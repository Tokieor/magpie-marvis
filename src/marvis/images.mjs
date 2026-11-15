// 图片输入归一 —— Marvis 只接受 OpenAI image_url + data:image/...;base64 形态。
//
// 这里处理三种输入：
//   1. http(s) 图片 URL：插件下载后转 data URI（不带任何 Marvis 鉴权头）；
//   2. 裸 base64：识别常见图片头后补 data URI；
//   3. Anthropic { type:"image", source:{...} }：显式转成 OpenAI image_url。
// 无法识别或下载失败时抛出 InvalidImageError，绝不静默丢图。

import { lookup as defaultLookup } from "node:dns/promises"
import { isIP } from "node:net"

export class InvalidImageError extends Error {}

const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 20_000
const SUPPORTED_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])

function fail(message) {
  throw new InvalidImageError(message)
}

function sniffMime(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png"
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg"
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) return "image/gif"
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp"
  return ""
}

function normalizedMime(bytes, declared = "") {
  const mime = sniffMime(bytes)
  if (mime) return mime
  const clean = String(declared).split(";", 1)[0].trim().toLowerCase()
  if (clean === "image/jpg") return "image/jpeg"
  if (SUPPORTED_MIME.has(clean)) return clean
  return ""
}

function decodeBase64(input) {
  const compact = String(input ?? "").replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/")
  if (!compact || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) fail("裸 base64 图片格式无效；请改用完整的 data:image/...;base64,...。")
  if (compact.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4) fail("图片超过 20 MiB 上限，未发往 Marvis。")
  const unpadded = compact.replace(/=+$/, "")
  if (unpadded.length % 4 === 1) fail("裸 base64 图片长度无效；请改用完整的 data URI。")
  const padded = unpadded + "=".repeat((4 - (unpadded.length % 4)) % 4)
  const bytes = Buffer.from(padded, "base64")
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) fail("图片为空或超过 20 MiB 上限，未发往 Marvis。")
  return bytes
}

function base64DataUri(data, declaredMime = "") {
  const bytes = decodeBase64(data)
  const mime = normalizedMime(bytes, declaredMime)
  if (!mime) fail("无法识别图片类型（仅支持 PNG / JPEG / GIF / WebP）；请改用带正确 media type 的 data URI。")
  return `data:${mime};base64,${bytes.toString("base64")}`
}

async function readLimited(response) {
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    const chunk = Buffer.from(value)
    total += chunk.length
    if (total > MAX_IMAGE_BYTES) {
      await reader.cancel().catch(() => {})
      fail("远程图片超过 20 MiB 上限，未发往 Marvis。")
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, total)
}

function isPrivateIp(ip) {
  if (ip.includes(":")) {
    const lower = ip.toLowerCase()
    if (lower === "::1" || lower === "::") return true
    if (lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) return true
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (mapped) return isPrivateIp(mapped[1])
    return false
  }
  const parts = ip.split(".").map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const [a, b] = parts
  if (a === 0 || a === 10 || a === 127) return true // 本机 / 私网 / loopback
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  if (a === 169 && b === 254) return true // link-local，含云元数据 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 192 && b === 0) return true // 192.0.0/24 与 192.0.2/24 文档段一并拒绝
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return true
  if (a === 203 && b === 0) return true
  if (a >= 224) return true // 组播 / 保留
  return false
}

/**
 * 是否放行内网 / 本机图片地址。
 *
 * 默认**不放行**（防 SSRF，见 assertPublicHttpUrl）。但插件就跑在用户自己的 NAS 上，
 * DSH / magpie 的附件常常是 `http://192.168.x.x/...` 这种局域网地址 —— 默认拦掉会让
 * 「图明明在眼前却传不上去」。所以给一个显式开关：
 *   `MAGPIE_MARVIS_ALLOW_PRIVATE_IMAGE_HOSTS=1`
 * 打开后只跳过私网判定，其余校验（协议、账号信息、大小、MIME、不跟随重定向）照旧。
 */
function allowPrivateImageHosts() {
  const v = String(process.env.MAGPIE_MARVIS_ALLOW_PRIVATE_IMAGE_HOSTS ?? "").trim().toLowerCase()
  return v === "1" || v === "true" || v === "yes"
}

async function assertPublicHttpUrl(parsed, lookupImpl) {
  if (parsed.username || parsed.password) fail("图片 URL 不允许携带账号信息，未发往 Marvis。")
  const host = parsed.hostname.replace(/^\[|\]$/g, "")
  const ips = []
  if (isIP(host)) {
    ips.push(host)
  } else {
    let records
    try {
      records = await lookupImpl(host, { all: true, verbatim: true })
    } catch {
      fail("图片域名无法解析，未发往 Marvis。")
    }
    for (const record of records || []) ips.push(record.address)
  }
  if (!ips.length) fail("图片域名没有可用解析结果，未发往 Marvis。")
  // 应用层预检：字面 IP 与 DNS 解析结果全部须为公网地址。
  // 残余风险：严格防 DNS rebinding 需要连接层固定已校验地址，当前实现不覆盖，在此明示。
  if (allowPrivateImageHosts()) return
  for (const ip of ips) {
    if (isPrivateIp(ip)) fail("图片地址指向本机 / 内网 / 保留地址，已拦截，未发往 Marvis。")
  }
}

