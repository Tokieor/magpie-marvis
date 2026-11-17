// tests/model-catalog-support.test.mjs —— 配置合并的展示目录 / 归一化回归锁
//
// 背景：用户配置可能因手工配置或陈旧路由包含 `kimi-k2.5`；该槽位实测上游
// 返回 500，属于 `context.mjs` 的 `isUnavailableModel` 明确判死的**不可用名单**。
//
// 合并策略（0.2.22 起，**不可用 denylist + 其余保留**）：
//   · 删 = 只有 `isUnavailableModel` 判为不可用的条目（当前只有 `kimi-k2.5`）
//   · 留 = 其余默认表（TABLE）外条目原样保留 —— TABLE 是**对外展示目录**，
//     不是上游可用性全集；`app-auto` 等旧真实槽位上游仍 200，不能误删
//     （见 tests/legacy-model-config.test.mjs）
//   · 归一 = 能落进 TABLE 的（数字下标 `0`…`7` / 槽位名 / 真实显示名）仍归一成真实显示名
//
// 硬要求（用户指定，不许妥协）：
//   1. Magpie 的模型**键 / id / name** 必须是真实模型名，绝不能出现内部槽位名 `main-auto`
//   2. `main-auto` 只允许作为上游 `apiId` / `api.id`
//   3. denylist 条目必须被清除，不得静默改成 main-auto 或其他模型
//   4. 旧数组 / 数字下标 / 槽位名 → 真实显示名的兼容不能回归

import test from "node:test"
import assert from "node:assert/strict"

import {
  staticModels,
  providerModels,
  canonicalModelId,
  displayModelId,
  DISPLAY_BY_SLOT,
  expectedServedModel,
} from "../src/context.mjs"
import { mergeModels } from "../src/hooks/config.mjs"

const defaults = staticModels()
const defaultKeys = Object.keys(defaults).sort()

// ── 1. denylist 条目清除 ─────────────────────────────────────────

test("mergeModels 删除 denylist 中的不可用条目 kimi-k2.5（对象形态）", () => {
  const user = {
    ...defaults,
    "kimi-k2.5": {
      id: "kimi-k2.5",
      name: "kimi-k2.5",
      apiId: "kimi-k2.5",
      limit: { context: 128_000, output: 32_000 },
      tool_call: true,
      reasoning: true,
    },
  }
  const merged = mergeModels(defaults, user)
  assert.equal(merged["kimi-k2.5"], undefined, "失效模型 kimi-k2.5 必须被清除")
  assert.deepEqual(
    Object.keys(merged).filter((k) => /kimi/i.test(k)),
    [],
    "输出里不应残留任何 kimi 条目",
  )
  assert.deepEqual(Object.keys(merged).sort(), defaultKeys, "输出键集合应等于默认表")
})

test("mergeModels 删除数组形态末尾多出来的 denylist 条目", () => {
  // 旧数组带多一条 kimi：denylist 命中，必须丢弃
  const user = [...Object.values(defaults), { id: "kimi-k2.5", name: "kimi-k2.5", apiId: "kimi-k2.5" }]
  const merged = mergeModels(defaults, user)
  assert.equal(merged["kimi-k2.5"], undefined, "数组末尾的 denylist 条目也必须被清除")
  assert.deepEqual(Object.keys(merged).sort(), defaultKeys)
})

test("denylist 条目不会被静默改写成 main-auto 或其他真实模型", () => {
  const user = { "kimi-k2.5": { id: "kimi-k2.5", name: "kimi-k2.5" } }
  const merged = mergeModels(defaults, user)
  // 不能凭空多出一个指向 main-auto 的伪造条目
  assert.equal(Object.keys(merged).includes("kimi-k2.5"), false)
  // main-auto 的真实显示名那条只能是默认自带的，不能被当成 kimi 的替身多出来
  assert.equal(merged["deepseek-v4-1-flash-261017"].apiId, "main-auto")
  assert.deepEqual(Object.keys(merged).sort(), defaultKeys)
})

