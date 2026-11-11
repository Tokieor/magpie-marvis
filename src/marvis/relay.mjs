// 局域网登录中继 —— 让「没有桌面」的机器也能登录（NAS / Docker / 远程访问）
//
// 为什么需要它（issue #4）：
//   `browser.mjs` 的路子要求**跑插件的这台机器**上有 Chromium，`desktop.mjs` 要求 Windows
//   上有 Marvis 客户端。飞牛 / 群晖 / Docker 里两样都没有，用户点登录只会看到
//   「没有找到可用的 Chromium 内核浏览器」——而 magpie 往往是被局域网里另一台电脑访问的，
//   那台电脑明明有浏览器，插件却用不上。
//
// 解法：把「显示二维码」搬到**用户自己的浏览器**里，把「拿 code」留在服务端。
//   插件在本机起一个 HTTP 服务（0.0.0.0:随机端口），页面只做两件事：显示二维码、显示状态。
//   二维码的 uuid / qrsig 由插件自己申请、自己在服务端长轮询 —— **浏览器全程不碰回调地址**，
//   所以 code 不会被浏览器消费掉。这正是 CDP 拦截（`browser.mjs`）在没有浏览器时做不到的事：
//   拦截必须发生在请求发出之前，而这里干脆不让那个请求存在。
//
// 两条通道（都已按上游页面实测的协议实现）：
//   · 微信：`connect/qrconnect` 页面里的 `uuid` → `long.open.weixin.qq.com/connect/l/qrconnect`
//           长轮询，返回 `window.wx_errcode=…;window.wx_code='…'`。扫完直接拿到 code。
//   · QQ  ：`xui.ptlogin2` 的 xlogin（拿 pt_login_sig）→ `ssl.ptlogin2` 的 ptqrshow（拿 qrsig）
//           → `ptqrlogin` 长轮询（`ptuiCB('66',…)` 未扫 / `'0'` 成功 + jumpUrl）
//           → 顺着 jumpUrl 的 302 走到 authorize，从 Location 里取 `code=`。
//
// ⚠ 只有本机起服务、页面在用户浏览器里，**没有**任何凭据出网到第三方；
//   二维码本身就是给用户扫的，所以页面上不需要登录态。
// ⚠ 端口随机 + 路径里带一次性 token：同一局域网里别的设备猜不到这个页面，
//   否则邻居扫了码就等于把**他的**账号绑到你的 magpie 上。
// ⚠ 状态一律放闭包（每次 `startRelayLogin()` 一份），不要放模块级变量 ——
//   宿主同进程服务多个账号，模块级变量必然串号（AGENTS §五）。

import { createServer } from "node:http"
import { networkInterfaces } from "node:os"
import { randomBytes, randomUUID } from "node:crypto"

/** 普通 Chrome UA：qrconnect / ptlogin 这些页面按浏览器 UA 下发，别用 Marvis 的 Electron UA */
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/152.0.7977.130 Safari/537.36"

/** 一次扫码流程最多等多久（二维码本身约 5 分钟失效，过期会自动换一张） */
export const RELAY_TIMEOUT_MS = 5 * 60_000

/**
 * QQ `ptqrtoken` 的算法（上游 `ptlogin2` 页面里的 `hash33`）。
 *
 * ⚠ 必须用 `(e<<5) + e + c` 的累加式，最后 `& 0x7fffffff`：
 *   写成 `e = (e<<5) + c` 会得到一个完全不同的数，服务端只会回 `'66'`（永远「未扫描」）。
 *
 * @param {string} s `qrsig` cookie
 * @returns {number}
 */
export function hash33(s) {
  let e = 0
  const t = String(s ?? "")
  for (let i = 0; i < t.length; i += 1) e = (e << 5) + e + t.charCodeAt(i)
  return e & 0x7fffffff
}

