# AGENTS.md —— 给 AI 执行者的入口

> 人类请读 [README](./README.md)。这份只回答两件事：
> **你现在该读哪一份**，以及**忘了哪一条会静默出错**。
>
> 从本模板派生出去的插件仓库，请把这份一起带走 —— 下面每一条对派生仓库同样成立。

---

## 一、先定位你在哪一步

别从头读到尾。先看自己在哪一格，只读那一格指的文件。

| 你在做什么 | 必读（按顺序） | 做完的判据 |
|---|---|---|
| **还没开工**，手上只有一台 magpie | [GUIDE.md](./GUIDE.md)（30 分钟主线，每步带官方锚点）→ 本文件 → [README](./README.md) 的「必读五份」「最小交付面」「三条铁律」 | 能说清「哪些事 magpie 已经做了、插件不该重做」 |
| **决定要不要拆成两个供应商**（国内版 / 国际版） | [MULTI-PROVIDER.md](./MULTI-PROVIDER.md)（只有一个站点：跳过） | 两张卡、两组登录态，互不覆盖 |
| **填那五个 TODO / 改钩子** | [HOOKS.md](./HOOKS.md) —— **按钩子查章节，不要通读** | 每个钩子的返回值形状与第 21 章一致 |
| **代码写完，准备交付** | [CHECKLIST.md](./CHECKLIST.md) 的 **A 表** | A 表全勾 + `node scripts/check.mjs` 退出 0 |
| **要发一个版本** | **[UPDATING.md](./UPDATING.md) 全文** | [CHECKLIST.md](./CHECKLIST.md) 的 **B 表**全勾 + 五条验证 |
| **用户说「有新版本但我这边没动静」** | UPDATING 的「一、magpie 怎么发现新版本」 | 分清是 npm 源（比 `version`）还是 git 源（比 HEAD commit） |

**最容易漏的是第 5 行。** 而且要记住分支和 `main` 是**两条分发通道**，不是「先放着」和「正式」：
- **分支 = 测试版通道**：用户写 `magpie plugin add owner/repo#feat-x` 才拿得到，不影响用 `main` 的人
- **`main` = 稳定版通道**：git 源跟随默认分支 HEAD，进了就是所有人

所以「怕把别人在用的插件炸了」的解法是**推分支**，不是「晚点推」。
PR 是 GitHub 对受保护分支的技术要求（直推报 `GH006`），批准数 0、自己就能合。

---

## 二、十三条会静默出错的坑

「症状」列照着你看到的现象查；「判据」是正确做法；「出处」是完整论证。

