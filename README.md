# 腾讯 Marvis · magpie 供应商插件

> 非官方插件。Marvis 是腾讯的产品，本插件只是把它自己的模型网关接到 magpie 上，
> 与腾讯无关。边界见下方「已知边界」。

> **这是个人 fork**：派生自 [MYCF711/magpie-marvis](https://github.com/MYCF711/magpie-marvis)（MIT），
> 由 [@Tokieor](https://github.com/Tokieor) 维护，**仅供自己使用**，不对外分发。
> 与上游作者、与腾讯都没有隶属关系。
>
> 相对上游 `0.2.22` 的改动（本 fork 的 `0.2.23`）：
>
> | 改了什么 | 为什么 |
> |---|---|
> | `main-auto` 补 `vision: true` | 上游 `deepseek-v4-1-flash` 本来能识图，缺这个字段会被 magpie 在入口 400 掉（上游 issue #8） |
> | `usage` 钩子改用 `import` 的 `fs` | 原来在 ESM 里调 `require`，ReferenceError 被自己的 `catch` 吞掉，诊断文件从来没写出来过 |
> | 新增无浏览器登录（局域网扫码） | 插件在服务端申请二维码并自己长轮询，浏览器只显示页面、不碰回调地址 —— NAS / Docker 可用（上游 issue #4） |
> | 新增 `MAGPIE_MARVIS_RELAY_PORT` / `MAGPIE_MARVIS_RELAY_URL` | 容器里探测到的是 `172.17.x`，局域网打不开，得能指定对外地址 |

把**腾讯 Marvis**（应用宝 AI 助手）背后的模型接进 [magpie](https://usemagpie.ai) /
OpenCode —— 不用 API key，用你的 **QQ 或微信** 登录。



## 它能给你什么

| | |
|---|---|
| **模型** | DeepSeek V4.1 Flash（主路由 + 防降级路由，**两条都能识图**）、DeepSeek V4 Flash、Hy3、Claude Sonnet 4.6、Claude Opus 4.6、GPT-5.4、HY-Vision 2.0 instruct —— 共 8 个模型 |
| **额度** | 一个号每天 1000 万**计费** token（缓存免费 + 输入输出五折，实际能跑 2000 万～5000 万+） |
| **流式** | ✅ SSE 逐 token |
| **思考** | ✅ `reasoning_content` 可见 |
| **工具调用** | ✅ 完整 function calling |
| **系统提示词** | ✅ 完全可替换（`messages[0]`） |

## 计费 / 额度

Marvis 免费账号 **一个号每天 1000 万计费 token**（`total_tokens`）。

**计费公式**：

```
计费 token = 缓存读取（cache_read）× 0
           + （输入 + 输出）× 0.5
```

- **缓存命中完全免费** —— `prompt_tokens_details.cached_tokens` 那部分 × 0，一个 token 都不扣
- **输入、输出都打五折** —— 实际跑 2 个 token，才扣 1 个计费 token
- 「输入」指**未命中缓存**的输入；命中缓存的部分已经乘 0，不会重复算

⚠ **1000 万是「计费 token」，不是「你能用的 token」** —— 实际可用量远不止这个数。
一次 10,000 token 的对话，按缓存命中算下来只扣 2,000：

| 一次对话 | 实际 token | 计费 token |
|---|---:|---:|
| 缓存命中 | 6,000 | 0 |
| 新输入 | 2,000 | 1,000 |
| 输出 | 2,000 | 1,000 |
| **合计** | **10,000** | **2,000** |

**实际 : 计费 = 5 : 1** —— 1000 万计费额度 **≈ 5000 万实际 token**；
缓存命中越多，实际能跑得越多（全无缓存也还有 2 : 1，即 2000 万）。

卡片上的数字来自 `POST /v3/marvis_get_wallet`，四个字段：

| 字段 | 含义 | 典型值 |
|---|---|---|
| `total_tokens` | 总额度（**计费** token） | `10,000,000` |
| `used_tokens` | 已用（**计费** token） | `6,432,691` |
| `avail_tokens` | 可用（上游直接给；拿不到时按 `total - used` 兜底） | `3,567,309` |
| `frozen_tokens` | 冻结中（并发请求预扣，结算后释放） | `0` |

⚠ **卡片刻度条上的百分比看的是 `used_tokens / total_tokens`**（magpie 的 `usage.used`
语义就是「用了多少」），所以数字越大表示**用得越多**。想核对真实剩余，看卡片文本里的
`X 可用 / 共 Y` 更准。

额度耗尽后上游回 **403**，magpie 会按路由策略切到别的账号 —— 不是封号，
换个账号或等额度刷新即可。

## 装

```bash
magpie plugin add Tokieor/magpie-marvis
```

> 想用上游原版：`magpie plugin add MYCF711/magpie-marvis`（没有扫码登录，NAS 上会卡在「请装一个浏览器」）。

装完在 magpie 设置里 **供应商 → 添加 → 腾讯 Marvis**，选登录方式：

- **QQ 登录** / **微信登录**：自动打开一个隔离浏览器窗口，授权完窗口自己关掉，不用复制任何东西
- **微信扫码登录（手机扫，NAS / 远程推荐）** / **QQ 扫码登录（手机扫，NAS / 远程推荐）**：
  插件在本机临时起一个网页，你在**自己那台**浏览器打开它、用手机扫码即可 ——
  **不需要跑插件的那台机器上有浏览器**（NAS / Docker / 群晖 / 飞牛 都能用）
- **从本机 Marvis 导入**：装了 Marvis 客户端并且登录过的话，一条命令读出来
- **QQ / 微信登录（粘贴回调地址）**：magpie 跑在**没有浏览器、没有显示**的地方（NAS 容器、Linux 服务器、
  Docker/WSL）时用这条——授权页在你自己的浏览器里打开，登录完把地址栏那条
  `…marvis_oauth?login_type=…&code=…&state=…` 整条粘贴回 magpie 的输入框即可

> 这台机器上找不到 Chromium 时，前两条会**自动**变成扫码路（同一个按钮，不报错）。
> 扫码页地址形如 `http://192.168.1.9:端口/s/一次性token/`，**同一局域网**就能打开；
> 打不开多半是端口被防火墙或容器端口映射挡了。

## 没有浏览器的机器怎么登录（NAS / Docker）

扫码路的原理：二维码的 `uuid` / `qrsig` 由插件**在服务端**申请，也由插件在服务端长轮询；
你的浏览器只负责**显示**二维码和状态，**全程不碰回调地址** —— 所以 code 不会被浏览器消费掉。
（Marvis 的回调地址是固定的 `yybadaccess.3g.qq.com/.../marvis_oauth`，浏览器一旦真去请求它，
code 立刻作废。这也是为什么「把回调地址粘回来」这种做法行不通。）

流程：

1. magpie 里点「微信扫码登录（手机扫，NAS / 远程推荐）」
2. 它给一个局域网地址，用手机或电脑的浏览器打开
3. 微信 / QQ 扫码并确认，页面显示「登录成功」
4. 回到 magpie，账号已经在列表里了

二维码约 5 分钟过期，页面会自动换一张；整个过程不需要外网暴露端口，只在局域网内。

**magpie 跑在 Docker 里**（飞牛、群晖、Unraid 都一样）时，插件监听的是**容器内**的随机端口，
外面进不来。给 magpie 加两个环境变量，然后重新点一次登录：

| 环境变量 | 作用 | 例子 |
|---|---|---|
| `MAGPIE_MARVIS_RELAY_PORT` | 固定监听端口，容器上只映射这一个 | `18080` |
| `MAGPIE_MARVIS_RELAY_URL` | 外面实际能打开的地址（容器里探测不到） | `http://192.168.5.9:18080` |

```yaml
# docker compose
environment:
  - MAGPIE_MARVIS_RELAY_PORT=18080
  - MAGPIE_MARVIS_RELAY_URL=http://192.168.5.9:18080
ports:
  - "18080:18080"
```

两个都不设也能用 —— 前提是 magpie 用 host 网络，或者你能访问容器的内网 IP。

### 图片：URL 形式的附件

Marvis 只接受 `data:image/...;base64` 形态的图片。插件会把这三种输入自动转成它：

- 图片 `http(s)` URL —— 插件自己下载后转 base64（20 MiB 上限，只认 PNG / JPEG / GIF / WebP）
- 裸 base64 —— 认出图片头后补成 data URI
- Anthropic 的 `{ "type": "image", "source": { ... } }` —— 转成 OpenAI 的 `image_url`

转换不了就**本地 400**（`invalid_image`），不会静默丢图，也不会把无效输入丢给上游换个看不懂的错。

⚠ 出于防 SSRF，**指向本机 / 内网 / 保留地址的图片 URL 默认被拒**。如果附件就在你这台 NAS 上
（`http://192.168.5.9/...`），打开这个开关即可；其余校验（协议、大小、MIME、不跟随重定向）照旧：

| 环境变量 | 作用 | 例子 |
|---|---|---|
| `MAGPIE_MARVIS_ALLOW_PRIVATE_IMAGE_HOSTS` | 放行内网 / 本机图片地址 | `1` |

### 打开扫码页是 404 / 401 / 要求登录 magpie？

说明你打开的**是 magpie 自己的端口，不是插件的端口**。两者不是一个服务：

| 服务 | 监听在哪 | 例子 |
|---|---|---|
| magpie 本体（Go） | 容器内 `3430` | 宿主机 `23430:3430` |
| 扫码页（本插件） | 容器内 `MAGPIE_MARVIS_RELAY_PORT` | 宿主机 `18080:18080` |

- `404 page not found` 是 **Go 的默认 404** —— 看到这句话就说明请求打到了 magpie 本体
- magpie 本体对陌生路径会回 401「open the link magpie web printed…」，也不是插件的页面

所以 `MAGPIE_MARVIS_RELAY_URL` 里的端口必须是**映射到插件那个端口**的宿主机端口，不是 magpie 的端口。
验证（在局域网任意一台机器上）：

```bash
curl -I http://192.168.5.9:18080/     # 应当 200 + text/html
```

插件启动扫码时会自己访问一次这个地址，对不上会在 `docker logs` 里打印
`[magpie-marvis] 扫码页的对外地址返回 401…` 这样的告警。

### 403「非法请求」= 上游把 agent 身份句当内容指纹

上游的内容过滤会拦「system prompt 首行里的 agent 身份句」，比如：

| system 首行 | 结果 |
|---|---|
| `You are an AI agent running in OpenCode, a coding agent harness.` | 403 |
| `You are an AI agent powered by DeepSeek Harness.` | 403 |
| `You are Claude Code, Anthropic's official CLI tool for Claude.` | 403 |
| `You are a coding agent running in the Codex CLI, a terminal-based coding assistant.` | 403 |
| 同一句放到第 2 行 / user 消息里 | 200 |

判据是**词对**，不是字符：`You are` 紧邻产品名、`powered by` + `DeepSeek`、`running in` + 产品名。
往词中间插连字符（`Claude-Code`、`DeepSeek-Harness`、`Codex-CLI`）**已经不管用**了
（2026-11-16 复测仍 403），必须换实词。插件在**请求体这一层**做等价替换：

| 原始首行 | 改写后 | 实测 |
|---|---|---|
| `You are Claude Code, …` | `You're Claude Code, …` | 403 → 200 |
| `…powered by DeepSeek Harness.` | `…built on DeepSeek Harness.` | 403 → 200 |
| `…running in the Codex CLI…` | `…working in the Codex CLI…` | 403 → 200 |
| `…running in OpenCode…` | `…working in OpenCode…` | 403 → 200 |

所以：

- **不用**去改客户端二进制，也**不用**改客户端配置 —— 换任何宿主（OpenCode / DSH / Codex / Copilot）都生效
- 改写是幂等的：已经写成 `You're` / `built on` / `working in` 的，一个字节都不改
- 只动 `system` 首行：user / assistant / tool 里的同样文字上游本来就放行，改了反而多余

如果改写之后**仍然** 403，说明上游又加了一条没见过的指纹 —— 把当时的 system prompt 首行贴到
QQ 群 451129479，加一条规则即可。

## 设备指纹（不需要任何二进制）

请求头 `Ual-Access-MarvisExt` 里要带一个 **uskey**（设备指纹）和一个 `qimei36`。
这两个值由插件在本地生成，**不需要安装 Marvis 客户端，也不需要任何 DLL**。

早期版本曾经打包过 4 个 Windows 二进制来调用官方 SDK 现签，现在不再需要：
没有 `native/` 目录时插件会本地生成同样格式的值，功能完全一致。

> `native/` 仍然是**可选**的：如果你把 4 个文件放进插件目录，插件会优先用它们。
> 这 4 个文件是平台相关的二进制，不随本仓库分发。

## 一个 uskey 只能用两次

上游对 uskey 有配额：**同一个 uskey 第 3 次请求起 403**（等 75 秒仍 403，是配额不是频率）。
所以插件**每次请求都现签一个**（`getUskey()` 是本地调用，毫秒级，不联网）。

## 已知边界

- **非官方**：Marvis 随时可能改协议。改了就提 issue。
- **登录态 30 天**：`refresh` 会**成对轮换** token，旧的立刻失效。插件已经串行化了刷新
  （同账号同时只允许一次），但如果你在 Marvis 客户端里也登录同一个号，两边会互相打掉。
- **跨平台**：不需要任何 Windows 二进制，「从本机 Marvis 导入」这条登录路仅在 Windows 可用。
- **`/v1/chat/completions` 不需要 UAL 签名**：那是 `/v3/*` 业务接口的事。把签名头加到模型
  网关上会从 `403 风控` 变成 `401 登录态过期`。

### 合规与风险（自己用之前先看一眼）

- **未获授权**：插件走的是 Marvis 客户端用的**私有接口**（`yybadaccess.3g.qq.com`、
  `ptlogin2.qq.com` 等），复用了官方的 `appid` / `client_id`，并在本地**伪造设备指纹**
  （`uskey` 随机生成、`qimei36` 常为空）。这些都不是腾讯开放给你的接入方式。
- **可能违反服务条款**：腾讯的《QQ 互联服务协议》《微信开放平台协议》《腾讯服务协议》都禁止
  以非官方客户端方式访问、禁止绕过风控。实际后果通常落在**账号**上（限流、封号），
  但公开分发有被投诉下架的可能。
- **商标**：README、插件显示名（`magpie.name` = `腾讯 Marvis TENCENT`）里的「腾讯」「Marvis」
  「TENCENT」只用来**说明兼容对象**，不代表腾讯认可、授权或背书。
- **别公开分发**：想压低风险就把仓库设成私有。GitHub 的 fork **不能直接转私有** ——
  要么新建一个私有仓库再 `git push`，要么删掉 fork。
- **代码许可没问题**：代码是 MIT（见下方「许可」），可以自由 fork、修改、自用。
  上面说的是**接口使用**和**商标**，跟代码许可无关。

## 首行改写（供应商卡片里的两个开关）

被上游内容过滤拦下（403 `非法请求`）时，插件会对 system 提示词的**第一句**做处理。
开关就在**腾讯 Marvis 的供应商编辑器**里（和账号、路由、模型同一张卡，标题「插件选项 / Plugin options」）：

| 开关 | 默认 | 打开后 |
| --- | --- | --- |
| 被上游拒绝时改写首行 / `first_line_fallback` | **开** | 被 403 拦下的请求，把 system 首行换成兜底句**重试一次**；正常请求一个字节都不改 |
| 每个请求都改写首行 / `first_line_always` | 关 | 每个请求都把首行换成自定义那句（开了会先弹一次确认） |

两个都关 = 只走内置白名单（已知客户端的默认首句），不做任何兜底。

自定义那句写在插件行的 **Options**（JSON 编辑框）里，与开关是两套东西：

```json
{ "提示词首行替换": "" }
```

引号里留空 = 内置兜底 `You are a helpful assistant.`（不含任何 agent 产品名，实测 200）。
换掉的只是 system 消息的**第一行**，第二行起原样；改写是幂等的，前缀缓存不会反复失效。

> 开关是 magpie 自己的扩展点（`auth.options`，#2038）：点一下立刻保存，插件下一个请求就读到，**不用重启**。

自定义首行那句除了 JSON，还有一个**输入框**（`magpie.panels` 面板）。⚠ 面板清单是窗口启动时拉的：
用命令行更新插件后要按 **Ctrl+R** 或关掉窗口重开，输入框才会出现；开关不受影响。

> 两个开关都带 `placement: "top"`，所以画在**账号下面、路由上面**（magpie #5269）。
> 面板（输入框）没有位置字段，只能追加在编辑器末尾；想让它也置顶需要 magpie 上游支持。

## 你的号被降级了没有？跑一条命令

auto 家族（`main-auto` / `file-auto` / `computer-auto` / `browser-auto`）在服务端是**按账号**改路由的：
同一个槽位，A 号可能服务 `deepseek-v4-1-flash-261017`，B 号被换到某个**旧快照**。

⚠ **旧快照的名字不固定** —— 已知出现过 `deepseek-v4-flash-ga-260731`（issue #13）、
`deepseek-v4-flash-202605`（issue #43）。所以别记名字、也别信槽位名，
**只认响应体里的 `model` 字段**：

```bash
node scripts/probe-served-model.mjs          # 每个账号 × main-auto / 防降级槽位，各打一次
node scripts/probe-served-model.mjs --json   # 机器可读；退出码 2 = 有号被路由到别的快照
```

它绕开 magpie、直接用插件自己的 `llmHeaders()` 打上游（供应商关着也能跑），只读本机账号文件、不改任何配置。

被降级了怎么办：**换 `deepseek-v4-pro-external`（卡片上的 `deepseek-v4-flash-ga-260731-proexternal`）** ——
那条是固定映射，不受账号级改路由影响。

⚠ 但本 fork 的显示名写的是**本机实测值** `deepseek-v4-flash-ga-260731`，不是上游 `-antidowngrade` 暗示的
`261017`：2026-11-15 / 11-16 / 11-17 三轮、三个 QQ 账号实测，这个槽位回的一直是 `260731` 且不带推理。
显示名跟实测走，是为了不再出现「名字写 A、实际跑 B」——那正是 magpie 那条「很可能换成了别的模型」警告的来源。

## 开发

```bash
node scripts/check.mjs      # 合规检查（退出码非 0 就是不合规）
node --test                 # 语义测试
node tests/e2e-live.mjs     # 真实网关端到端（需要有效登录态）
```

## 许可

MIT。详见 [LICENSE](./LICENSE)，归属说明见 [NOTICE.md](./NOTICE.md)。

- 上游版权：Copyright (c) 2026 [MYCF711](https://github.com/MYCF711)，以及 `NOTICE.md` 里列出的各 MIT 项目作者
- 本 fork 的修改：Copyright (c) 2026 [@Tokieor](https://github.com/Tokieor)

> 上游 `LICENSE` 的版权行原本是模板占位符（`Copyright (c) 2026 YOUR NAME`）。
> 本 fork 按 MIT 的要求补成了实际归属 —— MIT 允许你改，但**必须保留版权声明**。