/**
 * 解析微信长轮询的响应体。
 *
 * 形如 `window.wx_errcode=408;window.wx_code='';`
 *   · 405 等待扫码 · 404 已扫码待确认 · 403 已取消 · 402 二维码失效
 *   · 408 本轮长轮询到期（**不是**失效，继续轮询即可）
 *   · 拿到 `wx_code` 就是成功
 *
 * @param {string} text
 * @returns {{ errcode: number, code: string }}
 */
/**
 * QQ 的 `g_tk`（qlogin_v2.js 里的 Q.getToken）：种子是 5381，不是 hash33 的 0。
 * @param {string} s
 */
export function gtk(s) {
  let hash = 5381
  const t = String(s ?? "")
  for (let i = 0; i < t.length; i += 1) hash += (hash << 5) + t.charCodeAt(i)
  return hash & 0x7fffffff
}

export function parseWxPoll(text) {
  const s = String(text ?? "")
  const err = /wx_errcode\s*=\s*(-?\d+)/.exec(s)
  const code = /wx_code\s*=\s*'([^']*)'/.exec(s)
  return {
    errcode: err ? Number(err[1]) : Number.NaN,
    code: code ? code[1] : "",
  }
}

/**
 * 解析 QQ `ptqrlogin` 的响应体：`ptuiCB('66','0','','0','二维码未失效。', '')`
 *
 * 第一个参数是状态码：`'0'` 成功（第三个参数是跳转地址）、`'66'` 未扫描、
 * `'65'` 已取消、`'67'` 已失效。
 *
 * @param {string} text
 * @returns {{ code: string, jumpUrl: string, message: string }}
 */
export function parsePtuiCB(text) {
  const s = String(text ?? "")
  const m = /ptuiCB\(\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'/.exec(s)
  if (!m) return { code: "", jumpUrl: "", message: "" }
  return { code: m[1], jumpUrl: m[3], message: m[5] }
}

/** 最小的 cookie 罐：只做「收 Set-Cookie、发 Cookie」，够 ptlogin 用 */
function createJar() {
  /** @type {Map<string, string>} */
  const jar = new Map()
  return {
    /**
     * @param {Response} res
     */
    save(res) {
      const lines =
        typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : []
      for (const line of lines) {
        const pair = String(line).split(";")[0]
        const i = pair.indexOf("=")
        if (i <= 0) continue
        const name = pair.slice(0, i).trim()
        const value = pair.slice(i + 1).trim()
        if (!name) continue
        // 上游同一个名字会下发多次（不同 Domain/Path），其中一次可能是「删除」（空值）。
        // 我们这个罐子不分 Domain，所以空值不许覆盖已有值 —— 否则 p_skey 被清成空，
        // 确认授权时 g_tk 算出来是 5381，腾讯当成 CSRF 又跳回授权页（实测踩过）。
        if (!value && jar.has(name)) continue
        jar.set(name, value)
      }
    },
    /** @param {string} name */
    get(name) {
      return jar.get(name) ?? ""
    },
    header() {
      return [...jar].map(([k, v]) => `${k}=${v}`).join("; ")
    },
  }
}

/**
 * 本机的局域网 IPv4 地址，私网优先（192.168/10./172.16-31）。
 *
 * 用户是从**另一台设备**的浏览器打开这个地址的，所以不能给 127.0.0.1。
 *
 * @param {() => Record<string, any>} [ifaces] 便于测试注入
 * @returns {Array<{ name: string, address: string }>}
 */
export function lanAddresses(ifaces = networkInterfaces) {
  const isPrivate = (ip) =>
    /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)

  /** @type {Array<{ name: string, address: string }>} */
  const out = []
  for (const [name, list] of Object.entries(ifaces() ?? {})) {
    for (const a of /** @type {any[]} */ (list ?? [])) {
      if (a?.family !== "IPv4" || a?.internal) continue
      if (!a.address) continue
      out.push({ name, address: String(a.address) })
    }
  }
  // 私网排前面；docker 的 172.17.0.1 也是私网，但它不可达 —— 由调用方/用户挑，
  // 这里只保证「先给一个像样的地址」
  return out.sort((a, b) => Number(isPrivate(b.address)) - Number(isPrivate(a.address)))
}