| # | 症状（出问题时你看到什么） | 判据 | 出处 |
|---|---|---|---|
| 1 | 额度条永远是 100%；空账号反而排到队首 | `usage.used` **必填**且是有限数字 —— 它也是路由排序输入，漏了按 0% 算 | HOOKS 九 |
| 2 | 免费模型被反复派发；或收费模型被标成免费 | `free` 只认厂商自己的声明：列表价 $0，或厂商自己的计费端点明确说 0。**`rate: 0` 的意思是「没给倍率」，不是免费** —— magpie 不会从 `rate` 推 `free`（#468 更正，2026-10-29）。反过来，把「套餐内不按次计费但吃额度」的模型标成 `free: true`，Free first 会一直派发它们 | HOOKS 十一之二 |
| 3 | 点登录后界面转圈很久，或模型列表整个卡住 | `authorize()` 必须**立刻**返回；网络请求一律挪到 `loader` | README 铁律 2 |
| 4 | 刷新一次 token 后某个字段变空，或用户被要求重登 | `refresh` 返回的是**合并**结果，只给新字段会覆盖掉旧的 | README 铁律 3 |
| 5 | 插件装上了，但模型列表空、界面没反应 | `config.models` 必须有内容（可以是静态占位） | README 铁律 1 |
| 6 | 某一个模型报错，**整个账号（甚至所有账号）**被停用 | 模型级错误返回 **403 / 404**，不是 401。401 可重试 ⇒ 会 failover 到**每一个账号**，每个都标登录失效。magpie ≥ 0.1.1934（`3ec25523c`）起，插件 401 的 body 只说模型不可用、不提 token/key/sign-in/session 时不标账号；但插件仍应回 403/404（#468） | README 常见坑 2 |
| 7 | 登录偶尔「莫名失效」，多账号同时刷新时更常见 | 一次性 `refresh_token` 必须**串行**（同账号同时只允许一次刷新） | README 常见坑 4 |
| 8 | 流式输出卡住 / 只有第一段就结束 | 不要在 `fetch` 里读流，把 `Response` 原样交回去 | README 常见坑 5 |
| 9 | GitHub 把 license 标成 `NOASSERTION`，卡片上没有许可那一格 | `LICENSE` 最好写**逐字 MIT 正文**，归属说明另放 `NOTICE.md`。magpie ≥ 0.1.1934（`5957d45ac`）起，`NOASSERTION` 的 listing 回退到 `package.json` 的 `license` —— 夹归属说明不再必然没许可，但 GitHub 仍不认那份 LICENSE（#468） | README 顶部四件 |
| 10 | 改了代码重装，行为一点没变 | 同版本号重打包会命中 bun 缓存（`no changes`）—— 必须 bump `version` | UPDATING 第 1 步 |
| 11 | `magpie plugin add xxx.tgz` 跑完像成功，实际没装上 | 这个命令有 bug，改 `plugins.json` + `plugins/package.json` 两处 | README 常见坑 1 |
| 12 | 想让卡片标题/文案对，去改了 magpie 的缓存文件 | 插件对 magpie 的目录**只有读的份**；唯一载体是 `registry-entry.json` | README「不要写 magpie 的缓存」 |
| 13 | 用户那边没更新 / Release 页面是空的 / 「暂无发布版本」 | 起功能分支 → CHANGELOG + bump → 检查 / 测试 / pack → 推分支 → 提 PR 等 `rules` 绿 → 合并 → npm / tag / Release → 五条验证。**直接推 main 会被分支保护拒绝** | UPDATING 二 · CHECKLIST B |

补充两条只在发布侧出现的：

| # | 症状 | 判据 | 出处 |
|---|---|---|---|
| 14 | 推了分支，magpie 还说没更新 | git 源比的是**默认分支** HEAD 的 commit；推别的分支不算。而 `plugin add` 不会更新已有的锁 | UPDATING 一 / 六 |
| 15 | magpie 的 Discover 里搜不到自己的包 | `keywords` 要含 `opencode` + `plugin`/`auth`/`provider` + `magpie`；仓库要打 `magpie-plugin` topic | README 顶部四件 |

再三条与代码结构有关的 —— 它们不报错，但会让插件在多账号 / 部分成功 / 长大后出问题：

| # | 症状 | 判据 | 出处 |
|---|---|---|---|
| 16 | 加了第二个账号，第一个账号的数据变了 / 串号 | 一切按账号落盘的东西，文件名必须带账号（`<plugin>-<siteId>__<account>.json`）；**不要用模块级变量存 per-account 状态** —— 宿主是同一个进程跑所有账号 | [`src/hooks/models.mjs`](HOOKS.md) 的 `inScope` |
| 17 | 接口抖一下，列表整个空掉；或某个模型缺价格，用户选了报错 | **部分成功有三态**，方向要各自选对：① 整个接口失败 → 退回上次快照（不要返回空表）② 接口成功但单条缺字段 → **不列**（不猜）③ 登录失效 → 抛 `signIn: "expired"` | [`src/models.mjs`](./src/models.mjs) 的 `buildModels` |
| 18 | 越改越乱，`index.mjs` 涨到几百行，改一个钩子要读全篇 | 成熟形态是**`index.mjs` 只做九项钩子的装配，实现全在 `src/`**。实测四个真实插件的 `index.mjs` 是 80~715 行，而 `src/` 是 1.4k~3.7k 行 —— 本模板现在是 index 558 行 / `src/` 21 文件 3,900+ 行（已不是「单文件 78 行」） | 本文件「五、长大之后」 |

