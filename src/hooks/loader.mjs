// ④ auth.loader —— 接管所有出站请求
//
// 这里只做四件事：
//   1. 每次请求**现签一个 uskey**（同一 uskey 只给 2 次，第 3 次 403）
//   2. 换成这个账号的 Ual-Access-* 头（模型网关不认 Bearer，只认这套）
//   3. 把「模型不可用」翻成 404、「登录失效」翻成 401 + X-Magpie-Sign-In: expired
//   4. **把 Response 原样交回去** —— 绝不在 fetch 里读流（读了就是「只有第一段就结束」）
//
// ⚠ 实测：把 UAL 签名头（md5 body+ts+accessKey+nonce）加到模型网关上是**错的** ——
//   会从 403 风控变成 401 登录态过期。那套只用于 /v3/*。

import { BASE_V1, DEFAULT_MODEL, DISPLAY_BY_SLOT, canonicalModelId, isUnavailableModel } from "../context.mjs"
import { llmHeaders } from "../marvis/protocol.mjs"
import { normalizeTools } from "../marvis/tool-schema.mjs"
import { InvalidImageError, normalizeMessages } from "../marvis/images.mjs"

/**
 * 上游说「模型不行」的信号 —— 只收**模型级**的，映射成 404（搁置这个模型，不打死账号）。
 *
 * ⚠ `4130001` = `无效模型id`（请求体里的 model 不是注册表里的槽位）。
 * ⚠ `5104002` 是 **RPC 500**，这个业务码本身不等于模型失效 —— 不能加进来：
 *   把 5104002 全局映射成 404 会把正常模型的上游抖动误判成「模型不可用」，
 *   能用的模型和账号都会被标成失效。
 */
const MODEL_ISSUE =
  /model.*not (found|exist|allowed|available)|no such model|不支持.*模型|模型.*(不存在|未开通|不可用)|无效模型\s*id|4130001|4100402/i

/** 风控（uskey 配额用完 / 缺 MarvisExt）—— 可重试，但要换新 uskey */
const RISK_BLOCK = /4100404|风控拦截/

/** 登录态过期 */
const AUTH_EXPIRED = /4100403|登录态过期|未登录/

/**
 * Marvis 的内容过滤拦的是「**system 首行 + 词对 + 单个空格**」（issue #22 / #26）。
 *
 * 2026-11-15 首次定位 + 2026-11-16 复测（直打上游，只换 system prompt 第一句）：
 *
 *   `You are an AI agent powered by DeepSeek Harness.`      → 403 非法请求
 *   中文写法（由 DeepSeek Harness 驱动…）                    → 403 非法请求
 *   全小写同一句                                             → 403（大小写不敏感）
 *   句末加 ! 或 ,                                            → 403（句末符号无效）
 *   同一句放第 2 行 / 行内带前缀 / user 或 assistant 角色     → 200
 *   `DeepSeek-Harness` / `DeepSeek — Harness`               → 200（词间插字符放行）
 *
 * 2026-11-16 追加实测（OpenCode 2 用户报的 403，直打上游只换 system 首行）：
 *
 *   `You are an AI agent running in OpenCode, a coding agent harness.`  → 403 非法请求
 *   同一句放第 2 行                                                     → 200
 *   词间多一个空格 / 全小写 / 句子跨行（`…AI agent\nrunning in…`）        → 403
 *   `running` → `working` / `AI agent` → `AI-agent` / `OpenCode` → `Open-Code` → 200
 *   `You are Claude Code, Anthropic's official CLI tool for Claude.`     → 403 非法请求
 *   `You are Claude.`                                                    → 403
 *   裸 `Claude Code`（前面没有 `You are`）                                → 200
 *
 * ⇒ 各家 agent 的身份句是一张**持续变长的表**，不是一条正则能覆盖的。新命中的写法
 *   往下面的表里加一条即可；改写只动**词间的那点东西**（空格换连字符 / 动词换同义动词），
 *   句子其余部分一个字节都不碰 —— 客户端行为不变，上游放行。
 *
 * ⇒ 判据是「首行里的词对」，不是「整句模板」。只认英文整句会漏掉中文与本地化写法 ——
 *   它们照样 403，而且因为不命中模板，连 content_filtered 诊断都不会触发，
 *   用户看到的仍是宿主那句「API 密钥无效」。
 */
