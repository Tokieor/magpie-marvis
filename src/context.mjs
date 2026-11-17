// 共享上下文 —— 所有钩子都读这一份
//
// 这个插件只服务一个站点：腾讯 Marvis（应用宝 AI 助手）。
// 上游只有一个：https://yybadaccess.3g.qq.com
//   推理   /v1/chat/completions   （OpenAI 兼容，不需要 UAL 签名）
//   业务   /v3/*                  （钱包、用户信息；需要 md5 签名）
//
// ⚠ 模型表来自 Marvis 自己的 `_internal/CONFIG`（Fernet 加密的 config_defaults.yaml）。
//   `model` 字段填的是**槽位名**，服务端再路由到真实模型
//   （例：`main-auto` → 实际 `deepseek-v4-1-flash-261017`）。
//   响应体的 `model` 字段会回真实模型名，看那个才是准的。

/** 厂商 id：agent 用 `<id>/<model>` 命名 */
export const PROVIDER = "marvis"

/** 卡片上显示的供应商名：必须 <中文> <English> */
export const PROVIDER_NAME = "腾讯 Marvis TENCENT"

/** 业务接口基址（/v3/*：用户信息、钱包） */
export const BASE = "https://yybadaccess.3g.qq.com"
/** 推理 API 基址 —— loader 的 baseURL，SDK 会拼成 <baseURL>/chat/completions */
export const BASE_V1 = `${BASE}/v1`

/** 决定 API 形状：Chat completions */
export const SDK = "@ai-sdk/openai-compatible"

/** 上游 business id（请求头 Ual-Access-Businessid） */
export const BUSINESS_ID = "marvis_client"

/** 业务接口签名用的 accessKey —— 明文硬编码在 Marvis 渲染层里，不是密钥 */
export const ACCESS_KEY = "fpzkeTlcGLVP37qiOWd29MyaOqaJYxMi"

/** QQ 互联 appid / 微信开放平台 appid（登录用） */
export const QQ_APP_ID = "1903794758"
export const WX_APP_ID = "wxb650708317d56f88"

/**
 * 续期端点（**POST**，body 是 `{userInfo:{openId, refreshToken, accessToken, loginType}}`）。
 *
 * ⚠ 0.2.13 及以前调的是 `GET /v3/marvis_refresh_token?refresh_token=…` ——
 *   **那个不是续期端点**，恒定回 `-109 RefreshToken missing required param`。
 *   结果：续期从来没成功过。QQ 的 token 30 天没走完所以看不出来，
 *   微信的只有 2 小时，登录完几小时就 401。
 *   实测依据见 `docs/reverse/B-auth.md` §5.2 / §6.3（2026-11-07 复验 `code:0 RC_SUCCESS`）。
 */
export const REFRESH_PATH = "/marvis_client_login/marvis_refresh_token"

/** 登录类型码：QC = QQ 登录（1），WX = 微信登录（2）。对应 `Ual-Access-Login-Type` */
export const LOGIN_TYPE = { QC: "1", WX: "2" }

/**
 * 发出去的 UA。
 * 模型请求必须用 Marvis agent 自己的 UA（`AsyncOpenAI/Python 2.32.0`）——
 * 换成别的会被风控拦（4100404）。这不是「伪装」，是这个端点的准入条件。
 */
export const CLIENT = "AsyncOpenAI/Python 2.32.0"
/** 业务接口（/v3/*）用的浏览器 UA，同样照抄 Marvis 自己的 */
export const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Marvis/1.60.3300.408 Chrome/152.0.7977.130 Electron/44.7.0 Safari/537.36"