还有两条是 **magpie 0.1.1763 重新提取契约后才发现**的（2026-10-28）：

| # | 症状 | 判据 | 出处 |
|---|---|---|---|
| 19 | 某个能力「明明实现了却没生效」：模型不会联网、不能收图、没有思考档、折扣前的倍率不显示 | 模型 / provider 条目上有一批**不写就等于关掉**的字段：`searches`（模型级=这条自己会搜，provider 级=上游整体会搜）、`decides`（decision 模型，从 agent 列表隐藏）、`rateWas`（折扣前倍率）、`fast`、`serviceTiers`、`modalities`（图片 / 音频能力全靠它；其中 `image` 省略 **≠** 关掉，见坑 25） | HOOKS 十一之三 |
| 20 | 厂商有画图模型，插件里当垃圾过滤掉了；或者反过来，列进去之后用户在 chat 里选中报 400 | magpie **0.1.1707 起**支持插件供图（`DrawsID` + `ImagesAPI` + npm 是 `@ai-sdk/openai-compatible`）。但它**同时**留在 chat 模型列表里 —— 列不列是取舍，判据见 [`src/models.mjs`](./src/models.mjs) 的 `LIST_IMAGE_MODELS` | HOOKS 十一之三的「插件供图」 |
| 21 | 花一晚上追 magpie 的「每个版本」，改了一堆文档，用户那边一点变化都没有 | **判断要不要同步，看稳定渠道**（magpie 设置里那个「更新渠道：每个版本 / 稳定版」）。`curl -s "https://usemagpie.ai/api/latest?channel=stable"` 拿稳定版版本号；2026-10-28 实测：每版本 0.1.1763 / **稳定版 0.1.1327**，逐字段比对后插件相关字段**完全一致** —— 追每版本几乎全是白跑。一条命令判断：`node scripts/check-magpie-stable.mjs` | HOOKS 顶部 · UPDATING 一 |
| 22 | 卡片上每个账号都显示「剩余额度未知」，而 `usage()` 明明返回了 plan / balance / windows、也没有 error | **窗口变成 text-only 了**：**判断只看 `used`，与 `aside` 无关**（#468 更正，2026-10-29）。两种写法会丢占比：① 有 `amount`/`limit` 却没有 `used`（magpie < 0.1.1934 直接丢；≥ `1390aa458` 才用 amount/limit 推算）② `resetsAt`/`runsOutAt` 塞厂商原样时间 `"2026-10-28 23:59:59"`（解析失败 ⇒ 整条丢）。判据：`curl -s http://127.0.0.1:3425/v1/magpie/quotas`，看 `windows[0]` 有没有 `text: true` 和 ISO 形式的 `runsOutAt` | HOOKS 三 · 三条「写错不报错」的窗口规矩 |
| 23 | 有一批额度快到期了，卡片上却完全看不出来 | 用官方字段 `runsOutAt` + `runsOut`（剩余额度何时作废、损失多少），**不要拼进 `display`** —— 拼进去只是普通文字，magpie 不会当失效提醒。厂商给的时间要先转 ISO | HOOKS 三 · 规矩 ③ |
| 24 | **卡片上额度正常，路由页里这个号却是「剩余额度未知」，还总排在别人后面** | 窗口没有被路由计入：**`used` 缺省的窗口判成 `Text`，`aside: true` 的窗口路由直接跳过** —— `w.Aside || w.Text` 两个条件都会跳过，与 amount/limit 无关（#468 更正）。一条不剩 ⇒ `allowanceOf()` 返回空 ⇒ `routedAllowance` 不 ok ⇒ `weighed()` 不设 `Known`。**「不参与排序」的实际后果是「这个号在路由里不存在」**。判据：`curl -s http://127.0.0.1:3425/v1/magpie/trace` 看这个 provider 的 `known` 是 `true` 还是**字段缺失**；`~/.config/magpie/quotas.json` 的 `spans` 是 `[{}]` 还是 `[{"aside":true}]` | HOOKS 三 · 规矩 ① |
| 25 | **模型明明收不了图，却被当成能收图**：截图直发上游报 `The request model is not multimodal` / 400，或者模型回「图片无法查看」 | 模型条目的 `capabilities.input.image` **必须写成布尔值**：省略不等于 text，等于「厂商未表态」，magpie 会拿 models.dev 的裸模型 id 投票补 —— 同名模型在别家标过 `image`，这个模型就会被带成能收图。text-only 模板见 HOOKS 十一之三；反向的手动覆盖（厂商说 `false` 却勾了 `Accepts images`）在 magpie 侧暂无警告 | HOOKS 十一之三 · CHECKLIST A-14 |
| 26 | 邀请码填了、主登录也过了，但上级没拿到奖励；或「邀请码」那条登录方式点开只有一个框、后面什么都没接 | 两个原因：① 与码成对的额外参数没带（Accio 的 `sId`）—— 换码时必须一起换，见 `src/invite.mjs` 的 `write()`；② 用 `prompts` 数组串「邀请码 → 主登录」是串不起来的，必须用 `ask()`（HOOKS 四·陷阱 5） | HOOKS 四·陷阱 5 · 四之二 · `src/invite.mjs` |
| 27 | **卡片上的账号名是一串看不懂的 ID**（`iam::01a1642a…:user:hw0615…`、`urn:…`、uuid），用户以为是「显示乱码」 | `accountId` 是**名字**，不是身份：手机号（`maskPhone` 对去掉国家码后 ≥11 位的号码打码 `189****8051`；短号返回空串不显示）→ 昵称/邮箱 → **空串**（宿主回退供应商名）。内部 ID 只进 `uid`。**URN 写进 `accountId` 极难改回** —— 续期返回值是合并、插件落盘又多保留旧值，所以续期路径也要重算一遍 | HOOKS 八的「`accountId` 是名字，`uid` 是身份」· `src/account-name.mjs` 的 `resolveAccount` |
| 28 | 卡片标题写 `华为云 HUAWEI` 之后，`magpie plugin update` 报 `unrecognised dependency format: 华为云 HUAWEI` | `package.json.name` 同时是 bun 依赖键，**必须是 slug、不能有空格**；显示名写 `package.json.magpie.name`（可带空格），provider/registry 同步。旧安装按 UPDATING 的「旧版带空格依赖键」改键 + 目录 + lock，不用 rm+add | README「包名是 slug；显示名写 magpie.name」· UPDATING 迁移 |

