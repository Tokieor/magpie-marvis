// 局域网登录中继的测试 —— 全程不碰网络（fetch 全部注入）
//
// 覆盖：
//   · 纯函数：hash33 / parseWxPoll / parsePtuiCB / lanAddresses
//   · 微信通道：qrconnect 页面 → 二维码图 → 长轮询拿 code → 页面能看到「成功」
//   · QQ 通道：xlogin → ptqrshow → ptqrlogin('0') → 顺着 302 取到回调地址
//   · 超时：没人扫码时按 timeoutMs 报错，并且把服务关掉

import assert from "node:assert/strict"
import test from "node:test"
import { createServer } from "node:http"

import {
  hash33,
  lanAddresses,
  parsePtuiCB,
  parseWxPoll,
  startRelayLogin,
} from "../src/marvis/relay.mjs"

/** 造一个够用的 Response 替身（只实现 relay 用到的三个成员） */
function res({ status = 200, body = "", headers = {}, setCookie = [] } = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body))
  return {
    status,
    headers: {
      /** @param {string} k */
      get: (k) => headers[String(k).toLowerCase()] ?? null,
      getSetCookie: () => setCookie,
    },
    async text() {
      return buf.toString("utf8")
    },
    async arrayBuffer() {
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    },
  }
}

/** 本地回环地址（测试里要真的 HTTP 连上去，所以不能用 192.168.x） */
const loopback = () => ({ lo0: [{ family: "IPv4", internal: false, address: "127.0.0.1" }] })

test("hash33 与上游 ptlogin2 的算法一致", () => {
  // 手工算：97 → (97<<5)+97+98 = 3299 → (3299<<5)+3299+99 = 108966
  assert.equal(hash33("abc"), 108966)
  assert.equal(hash33(""), 0)
  assert.equal(hash33("a"), 97)
  // 必须收敛到 31 位（否则 ptqrlogin 回 '66' 永远不成功）
  assert.ok(hash33("x".repeat(200)) <= 0x7fffffff)
})

test("parseWxPoll 认得等待/到期/成功", () => {
  assert.deepEqual(parseWxPoll("window.wx_errcode=405;window.wx_code='';"), {
    errcode: 405,
    code: "",
  })
  assert.deepEqual(parseWxPoll("window.wx_errcode=408;window.wx_code='';"), {
    errcode: 408,
    code: "",
  })
  assert.deepEqual(parseWxPoll("window.wx_errcode=405;window.wx_code='031abcDEF';"), {
    errcode: 405,
    code: "031abcDEF",
  })
  // 完全不认识的内容不能抛，交给调用方当「继续等」
  assert.equal(Number.isNaN(parseWxPoll("<html>").errcode), true)
})

test("parsePtuiCB 认得未扫/成功/取消/失效", () => {
  assert.deepEqual(parsePtuiCB("ptuiCB('66','0','','0','二维码未失效。', '')"), {
    code: "66",
    jumpUrl: "",
    message: "二维码未失效。",
  })
  const ok = parsePtuiCB("ptuiCB('0','0','https://ptlogin2.graph.qq.com/check_sig?x=1','0','登录成功！','')")
  assert.equal(ok.code, "0")
  assert.match(ok.jumpUrl, /check_sig/)
  assert.equal(parsePtuiCB("ptuiCB('65','0','','0','已取消。', '')").code, "65")
  assert.equal(parsePtuiCB("ptuiCB('67','0','','0','二维码已失效。', '')").code, "67")
  assert.equal(parsePtuiCB("garbage").code, "")
})

test("lanAddresses 只给 IPv4、私网优先、跳过回环", () => {
  const got = lanAddresses(() => ({
    docker0: [{ family: "IPv4", internal: false, address: "172.17.0.1" }],
    eth0: [{ family: "IPv4", internal: false, address: "192.168.1.9" }],
    lo: [{ family: "IPv4", internal: true, address: "127.0.0.1" }],
    eth1: [{ family: "IPv6", internal: false, address: "fe80::1" }],
    pub: [{ family: "IPv4", internal: false, address: "203.0.113.7" }],
  }))
  assert.deepEqual(
    got.map((x) => x.address).sort(),
    ["172.17.0.1", "192.168.1.9", "203.0.113.7"],
  )
  // 公网地址必须排在私网后面
  assert.equal(got.at(-1).address, "203.0.113.7")
})

