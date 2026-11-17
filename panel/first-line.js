// 首行文本面板（magpie.panels，slot: provider）
//
// 一行：标签 · 当前值 · 「设置…」按钮；点按钮弹出原生 <dialog>，里面是输入框 + 取消/保存。
// 开关是 magpie 原生渲染的（`auth.options`，只支持布尔），文本没有原生控件，所以走面板。
//
// ⚠ options.set 是**整份替换**（一秒最多一次）：
//   每次都要把读到的 opts 展开再写回，否则会把别的键抹掉。只在按「保存」时写一次。

(async () => {
  const FALLBACK = "You are a helpful assistant."
  const $ = (id) => document.getElementById(id)
  const row = $("value")
  const dlg = $("dlg")
  const form = $("form")
  const input = $("text")
  const saved = $("saved")

  const STRINGS = {
    zh: {
      label: "首行文本",
      open: "设置…",
      title: "首行文本",
      hint: "「每个请求都改写首行」打开时，system 提示词的第一行会换成下面这句。",
      note: `留空 = ${FALLBACK}（不含任何 agent 产品名）`,
      empty: "（内置兜底句）",
      cancel: "取消",
      save: "保存",
      done: "已保存 · 下一个请求起生效",
      fail: "保存失败：",
      readFail: "读数失败，先按默认显示：",
    },
    en: {
      label: "First line",
      open: "Edit…",
      title: "First line text",
      hint: "With “every request” on, the system prompt's first line becomes this one.",
      note: `Empty = ${FALLBACK} (no agent product name in it)`,
      empty: "(the built-in fallback)",
      cancel: "Cancel",
      save: "Save",
      done: "Saved · takes effect on the next request",
      fail: "Could not save: ",
      readFail: "Could not read the options; showing defaults: ",
    },
  }

  await magpie.ready

  const lang = String(magpie.theme?.lang || document.documentElement.lang || "en").toLowerCase()
  const t = STRINGS[lang.startsWith("zh") ? "zh" : "en"]
  $("label").textContent = t.label
  $("open").textContent = t.open
  $("title").textContent = t.title
  $("text-label") && ($("text-label").textContent = t.label)
  $("hint").textContent = t.hint
  $("fallback-note").textContent = t.note
  $("cancel").textContent = t.cancel
  $("save").textContent = t.save
  input.placeholder = FALLBACK

  /** 读到的整份选项 —— 写回时必须原样带上 */
  let opts = {}

  const readOpts = async () => {
    try {
      const got = await magpie.options.get()
      if (got && typeof got === "object" && !Array.isArray(got)) opts = got
    } catch (err) {
      saved.textContent = t.readFail + (err?.message || err)
    }
    return opts
  }

  // 插件选项里就一个键，键名就是给人看的字段名（loader 里同名字符串）
  const KEY = "提示词首行替换"
  const firstLineOf = (o) => (o.firstLine && typeof o.firstLine === "object" ? o.firstLine : {})
  const textOf = (o) => {
    const v = typeof o[KEY] === "string" ? o[KEY] : typeof o.text === "string" ? o.text : firstLineOf(o).text
    return typeof v === "string" ? v : ""
  }

  const paint = () => {
    const v = textOf(opts)
    row.textContent = v || t.empty
    row.title = v || ""
  }

  await readOpts()
  paint()

  const open = async () => {
    // 每次打开都重新读一次：别的窗口/CLI 可能刚改过
    await readOpts()
    paint()
    input.value = textOf(opts)
    saved.textContent = ""
    if (typeof dlg.showModal === "function") {
      dlg.showModal()
      input.focus()
      input.select()
    } else {
      // 老 WebKit 没有 <dialog>：退化成原地展开，仍然是输入框 + 保存
      dlg.setAttribute("open", "")
      input.focus()
    }
  }

  $("open").addEventListener("click", open)

  form.addEventListener("submit", async (ev) => {
    const action = ev.submitter?.value || "cancel"
    ev.preventDefault()
    if (action !== "save") {
      if (typeof dlg.close === "function") dlg.close()
      else dlg.removeAttribute("open")
      return
    }
    // 写回一个键；老形状（text / firstLine）一并收掉，不留下两份文本
    const { firstLine: _legacy, text: _old, ...rest } = opts
    const next = { ...rest, [KEY]: input.value }
    try {
      const back = await magpie.options.set(next)
      opts = back && typeof back === "object" && !Array.isArray(back) ? back : next
      paint()
      saved.textContent = t.done
      if (typeof dlg.close === "function") dlg.close()
      else dlg.removeAttribute("open")
    } catch (err) {
      saved.textContent = t.fail + (err?.message || err)
    }
  })

  // 点背景关掉（dialog 的默认行为是点遮罩不关）
  dlg.addEventListener("click", (ev) => {
    if (ev.target === dlg) dlg.close?.()
  })
})()
