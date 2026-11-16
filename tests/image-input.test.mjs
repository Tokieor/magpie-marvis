// issue #8 回归锁：main-auto 能力声明 + 三种图片输入归一。
// 全部离线；远程图片与 Marvis 网关都用 stub，不需要凭据。

import test from "node:test"
import assert from "node:assert/strict"

import { providerModels, staticModels } from "../src/context.mjs"
import { loaderHook } from "../src/hooks/loader.mjs"
import { InvalidImageError, normalizeMessages } from "../src/marvis/images.mjs"

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zq3cAAAAASUVORK5CYII="
const DATA_URI = `data:image/png;base64,${PNG}`
const CHAT_URL = "https://yybadaccess.3g.qq.com/v1/chat/completions"
const PUBLIC_IP_URL = "https://93.184.216.34/a.png"
const PUBLIC_LOOKUP = async () => [{ address: "93.184.216.34", family: 4 }]
const PRIVATE_LOOKUP = async () => [{ address: "127.0.0.1", family: 4 }]
const AUTH = Object.freeze({
  access: "mv_test_offline_only",
  uid: "0123456789abcdef0123456789abcdef",
  metadata: {
    openid: "fedcba9876543210fedcba9876543210",
    guid: "0".repeat(32),
    loginType: "1",
  },
})

test("main-auto 在 config 与 provider.models 两种形状里都声明可收图", () => {
  const id = "deepseek-v4-1-flash-261017"
  const staticModel = staticModels()[id]
  assert.equal(staticModel.apiId, "main-auto")
  assert.equal(staticModel.attachment, true)
  assert.deepEqual(staticModel.modalities.input, ["text", "image"])

  const providerModel = providerModels()[id]
  assert.equal(providerModel.api.id, "main-auto")
  assert.equal(providerModel.capabilities.attachment, true)
  assert.equal(providerModel.capabilities.input.image, true)
  assert.equal(providerModel.capabilities.input.audio, false)
  assert.equal(providerModel.capabilities.input.video, false)
  assert.equal(providerModel.capabilities.input.pdf, false)
})

test("已是 data URI 的图片与纯文本消息保持原样", async () => {
  const messages = [
    { role: "user", content: "text only" },
    {
      role: "user",
      content: [
        { type: "text", text: "看图" },
        { type: "image_url", image_url: { url: DATA_URI, detail: "high" } },
      ],
    },
  ]
  const normalized = await normalizeMessages(messages, async () => {
    throw new Error("data URI 不应触发下载")
  })
  assert.equal(normalized, messages)
  assert.equal(normalized[1].content[1].image_url.url, DATA_URI)
  assert.equal(normalized[1].content[1].image_url.detail, "high")
})

test("裸 base64 按图片头补成 data URI", async () => {
  const [message] = await normalizeMessages([
    { role: "user", content: [{ type: "image_url", image_url: { url: PNG } }] },
  ])
  assert.equal(message.content[0].image_url.url, DATA_URI)
})

test("Anthropic base64 image 显式转成 OpenAI image_url，不静默丢图", async () => {
  const [message] = await normalizeMessages([
    {
      role: "user",
      content: [
        { type: "text", text: "这是什么颜色？" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
      ],
    },
  ])
  assert.deepEqual(message.content[0], { type: "text", text: "这是什么颜色？" })
  assert.deepEqual(message.content[1], { type: "image_url", image_url: { url: DATA_URI } })
  assert.equal(message.content[1].source, undefined)
})

test("http(s) 图片 URL 下载后转 data URI，下载请求不带 Marvis 鉴权头", async () => {
  const calls = []
  const messages = await normalizeMessages(
    [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }] }],
    async (url, init) => {
      calls.push({ url, init })
      return new Response(Buffer.from(PNG, "base64"), {
        status: 200,
        headers: { "content-type": "image/png" },
      })
    },
    PUBLIC_LOOKUP,
  )
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, "https://example.com/a.png")
  assert.equal(calls[0].init.headers, undefined)
  assert.equal(calls[0].init.redirect, "error")
  assert.equal(messages[0].content[0].image_url.url, DATA_URI)
})

