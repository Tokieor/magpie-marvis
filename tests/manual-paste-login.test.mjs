// tests/manual-paste-login.test.mjs —— 「粘贴回调地址」登录路的形状锁
//
// 场景：magpie 跑在无显示的 NAS 容器里。插件的两条原路都不通 ——
//   · 隔离浏览器（CDP 拦回调）在容器里没有浏览器/显示；
//   · 「从本机 Marvis 导入」只认 Windows 注册表 + 客户端内存。
// 所以加一条：把授权页交给用户自己的浏览器，登录完把回调地址粘贴回来。
//
// 写死的事实（改了就会被拦住）：
//   ① 手动入口必须是 method: "code" 且不自己开页面（不能设 opened: true，否则 magpie 不再弹页）
//   ② guid 必须与授权那次同一个：QQ 的 state 是随机小数，微信的 state 就是 guid
//   ③ callback 的参数形态两种都认：callback(粘贴内容) 与 callback(url, 粘贴内容)
//   ④ state→guid 只在**换取成功后**消费：空输入/换取失败都能原样重试（#9 评审第 1 点）
//
// 全部离线：fetch 换成假实现。跑法：node --test tests/manual-paste-login.test.mjs

import test from "node:test"
import assert from "node:assert/strict"

import { methods } from "../src/hooks/methods.mjs"
import { pastedInputOf } from "../src/marvis/login.mjs"

const CODE = "A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4"
const OAUTH_PATH = "/marvis_client_login/marvis_oauth"

