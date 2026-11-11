// ② auth.methods —— 三条登录路
//
//   A. QQ / 微信 授权：自己起一个**隔离浏览器**（一次性 profile、伪装客户端 UA、
//      抹掉 navigator.webdriver），用户在窗口里授权，插件在 CDP 的**请求阶段**拦下回调，
//      再带本机 guid 把 code 换一次。
//      → `{ url, opened: true, method: "auto", callback }`
//        `opened: true` 让 magpie **不要**再开系统默认浏览器（否则弹两个窗口）。
//
//   B. 从本机 Marvis 导入：装了客户端且登录过的人，直接读进程内存里的登录态。
//      → 同样 `opened: true` + `method: "auto"`，整个登录就是「点一下 → 读内存 → 成功」。
//
//   C. 局域网扫码（`src/marvis/relay.mjs`）：本机**没有**浏览器时（NAS / Docker /
//      纯命令行 / 远程访问）用。插件在本机起一个临时 HTTP 页面，用户用**自己的**浏览器
//      打开它、手机扫码；二维码的 uuid/qrsig 由插件在服务端申请并长轮询，
//      **浏览器全程不碰回调地址**，所以 code 不会被消费。
//      → `{ url: <局域网页面>, opened: false, method: "auto", callback }`
//        `opened: false` 是故意的：要让 magpie 把这个地址交给**用户那台**机器打开。
//      A 与 C 用同一套 `authOf()` / `withProfile()`，只有「怎么拿到回调」不同。
//      没有浏览器时 A 会自动改走 C（用户点同一个按钮，不报「请装浏览器」）。
//
// ⚠ `authorize()` 必须**立刻**返回 —— 真正等用户的是 `callback()`。
//   在这里 await 登录会和 magpie 双向死锁（HOOKS §四·陷阱1）。
//   `findBrowser()` 要查十几次注册表（实测 1.4 秒），必须放在 callback 里。
//
// ⚠⚠ `-109 RC_PARAMS_INVALID` 的根因（已修）：`marvis_oauth` 是**参数检查**失败，
//   最常见的是**缺设备 guid**。实测：缺 guid → 恒定 -109；带 `Ual-Access-Guid`
//   （或 `.qq.com` 的 `guid` cookie）后，假 code / 已消费 code 变成 `-107 RC_NO_AUTH_ERR`。
//   官方成功路径是「回调 → 302 + Set-Cookie 写入登录态」，不是 JSON 响应体。
//
//   所以现在：`browser.mjs` 用 CDP `Fetch.requestPaused` 在 **Request 阶段**拦下回调
//   （请求不出网，code 保持未使用），再 `Fetch.fulfillRequest` 一张静态完成页，
//   把回调地址交回来；这里只调 `parseCallback(callbackUrl, body, { loginType, guid })`，
//   由 Node 带 guid 换**唯一那一次**。`body` 恒为空 —— 没有「回调页正文」这回事。

import { PROVIDER, LOGIN_TYPE } from "../context.mjs"
import { authorizeUrl, parseCallback, deviceGuid } from "../marvis/login.mjs"
import { createDeviceRegistry, newDeviceGuid, stateOfUrl } from "../marvis/device.mjs"
import { openIsolatedLogin, findBrowser } from "../marvis/browser.mjs"
import { startRelayLogin } from "../marvis/relay.mjs"
import { resolveAccount } from "../account-name.mjs"
import { importFromDesktop, desktopAvailable } from "../marvis/desktop.mjs"
import { fetchUserProfile, accountLabel } from "../marvis/profile.mjs"

/**
 * 登录过程中的 state → 虚拟设备 guid。
 *
 * ⚠ 不能用一个模块级 `currentGuid`：宿主在同一进程里同时服务多个账号，
 *   两个登录窗口并行时就会串号。按 OAuth state 分开存，天然隔离。
 */
const pendingDevices = createDeviceRegistry()