test("denylist 之外的手工槽位保留：TABLE 是展示目录，不是可用性全集", () => {
  const user = {
    "app-auto": {
      id: "app-auto",
      name: "app-auto",
      apiId: "app-auto",
      tool_call: true,
      reasoning: true,
      limit: { context: 1_000_000, output: 32_000 },
    },
  }
  const merged = mergeModels(defaults, user)
  assert.ok(merged["app-auto"], "不在 denylist 里的旧真实槽位不能删")
  assert.equal(merged["app-auto"].id, "app-auto", "原条目不能被改名成默认模型")
  assert.equal(merged["app-auto"].name, "app-auto")
  assert.equal(merged["app-auto"].limit.context, 1_000_000)
  // 展示目录本身不因用户配置变大
  assert.deepEqual(Object.keys(defaults).sort(), defaultKeys)
})

// ── 2. 真实显示名 / 槽位归一保留 ──────────────────────────────────

test("真实显示名保留：默认合并后 key、id、name 三者一致且是真实模型名", () => {
  const merged = mergeModels(defaults, {})
  for (const [key, model] of Object.entries(merged)) {
    assert.equal(model.id, key, `id 必须等于真实显示名（${key}）`)
    assert.equal(model.name, key, `name 必须等于真实显示名（${key}）`)
    assert.notEqual(key, "main-auto", "键不能是内部槽位名 main-auto")
    assert.notEqual(model.id, "main-auto", "id 不能是内部槽位名 main-auto")
    assert.notEqual(model.name, "main-auto", "name 不能是内部槽位名 main-auto")
  }
  assert.equal(
    merged["deepseek-v4-1-flash-261017"].apiId,
    "main-auto",
    "apiId 才允许是上游槽位名 main-auto",
  )
})

test("旧槽位名 main-auto 归一成真实显示名，apiId 保留 main-auto，用户字段优先", () => {
  const user = {
    "main-auto": {
      id: "main-auto",
      name: "main-auto", // 即使是槽位名，也不能显示到 name
      limit: { context: 2_000_000 },
    },
  }
  const merged = mergeModels(defaults, user)
  assert.equal(merged["main-auto"], undefined, "不能以 main-auto 作为模型键")
  const model = merged["deepseek-v4-1-flash-261017"]
  assert.ok(model, "main-auto 必须归一成 deepseek-v4-1-flash-261017")
  assert.equal(model.id, "deepseek-v4-1-flash-261017")
  assert.equal(model.name, "deepseek-v4-1-flash-261017", "name 不能显示成槽位名 main-auto")
  assert.equal(model.apiId, "main-auto", "apiId 保留上游槽位名")
  assert.equal(model.limit.context, 2_000_000, "用户改过的 context 必须保留")
  assert.equal(typeof model.limit.output, "number", "用户没改的 output 不能被吃掉")
})

test("用户自定义 name 保留，不会被改回默认显示名", () => {
  const user = {
    "deepseek-v4-1-flash-261017": { id: "deepseek-v4-1-flash-261017", name: "我的 V4.1 Flash" },
  }
  const merged = mergeModels(defaults, user)
  assert.equal(merged["deepseek-v4-1-flash-261017"].name, "我的 V4.1 Flash")
  assert.equal(merged["deepseek-v4-1-flash-261017"].id, "deepseek-v4-1-flash-261017")
})

// ── 3. staticModels() / providerModels() 可见面不含 main-auto ─────

test("staticModels() 可见 key/id/name 均不含 main-auto；apiId 可以是 main-auto", () => {
  const models = staticModels()
  for (const [key, model] of Object.entries(models)) {
    assert.notEqual(key, "main-auto")
    assert.notEqual(model.id, "main-auto")
    assert.notEqual(model.name, "main-auto")
  }
  assert.ok(
    Object.values(models).some((m) => m.apiId === "main-auto"),
    "apiId 允许是上游槽位名 main-auto",
  )
})

test("providerModels() 可见 key/id/name 均不含 main-auto；api.id 可以是 main-auto", () => {
  const models = providerModels()
  for (const [key, model] of Object.entries(models)) {
    assert.notEqual(key, "main-auto")
    assert.notEqual(model.id, "main-auto")
    assert.notEqual(model.name, "main-auto")
    assert.equal(model.id, model.name, "对外 id 与 name 都应是真实模型名")
  }
  assert.ok(
    Object.values(models).some((m) => m.api?.id === "main-auto"),
    "api.id 允许是上游槽位名 main-auto",
  )
})

// ── 4. 旧数字映射不回归 ──────────────────────────────────────────

