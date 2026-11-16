// tests/loader-model-support.test.mjs —— 模型不可用名单闸（只拦明确不可用的模型）
//
// 事故现场：手工配置或陈旧路由里写着 `marvis/kimi-k2.5`（上游稳定 5104002 RPC 500）——
// 这不是 401/403/404，宿主把它当**可重试的上游故障**，同一个请求连打 8 次才放弃，
// 用户看到的是「卡很久然后 500」。
//
// 闸门规则（0.2.22 起，TABLE allowlist 已废弃）：
//   · 只有 context.mjs 的 `isUnavailableModel` 命中的模型（当前只有 `kimi-k2.5`）才本地拦。
//     TABLE 是**对外展示目录**，不是「上游可用集合」：`app-auto` / `file-auto` /
//     `computer-auto` / `browser-auto` 等旧真实槽位上游仍然 200，必须继续出网。
//   · 命中名单 → **本地** 404 `model_unavailable`，一次 fetch 都不发，绝不静默 fallback 到默认模型。
//   · TABLE 外的其他模型（含随手编的 ID）一律出网，由上游响应决定。
//   · `main-auto` 作为内部上游槽位继续可用（兼容旧路由），但卡片显示名仍是真实模型名。
//   · 上游 `4130001` / `无效模型id` 归入模型级 404；`5104002` **不**做全局 404 映射
//     （那是 RPC 故障，映射成 404 会把能用的模型/账号误标成失效）。
//
// 全部离线：mock 掉 globalThis.fetch，不需要真实凭据、不碰真实上游。

import test from "node:test"
import assert from "node:assert/strict"

import { loaderHook, DEFAULT_MODEL } from "../src/hooks/loader.mjs"
import { DISPLAY_BY_SLOT, MODEL_ALIASES } from "../src/context.mjs"

const CHAT_URL = "https://yybadaccess.3g.qq.com/v1/chat/completions"

/** 假凭据：只是形状对，值全部是测试用的假串，不会发到任何真实上游 */
const AUTH = Object.freeze({
  access: "mv_test_offline_only",
  uid: "0123456789abcdef0123456789abcdef",
  metadata: {
    openid: "fedcba9876543210fedcba9876543210",
    guid: "0".repeat(32),
    loginType: "1",
  },
})

/** 替换 globalThis.fetch 并记录调用；返回 { calls, restore } */
function stubFetch(handler) {
  const calls = []
  const real = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    calls.push({ url: typeof input === "string" ? input : String(input), init: init ?? {} })
    return handler(input, init ?? {})
  }
  return {
    calls,
    restore: () => {
      globalThis.fetch = real
    },
  }
}

/** 取 loader 描述符（loaderHook 的形状是 getAuth => { fetch, baseURL, apiKey }） */
async function loaderOf() {
  const describe = await loaderHook()(async () => AUTH)
  assert.equal(typeof describe.fetch, "function", "loader 必须返回 fetch")
  return describe
}

/** 组一个 /v1/chat/completions 请求（OpenAI 形状，stream 由参数决定） */
function requestFor(model, stream = false) {
  return {
    url: CHAT_URL,
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        stream,
        messages: [{ role: "user", content: "ping" }],
      }),
    },
  }
}

/** 上游正常回包（200，非流式 JSON） */
function upstreamOk(model = "deepseek-v4-1-flash-261017") {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion",
      model,
      choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )
}

/** 上游错误回包：status 是 HTTP 状态，body 里带业务码 / 文案 */
function upstreamError(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  })
}

/** 断言「本地 404、没有出网」并检查引导文案 */
async function assertLocalModelUnavailable(res, calls) {
  assert.equal(res.status, 404, "未知/失效模型必须在本地回 404")
  const body = await res.json()
  assert.equal(body.error.code, "model_unavailable")
  assert.equal(body.error.type, "upstream_error")
  assert.match(body.error.message, /重新选择/, "文案要引导用户回模型列表重新选")
  assert.match(body.error.message, /真实模型名/, "文案要指明选「真实模型名」条目")
  assert.equal(calls.length, 0, "不支持模型一次 upstream 都不能访问")
}

// ─────────────────────────────────────────────────────────────
// ① 未知 / 已失效模型：本地 404，不出网
// ─────────────────────────────────────────────────────────────

