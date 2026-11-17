# 更新记录

## 0.2.52 — 2026-11-17

**并入上游 0.2.38 – 0.2.51（身份句改写整条链路重做）+ 保留本 fork 的三处独立修复**

- 并入上游：身份句改写从「正则形状匹配」改成**整句白名单**（只换主流客户端的默认首句，
  用户自己改过的首句一个字节都不动 —— 不跟用户的修改打架，前缀也稳定，上游前缀缓存照常命中）；
  新增 `firstLine` 兜底 —— 被 403 拦下时换一句不含产品名的首行**重试一次**，以及「每个请求都换」
  的强制模式；两个开关由 magpie 原生渲染在供应商卡片里（`auth.options` + `placement: "top"`），
  改完不用重启；首行文本在「设置 → 插件 → 选项」里改，键名就是中文 `提示词首行替换`
- 并入上游：`scripts/probe-served-model.mjs` 降级自查探针；`deepseek-v4-pro-external` 补 `vision`；
  DNS 记录里混 `0.0.0.0` 时只要有公网记录就放行（issue #34）
- ⚠ **本 fork 保留 ①**：`Marvis-Scene` 仍固定 `chat` / `main_agent`。上游到 0.2.51 还在用
  `preload_summary` / `auto_discovery` —— 那个场景只放行腾讯自家的 deepseek / hunyuan，
  `claude-sonnet-4-6` / `claude-opus-4-6` / `gpt-5.4` 会一律回 `4130001 无效模型id`
  （上游把「场景不放行」和「模型不存在」共用一个码，所以看起来像模型下线）。本 fork 0.2.27 起已改
- ⚠ **本 fork 保留 ②**：白名单里补 **OpenCode**（`You are an AI agent running in OpenCode, …`
  → `You are an AI agent, running in OpenCode, …`，实测 403 → 200）。上游 11 条白名单里没有它 ——
  这正是本 fork 最初要解决的问题
- ⚠ **本 fork 保留 ③**：局域网扫码登录（`src/marvis/relay.mjs`，NAS / Docker / 无浏览器环境用），
  上游没有这个功能；图片 SSRF 预检的 `MAGPIE_MARVIS_ALLOW_PRIVATE_IMAGE_HOSTS=1` 开关同样保留
- 显示名再改一次：`deepseek-v4-pro-external` → `deepseek-v4-flash-ga-260731-proexternal`。
  上游 0.2.36 把该槽位写成 `deepseek-v4-1-flash-261017-antidowngrade`（称实测回 4.1f），
  但本机三个 QQ 账号 × 三轮实测（11-15 / 11-16 / 11-17）回的一直是 `deepseek-v4-flash-ga-260731`
  且不带推理。同时按 issue #15 去掉空格与括号 —— 显示名带空白 / 非 ASCII 会让 VS Code Copilot
  卡在回复阶段。四种历史写法全部保留归一
- 版本号说明：本 fork 的 0.2.38 / 0.2.39 与上游同号但内容不同，CHANGELOG 里标成「（fork 侧）」，
  本条起与上游错开（上游 0.2.51 → 本 fork 0.2.52）
- 验收：测试 207 项中 203 通过、4 项因未注入 live 凭据跳过；合规检查 42 项全过；
  网关实测 OpenCode / DSH / Codex / Claude 四种身份句首行全部 200，`claude-opus-4-6` 等非腾讯模型可选中

## 0.2.51 — 2026-11-17

**改（选项的键名换成中文：`提示词首行替换`）**

- 那个键是我们自己起的名字（magpie 只要求选项的值是一个对象），所以直接改成中文：
  `{ "提示词首行替换": "You are a helpful assistant." }` —— 设置 → 插件 → 本插件「选项」框里
  看到的就是这一句，把引号里换成自己的话、保存即可，不用猜 `text` 是什么
- 默认值仍然写在这（示例即默认）；老版本存过的 `{"text": …}`（0.2.50）与
  `{"firstLine": {"text": …}}`（≤0.2.49）继续读，不用手动迁移
- 面板写回同一个键，并顺手收掉老的 `text` / `firstLine`

## 0.2.50 — 2026-11-17

**改（首行文本改成在「设置 → 插件」那一行的选项框里改：一个键 `text`，默认值就写在那）**

- 插件选项从 `{ "firstLine": { "mode": "blocked", "text": "" } }` 瘦成一个键：`{ "text": "You are a helpful assistant." }`
  —— 那个框是 magpie 的通用 JSON 编辑器（值必须是对象，写字符串会被拒），键越少越好改；
  示例就是**默认值**，点「选项」看到的那句就是要用的那句，把引号里换成自己的话、保存即可
- loader 优先读 `options.text`；老版本存下的 `{ "firstLine": { "text": … } }` 继续读（不用手动迁移）
- `mode` 不再写进 JSON：改不改由卡片上那两个开关决定（`first_line_fallback` / `first_line_always`）
- 面板（供应商编辑器里的「首行文本」）同步读写 `text`，保存时把老的 `firstLine` 键收掉
- 开关的 label 加长到 43 字：magpie 的选项行按内容宽度排，太短整行会缩到中间

## 0.2.49 — 2026-11-17

**修复（选项的第二行还是压到「模型」上：一条开关只能占一行）**

- 两条开关的 `description` 全部删掉，说明并进 `label`（≤60 字符）。magpie 的 `.plugin-options`
  是 flex 的 `.stack`，但每个选项**只预留一行高度**：多画一行 description，那一行就压到下一个
  field（模型列表）上 —— 0.2.47 / 0.2.48 的两次缩短都只是把溢出变短，没消除
- 插件的渲染改不了（`pluginOptionsField` 在 magpie 里），能改的只有「一条只占一行」
- 用例改成锁这条：任一开关出现 `description` / `descriptions` 就失败

## 0.2.48 — 2026-11-17

**修复（说明文字压到模型行）+ 改版（首行文本：点按钮弹输入框）**

- 两条开关的 `description` 缩短到**一行画得完**（zh ≤48 字符、en ≤120）：magpie 按一行算行高，
  第二行不会撑高，会直接压在下面的「模型」区块上（实测截图）。用例加了这条上限防回归。
- 首行文本面板改成**一行 + 按钮**：`首行文本  当前值  [设置…]`，点「设置…」弹出原生 `<dialog>`，
  里面是输入框和「取消 / 保存」两个按钮；保存时才写一次 `firstLine.text`（`options.set` 是整份替换、
  一秒最多一次，仍然整份展开写回）。面板本身只有一行高，不再把编辑器撑高。
- 面板用例同步：写回挂在「保存」按钮的 submit 上，禁止边打字边写（原来是 1.2s 防抖）。

## 0.2.47 — 2026-11-17

**修复（开关没置顶：漏了 `placement: "top"`）**

- 我上一版说「插件侧无法置顶」是**错的**：magpie 早就支持 `auth.options[i].placement: "top"`，
  写了就画在**账号下面、路由上面**（magpie 仓库 issue 5269；渲染侧 `pluginOptionsField(sub, top)`
  按 `o.placement === "top"` 分组，Go 侧字段 `json:"placement,omitempty"`）
- 两条开关（`first_line_fallback` / `first_line_always`）都加上 `placement: "top"`
- README 更正对应的错误说法；用例加一条断言「每条都必须 top」，防止以后新增开关漏掉
- ⚠ 面板（首行文本输入框）**没有**位置字段，仍只能追加在编辑器末尾 —— 想让输入框也置顶需要上游支持
- 验收：测试 185 项中 181 通过、4 项因未注入 live 凭据跳过；合规检查 42 项全过

## 0.2.46 — 2026-11-17

**新增（首行文本的输入框：供应商卡片里的面板）**

