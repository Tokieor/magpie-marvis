// Marvis 登录 —— QQ / 微信 OAuth 授权码换登录态
//
// 上游只给两种登录：QQ（QC）和微信（WX）。都是标准 OAuth2 授权码。
//
// ⚠ `redirect_uri` **改不了** —— 它固定在 Marvis 服务端
//   （`https://yybadaccess.3g.qq.com/marvis_client_login/marvis_oauth?login_type=QC`），
//   是 QQ 互联里预注册过的。所以不能像别的插件那样起本地 loopback 收回调。
//
// 实际流程：插件打开授权页 → 用户在 QQ/微信里确认 → 浏览器跳到那个 redirect_uri。
//   插件用 CDP 在**请求发出前**拦下这次回调，取地址里的 `code` + `state`，
//   再由 Node 带**设备 guid**（`Ual-Access-Guid`）换一次登录态。
//
// ⚠⚠ 已实测的换取契约（别再凭猜测改）：
//   · 缺 `guid` → `-109 RC_PARAMS_INVALID`（参数检查在 code 校验之前）
//   · 带 guid 但 code 假/过期/已消费 → `-107 RC_NO_AUTH_ERR`
//   · 成功 → `302` + `Set-Cookie`（openid/accesstoken/refreshtoken/...），**不是 JSON**
//   所以必须 `redirect: "manual"`，跟随 302 会把登录态丢掉。

import { BASE, QQ_APP_ID, WX_APP_ID, BUSINESS_ID, LOGIN_TYPE } from "../context.mjs"
import { ualSignature } from "./protocol.mjs"
import { expiresAtOf, ttlFor } from "./expiry.mjs"
import { createHash } from "node:crypto"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)

/**
 * redirect_uri 的**基址**（不带查询串）。
 *
 * ⚠⚠ 授权时必须拼上 `?login_type=<QC|WX>`：它决定服务端用哪个 app 的身份换 code。
 *   少了它，请求会因缺必需参数被判 `-109 RC_PARAMS_INVALID`。
 *   但 `-109` 更常见的成因是**缺设备 guid**（见 `exchangeCode`），不是这个。
 *
 *   对照 Marvis 渲染层的 `Bpe(e)`：
 *     `${base}/${n}/marvis_oauth?login_type=${e}`   // e = QC | WX
 */
const REDIRECT = `${BASE}/marvis_client_login/marvis_oauth`

/**
 * 拼授权页地址。
 * @param {"QC" | "WX"} loginType
 * @param {string} guid 设备 guid（微信的 state 就是它）
 * @returns {string}
 */
export function authorizeUrl(loginType, guid) {
  if (loginType === "WX") {
    const p = new URLSearchParams({
      appid: WX_APP_ID,
      // ⚠ 同样必须带 ?login_type=WX
      redirect_uri: `${REDIRECT}?login_type=${loginType}`,
      response_type: "code",
      scope: "snsapi_login",
      state: guid,
    })
    return `https://open.weixin.qq.com/connect/qrconnect?${p}`
  }
  // QQ：which=Login&display=pc 是 Marvis 客户端用的参数，别省
  const p = new URLSearchParams({
    which: "Login",
    display: "pc",
    response_type: "code",
    client_id: QQ_APP_ID,
    // ⚠ 必须带 ?login_type=QC，见 REDIRECT 上方说明
    redirect_uri: `${REDIRECT}?login_type=${loginType}`,
    // ⚠ 必须与 Marvis 渲染层逐字一致：`state=${Math.random()*100}`
    //   是**小数**（如 31.1177412），不是整数。服务端会拿它做校验，格式不符会被判参数无效。
    state: String(Math.random() * 100),
  })
  return `https://graph.qq.com/oauth2.0/authorize?${p}`
}

/**
 * 从用户粘贴的内容里抠出授权码。
 * 支持：纯 code / 完整回调 URL / 整段 JSON 里的 code 字段。
 * @param {string} input
 * @returns {string | null}
 */
export function extractCode(input) {
  const s = String(input ?? "").trim()
  if (!s) return null
  // 完整 URL
  try {
    const u = new URL(s)
    const c = u.searchParams.get("code")
    if (c) return c
  } catch {
    /* 不是 URL，往下走 */
  }
  // JSON
  if (s.startsWith("{")) {
    try {
      const j = JSON.parse(s)
      const c = j?.code ?? j?.user_info?.code ?? j?.data?.code
      // 注意：失败响应的 code 是数字错误码，成功时才是字符串
      if (typeof c === "string" && c.length > 4) return c
    } catch {
      /* 不是 JSON */
    }
  }
  // 只有 code=xxx
  const m = /(?:^|[?&])code=([^&\s]+)/.exec(s)
  if (m) return decodeURIComponent(m[1])
  // 裸 code：Marvis 的 code 是长串字母数字
  if (/^[A-Za-z0-9_-]{8,}$/.test(s)) return s
  return null
}