test("kimi-k2.5（stream:true）→ 本地 404，fetch 0 次（旧实现会出网并透出 500）", async () => {
  // 上游对 kimi-k2.5 的真实反应：5104002 RPC 500 —— 宿主会当可重试故障，连打 8 次
  const s = stubFetch(() => upstreamError(500, { code: 5104002, msg: "RPC error" }))
  try {
    const req = requestFor("kimi-k2.5", true)
    const res = await (await loaderOf()).fetch(req.url, req.init)
    await assertLocalModelUnavailable(res, s.calls)
  } finally {
    s.restore()
  }
})

test("kimi-k2.5（stream:false）→ 本地 404，fetch 0 次", async () => {
  const s = stubFetch(() => upstreamError(500, { code: 5104002, msg: "RPC error" }))
  try {
    const req = requestFor("kimi-k2.5", false)
    const res = await (await loaderOf()).fetch(req.url, req.init)
    await assertLocalModelUnavailable(res, s.calls)
  } finally {
    s.restore()
  }
})

test("TABLE 外其他模型不本地拦截：出网 1 次，由上游 4130001 归入 404", async () => {
  // 这些只是「不在展示目录里」，不等于上游失效 —— 必须真的问上游。
  for (const model of ["not-a-model", "glm-5v-turbo-thinking", "memory-compress"]) {
    const s = stubFetch(() => upstreamError(400, { code: 4130001, msg: "无效模型id" }))
    try {
      const req = requestFor(model, false)
      const res = await (await loaderOf()).fetch(req.url, req.init)
      assert.equal(s.calls.length, 1, `${model} 不在明确不可用名单里，必须先出网`)
      assert.equal(res.status, 404)
      assert.equal((await res.json()).error.code, "model_unavailable")
    } finally {
      s.restore()
    }
  }
})

// ─────────────────────────────────────────────────────────────
// ② 合法模型仍然按原路径：显示名 / 旧下标 / 槽位名 → 槽位 → 出网
// ─────────────────────────────────────────────────────────────

test("显示名 deepseek-v4-1-flash-261017 → 归一成 main-auto 后正常出网", async () => {
  const s = stubFetch(() => upstreamOk())
  try {
    const req = requestFor("deepseek-v4-1-flash-261017", true)
    const res = await (await loaderOf()).fetch(req.url, req.init)
    assert.equal(res.status, 200)
    assert.equal(s.calls.length, 1, "合法模型必须正常出网")
    assert.equal(JSON.parse(s.calls[0].init.body).model, "main-auto", "上游只认槽位名")
  } finally {
    s.restore()
  }
})

test("旧数字下标 0 → main-auto 正常出网（旧路由不作废）", async () => {
  const s = stubFetch(() => upstreamOk())
  try {
    const req = requestFor("0", false)
    const res = await (await loaderOf()).fetch(req.url, req.init)
    assert.equal(res.status, 200)
    assert.equal(s.calls.length, 1)
    assert.equal(JSON.parse(s.calls[0].init.body).model, "main-auto")
  } finally {
    s.restore()
  }
})

test("内部槽位 main-auto 本身仍被接受（兼容），但显示名不是 main-auto", async () => {
  assert.equal(DEFAULT_MODEL, "main-auto")
  assert.notEqual(DISPLAY_BY_SLOT["main-auto"], "main-auto", "卡片显示名必须是真实模型名")

  const s = stubFetch(() => upstreamOk())
  try {
    const req = requestFor("main-auto", false)
    const res = await (await loaderOf()).fetch(req.url, req.init)
    assert.equal(res.status, 200)
    assert.equal(s.calls.length, 1)
    assert.equal(JSON.parse(s.calls[0].init.body).model, "main-auto")
  } finally {
    s.restore()
  }
})

test("TABLE 里 8 条槽位 / 显示名 / 旧下标全部放行（当前正常的 8 个模型不许被闸掉）", async () => {
  assert.equal(Object.keys(DISPLAY_BY_SLOT).length, 8)
  assert.equal(Object.keys(MODEL_ALIASES).length, 8)

  const cases = []
  for (const [slot, display] of Object.entries(DISPLAY_BY_SLOT)) {
    cases.push([slot, slot], [display, slot])
  }
  for (const [index, slot] of Object.entries(MODEL_ALIASES)) {
    cases.push([index, slot])
  }

  for (const [model, expectedSlot] of cases) {
    const s = stubFetch(() => upstreamOk(DISPLAY_BY_SLOT[expectedSlot]))
    try {
      const req = requestFor(model, false)
      const res = await (await loaderOf()).fetch(req.url, req.init)
      assert.equal(res.status, 200, `模型 ${model} 应放行`)
      assert.equal(s.calls.length, 1, `模型 ${model} 应出网`)
      assert.equal(JSON.parse(s.calls[0].init.body).model, expectedSlot, `模型 ${model} 应归一成 ${expectedSlot}`)
    } finally {
      s.restore()
    }
  }
})

