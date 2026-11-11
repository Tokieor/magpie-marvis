## 0.2.24 — 2026-11-11

- 扫码页启动时**自查对外地址**：访问不通或返回非 200 就在 `docker logs` 里打印告警，
  并在 `/status` 的 `reach` 字段里带上结果 —— 端口映射写错时不再毫无线索
- 登录说明里写清「扫码页端口 ≠ magpie 端口」，并给出 `curl -I` 验证方法
- README 新增「打开扫码页是 404 / 401 / 要求登录 magpie？」排障小节

# 更新记录

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
## 0.2.25 — 2026-11-11

- 修复**取消登录后再点一次，报「端口 18080 被占用」**：`close()` 以前只调 `server.close()`，
  它只停止接受新连接，浏览器那条 keep-alive 连接（页面每 1.2 秒轮询 `/status`）还挂着，
  端口就一直没放。现在关服务时把已建立的 socket 全部 destroy 掉
- 用户点「取消」时立刻收摊：监听宿主 abort 的 signal，不再等 5 分钟超时
- 上一次扫码页没关干净时，下一次登录**先关旧的再绑端口**，并自动重试几次
- 端口真被别的程序占着时，报「扫码页的端口 18080 被占用了…」而不是底层的
  `Failed to start server. Is port 18080 in use?`

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

