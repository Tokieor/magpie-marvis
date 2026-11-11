// tests/mount.test.mjs —— 入口 / 钩子挂载契约
//
//   ① 入口只导出一个函数（magpie 会把每个函数导出都当插件工厂调用）
//   ② _internal 是对象（helper 不暴露成插件）
//   ③ 钩子齐全，形状对
//   ④ config() 未登录也有模型（否则卡片显示 "0 models"）
//   ⑤ authorize() 立刻返回 Promise（真正的登录在 callback 里）
//   ⑥ loader() 给 baseURL / apiKey / fetch
//   ⑦ 两种模型形状**不能混**：config 用 modalities 数组 + tool_call；
//      provider.models 用 capabilities 对象 + toolcall
//
// 全部离线；不需要 magpie 进程、不需要凭据、不联网。
// 跑法：node --test tests/mount.test.mjs

import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import * as entry from "../index.mjs"
import { _internal } from "../index.mjs"
import { usage, usageWindow } from "../src/quota.mjs"

const { MarvisAuthPlugin } = entry

test("入口只导出一个函数（插件工厂）", () => {
  const functions = Object.entries(entry)
    .filter(([, value]) => typeof value === "function")
    .map(([key]) => key)
  assert.deepEqual(functions, ["MarvisAuthPlugin"])
})

test("_internal 是对象，helper 不暴露成顶层函数导出", () => {
  assert.equal(typeof _internal, "object")
  assert.equal(_internal.PROVIDER, "marvis")
  assert.equal(_internal.PROVIDER_NAME, "腾讯 Marvis TENCENT")
  assert.equal(typeof _internal.staticModels, "function")
  assert.equal(typeof _internal.providerModels, "function")
  assert.equal(_internal.BASE_V1, "https://yybadaccess.3g.qq.com/v1")
})

test("六个钩子齐全", async () => {
  const plugin = await MarvisAuthPlugin({})
  assert.equal(typeof plugin.config, "function")
  assert.ok(plugin.auth && typeof plugin.auth === "object")
  assert.equal(plugin.auth.provider, _internal.PROVIDER)
  assert.equal(typeof plugin.auth.refresh, "function")
  assert.equal(typeof plugin.auth.loader, "function")
  assert.equal(typeof plugin.auth.usage, "function")
  assert.ok(Array.isArray(plugin.auth.methods) && plugin.auth.methods.length >= 2)
  for (const m of plugin.auth.methods) assert.equal(typeof m.authorize, "function")
  assert.equal(typeof plugin.provider.models, "function")
  assert.equal(plugin.provider.id, _internal.PROVIDER)
  assert.ok(plugin.auth.icon?.startsWith("data:image/"), "图标必须内嵌（外部 URL 在 git 源下不渲染）")
  assert.ok(Number.isInteger(plugin.auth.maxConcurrency) && plugin.auth.maxConcurrency >= 1)
})

test("config() 未登录也声明了模型，且 modalities 是数组、tool_call 有下划线", async () => {
  const plugin = await MarvisAuthPlugin({})
  const cfg = {}
  await plugin.config(cfg)
  const models = cfg.provider?.[_internal.PROVIDER]?.models
  assert.ok(models && Object.keys(models).length > 0, "config.models 不能为空（铁律 1）")
  assert.equal(models["deepseek-v4-1-flash-261017"]?.id, "deepseek-v4-1-flash-261017", "config.models 必须以真实模型名为键")

  for (const m of Object.values(models)) {
    assert.equal(typeof m.id, "string")
    // config 形状：modalities.input / output 是**数组**
    assert.ok(Array.isArray(m.modalities.input), `${m.id}.modalities.input 必须是数组`)
    assert.ok(m.modalities.input.includes("text"), `${m.id}.modalities.input 必须含 text`)
    assert.ok(Array.isArray(m.modalities.output), `${m.id}.modalities.output 必须是数组`)
    // config 形状：tool_call 带下划线
    assert.equal(typeof m.tool_call, "boolean", `${m.id}.tool_call 必须是布尔（config 形状）`)
    assert.equal(m.toolcall, undefined, `${m.id} 不该有 toolcall（那是 provider.models 的形状）`)
    assert.equal(typeof m.attachment, "boolean", `${m.id}.attachment 必须是布尔`)
    assert.equal(typeof m.reasoning, "boolean", `${m.id}.reasoning 必须是布尔`)
    assert.equal(typeof m.limit.context, "number")
    assert.equal(typeof m.limit.output, "number")
  }
})