/** 图标 —— 两处必须一致：这里 + package.json 的 magpie.icon */
export const ICON =
  "data:image/png;base64,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Jnjb294mTz755AxF2B+LMEhUFRH553/+5z41vbQ2//Iv/3JYsw/m0/xv2rSpr+mLVQmWLVsmX/ziF6XRaMy4v6Io+i6ixA/Kn51zMwTabrflz//8z/uLYdDSHFUWoOTllyYvhCDvec97Fo0L2J0SAHLKKafI5z73Odm0adM+z0ez2ZR/+qd/kle96lUzUs5Bq/jDH/7wsCqAkiOEre6OUPnss89y2mmn0Wq1FiXxotw+Xpabq9Uqr3vd6/iVX/kVzjrrLF760pcyNjZGFEV0Oh22bdvGY489xp133sl3v/tdnnjiiRmw8yAdrVqtsnHjRlasWHH4NqAeqZUvIjIxMSEf/vCH5ZxzzpF3vvOd8p3vdNnoX/nKVxatFRgEjHYHW9dqNRkZGenD27OtyGzQq5yHc845Z/HjAKXZL4pCzjvvvF0m4PWvf7184xvfkJe//OUz8PfF+ir9dxnM7c517OnzUpH+4i/+4rDDzxwppO9jH/uYABLHsWitd9H8Wq22qAW/N6XY10BXKdW3Jg8//PBhL0NzJNK96667breVvSOF+5erbjDK3ldiyXwgju94xzuOyA7kwxYEhhBQSvHss89y5plnMjk52ad4HVH2Y48ruKfz7utmkSMVUJbcx9NPP/2w70ewhzPq11pz0UUXMTExgTHmiBMqBiPr8847jwsuuIBXv/rVpGnKE088werVq7nmmmv6EfZ8Ez6stRRFwV//9V+zatWqPhl20RFCSrP11a9+dd5IHWUkffLJJ8vNN9+822tds2ZNn284nwFoFEUCyG/91m/15/BIlIU5XESG5557TsbGxg6KmHmwwn/Tm94kW7dunROdc8718fd7771XhoaG5q0gVc7PeeedJ81m84gyjzhcq//d7373vKz+UvjnnnuuNJvNGcWauSY1y7qk6Msvv3xesIhygVx88cXinDvkFcYjqgCl8O+88855ncxly5b16+h5ns+IpGdH1SVG32w2+65gf6xAmdIeaDZTXvNHPvIRee6553Z7nYtCAUrzf+65586LApTnu/rqq2esbhGRVqslnU5nj1jFhz70oX22Wru7twNxeaXCLVu2TL70pS/1XdORsAYcLnbPfAn/ta997QxyxZYtW+Tiiy+WE088UU466ST59Kc/3V/1pUsoXcS+XPtsQOfMM8+UCy64QN7+9rf3uQ0HElAOnvPss8+W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"

/**
 * 距到期多久开始调 `auth.refresh`。
 *
 * ⚠ 0.2.13 及以前是 **24 小时**，理由是「token 30 天有效，提前 1 天」。
 *   但**微信的 token 只有 2 小时**（`expires_in=7200`，实测），
 *   24 小时的提前量意味着「从登录那一刻起就永远该刷新」——
 *   配合错误端点（每次 -109），账号在第一次 401 后就被标成「需要重新登录」。
 *
 *   5 分钟对两种登录方式都成立：微信 1h55m、QQ 29 天 23h55m。
 */
export const REFRESH_LEAD_MS = 5 * 60_000

/** 默认输出上限（Marvis 的 default 槽位写的是 32000） */
const DEFAULT_OUTPUT = 32_000

/**
 * 静态模型表 —— 没人登录时也能显示。
 *
 * 每条：`[槽位 id, 显示名, 上下文, 能力]`
 *   · `auto` 结尾的是服务端自动路由槽位（"按任务难度匹配 Hy4 / DeepSeek V4.1 Flash"）
 *   · 其余是显式模型
 *
 * ⚠ 只列**真实存在**的槽位（来自 config_defaults.yaml 的 25 条注册表），
 *   不猜、不补。`local_model` / `warmup_model` / `*placeholder` 是内部占位，不对外。
 */