test("无法转换的 Anthropic image 显式报错", async () => {
  await assert.rejects(
    () => normalizeMessages([{ role: "user", content: [{ type: "image", source: { type: "unknown" } }] }]),
    InvalidImageError,
  )
})

test("loader 将远程图片归一后再发聊天请求，并移除旧 content-length", async () => {
  const calls = []
  const real = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    calls.push({ url, init })
    if (url === PUBLIC_IP_URL) {
      return new Response(Buffer.from(PNG, "base64"), {
        status: 200,
        headers: { "content-type": "image/png" },
      })
    }
    return new Response(JSON.stringify({ id: "chatcmpl-test", choices: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }
  try {
    const loader = await loaderHook()(async () => AUTH)
    const originalBody = JSON.stringify({
      model: "deepseek-v4-1-flash-261017",
      stream: false,
      messages: [
        { role: "user", content: [{ type: "image_url", image_url: { url: PUBLIC_IP_URL } }] },
      ],
    })
    const response = await loader.fetch(CHAT_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(originalBody.length) },
      body: originalBody,
    })
    assert.equal(response.status, 200)
    assert.equal(calls.length, 2)
    assert.equal(calls[0].url, PUBLIC_IP_URL)
    assert.equal(calls[1].url, CHAT_URL)
    const sent = JSON.parse(calls[1].init.body)
    assert.equal(sent.model, "main-auto")
    assert.equal(sent.messages[0].content[0].image_url.url, DATA_URI)
    assert.equal(calls[1].init.headers["content-length"], undefined)
    assert.equal(calls[1].init.headers["Content-Length"], undefined)
  } finally {
    globalThis.fetch = real
  }
})

test("loader 对无法转换的图片本地 400，聊天请求不出网", async () => {
  const calls = []
  const real = globalThis.fetch
  globalThis.fetch = async (...args) => {
    calls.push(args)
    throw new Error("不应出网")
  }
  try {
    const loader = await loaderHook()(async () => AUTH)
    const response = await loader.fetch(CHAT_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "main-auto",
        messages: [{ role: "user", content: [{ type: "image", source: { type: "unknown" } }] }],
      }),
    })
    assert.equal(response.status, 400)
    const body = await response.json()
    assert.equal(body.error.code, "invalid_image")
    assert.match(body.error.message, /静默丢图|图片输入无效/)
    assert.equal(calls.length, 0)
  } finally {
    globalThis.fetch = real
  }
})

test("明确不可用模型不会先下载图片", async () => {
  const calls = []
  const real = globalThis.fetch
  globalThis.fetch = async (...args) => {
    calls.push(args)
    throw new Error("不应出网")
  }
  try {
    const loader = await loaderHook()(async () => AUTH)
    const response = await loader.fetch(CHAT_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "kimi-k2.5",
        messages: [
          { role: "user", content: [{ type: "image_url", image_url: { url: PUBLIC_IP_URL } }] },
        ],
      }),
    })
    assert.equal(response.status, 404)
    assert.equal((await response.json()).error.code, "model_unavailable")
    assert.equal(calls.length, 0)
  } finally {
    globalThis.fetch = real
  }
})

test("loopback / 私网 / 云元数据地址在出网前拦截", async () => {
  for (const url of ["http://127.0.0.1/a.png", "http://169.254.169.254/latest/meta-data", "http://10.0.0.5/a.png", "http://192.168.1.1/a.png", "http://[::1]/a.png"]) {
    const calls = []
    await assert.rejects(
      () => normalizeMessages(
        [{ role: "user", content: [{ type: "image_url", image_url: { url } }] }],
        async () => { calls.push(1); throw new Error("不应出网") },
      ),
      InvalidImageError,
    )
    assert.equal(calls.length, 0, url)
  }
})

test("域名解析到内网同样拦截（DNS 预检）", async () => {
  const calls = []
  await assert.rejects(
    () => normalizeMessages(
      [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }] }],
      async () => { calls.push(1); throw new Error("不应出网") },
      PRIVATE_LOOKUP,
    ),
    InvalidImageError,
  )
  assert.equal(calls.length, 0)
})

