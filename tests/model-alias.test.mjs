// tests/model-alias.test.mjs —— 旧数字模型 ID 的兼容映射
//
// 0.2.x 的 config.models 是数组，magpie 持久化成下标 "0"…"7"；
// 旧路由组仍引用 marvis/0，请求体就是 model:"0"，上游 400 无效模型 id。
// loader 必须把它归一成真正的槽位名。

import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

import { MODEL_ALIASES, canonicalModelId, displayModelId, DISPLAY_BY_SLOT } from "../src/context.mjs"

test("数字 ID 按 TABLE 顺序映射到槽位名", () => {
  assert.equal(canonicalModelId("0"), "main-auto")
  assert.equal(canonicalModelId("7"), "hunyuan-turbos-vision")
  assert.equal(canonicalModelId("deepseek-v4-1-flash-261017"), "main-auto", "真实模型名也要归一成槽位")
  assert.equal(Object.keys(MODEL_ALIASES).length, 8)
})

test("真实槽位名 / 未知 ID 原样返回", () => {
  assert.equal(canonicalModelId("main-auto"), "main-auto")
  assert.equal(canonicalModelId("deepseek-v4-pro-external"), "deepseek-v4-pro-external")
  assert.equal(canonicalModelId("not-a-model"), "not-a-model")
  assert.equal(canonicalModelId(undefined), "")
})

test("loader 确实调用了归一函数（改回不调用会 400）", () => {
  const source = readFileSync(new URL("../src/hooks/loader.mjs", import.meta.url), "utf8")
  assert.match(source, /canonicalModelId/)
  assert.match(source, /json\.model = canonical/)
})

test("旧显示名 deepseek-v4-pro-202606 仍能归一（改名不打断已有路由）", () => {
  // 0.2.22 及以前该槽位的展示名就是它；用户路由组里可能还写着这个名字
  assert.equal(canonicalModelId("deepseek-v4-pro-202606"), "deepseek-v4-pro-external")
})

test("pro-external 的显示名跟实测走（不是 4.1f，是 260731），且两条不塌成同一槽位", () => {
  // 2026-11-15/16 两个 QQ 账号实测：该槽位回 deepseek-v4-flash-ga-260731、不带推理。
  // 上游 0.2.23 起把显示名写成 `deepseek-v4-1-flash-261017 (防降级)` / `-antidowngrade`，
  // 与实测不符，本 fork 不采纳 —— 显示名必须是实测值，否则「名字 A 实际 B」的混淆会再来一次。
  // 后缀用连字符拼、不带空格与括号：issue #15 说显示名带空格 / 非 ASCII 会让 Copilot 卡在回复阶段
  assert.equal(displayModelId("deepseek-v4-pro-external"), "deepseek-v4-flash-ga-260731-proexternal")
  assert.equal(canonicalModelId("deepseek-v4-flash-ga-260731-proexternal"), "deepseek-v4-pro-external")
  // 本 fork 0.2.28 用过的带空格版：老路由组里的名字仍要归一
  assert.equal(canonicalModelId("deepseek-v4-flash-ga-260731 (pro-external slot)"), "deepseek-v4-pro-external")
  // 上游用过的两个名字，以及本 fork 早期的中文后缀名：从任何一边切过来都要能归一
  assert.equal(canonicalModelId("deepseek-v4-1-flash-261017 (防降级)"), "deepseek-v4-pro-external")
  assert.equal(canonicalModelId("deepseek-v4-1-flash-261017-antidowngrade"), "deepseek-v4-pro-external")
  assert.equal(canonicalModelId("deepseek-v4-flash-ga-260731 (pro-external 槽位)"), "deepseek-v4-pro-external")
  // 两条 4.1f / 260731 条目并存但不能塌成一个槽位
  assert.notEqual(
    canonicalModelId("deepseek-v4-1-flash-261017"),
    canonicalModelId("deepseek-v4-flash-ga-260731-proexternal"),
    "两条条目不能塌成同一个槽位（塌了就不是替代路由了）",
  )
})

test("模型显示名必须是纯 ASCII —— 非 ASCII 会让部分客户端（Copilot）在回复阶段卡死", () => {
  // issue #15：显示名带全角括号与空格时，VS Code Copilot 选它会一直停在回复中，DSH 下正常。
  for (const [slot, name] of Object.entries(DISPLAY_BY_SLOT)) {
    assert.match(name, /^[\x21-\x7e]+$/, `槽位 ${slot} 的显示名含非 ASCII / 空白字符：${name}`)
  }
})