- 开关已经由 magpie 原生渲染（`auth.options`，只支持布尔）；**文本没有原生控件**，
  所以补一个 `magpie.panels`（slot: provider）面板：一个输入框 + 回车/失焦自动保存，
  写的是同一份 `firstLine.text`，与「每个请求都改写首行」开关配套
- 位置由 magpie 决定：`app.js` 里 `ed.append(slot)` 在**编辑器末尾、取消/保存之上**，
  开关那两行在它的上方（`pluginOptionsField` 固定插在「高级」之前）—— 两者都无法置顶
- 面板只在 provider 编辑器里出现；`options.set` 是整份替换 + 一秒最多一次，
  所以写回展开读到的整份 opts，输入防抖 1.2s
- 新增 `tests/panel-manifest.test.mjs`（5 项）：清单形状 / files 白名单带面板文件（漏了就是空白）/
  必须加载 bridge 且用 options.get+set / 写回保留别的键 / 面板不许自己 fetch
- 验收：测试 184 项中 180 通过、4 项因未注入 live 凭据跳过；合规检查 42 项全过；
  `npm pack --dry-run` 里能看到 `panel/first-line.{html,js,css}`

## 0.2.45 — 2026-11-17

**修复（开关放错层：0.2.44 的 provider 面板换成 magpie 自带的 `auth.options` 开关）**

- 0.2.44 用 `magpie.panels` 在供应商编辑器里开了个 iframe 面板 —— 机制没写错，但对这件事是**绕远路**：
  面板清单要窗口重载才刷新，装完看不出变化；而且它要维护一套 HTML/JS。
- magpie 本来就有这个扩展点（`auth.options`，#2038，`internal/plugin/host.js` 的 `optionsOf`）：
  插件声明 `{key, label, description?, default?, confirm?, labels?, descriptions?, confirms?}`，
  magpie 在**供应商编辑器**里每条画一行 Off/On，点一下立刻保存，插件用
  `input.magpie.option("marvis", key)` 现读 —— **不用重启、不用窗口重载**
- 两个开关：`first_line_fallback`（默认开，被 403 拦下时换兜底句重试一次）、
  `first_line_always`（默认关，每个请求都改写；开了先弹一次确认）
- 自定义首行文本仍在插件选项 JSON 里（`firstLine.text`，留空 = 内置兜底句）
- 删掉 `magpie.panels` / `panel/*` / 对应的 4 个面板用例；新增 `tests/plugin-options.test.mjs`（4 项），
  按 magpie 的校验规则锁住开关形状（key 正则、label ≤60、default 布尔、zh 文案、最多 16 条）
- 验收：测试 179 项中 175 通过、4 项因未注入 live 凭据跳过；合规检查 42 项全过

## 0.2.44 — 2026-11-17

**新增（provider 编辑器里的「首行改写」面板：开关 + 输入框，不用手写 JSON）**

- `magpie.panels` 声明一个 `provider` 槽的面板（`panel/first-line.html`），它会出现在**每个 provider 编辑器**里：
  一个 `mode` 下拉（off / blocked / always）+ 一个「首行文本」输入框，改完自动保存
- 面板通过 `_magpie/bridge.js` 的 `magpie.options.get()/.set()` 读写**本插件自己的**选项 ——
  与 JSON 编辑框改的是同一份 `firstLine`，两条路等价
- `options.set` 是整份替换 + 一秒最多一次：写回时展开读到的整份 opts（不抹掉别的键），输入防抖 1.2s
- 新增 `tests/panel-manifest.test.mjs`（4 项）：面板清单形状 / `files` 白名单里必须带面板文件（漏了就是一块空白）/
  provider 槽必须走 bridge 且覆盖三档 / 写回必须保留别的键
- 验收：测试 179 项中 175 通过、4 项因未注入 live 凭据跳过；合规检查 42 项全过；
  `npm pack --dry-run` 里能看到 `panel/first-line.{html,js,css}`

## 0.2.43 — 2026-11-17

**新增（降级自查探针）+ 文档更正（降级落点不是固定值）**

- `node scripts/probe-served-model.mjs`：绕开 magpie、用插件自己的 `llmHeaders()` 直连上游，
  逐账号打印 `main-auto` / 防降级槽位的**实际服务模型**；有账号与声明不一致时退出码 2。
  只读本机账号文件、不写任何配置，供应商关着也能跑（issue #43 的建议 3）
- 文档更正：被改路由的号会落到**某个旧快照**，而旧快照的名字**不固定** ——
  已知出现过 `deepseek-v4-flash-ga-260731`（#13）与 `deepseek-v4-flash-202605`（#43）。
  #15 里把落点写成固定值的那句不再成立；判定只认响应体里的 `model`
- 新增 `expectedServedModel()`：比之前先剥掉我们自己的 `-antidowngrade` 显示后缀 ——
  第一版探针直接拿显示名比，把 4 个正常账号全判成「被降级」（实测踩到的坑，用用例锁住）
- 新增 1 个用例；README 增加「你的号被降级了没有」一节
- 验收：测试 175 项中 171 通过、4 项因未注入 live 凭据跳过；合规检查 42 项全过；
  本机 4 账号 × 2 槽位实跑 8/8 与声明一致

## 0.2.42 — 2026-11-17

**新增（首行兜底开关：`firstLine.mode` / `firstLine.text`）**

- 整句白名单只覆盖「已知客户端的默认首句」；用户改过的首句、新客户端、没见过的写法仍然 403。
  新增插件选项（设置页里的 JSON）：`{"firstLine": {"mode": "blocked", "text": ""}}`
  - `off`：只走白名单（等于 0.2.41 的行为）
  - `blocked`（默认）：先按原样发；被 403「非法请求」拦下时，把 system 首行换成兜底句**重试一次**
  - `always`：每个请求都把首行换成 `text`（优先级高于白名单，适合「提示词根本改不了」的客户端）
- `text` 留空 = 内置兜底 `You are a helpful assistant.`（不含任何 agent 产品名，实测 200）；
  选项写坏（未知 mode / 非字符串 / 整个 options 是坏 JSON）一律退回默认，绝不让请求失败
- 重试**每次重新签 uskey** —— 它是一次性的，复用会直接撞风控，看起来像另一类故障
- 只换 system 消息的**第一行**，第二行起原样；没有 system 消息就不重试（不凭空插一条）
- 新增 5 个用例：默认 retry（两次都被拦仍给诊断）/ retry 成功直通 200 / off 不重试 /
  always 直改且优先于白名单 / 选项写坏退回默认
- 验收：测试 174 项中 170 通过、4 项因未注入 live 凭据跳过；合规检查 42 项全过

## 0.2.41 — 2026-11-17

**变更（身份句改写：正则形状匹配 → 整句白名单）**

- 只对**主流客户端的默认首句**做整句替换（表里 11 条，逐条实测 403 → 200）；
  **用户自己改过的首句一个字节都不动** —— 不跟用户的修改打架，也不可能被二次改写
- 前缀稳定：同一客户端每次替换结果相同 ⇒ 上游前缀缓存照常命中。
  正则那种「形状像就改」在用户微调首句后仍然改写，前缀反复变、缓存反复失效（本次要解决的问题之一）
- 中文身份句实测原样就 200 ⇒ 从改写表移除（之前会做无谓的连字符替换，纯属让前缀变化）
- 403 文案改口径：默认首句走白名单自动换；改过首句的请求不动，仍被拦就把 system 首行贴出来加一行
- 新增 4 个用例：改过的首句不动 / 整句精确匹配（大小写、改词都不动）/ 句末标点归一 / 只替换第一句
- 验收：测试 169 项中 165 通过、4 项因未注入 live 凭据跳过；合规检查 42 项全过