test("provider.models：capabilities.input 五个模态键必须全是布尔", async () => {
  const plugin = await MarvisAuthPlugin({})
  const models = await plugin.provider.models(async () => null)
  assert.ok(models && typeof models === "object" && Object.keys(models).length > 0)

  for (const m of Object.values(models)) {
    // provider.models 形状：capabilities.input 是**对象**，五个键都得写
    for (const key of ["text", "image", "audio", "video", "pdf"]) {
      assert.equal(
        typeof m.capabilities.input[key],
        "boolean",
        `${m.id}.capabilities.input.${key} 必须是布尔（漏了等于厂商未表态，会被 models.dev 投票带偏）`,
      )
    }
    assert.equal(m.capabilities.input.text, true, `${m.id} 必须能收文字`)
    // provider.models 形状：toolcall 无下划线
    assert.equal(typeof m.capabilities.toolcall, "boolean")
    assert.equal(m.tool_call, undefined, `${m.id} 不该有 tool_call（那是 config 形状）`)
    assert.equal(typeof m.api.id, "string", "api.id 必须是上游槽位名")
    assert.ok(m.api.id, "api.id 不能为空，漏了会退化成数组下标 0")
    assert.equal(m.api.url, _internal.BASE_V1)
    assert.equal(m.api.npm, "@ai-sdk/openai-compatible")
    assert.equal(typeof m.id, "string")
    assert.equal(typeof m.name, "string")
    assert.equal(m.id, m.name, "id 用真实模型名，路由才显示名字")
  }
})

test("authorize 是 async 函数，且立刻返回（不 await 登录）", async () => {
  const plugin = await MarvisAuthPlugin({})
  for (const method of plugin.auth.methods) {
    assert.equal(typeof method.authorize, "function")
    assert.equal(method.authorize.constructor.name, "AsyncFunction")
  }
  // 铁律 2：authorize 必须立刻返回一个带 callback 的 flow（不碰网络、不等用户）
  const started = Date.now()
  const flow = await plugin.auth.methods[0].authorize(undefined)
  // 没有浏览器时这条路会先 listen 一个本地端口再返回（毫秒级），给一点余量
  assert.ok(Date.now() - started < 2_000, "authorize 不能阻塞")
  assert.equal(typeof flow.callback, "function")
  assert.equal(typeof flow.url, "string")
  assert.ok(flow.url.length > 0, "flow.url 不能为空")
  flow.close?.()
})

test("授权 URL 带对的 appid 与 redirect_uri", () => {
  // 直接测纯函数：不依赖这台机器有没有浏览器（有浏览器时 authorize 给的是授权页，
  // 没有时给的是局域网扫码页 —— 两者 url 形状不同，断言 authorize 的 url 会 flaky）
  const qq = _internal.authorizeUrl("QC", "0123456789abcdef0123456789abcdef")
  assert.match(qq, /client_id=1903794758/)
  assert.match(
    qq,
    /redirect_uri=https%3A%2F%2Fyybadaccess\.3g\.qq\.com%2Fmarvis_client_login%2Fmarvis_oauth/,
  )

  const wx = _internal.authorizeUrl("WX", "0123456789abcdef0123456789abcdef")
  assert.match(wx, /appid=wxb650708317d56f88/)
  // 微信的 state 就是 guid（回调里能靠它找回 guid）
  assert.match(wx, /state=0123456789abcdef0123456789abcdef/)
})

test("没有浏览器时 QQ/微信登录自动改走局域网扫码，而不是报「请装浏览器」", async (t) => {
  if (_internal.localBrowserAvailable()) {
    t.skip("这台机器有 Chromium，走的是浏览器路")
    return
  }
  const plugin = await MarvisAuthPlugin({})
  for (const method of plugin.auth.methods.slice(0, 2)) {
    const flow = await method.authorize(undefined)
    // 给用户的是**局域网页面**，不是 QQ/微信的授权页
    assert.match(flow.url, /^http:\/\/\d+\.\d+\.\d+\.\d+:\d+\/s\/[0-9a-f]{16}\/$/)
    // opened:false —— 要让 magpie 把这个地址交给用户那台机器打开
    assert.equal(flow.opened, false)
    assert.ok(flow.instructions.includes(flow.url), "说明里必须带这个地址，用户要能复制")
    flow.close?.()
  }
})

test("局域网扫码是显式的两个方法（远程访问时手选）", async () => {
  const plugin = await MarvisAuthPlugin({})
  const labels = plugin.auth.methods.map((m) => m.label)
  assert.ok(
    labels.some((l) => /微信扫码/.test(l)),
    `方法列表里要有微信扫码：${labels.join(" / ")}`,
  )
  assert.ok(
    labels.some((l) => /QQ 扫码/.test(l)),
    `方法列表里要有 QQ 扫码：${labels.join(" / ")}`,
  )
})