test("微信通道：页面 → 二维码 → 长轮询拿到 code", async () => {
  let polls = 0
  /** @type {string[]} */
  const seen = []
  /** @type {any} */
  const fetchImpl = async (url) => {
    const u = String(url)
    seen.push(u)
    if (u.startsWith("https://open.weixin.qq.com/connect/qrconnect")) {
      return res({
        body: '<script>var fordevtool = "https://long.open.weixin.qq.com/connect/l/qrconnect?uuid=TESTUUID123"</script>',
      })
    }
    if (u.includes("/connect/qrcode/TESTUUID123")) {
      return res({ body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) })
    }
    if (u.includes("/connect/l/qrconnect")) {
      polls += 1
      return res({
        body:
          polls === 1
            ? "window.wx_errcode=405;window.wx_code='';"
            : "window.wx_errcode=405;window.wx_code='031thecode';",
      })
    }
    throw new Error(`没预料到的请求：${u}`)
  }

  const relay = await startRelayLogin({
    loginType: "WX",
    authUrl: "https://open.weixin.qq.com/connect/qrconnect?appid=wxb650708317d56f88",
    guid: "0123456789abcdef0123456789abcdef",
    fetchImpl,
    ifaces: loopback,
    timeoutMs: 10_000,
  })

  try {
    assert.match(relay.url, /^http:\/\/127\.0\.0\.1:\d+\/s\/[0-9a-f]{16}\/$/)

    // 页面本身（用户浏览器打开的那个地址）
    const page = await fetch(relay.url)
    assert.equal(page.status, 200)
    const html = await page.text()
    assert.match(html, /微信扫码登录/)
    assert.match(html, /id="qr"/)

    // 二维码图：等后台把 session 建好
    let qr = null
    for (let i = 0; i < 50; i += 1) {
      const r = await fetch(`${relay.url}qr.png`)
      if (r.status === 200) {
        qr = Buffer.from(await r.arrayBuffer())
        break
      }
      await new Promise((r2) => setTimeout(r2, 50))
    }
    assert.ok(qr && qr.length > 0, "二维码图应该能取到")

    const code = await relay.waitForCode()
    assert.equal(code, "031thecode")

    const st = await (await fetch(`${relay.url}status`)).json()
    assert.equal(st.status, "done")
    assert.equal(typeof st.qr, "number")

    // 二维码是用页面里那个 uuid 申请的，不是我们自己编的
    assert.ok(seen.some((u) => u.includes("/connect/qrcode/TESTUUID123")))
  } finally {
    relay.close()
  }
})

test("QQ 通道：ptuiCB('0') 之后顺着 302 取到带 code 的回调地址", async () => {
  const CALLBACK =
    "https://yybadaccess.3g.qq.com/marvis_client_login/marvis_oauth?login_type=QC&code=QCODE9&state=31.5"
  /** @type {any} */
  const fetchImpl = async (url) => {
    const u = String(url)
    if (u.startsWith("https://xui.ptlogin2.qq.com/cgi-bin/xlogin")) {
      return res({ body: "<html>xlogin</html>", setCookie: ["pt_login_sig=LOGINSIG; Path=/"] })
    }
    if (u.startsWith("https://ssl.ptlogin2.qq.com/ptqrshow")) {
      return res({ body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 9]), setCookie: ["qrsig=QRSIGVALUE; Path=/"] })
    }
    if (u.startsWith("https://ssl.ptlogin2.qq.com/ptqrlogin")) {
      // ptqrtoken 必须是 hash33(qrsig)
      assert.match(u, new RegExp(`ptqrtoken=${hash33("QRSIGVALUE")}`))
      return res({
        body: "ptuiCB('0','0','https://ptlogin2.graph.qq.com/check_sig?x=1','0','登录成功！','')",
      })
    }
    if (u.startsWith("https://ptlogin2.graph.qq.com/check_sig")) {
      return res({
        status: 302,
        headers: { location: "https://graph.qq.com/oauth2.0/authorize?which=Login" },
      })
    }
    if (u.startsWith("https://graph.qq.com/oauth2.0/authorize")) {
      return res({ status: 302, headers: { location: CALLBACK } })
    }
    throw new Error(`没预料到的请求：${u}`)
  }

  const relay = await startRelayLogin({
    loginType: "QC",
    authUrl:
      "https://graph.qq.com/oauth2.0/authorize?which=Login&display=pc&response_type=code&client_id=1903794758",
    guid: "0123456789abcdef0123456789abcdef",
    fetchImpl,
    ifaces: loopback,
    timeoutMs: 10_000,
  })

  try {
    const got = await relay.waitForCode()
    assert.equal(got, CALLBACK)
  } finally {
    relay.close()
  }
})

