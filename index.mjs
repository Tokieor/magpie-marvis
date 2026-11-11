// 腾讯 Marvis 的 magpie 供应商插件
//
// 这个文件只做**装配**：钩子实现全在 src/ 里。改哪一块就去看哪个文件。
//
//   ① config          src/hooks/config.mjs        声明 provider + 静态模型表
//   ② auth.methods    src/hooks/methods.mjs       QQ / 微信 登录 · 从本机导入
//   ③ auth.refresh    src/hooks/refresh.mjs       /v3/marvis_refresh_token（串行，成对轮换）
//   ④ auth.loader     src/hooks/loader.mjs        换 Ual-Access-*、每请求现签 uskey、错误分流
//   ⑤ auth.usage      src/hooks/usage.mjs         令牌钱包
//   ⑥ provider.models src/hooks/models.mjs        静态注册表（上游没有模型接口）
//
// ═══ 三条铁律 ═══════════════════════════════════════════════════════
//   1. config.models 必须有内容 —— 未登录也要有，否则显示 "0 models"
//   2. authorize() 立刻返回 —— 等用户放在 callback() 里
//   3. refresh 返回的是**合并**语义 —— 只给新字段会覆盖旧的
//
// ═══ 上游 ═══════════════════════════════════════════════════════════
//   模型   https://yybadaccess.3g.qq.com/v1/chat/completions   （OpenAI 兼容，不要 UAL 签名）
//   业务   https://yybadaccess.3g.qq.com/v3/*                  （要 md5 签名）
//
// 非官方插件：Marvis 的接口随时可能变，边界见 README「已知边界」。

import { configHook } from "./src/hooks/config.mjs"
import { authHooks } from "./src/auth.mjs"
import { modelsHook } from "./src/hooks/models.mjs"
import { localBrowserAvailable } from "./src/hooks/methods.mjs"
import { authorizeUrl } from "./src/marvis/login.mjs"
import { startRelayLogin } from "./src/marvis/relay.mjs"
import { PROVIDER, PROVIDER_NAME, BASE_V1, staticModels, providerModels, DEFAULT_MODEL } from "./src/context.mjs"

export const MarvisAuthPlugin = async (_input) => {
  return {
    config: configHook(),
    auth: authHooks(),

    provider: {
      id: PROVIDER,
      models: modelsHook(),
    },
  }
}

// 供测试引用（⚠ 入口里只导出**一个**函数，否则会被当成多个插件）
export const _internal = {
  PROVIDER,
  PROVIDER_NAME,
  BASE_V1,
  staticModels,
  providerModels,
  DEFAULT_MODEL,
  // 登录相关的纯函数 / 环境判断：测试要能确定性地断言，不能依赖「这台机器有没有浏览器」
  authorizeUrl,
  localBrowserAvailable,
  startRelayLogin,
}
