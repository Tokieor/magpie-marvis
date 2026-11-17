// tests/panel-manifest.test.mjs —— 首行文本面板的打包面与桥接锁
//
// 面板（magpie.panels，slot: provider）的三种失败都是**静默的**：
//   · `file` 不在包的 files 白名单里 → npm 装出来没有这个文件，编辑器里一块空白，没有任何报错；
//   · `slot` 写错 → 永远不出现；
//   · 忘了 `<script src="_magpie/bridge.js">` → 面板读不到 options，一片死白。
// 契约出处：magpie 源码 docs/subsystems/plugin-runtime.md 的 P5，
//   panels: [{slot, file, title}]，slot ∈ {agents, usage, settings, provider}，
//   file 必须是插件目录里的 .html；面板通过 bridge 的 magpie.options.get()/.set() 读写本插件选项。

import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync, existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
const panels = pkg.magpie?.panels ?? []
const SLOTS = new Set(["agents", "usage", "settings", "provider"])

/** 读面板的 HTML 与它自己的 JS */
function panelFiles(panel) {
  const html = readFileSync(join(ROOT, panel.file), "utf8")
  const srcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1])
  const own = srcs.find((s) => !s.includes("_magpie/"))
  assert.ok(own, `${panel.file} 要有自己的脚本`)
  const js = readFileSync(join(dirname(join(ROOT, panel.file)), own), "utf8")
  return { html, srcs, js }
}

test("magpie.panels 形状合法：slot 在允许集合里、file 存在", () => {
  assert.ok(Array.isArray(panels) && panels.length > 0, "面板清单不能空")
  assert.ok(panels.length <= 8, "magpie 一个插件最多 8 个面板")
  for (const p of panels) {
    assert.ok(SLOTS.has(p.slot), `slot 必须是 ${[...SLOTS].join(" / ")}，收到 ${p.slot}`)
    assert.ok(typeof p.title === "string" && p.title.trim(), "要有 title")
    assert.ok(p.file.endsWith(".html"), "file 必须是 .html")
    assert.ok(existsSync(join(ROOT, p.file)), `面板文件不存在：${p.file}`)
  }
})

test("面板要出现在供应商卡片里（slot: provider）", () => {
  assert.ok(panels.some((p) => p.slot === "provider"), "文本框要挂在 provider 编辑器上")
})

test("面板文件必须在 npm 的 files 白名单里（否则用户那边是空白）", () => {
  const files = pkg.files ?? []
  for (const p of panels) {
    const top = p.file.split("/")[0]
    assert.ok(files.includes(top) || files.includes(p.file), `files 里没有 ${top}，npm 打包会漏掉面板`)
  }
})

test("走 bridge 读改写：options.get / set 都在，且写回保留别的键", () => {
  for (const panel of panels) {
    const { srcs, js } = panelFiles(panel)
    assert.ok(srcs.some((s) => s.includes("_magpie/bridge.js")), "必须加载 magpie 的 bridge")
    assert.match(js, /magpie\.options\.get\(\)/, "要读当前选项，否则面板打开是空的")
    assert.match(js, /magpie\.options\.set\(/, "要能写选项")
    assert.match(js, /\.\.\.(opts|rest)/, "options.set 是整份替换，写回必须展开读到的整份 opts")
    assert.ok(js.includes("提示词首行替换"), "写回的是 loader 读的那个键「提示词首行替换」（老的 text / firstLine 一并收掉）")
    assert.match(js, /submit/, "写回要挂在「保存」按钮的 submit 上")
    assert.ok(!/addEventListener\("input"/.test(js), "不要边打字边写：options.set 一秒最多一次")
  }
})

test("面板不得自己发网络请求（沙箱里也没有网络）", () => {
  for (const panel of panels) {
    const { js } = panelFiles(panel)
    assert.ok(!/\bfetch\s*\(/.test(js), "面板不该 fetch：越权也没有网络")
  }
})
