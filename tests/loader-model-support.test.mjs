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

/**
 * 取 loader 描述符（loaderHook 的形状是 getAuth => { fetch, baseURL, apiKey }）
 *
 * @param {object} [options]  插件选项（设置页那份 JSON，例如 { firstLine: { text: "…" } }）
 * @param {object} [switches] provider 卡片上的开关（auth.options 的 key → 布尔）；
 *                            没给 = 插件默认（first_line_fallback 开、first_line_always 关）
 */
async function loaderOf(options, switches) {
  const input = {
    magpie: {
      option: (_provider, key) => (switches && key in switches ? switches[key] : undefined),
    },
  }
  const describe = await loaderHook(input, options)(async () => AUTH)
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
    assert.match(out.error.message, /不是密钥或登录问题/, "要纠正「API 密钥无效」这个误导")
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
    assert.match(out.error.message, /不是密钥或登录问题/)
  } finally {
    s.restore()
  }
})

// ─────────────────────────────────────────────────────────────
// 自动改写：那句标识句换成 DeepSeek-Harness，用户不用动 DSH 配置
// ─────────────────────────────────────────────────────────────

test("system prompt 里那句 DSH 标识会被自动改成 DeepSeek-Harness", async () => {
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
      "You are an AI agent running in DeepSeek Harness.",
      "两个词之间要换成连字符（实测这样上游才放行）",
    )
    assert.equal(sent.messages[1].content, "ping", "其余消息一个字符都不能动")
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

test("用户已经在 DSH 侧修好（连字符 / 破折号 / 关掉整句）→ 插件一个字节都不改", async () => {
  // 这是「门禁」而不是「无差别替换」的关键：只认会被拦的原始形态，用户的修复必须原样保留
  const alreadyFixed = [
    "You are an AI agent powered by DeepSeek-Harness. Your working directory is /repo.",
    "You are an AI agent powered by DeepSeek — Harness. Your working directory is /repo.",
    "You are a coding agent powered by the deepseek model.",
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
      assert.equal(
        sent.messages[0].content,
        text,
        `已经修过的形态不许再动：${text.slice(0, 42)}…`,
      )
    } finally {
      s.restore()
    }
  }
})
// ─────────────────────────────────────────────────────────────
// Claude Code 身份句的 403 诊断（issue #26，错误码 4100406）
// ─────────────────────────────────────────────────────────────

test("Claude Code 身份句 + 403 → 改写成 Claude-Code，且诊断指回原始身份句", async () => {
  const s = stubFetch(() => upstreamError(403, { code: 4100406, msg: "非法请求" }))
  try {
    const req = requestFor("deepseek-v4-1-flash-261017")
    const body = JSON.parse(req.init.body)
    const claudeIdentity = "You are Claude Code, Anthropic's official CLI for Claude."
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
      "You are an agent, Claude Code, Anthropic's official CLI for Claude.",
      "2026-11-17 起改成「拆主语」：插 `an agent, ` 让第一句不再是 `You are <产品名>`",
    )
  } finally {
    s.restore()
  }
})

// ─────────────────────────────────────────────────────────────
// 同一类内容过滤：Codex Desktop / Claude Desktop 的身份句
//
// 2026-11-15 直打上游实测（只换 system prompt 第一句，其余完全一样）：
//   Codex 原句 → 403；`Codex-CLI` → 200
//   Claude 原句 → 403；`Claude-Code` → 200
//
// ⚠ 2026-11-17 **复测：连字符形态失效了**（`Codex-CLI` / `Claude-Code` 都是 403，
//   见 issue #36 的表）。上游认的是**第一句的形状** —— `You are <产品名>` 当主语就拦，
//   插什么字符都不管用；**拆主语**才放行：
//     `You are a coding agent, running in the Codex CLI, …` → 200
//     `You are an agent, Claude Code, …` → 200（`Claude-Code` / 裸 `You are Claude.` 同样 200）
//   所以改写改成「插一个逗号 + 泛指名词」，名字一个字符都不删。
// ─────────────────────────────────────────────────────────────