---

## 三、命令

```bash
# 合规检查 —— 退出码非 0 就是不合规，别靠眼睛看
node scripts/check.mjs              # 检查当前目录（严格：占位符会失败）
node scripts/check.mjs ../my-plugin # 检查别的仓库
npm run check:template              # 仅脚手架自身：允许「未命名」占位符

# 打包面预演：README / CHANGELOG / docs 在不在包里
npm pack --dry-run

# 包名撞车检查（撞了 = magpie 的「更新」会装成别人的包）
npm view <包名> version

# 语义测试 —— check 查「形状」，它查「语义」（free 三分支 / 三态降级 / 404 vs 401 / 流式 usage）
node --test

# 维护检查 —— 改了代码有没有 bump、bump 了有没有打 tag、CHANGELOG 有没有这一节
#   六条全不报错，但后果同一个：用户永远拿不到新版。发布前必跑。
node scripts/check-maintenance.mjs

# 显示名（magpie.name，中文 + English）与 npm 包名不同时发布
#   模板自带 scripts/publish-npm.mjs（PUBLISH_AS = magpie-plugin-scaffold）；
#   派生仓库由 create.mjs 生成自己的 PUBLISH_AS。
#   release.mjs 会自动检测：有它就用它，没有就退回 npm publish。
#   CI 的 release.yml 必须配 NPM_TOKEN；没配会显式失败（不是 exit 0 假绿）。
npm run publish:npm

# 受控发布：只在 PR 合并后运行；脚本不推 main，只推 tag
node scripts/release.mjs             # 预演：已合并 HEAD + 检查 / 测试 / pack，什么都不改
node scripts/release.mjs --yes       # 真做：tag + Release（要 GITHUB_TOKEN 才建 Release）
node scripts/release.mjs --yes --npm # 再加 npm publish

# 手工版（release.mjs 用不了时）
git tag v0.1.8 && git push origin v0.1.8

# 重新提取 magpie 二进制里的钩子契约（核对 HOOKS.md 用）
python extract-contract.py [magpie 可执行文件]

# magpie 升级后必做：重新提取 + 自动找出 HOOKS.md 漏写的字段
python extract-contract.py && node scripts/contract-diff.mjs
#   退出码 2 = 有差集（列出前 40 个）。挑「不写会关掉某个能力」的补进 HOOKS 十一之三。

# 该不该跟着 magpie 升级动这份文档？**看稳定渠道，不看每版本渠道**
node scripts/check-magpie-stable.mjs
#   0 = 基线就是当前稳定版，不用动；2 = 稳定版变了，按它打印的三步走
#   裸查：curl -s "https://usemagpie.ai/api/latest?channel=stable"

# 模型「说自己能收图」是不是真的？发一张写着字的内嵌图问它，按回答分四类
#   假声明 = magpie 当它能收图、直发上游，而上游答「看不见」或直接拒绝（坑 25）
node scripts/probe-vision.mjs                 # 测网关 /v1/models 里的每个模型
node scripts/probe-vision.mjs --vision-only   # 只测设置里那个识图模型
node scripts/probe-vision.mjs <provider/model> …
#   退出码 2 = 有假声明；只读本机网关与 settings.json，不改任何配置
```

