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

import { BASE_V1, DEFAULT_MODEL, DISPLAY_BY_SLOT, canonicalModelId, isUnavailableModel } from "../context.mjs"
import { llmHeaders } from "../marvis/protocol.mjs"
import { normalizeTools } from "../marvis/tool-schema.mjs"

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
 * 构造一个错误 Response。
 * @param {number} status
 * @param {string} code
 * @param {string} message
 * @param {Record<string, string>} [headers]
 */
function errorResponse(status, code, message, headers = {}) {
  return new Response(JSON.stringify({ error: { type: "upstream_error", code, message } }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
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

export function loaderHook() {
  return async (getAuth) => {
    const auth = await getAuth()
    const creds = credsOf(auth)
    if (!creds.accessToken || !creds.openid) {
      return {}
    }

    return {
      baseURL: BASE_V1,
      apiKey: "placeholder",
      fetch: async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url

        // 非补全请求（/models 之类）原样放行 —— 上游没有这个端点，交给上层兜底
        if (!/\/chat\/completions\b/.test(url)) {
          return fetch(input, init)
        }

        // ⚠ 每次都要重新算头：uskey 是一次性的
        let headers
        try {
          headers = llmHeaders(creds, {
            // ⚠ `Marvis-Scene` 是上游的**准入闸门**，不是随便填的元数据：
            //   `preload_summary` / `prefill_supplement` / `agent` 这几个场景
            //   只放行腾讯自家的 deepseek / hunyuan，claude / gpt 一律回
            //   `4130001 无效模型id`（看起来像模型不存在，其实是场景不放行）。
            //   实测只有 `chat` 场景能过全部 8 个槽位，所以固定用 `chat`。
            scene: "chat",
            agentTag: "main_agent",
          })
        } catch (err) {
          return errorResponse(
            503,
            "header_unavailable",
            `请求头构造失败：${err?.message ?? err}`,
          )
        }

        // 保留调用方传的 stream / 业务体，只换鉴权头
        const merged = { ...(init?.headers ?? {}) }
        for (const [k, v] of Object.entries(headers)) merged[k] = v

        // ⚠ 旧路由里模型 ID 是数组下标 `"0"…"7"`，上游只认槽位名。
        //   在这里做一次归一，旧路由不改配置也能继续用。
        let body = init?.body
        /** @type {string | null} 命中「明确不可用」名单的模型 ID */
        let unavailableModel = null
        if (typeof body === "string") {
          try {
            const json = JSON.parse(body)
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
            // 其余模型（含 TABLE 外的旧真实槽位）一律出网，可用性由上游响应决定。
            // Marvis 要求每个工具 parameters 显式 type:"object"；
            // DSH 的部分工具省略了它，缺一个就 400 invalid parameter。
            const tools = normalizeTools(json.tools)
            if (tools !== json.tools) {
              json.tools = tools
              changed = true
            }
            if (changed) {
              body = JSON.stringify(json)
              // body 变了，长度头必须去掉，让 fetch 重新算
              delete merged["content-length"]
              delete merged["Content-Length"]
              delete merged["content-encoding"]
              delete merged["Content-Encoding"]
            }
          } catch {
            /* 不是 JSON 就原样转发 */
          }
        }

        // 明确不可用模型：本地 404，一次 fetch 都不发
        if (unavailableModel !== null) {
          return modelUnavailableResponse(unavailableModel)
        }

        let response
        try {
          response = await fetch(url, { ...init, ...(body === init?.body ? {} : { body }), headers: merged })
        } catch (err) {
          return errorResponse(503, "upstream_unreachable", `连不上 Marvis 网关：${err?.message ?? err}`)
        }

        if (response.ok) {
          // 上游给流式响应时带的是 `text/plain` —— 但 body 是标准 SSE。
          // 部分 OpenAI SDK 版本按 content-type 决定走不走 SSE 解析器，所以这里归一化。
          const ct = response.headers.get("content-type") ?? ""
          if (response.body && !/event-stream/i.test(ct)) {
            const headers = new Headers(response.headers)
            headers.set("content-type", "text/event-stream; charset=utf-8")
            return new Response(response.body, { status: response.status, headers })
          }
          return response
        }

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
          // 4130001 有两种含义，别一口咬定「模型下线」把人带偏：
          //   ① 槽位名写错/已下线  ② 场景不放行（同一个 id 在别的 Marvis-Scene 下能过）
          const hint = /4130001/.test(text) ? "（模型 id 无效，或当前场景/账号不放行）" : ""
          return errorResponse(
            404,
            "model_unavailable",
            `该模型在当前账号不可用${hint}：${text.slice(0, 300)}`,
          )
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