test("没人扫码：到点报超时，并把服务关掉", async () => {
  /** @type {any} */
  const fetchImpl = async (url) => {
    const u = String(url)
    if (u.startsWith("https://open.weixin.qq.com/connect/qrconnect")) {
      return res({ body: "uuid=1&l/qrconnect?uuid=U1" })
    }
    if (u.includes("/connect/qrcode/")) return res({ body: Buffer.from([1]) })
    return res({ body: "window.wx_errcode=405;window.wx_code='';" })
  }

  const relay = await startRelayLogin({
    loginType: "WX",
    authUrl: "https://open.weixin.qq.com/connect/qrconnect?appid=x",
    guid: "g",
    fetchImpl,
    ifaces: loopback,
    timeoutMs: 300,
  })

  await assert.rejects(() => relay.waitForCode(), /超时/)

  // 关掉之后再连就没人接了
  await assert.rejects(() => fetch(`${relay.url}status`))
})

test("二维码申请失败：waitForCode 把上游错误原样抛出，而不是干等到超时", async () => {
  /** @type {any} */
  const fetchImpl = async () => res({ body: "<html>没有 uuid 的页面</html>" })

  const relay = await startRelayLogin({
    loginType: "WX",
    authUrl: "https://open.weixin.qq.com/connect/qrconnect?appid=x",
    guid: "g",
    fetchImpl,
    ifaces: loopback,
    timeoutMs: 10_000,
  })

  try {
    await assert.rejects(() => relay.waitForCode(), /二维码标识/)
  } finally {
    relay.close()
  }
})

/** 只够让后台 session 建起来、永远停在「等待扫码」的假上游 */
async function waitingFetch(url) {
  const u = String(url)
  if (u.includes("/connect/qrconnect")) {
    return res({
      body: '<script>var fordevtool = "https://long.open.weixin.qq.com/connect/l/qrconnect?uuid=WAIT1"</script>',
    })
  }
  if (u.includes("/connect/qrcode/")) return res({ body: Buffer.from([0x89, 0x50]) })
  if (u.includes("/connect/l/qrconnect")) return res({ body: "window.wx_errcode=408;window.wx_code='';" })
  if (u.startsWith("https://xui.ptlogin2.qq.com")) return res({ body: "x", setCookie: ["pt_login_sig=S; Path=/"] })
  if (u.startsWith("https://ssl.ptlogin2.qq.com/ptqrshow")) {
    return res({ body: Buffer.from([0x89, 0x50]), setCookie: ["qrsig=Q; Path=/"] })
  }
  if (u.startsWith("https://ssl.ptlogin2.qq.com/ptqrlogin")) {
    return res({ body: "ptuiCB('66','0','','0','二维码未失效。','')" })
  }
  throw new Error(`没预料到的请求：${u}`)
}