---

## 四、两个交付门

**门 1 · 代码交付**（给用户能装之前）

```
□ node scripts/check.mjs 退出码 = 0
□ CHECKLIST.md 的 A 表全勾（check 脚本查不到的那部分）
□ 五个 TODO 的语义按 HOOKS.md 对过一遍，不是「能跑就算」
```

**门 2 · 发布**（说「已发布」之前）

```
□ CHECKLIST.md 的 B 表全勾
□ 五条验证都跑过（含 check-maintenance.mjs）：npm 版本 / tarball 内容 / 本机 magpie 认得 / Release 在
```

⚠ **没过门 2 不许说「已发布」。** 只 push 过就说已发布，是在用印象代替验证。

---

## 五、长大之后：从单文件到 `src/`

本模板刻意是**单文件入门**（九个钩子一屏读完，五个 TODO 在底部）。但插件一旦有登录、
缓存、多账号、签到…就会长。四个真实插件的实测形态是这样：

| 仓库 | `index.mjs` | `src/` | `tests/` |
|---|---|---|---|
| 本模板 | 558 行 | 20 文件 / 3,716 行 | 16 |
| `magpie-magicrew-auth` | **86** | 27 文件 / 7,773 行 | 17 |
| `magpie-officeace` | 383 | 8 文件 / 1,566 行 | 2 |
| `magpie-loomy-auth` | 611 | 9 文件 / 1,905 行 | 4 |
| `magpie-today` | 715 | 18 文件 / 2,812 行 | 7 |

结论：**`index.mjs` 只做装配，实现全在 `src/`** —— 最成熟的那个（magicrew）index 只有 86 行。

已经备好 21 个 `src/` 模块（前四块四个插件里 4/4 都有；`store` 只有 magicrew 独立成文件，
另两个各自实现了等价逻辑；其余是 2026-10-29～30 从 magicrew / 社区 MIT 包抽出的通用协议）：