/**
 * 从 `callback` 收到的参数里挑出「用户粘贴的内容」。
 *
 * ⚠ 宿主对 `method: "code"` 的调用形态是 `callback(粘贴内容)`（社区插件
 *   `opencode-raccoon-auth` 的手动入口即如此，实机在跑）；本插件历史写法是
 *   `callback(url, input)`。两种都认：优先取**能抠出 code** 的那个参数，
 *   都不像时取最后一个非空字符串 —— 让用户拿到「回调地址里没 code」这种可读错误。
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {string}
 */
export function pastedInputOf(a, b) {
  const cands = [a, b].filter((v) => typeof v === "string" && v.trim())
  if (!cands.length) return ""
  for (const c of cands) if (extractCode(c)) return c
  return cands[cands.length - 1]
}

/** 官方客户端 UA —— 服务端按它识别调用方（换成普通 Chrome UA 会被判参数无效） */
const MARVIS_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Marvis/1.60.3300.408 Chrome/152.0.7977.130 Electron/44.7.0 Safari/537.36"

/**
 * `login_type`（QC / WX）→ `Ual-Access-Login-Type` 的取值：QC = 1、WX/WXAPP = 2。
 *
 * ⚠ `context.mjs` 的 `LOGIN_TYPE` 也是 `1`/`2`；渲染层是
 *   `yct={QC:"1",WX:"2",WXAPP:"2"}`。
 *
 * @param {unknown} raw cookie 里的 `logintype`，或 QC / WX，或已是 "1"/"2"
 * @returns {"1" | "2"}
 */
function loginTypeCode(raw) {
  const s = String(raw ?? "")
  if (s === "2") return "2"
  return /^WX/i.test(s) ? "2" : "1"
}

/**
 * 把响应头里的 `Set-Cookie` 拆成 `name -> value`（同名只留**第一个**）。
 *
 * ⚠ 不能 `headers.get("set-cookie")` 再 `split(",")` —— `Expires=Wed, 01 Jan…`
 *   里的那个逗号会把一条 cookie 劈成两半。Node 22+ 的 `getSetCookie()` 是可靠来源；
 *   只在它不存在时才退回「逗号后面紧跟 `name=`」的切口。
 *
 * @param {any} headers `res.headers`
 * @returns {Map<string, string>}
 */
export function parseSetCookies(headers) {
  /** @type {string[]} */
  const lines =
    typeof headers?.getSetCookie === "function"
      ? headers.getSetCookie()
      : String(headers?.get?.("set-cookie") ?? "")
          .split(/,(?=\s*[^;=]+=)/)
          .filter(Boolean)

  const jar = new Map()
  for (const line of lines) {
    const pair = String(line).split(";")[0]
    const i = pair.indexOf("=")
    if (i <= 0) continue
    const name = pair.slice(0, i).trim()
    const value = pair.slice(i + 1).trim()
    if (!name || jar.has(name)) continue
    jar.set(name, value)
  }
  return jar
}

/**
 * 302 的 `Set-Cookie` 集合 → 插件内部账号形状。
 *
 * 官方换取**成功**时回的是 302 + 这一串 cookie（实测），**没有 JSON**：
 *   openid / accesstoken / refreshtoken / logintype / nickname / head_img_url /
 *   access_token_expire_time / appid / scope / is_locked
 *
 * 缺 `openid` 或 `accesstoken` 就不算成功 —— 风控页同样回 302，但塞的是别的 cookie。
 *
 * @param {Map<string, string>} jar parseSetCookies() 的结果
 * @param {{ loginType?: string, guid?: string }} [opts] cookie 里没 `logintype` 时的兜底
 * @returns {ReturnType<typeof normalize> | null}
 */
export function accountFromCookies(jar, opts = {}) {
  const openid = jar.get("openid")
  const accessToken = jar.get("accesstoken") ?? jar.get("access_token")
  if (!openid || !accessToken) return null
  return normalize(
    {
      access_token: accessToken,
      openid,
      refresh_token: jar.get("refreshtoken") || undefined,
      nick_name: jar.get("nickname") || undefined,
      head_img_url: jar.get("head_img_url") || undefined,
      access_token_expire_time: jar.get("access_token_expire_time") || undefined,
      login_type: jar.get("logintype") || opts.loginType || "",
    },
    accessToken,
    openid,
    {
      guid: opts.guid,
      appid: jar.get("appid"),
      scope: jar.get("scope"),
      isLocked: /^(1|true|yes)$/i.test(jar.get("is_locked") ?? ""),
    },
  )
}