test("publicUrl 覆盖对外地址（容器里探测到的内网 IP 打不开时）", async () => {
  const relay = await startRelayLogin({
    loginType: "WX",
    authUrl: "https://open.weixin.qq.com/connect/qrconnect?appid=wxb650708317d56f88",
    guid: "0123456789abcdef0123456789abcdef",
    publicUrl: "http://192.168.5.9:18080/",
    fetchImpl: waitingFetch,
    ifaces: () => ({ eth0: [{ family: "IPv4", internal: false, address: "172.17.0.2" }] }),
    timeoutMs: 5_000,
  })
  relay.waitForCode().catch(() => {})
  try {
    assert.match(relay.url, /^http:\/\/192\.168\.5\.9:18080\/s\/[0-9a-f]{16}\/$/)
    assert.doesNotMatch(relay.url, /172\.17\.0\.2/)
    // 服务仍然真的 listen 着（本机端口在），只是「对外地址」换成了外面能打开的那个
    const token = relay.url.split("/s/")[1]
    assert.equal((await fetch(`http://127.0.0.1:${relay.port}/s/${token}status`)).status, 200)
  } finally {
    relay.close()
  }
})

test("port 参数能固定监听端口（容器映射用）", async () => {
  const relay = await startRelayLogin({
    loginType: "QC",
    authUrl: "https://graph.qq.com/oauth2.0/authorize?client_id=1903794758",
    guid: "0123456789abcdef0123456789abcdef",
    fetchImpl: waitingFetch,
    ifaces: loopback,
    timeoutMs: 5_000,
  })
  relay.waitForCode().catch(() => {})
  try {
    assert.ok(relay.port > 0 && relay.port < 65_536)
    assert.equal(relay.url, `http://127.0.0.1:${relay.port}/s/${relay.url.split("/s/")[1]}`)
  } finally {
    relay.close()
  }
})

/** 先占一个空闲端口号再放掉，用来测「同一个端口反复绑定」 */
async function freePort() {
  const srv = createServer()
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  const port = /** @type {any} */ (srv.address()).port
  await new Promise((r) => srv.close(r))
  return port
}

const qc = (port) => ({
  loginType: /** @type {const} */ ("QC"),
  authUrl: "https://graph.qq.com/oauth2.0/authorize?client_id=1903794758",
  guid: "0123456789abcdef0123456789abcdef",
  fetchImpl: waitingFetch,
  ifaces: loopback,
  timeoutMs: 5_000,
  port,
})

// 用户实测的 bug：扫错号 → 在 magpie 里点取消 → 再点登录，报
// "Failed to start server. Is port 18080 in use?"
// 根因：close() 只调了 server.close()，浏览器那条 keep-alive 连接还挂着，端口没放。
test("取消之后再点一次登录：端口能立刻重新绑上", async () => {
  const port = await freePort()
  const ac = new AbortController()

  const first = await startRelayLogin(qc(port))
  const waiting = first.waitForCode({ signal: ac.signal }).catch((e) => e)
  // 模拟用户浏览器打开扫码页（keep-alive 连接留在服务端）
  assert.equal((await fetch(first.url)).status, 200)

  ac.abort() // = 用户在 magpie 里点「取消」
  const err = await waiting
  assert.match(String(/** @type {any} */ (err)?.message ?? err), /取消/)

  // 关键断言：同一个端口立刻还能绑上，不能报 EADDRINUSE
  const second = await startRelayLogin(qc(port))
  try {
    assert.equal((await fetch(second.url)).status, 200)
  } finally {
    second.close()
  }
})

test("上一次扫码页没关就再点一次：新的顶掉旧的，不会报端口占用", async () => {
  const port = await freePort()
  const first = await startRelayLogin(qc(port))
  first.waitForCode().catch(() => {})
  const second = await startRelayLogin(qc(port))
  try {
    assert.equal((await fetch(second.url)).status, 200)
  } finally {
    second.close()
    first.close()
  }
})

test("端口被别的程序占着：报能看懂的错，而不是底层 EADDRINUSE", async () => {
  const port = await freePort()
  const blocker = createServer((_req, res) => res.end("x"))
  await new Promise((r) => blocker.listen(port, "127.0.0.1", r))
  try {
    await assert.rejects(startRelayLogin(qc(port)), /被占用/)
  } finally {
    await new Promise((r) => blocker.close(r))
  }
})