| 文件 | 里面写什么 | 为什么单独拎出来 |
|---|---|---|
| [`src/refresh-lock.mjs`](./src/refresh-lock.mjs) | `createRefreshLock` / `run` / `clear` / `sweep` | 一次性 refresh_token 的并发闸：同 key 合并、成功回放 60 秒、失败可重试；键必须是凭据身份 |
| [`src/oauth-pkce.mjs`](./src/oauth-pkce.mjs) | `generatePkce` / `randomState` / `startLoopback` | OAuth PKCE S256 + 127.0.0.1 loopback：state/Host 校验、错误 path 404 不结束、错误 state 400 可重试、超时/abort/close |
| [`src/model-context.mjs`](./src/model-context.mjs) | `createModelContext` / `contextOf` / `clear` / `size` | 查 `~/.cache/magpie/models.json` 的真实上下文；查不到返回 fallback / undefined，不猜 |
| [`src/openai-sse.mjs`](./src/openai-sse.mjs) | `parseSse` / `readSseEvents` / `openAIEvents` / `foldOpenAI` | SSE 帧解析 + 非流折叠；CRLF / 多行 data / BOM / UTF-8 跨块 / 32 MiB / tool_calls 分片 / usage 帧 |
| [`src/usage-cache.mjs`](./src/usage-cache.mjs) | `createUsageCache` / `read` / `clear` / `publicUsage` / `exhausted` | 额度卡片频繁刷新：成功 60 秒 / 失败 5 秒、同 key 并发合并；无读数时 `exhausted` 必须放行 |
| [`src/request-rewrite.mjs`](./src/request-rewrite.mjs) | `rewriteJsonBody` / `ensureStreamUsage` / `clampMaxTokens` / `stripModelPrefix` / `stripHopHeaders` | identity 快路径；改 body 后必须去掉 `content-length` / `content-encoding`；工具 schema 不动 |
| [`src/tool-schema.mjs`](./src/tool-schema.mjs) | `truncateToolName` / `truncateToolNames` / `loosenToolSchema` / `adaptToolList` / `rewriteToolSchema` / `createToolSchemaAdapter` | 工具名超长截断（保持唯一）+ 工具 schema 兼容改写（`additionalProperties` 非布尔→`true`、删 `items:{}`、`items` 子树摊平且不留空 `{}`）；**默认关闭、只作显式 adapter** —— 会放宽用户 schema，与 `request-rewrite.mjs` 的「工具 schema 绝不改」是两套取舍，别同时挂 |
| [`src/api.mjs`](./src/api.mjs) | `headersFor` / `read` / `get` / `asModelError` / `asSignInExpired` | 错误语义只在一处定义 —— 401 与 404 混用会打死整个账号 |
| [`src/models.mjs`](./src/models.mjs) | `isUsable` / `priceOf` / `buildModels` / `defaultEntry` | 三态降级 + `free` 三分支，错法都长得像「正常」 |
| [`src/chat.mjs`](./src/chat.mjs) | `passThrough` / `withUsage` / `singleShotToSSE` / `normalizeUsage` | 流式三坑：读干流、漏 `include_usage`、`stream:false` 不被接受 |
| [`src/store.mjs`](./src/store.mjs) | `fileOf` / `readJson` / `writeJson` + 快照 / 登录态 / 一次性标记三件套 | 只写 `~/.cache/magpie`、文件名带账号、原子写、可整目录删 |
| [`src/quota.mjs`](./src/quota.mjs) | `usageWindow` / `usage` / `toIso` / `QuotaShapeError` | **把「写错不报错、但 GUI 和智能路由会坏」的五类窗口写法变成运行时错误** —— 见下方的表 |
| [`src/invite.mjs`](./src/invite.mjs) | `createInviteStore` / `inviteHint` / `resolveInvite` / `makeInviteMethod` | 邀请码只能在登录 URL 上带、事后补不了；而 `prompts` 是静态数组，串不起「填码 → 主登录」—— 只有 `ask()` 能 |
| [`src/desktop-import.mjs`](./src/desktop-import.mjs) | `hasDesktopLogin` / `decryptChromiumV10` / `importDesktopLogin` | 厂商有桌面客户端时，这是**唯一不弹浏览器**的登录路；DPAPI + AES-GCM 的边界（v11/v20 解不开）必须写在代码里 |
| [`src/account-name.mjs`](./src/account-name.mjs) | `maskPhone` / `looksLikeIdentifier` / `accountLabelOf` / `resolveAccountLabel` / `resolveAccount` | 换码响应没有账号名 ⇒ 卡片只能显示「Signed in」；补一次 userinfo 就行，但**失败不能阻塞登录、不能编造**。手机号（去掉国家码后 ≥11 位）一律打码，短号返回空串；内部 ID（`iam::…` / URN / uuid / `hw…`）**不许当名字** —— 它们进 `uid`，名字取不到就是空串 |
| [`src/rotation-captcha.mjs`](./src/rotation-captcha.mjs) | `encodeAngle` / `createRotationCaptcha` / `solveRotationCaptcha` / `createCookieJar` | 「旋转图片对正」的验证码：角度编码是从前端反出来的（实测 4 组提交正向穷举唯一命中）；`acw_tc` WAF cookie 不带回去会回「客户端信息不匹配」；判角不可信要换图而不是硬撞 |
| [`src/vision-clock.mjs`](./src/vision-clock.mjs) | `readVisionModel` / `decideDegFromImage` / `clockToDeg` / `clockSpread` | 用用户自己在 magpie 里选的识图模型判「主体朝几点」；两个判官并行 + 分歧阈值；`max_tokens` 是给推理留的（400 会饿死答案） |
| [`src/local-browser.mjs`](./src/local-browser.mjs) | `readLocalCreds` / `credsNear` / `leveldbText` | 用户在自己浏览器里登录过时，直接读 localStorage 的 leveldb —— 不开窗、不弹浏览器；跨 origin 必须截断，否则 A 站 jwt 会配到 B 站 org |
| [`src/marvis/relay.mjs`](./src/marvis/relay.mjs) | `startRelayLogin` / `hash33` / `parseWxPoll` / `parsePtuiCB` / `lanAddresses` | 本机**没有**浏览器时（NAS / Docker / 远程访问）的登录路：插件在服务端申请二维码（微信 uuid / QQ qrsig）并自己长轮询，用户的浏览器只显示页面 —— **绝不碰回调地址**，浏览器一旦真去请求回调，code 立刻作废（-107）。页面地址带一次性 token，否则同局域网的人扫码等于把他的号绑到你的 magpie 上 |
| [`src/browser-login.mjs`](./src/browser-login.mjs) | `browserCandidates` / `findBrowser` / `chromiumLogin` / `selectCookies` | 需要用户在网页里登录时，开一个一次性 Chromium profile 从 CDP 取 Cookie；国产浏览器也要覆盖，Windows 注册表 App Paths 优先 |
| [`src/tempmail-client.mjs`](./src/tempmail-client.mjs) | `createTempMailbox` / `waitTempCode` | 邮箱验证码自动登录的一次性地址；域名有黑名单（`maxxspace.com` 被 magicrew 拒），换厂商先用真实请求确认 |
| [`tests/semantics.test.mjs`](./tests/semantics.test.mjs) | 语义锁（含额度窗口 / accountId 规则） | `check.mjs` 查不到的那部分，只有它能拦 |
| [`tests/mount.test.mjs`](./tests/mount.test.mjs) | 入口唯一函数导出 / 九钩子 / config 模型 / loader / usage 形状 | 模块测试全绿也拦不住「index 改坏了」 |