const TABLE = [
  // ⚠ 上下文窗口：实测 main-auto 发 400,000 字符（190,511 tokens）返回 200，
  //   已远超 config_defaults.yaml 声明的 128k —— 所以按 1M 声明（用户要求，出问题再调）。
  // ⚠ 2026-11-06 逐槽位实测（每槽连发 5 次、5 种不同难度提示词，路由 100% 稳定）。
  //   显示名 = **真实模型名**，槽位名写进 id —— 卡片上看到的就是实际在跑什么。
  // ⚠ 真实模型 id 不能直接当 `model` 传（会 400 无效模型id），只能填槽位名。
  //
  // 为什么不列 file-auto / computer-auto / browser-auto / app-auto：
  //   前三个实测**全部**路由到 `deepseek-v4-1-flash-261017`，和 main-auto 一模一样，
  //   列出来只会在列表里重复 4 条同名模型。main-auto 是主对话槽位，最稳定，留它一个。
  //
  // 已移除（上游 400 无效模型id / 500 / 空响应，不是我们这边的问题）：
  //   glm-5v-turbo-thinking · claude-opus-4-6-thinking · memory-compress · profile-request-placeholder
  //   kimi-k2.5（500 RPC）· hunyuan-2.0-instruct-20251111（空响应）· venus-vision-llm（→ default）

  // ── DeepSeek ────────────────────────────────────────────────
  // ⚠ main-auto **必须**带 `vision: true`（issue #8）：上游这个槽位能识图，
  //   漏了它 `staticModels()` 会写 `attachment:false`、`providerModels()` 会写
  //   `capabilities.input.image:false`，magpie 在入口就把带图请求 400 掉，
  //   用户看到的是「deepseek flash 用不了图片」——而上游其实 200。
  //   `efforts` 来自上游 0.2.31：这个槽位支持 low/high/max 三档推理强度。
  ["main-auto", "deepseek-v4-1-flash-261017", 1_000_000, { reasoning: true, tools: true, vision: true, efforts: ["low", "high", "max"] }],
  // ⚠ 显示名跟**实测**走，不跟名字暗示走：2026-11-15 / 11-16 / 11-17 三轮、三个 QQ 账号实测，
  //   该槽位回的一直是 `deepseek-v4-flash-ga-260731`（且**不带推理**），不是 pro，也不是 4.1f。
  //   上游 0.2.23 起把它写成 `deepseek-v4-1-flash-261017 (防降级)` / `-antidowngrade`，理由是
  //   「固定映射能拿到 4.1f」——**这个结论在我们的账号上不成立**（2026-11-17 复测仍然如此），
  //   照抄会把显示名写成 A、实际跑 B，正是 magpie「很可能换成了别的模型」那条警告的来源。
  //
  //   ⚠ 后缀与 hy3-preview-agent（同样回 260731）区分开，且必须**纯 ASCII、不带空格与括号**
  //     （issue #15：显示名会被客户端拿去做 header / URL，非 ASCII 与空格会让 VS Code Copilot
  //     卡在回复阶段）。所以用连字符拼的 `-proexternal`，不用 ` (pro-external slot)`。
  //
  //   ⚠ 被改路由的号落到的旧快照名字**不固定**（已知 260731 / 202605，issue #43）——
  //     所以这里只是「本机实测值」，不是「上游承诺值」。自查用 `node scripts/probe-served-model.mjs`。
  ["deepseek-v4-pro-external", "deepseek-v4-flash-ga-260731-proexternal", 1_000_000, { reasoning: true, tools: true, vision: true, efforts: ["low", "high", "max"] }],
  ["hy3-preview-agent", "deepseek-v4-flash-ga-260731", 1_000_000, { reasoning: true, tools: true }],

  // ── 其他厂商 ─────────────────────────────────────────────────
  ["hy3-preview-agent-real", "hy3", 1_000_000, { reasoning: true, tools: true }],
  ["claude-sonnet-4-6", "claude-sonnet-4-6", 1_000_000, { reasoning: true, tools: true, vision: true }],
  ["claude-opus-4-6", "claude-opus-4-6", 1_000_000, { reasoning: true, tools: true, vision: true }],
  ["gpt-5.4", "gpt-5.4-2026-03-05", 1_000_000, { reasoning: true, tools: true, vision: true }],
  ["hunyuan-turbos-vision", "HY-Vision-2.0-instruct", 32_000, { vision: true }],
]