test("旧数字下标对象键归一成真实显示名（旧路由不回归）", () => {
  // 旧版把模型表持久化成 {"0":..,"1":..}，且 id 也是数字
  const list = Object.values(defaults)
  const user = Object.fromEntries(
    list.map((m, i) => [String(i), { ...m, id: String(i), name: String(i) }]),
  )
  const merged = mergeModels(defaults, user)
  assert.deepEqual(
    Object.keys(merged).filter((k) => /^\d+$/.test(k)),
    [],
    "输出不应残留纯数字键",
  )
  assert.deepEqual(Object.keys(merged).sort(), defaultKeys)
  assert.equal(merged["deepseek-v4-1-flash-261017"].apiId, "main-auto")
  assert.equal(merged["HY-Vision-2.0-instruct"].apiId, "hunyuan-turbos-vision")
})

test("canonicalModelId / displayModelId 的数字与槽位映射不回归", () => {
  assert.equal(canonicalModelId("0"), "main-auto")
  assert.equal(canonicalModelId("7"), "hunyuan-turbos-vision")
  assert.equal(canonicalModelId("deepseek-v4-1-flash-261017"), "main-auto")
  assert.equal(displayModelId("main-auto"), "deepseek-v4-1-flash-261017")
  assert.equal(displayModelId("deepseek-v4-1-flash-261017"), "deepseek-v4-1-flash-261017")
})

// ── 推理挡位：metadata 必须声明，否则 DSH / Codex 的选择器会缺项 ──────────
//
// 2026-11-15：DSH 接入页给 DeepSeek 的挡位映射就是 low / high / max
// （对比 workbuddy 的 `reasoningEfforts: {off, low, high, max}`）。插件不声明
// `variants` 时，Magpie 只能落到客户端默认值 —— DSH 里 Marvis 的 4.1f 条目
// 直接没有这组挡位，Codex 目录则生成 low/medium/high/ultra（缺 max）。
// 直打上游实测：low / high / max 三挡都 200，且推理 token 随挡位递增。

test("DeepSeek 两条 4.1f 条目声明 low/high/max 三挡（config 形状）", () => {
  for (const slot of ["main-auto", "deepseek-v4-pro-external"]) {
    const name = DISPLAY_BY_SLOT[slot]
    const model = defaults[name]
    assert.ok(model, `缺少模型：${name}`)
    assert.deepEqual(Object.keys(model.variants).sort(), ["high", "low", "max"])
    for (const effort of ["low", "high", "max"]) {
      assert.equal(model.variants[effort].reasoningEffort, effort, `${name} 的 ${effort} 要映射到自身`)
    }
  }
})

test("DeepSeek 两条 4.1f 条目在 provider.models 里也带 variants（Codex 目录来源）", () => {
  const models = providerModels()
  for (const slot of ["main-auto", "deepseek-v4-pro-external"]) {
    const name = DISPLAY_BY_SLOT[slot]
    assert.deepEqual(Object.keys(models[name].variants).sort(), ["high", "low", "max"])
  }
})

test("非推理模型不凭空声明 variants", () => {
  assert.equal(defaults["HY-Vision-2.0-instruct"].variants, undefined)
  assert.equal(providerModels()["HY-Vision-2.0-instruct"].variants, undefined)
})

// ─────────────────────────────────────────────────────────────
// 自查探针的「应该服务哪个上游模型」（issue #43）
//
// 显示名里有**我们加的后缀**（`-antidowngrade`），上游回的 model 从来没有它。
// 探针若直接拿 DISPLAY_BY_SLOT 比，会把正常的号全判成「被降级」—— 这条锁住那个错误。
// ─────────────────────────────────────────────────────────────

test("expectedServedModel：剥掉我们加的显示后缀，未知槽位原样返回", () => {
  assert.equal(expectedServedModel("main-auto"), "deepseek-v4-1-flash-261017")
  // 本 fork 的实测值：该槽位回 `deepseek-v4-flash-ga-260731`，不是 4.1f（三个账号 × 三轮测过）
  assert.equal(expectedServedModel("deepseek-v4-pro-external"), "deepseek-v4-flash-ga-260731")
  assert.equal(expectedServedModel("hy3-preview-agent"), "deepseek-v4-flash-ga-260731", "真实模型名原样保留")
  assert.equal(expectedServedModel("not-a-slot"), "not-a-slot")
})