## 0.2.40 — 2026-11-17

**修复（Claude / Codex 的改写规则已经变成空转：产物照样 403）**

- 2026-11-17 复测 0.2.32 起的连字符改写产物：`You are Claude-Code, …` /
  `You are a coding agent running in the Codex-CLI, …` **仍然 403** —— 规则在跑，
  改完上游照样拦，用户看到的现象和没装插件一样（issue #36 / #41 的表里都记着）
- 上游认的是**第一句的形状**：`You are <产品名>` 当主语就拦，插字符不管用；**拆主语**才放行。
  实测（同一分钟、只换 system 首行）：`You are a coding agent, running in the Codex CLI, …` → 200、
  `You are an agent, Claude Code, …` → 200、`You are an agent, Claude-Code, …` → 200、
  `You are an agent, Claude.` → 200
- 改写改成「插一个逗号 + 泛指名词」：**名字一个字符都不删**，模型仍然知道自己是哪个客户端；
  老形态（`Codex-CLI` / `Claude-Code` / 裸 `You are Claude.`）继续被救回来
- 新增 2 个用例（老形态救回 / 幂等），改写产物与用例期望一起更新
- 验收：测试 166 项中 162 通过、4 项因未注入 live 凭据跳过；合规检查 42 项全过

## 0.2.39（fork 侧） — 2026-11-16

**修复（0.2.38 的改写思路已失效：上游改成按「词对」判指纹）**

- 0.2.38 照抄上游的做法是往词中间插连字符（`Claude Code`→`Claude-Code`）。2026-11-16 复测：
  `Claude-Code` / `DeepSeek-Harness` / `Codex-CLI` 全部**仍然 403**，只有 OpenCode 那条换实词的规则生效
- 重新实测判据：`You are` 紧邻产品名、`powered by` + `DeepSeek`、`running in` + 产品名 三类**词对**。
  改判据后改成「换实词」，五条规则逐条用真账号验证 403 → 200：
  `You are`→`You're`、`powered by`→`built on`、`running in the Codex`→`working in the Codex`、
  `running in OpenCode`→`working in OpenCode`、中文那句改成 `DeepSeek-Harness`（中文现已不拦，留着兜底）
- 顺带删掉 `loader.mjs` 里 `normalizeMessages` 的**重复调用块**（0.2.38 合并上游时的冲突残留，
  同一批消息会被归一两次）
- 验收：测试 182 项中 178 通过、4 项因未注入 live 凭据跳过；合规检查 42 项全过；
  网关实测 OpenCode / DSH / Codex / Claude 四种身份句首行全部 200

## 0.2.39 — 2026-11-17

**修复（ZCode 的身份句没被覆盖，整个客户端 403）**

- 2026-11-17 实测（同一分钟、只换 system 首行）：`You are ZCode, …` / `You are ZCode.` → 403，
  `You are Z-Code, …` → 200，`You are Zed, …` / `You are a helpful assistant.` → 200
  —— 这条的判据仍是字面量 `ZCode`，插连字符有效（**与 0.2.38 那条 DSH 的结论不是一回事**，别混）
- `IDENTITY_PHRASES` 补 `You are ZCode → You are Z-Code`，`IDENTITY_PHRASE_TEST` 同步补
  `You are\s+ZCode\b`；ZCode 的系统提示词**不可配置**，插件不改写就等于这个客户端完全不能用（issue #38）
- 403 文案改成「常见身份句插件已自动改写；仍被拦说明这句还没覆盖，把首行带到群里」——
  原来只教 `powered by → running in`，对 ZCode 这类提示词改不动的客户端是空建议
- 新增 4 个用例：长短两种 ZCode 写法改写 / 无关首句不误伤 / 已写成 `Z-Code` 不再动 / 诊断与改写同集合
- 验收：测试 165 项中 161 通过、4 项因未注入 live 凭据跳过；合规检查 42 项全过

## 0.2.38（fork 侧） — 2026-11-16

**修复（OpenCode 2 的 system prompt 被上游当内容指纹，每轮 403）**

- 现象：用 OpenCode 2 接本插件，每轮都回 `403 非法请求`，插件只能提示「上游内容过滤拦截」。
  根因是上游把 agent 身份句当指纹：`You are an AI agent running in OpenCode, a coding agent harness.`
  直打上游实测 403（大小写 / 词间空格都不敏感，句子跨行也拦）；同一句放到第 2 行就是 200
- 作者给的办法是去改 `opencode.exe` 里的字节（三份副本，UTF-8 ×2 + UTF-16LE ×1）。本 fork 在
  **请求体这一层**改：loader 把首行里的 `running` 换成同义的 `working`（等长、句意不变、实测 200），
  其余字节一个不动 —— 对任何客户端、任何系统都生效，不用动二进制，也不用改客户端配置
- 顺带把上游 0.2.24–0.2.37 全部并入：Codex / Claude Desktop / 中文身份句改写、403 统一指路、
  `deepseek-v4-pro-external` 补 `vision`、DNS 里混 `0.0.0.0` 时放行、DeepSeek 两条 4.1f 补 low/high/max 挡位
- ⚠ 本 fork 仍**不采纳**上游把 `deepseek-v4-pro-external` 改名成 `deepseek-v4-1-flash-261017-…`：
  2026-11-16 复测该槽位回的仍是 `deepseek-v4-flash-ga-260731`（不带推理）。但按上游 issue #15，
  显示名改成纯 ASCII：`deepseek-v4-flash-ga-260731 (pro-external slot)`，旧名继续归一
- 验收：测试 182 项中 178 通过、4 项因未注入 live 凭据跳过；合规检查 42 项全过

## 0.2.38 — 2026-11-16

**修复（连字符形态失效，改成换句式；报错文案写明根因与修法）**

- 2026-11-16 实测：`DeepSeek-Harness` / `Claude-Code` 这些**连字符形态也被拦了** ——
  上游把判据从「词对之间插字符就不认」收紧成「`You are an AI agent` + `DeepSeek`」，插字符不再管用
- 改写改成**换句式**：`powered by` → `running in`（等长、语义不变），
  `You are an AI agent running in DeepSeek Harness.` 实测 200；倒装/`inside` 也放行
- 报错文案写明**根因与修法**：「系统提示词首句被当成身份指纹（不是密钥或登录问题）」+ 具体改法
  + QQ 群 451129479，让用户那边的 agent 看了报错就能自己动手修
- 验收：测试 162 项中 158 通过、4 项因未注入 live 凭据跳过；合规检查 42 项全过

## 0.2.37 — 2026-11-16

**修复（URL 图片：DNS 里混一条 0.0.0.0 就把整个域名拒掉）**

- `assertPublicHttpUrl()` 原来对 DNS 记录**逐条否决** —— 开了 DNS 过滤 / sinkhole 的机器上，
  `cdn.jsdelivr.net` 会解析成「3 条 Cloudflare IPv6 + 2 条 `0.0.0.0`」，于是整条外链图被拦
  （issue #34：curl 走 IPv6 取图 200，插件回 `400 invalid_image`）
- 改成：**只要还有一条公网记录就放行**，一条不剩才拒；字面 IP 那条分支仍然严格拒绝，SSRF 面不变
- 新增 2 个用例：混合记录（IPv6 + `0.0.0.0`）放行 / 全保留地址仍拒
- 验收：测试 162 项中 158 通过、4 项因未注入 live 凭据跳过；合规检查 42 项全过

## 0.2.36 — 2026-11-16

**修复（`deepseek-v4-pro-external` 漏了识图能力声明）**

- 该槽位上游回的是 `deepseek-v4-1-flash-261017`，与 `main-auto` 同一个模型；0.2.26 给 `main-auto`
  补了 `vision: true`，这条漏了 —— 结果选中它时 `attachment` / `modalities.input` 全为假，传不了图
  （贡献：@xxhhlk，PR #32）