/**
 * 旧版存量的模型 ID 别名。
 *
 * ⚠ 0.2.x 的 `staticModels()` 返回的是数组，magpie 把它持久化成了数组下标
 * `"0"…"7"`；路由组因此写着 `marvis/0`，请求体里的 `model` 也是 `"0"`，
 * 上游会回 `400 无效模型 id`。
 *
 * 新配置会改成按槽位名存，但用户已有的路由不能作废 —— 所以在 loader 里
 * 把纯数字 ID 映射回 TABLE 顺序对应的槽位，旧路由继续可用。
 */
export const MODEL_ALIASES = Object.freeze(
  Object.fromEntries(TABLE.map(([id], index) => [String(index), id])),
)

/**
 * provider 卡片里的开关（magpie 的 `auth.options`，#2038）。
 *
 * magpie 把每条渲染成一行 Off/On 开关，放在供应商编辑器里（和账号、路由、模型同一张卡），
 * 用户点一下立刻保存；插件用 `input.magpie.option("marvis", key)` 读，
 * **改完不用重启、下一个请求就生效**。
 *
 * 位置：条目上写 `placement: "top"` 就会被画在**账号下面、路由上面**（magpie #5269）；
 * 不写（或写别的）则排在模型之后、高级折叠之前。我们两条都放 top —— 这两个开关是这张卡上
 * 唯一需要用户先看的设置，排在路由/模型之后基本等于找不到。
 *
 * 字段约束（magpie 侧强校验，写错就整条被丢）：`key` 必须 `[a-z0-9_-]{1,40}` 且唯一；
 * `label` ≤60 字符；`description` ≤300；`labels` / `descriptions` / `confirms` 是多语言版本
 * （`{"zh": "…"}`），`label` 本身必须留着，老版本 magpie 只读它。最多 16 条。
 *
 * ⚠ **这里不写 `description`**：magpie 的 `.plugin-options`（`plugin-options` 是
 * `display:flex` 的 `.stack`）只给每个选项留了一行的高度，多出来的那行会**压在下一个 field
 * （模型列表）上**（0.2.47 / 0.2.48 实测，两张截图）。插件的渲染自己改不了，能改的只有
 * 「让每条只占一行」—— 所以说明写进 `label`（≤60 字符），`description` 一律留空。
 */
/**
 * 插件选项里的那个键：**就是给用户看的字段名**，所以用中文。
 *
 * 设置 → 插件 → 本插件那一行的「选项」框里，用户看到的就是
 * `{ "提示词首行替换": "You are a helpful assistant." }`。
 * 键名是我们自己定的（magpie 只要求值是一个对象），随时能改；改成中文以后
 * 不用猜 `text` 是什么意思。老版本存过的 `text` / `firstLine.text` 仍然读。
 */
export const FIRST_LINE_OPTION_KEY = "提示词首行替换"

export const PLUGIN_OPTIONS = Object.freeze([
  Object.freeze({
    key: "first_line_fallback",
    label: "Rewrite the first line when the upstream refuses it (403)",
    labels: {
      zh: "被上游拒绝时改写首行：内容过滤拦下（403）时把 system 首行换成兜底句重发一次",
      "zh-TW": "被上游拒絕時改寫首行：內容過濾攔下（403）時把 system 首行換成兜底句重發一次",
    },
    default: true,
    placement: "top",
  }),
  Object.freeze({
    key: "first_line_always",
    label: "Rewrite the first line of every request",
    labels: { zh: "每个请求都改写首行：把 system 首行换成设置 → 插件里本插件「选项」那句，留空用兜底句" },
    default: false,
    placement: "top",
    confirm: "Every request will have its system prompt's first line replaced, including the ones that would work as they are.",
    confirms: {
      zh: "之后每个请求的 system 首行都会被换掉，包括本来能正常通过的那些。",
    },
  }),
])

/**
 * 槽位「应该」服务哪个上游模型名 —— 自查探针与测试共用。
 *
 * ⚠ 不能直接拿 `DISPLAY_BY_SLOT` 比：显示名里有**我们加的后缀**
 *   （`deepseek-v4-1-flash-261017-antidowngrade`），而上游回的 model 一直是
 *   `deepseek-v4-1-flash-261017`。后缀只是 UI 标记，剥掉才是上游名字。
 *
 * @param {string} slot
 * @returns {string}
 */
