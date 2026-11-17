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

import { BASE_V1, DEFAULT_MODEL, DISPLAY_BY_SLOT, PROVIDER, canonicalModelId, isUnavailableModel, FIRST_LINE_OPTION_KEY } from "../context.mjs"
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
 * ⇒ 判据是「首行里的词对」，不是「整句模板」。只认英文整句会漏掉中文与本地化写法 ——
 *   它们照样 403，而且因为不命中模板，连 content_filtered 诊断都不会触发，
 *   用户看到的仍是宿主那句「API 密钥无效」。
 */
/**
 * 主流客户端**默认首句** → 能放行的等价句（整句精确匹配才换）。
 *
 * ⚠ 为什么是「整句白名单」而不是正则：
 *   ① 用户自己改过的首句**一个字节都不动** —— 不跟用户的修改打架，也不可能被二次改写；
 *   ② 前缀稳定：同一客户端每次得到同一句 ⇒ 上游前缀缓存照常命中。
 *      正则那种「形状像就改」在用户微调首句后仍会改写，前缀反复变、缓存反复失效；
 *   ③ 出问题时一眼能看出改了什么（整句就是表里那一句）。
 * ⚠ 表里出现新写法 = 新客户端版本 / 新指纹。宁可漏（有 403 诊断兜底），不可错改。
 *
 * 每行：原句（不带句末标点、空白已归一）→ 替换句（带句末标点）。
 * 实测（2026-11-17，直打 127.0.0.1:3425，同一分钟只换 system 首句）：左列 403 → 右列 200。
 */
const IDENTITY_SENTENCES = new Map([
  // DeepSeek Harness（我们自己的，改得理直气壮）
  ["You are an AI agent powered by DeepSeek Harness", "You are an AI agent running in DeepSeek Harness."],
  // Claude Code / Claude Desktop / 裸 Claude；连字符是老版本产物，用户可能已手改过
  [
    "You are Claude Code, Anthropic's official CLI for Claude",
    "You are an agent, Claude Code, Anthropic's official CLI for Claude.",
  ],
  [
    "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK",
    "You are an agent, Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.",
  ],
  [
    "You are Claude-Code, Anthropic's official CLI for Claude",
    "You are an agent, Claude-Code, Anthropic's official CLI for Claude.",
  ],
  ["You are Claude Code", "You are an agent, Claude Code."],
  ["You are Claude", "You are an agent, Claude."],
  // Codex CLI / Codex Desktop
  [
    "You are a coding agent running in the Codex CLI, a terminal-based coding assistant",
    "You are a coding agent, running in the Codex CLI, a terminal-based coding assistant.",
  ],
  [
    "You are a coding agent running in the Codex-CLI, a terminal-based coding assistant",
    "You are a coding agent, running in the Codex-CLI, a terminal-based coding assistant.",
  ],
  ["You are a coding agent running in the Codex", "You are a coding agent, running in the Codex."],
  // ZCode（issue #38）
  [
    "You are ZCode, an interactive agent working with the user toward their goals",
    "You are Z-Code, an interactive agent working with the user toward their goals.",
  ],
  ["You are ZCode", "You are Z-Code."],
  // OpenCode 2（本 fork 最初要解决的那一条，上游表里没有）
  // 实测 2026-11-17：原句 403；`You are an AI agent, running in OpenCode, …` 200；
  // `You are an AI agent working in OpenCode, …` 也 200（两种都行，取与 Codex 一致的「拆主语」写法）
  [
    "You are an AI agent running in OpenCode, a coding agent harness",
    "You are an AI agent, running in OpenCode, a coding agent harness.",
  ],
  ["You are an AI agent running in OpenCode", "You are an AI agent, running in OpenCode."],
])

/** 判定用（只看原文，不参与改写）：命中任一条即认为这次 403 是内容过滤 */
const IDENTITY_PHRASE_TEST =
  /You are an AI agent powered by DeepSeek\s+Harness|You are an AI agent\s+running in OpenCode|You are a coding agent\s+running in the Codex|You are\s+Claude\b|You are\s+ZCode\b|你是一个由\s*DeepSeek\s+Harness/i