/** 替身 fetch：回调换码 302 + cookie；用户信息端点回 JSON；其余 404 */
function stubFetch() {
  const calls = []
  const real = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    calls.push({ url: u, init: init ?? {} })
    if (u.includes(OAUTH_PATH)) return ok302()
    if (u.includes("marvis_get_user_info")) {
      return new Response(JSON.stringify({ ret: 0, nick_name: "阿明", head_img_url: "" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    return new Response("not found", { status: 404 })
  }
  return {
    calls,
    restore() {
      globalThis.fetch = real
    },
  }
}

/** 官方成功形态：302 + 10 个 Set-Cookie，无 body */
function ok302() {
  const setCookies = [
    "openid=0A1B2C3D4E5F60718293A4B5C6D7E8F9; Path=/; Domain=.qq.com; HttpOnly",
    "accesstoken=TOKEN_abc123; Path=/; Domain=.qq.com; HttpOnly",
    "refreshtoken=REFRESH_def456; Path=/; Domain=.qq.com; HttpOnly",
    "logintype=QC; Path=/; Domain=.qq.com",
    "nickname=%E9%98%BF%E6%98%8E; Path=/; Domain=.qq.com",
    "head_img_url=https%3A%2F%2Fthirdqq.qlogo.cn%2Fabc%2F100; Path=/; Domain=.qq.com",
    "access_token_expire_time=1793000000; Path=/; Domain=.qq.com",
    "appid=1903794758; Path=/; Domain=.qq.com",
    "scope=all; Path=/; Domain=.qq.com",
    "is_locked=0; Path=/; Domain=.qq.com",
  ]
  const headers = new Headers()
  for (const c of setCookies) headers.append("set-cookie", c)
  headers.set("location", "https://yybadaccess.3g.qq.com/marvis_client_login/oauth_done")
  return new Response(null, { status: 302, headers })
}

/** 找手动入口：label 里同时有「粘贴」和平台名 */
function manual(platform) {
  return methods().find((m) => m.label.includes("粘贴") && m.label.includes(platform))
}

test("两种平台各有一条手动粘贴入口，且 authorize 返回 code 形态", async () => {
  for (const platform of ["QQ", "微信"]) {
    const m = manual(platform)
    assert.ok(m, `${platform} 手动入口应存在`)
    assert.equal(m.type, "oauth")
    const r = await m.authorize()
    assert.equal(r.method, "code", "method 必须是 code，否则宿主不会给输入框")
  }
})

test("QQ 手动入口：授权页是 graph.qq.com，login_type=QC，不自己开页面", async () => {
  const m = manual("QQ")
  const r = await m.authorize()
  const u = new URL(r.url)
  assert.equal(u.host, "graph.qq.com")
  assert.match(u.searchParams.get("redirect_uri"), /login_type=QC$/)
  assert.notEqual(r.opened, true, "opened: true 会让 magpie 不再弹页")
  assert.equal(r.method, "code")
  // 官方要求 state 是小数形状
  assert.match(u.searchParams.get("state"), /^\d+(\.\d+)?$/)
  assert.match(r.instructions, /粘贴/)
})

test("微信手动入口：授权页是 open.weixin.qq.com，state 就是 guid 形状", async () => {
  const m = manual("微信")
  const r = await m.authorize()
  const u = new URL(r.url)
  assert.equal(u.host, "open.weixin.qq.com")
  assert.match(u.searchParams.get("redirect_uri"), /login_type=WX$/)
  assert.match(u.searchParams.get("state"), /^[0-9a-f]{32}$/)
})

test("粘贴回调地址（单参形态 callback(input)）能换到登录态，guid 与授权时一致", async () => {
  const s = stubFetch()
  try {
    const m = manual("QQ")
    const r = await m.authorize()
    const state = new URL(r.url).searchParams.get("state")
    const pasted = `https://yybadaccess.3g.qq.com${OAUTH_PATH}?login_type=QC&code=${CODE}&state=${state}`

    const auth = await r.callback(pasted)
    assert.equal(auth.type, "success")
    assert.equal(auth.access, "TOKEN_abc123")
    assert.match(auth.accountId, /^QQ·/)
    assert.equal(auth.metadata.loginType, "1")
    assert.match(auth.metadata.guid, /^[0-9a-f]{32}$/)

    // 换码请求必须带同一个 guid，且不许跟随重定向
    const exchange = s.calls.find((c) => c.url.includes(OAUTH_PATH))
    assert.ok(exchange, "应该真的发了一次换码请求")
    assert.equal(exchange.init.redirect, "manual")
    assert.equal(exchange.init.headers["Ual-Access-Guid"], auth.metadata.guid)
    assert.match(exchange.url, /code=A1B2C3D4/)
    assert.match(exchange.url, new RegExp(`state=${state.replace(/\./g, "\\.")}`))
  } finally {
    s.restore()
  }
})

test("两参形态 callback(url, input) 也认（宿主签名可能变）", async () => {
  const s = stubFetch()
  try {
    const m = manual("QQ")
    const r = await m.authorize()
    const state = new URL(r.url).searchParams.get("state")
    const pasted = `https://yybadaccess.3g.qq.com${OAUTH_PATH}?login_type=QC&code=${CODE}&state=${state}`
    const auth = await r.callback(r.url, pasted)
    assert.equal(auth.type, "success")
  } finally {
    s.restore()
  }
})

test("粘贴内容里什么都没有时报可读错误，不是 -109", async () => {
  const m = manual("QQ")
  const r = await m.authorize()
  await assert.rejects(() => r.callback("随便写点东西"), /没有 code/)
})

test("两参形态下空输入不消耗这次登录，原样重试仍成功", async () => {
  const s = stubFetch()
  try {
    const m = manual("QQ")
    const r = await m.authorize()
    const state = new URL(r.url).searchParams.get("state")
    // 空输入时 helper 回退到授权 URL（它没有 code）→ 报可读错误，registry 不许被动
    await assert.rejects(() => r.callback(r.url, ""), /没有 code/)
    const pasted = `https://yybadaccess.3g.qq.com${OAUTH_PATH}?login_type=QC&code=${CODE}&state=${state}`
    const auth = await r.callback(pasted)
    assert.equal(auth.type, "success")
  } finally {
    s.restore()
  }
})

test("换取失败（上游抖动）会把映射放回去，重试成功", async () => {
  const real = globalThis.fetch
  let attempt = 0
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.includes(OAUTH_PATH)) {
      attempt += 1
      if (attempt === 1) {
        // 上游第一次回一个没有 Set-Cookie 的 302 → exchangeCode 抛错
        return new Response(null, {
          status: 302,
          headers: { location: "https://yybadaccess.3g.qq.com/marvis_client_login/oauth_done" },
        })
      }
      return ok302()
    }
    if (u.includes("marvis_get_user_info")) {
      return new Response(JSON.stringify({ ret: 0, nick_name: "阿明", head_img_url: "" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    return new Response("not found", { status: 404 })
  }
  try {
    const m = manual("QQ")
    const r = await m.authorize()
    const state = new URL(r.url).searchParams.get("state")
    const pasted = `https://yybadaccess.3g.qq.com${OAUTH_PATH}?login_type=QC&code=${CODE}&state=${state}`
    await assert.rejects(() => r.callback(pasted))
    const auth = await r.callback(pasted)
    assert.equal(auth.type, "success")
    assert.equal(auth.access, "TOKEN_abc123")
  } finally {
    globalThis.fetch = real
  }
})

test("同一个 state 只能换一次", async () => {
  const s = stubFetch()
  try {
    const m = manual("QQ")
    const r = await m.authorize()
    const state = new URL(r.url).searchParams.get("state")
    const pasted = `https://yybadaccess.3g.qq.com${OAUTH_PATH}?login_type=QC&code=${CODE}&state=${state}`
    await r.callback(pasted)
    await assert.rejects(() => r.callback(pasted), /登录流程已失效/)
  } finally {
    s.restore()
  }
})

test("pastedInputOf：优先取带 code 的那个参数", () => {
  const url = `https://yybadaccess.3g.qq.com${OAUTH_PATH}?login_type=QC&code=${CODE}&state=1.5`
  assert.equal(pastedInputOf(url, ""), url)
  assert.equal(pastedInputOf("", url), url)
  assert.equal(pastedInputOf("junk", url), url)
  assert.equal(pastedInputOf(CODE, ""), CODE)
  assert.equal(pastedInputOf(undefined, undefined), "")
})