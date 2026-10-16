/**
 * 验证：**从插件的真实路径出发，ESM 能不能解析到裸标识符**。
 *
 * ## 为什么单独测这一条
 *
 * `failed to import` 这个报错的根因就是它。ESM 解析裸标识符时，会从**引用方文件**
 * 所在目录开始，逐级往上找 `node_modules`。本插件的布局很特殊：
 *
 * ```
 * profiles/desktop/node_modules/dsh-pet-ds   ← 指向下面的 Junction
 *          │
 *          └──► D:\dsh\pet                    ← ESM 解析的**真实锚点**
 *               ├── node_modules/             ← 依赖必须在这里，否则解析不到
 *               ├── src/host/index.js
 *               └── ...
 *
 * profiles/desktop/node_modules/@deepseek-ai/schemastery   ← 装在这里是**没用的**，
 *                                                             它不在 D:\dsh\pet 的解析链上
 * ```
 *
 * 对照：profile 里另外两个第三方插件（dshmarket、dsh-paper-reader）都是
 * **真实目录**且**各自带 node_modules**，所以它们能加载。
 *
 * ## 判据
 *
 * 用 `import.meta.resolve`（或 createRequire 兜底）从**仓库根**解析每个裸标识符，
 * 要求全部成功。任何一条失败，DSH 侧就会是 `failed to import`。
 *
 * ⚠️ 必须用 **Electron 以 Node 模式**跑才能验 `@deepseek-ai/*`
 * （它们现在装在仓库 node_modules 里，纯 Node 也能验一部分，
 * 但 asar 那侧的对照需要 Electron）。
 *
 * 运行：node scripts/dev/probe-import-resolution.mjs
 */

import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const ENTRY = join(REPO, 'src', 'host', 'index.js')

let failed = 0
const ok = (m) => console.log('  ✓ ' + m)
const bad = (m) => {
  failed += 1
  console.log('  ✗ ' + m)
}

console.log('运行环境：node ' + process.versions.node + (process.versions.electron ? ' / electron ' + process.versions.electron : ''))
console.log('插件真实路径（ESM 解析锚点）：' + REPO)
console.log('')

// ---------------------------------------------------------------- 前置：解析链
console.log('解析链检查（ESM 会从插件目录往上找 node_modules）：')
for (const p of [join(REPO, 'node_modules'), join(dirname(REPO), 'node_modules')]) {
  console.log(`  ${existsSync(p) ? '有' : '无'}  ${p}`)
}
console.log('')

// ---------------------------------------------------------------- 逐个标识符
/*
 * 与 src/ 里实际 import 的一致（加一个 client 用的 react 作为对照，
 * 它由浏览器的模块表提供，不该在这里被解析）。
 */
const NODE_SPECIFIERS = [
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/schemastery',
  '@deepseek-ai/cordis',
]

const req = createRequire(join(REPO, 'package.json'))

console.log('裸标识符解析（从插件目录出发）：')
for (const spec of NODE_SPECIFIERS) {
  let viaCjs = null
  let viaEsm = null
  try {
    viaCjs = req.resolve(spec)
  } catch (e) {
    viaCjs = null
  }
  try {
    viaEsm = import.meta.resolve(spec, pathToFileURL(ENTRY).href)
  } catch {
    viaEsm = null
  }
  if (viaCjs && viaEsm) ok(`${spec}\n      CJS → ${viaCjs}\n      ESM → ${viaEsm}`)
  else bad(`${spec}   CJS=${viaCjs ?? '失败'}  ESM=${viaEsm ?? '失败'}`)
}
console.log('')

// ---------------------------------------------------------------- 真导入
console.log('真导入插件入口：')
try {
  const mod = await import(pathToFileURL(ENTRY).href)
  ok(`导入成功（name=${String(mod.name)}, Config=${mod.Config ? '有' : '无'}）`)
} catch (err) {
  bad('导入失败：' + (err?.message ?? String(err)))
}
console.log('')

// ---------------------------------------------------------------- 与 profile 对照
console.log('对照：profile 里其它第三方插件的形态：')
const PROFILE_NM = join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'desktop', 'node_modules')
for (const name of ['dshmarket', '@ggboy123/dsh-paper-reader', 'dsh-pet-ds']) {
  const dir = join(PROFILE_NM, name)
  if (!existsSync(dir)) {
    console.log(`  (缺) ${name}`)
    continue
  }
  const hasOwn = existsSync(join(dir, 'node_modules'))
  console.log(`  ${name.padEnd(30)} 自带 node_modules: ${hasOwn ? '有' : '无'}`)
}

console.log(`\n结果：${failed === 0 ? '解析链完好，DSH 侧应该能导入' : failed + ' 项失败 —— DSH 侧会报 failed to import'}`)
process.exitCode = failed === 0 ? 0 : 1