// ─────────────────────────────────────────────────────────────
// ③ 上游错误码分类：4130001 / 无效模型id → 404；5104002 不许全局 404
// ─────────────────────────────────────────────────────────────

test("上游 4130001（无效模型id）→ 404 model_unavailable，不打死账号", async () => {
  const s = stubFetch(() => upstreamError(400, { code: 4130001, msg: "invalid request" }))
  try {
    const req = requestFor("main-auto", false)
    const res = await (await loaderOf()).fetch(req.url, req.init)
    assert.equal(s.calls.length, 1, "这是上游返回的分类，必须真的请求过上游")
    assert.equal(res.status, 404)
    const body = await res.json()
    assert.equal(body.error.code, "model_unavailable")
  } finally {
    s.restore()
  }
})

test("上游只说「无效模型id」没有业务码时也归入 404", async () => {
  const s = stubFetch(() => upstreamError(400, { error: { message: "无效模型id: xxx" } }))
  try {
    const req = requestFor("main-auto", false)
    const res = await (await loaderOf()).fetch(req.url, req.init)
    assert.equal(res.status, 404)
    assert.equal((await res.json()).error.code, "model_unavailable")
  } finally {
    s.restore()
  }
})

test("上游 5104002 RPC 500 原样透出（不全局映射成 404）", async () => {
  const s = stubFetch(() => upstreamError(500, { code: 5104002, msg: "RPC error" }))
  try {
    const req = requestFor("main-auto", false)
    const res = await (await loaderOf()).fetch(req.url, req.init)
    assert.equal(s.calls.length, 1)
    assert.equal(res.status, 500, "5104002 是 RPC 故障，不能当模型失效")
    assert.equal((await res.json()).code, 5104002)
  } finally {
    s.restore()
  }
})
// `Marvis-Scene` 是上游的准入闸门，不是随便填的元数据。
// 事故现场：claude-sonnet-4-6 / claude-opus-4-6 / gpt-5.4 三个槽位在
// `preload_summary` 场景下稳定回 `4130001 无效模型id`（看着像模型没了，
// 其实是场景不放行），而 deepseek / hunyuan 正常。实测只有 `chat` 能过全部 8 个槽位。
test("loader 发出去的 Marvis-Scene 必须是 chat（否则 claude / gpt 全被误判成模型不存在）", async () => {
  const s = stubFetch(() => new Response("{}", { status: 200 }))
  try {
    const describe = await loaderOf()
    await describe.fetch(CHAT_URL, {
      method: "POST",
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
    })
    assert.equal(s.calls.length, 1)
    const h = s.calls[0].init.headers
    assert.equal(h["Marvis-Scene"], "chat", "场景必须是 chat，不能是 preload_summary")
    assert.equal(h["Marvis-AgentTag"], "main_agent")
  } finally {
    s.restore()
  }
})

// ─────────────────────────────────────────────────────────────
// system prompt 含 DSH 标识语句时的 403 诊断（issue #22）
// ─────────────────────────────────────────────────────────────

test("system prompt 命中 DSH 标识句 + 上游 403 → 改判成可读的 content_filtered", async () => {
  const s = stubFetch(() => upstreamError(403, { code: 403, msg: "非法请求", type: "permission_error" }))
  try {
    const req = requestFor("deepseek-v4-1-flash-261017")
    const body = JSON.parse(req.init.body)
    body.messages = [
      { role: "system", content: "You are an AI agent powered by DeepSeek Harness." },
      ...body.messages,
    ]
    req.init.body = JSON.stringify(body)
    const res = await (await loaderOf()).fetch(req.url, req.init)
    assert.equal(res.status, 403)
    const out = await res.json()
    assert.equal(out.error.code, "content_filtered", "命中标识句时要给出能指路的错误码")
    assert.match(out.error.message, /QQ 群 451129479/, "要给出拿修复方法的入口")
    assert.match(out.error.message, /非密钥或登录问题/, "要纠正「API 密钥无效」这个误导")
  } finally {
    s.restore()
  }
})