/**
 * 微信通道：qrconnect 页面里带 `uuid`，二维码图在 `connect/qrcode/<uuid>`，
 * 状态靠 `l/qrconnect` 长轮询。
 *
 * @param {{ authUrl: string, fetchImpl: typeof fetch }} o
 */
async function wechatSession({ authUrl, fetchImpl }) {
  const res = await fetchImpl(authUrl, { headers: { "User-Agent": UA } })
  const html = await res.text()
  const uuid = /l\/qrconnect\?uuid=([A-Za-z0-9_-]+)/.exec(html)?.[1] ?? ""
  if (!uuid) {
    throw new Error(
      "没能从微信授权页里取到二维码标识（页面结构可能变了）。请改用 QQ 登录，或把这条错误反馈给插件作者。",
    )
  }
  const imgRes = await fetchImpl(`https://open.weixin.qq.com/connect/qrcode/${uuid}`, {
    headers: { "User-Agent": UA, Referer: authUrl },
  })
  const image = Buffer.from(await imgRes.arrayBuffer())
  // 微信给的是 JPEG、QQ 给的是 PNG —— 按实际类型下发，别写死
  const contentType = imgRes.headers.get("content-type") ?? "image/png"

  return {
    image,
    contentType,
    /** @returns {Promise<{ status: string, code?: string }>} */
    async pollOnce() {
      const r = await fetchImpl(
        `https://long.open.weixin.qq.com/connect/l/qrconnect?uuid=${uuid}&_=${Date.now()}`,
        {
          headers: { "User-Agent": UA, Referer: authUrl },
          signal: AbortSignal.timeout(25_000),
        },
      )
      const { errcode, code } = parseWxPoll(await r.text())
      if (code) return { status: "done", code }
      if (errcode === 404) return { status: "scanned" }
      if (errcode === 402 || errcode === 403) return { status: "expired" }
      // 405 等待、408 本轮到期、其余未知码 —— 都当作「继续等」
      return { status: "waiting" }
    },
  }
}

/**
 * QQ 通道：xlogin → ptqrshow(qrsig) → ptqrlogin 长轮询 → jumpUrl → 302 链里取 code。
 *
 * @param {{ authUrl: string, fetchImpl: typeof fetch }} o
 */