- 作者实测：两个槽位对同一张带字 PNG 都读出 `MAGPIE-VISION-TEST 42`
- 验收：测试 160 项中 156 通过、4 项因未注入 live 凭据跳过；合规检查 42 项全过

## 0.2.35 — 2026-11-15

**修复（403 一律指引到群，不再按指纹判定）**

- 报错分流从「命中已知身份句才算内容过滤」改成「**403 + 非法请求就给统一提示**」
- 理由：上游指纹在持续扩大（英文 → 中文 → 还没见过的写法），按指纹判定永远漏
  —— 0.2.34 刚给中文补了一条规则，下一版还会有别的。而 403 + 这个组合目前只出现在
  内容过滤上（模型无权限是 400「无效模型id」）
- **改写仍按指纹精确执行**（避免改无关内容），只有**诊断**放宽：宁可多给一句「进群」，
  也不把人甩回宿主那句「API 密钥无效」
- 验收：测试 160 项中 156 通过、4 项因未注入 live 凭据跳过；合规检查 42 项全过

## 0.2.34 — 2026-11-16

**修复（中文 / 本地化身份句既不自动改写、也不给诊断）**

- 触发：system 首行是中文身份句（如 `你是一个由 DeepSeek Harness 驱动的 AI 智能体。`）时，上游同样回
  403 `4100406 非法请求`；但 0.2.29 起的三条改写规则都是英文整句模板，中文一句都不匹配 ——
  于是既不自动改写（用户照旧撞墙），也不进 `content_filtered` 诊断（宿主照旧显示「API 密钥无效」）
- 判据统一成「system 首行 + 词对 + 单个空格」：改写与诊断共用同一个集合，中文规则一并补上；
  顺带补上 Codex 身份句的诊断分支（此前只有 DSH 与 Claude 两条），改写限定在 system 角色的第一行
- 验收：`node --test` 157 项全过（新增 5 项：中文改写 / 中文诊断 / 非首行与 user 角色零改动 /
  全小写与句末叹号 / Codex 诊断）

## 0.2.33 — 2026-11-15

**修复（内容过滤的报错改成一句话，并指向 QQ 群）**

- 文案从两段式（点名 `You are an AI agent powered by DeepSeek Harness.` / `You are Claude Code…`）
  改成统一一句：**「上游内容过滤拦截（非密钥或登录问题），修复方法见 QQ 群 451129479。」**
- 为什么不点名具体 agent：被拦的可能是很多家，写死一家会在别家命中时把人带偏；而且 0.2.32 起
  身份句已在本地自动改写，走到报错这一步时已经不能断定就是那两句 —— 原来的说法是推断冒充结论
- 两个 403 分支合并成一个，以后新增指纹不用再加分支
- 验收：测试 156 项中 152 通过、4 项因未注入 live 凭据跳过；合规检查 42 项全过

## 0.2.32 — 2026-11-15

**修复（Codex / Claude Desktop 的新会话 403）+ 补齐 DeepSeek 推理挡位**

- 身份句改写扩到三家：`DeepSeek Harness`、`Codex CLI`、`Claude Code` 都换成连字符形态
  （`DeepSeek-Harness` / `Codex-CLI` / `Claude-Code`）—— 2026-11-15 直打上游实测：
  原句 403「非法请求」，连字符 200；只改身份短语里的一个空格，其余字节不动（贡献：@BangShou1st）
- 背景：Marvis 的内容过滤按「产品身份」定点拦截；新会话会把身份句放在 system prompt 开头，
  老会话续聊不会 —— 所以表现是「老会话能用、新会话全 403」
- DeepSeek 两条 4.1f 条目补 `variants: low/high/max`：不声明时 DSH 接入页的 `reasoningEfforts`
  会缺这组挡位，Codex 目录则生成 low/medium/high/ultra（缺 max）（贡献：@BangShou1st）
- 保留 0.2.31 的兜底诊断：改写生效后若仍 403，错误信息仍会指出命中哪句身份声明
- 验收：测试 158 项中 154 通过、4 项因未注入 live 凭据跳过；合规检查 42 项全过

## 0.2.31 — 2026-11-15

**修复（Claude Code 的身份句被上游拦时，错误信息能指路）**

- 触发：上游 403 + 请求体含 `You are Claude Code, Anthropic's official CLI for Claude.`
  （2026-11-15 实测，错误码 `4100406`，issue #26）
- 命中时返回 `content_filtered` 并给出可执行改写（`Claude Code` → `Claude-Code`，实测放行）；
  **只诊断、不替第三方工具改 prompt** —— 改不改是调用方自己的决定
- 顺带测到：`You are a Claude agent, built on Anthropic's Claude Agent SDK.` 这句**不触发**
- 验收：测试 150 项中 146 通过、4 项因未注入 live 凭据跳过；合规检查 42 项全过

## 0.2.30 — 2026-11-15

**测试（锁住「门禁」语义：只改会被拦的形态，用户已修好的一个字节都不动）**

- 新增用例覆盖三种「用户自己已经修过」的形态：连字符 `DeepSeek-Harness`、破折号 `DeepSeek — Harness`、
  以及整句已被移出 —— 这些都必须**原样发出**
- 背景：0.2.29 的改写用的是精确正则 `(…DeepSeek)\s+(Harness)`，本来就只命中「单个空格」的原始形态；
  但当时没有测试锁住，以后谁放宽正则就会变成「无差别替换」，跟用户自己在 DSH 侧的修复打架
- 验收：测试 149 项中 145 通过、4 项因未注入 live 凭据跳过；合规检查 42 项全过

## 0.2.29 — 2026-11-15

**新增（自动改写会被上游内容过滤拦下的那句 system prompt）**

- 请求体里出现 `You are an AI agent powered by DeepSeek Harness.` 时，自动把两个词之间的空格换成
  连字符（`DeepSeek-Harness`）—— **语义不变，但能过内容过滤**（issue #22 实测：连字符与破折号都放行；
  加在句末的感叹号 / 逗号、双空格、纯小写、后置括号**全都还是 403**）
- 用户**不用改 DSH 配置**：不用关 `includeHarnessIdentity`，也不用动 profile
- 只动这一处，其余消息一个字符都不碰；改写后若仍 403，0.2.28 的诊断文案照旧生效
- 验收：测试 148 项中 144 通过、4 项因未注入 live 凭据跳过；合规检查 42 项全过

## 0.2.28 — 2026-11-15

**并入上游 0.2.23 / 0.2.24（选择性），并修正其中的一处错误结论**

- 并入上游「粘贴回调地址登录」（贡献者 @Yandre97，上游 PR #9）：新增「QQ 登录（粘贴回调地址）」
  「微信登录（粘贴回调地址）」两条路 —— 授权页交给你自己的浏览器，登录完把地址栏那条
  `…marvis_oauth?…&code=…&state=…` 粘回来即可。扫码页打不开（端口没映射 / 防火墙）时的兜底
- 并入上游的**旧显示名归一**机制（`LEGACY_DISPLAY_ALIASES`）：显示名改过之后，用户路由组里
  写的旧名字仍能归一成槽位，不会被原样发给上游变成 `400 无效模型id`
- ⚠ **不采纳**上游把 `deepseek-v4-pro-external` 改名成 `deepseek-v4-1-flash-261017 (防降级)`：
  2026-11-15 用两个 QQ 账号实测，该槽位回的是 `deepseek-v4-flash-ga-260731`（且不带推理），
  不是 4.1f。它的显示名改成本 fork 实测到的真实值 `deepseek-v4-flash-ga-260731 (pro-external slot)`，
  免得又出现「名字写 A、实际跑 B」——那正是 magpie 那条「很可能换成了别的模型」警告的来源