**为什么 `src/quota.mjs` 值得单独一个文件**：额度窗口是 magpie **画卡片**和**智能路由排序**的同一个输入。
写错不会崩，只会让卡片显示「剩余额度未知」、让这个号在路由里被当成不存在 —— 用户以为插件坏了，
插件作者在日志里什么都看不到。这个构造器把五类写法直接变成 throw：

| 写法 | 不拦的后果 | 构造器的行为 |
|---|---|---|
| 缺 `used`（且没有 amount/limit） | 窗口判成 `Text`，**路由不计入** ⇒ 一条不剩时该号在路由里不存在（坑 24） | 抛，要 text-only 必须显式 `textOnly: true` |
| `aside: true` 又给 `amount`/`limit` | 分母就是余额本身，算出来永远「剩余 100%」—— 看着漂亮、含义是错的 | 抛 |
| 钱包型（`balance`）又给 `used` | 被当占比读，余额显示错 | 抛 |
| `resetsAt` 塞厂商原样时间 | 解析失败，整条窗口被丢掉（坑 22） | 抛 |
| 所有窗口都是 `aside` / `textOnly` | 路由一条都不读 ⇒ 这个号在路由页「剩余额度未知」且排在已知账号之后 | `usage()` 抛 |
| `span` 不是正整数 | 窗口长度算错，重置时间显示乱 | 抛 |

