/**
 * 解析钩子：把 DSH 自带的包（`@deepseek-ai/schemastery` 及其依赖）
 * 映射到本地导出目录。
 *
 * ## 为什么需要它
 *
 * 生产代码 `src/host/config-schema.js` 用**裸标识符**导入 schemastery ——
 * 那是 DSH 的规范做法（`cordis-plugin-loader` 用 `createRequire(import.meta.url)`
 * 加载插件，锚点在 DSH 那边，所以裸标识符能解析到 DSH 自己的依赖）。
 *
 * 但单测是脱离 DSH 跑的，本机也没装这个包，于是解析失败。
 * 与其为了"能单测"去改生产代码（加环境变量分支之类），不如在**测试这一侧**
 * 用一个 Node 解析钩子把裸标识符指到从 app.asar 导出的那份 ——
 * 生产代码保持干净，测试的痕迹全部留在测试里。
 *
 * ## 用法
 *
 * 由 `test-config-schema.mjs` 用 `module.register()` 注册，
 * 并通过 `data.vendorDir` 传入导出目录（该目录下有 `node_modules/@deepseek-ai/...`）。
 */

import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

/** 需要改道的包名。schemastery 依赖 cosmokit，两个都要。 */
const REROUTED = new Set(['@deepseek-ai/schemastery', '@deepseek-ai/cosmokit'])

export function initialize(data) {
  return { vendorDir: data?.vendorDir ?? '' }
}

export async function resolve(specifier, context, nextResolve) {
  // 先让默认解析试一次：DSH 环境里本来就是能解析的，不该干扰。
  try {
    return await nextResolve(specifier, context)
  } catch (err) {
    /*
     * ⚠️ 解析钩子跑在**另一条线程**，模块级变量与 `data` 都可能拿不到实时值；
     * `process.env` 才是能可靠共享的通道（子线程继承父进程的环境变量）。
     */
    const vendorDir = process.env.DSH_PET_VENDOR_DIR ?? ''
    if (!REROUTED.has(specifier) || !vendorDir) throw err
    // 改道到导出目录；包自己的依赖（cosmokit）会从该目录的 node_modules 解析。
    const main = join(vendorDir, 'node_modules', specifier, 'lib', 'index.mjs')
    return { url: pathToFileURL(main).href, shortCircuit: true }
  }
}
