/**
 * 解析钩子：把 DSH 自带的包（`@deepseek-ai/*`）指向 DSH 安装目录里的 app.asar。
 *
 * ## 为什么需要
 *
 * 生产插件用**裸标识符** `import { defineTool } from '@deepseek-ai/dsh-tools'`
 * —— 这是 DSH 的规范做法，由 Loader 的模块解析负责。
 *
 * 但那个解析是 **Node 私有 API**（`internal/modules/esm/loader` 的
 * `getOrInitializeCascadedLoader()`，需要 `--expose-internals`），本机拿不到。
 * 所以脱离 DSH 时，插件的裸标识符一律解析失败：
 *
 *   Cannot find package '@deepseek-ai/dsh-tools' imported from .../src/host/index.js
 *
 * 这个失败是**探测方式的问题**，不是插件的问题 —— 但如果因此就放弃探测，
 * 就永远测不到 `apply()`（插件真正干活的地方）。
 *
 * 解法：自己写一个解析钩子，把这些标识符**映射到 asar 里的真实文件**。
 * 映射用 `createRequire`（它能认 asar）解析出真实路径，再交给默认 ESM 加载器。
 *
 * ⚠️ 必须用 **Electron 以 Node 模式**跑：纯 Node 的 `createRequire` 也不认 asar。
 *
 * 用法：由 probe-apply.mjs 通过 `module.register()` 注册，
 * 目标 asar 路径经环境变量 `DSH_PET_ASAR` 传入（子线程继承环境变量）。
 */

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

/** 需要改道的包前缀。 */
const PREFIX = '@deepseek-ai/'

export async function resolve(specifier, context, nextResolve) {
  // 先让默认解析试一次：能解析就不插手（例如相对导入、node: 内建）。
  try {
    return await nextResolve(specifier, context)
  } catch (err) {
    const asar = process.env.DSH_PET_ASAR ?? ''
    if (!asar || !specifier.startsWith(PREFIX)) throw err

    // createRequire 认 asar，用它把标识符解析成真实文件路径。
    const anchor = `${asar}/dsh/node_modules/@deepseek-ai/cordis-plugin-loader/lib/index.js`
    const req = createRequire(anchor)
    let resolved
    try {
      resolved = req.resolve(specifier)
    } catch {
      throw err
    }
    return { url: pathToFileURL(resolved).href, shortCircuit: true }
  }
}