test("任何 403「非法请求」都给 content_filtered —— 不再按指纹判定", async () => {
  // 指纹在持续扩大（英文 → 中文 → 还没见过的写法），按指纹判定永远漏。
  // 403 + 非法请求这个组合目前只出现在内容过滤上（模型无权限是 400 无效模型id），
  // 所以宁可多给一句「进群」，也不把人甩回宿主那句「API 密钥无效」。
  const s = stubFetch(() => upstreamError(403, { code: 403, msg: "非法请求", type: "permission_error" }))
  try {
    const req = requestFor("deepseek-v4-1-flash-261017")
    const res = await (await loaderOf()).fetch(req.url, req.init)
    assert.equal(res.status, 403)
    const out = await res.json()
    assert.equal(out.error?.code, "content_filtered", "普通 system prompt + 403 非法请求也要指路")
    assert.match(out.error.message, /QQ 群 451129479/)
    assert.match(out.error.message, /非密钥或登录问题/)
  } finally {
    s.restore()
  }
})

// ─────────────────────────────────────────────────────────────
// 自动改写：那句标识句换成 DeepSeek-Harness，用户不用动 DSH 配置
// ─────────────────────────────────────────────────────────────

test("system prompt 里那句 DSH 标识会被自动改成 built on（连字符那招 2026-11-16 已失效）", async () => {
  const s = stubFetch(() => upstreamOk())
  try {
    const req = requestFor("deepseek-v4-1-flash-261017")
    const body = JSON.parse(req.init.body)
    body.messages = [
      { role: "system", content: "You are an AI agent powered by DeepSeek Harness." },
      ...body.messages,
    ]
    req.init.body = JSON.stringify(body)
    await (await loaderOf()).fetch(req.url, req.init)
    const sent = JSON.parse(s.calls[0].init.body)
    assert.equal(
      sent.messages[0].content,
      "You are an AI agent built on DeepSeek Harness.",
      "换成同义的 built on 才放行（实测：插连字符已经骗不过上游）",
    )
    assert.equal(sent.messages[1].content, "ping", "其余消息一个字符都不能动")
  } finally {
    s.restore()
  }
})

test("OpenCode 2 的身份句 → 自动改写成 working in OpenCode（用户不用去改客户端二进制）", async () => {
  // 上游把 `You are an AI agent running in OpenCode` 当内容指纹（实测 403 非法请求）。
  // 作者给的办法是改 opencode.exe 里的字节；插件在请求体这一层改更省事，且对任何客户端都生效。
  const s = stubFetch(() => upstreamOk())
  try {
    const req = requestFor("deepseek-v4-1-flash-261017")
    const body = JSON.parse(req.init.body)
    body.messages = [
      {
        role: "system",
        content: "You are an AI agent running in OpenCode, a coding agent harness.\n\nYou help the user with coding tasks.",
      },
      ...body.messages,
    ]
    req.init.body = JSON.stringify(body)
    await (await loaderOf()).fetch(req.url, req.init)
    const sent = JSON.parse(s.calls[0].init.body)
    assert.equal(
      sent.messages[0].content,
      "You are an AI agent working in OpenCode, a coding agent harness.\n\nYou help the user with coding tasks.",
      "只换动词，句子其余部分一个字节都不能动",
    )
  } finally {
    s.restore()
  }
})

test("OpenCode 身份句不在首行 → 不改（上游只拦首行，改了是多余改动）", async () => {
  const s = stubFetch(() => upstreamOk())
  try {
    const req = requestFor("deepseek-v4-1-flash-261017")
    const body = JSON.parse(req.init.body)
    const text = "preamble.\nYou are an AI agent running in OpenCode."
    body.messages = [{ role: "system", content: text }, ...body.messages]
    req.init.body = JSON.stringify(body)
    await (await loaderOf()).fetch(req.url, req.init)
    assert.equal(JSON.parse(s.calls[0].init.body).messages[0].content, text)
  } finally {
    s.restore()
  }
})

test("不涉及那句的 system prompt 原样发出", async () => {
  const s = stubFetch(() => upstreamOk())
  try {
    const req = requestFor("deepseek-v4-1-flash-261017")
    const body = JSON.parse(req.init.body)
    body.messages = [{ role: "system", content: "You are a helpful assistant." }, ...body.messages]
    req.init.body = JSON.stringify(body)
    await (await loaderOf()).fetch(req.url, req.init)
    const sent = JSON.parse(s.calls[0].init.body)
    assert.equal(sent.messages[0].content, "You are a helpful assistant.")
  } finally {
    s.restore()
  }
})