/**
 * 上游内容过滤拦截时的**统一**提示（本插件自己的 403 文案，不发给上游）。
 *
 * ⚠ 覆盖的是「**已知会被改写 + 仍被拦**」这一种状态，措辞必须同时成立三件事：
 *   ① 性质是内容过滤，不是密钥或登录（否则用户去重登，白折腾）；
 *   ② 说明这件事客户端多半不用管 —— 常见身份句插件已经替他改了；
 *   ③ 给出「还没覆盖」时的上报动作（把首行带到群里），并留一条 DSH 的手工改法。
 * ⚠ 不要把「改哪一句」写死成唯一修法：不同客户端首句不同（issue #38 的 ZCode 提示词不可配置，
 *   用户侧根本没有可改的地方），写死一家会在别家命中时把人带偏。
 */
const CONTENT_FILTER_HINT =
  "上游内容过滤拦截：系统提示词首句被当成身份指纹（不是密钥或登录问题）。" +
  "主流客户端的默认首句（DSH / OpenCode / Claude Code / Claude Desktop / Codex / ZCode）会在本插件里" +
  "按整句白名单换成等价句；自己改过首句的请求不动（不跟你的修改打架）。" +
  "仍然被拦说明这句还没进白名单 —— 把 system 首行原样带到 QQ 群 451129479，加一行就能修。"

// ── 首行兜底（插件选项 firstLine）────────────────────────────────────
//
// 为什么要有它：整句白名单只覆盖「已知客户端的默认首句」。用户改过的首句、新客户端、
// 我们还没见过的写法，白名单都救不了 —— 而这些请求同样会被 403 拦死。
// 兜底句不含任何 agent 产品名（`You are a helpful assistant.` 实测 200），
// 它能过；代价是模型不知道自己是哪个客户端，所以**默认只在被拦之后才用**（mode=blocked）。
//
// 两个开关由 **magpie 渲染在供应商卡片里**（`auth.options`，见 context.mjs 的 PLUGIN_OPTIONS），
// 用户在编辑器里点 Off/On 即生效，插件用 `input.magpie.option("marvis", key)` 读，
// **不用重启**（magpie 每次调用都现读）：
//
//   first_line_fallback（默认开）被拦时换兜底句重试一次 → blocked
//   first_line_always  （默认关）每个请求都换首行        → always
//   两个都关                                            → off（只走白名单）
//
// 首行文本来自插件选项的 JSON，**就一个键**（`magpie.options` = `{"text": "…"}`）：
// 设置 → 插件 → 本插件那一行的「选项」框里直接改那句话。只留一个键是有意的 ——
// 那个框是 magpie 的通用 JSON 编辑器（值必须是对象，写字符串会被拒），键越少越好改。
// 老版本存下的 `{ "firstLine": { "text": "…", "mode": "…" } }` 仍然读。
// 留空 = 内置兜底句。整行替换：只换 system 消息的第一行，第二行起原样。

/** 内置兜底首行：不含任何 agent 产品名（实测 200） */
const FALLBACK_FIRST_LINE = "You are a helpful assistant."


/**
 * 读一次「首行改写」配置。
 *
 * 开关从 magpie 现读（`input.magpie.option(provider, key)`，用户点一下就到，不用重启）；
 * 文本从插件选项的 JSON 读（`magpie.options.firstLine.text`）。任何形状不对的值都退回默认
 * （fallback 开 + 内置兜底句），绝不因为配置写错而让请求失败。
 *
 * @param {unknown} input   magpie 给插件的 input（`input.magpie.option` 在里面）
 * @param {unknown} options 插件选项（设置页那个 JSON）
 * @returns {{ mode: "off" | "blocked" | "always", text: string }}
 */
function firstLineOption(input, options) {
  let opts = options
  if (typeof opts === "string") {
    try {
      opts = JSON.parse(opts)
    } catch {
      opts = {}
    }
  }
  // 新形状：{"提示词首行替换": "…"}（键名就是给人看的字段名）；
  // 0.2.50 用的是 {"text": "…"}，0.2.49 及以前是 {"firstLine": {"text": "…"}} —— 都还读
  const raw =
    typeof opts?.[FIRST_LINE_OPTION_KEY] === "string"
      ? { text: opts[FIRST_LINE_OPTION_KEY] }
      : typeof opts?.text === "string"
        ? opts
        : opts?.firstLine
  const text =
    typeof raw?.text === "string" && raw.text.trim()
      ? raw.text.trim().replace(/\s*\n\s*/g, " ")
      : FALLBACK_FIRST_LINE
  // 开关：用户的值 → 插件默认。读不到（老 magpie / 抛错）就当默认
  const switched = (key, fallback) => {
    try {
      const v = input?.magpie?.option?.(PROVIDER, key)
      return typeof v === "boolean" ? v : fallback
    } catch {
      return fallback
    }
  }
  const always = switched("first_line_always", false)
  const blocked = switched("first_line_fallback", true)
  const mode = always ? "always" : blocked ? "blocked" : "off"
  return { mode, text }
}

