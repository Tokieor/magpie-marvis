// tests/plugin-options.test.mjs —— provider 卡片上那些开关的契约锁
//
// 机制（magpie 源码 internal/plugin/host.js 的 `optionsOf`，上游 #2038）：
//   插件在 auth 对象上声明 `options: [{key, label, description?, default?, confirm?,
//   labels?, descriptions?, confirms?, filtersModels?}]`，magpie 在**供应商编辑器**里
//   每条画一行 Off/On，用户点一下立刻保存，插件用 `input.magpie.option(provider, key)` 读。
//
// 失败方式是静默的：magpie 对每条做校验，**不合格就整条丢掉**，卡片上什么都不显示、
// 也没有任何报错。所以这里按它的规则把形状锁住：
//   · key 必须 /^[a-z0-9_-]{1,40}$/，重复的只留第一条
//   · label 必填且 ≤60 字符（trim 后）；description ≤300
//   · default 必须是布尔（`o.default === true` 才算开）
//   · 多语言写在 labels / descriptions / confirms 里，label 本身必须留着（老版本只读它）
//   · 最多 16 条
//   · `placement: "top"` → 画在账号下面、路由上面（magpie #5269）；不写就排在模型之后

import test from "node:test"
import assert from "node:assert/strict"

import { PLUGIN_OPTIONS } from "../src/context.mjs"
import { authHooks } from "../src/auth.mjs"

const OPTION_KEY = /^[a-z0-9_-]{1,40}$/
const MAX_OPTIONS = 16

test("auth.options 里确实带着这两个开关（卡片上才有一行可点）", () => {
  const auth = authHooks({}, {})
  assert.ok(Array.isArray(auth.options), "auth.options 必须是数组，否则 magpie 一个开关都不画")
  const keys = auth.options.map((o) => o.key)
  assert.deepEqual(keys, ["first_line_fallback", "first_line_always"])
  assert.equal(PLUGIN_OPTIONS, auth.options, "同一份声明，别在别处再抄一遍")
})

test("每条开关都符合 magpie 的校验规则（不合格会被静默丢掉）", () => {
  assert.ok(PLUGIN_OPTIONS.length <= MAX_OPTIONS, `最多 ${MAX_OPTIONS} 条`)
  const seen = new Set()
  for (const o of PLUGIN_OPTIONS) {
    assert.match(o.key, OPTION_KEY, `key 不合格会被丢掉：${o.key}`)
    assert.ok(!seen.has(o.key), `key 重复只留第一条：${o.key}`)
    seen.add(o.key)
    assert.equal(typeof o.label, "string")
    assert.ok(o.label.trim().length > 0 && o.label.trim().length <= 60, "label 必填且 ≤60 字符")
    if (o.description !== undefined) {
      assert.ok(o.description.length <= 300, "description ≤300 字符")
    }
    if (o.default !== undefined) {
      assert.equal(typeof o.default, "boolean", "default 必须是布尔，magpie 只认 === true")
    }
    for (const field of ["labels", "descriptions", "confirms"]) {
      if (o[field] === undefined) continue
      assert.ok(o[field] && typeof o[field] === "object" && !Array.isArray(o[field]), `${field} 必须是对象`)
      for (const [lang, words] of Object.entries(o[field])) {
        assert.ok(lang.trim() && lang.length <= 16, `${field} 的语言码不合格：${lang}`)
        assert.ok(typeof words === "string" && words.trim(), `${field}.${lang} 不能是空串（会被丢）`)
        // magpie 的 inLanguages(o.labels, 60)：每条译文也按 label 的上限截断，超了整条译文被丢
        if (field === "labels") assert.ok(words.trim().length <= 60, `labels.${lang} 超过 60 字符会被丢`)
      }
    }
  }
})

test("中文用户看得懂：每个开关都有 zh 的 label", () => {
  for (const o of PLUGIN_OPTIONS) {
    assert.ok(o.labels?.zh, `${o.key} 缺 labels.zh`)
    assert.ok(o.labels.zh.trim().length <= 60, `${o.key} 的 labels.zh 超过 60 字符会被丢`)
  }
})

test("一条开关只占一行：不写 description（多一行就会压到「模型」区块上）", () => {
  // magpie 的 .plugin-options 是 flex 的 .stack，但每个选项只预留一行的高度：
  // 有 description 就多画一行，那一行会压在下一个 field（模型列表）上。
  // 插件的渲染改不了，能改的只有「一条只占一行」—— 说明写进 label。
  for (const o of PLUGIN_OPTIONS) {
    assert.equal(o.description, undefined, `${o.key} 写了 description，会多一行压到模型区块上`)
    assert.equal(o.descriptions, undefined, `${o.key} 写了 descriptions，会多一行压到模型区块上`)
  }
})

test("两个开关都要置顶（placement: \"top\"）—— 排在路由/模型之后等于找不到", () => {
  for (const o of PLUGIN_OPTIONS) {
    assert.equal(o.placement, "top", `${o.key} 缺 placement: "top"，会被画在模型之后`)
  }
})

test("默认值就是「被拦才兜底」：fallback 开、always 关", () => {
  const byKey = Object.fromEntries(PLUGIN_OPTIONS.map((o) => [o.key, o]))
  assert.equal(byKey.first_line_fallback.default, true, "默认要能在没配置时救回 403")
  assert.equal(byKey.first_line_always.default, false, "默认不能改写所有请求")
  assert.ok(byKey.first_line_always.confirm, "always 会改掉每个请求，值得一次二次确认")
})