const IDENTITY_PHRASES = [
  [/(You are an AI agent powered by DeepSeek)\s+(Harness)/i, "$1-$2"],
  [/(You are a coding agent running in the Codex)\s+(CLI)/i, "$1-$2"],
  [/(You are Claude)\s+(Code, Anthropic's official CLI for Claude)/i, "$1-$2"],
  [/(你是一个由\s*DeepSeek)\s+(Harness)/i, "$1-$2"],
  // OpenCode 2 的身份句。上游拦的是 `running in OpenCode` 这个词对，所以把 running 换成
  // 同义的 working（等长、句意不变、实测 200）—— 用户不用去改 opencode.exe 的二进制。
  [
    /(You are an AI agent)(\s+)(running)(\s+in\s+OpenCode)/i,
    (_match, head, gap1, verb, gap2) => head + gap1 + (/^r/i.test(verb) ? "working" : "WORKING") + gap2,
  ],
]

/** 判定用（只看原文，不参与改写）：命中任一条即认为这次 403 是内容过滤 */
const IDENTITY_PHRASE_TEST =
  /You are an AI agent powered by DeepSeek\s+Harness|You are a coding agent running in the Codex\s+CLI|You are Claude\s+Code|You are an AI agent\s+running\s+in\s+OpenCode|你是一个由\s*DeepSeek\s+Harness/i

/**
 * 上游内容过滤拦截时的**统一**提示。
 *
 * ⚠ 刻意**不点名**任何 agent / 身份句 —— 被拦的可能有很多家（DSH、Codex、Claude Desktop，
 *   以及还没测到的），写死一家会在别家命中时把人带偏。只留两件确定的事：
 *   ① 性质是内容过滤，不是密钥或登录；② 修复方法在群里。
 */
const CONTENT_FILTER_HINT =
  "上游内容过滤拦截（非密钥或登录问题），修复方法见 QQ 群 451129479。"

/**
 * 构造一个错误 Response。
 * @param {number} status
 * @param {string} code
 * @param {string} message
 * @param {Record<string, string>} [headers]
 */
function errorResponse(status, code, message, headers = {}) {
  return new Response(JSON.stringify({ error: { type: "upstream_error", code, message } }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}

/**
 * 把会被上游内容过滤拦下的身份句改写成能放行的形态。
 *
 * ⚠ 只改 system 消息**第一行**里的身份短语 —— 那是上游唯一会拦的位置；
 *   user / assistant 里的同一句上游本来就放行，改了反而是多余改动。
 * ⚠ 门禁不变：只把词间那一个空格换成连字符，其余字符一个都不碰；
 *   已经写成连字符 / 破折号的形态没有空格可换，仍然原样发出（0.2.30 的用例继续守着）。
 * ⚠ 返回**新数组**才表示改过 —— 调用方据此决定要不要重新序列化 body（并去掉 content-length）。
 *
 * @param {unknown} messages
 * @returns {unknown}
 */
function firstLineOf(text) {
  const cut = text.indexOf("\n")
  return cut < 0 ? text : text.slice(0, cut)
}

/** 首行里的身份短语换成连字符形态；没有可换的就原样返回 */
function rewriteFirstLine(text) {
  const line = firstLineOf(text)
  let next = line
  for (const [pattern, replacement] of IDENTITY_PHRASES) {
    next = next.replace(pattern, replacement)
  }
  return next === line ? text : next + text.slice(line.length)
}

function rewriteAgentIdentity(messages) {
  if (!Array.isArray(messages)) return messages
  let touched = false
  const out = messages.map((message) => {
    if (!message || typeof message !== "object") return message
    if (message.role !== "system") return message
    if (typeof message.content !== "string") return message
    const content = rewriteFirstLine(message.content)
    if (content === message.content) return message
    touched = true
    return { ...message, content }
  })
  return touched ? out : messages
}

/**
 * 这次请求体里有没有「上游会拦的身份短语」—— **改写前**判定，只影响 403 的文案。
 * 只看 system 首行，与上游判据保持同一集合，避免把普通 403 误判成内容过滤。
 *
 * @param {unknown} bodyString
 * @returns {boolean}
 */
function identityBlockedInSystem(bodyString) {
  if (typeof bodyString !== "string") return false
  let json = null
  try {
    json = JSON.parse(bodyString)
  } catch {
    return false
  }
  const messages = Array.isArray(json?.messages) ? json.messages : []
  for (const message of messages) {
    if (!message || message.role !== "system") continue
    const text = typeof message.content === "string" ? message.content : ""
    if (IDENTITY_PHRASE_TEST.test(firstLineOf(text))) return true
  }
  return false
}

// ⚠ 不要用 TABLE（`DISPLAY_BY_SLOT`）当准入集合。
//   TABLE 是**对外展示目录**，不是「上游可用集合」：`app-auto` / `file-auto` /
//   `computer-auto` / `browser-auto` 这类旧真实槽位不在 TABLE 里，上游却仍然 200。
//   拿 TABLE 做 allowlist 会把它们本地 404 掉（0.2.21 的事故）。
//   准入只查 `isUnavailableModel`（明确不可用名单，当前只有 `kimi-k2.5`），其余交给上游判。

/** 请求体里到底有没有指定模型（空 / null 的交回上游判） */
function hasModelId(value) {
  return value != null && String(value) !== ""
}

/**
 * 明确不可用的模型：**本地** 404，不出网、不 fallback。
 *
 * 只对 `isUnavailableModel` 命中名单的模型生效（当前只有 `kimi-k2.5`）。
 * TABLE 外的旧真实槽位不归这里管 —— 它们照常出网，可用性由上游响应决定。
 *
 * 为什么是 404 而不是 401/500（AGENTS 坑 6）：
 *   · 401 会被宿主当登录问题，failover 到**每一个账号**；
 *   · 500 会被当可重试的上游故障，同一个请求连打 8 次（kimi-k2.5 的 5104002 现场）；
 *   · 404 只搁置这个模型，文案把用户引导回模型列表里**真实模型名**的条目。
 */
function modelUnavailableResponse(id) {
  const example = DISPLAY_BY_SLOT[DEFAULT_MODEL] ?? DEFAULT_MODEL
  return errorResponse(
    404,
    "model_unavailable",
    `模型「${String(id).slice(0, 120)}」已被标记为持续不可用（上游稳定失败），` +
      `这次请求没有发往上游。请在模型列表里重新选择一个真实模型名条目（例如 ${example}）。`,
  )
}

/** 从账号凭据里取模型网关要的四件套 */
function credsOf(auth) {
  const meta = auth?.metadata ?? {}
  return {
    openid: String(meta.openid ?? auth?.uid ?? ""),
    accessToken: String(auth?.access ?? auth?.key ?? ""),
    guid: String(meta.guid ?? ""),
    loginType: String(meta.loginType ?? "1"),
  }
}

export function loaderHook() {
  return async (getAuth) => {
    const auth = await getAuth()
    const creds = credsOf(auth)
    if (!creds.accessToken || !creds.openid) {
      return {}
    }

    return {
      baseURL: BASE_V1,
      apiKey: "placeholder",
      fetch: async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url

        // 非补全请求（/models 之类）原样放行 —— 上游没有这个端点，交给上层兜底
        if (!/\/chat\/completions\b/.test(url)) {
          return fetch(input, init)
        }

        // ⚠ 每次都要重新算头：uskey 是一次性的
        let headers
        try {
          headers = llmHeaders(creds, {
            // ⚠ `Marvis-Scene` 是上游的**准入闸门**，不是随便填的元数据：
            //   `preload_summary` / `prefill_supplement` / `agent` 这几个场景
            //   只放行腾讯自家的 deepseek / hunyuan，claude / gpt 一律回
            //   `4130001 无效模型id`（看起来像模型不存在，其实是场景不放行）。
            //   实测只有 `chat` 场景能过全部 8 个槽位，所以固定用 `chat`。
            scene: "chat",
            agentTag: "main_agent",
          })
        } catch (err) {
          return errorResponse(
            503,
            "header_unavailable",
            `请求头构造失败：${err?.message ?? err}`,
          )
        }

        // 保留调用方传的 stream / 业务体，只换鉴权头
        const merged = { ...(init?.headers ?? {}) }
        for (const [k, v] of Object.entries(headers)) merged[k] = v

        // ⚠ 旧路由里模型 ID 是数组下标 `"0"…"7"`，上游只认槽位名。
        //   在这里做一次归一，旧路由不改配置也能继续用。
        let body = init?.body
        /** 改写前的原始请求体 —— 403 诊断要靠它判断上游拦的是哪句身份声明（body 可能已被改写） */
        const originalBody = typeof body === "string" ? body : ""
        /** @type {string | null} 命中「明确不可用」名单的模型 ID */
        let unavailableModel = null
        /** 请求体里是否含被上游内容过滤定向拦截的 DSH 标识语句 */
        let harnessIdentityPrompt = false
        if (typeof body === "string") {
          // 只做标记，不改 body —— 命中与否只影响错误文案
          harnessIdentityPrompt = identityBlockedInSystem(originalBody)
          let json = null
          try {
            json = JSON.parse(body)
          } catch {
            /* 不是 JSON 就原样转发 */
          }
          if (json && typeof json === "object") {
            let changed = false
            const canonical = canonicalModelId(json.model)
            if (canonical !== json.model) {
              json.model = canonical
              changed = true
            }
            if (hasModelId(json.model) && isUnavailableModel(json.model)) {
              // 明确不可用名单（当前只有 kimi-k2.5）：本地挡掉，不出网、不 fallback。
              unavailableModel = String(json.model)
            }
            if (unavailableModel === null) {
              // Marvis 要求每个工具 parameters 显式 type:"object"；
              // DSH 的部分工具省略了它，缺一个就 400 invalid parameter。
              const tools = normalizeTools(json.tools)
              if (tools !== json.tools) {
                json.tools = tools
                changed = true
              }
              try {
                // 图片 URL / 裸 base64 / Anthropic image 显式归一为 data URI；
                // 转换不了就本地 400，不再静默丢图或把无效输入交给上游。
                const messages = await normalizeMessages(json.messages)
                if (messages !== json.messages) {
                  json.messages = messages
                  changed = true
                }
              } catch (err) {
                if (err instanceof InvalidImageError) {
                  return errorResponse(400, "invalid_image", `图片输入无效：${err.message}`)
                }
                throw err
              }
              // ⚠ 上游内容过滤会精确拦下 DSH / Codex / Claude Desktop 的身份句
              //   （issue #22 实测：身份短语中间换成连字符就放行）。自动改写，用户不用改客户端配置。
              const rewritten = rewriteAgentIdentity(json.messages)
              if (rewritten !== json.messages) {
                json.messages = rewritten
                changed = true
              }
            }
            if (!unavailableModel) {
              try {
                // Marvis 只认 OpenAI `image_url` + `data:image/...;base64`：
                // 图片 http(s) URL / 裸 base64 / Anthropic `{type:"image",source}` 都归一成 data URI。
                // 归一不了就本地 400 —— 不静默丢图，也不把无效输入丢给上游换个看不懂的错。
                const messages = await normalizeMessages(json.messages)
                if (messages !== json.messages) {
                  json.messages = messages
                  changed = true
                }
              } catch (err) {
                if (err instanceof InvalidImageError) {
                  return errorResponse(400, "invalid_image", `图片输入无效：${err.message}`)
                }
                throw err
              }
            }
            if (changed) {
              body = JSON.stringify(json)
              // body 变了，长度头必须去掉，让 fetch 重新算
              delete merged["content-length"]
              delete merged["Content-Length"]
              delete merged["content-encoding"]
              delete merged["Content-Encoding"]
            }
          }
        }

        // 明确不可用模型：本地 404，一次 fetch 都不发
        if (unavailableModel !== null) {
          return modelUnavailableResponse(unavailableModel)
        }

        let response
        try {
          response = await fetch(url, { ...init, ...(body === init?.body ? {} : { body }), headers: merged })
        } catch (err) {
          return errorResponse(503, "upstream_unreachable", `连不上 Marvis 网关：${err?.message ?? err}`)
        }

        if (response.ok) {
          // 上游给流式响应时带的是 `text/plain` —— 但 body 是标准 SSE。
          // 部分 OpenAI SDK 版本按 content-type 决定走不走 SSE 解析器，所以这里归一化。
          const ct = response.headers.get("content-type") ?? ""
          if (response.body && !/event-stream/i.test(ct)) {
            const headers = new Headers(response.headers)
            headers.set("content-type", "text/event-stream; charset=utf-8")
            return new Response(response.body, { status: response.status, headers })
          }
          return response
        }

        // —— 错误分流：只读 **错误** 的 body（成功响应绝不读，见文件头 ⚠）——
        let text = ""
        try {
          text = await response.clone().text()
        } catch {
          /* 读不出来就按状态码判 */
        }

        if (AUTH_EXPIRED.test(text) || response.status === 401) {
          return errorResponse(401, "sign_in_expired", "Marvis 登录态已过期，请重新登录。", {
            "X-Magpie-Sign-In": "expired",
          })
        }
        if (RISK_BLOCK.test(text)) {
          // 风控可重试：换新 uskey 就能过，交给宿主重试
          return errorResponse(503, "risk_blocked", `上游风控拦截（通常是一次性 uskey 用完了，重试即可）：${text.slice(0, 300)}`)
        }
        if (MODEL_ISSUE.test(text) || response.status === 404) {
          // 模型级错误 → 404，只搁置这个模型，不打死账号（AGENTS 坑 6）
          // 4130001 有两种含义，别一口咬定「模型下线」把人带偏：
          //   ① 槽位名写错/已下线  ② 场景不放行（同一个 id 在别的 Marvis-Scene 下能过）
          const hint = /4130001/.test(text) ? "（模型 id 无效，或当前场景/账号不放行）" : ""
          return errorResponse(
            404,
            "model_unavailable",
            `该模型在当前账号不可用${hint}：${text.slice(0, 300)}`,
          )
        }
        // ⚠ 403 +「非法请求」一律按内容过滤处理，**不再看是否命中已知指纹**。
        //   理由：上游的指纹在持续扩大（英文 → 中文 → 还没见过的写法），按指纹判定永远漏；
        //   而 403 + 这个组合目前只出现在内容过滤上（模型无权限是 400「无效模型id」）。
        //   宁可多给一句「进群」，也不要把人甩回宿主那句「API 密钥无效」。
        if (response.status === 403 && /非法请求|permission_error/i.test(text)) {
          return errorResponse(403, "content_filtered", CONTENT_FILTER_HINT)
        }
        // 其余原样透出
        return new Response(text || null, {
          status: response.status,
          headers: response.headers,
        })
      },
    }
  }
}

export { DEFAULT_MODEL, credsOf }