- 该槽位的两个旧名（`deepseek-v4-pro-202606`、`deepseek-v4-1-flash-261017 (防降级)`）都保留归一映射
- 并入上游尚未发布的「图片输入归一」分支（issue #8 后续）：图片 http(s) URL / 裸 base64 /
  Anthropic `{type:"image",source}` 三种输入统一转成 Marvis 要的 `data:image/...;base64`，
  转不了就本地 400（`invalid_image`）—— 之前只有 `vision: true` 声明，URL 形式的附件会原样丢给上游
- 该分支的 SSRF 预检（私网 / 本机 / link-local / CGNAT 一律拦）默认保留，另加开关
  `MAGPIE_MARVIS_ALLOW_PRIVATE_IMAGE_HOSTS=1` 放行局域网图片地址 —— 附件就在 NAS 上时不然传不上去
- 上游到 0.2.24 仍未修 `Marvis-Scene`（claude / gpt 三个模型在他们那儿依旧 4130001），本 fork 的 0.2.27 已修

## 0.2.28 — 2026-11-15

**修复（403「非法请求」时给出能指路的错误，而不是让宿主显示「API 密钥无效」）**

- 触发条件：上游 403 + 请求体里含 `You are an AI agent powered by DeepSeek Harness.`。
  2026-11-15 实测：这句会被 Marvis 内容过滤**精确**拦下（少一个词就不触发），见 issue #22
- 命中时返回 `content_filtered` 并写明解法（关掉 DSH 的 `includeHarnessIdentity` 或改写开场白）；
  **不拦请求、不改 prompt** —— 只把错误文案从误导改成可执行
- 没命中标识句的 403 仍然原样透出，不误判
- 验收：测试 146 项中 142 通过、4 项因未注入 live 凭据跳过；合规检查 42 项全过

## 0.2.27 — 2026-11-11

**修复：claude-sonnet-4-6 / claude-opus-4-6 / gpt-5.4 三个模型永远回「该模型在当前账号不可用」**

根因不是模型下线，是 `Marvis-Scene` 请求头 —— 它是上游的**准入闸门**，不是随便填的元数据：

| Marvis-Scene | deepseek / hunyuan | claude / gpt |
| --- | --- | --- |
| `preload_summary`（插件原来用的） | 200 | **400 `4130001 无效模型id`** |
| `chat` | 200 | 200 |

同一个 model id、同一个账号、同一秒，只换场景就从 400 变 200。看起来像「模型不存在」，
其实是场景不放行 —— 上游把两种情况用了同一个错误码，特别容易查错方向。
现在固定发 `scene: "chat"`（这才是补全请求该有的场景），8 个槽位全部 200。

- `src/hooks/loader.mjs`：`Marvis-Scene` 改成 `chat`、`Marvis-AgentTag` 改成 `main_agent`
- `src/marvis/protocol.mjs`：`llmHeaders` 的默认 scene 同步改成 `chat`
- 4130001 的报错文案补一句「（模型 id 无效，或当前场景/账号不放行）」，
  别一口咬定是模型下线
- 新增回归测试：断言 loader 发出去的 `Marvis-Scene` 必须是 `chat`

附带验证（真账号直连上游）：8 个槽位全部 200；stream / tools / vision 都通
（`claude-sonnet-4-6` 识图答「红色」，`main-auto` 不再被入口 400 拦掉）。

## 0.2.27 — 2026-11-15

**新增（卡片上显示额度重置时间）**

- `auth.usage` 的主窗口补 `resetsAt`：按**北京时间每天 0 点**推算（issue #12 确认的规则）。
  上游 `/v3/marvis_get_wallet` 不返回重置时间，所以这里是固定规则推算，规则变了只改 `nextResetAt()`
- ⚠ 它**只影响卡片显示**：路由排序只读 `used`，给 `resetsAt` 不会让这个号排得更前
  （排序是 magpie 按剩余额度算的，插件给不了优先级）
- 验收：测试 144 项中 140 通过、4 项因未注入 live 凭据跳过；合规检查 42 项全过

## 0.2.26 — 2026-11-11

**修复 QQ 扫码后卡在「请在浏览器中完成腾讯 Marvis 登录」** —— 三个连环坑，都在 `src/marvis/relay.mjs`：

- `ptuiCB('67', …, '二维码认证中。')` 是「已扫、手机正在确认」，以前被当成「已过期」，
  于是插件立刻换了一张二维码 —— 手机确认的是旧那张，新那张永远没人扫，就卡死了。
  现在 67 只更新页面状态，继续轮询同一张码
- 扫码成功后腾讯还有一页「确认授权」（`graph.qq.com/oauth2.0/show`），那一步是页面 JS 干的
  （`qlogin_v2.js` 里的 `formSend()`）。插件不跑 JS，所以停在这一页。
  现在照它的实现自己发一次 `POST graph.qq.com/oauth2.0/authorize`
  （`openapi=1010`、`g_tk=hash(p_skey)`、`from_ptlogin=1`…），一次就过
- 腾讯会给同一个 cookie 名下发多条（不同 Domain），其中一条是空值的「删除」。
  我们的 cookie 罐子不分 Domain，空值把 `p_skey` 盖成了空串，
  `g_tk` 于是算成 5381，被当成 CSRF 又跳回授权页。现在空值不覆盖已有值
- 轮询的 800ms 间隔计时器以前 `unref()` 了：宿主进程此刻没别的活时事件循环会空掉，
  Node 直接退出。现在不 unref

实测：手机 QQ 扫码 → 确认 → 拿到 code → `exchangeCode` 成功（openid 5709482C…）。

## 0.2.26 — 2026-11-15

**修复（`main-auto` 被声明成不收图，贴图直接 400）**

- `main-auto` 补 `vision: true`：上游 `deepseek-v4-1-flash-261017` 本来能识图，但 TABLE 里没标能力
  ⇒ 默认槽位被声明成 text-only ⇒ magpie 在入口就把带图请求 400 掉（定位来自 @ATCThunder，issue #8）
- 图片输入归一：http(s) 图片 URL 下载后转 `data:` URI（含 SSRF 防护、禁重定向）、裸 base64 补成
  data URI、Anthropic `image/source` 显式转换 —— 转不了时本地 400，不再静默丢图
- README 的模型清单去掉已不存在的「DeepSeek V4 Pro」，并注明两条 V4.1 Flash 路由都能识图
- 验收：测试 143 项中 139 通过、4 项因未注入 live 凭据跳过；合规检查 42 项全过

## 0.2.25 — 2026-11-11

- 修复**取消登录后再点一次，报「端口 18080 被占用」**：`close()` 以前只调 `server.close()`，
  它只停止接受新连接，浏览器那条 keep-alive 连接（页面每 1.2 秒轮询 `/status`）还挂着，
  端口就一直没放。现在关服务时把已建立的 socket 全部 destroy 掉
- 用户点「取消」时立刻收摊：监听宿主 abort 的 signal，不再等 5 分钟超时
- 上一次扫码页没关干净时，下一次登录**先关旧的再绑端口**，并自动重试几次
- 端口真被别的程序占着时，报「扫码页的端口 18080 被占用了…」而不是底层的
  `Failed to start server. Is port 18080 in use?`

## 0.2.25 — 2026-11-15

**修复（0.2.23 的「防降级」条目会让部分客户端卡死）**

- 该条目的显示名从 `deepseek-v4-1-flash-261017 (防降级)` 改为
  `deepseek-v4-1-flash-261017-antidowngrade` —— **纯 ASCII，不带空格与全角括号**