test("携带账号信息的图片 URL 拒绝", async () => {
  await assert.rejects(
    () => normalizeMessages([{ role: "user", content: [{ type: "image_url", image_url: { url: "https://user:pass@93.184.216.34/a.png" } }] }]),
    InvalidImageError,
  )
})

test("下载禁止重定向，重定向按失败处理", async () => {
  let seen
  await assert.rejects(
    () => normalizeMessages(
      [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }] }],
      async (url, init) => { seen = init; throw new TypeError("redirect mode is set to error") },
      PUBLIC_LOOKUP,
    ),
    InvalidImageError,
  )
  assert.equal(seen.redirect, "error")
})

test("合法 data URI 重编码后值不变；非 base64 data URI 拒绝", async () => {
  const [message] = await normalizeMessages([
    { role: "user", content: [{ type: "image_url", image_url: { url: DATA_URI } }] },
  ])
  assert.equal(message.content[0].image_url.url, DATA_URI)
  await assert.rejects(
    () => normalizeMessages([{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>" } }] }]),
    InvalidImageError,
  )
})

test("超过 20 MiB 的 data URI 同样被上限拦截", async () => {
  const huge = "A".repeat(Math.ceil((20 * 1024 * 1024) / 3) * 4 + 8)
  await assert.rejects(
    () => normalizeMessages([{ role: "user", content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${huge}` } }] }]),
    InvalidImageError,
  )
})

// issue #34：DNS 过滤 / sinkhole 会把同一域名解析成「N 条公网 + 若干条 0.0.0.0」。
// 逐条否决会把完全正常的外链图一起拦掉，所以只在**一条公网记录都没有**时才拒。

test("解析结果混进 0.0.0.0（DNS sinkhole）时放行 —— 只要还有一条公网记录", async () => {
  const mixedLookup = async () => [
    { address: "2606:4700::6810:84e5", family: 6 },
    { address: "0.0.0.0", family: 4 },
  ]
  const calls = []
  const messages = await normalizeMessages(
    [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://cdn.example.com/a.png" } }] }],
    async (url) => {
      calls.push(url)
      return new Response(Buffer.from(PNG, "base64"), {
        status: 200,
        headers: { "content-type": "image/png" },
      })
    },
    mixedLookup,
  )
  assert.equal(calls.length, 1, "有公网记录就该照常下载")
  assert.equal(messages[0].content[0].image_url.url, DATA_URI)
})

test("解析结果全是保留地址时仍然拒（SSRF 面不变）", async () => {
  const calls = []
  await assert.rejects(
    () => normalizeMessages(
      [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }] }],
      async () => { calls.push(1); throw new Error("不应出网") },
      async () => [
        { address: "0.0.0.0", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ],
    ),
    InvalidImageError,
  )
  assert.equal(calls.length, 0)
})

test("内网图片地址默认拦截；MAGPIE_MARVIS_ALLOW_PRIVATE_IMAGE_HOSTS=1 时放行", async () => {
  const msgs = [{ role: "user", content: [{ type: "image_url", image_url: { url: "http://192.168.5.9/a.png" } }] }]
  const stubFetch = async () => new Response(Buffer.from(PNG, "base64"), { headers: { "content-type": "image/png" } })
  const lanLookup = async () => [{ address: "192.168.5.9", family: 4 }]

  // 默认：私网地址一律拦（防 SSRF）
  await assert.rejects(() => normalizeMessages(msgs, stubFetch, lanLookup), InvalidImageError)

  // 显式开关：NAS 上的附件就是局域网地址，放行后能正常转成 data URI
  process.env.MAGPIE_MARVIS_ALLOW_PRIVATE_IMAGE_HOSTS = "1"
  try {
    const [message] = await normalizeMessages(msgs, stubFetch, lanLookup)
    assert.match(message.content[0].image_url.url, /^data:image\/png;base64,/)
  } finally {
    delete process.env.MAGPIE_MARVIS_ALLOW_PRIVATE_IMAGE_HOSTS
  }
})