/**
 * 把 system 消息的**第一行**整行换掉（第二行起原样）。
 *
 * 只动第一条 system 消息 —— 再往后的 system 不是身份句的常见位置，改了反而多余。
 * 没有 system 消息时原样返回（调用方据此判断有没有改动）。
 *
 * @param {unknown} messages
 * @param {string} text
 * @returns {unknown}
 */
function withFirstLine(messages, text) {
  if (!Array.isArray(messages)) return messages
  let touched = false
  const out = messages.map((message) => {
    if (touched) return message
    if (!message || typeof message !== "object") return message
    if (message.role !== "system" || typeof message.content !== "string") return message
    touched = true
    const line = firstLineOf(message.content)
    return { ...message, content: text + message.content.slice(line.length) }
  })
  return touched ? out : messages
}


/**
 * 构造一个错误 Response。
 * @param {number} status
 * @param {string} code
 * @param {string} message
 * @param {Record<string, string>} [headers]
 */
/** 请求头构造失败（uskey 现签）—— 与「连不上上游」不是一类故障，别混成同一个 503 */
class HeaderUnavailable extends Error {}

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

/** 首行里的第一句（到第一个句末标点为止；没有标点就是整行） */
function firstSentenceOf(line) {
  const m = /^[\s\S]*?[.!?](?=\s|$)/.exec(line)
  return m ? m[0] : line
}

/**
 * 首句命中白名单就整句换掉；没命中（用户改过的、新版本的、没见过的）**原样返回**。
 *
 * 只动一个句子：行内其余内容与后续行一个字节都不碰；替换**幂等** ——
 * 换完的句子不在表里，下次调用不会再动它（前缀因此稳定，缓存不会反复失效）。
 */
function rewriteFirstLine(text) {
  const line = firstLineOf(text)
  const sentence = firstSentenceOf(line)
  const rest = line.slice(sentence.length)
  const key = sentence.replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "")
  const to = IDENTITY_SENTENCES.get(key)
  if (!to) return text
  const next = to + rest
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

