/**
 * 解析钩子：让裸标识符按 **DSH 的真实优先级**解析。
 *
 * ## 为什么要写这个
 *
 * DSH 里插件能不能加载，取决于裸标识符怎么解析。但它的解析走的是
 * **Node 私有 API**（`internal/modules/esm/loader`，需要 `--expose-internals`），
 * 本机拿不到 —— 所以脱离 DSH 时插件的 `import '@deepseek-ai/...'` 一律失败，
 * 那会掩盖真正的问题（我因此在排查上绕了好几圈）。
 *
 * 这个钩子按**与 DSH 一致的优先级**自己解析：
 *
 *   1. `$DSH_PROFILE_DIR/node_modules/` —— 插件装在 profile 里，依赖装在这里
 *      （例：`@deepseek-ai/schemastery` 是声明过的依赖，pnpm 装到 profile）；
 *   2. DSH 的 `app.asar` —— DSH 会把一部分包注入给插件
 *      （例：`@deepseek-ai/dsh-tools`、`@deepseek-ai/cordis`）。
 *
 * ⚠️ 顺序很要紧：**profile 优先**。反了的话 `schemastery` 会解析到 asar 里
 * DSH 自用的那份副本，于是"你没声明依赖"这种问题就测不出来。
 *
 * ⚠️ 必须用 **Electron 以 Node 模式**跑：纯 Node 的 `createRequire` 不认 asar。
 *
 * 由探测脚本通过 `module.register()` 注册；两个目录经环境变量
 * `DSH_PET_PROFILE_DIR` / `DSH_PET_ASAR` 传入（子线程继承环境变量）。
 */

import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ASAR = process.env.DSH_PET_ASAR ?? ''
const PROFILE_DIR = process.env.DSH_PET_PROFILE_DIR ?? ''

/** 在 profile 的 node_modules 里试解析。 */
function fromProfile(specifier) {
  if (!PROFILE_DIR) return null
  const anchor = join(PROFILE_DIR, 'package.json')
  if (!existsSync(anchor)) return null
  try {
    return createRequire(anchor).resolve(specifier)
  } catch {
    return null
  }
}

/** 在 DSH 的 asar 里试解析（DSH 注入的那类包）。 */
function fromAsar(specifier) {
  if (!ASAR) return null
  const anchor = `${ASAR}/dsh/node_modules/@deepseek-ai/cordis-plugin-loader/lib/index.js`
  try {
    return createRequire(anchor).resolve(specifier)
  } catch {
    return null
  }
}

export async function resolve(specifier, context, nextResolve) {
  // 相对路径、node: 内建等交给默认解析（能成功就不插手）。
  try {
    return await nextResolve(specifier, context)
  } catch (err) {
    if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) throw err

    const viaProfile = fromProfile(specifier)
    if (viaProfile) return { url: pathToFileURL(viaProfile).href, shortCircuit: true }

    const viaAsar = fromAsar(specifier)
    if (viaAsar) return { url: pathToFileURL(viaAsar).href, shortCircuit: true }

    throw err
  }
}