- 原因：显示名带非 ASCII 字符时，VS Code Copilot 里选中它会一直停在回复阶段（同一条在 DSH 下正常），
  模型名会被客户端拿去做 header / URL 处理，非 ASCII 在那一层会出问题（issue #15）
- 旧显示名保留归一映射：已经写好它的路由组升级后照常工作，不会 `400 无效模型id`
- 新增回归测试：**所有模型的显示名必须是纯 ASCII** —— 防止再有人给它加中文后缀
- 验收：测试 128 项中 124 通过、4 项因未注入 live 凭据跳过；合规检查 42 项全过

## 0.2.24 — 2026-11-11

- 扫码页启动时**自查对外地址**：访问不通或返回非 200 就在 `docker logs` 里打印告警，
  并在 `/status` 的 `reach` 字段里带上结果 —— 端口映射写错时不再毫无线索
- 登录说明里写清「扫码页端口 ≠ magpie 端口」，并给出 `curl -I` 验证方法
- README 新增「打开扫码页是 404 / 401 / 要求登录 magpie？」排障小节

## 0.2.24 — 2026-11-13

## 0.2.23 — 2026-11-11

**修复（NAS / 无浏览器环境登录）+ 两处旧 bug**

- 新增**局域网扫码登录**（`src/marvis/relay.mjs`）：插件在本机临时起一个网页，用户用自己的
- 容器（Docker / 飞牛 / 群晖）里登录：新增 `MAGPIE_MARVIS_RELAY_PORT` / `MAGPIE_MARVIS_RELAY_URL`，
  固定监听端口并把「外面该打开哪个地址」交给用户指定 —— 否则容器里探测到的是 `172.17.x`，局域网打不开
  浏览器打开、手机扫码；二维码的 uuid/qrsig 由插件在服务端申请并长轮询，浏览器全程不碰回调地址。
  跑 magpie 的机器**不需要**任何浏览器 —— NAS / Docker / 群晖 / 飞牛 都能登录
- 本机找不到 Chromium 时，「QQ 登录」「微信登录」自动改走扫码路，不再报「请装一个浏览器」
- 新增两个显式方法「微信扫码登录（手机扫，NAS / 远程推荐）」「QQ 扫码登录（手机扫，NAS / 远程推荐）」，
  远程访问 magpie（桌面窗口开在服务器上、用户看不见）时手选这两条
- `main-auto` 补上 `vision: true`：之前漏了它，magpie 在入口就把带图请求 400 掉，
  上游其实能识图（issue #8）
- `usage` 的诊断文件改用顶层 `import`：原来在 ESM 里写 `require("node:fs")`，
  ReferenceError 被 catch 吞掉，`~/.cache/magpie/marvis-wallet-error.json` 从来没写出来过
- 验收：全量 124 项中 120 通过、4 项因未注入 live 凭据跳过；`check.mjs` 42 项全过；
  微信 / QQ 二维码通道对真实上游实测（页面 200、二维码 46KB JPEG / 442B PNG、状态 waiting）

> 每个版本一节，**一条一行**，说用户能感知的变化。
> 格式与规矩见 [UPDATING.md](./UPDATING.md)。

## 0.2.22 — 2026-11-08

**修复（保留仍可用的旧模型槽位）**

- 0.2.21 的 TABLE allowlist 会误伤 `app-auto` / `file-auto` / `computer-auto` / `browser-auto` 等旧槽位；
  改为只拦截已确认持续 500 的 `kimi-k2.5`，其他旧槽位继续由上游判定
- 配置合并同样改为不可用名单，不再丢弃所有目录外的手工或旧模型条目
- Magpie 可见模型键、`id`、`name` 仍只使用真实模型名；`main-auto` 不作为用户可见模型名
- 验收：全量 114 项中 110 通过、4 项因未注入 live 凭据跳过；真实当前 8 模型与旧 4 槽位全部 200，
  `kimi-k2.5` 流式/非流式均在本地 404 且上游调用为 0

## 0.2.21 — 2026-11-08

**修复（失效模型导致持续 500）+ 锁定真实模型显示名**

- 配置合并不再保留无法归一到当前目录的失效或手工模型 ID，避免继续调用已下线槽位
- `loader` 对不支持的模型直接返回 404 `model_unavailable`，不再发上游并触发多轮 500 重试；
  上游 `4130001 / 无效模型id` 也归为模型级 404
- Magpie 的模型键、`id`、`name` 继续显示真实模型名；`main-auto` 只作为内部上游槽位，不作为用户可见模型名
- README、npm 描述与 Discover 注册摘要同步为真实 8 个模型，删除 Kimi K2.5 与“18 个槽位”等失效宣传
- 验收：新增回归测试均先红后绿；全量 83 项中 79 通过、4 项因未注入 live 凭据跳过；
  真实 8 模型全部 200，`kimi-k2.5` 流式/非流式均在本地 404 且上游调用为 0

## 0.2.20 — 2026-11-08

**去掉对 `native/` 二进制的依赖（不再需要那 4 个 Windows 文件）**

- 新增 `src/marvis/fingerprint.mjs`：设备指纹改成本地生成，格式与上游一致；
  `native/` 变成**可选**——目录在且能加载就优先用它，不在也不影响使用
- 删除 `src/native.mjs`（原来要求 4 个 DLL 齐全，缺一个就返回 null）
- `MarvisExt` 的 `qimei36` 改成条件展开：取不到真值就整个字段不发，
  不要用占位值代替（该字段要求与设备一致）
- `loader` 的错误码 `native_unavailable` → `header_unavailable`
- README：「为什么需要 native/」改写为「设备指纹（不需要任何二进制）」，
  「只支持 Windows」改为跨平台说明
- 验收：无 `native/` 目录时走完整插件链路打真实网关 → 200；
  测试 59 通过、合规全过

> 0.2.16 ~ 0.2.19 是内部迭代版本，未公开发布；本次合并发布为 0.2.20。

## 0.2.15 — 2026-11-07

**文档（计费口径改写成计费公式）**

- README「计费 / 额度」从「字段含义 + 占比公式」改成**计费公式**：
  `计费 token = 缓存读取 × 0 +（输入 + 输出）× 0.5`，一个号每天 **1000 万计费 token**
- 并说明 1000 万是**计费** token，实际可用量远高于它 —— 缓存命中全免、输入输出打五折，
  按例子 `实际 : 计费 = 5 : 1`，1000 万计费 ≈ **5000 万实际 token**（全无缓存也有 2 : 1）
- 顶部「它能给你什么」的额度行同步成「1000 万计费 token（缓存免费 + 输入输出五折，实际能跑 2000 万～5000 万+）」
- 字段表里 `total_tokens` / `used_tokens` 标注「**计费** token」，避免与实际 token 混读

## 0.2.14 — 2026-11-07

**修复（微信账号登录态被踢下线）**

> 五个根因叠在一起，缺一个都修不好。前四条让续期「调不通」，第五条让续期「根本进不去」。

- **`auth.refresh` 的签名写错了（最致命）**：magpie 的续期钩子是
  `refresh(auth, provider)` —— 第一个参数是**账号对象**；只有
  `loader` / `usage` / `checkin` 才收 `getAuth` 函数。
  0.2.13 及以前写成 `async (getAuth) => getAuth()`，magpie 实测报
  `plugin [error]: auth.refresh: getAuth is not a function.
  (In 'getAuth()', 'getAuth' is an instance of Object)` ——
  **续期一次都没跑起来过**，30 秒重试、无限循环。现在两种传法都认
- **续期端点调错了**：以前调 `GET /v3/marvis_refresh_token?refresh_token=…`，
  该端点恒定回 `-109 RefreshToken missing required param (openid, guid, token)` ——
  **续期从来没成功过**。真实端点是 `POST /marvis_client_login/marvis_refresh_token`，
  body `{"userInfo":{openId,refreshToken,accessToken,loginType:"Marvis"}}`