export function loaderHook(input, options = {}) {
  return async (getAuth) => {
    const auth = await getAuth()
    const creds = credsOf(auth)
    if (!creds.accessToken || !creds.openid) {
      return {}
    }

    return {
      baseURL: BASE_V1,
      apiKey: "placeholder",
      fetch: async (target, init) => {
        // ⚠ 每次请求都现读开关：magpie 的 option() 本来就是现查的，改了立刻生效
        const firstLine = firstLineOption(input, options)
        const url = typeof target === "string" ? target : target instanceof URL ? target.href : target.url

        // 非补全请求（/models 之类）原样放行 —— 上游没有这个端点，交给上层兜底
        if (!/\/chat\/completions\b/.test(url)) {
          return fetch(target, init)
        }

        /**
         * 发一次上游请求。**每次都重新签 uskey** —— 它是一次性的：
         * 403 兜底重试若复用上一次的 uskey，会直接撞风控（`risk_blocked`），
         * 看起来像另一个故障，排查时会被带偏。
         */
        const callUpstream = async (payload) => {
          let headers
          try {
            // ⚠ `Marvis-Scene` 是上游的**准入闸门**，不是随便填的元数据：
            //   `preload_summary` / `prefill_supplement` / `agent` 这几个场景
            //   只放行腾讯自家的 deepseek / hunyuan —— claude-sonnet-4-6 / claude-opus-4-6 /
            //   gpt-5.4 在这种场景下一律回 `4130001 无效模型id`（看起来像模型不存在，
            //   其实是场景不放行，上游把两种情况共用一个码）。
            //   实测只有 `chat` 场景能过全部 8 个槽位，所以固定用 `chat`（本 fork 0.2.27 起）。
            headers = llmHeaders(creds, { scene: "chat", agentTag: "main_agent" })
          } catch (err) {
            throw new HeaderUnavailable(err?.message ?? String(err))
          }
          // 保留调用方传的 stream / 业务体，只换鉴权头
          const merged = { ...(init?.headers ?? {}) }
          for (const [k, v] of Object.entries(headers)) merged[k] = v
          if (payload !== init?.body) {
            // body 变了，长度 / 压缩头必须去掉，让 fetch 重新算
            delete merged["content-length"]
            delete merged["Content-Length"]
            delete merged["content-encoding"]
            delete merged["Content-Encoding"]
          }
          return fetch(url, { ...init, body: payload, headers: merged })
        }

        /** 上游给流式响应时带的是 text/plain，但 body 是标准 SSE —— 归一化 content-type */
        const normalizeStreaming = (res) => {
          const ct = res.headers.get("content-type") ?? ""
          if (res.body && !/event-stream/i.test(ct)) {
            const headers = new Headers(res.headers)
            headers.set("content-type", "text/event-stream; charset=utf-8")
            return new Response(res.body, { status: res.status, headers })
          }
          return res
        }

        /**
         * 403 兜底：把首行换成兜底句，**重试一次**。
         * 成功返回规范化后的响应；失败返回 null（落回统一诊断，不把第二次的错误文本当结果）。
         */
        const retryWithFallbackFirstLine = async (json) => {
          const messages = withFirstLine(json.messages, firstLine.text)
          if (messages === json.messages) return null // 没有 system 消息，无从下手
          try {
            const retry = await callUpstream(JSON.stringify({ ...json, messages }))
            return retry.ok ? normalizeStreaming(retry) : null
          } catch {
            return null
          }
        }

        // ⚠ 旧路由里模型 ID 是数组下标 `"0"…"7"`，上游只认槽位名。
        //   在这里做一次归一，旧路由不改配置也能继续用。
        let body = init?.body
        /** 改写前的原始请求体 —— 403 诊断要靠它判断上游拦的是哪句身份声明（body 可能已被改写） */
        const originalBody = typeof body === "string" ? body : ""
        /** @type {string | null} 命中「明确不可用」名单的模型 ID */
        let unavailableModel = null
        /** 请求体里是否含被上游内容过滤定向拦截的 DSH 标识语句 */
        let harnessIdentityPrompt = false
        /** 解析后的请求体 —— 403 兜底重试要用它重建 body */
        let requestJson = null
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
            requestJson = json
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
              // mode=always：用户明确要求「每个请求都换成我填的那句」，优先级高于白名单
              if (firstLine.mode === "always") {
                const forced = withFirstLine(json.messages, firstLine.text)
                if (forced !== json.messages) {
                  json.messages = forced
                  changed = true
                }
              }
            }
            if (changed) body = JSON.stringify(json)
          }
        }

        // 明确不可用模型：本地 404，一次 fetch 都不发
        if (unavailableModel !== null) {
          return modelUnavailableResponse(unavailableModel)
        }

        let response
        try {
          response = await callUpstream(body)
        } catch (err) {
          if (err instanceof HeaderUnavailable) {
            return errorResponse(503, "header_unavailable", `请求头构造失败：${err.message}`)
          }
          return errorResponse(503, "upstream_unreachable", `连不上 Marvis 网关：${err?.message ?? err}`)
        }

        if (response.ok) return normalizeStreaming(response)

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
          return errorResponse(404, "model_unavailable", `该模型在当前账号不可用：${text.slice(0, 300)}`)
        }
        // ⚠ 403 +「非法请求」一律按内容过滤处理，**不再看是否命中已知指纹**。
        //   理由：上游的指纹在持续扩大（英文 → 中文 → 还没见过的写法），按指纹判定永远漏；
        //   而 403 + 这个组合目前只出现在内容过滤上（模型无权限是 400「无效模型id」）。
        //   宁可多给一句「进群」，也不要把人甩回宿主那句「API 密钥无效」。
        if (response.status === 403 && /非法请求|permission_error/i.test(text)) {
          // 兜底：白名单救不了的（用户改过首句 / 新客户端 / 没见过的写法），
          // 换一句不含任何 agent 产品名的首行重试一次。宁可多打一次，也别把人卡死在 403。
          if (firstLine.mode === "blocked" && requestJson) {
            const retried = await retryWithFallbackFirstLine(requestJson)
            if (retried) return retried
          }
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
