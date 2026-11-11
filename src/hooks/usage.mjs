// ⑤ auth.usage —— 卡片上的额度窗口
//
// Marvis 的额度是**令牌钱包**：总额 10,000,000 tokens，用掉多少、剩多少。
// 上游 `POST /v3/marvis_get_wallet` 返回：
//   { total_tokens, used_tokens, frozen_tokens, avail_tokens, total_cost, status }
//
// ⚠ 窗口一律交给 src/quota.mjs 的构造器生成（这里只给**原始字段**，不要自己先构造一遍）。
//   它会拦下：缺 used、aside 带 amount/limit、时间不是 ISO —— 这五类写法不会抛错，
//   只会让卡片显示「剩余额度未知」，而这个号在智能路由里等于不存在（HOOKS §三）。

import { mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { usage as buildUsage, usageWindow } from "../quota.mjs"
import { businessHeaders } from "../marvis/protocol.mjs"
import { BASE } from "../context.mjs"

const WALLET_URL = `${BASE}/v3/marvis_get_wallet`

const fmt = (n) => (Number.isFinite(Number(n)) ? Number(n).toLocaleString("en-US") : "0")

/**
 * 上游失败时留一份现场（不含 token），方便排查「卡片刻度不更新」。
 * @param {unknown} err
 */
function recordFailure(err) {
  try {
    // ⚠ 这个文件是 `"type": "module"`：**没有** `require`。
    //   以前这里写的是 `require("node:fs")` —— ReferenceError 被下面的 catch 吞掉，
    //   于是这个诊断文件从来没写出来过（排查时白等）。必须用顶层 import。
    const dir = join(homedir(), ".cache", "magpie")
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, "marvis-wallet-error.json"),
      `${JSON.stringify({ at: new Date().toISOString(), message: String(/** @type {any} */ (err)?.message ?? err) }, null, 2)}\n`,
    )
  } catch {
    /* 写不进去就算了，别因为诊断把主流程搞挂 */
  }
}

export function usageHook() {
  return async (getAuth) => {
    const auth = await getAuth()
    const meta = auth?.metadata ?? {}
    const acct = {
      openid: String(meta.openid ?? ""),
      accessToken: String(auth?.access ?? auth?.key ?? ""),
      guid: String(meta.guid ?? ""),
      loginType: String(meta.loginType ?? "1"),
    }
    if (!acct.accessToken || !acct.openid) {
      return { error: "尚未登录 Marvis", windows: [] }
    }

    /** @type {any} */
    let wallet
    try {
      const body = "{}"
      const res = await fetch(WALLET_URL, {
        method: "POST",
        headers: businessHeaders(acct, { query: body, method: "POST" }),
        body,
        signal: AbortSignal.timeout(15_000),
      })
      const text = await res.text()
      if (!res.ok) throw new Error(`HTTP ${res.status}：${text.slice(0, 200)}`)
      wallet = JSON.parse(text)?.data
      if (!wallet) throw new Error(`返回体没有 data：${text.slice(0, 200)}`)
    } catch (err) {
      recordFailure(err)
      // 读取失败不要把整次判死：返回空窗口 + error，magpie 会保留旧值
      return { error: `读取令牌钱包失败：${/** @type {any} */ (err)?.message ?? err}`, windows: [] }
    }

    const total = Number(wallet.total_tokens ?? 0)
    const used = Number(wallet.used_tokens ?? 0)
    const avail = Number(wallet.avail_tokens ?? Math.max(0, total - used))
    const frozen = Number(wallet.frozen_tokens ?? 0)

    return buildUsage({
      plan: "Marvis 令牌",
      windows: [
        // 主窗口：数量型（amount + limit）。路由排序读的就是它。
        usageWindow({
          name: "令牌用量",
          amount: used,
          limit: total,
          unit: "tokens",
          display: `${fmt(avail)} 可用 / 共 ${fmt(total)}`,
        }),
        // 冻结额度单独一条，只上卡片（不影响路由）
        ...(frozen > 0
          ? [usageWindow({ name: "冻结中", textOnly: true, display: `冻结 ${fmt(frozen)}` })]
          : []),
      ],
    })
  }
}