- **微信 token 只有 2 小时**（`expires_in=7200`，QQ 是 ≈30 天 = `2591962`）：
  旧代码把 `expires_in` 当成「不是绝对时间戳」直接回退 30 天，于是**从不主动续期**。
  微信账号登录完几小时就 401「登录态过期/未登录」，QQ 只是 30 天没走完所以看不出来
- **`refresh_token` 空串覆盖**：续期响应里 `refresh_token` 回 `""`，`??` 不回退，
  存成空串后下次 `if (!refreshToken) return {}` 直接短路 —— 即使端点对了也永不续期
- **`-109` 被误判成登录失效**：它表示「参数检查未通过」（插件自身问题），
  标 `signIn: "expired"` 会让 magpie 把好账号标成「需要重新登录」。
  现在只有 `-107`（`RC_NO_AUTH_ERR`）/ `-101`（会话不存在）才标
- `refreshLead` 从 **24 小时**改为 **5 分钟**：24 小时对 2 小时的微信 token 意味着
  「从登录那刻起就永远该刷新」
- 新增 `src/marvis/expiry.mjs` 统一「绝对秒 / 绝对毫秒 / 相对秒 / 兜底」四分支，
  登录（`login.mjs`）、导入（`desktop.mjs`）、续期（`refresh.mjs`）三处共用

**修复（登录类型兜底）**

- `Ual-Access-Login-Type` 只认 **`1`（QQ）/ `2`（微信）** —— 渲染层
  `yct={QC:"1",WX:"2",WXAPP:"2"}`。五处兜底默认值 `6` 改成 `1`：
  `protocol.mjs` 两处（`llmHeaders` / `businessHeaders`）、`loader.mjs`、`usage.mjs`、
  `desktop.mjs` 的 JSON 形态。写 6 会让「拿不到 loginType 的账号」在后续请求里
  带错类型（`Ual-Access-Login-Type: 6` 不存在）→ 401

**文档**

- README 新增「**计费 / 额度**」小节：`total_tokens` / `used_tokens` / `avail_tokens` /
  `frozen_tokens` 四个字段的含义与占比公式
- README 登录说明改成「自动打开隔离浏览器、授权完自己关掉，不用复制 URL」——
  浏览器登录从 0.2.2 起就自动抓回调了

**实测（2026-11-07）**

- 五个账号（3 QQ + 2 微信）全部续期 `code:0`，续期后打 `/v1/chat/completions` 全部 **200**
- 续期**不换** `access_token`（响应与请求同值），只重置有效期；
  `metadata.openid` / `guid` / `refresh_token` 全部保留
- 修复前：两个微信账号 401 `{"code":4100403,"msg":"客户端通用错误:登录态过期/未登录"}`
- 修复后在**运行中的 magpie** 上复验：把过期账号的 `expires` 拨到过去 → 发一次请求 →
  magpie 自动续期并写回 `plugin-auth.json`（`expires` 变成 +2 小时），请求 **200**；
  五个账号现在全部有效
- 顺带：`auth.refresh` 的错误不再污染 magpie 日志（此前每 30 秒一条 `getAuth is not a function`）

## 0.2.13 — 2026-11-06

**修复（工具调用 400 invalid parameter）**

- Marvis 要求每个 `tools[].function.parameters` 显式带 `type: "object"`；
  DSH 的部分工具（如 `bash`）省略了它，**只要有一个工具缺 type，整次请求就 400**
- `loader` 现在递归补齐缺失的 `type:"object"`，不动 `properties` / `required` /
  `additionalProperties`；不改变工具名和行为
- 已用 DSH 当时的完整请求（57 个工具 + `reasoning_effort` + 流式）复放：
  修复前 400 `invalid parameter`，修复后 **200 流式工具调用**

## 0.2.12 — 2026-11-06

**修复（路由显示真实模型名）**

- 模型条目的 `id` 改成**真实模型名**（`deepseek-v4-1-flash-261017` 等），
  `apiId` 保留上游槽位名（`main-auto`）—— 路由/卡片不再显示 `0` 或 `main-auto`
- `loader` 同时认三种写法：真实模型名、旧槽位名、旧数字下标，统一映射到上游槽位；
  已实测 `model:"0"` 与 `model:"deepseek-v4-1-flash-261017"` 都返回 200
- 旧路由由升级脚本迁移 `marvis/0 → marvis/main-auto → marvis/<真实模型名>`；
  不迁移时 loader 仍兼容旧引用

## 0.2.11 — 2026-11-06

**修复（模型目录真正按槽位名）**

- `config.models` / `provider.models` 改成**对象表，键是槽位名**（`main-auto` 等），
  并给 `provider.models` 补上 `api.id`。此前是数组，magpie 会存成下标 `"0"…"7"`，
  路由里只显示 `0`，请求发 `model:"0"` 上游 400
- 旧数组形态在 `config` 合并时按 TABLE 顺序自动认回槽位名，用户改过的名字/上下文/能力保留
- `loader` 的数字 ID 兼容映射保留：即使路由组里还写着 `marvis/0`，也能正常调用
- 账号名继续带 `QQ·` / `微信·` 前缀（旧账号点刷新或重登后生效）

**升级提示**

- 安装后点一次「重新获取模型」，路由里把旧的 `0` 重新选成
  `deepseek-v4.1-flash-261017`，之后显示真实名称；不重选时 `0` 仍可用（loader 已兼容）

## 0.2.10 — 2026-11-06

**修复**

- **旧路由 `model:"0"` 报 `400 无效模型 id`**：0.2.x 的 `config.models` 是数组，
  magpie 把它持久化成下标 `"0"…"7"`，路由组引用 `marvis/0`，请求体就发 `"0"`。
  `loader` 现在把纯数字 ID 按 TABLE 顺序归一成槽位名（`0 → main-auto`），
  **旧路由不改配置即可继续用**
- **账号名前缀**：卡片名变成 `QQ·昵称` / `微信·昵称`，同名的 QQ/微信账号可以直接区分；
  旧账号点一次刷新（或重登）后生效
- 昵称/头像在登录、本机导入、刷新时统一通过签名 POST 获取，拿不到就留空

**说明**

- 路由页仍显示 `0`，是 0.2.x 数组模型 ID 的历史存量。本次优先保兼容、**不迁移路由组**
  （迁移要把 `marvis/0` 改成 `marvis/main-auto`，会动到用户现有路由）。
  需要显示真实名称时再做单独迁移。

## 0.2.9 — 2026-11-06

**新增（多账号并行）**

- **每个账号独立设备 `guid`（虚拟设备）**：扫码登录时生成新的 32 位 guid 并随账号保存，
  后续请求、刷新、额度查询都用该账号自己的 guid。此前所有账号共用本机 `svid`，
  上游同一 guid 只保留一个有效登录态，**新号登录会把旧号顶掉**（旧号随后 401）
- 登录过程中用 OAuth `state` 关联本次 guid，按 state 分开暂存，并发登录不会串号
- 本机导入仍使用客户端自己的 `svid`，保持与本机 Marvis 一致
- **账号名显示 QQ 昵称**：登录、本机导入、刷新时用签名 POST 取 `nick_name` / 头像并落盘；
  拿不到就留空，不编造。QQ 号拿不到（`openid` 是应用内 ID，不是 QQ 号）

**实测依据**

- 同一 token：原 guid → 200；随机 guid → 401；随机 `qimei36` / `nonce`（guid 不变）→ 200
  —— 绑定的是 guid，不是其他指纹

## 0.2.8 — 2026-11-06

**修复（根因，已实机验证）**