/**
 * 换登录态失败时的两个死码 —— **都不是「账号错」**。
 * 写错方向会让用户去重装客户端 / 改密码，白折腾。
 *
 *   `-109 RC_PARAMS_INVALID` **参数检查没通过**。实测：缺 `login_type`、缺 `code`、
 *       缺 `guid`、非 GET、`login_type` 非法，任一命中都是 -109。参数检查发生在
 *       code 校验之前，所以**不能**从 -109 反推 code 是否过期/被用过。
 *
 *   `-107` **参数已通过，认证/会话校验失败**。实测：补上 guid（哪怕值 `abc`）后，
 *       假 code / 已消耗 code 都从 -109 变成 -107。因此它表示 code 无效、过期、
 *       已被消费，或该会话不能完成这次授权；**不是**「账号或密码错误」。
 *
 * @param {unknown} errCode 上游 `code` 字段，或 HTTP 状态码
 * @param {string} msg 上游 `msg`
 * @returns {Error}
 */
function loginError(errCode, msg) {
  const code = Number(errCode)
  const hint =
    code === -109
      ? "（-109 RC_PARAMS_INVALID：请求参数检查未通过 —— 最常见是缺设备 guid（Ual-Access-Guid），也可能是缺 login_type / code、非 GET 或 login_type 非法。参数检查在 code 校验之前，不能据此判断 code 是否过期）"
      : code === -107
        ? "（-107：参数已通过，认证/会话校验失败 —— code 无效、已过期或已被消费，或本次会话不能完成授权。请重新走一遍登录；与账号本身无关）"
        : ""
  return new Error(`登录失败（code=${errCode}）：${msg}${hint}`)
}

/**
 * 用授权码换登录态。
 *
 * 这个端点**不需要登录态**（它就是在发登录态），但**必须带设备 guid**：
 *   · 不带 `Ual-Access-Guid` → `-109 RC_PARAMS_INVALID`（实测）
 *   · 带了但那个 guid 不是这次授权的设备 → `-107`（实测）
 *   · 官方成功 → **302 + Set-Cookie**（不是 JSON）
 * 所以 guid 从 `authorizeUrl()` 那一次开始就必须是同一个，一路带到这里。
 *
 * ⚠⚠ 必须 `redirect: "manual"`：跟着 302 跳过去只会落到「正在完成授权…」的
 *   落地页，登录态（那串 Set-Cookie）就丢了。
 *
 * ⚠ 这里**不要**复用 `businessHeaders()`：`Ual-Access-*` 签名头会让 WAF 直接 400。
 *   `Ual-Access-Guid` 是唯一必须的 `Ual-` 头，且它不是签名，只是设备标识。
 *
 * @param {string} code
 * @param {"QC" | "WX"} loginType
 * @param {string} guid 设备 guid —— 必填，进 `Ual-Access-Guid` 请求头
 * @param {string} [state] 回调带回来的 state（原样回传，服务端会比对）
 * @returns {Promise<{ openid: string, accessToken: string, refreshToken?: string, nickname?: string, avatar?: string, loginType: string, expiresAt: number, guid?: string, appid?: string, scope?: string, isLocked?: boolean }>}
 */
