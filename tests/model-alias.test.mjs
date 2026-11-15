// tests/model-alias.test.mjs —— 旧数字模型 ID 的兼容映射
//
// 0.2.x 的 config.models 是数组，magpie 持久化成下标 "0"…"7"；
// 旧路由组仍引用 marvis/0，请求体就是 model:"0"，上游 400 无效模型 id。
// loader 必须把它归一成真正的槽位名。

import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

import { MODEL_ALIASES, canonicalModelId, displayModelId } from "../src/context.mjs"

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
  // 2026-11-15 实测：该槽位回 deepseek-v4-flash-ga-260731、不带推理。
  // 上游 0.2.23 把显示名写成 `deepseek-v4-1-flash-261017 (防降级)`，与实测不符，
  // 本 fork 不采纳 —— 显示名必须是实测值，否则「名字 A 实际 B」的混淆会再来一次。
  assert.equal(displayModelId("deepseek-v4-pro-external"), "deepseek-v4-flash-ga-260731 (pro-external 槽位)")
  assert.equal(canonicalModelId("deepseek-v4-flash-ga-260731 (pro-external 槽位)"), "deepseek-v4-pro-external")
  // 上游那个名字本 fork 从没发过，但从上游版本切过来的路由里可能有，仍要能归一
  assert.equal(canonicalModelId("deepseek-v4-1-flash-261017 (防降级)"), "deepseek-v4-pro-external")
  // 两条 4.1f / 260731 条目并存但不能塌成一个槽位
  assert.notEqual(
    canonicalModelId("deepseek-v4-1-flash-261017"),
    canonicalModelId("deepseek-v4-flash-ga-260731 (pro-external 槽位)"),
    "两条条目不能塌成同一个槽位（塌了就不是替代路由了）",
  )
})