async function qqSession({ authUrl, fetchImpl }) {
  const jar = createJar()
  const appid = "716027609" // QQ 互联网页登录用的固定 appid
  const daid = "383"
  const xlogin =
    "https://xui.ptlogin2.qq.com/cgi-bin/xlogin" +
    `?appid=${appid}&daid=${daid}&style=33&login_text=${encodeURIComponent("登录")}` +
    "&hide_title_bar=1&hide_border=1&target=self" +
    `&s_url=${encodeURIComponent(authUrl)}&pt_3rd_aid=1903794758` +
    `&pt_feedback_link=${encodeURIComponent("https://support.qq.com/")}`

  let r = await fetchImpl(xlogin, { headers: { "User-Agent": UA, Referer: "https://graph.qq.com/" } })
  jar.save(r)
  await r.arrayBuffer() // 排空，别让连接挂着

  const show =
    "https://ssl.ptlogin2.qq.com/ptqrshow" +
    `?appid=${appid}&e=2&l=M&s=3&d=72&v=4&t=${Math.random()}&daid=${daid}&pt_3rd_aid=1903794758`
  r = await fetchImpl(show, {
    headers: { "User-Agent": UA, Referer: xlogin, Cookie: jar.header() },
  })
  jar.save(r)
  const image = Buffer.from(await r.arrayBuffer())
  const contentType = r.headers.get("content-type") ?? "image/png"
  const qrsig = jar.get("qrsig")
  if (!qrsig) {
    throw new Error("没能从 QQ 二维码接口拿到 qrsig（页面结构可能变了）。请改用微信登录。")
  }

  /**
   * 顺着 jumpUrl 的 302 链走，直到某一跳的 Location 里带 `code=`。
   * @param {string} jumpUrl
   * @returns {Promise<string>} 回调地址（含 code），取不到返回空串
   */
  async function followToCode(jumpUrl) {
    let url = jumpUrl
    for (let i = 0; i < 8; i += 1) {
      const res = await fetchImpl(url, {
        redirect: "manual",
        headers: { "User-Agent": UA, Referer: "https://graph.qq.com/", Cookie: jar.header() },
      })
      jar.save(res)
      const loc = res.headers.get("location") ?? ""
      if (!loc) {
        // 走到 graph.qq.com/oauth2.0/show 这一页：二维码已经登录成功，但还要
        // 「确认授权」——那一步是页面里的 JS 干的，我们照着 qlogin_v2.js 自己 POST。
        const html = await res.text()
        return confirmAuthorize(html, url)
      }
      const next = new URL(loc, url).toString()
      if (/[?&]code=/.test(next)) return next
      url = next
    }
    return ""
  }

  /**
   * 复刻 qlogin_v2.js 里 formSend() 的那一发 POST：
   * `POST https://graph.qq.com/oauth2.0/authorize`，带 openapi=授权项、g_tk=hash(p_skey)…
   * 不这么做就永远停在「请确认授权」，用户那边看到的是插件一直转圈。
   * @param {string} html 授权页 HTML
   * @param {string} pageUrl 授权页地址（参数从它的 query 里取）
   * @returns {Promise<string>} 带 code 的回调地址，取不到返回空串
   */
  async function confirmAuthorize(html, pageUrl) {
    let q = new URLSearchParams()
    try {
      q = new URL(pageUrl).searchParams
    } catch {}
    // 授权项：页面里勾上的那几个 checkbox（Marvis 只有一个 1010：头像昵称）
    const openapi =
      [...String(html).matchAll(/name="api_choose"[^>]*value="(\d+)"/g)].map((m) => m[1]).join("_") ||
      "1010"
    const body = new URLSearchParams({
      response_type: q.get("response_type") ?? "code",
      client_id: q.get("client_id") ?? "",
      redirect_uri: q.get("redirect_uri") ?? "",
      scope: q.get("scope") ?? "",
      state: q.get("state") ?? "",
      switch: q.get("switch") ?? "",
      from_ptlogin: "1",
      src: "1",
      update_auth: "1",
      openapi,
      g_tk: String(gtk(jar.get("p_skey"))),
      auth_time: String(Date.now()),
      ui: randomUUID().toUpperCase(),
    })
    const res = await fetchImpl("https://graph.qq.com/oauth2.0/authorize", {
      method: "POST",
      redirect: "manual",
      headers: {
        "User-Agent": UA,
        Referer: pageUrl,
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
        Cookie: jar.header(),
      },
      body: body.toString(),
    })
    jar.save(res)
    const loc = res.headers.get("location") ?? ""
    if (loc) {
      const next = new URL(loc, "https://graph.qq.com/").toString()
      return /[?&]code=/.test(next) ? next : ""
    }
    // 有的版本是 200 + 一段跳转脚本
    const text = await res.text()
    const m = /https:\/\/[^"'\s]*marvis_oauth[^"'\s]*[?&]code=[A-Za-z0-9_-]+/.exec(text)
    return m ? m[0].replace(/\\\//g, "/") : ""
  }

  return {
    image,
    contentType,
    /** @returns {Promise<{ status: string, url?: string }>} */
    async pollOnce() {
      const poll =
        "https://ssl.ptlogin2.qq.com/ptqrlogin" +
        `?u1=${encodeURIComponent(authUrl)}&ptqrtoken=${hash33(qrsig)}&ptredirect=0` +
        `&h=1&t=1&g=1&from_ui=1&ptlang=2052&action=0-0-${Date.now()}` +
        "&js_ver=20102616&js_type=1" +
        `&login_sig=${encodeURIComponent(jar.get("pt_login_sig"))}&pt_uistyle=40` +
        `&aid=${appid}&daid=${daid}&pt_3rd_aid=1903794758&`
      const res = await fetchImpl(poll, {
        headers: { "User-Agent": UA, Referer: xlogin, Cookie: jar.header() },
        signal: AbortSignal.timeout(25_000),
      })
      jar.save(res)
      const cb = parsePtuiCB(await res.text())
      if (cb.code === "0") {
        const url = await followToCode(cb.jumpUrl)
        // 扫码成功但拿不到 code：说明授权页要人工确认（协议变了），别假装成功
        return url ? { status: "done", url } : { status: "scanned" }
      }
      // 上游的码（实测抓的）：
      //   66 二维码未失效 = 还没扫
      //   67 二维码认证中 = 已扫，手机那头正在点确认 —— **必须继续轮询同一张二维码**
      //   65 二维码已失效 = 过期，该换一张
      //   0  登录成功，第三个参数是 jumpUrl
      // 67 曾经被当成「过期」直接换二维码：手机确认的是旧的那张，新的一张永远没人扫，
      // 于是就卡在「请在浏览器中完成登录」—— 用户实测踩到过。
      if (cb.code === "67") return { status: "scanned" }
      if (cb.code === "65") return { status: "expired" }
      return { status: "waiting" }
    },
  }
}

/**
 * 二维码页面。故意不用任何外部资源（图片由本服务自己给），
 * 因为 NAS 上的浏览器可能根本连不出去。
 *
 * @param {{ title: string, tip: string, token: string }} o
 */
function pageHtml({ title, tip, token }) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  :root{color-scheme:light dark}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       font:15px/1.6 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
       background:#f5f6f8;color:#1b1d21}
  @media (prefers-color-scheme:dark){body{background:#16181c;color:#e6e8eb}}
  .card{background:#fff;border-radius:16px;padding:28px 32px;max-width:420px;width:calc(100% - 32px);
        box-shadow:0 8px 32px rgba(0,0,0,.08);text-align:center}
  @media (prefers-color-scheme:dark){.card{background:#1e2126;box-shadow:none}}
  h1{font-size:18px;margin:0 0 4px}
  .tip{color:#6b7280;font-size:13px;margin:0 0 18px}
  img{width:220px;height:220px;image-rendering:pixelated;border-radius:12px;background:#fff}
  .state{margin:16px 0 0;font-size:14px;min-height:22px}
  .ok{color:#0a7d33;font-weight:600}
  .bad{color:#b42318}
  .foot{color:#9aa1ab;font-size:12px;margin:18px 0 0}
  .bar{height:3px;border-radius:2px;background:#e5e7eb;overflow:hidden;margin-top:16px;display:none}
  .bar.on{display:block}
  .bar i{display:block;height:100%;width:40%;background:#0a7d33;animation:run 1.1s linear infinite}
  @keyframes run{from{transform:translateX(-100%)}to{transform:translateX(260%)}}
</style></head>
<body><div class="card">
  <h1>${title}</h1>
  <p class="tip">${tip}</p>
  <img id="qr" src="qr.png" alt="二维码">
  <p class="state" id="state">正在生成二维码…</p>
  <div class="bar" id="bar"><i></i></div>
  <p class="foot">这个页面由 magpie 插件在本机临时开启，登录完成后会自动关闭。</p>
</div>
<script>
  var ver = -1, done = false, token = ${JSON.stringify(token)}
  function setState(text, cls) {
    var el = document.getElementById('state')
    el.textContent = text
    el.className = 'state' + (cls ? ' ' + cls : '')
  }
  function tick() {
    fetch('status?t=' + encodeURIComponent(token) + '&_=' + Date.now(), {cache: 'no-store'})
      .then(function (r) { return r.json() })
      .then(function (j) {
        if (j.qr !== ver) {
          ver = j.qr
          document.getElementById('qr').src = 'qr.png?v=' + ver
        }
        document.getElementById('bar').className = 'bar' + (j.status === 'scanned' ? ' on' : '')
        if (j.status === 'done') { done = true; setState('登录成功，可以回到 magpie 了', 'ok'); return }
        if (j.status === 'cancelled') { setState('已在手机上取消，请重新扫码', 'bad') }
        else if (j.status === 'expired') { setState('二维码已过期，正在换一张…', 'bad') }
        else if (j.status === 'scanned') { setState('已扫码，请在手机上确认登录', 'ok') }
        else if (j.status === 'waiting') { setState('请用手机扫码', '') }
        else if (j.message) { setState(j.message, 'bad') }
      })
      .catch(function () {})
      .then(function () { if (!done) setTimeout(tick, 1200) })
  }
  tick()
</script>
</body></html>`
}

/**
 * 上一次没关干净的扫码页的 close 函数。
 *
 * 扫码页是**单例资源**（固定端口 + 一个临时 HTTP 服务），不是按账号的状态，
 * 所以放在模块级是安全的：同一时刻只该有一个扫码页在跑，新的登录直接顶掉旧的。
 * 用户取消登录时宿主不一定会通知插件（magpie 只 abort callback 的 signal），
 * 靠「下一次登录先关掉上一次」兜底，才不会被 5 分钟超时卡住端口。
 */
let activeClose = null

/**
 * 起一个「局域网扫码登录」。
 *
 * 返回得很早：只等服务**开始 listen**，二维码在后台申请（页面先显示「正在生成…」）。
 * 这一点很重要 —— `authorize()` 里不能等网络，更不能等用户（HOOKS §四·陷阱 1）。
 *
 * @param {{
 *   loginType: "QC" | "WX",
 *   authUrl: string,
 *   guid: string,
 *   timeoutMs?: number,
 *   host?: string,
 *   fetchImpl?: typeof fetch,
 *   ifaces?: () => Record<string, any>,
 * }} o
 * @returns {Promise<{
 *   url: string,
 *   port: number,
 *   address: string,
 *   waitForCode: (o?: { signal?: AbortSignal }) => Promise<string>,
 *   close: () => void,
 * }>}
 */
export async function startRelayLogin(o) {
  const loginType = o.loginType === "WX" ? "WX" : "QC"
  const fetchImpl = o.fetchImpl ?? fetch
  const timeoutMs = o.timeoutMs ?? RELAY_TIMEOUT_MS
  const token = randomBytes(8).toString("hex")
  const base = `/s/${token}/`
  /** @type {Set<any>} */
  const sockets = new Set()

  /** @type {{ status: string, message: string, qr: number, code: string }} */
  const st = { status: "waiting", message: "", qr: 0, code: "", reach: "" }
  let image = Buffer.alloc(0)
  let imageType = "image/png"
  let closed = false
  const ac = new AbortController()

  /** @type {(v: string) => void} */
  let resolveCode = () => {}
  /** @type {(e: Error) => void} */
  let rejectCode = () => {}
  const done = new Promise((res, rej) => {
    resolveCode = res
    rejectCode = rej
  })
  done.catch(() => {}) // 没人 await 时别变成 unhandledRejection

  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://relay").pathname
    const send = (code, type, body) => {
      res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" })
      res.end(body)
    }
    if (path === base || path === `${base}index.html`) {
      return send(
        200,
        "text/html; charset=utf-8",
        pageHtml({
          title: loginType === "WX" ? "微信扫码登录" : "QQ 扫码登录",
          tip: loginType === "WX" ? "打开微信 → 扫一扫" : "打开手机 QQ → 扫一扫",
          token,
        }),
      )
    }
    if (path === `${base}qr.png`) {
      if (!image.length) return send(503, "text/plain; charset=utf-8", "二维码还没生成好")
      res.writeHead(200, { "Content-Type": imageType, "Cache-Control": "no-store" })
      return res.end(image)
    }
    if (path === `${base}status`) {
      return send(
        200,
        "application/json; charset=utf-8",
        JSON.stringify({ status: st.status, message: st.message, qr: st.qr, reach: st.reach }),
      )
    }
    // 其余路径（含 `/`）一律不认：这个服务只服务上面三个路径
    send(404, "text/plain; charset=utf-8", "404")
  })

  // 端口默认随机。跑在容器里时随机端口外面映射不进来，所以允许用
  // MAGPIE_MARVIS_RELAY_PORT 固定一个端口，再在容器上映射它。
  const wantPort = Number(o.port ?? process.env.MAGPIE_MARVIS_RELAY_PORT ?? 0)
  const listenPort = Number.isInteger(wantPort) && wantPort > 0 && wantPort < 65_536 ? wantPort : 0
  const bindHost = o.host ?? "0.0.0.0"

  // 先关掉上一次（用户取消后宿主通常不会通知插件，这里兜底），再绑端口。
  // 上一次的连接是 keep-alive 的，光 close 端口还占着，所以等一下再绑。
  if (activeClose) {
    try {
      activeClose()
    } catch {
      /* 已经不在了 */
    }
    activeClose = null
    await new Promise((r) => setTimeout(r, 80))
  }

  /** 绑一次端口；失败时 reject 原始错误（交给外面判断是不是 EADDRINUSE） */
  function bindOnce() {
    return new Promise((res, rej) => {
      const onError = (err) => {
        server.removeListener("listening", onListening)
        rej(err)
      }
      const onListening = () => {
        server.removeListener("error", onError)
        res(null)
      }
      server.once("error", onError)
      server.once("listening", onListening)
      server.listen(listenPort, bindHost)
    })
  }

  for (let attempt = 0; ; attempt++) {
    try {
      await bindOnce()
      break
    } catch (err) {
      const code = /** @type {any} */ (err)?.code
      // 端口被占：多半是上一次的扫码页还没收干净（keep-alive 连接）。重试几次。
      if (code === "EADDRINUSE" && attempt < 4) {
        if (activeClose) {
          try {
            activeClose()
          } catch {
            /* ignore */
          }
          activeClose = null
        }
        await new Promise((r) => setTimeout(r, 250))
        continue
      }
      throw new Error(
        code === "EADDRINUSE"
          ? `扫码页的端口 ${listenPort} 被占用了（上一次的扫码页还没关干净，或者别的程序占着它）。` +
              "等两三秒再点一次登录；如果一直这样，把 MAGPIE_MARVIS_RELAY_PORT 换成一个空闲端口，" +
              "并同步改容器映射和 MAGPIE_MARVIS_RELAY_URL。"
          : `扫码页起不来：${/** @type {any} */ (err)?.message ?? err}`,
      )
    }
  }
  server.on("connection", (socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
  })
  server.unref?.()
  activeClose = close
  const port = /** @type {any} */ (server.address()).port
  const address = lanAddresses(o.ifaces)[0]?.address ?? "127.0.0.1"
  // 容器里探测到的地址（172.17.x / 容器内网卡）局域网是访问不到的，
  // 所以允许用 MAGPIE_MARVIS_RELAY_URL 直接指定「外面该打开哪个地址」。
  const external = String(o.publicUrl ?? process.env.MAGPIE_MARVIS_RELAY_URL ?? "")
    .trim()
    .replace(/\/+$/, "")
  const url = external ? `${external}${base}` : `http://${address}:${port}${base}`

  // 自查一次「对外地址」：容器里最常见的事故是端口映射写成了 magpie 自己的端口，
  // 用户打开看到的是 magpie 的 404 / 401，而插件这边毫无线索。这里主动访问一次，
  // 把结果写进日志（docker logs 能看见），页面 /status 里也带上。
  if (!o.fetchImpl) {
    void (async () => {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(3000) })
        if (r.status === 200) {
          st.reach = "ok"
          return
        }
        st.reach = `http-${r.status}`
        console.error(
          `[magpie-marvis] 扫码页的对外地址返回 ${r.status}：${url}\n` +
            "  多半是端口映射没对上（映射到的不是插件的监听端口），或 MAGPIE_MARVIS_RELAY_URL 填成了 magpie 自己的端口。",
        )
      } catch (err) {
        st.reach = "unreachable"
        console.error(
          `[magpie-marvis] 扫码页的对外地址连不上：${url}（${/** @type {any} */ (err)?.message ?? err}）\n` +
            "  检查容器是否把 MAGPIE_MARVIS_RELAY_PORT 映射到了宿主机，以及 MAGPIE_MARVIS_RELAY_URL 的端口是否就是这个映射端口。",
        )
      }
    })()
  }

  const timer = setTimeout(() => {
    st.status = "timeout"
    st.message = "扫码超时"
    rejectCode(new Error(`扫码登录超时（${Math.round(timeoutMs / 60_000)} 分钟没扫）。请重新点一次登录。`))
    close()
  }, timeoutMs)

  /** 重新申请一张二维码（过期时） */
  async function makeSession() {
    return loginType === "WX"
      ? wechatSession({ authUrl: o.authUrl, fetchImpl })
      : qqSession({ authUrl: o.authUrl, fetchImpl })
  }

  /**
   * 关掉扫码页。
   *
   * ⚠ 只 `server.close()` 是不够的：它只停止接受**新**连接，已经建立的
   * keep-alive 连接（用户浏览器每 1.2 秒轮询一次 /status）会一直挂着，
   * 端口就还占着 —— 表现就是「取消之后再点登录 → 端口 18080 被占用」。
   * 所以这里必须把已建立的 socket 全部 destroy 掉。
   */
  function close(reason = "") {
    if (closed) return
    closed = true
    clearTimeout(timer)
    ac.abort()
    if (reason && st.status !== "done" && st.status !== "timeout") st.status = reason
    if (activeClose === close) activeClose = null
    for (const socket of sockets) {
      try {
        socket.destroy()
      } catch {
        /* 已经断了 */
      }
    }
    sockets.clear()
    try {
      server.closeAllConnections?.()
    } catch {
      /* 老运行时没有这个 API */
    }
    try {
      server.close()
    } catch {
      /* 已经关了 */
    }
  }

  // 后台：申请二维码 → 一直轮询到出 code
  void (async () => {
    try {
      let session = await makeSession()
      image = session.image
      imageType = session.contentType || imageType
      st.qr += 1

      while (!closed) {
        const t0 = Date.now()
        const r = await session.pollOnce()
        if (closed) return
        if (r.status === "done") {
          st.status = "done"
          const got = "code" in r && r.code ? r.code : "url" in r && r.url ? r.url : ""
          st.code = got
          resolveCode(got)
          // 留 3 秒让页面把「成功」画出来，再收摊
          setTimeout(close, 3000).unref?.()
          return
        }
        if (r.status === "expired") {
          st.status = "expired"
          session = await makeSession()
          image = session.image
          imageType = session.contentType || imageType
          st.qr += 1
          st.status = "waiting"
          continue
        }
        st.status = r.status
        // ⚠ 上游正常会挂住 15~25 秒（长轮询）。万一它秒回（405 / 网络抖动），
        //   这里补一个下限间隔，否则会变成每秒几十次的热循环把二维码刷成风控。
        const spent = Date.now() - t0
        // ⚠ 这个 setTimeout 不能 unref：宿主进程里如果此刻没有别的活，
        //   事件循环会直接空掉，Node 退出，扫码页就那么一直"等着"（实测过）。
        if (spent < 800) await new Promise((res) => setTimeout(res, 800 - spent))
      }
    } catch (err) {
      if (closed) return
      st.status = "error"
      st.message = String(/** @type {any} */ (err)?.message ?? err)
      rejectCode(/** @type {any} */ (err))
      close()
    }
  })()

  return {
    url,
    port,
    address,
    /**
     * 等用户扫完。返回**回调地址**（含 code）或**裸 code**，交给 `parseCallback()` 都认。
     * @param {{ signal?: AbortSignal }} [oo]
     */
    async waitForCode(oo = {}) {
      const sig = oo.signal
      if (sig?.aborted) {
        close()
        throw new Error("登录已取消。")
      }
      const onAbort = () => {
        close()
        rejectCode(new Error("登录已取消。"))
      }
      sig?.addEventListener("abort", onAbort, { once: true })
      try {
        return await done
      } finally {
        sig?.removeEventListener("abort", onAbort)
      }
    },
    close,
  }
}