export async function exchangeCode(code, loginType, guid, state) {
  if (!code) {
    throw new Error("换取登录态失败：没有授权码（回调地址里取不到 code=）。请重新走一遍登录。")
  }
  // ⚠ 本地就拦：不带 guid 服务端一定回 -109，白跑一趟还拿到一个看不懂的死码
  if (!guid) {
    throw new Error(
      "换取登录态失败：缺少设备 guid（请求头 Ual-Access-Guid）。" +
        "不带它服务端一律 -109 RC_PARAMS_INVALID —— 先取一个设备 guid 再换。",
    )
  }

  // ⚠ query 里**只能有 login_type / code / state**：多一个参数服务端就 -109
  const params = { login_type: loginType, code }
  if (state) params.state = String(state)
  const query = new URLSearchParams(params).toString()
  const url = `${REDIRECT}?${query}`

  const res = await fetch(url, {
    method: "GET",
    // ⚠⚠ 成功是 302 + Set-Cookie。跟随重定向 = 把登录态扔掉
    redirect: "manual",
    headers: {
      Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
      // 伪装成 Marvis 自己的浏览器 —— 服务端按 UA 区分客户端
      "User-Agent": MARVIS_UA,
      // ⚠ 只有设备标识，不是签名
      "Ual-Access-Guid": String(guid),
    },
    signal: AbortSignal.timeout(30_000),
  })

  // ① 成功形态（官方实测）：302 + Set-Cookie
  const fromCookie = accountFromCookies(parseSetCookies(res.headers), { loginType, guid })
  if (fromCookie) return fromCookie

  // 3xx 却没给登录 cookie：换到的是别的东西（风控页 / 协议变更），把 Location 带出来
  if (res.status >= 300 && res.status < 400) {
    const to = res.headers.get("location") ?? ""
    throw new Error(
      `登录失败：服务端返回 ${res.status}，但没有下发登录 Cookie（Location=${to || "空"}）。` +
        "请重新走一遍登录。",
    )
  }

  // ② 兼容形态：200 + JSON
  const text = await res.text()
  /** @type {any} */
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(
      `登录接口返回的既不是 302 + Cookie 也不是 JSON（HTTP ${res.status}）：${text.slice(0, 200) || "空响应"}`,
    )
  }

  const info = body?.user_info ?? body?.data ?? body ?? null
  const accessToken = info?.access_token ?? info?.accessToken ?? body?.access_token
  const openid = info?.openid ?? info?.openId ?? info?.open_id
  const biz = Number(body?.code ?? 0)

  if (accessToken && openid && (biz === 0 || Number.isNaN(biz))) {
    return normalize(info, accessToken, openid, { guid })
  }

  throw loginError(biz || res.status, body?.msg ?? "未返回 access_token / openid")
}

/**
 * 从回调地址里取 `state`。
 *
 * ⚠ 必须按**字符串**原样保留：QQ 的 state 是 `31.1177412` 这种小数，
 *   转成数字再转回字符串会变形（末尾补零 / 科学计数法），服务端比对就不过。
 *
 * @param {string} callbackUrl
 * @returns {string} 取不到返回空串
 */