test("用户已经在 DSH 侧修好（换词 / 换介词 / 关掉整句）→ 插件一个字节都不改", async () => {
  // 这是「门禁」而不是「无差别替换」的关键：只认会被拦的原始形态，用户的修复必须原样保留
  const alreadyFixed = [
    "You are a helpful AI assistant. Your working directory is /repo.",
    "You are a coding agent using the deepseek model.",
    "An AI agent on DeepSeek Harness, ready to help.",
  ]
  for (const text of alreadyFixed) {
    const s = stubFetch(() => upstreamOk())
    try {
      const req = requestFor("deepseek-v4-1-flash-261017")
      const body = JSON.parse(req.init.body)
      body.messages = [{ role: "system", content: text }, ...body.messages]
      req.init.body = JSON.stringify(body)
      await (await loaderOf()).fetch(req.url, req.init)
      const sent = JSON.parse(s.calls[0].init.body)
      assert.equal(sent.messages[0].content, text, `已经修过的形态不许再动：${text.slice(0, 42)}…`)
    } finally {
      s.restore()
    }
  }
})
test("Claude Code 身份句 + 403 → 改写成 You're，且诊断指回原始身份句", async () => {
  const s = stubFetch(() => upstreamError(403, { code: 4100406, msg: "非法请求" }))
  try {
    const req = requestFor("deepseek-v4-1-flash-261017")
    const body = JSON.parse(req.init.body)
    const claudeIdentity = "You are Claude Code, Anthropic's official CLI."
    body.messages = [{ role: "system", content: claudeIdentity }, ...body.messages]
    req.init.body = JSON.stringify(body)
    const res = await (await loaderOf()).fetch(req.url, req.init)
    assert.equal(res.status, 403)
    const out = await res.json()
    assert.equal(out.error.code, "content_filtered", "命中 Claude 身份句时要给出能指路的错误码")
    assert.match(out.error.message, /QQ 群 451129479/, "要给出拿修复方法的入口")
    const sent = JSON.parse(s.calls[0].init.body)
    assert.equal(
      sent.messages[0].content,
      "You're Claude Code, Anthropic's official CLI.",
      "本地先把 `You are` 缩成 `You're`（改写后仍 403 时才走上面那条诊断）",
    )
  } finally {
    s.restore()
  }
})
test("Codex Desktop 的身份句会被自动改写成 working in the Codex CLI", async () => {
  const s = stubFetch(() => upstreamOk())
  try {
    const req = requestFor("deepseek-v4-1-flash-261017")
    const body = JSON.parse(req.init.body)
    const input = "You are a coding agent running in the Codex CLI, a terminal-based coding assistant."
    body.messages = [{ role: "system", content: input }, ...body.messages]
    req.init.body = JSON.stringify(body)
    await (await loaderOf()).fetch(req.url, req.init)
    const sent = JSON.parse(s.calls[0].init.body)
    assert.equal(
      sent.messages[0].content,
      "You are a coding agent working in the Codex CLI, a terminal-based coding assistant.",
      "只换动词 running→working，其余原样保留",
    )
    assert.equal(sent.messages[1].content, "ping", "其余消息一个字符都不能动")
  } finally {
    s.restore()
  }
})
test("Claude Desktop 的身份句会被自动改写成 You're Claude Code", async () => {
  const s = stubFetch(() => upstreamOk())
  try {
    const req = requestFor("deepseek-v4-1-flash-261017")
    const body = JSON.parse(req.init.body)
    body.messages = [
      {
        role: "system",
        content:
          "You are Claude Code, Anthropic's official CLI, running within the Claude Agent SDK.",
      },
      ...body.messages,
    ]
    req.init.body = JSON.stringify(body)
    await (await loaderOf()).fetch(req.url, req.init)
    const sent = JSON.parse(s.calls[0].init.body)
    assert.equal(
      sent.messages[0].content,
      "You're Claude Code, Anthropic's official CLI, running within the Claude Agent SDK.",
      "只改 `You are` 这一处，第二处 `Claude` 不动",
    )
  } finally {
    s.restore()
  }
})
test("连字符形态（Codex-CLI / Claude-Code）照样被拦 → 仍然要改", async () => {
  const cases = [
    // 连字符挡不住上游：`Codex-CLI` 实测仍 403，所以照样要把 running 换成 working
    ["You are a coding agent running in the Codex-CLI, a terminal-based assistant.",
     "You are a coding agent working in the Codex-CLI, a terminal-based assistant."],
    // `Claude-Code` 照样被拦，所以 `You are` 仍要缩成 `You're`
    ["You are Claude-Code, Anthropic's official CLI.",
     "You're Claude-Code, Anthropic's official CLI."],
  ]
  for (const [text, expected] of cases) {
    const s = stubFetch(() => upstreamOk())
    try {
      const req = requestFor("deepseek-v4-1-flash-261017")
      const body = JSON.parse(req.init.body)
      body.messages = [{ role: "system", content: text }, ...body.messages]
      req.init.body = JSON.stringify(body)
      await (await loaderOf()).fetch(req.url, req.init)
      const sent = JSON.parse(s.calls[0].init.body)
      assert.equal(sent.messages[0].content, expected, `改写结果不对：${text.slice(0, 42)}…`)
    } finally {
      s.restore()
    }
  }
})
test("中文身份句写在 system 首行 → 自动改写，且 403 改判成 content_filtered", async () => {
  const s = stubFetch(() => upstreamError(403, { code: 403, msg: "非法请求", type: "permission_error" }))
  try {
    const req = requestFor("deepseek-v4-1-flash-261017")
    const body = JSON.parse(req.init.body)
    body.messages = [{ role: "system", content: "你是一个由 DeepSeek Harness 驱动的 AI 智能体。" }, ...body.messages]
    req.init.body = JSON.stringify(body)
    const res = await (await loaderOf()).fetch(req.url, req.init)
    const sent = JSON.parse(s.calls[0].init.body)
    assert.equal(sent.messages[0].content, "你是一个由 DeepSeek-Harness 驱动的 AI 智能体。", "中文写法同样要把词间空格换成连字符")
    assert.equal(res.status, 403)
    assert.equal((await res.json()).error.code, "content_filtered", "中文写法不许退化成原始 403")
  } finally {
    s.restore()
  }
})