export const OURS_DISPLAY_SUFFIX = "-proexternal"

export function expectedServedModel(slot) {
  const display = DISPLAY_BY_SLOT[slot] ?? slot
  return display.endsWith(OURS_DISPLAY_SUFFIX) ? display.slice(0, -OURS_DISPLAY_SUFFIX.length) : display
}

/** 槽位名 → 卡片/路由上显示的真实模型名 */
export const DISPLAY_BY_SLOT = Object.freeze(
  Object.fromEntries(TABLE.map(([slot, name]) => [slot, name])),
)

/**
 * 已下线的**旧显示名** → 当前槽位。
 *
 * ⚠ 与 `MODEL_ALIASES`（数字下标）分开：那个锁的是 TABLE 位置契约，这个只管改过名的条目。
 *
 * 用户的路由组里可能还写着旧名字（`marvis/deepseek-v4-pro-202606`）——
 * 不归一就会被原样发给上游，回 `400 无效模型id`，等于升级即打断在用的路由。
 *
 * 收录的旧名：
 *   · `deepseek-v4-pro-202606`      —— 0.2.22 及以前的展示名
 *   · `deepseek-v4-1-flash-261017 (防降级)` —— 上游 0.2.23/0.2.24 的展示名（本 fork 从没发过，
 *                                   但从上游版本切过来的用户路由里可能有）
 */
const LEGACY_DISPLAY_ALIASES = Object.freeze({
  "deepseek-v4-pro-202606": "deepseek-v4-pro-external",
  // 0.2.23 / 0.2.24 用过的带中文后缀的显示名，以及上游 0.2.25+ 的 ASCII 名 ——
  // 已经写好它们的路由组不能因此 400。
  "deepseek-v4-1-flash-261017-antidowngrade": "deepseek-v4-pro-external",
  // 本 fork 用过的两种后缀名：0.2.28 的带空格 ASCII 版、0.2.28 前的中文版
  // （带空格 / 非 ASCII 会让 Copilot 卡住，见 issue #15，故都收进归一表）
  "deepseek-v4-flash-ga-260731 (pro-external slot)": "deepseek-v4-pro-external",
  "deepseek-v4-flash-ga-260731 (pro-external 槽位)": "deepseek-v4-pro-external",
  "deepseek-v4-1-flash-261017 (防降级)": "deepseek-v4-pro-external",
})

/** 真实模型名 → 上游接受的槽位名 */
export const SLOT_BY_DISPLAY = Object.freeze(
  Object.fromEntries(TABLE.map(([slot, name]) => [name, slot])),
)

/**
 * 把模型 ID 归一成上游槽位名；未知 ID 原样返回。
 * 支持：旧数字下标 `"0"`、已下线的旧显示名、真实模型名、已经是槽位名。
 * @param {unknown} model
 * @returns {string}
 */
export function canonicalModelId(model) {
  const id = String(model ?? "")
  return MODEL_ALIASES[id] ?? LEGACY_DISPLAY_ALIASES[id] ?? SLOT_BY_DISPLAY[id] ?? id
}

/** 已确认会持续失败、必须在本地拦截的模型 ID；其他旧槽位仍由上游判定。 */
export const UNAVAILABLE_MODEL_IDS = Object.freeze(["kimi-k2.5"].map((id) => id.trim().toLowerCase()))

/**
 * 模型是否属于明确的不可用名单。
 * 不能用 TABLE allowlist 代替：TABLE 是对外展示目录，旧版真实槽位可能仍可用。
 *
 * ⚠ 比对前先 **trim + 转小写**：手工配置 / 旧路由里会写成 `"kimi-k2.5 "`、
 *   `"Kimi-K2.5"` 这类形态，不归一就会绕过 denylist，把已确认持续失败的模型
 *   重新发到上游（config 合并和 loader 本地拦截都读这个函数）。
 * @param {unknown} model
 * @returns {boolean}
 */