export function stateOf(callbackUrl) {
  try {
    return new URL(String(callbackUrl)).searchParams.get("state") ?? ""
  } catch {
    const m = /[?&]state=([^&\s#]+)/.exec(String(callbackUrl ?? ""))
    return m ? m[1] : ""
  }
}

/**
 * 从回调里拿到登录态。
 *
 * **主路径**（推荐，已实测）：回调请求被 CDP 在**跳转前**拦下，我们只拿到 URL，
 * 由自己带上 `login_type` + `state` + `Ual-Access-Guid` 去换登录态。
 *
 * **兜底**：如果 URL 里取不到 code、但页面正文是一段 JSON（旧路径），也认。
 *
 * ⚠ 必须自己拿 code 再换：浏览器的落地响应是官方 302 + Set-Cookie（或失败 JSON），
 *   不是「token JSON」；而插件的拦截路径根本不会让浏览器发出这次请求。
 *
 * ⚠ `guid` 必须带、`state` 尽量原样回传：
 *   · 少了 guid → `-109 RC_PARAMS_INVALID`（实测；参数检查在 code 校验之前）
 *   · 带 guid 但 code 假/过期/已消费 → `-107 RC_NO_AUTH_ERR`（实测）
 *   · `state` 在换取端实测为**可选**，但官方客户端一直带着它，所以我们也原样保留
 *   微信的 `state` 本身就是 guid（`authorizeUrl("WX", guid)` 把 guid 塞进 state），
 *   所以 WX 这条路即使调用方没给 `opts.guid` 也能自己对上。
 *
 * @param {string} callbackUrl 回调地址（含 code，通常带 state）
 * @param {string} [body] 回调页正文（CDP 拦截时为空）
 * @param {{ loginType?: string, guid?: string, state?: string }} [opts]
 */
export async function parseCallback(callbackUrl, body, opts = {}) {
  const loginType = opts.loginType ?? "QC"
  // state：回调 URL 里的优先（那才是服务端认的那个），其次调用方给的
  const state = stateOf(callbackUrl) || opts.state || ""
  // guid：**绝不能再是 undefined**（老代码在这里传的就是 undefined，只会拿到 -109）
  const guid =
    opts.guid || (loginType === "WX" && /^[0-9a-f]{32}$/i.test(state) ? state : "") || deviceGuid()

  const text = String(body ?? "").trim()

  // 主路径：正文就是 JSON。
  // ⚠ 不能只看 `startsWith("{")` —— 浏览器渲染 `application/json` 时会加缩进/包装，
  //   也可能前后带空白。改成「抠第一个 `{` 到最后一个 `}`」再解析。
  const jsonText = (() => {
    const a = text.indexOf("{")
    const b = text.lastIndexOf("}")
    return a >= 0 && b > a ? text.slice(a, b + 1) : ""
  })()
  if (jsonText) {
    /** @type {any} */
    let body0
    try {
      body0 = JSON.parse(jsonText)
    } catch {
      body0 = null
    }
    if (body0) {
      const biz = body0.code
      const info = body0.user_info ?? body0.data ?? body0
      const accessToken = info?.access_token ?? info?.accessToken
      const openid = info?.openid ?? info?.openId ?? info?.open_id
      if (typeof biz === "number" && biz !== 0) {
        throw loginError(biz, body0.msg ?? "未返回用户信息")
      }
      if (accessToken && openid) return normalize(info, accessToken, openid, { guid })
    }
  }

  // 主路径：从 URL 取 code，自己换
  const code = extractCode(callbackUrl)
  if (!code) {
    throw new Error(
      `没能从回调地址里取出授权码（${String(callbackUrl).slice(0, 160) || "空"}）。请重新走一遍登录。`,
    )
  }
  return exchangeCode(code, loginType, guid, state)
}

/**
 * 把上游登录态（302 的 cookie 解析结果 / 200 的 user_info）归一成插件内部形状。
 *
 * @param {any} info
 * @param {string} accessToken
 * @param {string} openid
 * @param {{ guid?: string, appid?: string, scope?: string, isLocked?: boolean }} [extra]
 */
function normalize(info, accessToken, openid, extra = {}) {
  const nickname = info?.nick_name ? safeDecode(info.nick_name) : ""
  return {
    openid: String(openid),
    accessToken: String(accessToken),
    refreshToken: info?.refresh_token ? String(info.refresh_token) : undefined,
    nickname: nickname || undefined,
    // cookie 里的头像地址是百分号编码的，JSON 里的不会 —— safeDecode 对后者是恒等
    avatar: info?.head_img_url ? safeDecode(info.head_img_url) : undefined,
    // ⚠ `Ual-Access-Login-Type` 的真实取值：QC→"1"、WX/WXAPP→"2"
    //   （渲染层 `yct={QC:"1",WX:"2",WXAPP:"2"}`）。不是 6。
    loginType: loginTypeCode(info?.login_type),
    // ⚠ 别再用 `> 1e9` 三目：`expires_in` 是**相对秒数**（微信只有 7200 = 2 小时），
    //   被判成「不是绝对时间戳」后回退 30 天 —— 微信 token 2 小时就过期，插件却以为还有 30 天。
    //   统一走 expiresAtOf（绝对/相对/兜底三分支）。
    expiresAt: expiresAtOf(info, { fallbackMs: ttlFor(loginTypeCode(info?.login_type)) }),
    // 落盘用：guid 必须与换取时那个**同一个**（后续请求要靠它做设备标识）
    ...(extra.guid ? { guid: String(extra.guid) } : {}),
    ...(extra.appid ? { appid: String(extra.appid) } : {}),
    ...(extra.scope ? { scope: String(extra.scope) } : {}),
    ...(extra.isLocked ? { isLocked: true } : {}),
  }
}

function safeDecode(s) {
  try {
    return decodeURIComponent(String(s))
  } catch {
    return String(s)
  }
}

/**
 * 设备 guid。
 *
 * 来源：注册表 `HKCU\SOFTWARE\Tencent\Marvis\Env\svid`。
 * `marvis_oauth` 的换取要求它非空（实测：缺 → -109，有 → 才进入 code 校验）。
 *
 * 没有注册表（没装 Marvis）时，用「本机机器名 + 用户名」派生 ——
 * 同一台机器永远算出同一个，不会每次登录变。
 *
 * @returns {string} 32 位小写 hex
 */
export function deviceGuid() {
  try {
    const { execFileSync } = require("node:child_process")
    // ⚠ 必须 String.raw：JS 里 `\S` `\T` 是**无效转义**，反斜杠会被吃掉，
    //   传给 reg 的路径变成 `HKCUSOFTWARETencentMarvisEnv` -> 「无效参数」。
    const out = execFileSync("reg", ["query", String.raw`HKCU\SOFTWARE\Tencent\Marvis\Env`, "/v", "svid"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 3000,
    })
    const m = /svid\s+REG_SZ\s+([0-9a-fA-F]{32})/.exec(out)
    if (m) return m[1].toLowerCase()
  } catch {
    /* 没装 Marvis 或没有这个键，用派生值 */
  }
  const { hostname, userInfo } = require("node:os")
  const seed = `${hostname()}|${userInfo?.().username ?? ""}|marvis`
  return createHash("md5").update(seed).digest("hex")
}