/** 回调地址判据：跳到 marvis_oauth 且带 code= */
const CALLBACK = /marvis_client_login\/marvis_oauth\?[^#]*\bcode=/i

/**
 * CDP `Fetch.enable` 的拦截模式（`*` = 任意长度）。
 * ⚠ 故意放松到「路径里含 marvis_oauth」：判据漏一个只会让 code 被浏览器消费（之后换成 `-107`），
 *   而授权页自己的地址里虽然也带这个字样，路径却是百分号编码的 —— 由 `isCallbackUrl` 再筛一次。
 */
const CALLBACK_PATTERN = "*marvis_oauth*"

/** `-109` 的可执行提示：参数检查没通过，最常见是缺 guid */
const PARAM_HINT =
  "  [提示] 服务端参数检查未通过（最常见是缺设备 guid）。这不是 code 过期，" +
  "请把这条提示反馈给插件作者；也可以改用「从本机 Marvis 导入」——装了客户端并在里面登录过就能一键导入。"

/** 拦截没生效（浏览器自己把回调请求发了出去）时的追加提示 */
const NOT_INTERCEPTED_HINT =
  "（本次未能在请求发出前拦下回调，code 很可能已被浏览器消费 —— 换个 Chromium 内核浏览器再试）"

/**
 * 登录成功时给宿主的字段。
 * `accountId` 是**名字**（卡片上显示），`uid` 是身份（HOOKS §八）。
 * ⚠ `refresh` 必须有 —— 缺了它 magpie 不会把账号写进 plugin-auth.json，
 *   表现是「登录显示成功，但界面说无法列出账号」。
 */
export function authOf(acct) {  const { accountId, uid } = resolveAccount({
    name: acct.nickname ?? "",
    phone: "",
    urn: acct.openid,
  })
  // 卡片名带登录方式：QQ·昵称 / 微信·昵称
  const label = accountLabel(acct.nickname, acct.loginType) || accountId
  return {
    type: "success",
    access: acct.accessToken,
    // token 30 天有效，refresh 会成对轮换 —— 这里存自己，refresh 钩子负责换新
    refresh: acct.refreshToken ?? acct.accessToken,
    expires: acct.expiresAt ?? 0,
    ...(label ? { accountId: label } : {}),
    ...(uid ? { uid } : {}),
    // 落盘的额外字段：模型请求随时要用
    metadata: {
      openid: acct.openid,
      guid: acct.guid ?? deviceGuid(),
      loginType: acct.loginType ?? "1",
      nickname: acct.nickname ?? "",
    },
  }
}

/**
 * 补昵称/头像：拿不到就用原值，**绝不阻塞登录**。
 * QQ 号拿不到（Marvis 只给 openid），这里只取 `nick_name`。
 *
 * @param {any} acct
 * @param {"QC" | "WX"} loginType
 */
async function withProfile(acct, loginType) {
  try {
    const profile = await fetchUserProfile(acct, { loginType })
    if (!profile) return acct
    return {
      ...acct,
      nickname: profile.nickname || acct.nickname,
      avatar: profile.avatar || acct.avatar,
    }
  } catch {
    return acct
  }
}

/**
 * 本机有没有可用的 Chromium 内核浏览器。
 *
 * 这个判断决定「浏览器路」还是「局域网扫码路」：
 *   · Windows / macOS 桌面：有浏览器 → 老路子（起隔离窗口，CDP 拦回调）
 *   · NAS / Docker / 纯命令行：没有 → 走 `relay.mjs`（用户自己的浏览器扫码，服务端拿 code）
 *
 * `findBrowser()` 自己带缓存，第二次调用几乎零成本；异常一律当「没有」。
 *
 * @returns {boolean}
 */
export function localBrowserAvailable() {
  try {
    return findBrowser() !== null
  } catch {
    return false
  }
}

/**
 * 局域网扫码登录的 `authorize` 载荷。
 *
 * 和浏览器路共用 `withProfile()` / `authOf()`，只有「怎么拿到回调」这一段不同：
 * 这里等的是 `relay.waitForCode()`（服务端长轮询拿到的 code），
 * 而不是 CDP 在请求阶段拦下来的地址。
 *
 * @param {"QC" | "WX"} loginType
 * @param {string} guid
 * @param {string} authUrl 授权页地址（`authorizeUrl()` 的产物）
 * @param {string} [hint] 追加到说明末尾的一句话（例如「你是远程访问，所以走这条路」）
 */
async function relayAuthorize(loginType, guid, authUrl, hint) {
  // ⚠ 只等 listen，不等网络：二维码在后台申请，页面先显示「正在生成…」
  const relay = await startRelayLogin({ loginType, authUrl, guid })

  const instructions =
    "1) 在浏览器打开下面这个地址（和 magpie 在同一局域网即可，手机、电脑都行）\n" +
    `   ${relay.url}\n` +
    `2) 用${loginType === "WX" ? "微信" : "手机 QQ"}扫码，并在手机上确认登录\n` +
    "3) 页面显示「登录成功」后回到 magpie 即可\n" +
    (hint ? `\n${hint}\n` : "") +
    "\n⚠ 上面这个端口是**扫码页**的端口，不是 magpie 自己的端口。打不开 / 看到 404、401、" +
    "或者一个要你登录的页面，都说明端口对不上：\n" +
    "   · 容器要额外映射一个端口，比如 18080:18080（magpie 的 3430 不要拿来用）\n" +
    "   · 环境变量 MAGPIE_MARVIS_RELAY_PORT=18080（插件在里面监听的端口）\n" +
    "   · 环境变量 MAGPIE_MARVIS_RELAY_URL=http://<宿主机 IP>:18080（外面实际打开的那个）\n" +
    "改完要**重建**容器才生效（docker compose up -d --force-recreate）。\n" +
    "验证：在局域网任意一台机器上 curl -I 那个地址，应当是 200 且 Content-Type 是 text/html。\n" +
    "Windows 且装了 Marvis 客户端的，也可以改用「从本机 Marvis 导入」。"

  return {
    // 给用户那台机器打开的地址（不是授权页）：opened:false 让 magpie 去开它
    url: relay.url,
    opened: false,
    method: "auto",
    instructions,
    // 用户放弃 / 宿主提前收摊时能立刻关掉端口（magpie 不会调它，测试与诊断会）
    close: () => relay.close("cancelled"),
    async callback(_url, _input, signal) {
      // 用户在 magpie 里点「取消」= 宿主 abort 这个 signal。
      // 不在这里收摊的话，端口会一直占着，下一次点登录就是「端口 18080 被占用」。
      signal?.addEventListener?.("abort", () => relay.close("cancelled"), { once: true })
      try {
        const got = await relay.waitForCode({ signal })
        // got 可能是完整回调地址（QQ），也可能是裸 code（微信）
        let acct = await parseCallback(got, "", { loginType, guid })
        acct = await withProfile({ ...acct, guid }, loginType)
        return authOf({ ...acct, guid, loginType: acct.loginType ?? LOGIN_TYPE[loginType] ?? "1" })
      } catch (err) {
        const msg = String(/** @type {any} */ (err)?.message ?? err)
        const paramHint = /-109|RC_PARAMS_INVALID/.test(msg) ? PARAM_HINT : ""
        throw new Error(msg + paramHint)
      } finally {
        relay.close()
      }
    },
  }
}

/** 显式的「局域网扫码」登录方式（不依赖本机有没有浏览器） */
function relayLogin(loginType, label, hint) {
  return {
    type: "oauth",
    label,
    async authorize() {
      const guid = newDeviceGuid()
      const url = authorizeUrl(loginType, guid)
      pendingDevices.remember(stateOfUrl(url) || guid, guid)
      return relayAuthorize(loginType, guid, url, hint)
    },
  }
}

/** 授权页登录（QQ / 微信），走隔离浏览器 */
function oauthLogin(loginType, label, instructions) {  return {
    type: "oauth",
    label,
    async authorize() {
      // ⚠ 每个账号一个独立 guid，而不是共用本机 svid —— 否则新号登录会把旧号顶掉
      const guid = newDeviceGuid()
      const url = authorizeUrl(loginType, guid)
      // 用 QQ/微信 回传的 state 关联这次登录与 guid（WX 的 state 本身就是 guid）
      const state = stateOfUrl(url) || guid
      pendingDevices.remember(state, guid)

      // 本机没有浏览器（NAS / Docker / 纯命令行）→ 自动改走局域网扫码，
      // 别让用户卡在「请装一个 Chromium」上（issue #4）。这里**不抛错**：
      // 用户点的是同一个「QQ 登录」，只是后面等他的是手机扫码而不是桌面窗口。
      if (!localBrowserAvailable()) return relayAuthorize(loginType, guid, url)

      return {
        url,
        // 我们自己开隔离浏览器，magpie 不要再开系统默认浏览器
        opened: true,
        method: "auto",
        instructions,
        async callback(_url, _input, signal) {
          const browser = findBrowser()
          if (!browser) {
            // 正常不会走到这里：`authorize()` 已经用 `localBrowserAvailable()` 分流过。
            // 真走到说明浏览器在两次调用之间消失了（或首次判断被缓存成有），给一条能自救的话。
            throw new Error(
              "这台机器上没有可用的 Chromium 内核浏览器（Chrome / Edge / 360 / QQ 浏览器都行）。" +
                "如果你是从**另一台设备**访问 magpie 的，请改用「微信扫码登录（手机扫，NAS / 远程推荐）」" +
                "或「QQ 扫码登录（手机扫，NAS / 远程推荐）」—— 那两条只要手机能扫码就行；" +
                "Windows 且装了 Marvis 客户端的话，也可以用「从本机 Marvis 导入」。",
            )
          }

          // 起隔离浏览器 → 在**请求阶段**拦下回调（请求不出网，code 不会被消费）
          const { url: callbackUrl, body, intercepted } = await openIsolatedLogin({
            browser,
            url,
            match: CALLBACK,
            pattern: CALLBACK_PATTERN,
            timeoutMs: 5 * 60_000,
            signal,
          })

          // 取回这次登录专属的虚拟设备 guid
          const callbackState = stateOfUrl(callbackUrl)
          const virtualGuid = pendingDevices.take(callbackState) || (loginType === "WX" ? callbackState : "")
          if (!virtualGuid) {
            throw new Error(
              "登录流程已失效（找不到这次登录的设备标识）。请重新点一次登录，" +
                "或改用「从本机 Marvis 导入」。",
            )
          }

          /** @type {any} */
          let acct
          try {
            // ⚠ guid 必须是**这次登录生成的那个**：token 会绑定到它
            acct = await parseCallback(callbackUrl, body, { loginType, guid: virtualGuid })
            acct = await withProfile({ ...acct, guid: virtualGuid }, loginType)
          } catch (err) {
            const msg = String(err?.message ?? err)
            // -109 = 参数检查没过（不该再出现；出现就是真 bug，别让用户误以为是 code 过期）
            const paramHint = /-109|RC_PARAMS_INVALID/.test(msg) ? PARAM_HINT : ""
            throw new Error(msg + paramHint + (intercepted ? "" : NOT_INTERCEPTED_HINT))
          }
          return authOf({ ...acct, guid: virtualGuid, loginType: acct.loginType ?? LOGIN_TYPE[loginType] ?? "1" })
        },
      }
    },
  }
}

export function methods() {
  return [
    oauthLogin(
      "QC",
      "QQ 登录",
      "1) 会打开一个**独立的**浏览器窗口（不碰你日常浏览器）\n" +
        "2) 用你的 QQ 登录并确认授权\n" +
        "3) 授权完成后窗口会自己关掉，回到 magpie 即可",
    ),
    oauthLogin(
      "WX",
      "微信登录",
      "1) 会打开一个**独立的**浏览器窗口（不碰你日常浏览器）\n" +
        "2) 用微信扫码并确认\n" +
        "3) 授权完成后窗口会自己关掉，回到 magpie 即可",
    ),
    // 显式两条「局域网扫码」：本机没浏览器时会自动走到它们，但**远程访问**（magpie 跑在
    // 另一台机器上、你从笔记本访问）时自动判断看不出来 —— 桌面窗口开在服务器上，用户看不见。
    // 所以留两个手选入口。
    relayLogin(
      "WX",
      "微信扫码登录（手机扫，NAS / 远程推荐）",
      "你是从另一台设备访问 magpie 的，所以这条路不需要这台机器上有浏览器。",
    ),
    relayLogin(
      "QC",
      "QQ 扫码登录（手机扫，NAS / 远程推荐）",
      "你是从另一台设备访问 magpie 的，所以这条路不需要这台机器上有浏览器。",
    ),
    {
      type: "oauth",
      label: "从本机 Marvis 导入（需已安装并登录）",
      async authorize() {
        const ok = await desktopAvailable()
        return {
          // ⚠ 必须 opened: true + method: "auto"，否则 magpie 会去开这个 url
          //   （之前给 about:blank 弹了一次「没有可打开此链接的应用」）
          url: "",
          opened: true,
          method: "auto",
          instructions: ok
            ? "已检测到本机 Marvis 客户端，正在读取登录态…"
            : "本机没找到运行中的 Marvis 客户端。请先打开 Marvis 并登录，或改用 QQ / 微信 登录。",
          async callback() {
            const acct = await importFromDesktop()
            const loginType = acct.loginType === "2" ? "WX" : "QC"
            return authOf(await withProfile(acct, loginType))
          },
        }
      },
    },
  ]
}

export { PROVIDER, CALLBACK }