test("loader() 给 baseURL / apiKey / fetch；未登录返回空对象", async () => {
  const plugin = await MarvisAuthPlugin({})
  const out = await plugin.auth.loader(async () => ({
    type: "oauth",
    access: "token",
    metadata: { openid: "OPENID", guid: "GUID", loginType: "6" },
  }))
  assert.equal(typeof out.fetch, "function")
  assert.equal(out.baseURL, _internal.BASE_V1)
  assert.equal(out.apiKey, "placeholder")

  const empty = await plugin.auth.loader(async () => null)
  assert.deepEqual(empty, {})
})

test("usage() 未登录时给出 error 而不是伪造 0", async () => {
  const plugin = await MarvisAuthPlugin({})
  const anonymous = await plugin.auth.usage(async () => null)
  assert.match(String(anonymous.error), /未登录/)
  assert.deepEqual(anonymous.windows, [])
})

test("usage 构造器可用：至少造一条参与路由的窗口", () => {
  const value = usage({
    plan: "Test",
    windows: [usageWindow({ name: "令牌", amount: 37, limit: 1_000_000, unit: "tokens" })],
  })
  assert.equal(typeof value.plan, "string")
  assert.equal(value.windows.length, 1)
  assert.equal(Number.isFinite(value.windows[0].used), true)
})

test("refresh 走串行锁（成对轮换的 token 不能被并发打掉）", () => {
  const source = readFileSync(new URL("../src/hooks/refresh.mjs", import.meta.url), "utf8")
  assert.match(source, /createRefreshLock/)
  assert.match(source, /lock\.run\(/)
  // 合并语义：不能只返回新字段
  assert.match(source, /metadata: \{ \.\.\.meta/)
})

test("native 目录若存在则 4 个文件必须齐全（缺一个就静默返回 null）", () => {
  // ⚠ 4 个文件是**可选增强**，不随仓库分发（平台相关的二进制，体积大）。
  //   目录不存在时直接跳过 —— 不能因为没装它就判测试失败。
  const dir = fileURLToPath(new URL("../native", import.meta.url))
  if (!existsSync(dir)) return
  for (const f of ["beacon_napi.node", "qimei.dll", "beacon_sdk.dll", "beacon_wrapper.dll"]) {
    assert.ok(existsSync(join(dir, f)), `native/${f} 必须齐全（else getUskey() 静默返回 null）`)
  }
})

test("config() 合并：用户改过的值优先，插件只补缺", async () => {
  const { mergeModels } = await import("../src/hooks/config.mjs")
  const { staticModels } = await import("../src/context.mjs")
  const defaults = staticModels()

  // 用户把 main-auto 的上下文改成 2M，并删掉了 hunyuan-turbos-vision
  const user = Object.fromEntries(
    Object.entries(defaults)
      .filter(([id]) => id !== "HY-Vision-2.0-instruct")
      .map(([id, m]) => [id, id === "deepseek-v4-1-flash-261017" ? { ...m, limit: { ...m.limit, context: 2_000_000 } } : m]),
  )

  const merged = mergeModels(defaults, user)
  const main = merged["deepseek-v4-1-flash-261017"]

  assert.equal(main.limit.context, 2_000_000, "用户设的 2M 必须保留")
  assert.equal(typeof main.limit.output, "number", "用户没改的 output 不能被吃掉")
  assert.ok(merged["HY-Vision-2.0-instruct"], "默认表里有、用户没有的模型要追加回来")
})

test("config() 已有 provider 时不重置用户配置", async () => {
  const { MarvisAuthPlugin } = await import("../index.mjs")
  const plugin = await MarvisAuthPlugin({})
  const cfg = {
    provider: {
      marvis: {
        name: "我改的名字",
        npm: "@ai-sdk/openai-compatible",
        api: "https://custom.example.com/v1",
        models: [
          {
            id: "main-auto",
            name: "我的 V4.1 Flash",
            limit: { context: 2_000_000, output: 64_000 },
            modalities: { input: ["text"], output: ["text"] },
            tool_call: true,
            attachment: false,
            reasoning: true,
          },
        ],
      },
    },
  }
  await plugin.config(cfg)
  const p = cfg.provider.marvis
  assert.equal(p.name, "我改的名字", "provider 名不能被我覆盖")
  assert.equal(p.api, "https://custom.example.com/v1", "api 不能被我覆盖")
  assert.equal(p.models["deepseek-v4-1-flash-261017"].limit.context, 2_000_000, "上下文不能被我覆盖")
  assert.equal(p.models["deepseek-v4-1-flash-261017"].name, "我的 V4.1 Flash")
  assert.equal(p.models["deepseek-v4-1-flash-261017"].id, "deepseek-v4-1-flash-261017")
  assert.equal(p.models["deepseek-v4-1-flash-261017"].apiId, "main-auto", "apiId 保留上游槽位名")
})