**拆分示例**：[`examples/split/`](./examples/split/) 把「index 只装配」这件事摆了一遍
（三个钩子各占一个文件 + 一个 40 行的 index）。钩子只有三种形态，其余五个照同一规则搬。

**什么时候该搬**（出现任一情形就搬，别等）：

- 某个钩子函数超过 60 行，或同一个 `fetch` 在三个钩子里重复出现 → 抽 `src/api.mjs`
- 需要在两次调用之间记住东西（token、快照、当天做过的标记）→ 加 `src/store.mjs`，
  **文件名里必须带账号**（坑 16）
- 开始有第二个账号进来 → 先查有没有模块级变量在存 per-account 状态

---

## 六、文档地图

| 文件 | 管什么 | 什么时候读 |
|---|---|---|
| [GUIDE](./GUIDE.md) | **说明书主线**：30 分钟，拿模板 → 改身份 → config → auth → models → usage/checkin → 自检 → 打分 → 发布 | **第一次做插件时，从头读** |
| [OFFICIAL-SOURCES](./OFFICIAL-SOURCES.md) | **官方 22 个锚点 → 本仓库的映射**；每条结论的官方出处 + 版本基线 + 我们补的 8 条 | 想知道「这条规矩官方有没有写」时 |
| [SCORING](./SCORING.md) | 100 分怎么算、80 分卡在哪、`node scripts/score.mjs` | 交付前自评时 |
| [README](./README.md) | 这个模板的设计原则：最小交付面、九项清单、三条铁律、常见坑 | 开工前 |
| [HOOKS.md](./HOOKS.md) | 21 章钩子契约（**字段级**：少写/写错会怎样。官方文档讲行为，两者并用；`auth.checkin` 已于 v0.1.1582 补进官方文档） | 写代码时按钩子查 |
| [MULTI-PROVIDER.md](./MULTI-PROVIDER.md) | 一个包两个供应商（国内/国际）：判据、骨架、五条铁律 | 只有多站点时 |
| [UPDATING.md](./UPDATING.md) | 功能分支 + PR + `rules` 门禁、进 main 后的受控发布、用户怎么拿到 | **每次发布前** |
| [README-TEMPLATE.md](./README-TEMPLATE.md) | 插件介绍页模板（用户只看它决定装不装） | 写 README 时 |
| [CHECKLIST.md](./CHECKLIST.md) | 两张勾选表：交付前 / 发版前 | 两个交付门 |
| [CHANGELOG.md](./CHANGELOG.md) | 本模板自己的更新记录（格式即范例） | 找「为什么这样改」 |

---

## 七、这份文件的维护规矩

1. **任何一份专档新增/改写一条「会静默出错」的结论，就在第二节加一行**（症状 → 判据 → 出处）。
   不加的后果：这份表会慢慢过期，而 AI 会照样信它。
2. 第二节只放一句话判据，**论证留在出处那一份**。别在这里复制长段落 —— 两份会打架。
3. 新增一份文档，就要在第五节加一行，并说明「什么时候读」。
4. 判据要能**当场验证**（能跑的命令、能看的字段）。写不成判据的，是感想，不是规矩。