export function isUnavailableModel(model) {
  const id = String(model ?? "").trim().toLowerCase()
  return UNAVAILABLE_MODEL_IDS.includes(canonicalModelId(id))
}

/**
 * 把槽位名归一成真实模型名（config/provider 的 `id` 用它显示）。
 * @param {unknown} model
 * @returns {string}
 */
export function displayModelId(model) {
  const id = String(model ?? "")
  return DISPLAY_BY_SLOT[id] ?? id
}

/**
 * 推理挡位 → OpenCode `variants` 形状（键是挡位名，值映射成请求里的 `reasoningEffort`）。
 *
 * Magpie 用这份 metadata 生成 Codex 的 `supported_reasoning_levels` 与 DSH 的
 * `reasoningEfforts`；不声明就会落到客户端默认值 —— DSH 的 DeepSeek 模型会因此
 * 缺 low / high / max 三挡（2026-11-15 实测 Marvis 的 4.1f 就这三挡）。
 */
function variantsOf(efforts) {
  return Object.fromEntries(efforts.map((effort) => [effort, { reasoningEffort: effort }]))
}

/**
 * 静态模型表（`config` 钩子用）—— 没人登录时也能显示。
 *
 * ⚠ 这是 **OpenCode `#quick` 形状**，与 `provider.models` 返回的形状**不同**：
 *   · 工具能力叫 `tool_call`（有下划线）
 *   · 能力写在 `modalities` 里，`input` / `output` 是**数组** `["text","image"]`
 *   · 收图能力是 `attachment: boolean`
 *   两个位置写混不会报错，只会让「能不能调工具 / 能不能收图」静默为假（HOOKS 十一之三）。
 */
export function staticModels() {
  /** @type {Record<string, any>} */
  const out = {}
  for (const [slot, name, context, cap] of TABLE) {
    out[name] = {
      id: name,
      apiId: slot,
      name,
      // 收图能力：模型级 `attachment`，config 形状就是它
      attachment: Boolean(cap.vision),
      modalities: {
        input: cap.vision ? ["text", "image"] : ["text"],
        output: ["text"],
      },
      tool_call: Boolean(cap.tools),
      reasoning: Boolean(cap.reasoning),
      ...(cap.reasoning && cap.efforts ? { variants: variantsOf(cap.efforts) } : {}),
      limit: { context, output: DEFAULT_OUTPUT },
      ...(cap.search ? { searches: true } : {}),
    }
  }
  return out
}

/**
 * `provider.models` 钩子返回的形状 —— **OpenCode `Model` 形状**，与静态表不同：
 *   · 工具能力叫 `toolcall`（无下划线）
 *   · `capabilities.input` / `output` 是**对象**，五个模态键必须是布尔值
 *     （漏 `image` 等于「厂商未表态」，magpie 会去 models.dev 投票，导致收不了图的模型被当成能收图）
 *   · `api.id` 必须是**上游模型 id**（= 槽位名）。漏了它 magpie 会把数组下标当模型 id，
 *     路由里显示 `0`、请求发 `model:"0"`，上游回 400 无效模型 id。
 *
 * ⚠ text-only 的接口也必须写全五个键 —— 只写 `text: true` 等于没说。
 *
 * @returns {Record<string, any>}
 */
export function providerModels() {
  /** @type {Record<string, any>} */
  const out = {}
  for (const [slot, name, context, cap] of TABLE) {
    out[name] = {
      id: name,
      name,
      api: { id: slot, url: BASE_V1, npm: SDK },
      status: "active",
      capabilities: {
        reasoning: Boolean(cap.reasoning),
        attachment: Boolean(cap.vision),
        toolcall: Boolean(cap.tools),
        input: {
          text: true,
          image: Boolean(cap.vision),
          audio: false,
          video: false,
          pdf: false,
        },
        output: { text: true },
      },
      ...(cap.reasoning && cap.efforts ? { variants: variantsOf(cap.efforts) } : {}),
      limit: { context, output: DEFAULT_OUTPUT },
      ...(cap.search ? { searches: true } : {}),
    }
  }
  return out
}

/** 默认模型（magpie 路由的兜底） */
export const DEFAULT_MODEL = "main-auto"