- **浏览器扫码登录 `-109 RC_PARAMS_INVALID` 的根因是换取时没带设备 `guid`**。
  实测：缺 guid → 恒定 `-109`；补 `Ual-Access-Guid`（或 `.qq.com` 的 `guid` cookie）后，
  死码立即变 `-107 RC_NO_AUTH_ERR` —— 参数检查发生在 code 校验之前。
  0.2.2～0.2.7 里「redirect_uri / 两次请求 / code 已消费 / UA / TLS」的解释均不成立，以本节为准
- **成功响应是 302 + Set-Cookie，不是 JSON**：改为 `redirect: "manual"`，
  从 `openid / accesstoken / refreshtoken / logintype / nickname / head_img_url /
  access_token_expire_time / appid / scope / is_locked` 还原账号
- **CDP 在 Request 阶段拦截回调**（`Fetch.requestPaused` + `Fetch.fulfillRequest` 静态完成页），
  浏览器不再把 code 发出去；监听器与钩子全部在 `Page.navigate` 之前安装
- **修正 `Network.responseReceived` 的资源类型读取位置**：类型在 `msg.params.type`，
  不在 `response.type`；原条件永不成立
- **回调 `state` 原样保留**并随换取请求回传；`guid` 不再在兜底路径变成 `undefined`
- **`-109` / `-107` 文案按实测更正**：`-109` = 参数检查未通过（最常见缺 guid），
  `-107` = 参数已通过但 code 无效/过期/已消费，都不是账号密码错误

**实机验证**

- QQ 扫码 → 隔离浏览器拦截 → Node 带 guid 换取成功：`uid=<已脱敏>`，拿到 access + refresh
- 用新凭据调用 `main-auto`：HTTP 200，`model=deepseek-v4-1-flash-261017`，内容 `"OK"`

## 0.2.7 — 2026-11-06

**修复**

- **UA 换回客户端自己的 Electron UA**（`Marvis/1.60.3300.408 ... Electron/44.7.0`）。
  之前为了「伪装成普通浏览器」用的是纯 Chrome UA —— 服务端很可能就是按这个区分调用方
- **去掉 `--disable-blink-features=AutomationControlled`**：它会在地址栏下面挂一条
  「你使用的是不受支持的命令行标记」黄色警告条。`navigator.webdriver` 改用 CDP 抹掉

**修复**

- **`state` 格式与客户端不一致**：app 是 `state=${Math.random()*100}`（**小数**，如 `31.1177412`），
  我写成了 `Math.floor(Math.random()*1e9)`（整数）。抓包确认服务端收到的是 `845583851` 这种
- **`loginType` 映射错了**：渲染层 `yct={QC:"1",WX:"2",WXAPP:"2"}`，
  `Ual-Access-Login-Type` 应该是 `1`/`2`，我写的是 `6`/`5`

**修复（`-109` 的最终根因）**

- **`marvis_oauth` 会被请求两次**：QQ 的 `self_redirect` + 页面自身重载，
  让同一个 code 打两遍 —— 第一次成功返回 token，第二次因为 code 已消耗而回
  `-109 RC_PARAMS_INVALID`。我之前读的是**页面最终状态**，拿到的正是第二次。
  客户端主进程用 `[oauth-dedup]`（"reuse first request"）处理这件事；
  插件改成监听 `Network.responseReceived`，**只认第一个响应体**，抓到立刻返回
- **`authorize()` 阻塞 1.4 秒**：里面调了 `findBrowser()`（15 次注册表查询），
  违反 HOOKS 四·陷阱 1。挪进 `callback()`

**修复**

- **响应解析对格式不敏感**：浏览器渲染 `application/json` 会加缩进/包装，
  原来只看 `startsWith("{")` 会漏判。改成「抠第一个 `{` 到最后一个 `}`」再解析

**修复**

- **授权页卡在「正在完成授权…」，magpie 加不进号**：上一版用 `Fetch.fulfillRequest`
  把回调换成静态页再在页面里 `fetch` 换取 —— 但执行上下文会随导航销毁，`Runtime.evaluate`
  拿不到结果。改成**完全不拦截**：让浏览器自己走完换取（TLS 指纹 / Cookie / Referer 天然齐全），
  只轮询 `location.href` 等它跳到回调地址，再读 `document.body.innerText`

**变更**

- **上下文窗口声明改为 1,000,000**（除 `hunyuan-turbos-vision` 仍 32k）。
  依据：实测 `main-auto` 发 **400,000 字符 = 190,511 tokens** 返回 200，
  远超 `config_defaults.yaml` 声明的 128k —— 那个 128k 是客户端自己的保守值
- **用户设置优先**：`config()` 不再整块覆盖 provider。改成**逐模型、逐字段合并** ——
  用户在 magpie 设置里改过的 `limit.context` / `limit.output` / `name` / `api` 一律保留，
  插件只补缺失字段和新增模型

**修复（逆向客户端主进程后对齐）**

- **换取请求改在页面上下文里发**：`yybadaccess` 的 WAF 做 TLS 指纹校验，
  Node 的 undici（OpenSSL）和 Chromium（BoringSSL）指纹不同 ——
  带头的请求从 Node 发出去一律 **400 空响应**。
- **补 `Referer`**：客户端重放时会把原始请求头整份复制（`reqHeaders` / `cookies` / `referer`），
  缺 referer 服务端判来源不合法。
- **去掉 `Ual-Access-Businessid`**：实测它会让 WAF 直接 400（这是我这轮踩的最大坑——
  加头反而更糟，不加头时至少还能拿到 `-109` JSON）。
- 浏览器先开 `about:blank`、装好钩子再 `Page.navigate` —— 否则首次请求漏过去，拦截永远不触发。

**修复（这是 `-109` 的真正根因）**

- **`redirect_uri` 少了 `?login_type=QC`**。Marvis 渲染层的 `Bpe(e)` 返回的是
  `.../marvis_oauth?login_type=${e}`，我写成了 `.../marvis_oauth`。
  服务端靠这个参数知道「用哪个 app 的 `client_secret` 去换 code」——
  少了它，**哪怕 code 是真的也一律 `-109 RC_PARAMS_INVALID`**（是参数无效，不是 code 无效）。
- 浏览器登录改为**正常走完回调请求**（带 Cookie、带正确 `redirect_uri`），
  只读第一个响应体；不再拦截后用 Node 重放（重放丢 Cookie，同样 `-109`）
- 微信登录同步修正

- **浏览器登录「授权码已被使用过」（`-109`）**：根因是 **QQ 会把 `redirect_uri` 的查询串整个丢掉** ——
  落地页收到的是 `?code=...&state=...`，**没有 `login_type`**，服务端因此判参数无效。
  改成用 CDP `Fetch.requestPaused` 在**跳转前**拦下回调，自己从 URL 取 `code` 再带 `login_type` 换。
  页面同时显示「授权完成」，用户不用对着 `-109` 的 JSON 发愣
- **换 token 带了鉴权头**：`marvis_oauth` 是**免鉴权**端点，带 `Ual-Access-*` 签名头会直接 400 空响应
- **`deviceGuid()` 永远取不到注册表**：JS 里 `\S` `\T` 是无效转义，反斜杠被吃掉，
  `reg` 收到 `HKCUSOFTWARETencentMarvisEnv` → 「无效参数」。改用 `String.raw`
- **本机导入的 guid 与 token 不同源**：服务端按 `(openid, guid, token)` 三元组校验，
  现在优先从**同一段内存**里取 `guid=`
- 去掉 `--disable-blink-features=AutomationControlled`（Edge 会弹「不受支持的命令行标记」警告条），
  改用 CDP `Page.addScriptToEvaluateOnNewDocument` 抹掉 `navigator.webdriver`
