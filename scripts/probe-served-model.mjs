#!/usr/bin/env node
// 自查：你的 marvis 账号「实际被路由到哪个快照」
//
// 背景：auto 家族（main-auto 等）在服务端是**按账号**改路由的，被改到的号会落到旧快照。
// 旧快照的名字**不固定** —— 已知出现过 `deepseek-v4-flash-ga-260731`（issue #13）、
// `deepseek-v4-flash-202605`（issue #43）。判定只认**响应体里的 `model`**，不要认槽位名。
//
// 这个脚本完全绕开 magpie：直接用插件自己的 `llmHeaders()` 打上游，
// 所以供应商关掉、magpie 没开都能跑；也不动任何配置，只读本机的账号文件。
//
// 用法：
//   node scripts/probe-served-model.mjs                       # 全部账号 × 两个槽位
//   node scripts/probe-served-model.mjs --slots main-auto     # 只测某个槽位
//   node scripts/probe-served-model.mjs --json                # 机器可读
//
// 退出码：0 = 全部一致；2 = 有账号被路由到别的快照；1 = 没有可用账号 / 读不到配置

import { readFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { llmHeaders } from "../src/marvis/protocol.mjs"
import { BASE_V1, DISPLAY_BY_SLOT, expectedServedModel } from "../src/context.mjs"

const DEFAULT_SLOTS = ["main-auto", "deepseek-v4-pro-external"]
const TIMEOUT_MS = 60_000

function parseArgs(argv) {
  const out = { slots: DEFAULT_SLOTS, json: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === "--json") out.json = true
    else if (a === "--slots") out.slots = String(argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean)
    else if (a.startsWith("--slots=")) out.slots = a.slice(8).split(",").map((s) => s.trim()).filter(Boolean)
    else if (a === "-h" || a === "--help") {
      console.log("用法: node scripts/probe-served-model.mjs [--slots main-auto,deepseek-v4-pro-external] [--json]")
      process.exit(0)
    }
  }
  if (out.slots.length === 0) out.slots = DEFAULT_SLOTS
  return out
}

/** magpie 的配置目录：优先 MAGPIE_CONFIG，其次 ~/.config/magpie */
function configDir() {
  return process.env.MAGPIE_CONFIG || join(homedir(), ".config", "magpie")
}

/** 读出本机所有 marvis 账号（只读，不写回） */
function accounts() {
  const file = join(configDir(), "plugin-auth.json")
  if (!existsSync(file)) return { file, list: [] }
  let json = null
  try {
    json = JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return { file, list: [] }
  }
  const list = []
  for (const [key, v] of Object.entries(json ?? {})) {
    if (!key.startsWith("marvis#") || !v || typeof v !== "object") continue
    const meta = v.metadata ?? {}
    list.push({
      key,
      accountId: v.accountId || meta.nickname || key,
      acct: {
        openid: meta.openid,
        accessToken: v.access,
        guid: meta.guid,
        loginType: meta.loginType,
      },
    })
  }
  return { file, list }
}

/**
 * 打一次上游，从**流式首帧**里读 `model` 字段。
 *
 * ⚠ 只读到出现 `"model":` 为止就取消，不把整条流读完 —— 与插件 loader 里
 *   「不要在 fetch 里读流」是同一条约束的两个方向：这里读的是我们自己的一次性探针，
 *   不是要给宿主转发的响应。
 */
async function servedModel(acct, slot) {
  const res = await fetch(`${BASE_V1}/chat/completions`, {
    method: "POST",
    // ⚠ 必须与 loader 发的头一致（chat / main_agent）：
    //   `preload_summary` 场景下 claude / gpt 一律 4130001，探针量到的就不是插件的真实行为了
    headers: llmHeaders(acct, { scene: "chat", agentTag: "main_agent" }),
    body: JSON.stringify({
      model: slot,
      stream: true,
      max_tokens: 8,
      messages: [{ role: "user", content: "hi" }],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) return { status: res.status, served: null, error: (await res.text()).slice(0, 160) }
  const reader = res.body?.getReader()
  const decoder = new TextDecoder()
  let text = ""
  try {
    while (reader) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
      if (/"model"\s*:/.test(text)) break
    }
  } finally {
    await reader?.cancel().catch(() => {})
  }
  const served = (/"model"\s*:\s*"([^"]+)"/.exec(text) ?? [])[1] ?? null
  return { status: res.status, served, error: null }
}

const args = parseArgs(process.argv.slice(2))
const { file, list } = accounts()

if (list.length === 0) {
  console.error(`没有找到 marvis 账号：${file}`)
  console.error("先在 magpie 里登录一个账号，或用 MAGPIE_CONFIG 指向配置目录。")
  process.exit(1)
}

const rows = []
for (const { accountId, acct } of list) {
  for (const slot of args.slots) {
    // 没在 TABLE 里声明的槽位（file-auto / app-auto …）没有「应该服务什么」可言：
    // 它们由服务端按槽位固定映射，实测是唯一判据 —— 别拿槽位名当期望值，否则全是假报警。
    const declared = slot in DISPLAY_BY_SLOT ? expectedServedModel(slot) : null
    let r
    try {
      r = await servedModel(acct, slot)
    } catch (err) {
      r = { status: 0, served: null, error: String(err?.message ?? err) }
    }
    rows.push({
      account: accountId,
      slot,
      declared,
      served: r.served,
      status: r.status,
      ok: declared === null ? Boolean(r.served) : Boolean(r.served) && r.served === declared,
      error: r.error,
    })
  }
}

const mismatch = rows.filter((r) => !r.ok)

if (args.json) {
  console.log(JSON.stringify({ accounts: list.length, rows }, null, 2))
} else {
  console.log(`\n探针 · marvis 账号实际服务模型（绕开 magpie 直连上游）\n`)
  for (const r of rows) {
    const mark = r.declared === null ? "ℹ️ " : r.ok ? "✅" : r.served ? "⚠️ " : "❌"
    const got = r.served ?? `(HTTP ${r.status || "-"}${r.error ? " " + r.error : ""})`
    const want = r.declared === null ? "（未声明，只看实测）" : r.declared
    console.log(`${mark} ${r.account.padEnd(18)} ${r.slot.padEnd(26)} 声明 ${want.padEnd(38)} 实服务 ${got}`)
    if (r.declared !== null && !r.ok && r.served) {
      console.log(`     ↳ 这个号被路由到了别的快照：${r.served}（不是声明里的 ${r.declared}）`)
      console.log(`       要拿回声明的模型，改用防降级槽位：deepseek-v4-pro-external`)
    }
  }
  console.log()
  if (mismatch.length > 0) {
    console.log(`⚠️  ${mismatch.length}/${rows.length} 条与声明不一致 —— 旧快照的名字不固定（ga-260731 / 202605 都出现过），只认响应体 model。`)
  } else {
    console.log(`全部与声明一致（${rows.length} 条）。`)
  }
  console.log()
}

process.exit(mismatch.length > 0 ? 2 : 0)