test("身份句不在 system 首行（第 2 行 / user 角色）→ 一个字节都不改", async () => {
  const cases = [
    [{ role: "system", content: "你是一个助手。\n你是一个由 DeepSeek Harness 驱动的 AI 智能体。" }, { role: "user", content: "ping" }],
    [{ role: "user", content: "你是一个由 DeepSeek Harness 驱动的 AI 智能体。" }],
    [{ role: "system", content: "You are a helpful assistant." }, { role: "assistant", content: "You are an AI agent powered by DeepSeek Harness." }, { role: "user", content: "ping" }],
  ]
  for (const messages of cases) {
    const s = stubFetch(() => upstreamOk())
    try {
      const req = requestFor("deepseek-v4-1-flash-261017")
      const body = JSON.parse(req.init.body)
      body.messages = messages
      req.init.body = JSON.stringify(body)
      await (await loaderOf()).fetch(req.url, req.init)
      const sent = JSON.parse(s.calls[0].init.body)
      assert.deepEqual(sent.messages, messages, "上游本来就放行的位置，不许改（改了是多余改动）")
    } finally {
      s.restore()
    }
  }
})

test("全小写 / 句末加感叹号的身份句照样会被拦，也照样要改写", async () => {
  const variants = [
    ["you are an ai agent powered by deepseek harness.", "you are an ai agent built on deepseek harness."],
    ["You are an AI agent powered by DeepSeek Harness!", "You are an AI agent built on DeepSeek Harness!"],
  ]
  for (const [input, expected] of variants) {
    const s = stubFetch(() => upstreamOk())
    try {
      const req = requestFor("deepseek-v4-1-flash-261017")
      const body = JSON.parse(req.init.body)
      body.messages = [{ role: "system", content: input }, ...body.messages]
      req.init.body = JSON.stringify(body)
      await (await loaderOf()).fetch(req.url, req.init)
      const sent = JSON.parse(s.calls[0].init.body)
      assert.equal(sent.messages[0].content, expected)
    } finally {
      s.restore()
    }
  }
})

test("Codex 身份句被拦时也要给 content_filtered 诊断（旧版只有 DSH 与 Claude 两条分支）", async () => {
  const s = stubFetch(() => upstreamError(403, { code: 403, msg: "非法请求", type: "permission_error" }))
  try {
    const req = requestFor("deepseek-v4-1-flash-261017")
    const body = JSON.parse(req.init.body)
    body.messages = [{ role: "system", content: "You are a coding agent running in the Codex CLI, a terminal-based coding assistant." }, ...body.messages]
    req.init.body = JSON.stringify(body)
    const res = await (await loaderOf()).fetch(req.url, req.init)
    assert.equal(res.status, 403)
    assert.equal((await res.json()).error.code, "content_filtered")
  } finally {
    s.restore()
  }
})