test("Codex Desktop 的身份句会被拆主语（插逗号），名字原样保留", async () => {
  const s = stubFetch(() => upstreamOk())
  try {
    const req = requestFor("deepseek-v4-1-flash-261017")
    const body = JSON.parse(req.init.body)
    body.messages = [
      {
        role: "system",
        content:
          "You are a coding agent running in the Codex CLI, a terminal-based coding assistant. " +
          "Codex CLI is an open source project led by OpenAI.",
      },
      ...body.messages,
    ]
    req.init.body = JSON.stringify(body)
    await (await loaderOf()).fetch(req.url, req.init)
    const sent = JSON.parse(s.calls[0].init.body)
    assert.equal(
      sent.messages[0].content,
      "You are a coding agent, running in the Codex CLI, a terminal-based coding assistant. " +
        "Codex CLI is an open source project led by OpenAI.",
      "只在 `agent` 后面插一个逗号，`Codex CLI` 与后面的句子一个字符都不动",
    )
    assert.equal(sent.messages[1].content, "ping", "其余消息一个字符都不能动")
  } finally {
    s.restore()
  }
})

test("Claude Desktop 的身份句会被拆主语（插 `an agent, `），名字原样保留", async () => {
  const s = stubFetch(() => upstreamOk())
  try {
    const req = requestFor("deepseek-v4-1-flash-261017")
    const body = JSON.parse(req.init.body)
    body.messages = [
      {
        role: "system",
        content:
          "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.",
      },
      ...body.messages,
    ]
    req.init.body = JSON.stringify(body)
    await (await loaderOf()).fetch(req.url, req.init)
    const sent = JSON.parse(s.calls[0].init.body)
    assert.equal(
      sent.messages[0].content,
      "You are an agent, Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.",
      "只在 `You are ` 后面插 `an agent, `，`Claude Code` 与后面整句一个字符都不动",
    )
    assert.equal(sent.messages[1].content, "ping", "其余消息一个字符都不能动")
  } finally {
    s.restore()
  }
})