function normalizeDataUri(url) {
  const comma = url.indexOf(",")
  if (comma < 0) fail("data URI 缺少数据段，未发往 Marvis。")
  const header = url.slice(5, comma)
  if (!/;base64/i.test(header)) fail("只支持 base64 形态的 data:image URI，未发往 Marvis。")
  const declared = header.split(";")[0]
  return base64DataUri(url.slice(comma + 1), declared)
}

async function downloadDataUri(url, fetchImpl, lookupImpl = defaultLookup) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    fail("图片 URL 无效，未发往 Marvis。")
  }
  if (!["http:", "https:"].includes(parsed.protocol)) fail("图片 URL 只支持 http / https，未发往 Marvis。")
  await assertPublicHttpUrl(parsed, lookupImpl)

  let response
  try {
    // 不跟随重定向：公网 URL 跳到内网是常见 SSRF 路径，直接拒绝。
    response = await fetchImpl(parsed.href, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), redirect: "error" })
  } catch {
    fail("远程图片下载失败、超时或发生重定向，未发往 Marvis。")
  }
  if (!response.ok) fail(`远程图片下载失败（HTTP ${response.status}），未发往 Marvis。`)
  const declaredLength = Number(response.headers.get("content-length") ?? 0)
  if (declaredLength > MAX_IMAGE_BYTES) fail("远程图片超过 20 MiB 上限，未发往 Marvis。")
  let bytes
  try {
    bytes = await readLimited(response)
  } catch (err) {
    if (err instanceof InvalidImageError) throw err
    fail("读取远程图片失败，未发往 Marvis。")
  }
  if (!bytes.length) fail("远程图片内容为空，未发往 Marvis。")
  const mime = normalizedMime(bytes, response.headers.get("content-type") ?? "")
  if (!mime) fail("远程地址返回的不是受支持的 PNG / JPEG / GIF / WebP 图片，未发往 Marvis。")
  return `data:${mime};base64,${bytes.toString("base64")}`
}

async function normalizeUrl(value, fetchImpl, lookupImpl) {
  const url = String(value ?? "").trim()
  if (!url) fail("图片地址为空，未发往 Marvis。")
  // data URI 同样过大小 / base64 / 图片头校验后重编码，不再原样透传。
  if (/^data:image\//i.test(url)) return normalizeDataUri(url)
  if (/^https?:\/\//i.test(url)) return downloadDataUri(url, fetchImpl, lookupImpl)
  return base64DataUri(url)
}

async function normalizePart(part, fetchImpl, lookupImpl) {
  if (!part || typeof part !== "object" || Array.isArray(part)) return part
  if (part.type === "image_url") {
    const current = typeof part.image_url === "string" ? part.image_url : part.image_url?.url
    const url = await normalizeUrl(current, fetchImpl, lookupImpl)
    if (url === current) return part
    const imageUrl = typeof part.image_url === "object" && part.image_url !== null ? part.image_url : {}
    return { ...part, image_url: { ...imageUrl, url } }
  }
  if (part.type === "image") {
    const source = part.source
    if (source?.type === "base64" && source.data) {
      return { type: "image_url", image_url: { url: base64DataUri(source.data, source.media_type) } }
    }
    if (source?.type === "url" && source.url) {
      return { type: "image_url", image_url: { url: await downloadDataUri(source.url, fetchImpl, lookupImpl) } }
    }
    fail("Anthropic image part 缺少可转换的 base64 / url source；为避免静默丢图，这次请求已拦截。")
  }
  return part
}

/** 归一 messages 里的图片 part；无改动时返回原数组。 */
export async function normalizeMessages(messages, fetchImpl = globalThis.fetch, lookupImpl = defaultLookup) {
  if (!Array.isArray(messages)) return messages
  let changed = false
  const out = []
  for (const message of messages) {
    if (!message || typeof message !== "object" || !Array.isArray(message.content)) {
      out.push(message)
      continue
    }
    let messageChanged = false
    const content = []
    for (const part of message.content) {
      const next = await normalizePart(part, fetchImpl, lookupImpl)
      if (next !== part) messageChanged = true
      content.push(next)
    }
    if (messageChanged) {
      out.push({ ...message, content })
      changed = true
    } else {
      out.push(message)
    }
  }
  return changed ? out : messages
}