test("已经写成连字符老形态的（Codex-CLI / Claude-Code）也要被救回来", async () => {
  // 0.2.32–0.2.39 的改写产物就是这两个形态，2026-11-17 实测它们**同样 403**。
  // 用户可能已经按旧建议手改过自己的 prompt，所以老形态必须继续被（更彻底地）改写。
  const cases = [
    [
      "You are a coding agent running in the Codex-CLI, a terminal-based coding assistant.",
      "You are a coding agent, running in the Codex-CLI, a terminal-based coding assistant.",
    ],
    [
      "You are Claude-Code, Anthropic's official CLI for Claude.",
      "You are an agent, Claude-Code, Anthropic's official CLI for Claude.",
    ],
    ["You are Claude.", "You are an agent, Claude."],
  ]
  for (const [input, expected] of cases) {
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

test("已经改成「拆主语」形态的请求 → 一个字节都不改（幂等）", async () => {
  const alreadyFixed = [
    "You are a coding agent, running in the Codex CLI, a terminal-based coding assistant.",
    "You are a coding agent, running in the Codex-CLI, a terminal-based coding assistant.",
    "You are an agent, Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.",
    "You are an agent, Claude-Code, Anthropic's official CLI for Claude.",
    "You are Z-Code, an interactive agent working with the user toward their goals.",
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
test("句末标点归一：`…Claude` / `…Claude.` / `…Claude!` 视作同一句", async () => {
  const cases = [
    ["You are Claude", "You are an agent, Claude."],
    ["You are Claude.", "You are an agent, Claude."],
    ["You are Claude!", "You are an agent, Claude."],
  ]
  for (const [input, expected] of cases) {
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

test("用户自己改过的首句（不在白名单里）→ 一个字节都不动", async () => {
  // 用户可能已经按群里/旧建议手改过首句，或客户端自己换了措辞。
  // 这类请求改了也不一定对，还可能和他的改动打架、让前缀缓存反复失效 ⇒ 只诊断，不改写。
  const custom = [
    "You are Claude, my pair-programming buddy. Be concise.",
    "You are Claude Code, Anthropic's official CLI for Claude — but with our house rules.",
    "You are a coding agent running in the Codex CLI, a terminal-based coding assistant, for Acme Corp.",
    "You are ZCode, a helpful coding assistant for our monorepo.",
  ]
  for (const text of custom) {
    const s = stubFetch(() => upstreamOk())
    try {
      const req = requestFor("deepseek-v4-1-flash-261017")
      const body = JSON.parse(req.init.body)
      body.messages = [{ role: "system", content: text }, ...body.messages]
      req.init.body = JSON.stringify(body)
      await (await loaderOf()).fetch(req.url, req.init)
      const sent = JSON.parse(s.calls[0].init.body)
      assert.equal(sent.messages[0].content, text, `改过的首句不许动：${text.slice(0, 40)}…`)
    } finally {
      s.restore()
    }
  }
})

test("白名单替换只动第一句，行内其余内容与后续行原样", async () => {
  const s = stubFetch(() => upstreamOk())
  try {
    const req = requestFor("deepseek-v4-1-flash-261017")
    const body = JSON.parse(req.init.body)
    body.messages = [
      {
        role: "system",
        content:
          "You are Claude Code, Anthropic's official CLI for Claude. Second sentence stays.\nSecond line stays too.",
      },
      ...body.messages,
    ]
    req.init.body = JSON.stringify(body)
    await (await loaderOf()).fetch(req.url, req.init)
    const sent = JSON.parse(s.calls[0].init.body)
    assert.equal(
      sent.messages[0].content,
      "You are an agent, Claude Code, Anthropic's official CLI for Claude. Second sentence stays.\nSecond line stays too.",
    )
  } finally {
    s.restore()
  }
})

// ─────────────────────────────────────────────────────────────
// ZCode 身份句（issue #38，2026-11-17 直打上游实测）
//   `You are ZCode, an interactive agent working with the user toward their goals.` → 403
//   `You are ZCode.`                                                              → 403
//   `You are Z-Code, an interactive agent working with the user toward their goals.` → 200
//   `You are Zed, …` / `You are a helpful assistant.`                              → 200
// ⇒ 判据仍是**字面量 `ZCode`**（连字符形态在有空格可换的这条上照样有效），
//   与 0.2.38 那条「连字符失效、改成换句式」的 DSH 结论不是一回事，别把两条混成一条。
// ⚠ ZCode 的系统提示词不可配置（issue #38 原话），用户侧没有可行修法 ——
//   不改写就等于这个客户端在插件里彻底不能用。
// ─────────────────────────────────────────────────────────────

test("ZCode 的身份句会被自动改写成 Z-Code（长短两种写法都覆盖）", async () => {
  const variants = [
    [
      "You are ZCode, an interactive agent working with the user toward their goals.",
      "You are Z-Code, an interactive agent working with the user toward their goals.",
    ],
    ["You are ZCode.", "You are Z-Code."],
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
      assert.equal(sent.messages[1].content, "ping", "其余消息一个字符都不能动")
    } finally {
      s.restore()
    }
  }
})

test("无关的首句（Zed / helpful assistant）不许被 ZCode 那条规则误伤", async () => {
  const unrelated = [
    "You are Zed, an interactive agent working with the user toward their goals.",
    "You are a helpful assistant.",
  ]
  for (const text of unrelated) {
    const s = stubFetch(() => upstreamOk())
    try {
      const req = requestFor("deepseek-v4-1-flash-261017")
      const body = JSON.parse(req.init.body)
      body.messages = [{ role: "system", content: text }, ...body.messages]
      req.init.body = JSON.stringify(body)
      await (await loaderOf()).fetch(req.url, req.init)
      const sent = JSON.parse(s.calls[0].init.body)
      assert.equal(sent.messages[0].content, text, `上游本来就放行，改了是多余改动：${text.slice(0, 32)}…`)
    } finally {
      s.restore()
    }
  }
})

test("ZCode 身份句被拦时也要给 content_filtered 诊断（诊断集合与改写集合同步）", async () => {
  const s = stubFetch(() => upstreamError(403, { code: 403, msg: "非法请求", type: "permission_error" }))
  try {
    const req = requestFor("deepseek-v4-1-flash-261017")
    const body = JSON.parse(req.init.body)
    body.messages = [
      { role: "system", content: "You are ZCode, an interactive agent working with the user toward their goals." },
      ...body.messages,
    ]
    req.init.body = JSON.stringify(body)
    const res = await (await loaderOf()).fetch(req.url, req.init)
    const sent = JSON.parse(s.calls[0].init.body)
    assert.equal(sent.messages[0].content.startsWith("You are Z-Code,"), true, "先改写")
    assert.equal(res.status, 403)
    const out = await res.json()
    assert.equal(out.error.code, "content_filtered")
    assert.match(out.error.message, /QQ 群 451129479/, "要给出上报/修法的入口")
  } finally {
    s.restore()
  }
})

// ─────────────────────────────────────────────────────────────
// 中文 / 本地化身份句（2026-11-16 复测）
//
// 判据是「**system 首行 + 词对 + 单个空格**」，不是「三句英文模板」：
//   system 第 1 行 `你是一个由 DeepSeek Harness 驱动的 AI 智能体。`   → 403 非法请求
//   system 第 1 行 全小写 / 句末加 !                               → 403
//   system 第 2 行 / user 角色里的同一句                            → 200
// ⇒ 旧版只认英文整句，中文写法既不改写也不诊断，用户看到的是原始 403
//   （宿主再翻成「API 密钥无效」）—— 这就是本条用例要锁住的回归。
// ─────────────────────────────────────────────────────────────

test("中文身份句：实测原样就 200 ⇒ 白名单里没有它，一个字节都不改", async () => {
  const s = stubFetch(() => upstreamError(403, { code: 403, msg: "非法请求", type: "permission_error" }))
  try {
    const req = requestFor("deepseek-v4-1-flash-261017")
    const body = JSON.parse(req.init.body)
    body.messages = [{ role: "system", content: "你是一个由 DeepSeek Harness 驱动的 AI 智能体。" }, ...body.messages]
    req.init.body = JSON.stringify(body)
    const res = await (await loaderOf()).fetch(req.url, req.init)
    const sent = JSON.parse(s.calls[0].init.body)
    assert.equal(
      sent.messages[0].content,
      "你是一个由 DeepSeek Harness 驱动的 AI 智能体。",
      "2026-11-17 复测：中文原句直接 200，不改写（改了反而让前缀无谓变化、缓存失效）",
    )
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
    [{ role: "system", content: "You are a helpful assistant.\nYou are ZCode, an interactive agent working with the user toward their goals." }, { role: "user", content: "ping" }],
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

test("白名单是整句精确匹配：大小写 / 句内改词都不改（宁可漏，不可错改）", async () => {
  // 客户端的默认首句是固定字符串；改过大小写或改了几个词 = 用户自己动过 ⇒ 不在插件范围内。
  // 只有「句末标点」在归一范围内（`…Claude` / `…Claude.` / `…Claude!` 视作同一句）。
  const variants = [
    "you are an ai agent powered by deepseek harness.",
    "YOU ARE CLAUDE CODE.",
    "You are Claude Code, Anthropic's official CLI.",
  ]
  for (const text of variants) {
    const s = stubFetch(() => upstreamOk())
    try {
      const req = requestFor("deepseek-v4-1-flash-261017")
      const body = JSON.parse(req.init.body)
      body.messages = [{ role: "system", content: text }, ...body.messages]
      req.init.body = JSON.stringify(body)
      await (await loaderOf()).fetch(req.url, req.init)
      const sent = JSON.parse(s.calls[0].init.body)
      assert.equal(sent.messages[0].content, text, `非默认写法一律不动：${text.slice(0, 32)}…`)
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

// ─────────────────────────────────────────────────────────────
// 首行兜底（插件选项 firstLine）
//
// 白名单只覆盖「已知客户端的默认首句」；用户改过的首句、新客户端、没见过的写法都救不了，
// 而这些请求同样会被 403 拦死。兜底句不含任何 agent 产品名（实测 200），默认**只在被拦后**用：
//   mode=off     只走白名单
//   mode=blocked 403 非法请求 → 换兜底首行重试一次（默认）
//   mode=always  每个请求都把首行换成 text
// ─────────────────────────────────────────────────────────────

test("默认 blocked：403 后换兜底首行重试一次，第二次仍 403 才报 content_filtered", async () => {
  const s = stubFetch(() => upstreamError(403, { code: 403, msg: "非法请求", type: "permission_error" }))
  try {
    const req = requestFor("deepseek-v4-1-flash-261017")
    const body = JSON.parse(req.init.body)
    body.messages = [
      { role: "system", content: "You are Claude Code, Anthropic's official CLI for Claude.\nExtra line stays." },
      ...body.messages,
    ]
    req.init.body = JSON.stringify(body)
    const res = await (await loaderOf()).fetch(req.url, req.init)
    assert.equal(s.calls.length, 2, "被拦之后要重试一次（一次原样、一次兜底）")
    const retried = JSON.parse(s.calls[1].init.body)
    assert.equal(
      retried.messages[0].content,
      "You are a helpful assistant.\nExtra line stays.",
      "兜底句不含任何 agent 产品名；第二行原样保留",
    )
    assert.equal(res.status, 403)
    assert.equal((await res.json()).error.code, "content_filtered", "两次都被拦时才给诊断")
  } finally {
    s.restore()
  }
})

test("默认 blocked：重试成功时直接把 200 交给宿主（用户看不到 403）", async () => {
  let n = 0
  const s = stubFetch(() => {
    n += 1
    return n === 1
      ? upstreamError(403, { code: 403, msg: "非法请求", type: "permission_error" })
      : upstreamOk()
  })
  try {
    const req = requestFor("deepseek-v4-1-flash-261017")
    const body = JSON.parse(req.init.body)
    body.messages = [{ role: "system", content: "You are Claude, my buddy." }, ...body.messages]
    req.init.body = JSON.stringify(body)
    const res = await (await loaderOf()).fetch(req.url, req.init)
    assert.equal(res.status, 200)
    assert.equal(s.calls.length, 2)
    const retried = JSON.parse(s.calls[1].init.body)
    assert.equal(retried.messages[0].content, "You are a helpful assistant.", "自定义首句救不了时，换兜底句")
  } finally {
    s.restore()
  }
})

test("两个开关都关 → 403 不重试、不改写（只走白名单）", async () => {
  const s = stubFetch(() => upstreamError(403, { code: 403, msg: "非法请求", type: "permission_error" }))
  try {
    const req = requestFor("deepseek-v4-1-flash-261017")
    const res = await (await loaderOf({}, { first_line_fallback: false })).fetch(req.url, req.init)
    assert.equal(s.calls.length, 1)
    assert.equal(res.status, 403)
  } finally {
    s.restore()
  }
})

test("first_line_always 开着：每个请求的首行都被换成配置的那句（优先级高于白名单）", async () => {
  const s = stubFetch(() => upstreamOk())
  try {
    const req = requestFor("deepseek-v4-1-flash-261017")
    const body = JSON.parse(req.init.body)
    body.messages = [
      { role: "system", content: "You are Claude Code, Anthropic's official CLI for Claude.\nSecond line stays." },
      ...body.messages,
    ]
    req.init.body = JSON.stringify(body)
    const custom = "You are an assistant that answers in Chinese."
    await (await loaderOf({ firstLine: { text: custom } }, { first_line_always: true })).fetch(req.url, req.init)
    assert.equal(s.calls.length, 1, "always 模式直接改，不需要先撞一次 403")
    const sent = JSON.parse(s.calls[0].init.body)
    assert.equal(sent.messages[0].content, `${custom}\nSecond line stays.`)
  } finally {
    s.restore()
  }
})

test("选项的键名是中文「提示词首行替换」时照读（设置页那个框里给人看的就是它）", async () => {
  const NL = String.fromCharCode(10)
  const s = stubFetch(() => upstreamOk())
  try {
    const req = requestFor("deepseek-v4-1-flash-261017")
    const body = JSON.parse(req.init.body)
    const sys = "You are Claude Code, Anthropic's official CLI for Claude." + NL + "Second line stays."
    body.messages = [{ role: "system", content: sys }, ...body.messages]
    req.init.body = JSON.stringify(body)
    const custom = "You are an assistant that answers in Chinese."
    await (await loaderOf({ "提示词首行替换": custom }, { first_line_always: true })).fetch(req.url, req.init)
    const sent = JSON.parse(s.calls[0].init.body)
    assert.equal(sent.messages[0].content, custom + NL + "Second line stays.")
  } finally {
    s.restore()
  }
})

test("选项是新形状 { text } 时照读（设置页那个 JSON 框只留一个键）", async () => {
  const NL = String.fromCharCode(10)
  const s = stubFetch(() => upstreamOk())
  try {
    const req = requestFor("deepseek-v4-1-flash-261017")
    const body = JSON.parse(req.init.body)
    const sys = "You are Claude Code, Anthropic's official CLI for Claude." + NL + "Second line stays."
    body.messages = [{ role: "system", content: sys }, ...body.messages]
    req.init.body = JSON.stringify(body)
    const custom = "You are an assistant that answers in Chinese."
    await (await loaderOf({ text: custom }, { first_line_always: true })).fetch(req.url, req.init)
    const sent = JSON.parse(s.calls[0].init.body)
    assert.equal(sent.messages[0].content, custom + NL + "Second line stays.")
  } finally {
    s.restore()
  }
})

test("text 留空 / 选项形状不对 → 用内置兜底句，绝不让请求失败", async () => {
  const cases = [
    {},
    { firstLine: {} },
    { firstLine: { text: "   " } },
    { firstLine: { text: 42 } },
    { firstLine: "oops" },
  ]
  for (const options of cases) {
    let n = 0
    const s = stubFetch(() => {
      n += 1
      return n === 1
        ? upstreamError(403, { code: 403, msg: "非法请求", type: "permission_error" })
        : upstreamOk()
    })
    try {
      const req = requestFor("deepseek-v4-1-flash-261017")
      const body = JSON.parse(req.init.body)
      body.messages = [{ role: "system", content: "You are Claude, my buddy." }, ...body.messages]
      req.init.body = JSON.stringify(body)
      const res = await (await loaderOf(options)).fetch(req.url, req.init)
      assert.equal(res.status, 200, `配置写错也要能跑：${JSON.stringify(options)}`)
      assert.equal(JSON.parse(s.calls[1].init.body).messages[0].content, "You are a helpful assistant.")
    } finally {
      s.restore()
    }
  }
})

// ── OpenCode（本 fork 的起因：上游白名单里一直没有这个客户端）────────────

test("OpenCode 2 的身份句会被拆主语（插逗号），名字原样保留", async () => {
  const variants = [
    [
      "You are an AI agent running in OpenCode, a coding agent harness. Your working directory is /repo.",
      "You are an AI agent, running in OpenCode, a coding agent harness. Your working directory is /repo.",
    ],
    ["You are an AI agent running in OpenCode.", "You are an AI agent, running in OpenCode."],
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
      assert.equal(sent.messages[1].content, "ping", "其余消息一个字符都不能动")
    } finally {
      s.restore()
    }
  }
})

test("OpenCode 身份句被拦时也要给 content_filtered 诊断（诊断集合与改写集合同步）", async () => {
  const s = stubFetch(() => upstreamError(403, { code: 403, msg: "非法请求", type: "permission_error" }))
  try {
    const req = requestFor("deepseek-v4-1-flash-261017")
    const body = JSON.parse(req.init.body)
    body.messages = [
      { role: "system", content: "You are an AI agent running in OpenCode, a coding agent harness." },
      ...body.messages,
    ]
    req.init.body = JSON.stringify(body)
    // 关掉兜底重试，直接看诊断文案
    const res = await (await loaderOf(undefined, { first_line_fallback: false })).fetch(req.url, req.init)
    assert.equal(res.status, 403)
    const out = await res.json()
    assert.equal(out.error.code, "content_filtered")
    assert.match(out.error.message, /QQ 群 451129479/)
    assert.equal(
      JSON.parse(s.calls[0].init.body).messages[0].content,
      "You are an AI agent, running in OpenCode, a coding agent harness.",
      "诊断之前先按白名单改写",
    )
  } finally {
    s.restore()
  }
})

test("上游准入闸门：Marvis-Scene 必须是 chat、AgentTag 必须是 main_agent", async () => {
  // 上游把「场景不放行」和「模型真不存在」共用 4130001 一个码：
  // preload_summary / auto_discovery 这个场景只放行腾讯自家的 deepseek / hunyuan，
  // claude-sonnet-4-6 / claude-opus-4-6 / gpt-5.4 会一律被判成「无效模型id」。
  const s = stubFetch(() => upstreamOk())
  try {
    const req = requestFor("deepseek-v4-1-flash-261017")
    await (await loaderOf()).fetch(req.url, req.init)
    const sent = s.calls[0].init.headers
    const pick = (name) => sent[name] ?? sent[name.toLowerCase()] ?? Object.entries(sent).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1]
    assert.equal(pick("Marvis-Scene"), "chat", "场景必须是 chat，否则 claude / gpt 三个模型全 4130001")
    assert.equal(pick("Marvis-AgentTag"), "main_agent")
  } finally {
    s.restore()
  }
})
