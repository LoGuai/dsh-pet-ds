/**
 * 复现 DSH 的模块解析，直接加载本插件的宿主入口 —— **抓真实报错**。
 *
 * ## 为什么需要
 *
 * DSH 里插件加载失败时**没有日志文件**（本机 `DeepSeek Harness\log` 不存在），
 * 而现象只是"模型工具消失、桥接没监听"，完全看不出原因。
 *
 * ## 怎么复现
 *
 * DSH 的做法（已读源码确认）：`cordis-plugin-loader` 里
 * `const require = createRequire(import.meta.url)` —— 锚点在 loader 自己那里，
 * 即 **DSH 的 app.asar 内部**，所以裸标识符（`@deepseek-ai/schemastery`、
 * `@deepseek-ai/dsh-tools`）能解析到 DSH 自带的包。
 *
 * ⚠️ **必须用 Electron 以 Node 模式跑**（`ELECTRON_RUN_AS_NODE=1`），
 * 因为**纯 Node 不认 asar 归档** —— 用系统 node 跑这个脚本，
 * `createRequire(asar 内路径)` 会一律报 Cannot find module，
 * 那是复现方式的问题、不是插件的问题（实测踩过这个假象）。
 *
 * 运行：
 *   $env:ELECTRON_RUN_AS_NODE=1
 *   & (Get-ChildItem "$env:USERPROFILE\.dsh\electron\electron-*\electron.exe").FullName scripts/dev/probe-host-load.mjs
 *
 * （注释里别写带星号的路径 —— `星号+斜杠` 会提前闭合并报语法错，踩过两次。）
 */

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const ASAR = 'C:/Users/29845/AppData/Local/Programs/DeepSeek Harness/resources/app.asar'
/** 锚点：asar 内任意一个真实存在的文件路径。 */
const ANCHOR = `${ASAR}/dsh/node_modules/@deepseek-ai/cordis-plugin-loader/lib/index.js`

console.log('运行时：node ' + process.versions.node + ' / electron ' + String(process.versions.electron))
console.log('解析锚点：')
console.log('  ' + ANCHOR)
console.log('')

const req = createRequire(ANCHOR)

let resolveOk = true
for (const spec of ['@deepseek-ai/schemastery', '@deepseek-ai/dsh-tools', '@deepseek-ai/cordis']) {
  try {
    console.log(`  ✓ resolve ${spec}\n      → ${req.resolve(spec)}`)
  } catch (err) {
    resolveOk = false
    console.log(`  ✗ resolve ${spec}\n      ${String(err.message).split('\n')[0]}`)
  }
}

console.log('\n尝试导入插件入口（src/host/index.js）…')
const entry = pathToFileURL('D:/dsh/pet/src/host/index.js').href
try {
  const mod = await import(entry)
  console.log('  ✓ 导入成功')
  console.log(`      name   = ${String(mod.name)}`)
  console.log(`      inject = ${JSON.stringify(mod.inject)}`)
  console.log(`      Config = ${mod.Config ? '有（schemastery schema）' : '无'}`)
  console.log(`      导出    = ${Object.keys(mod).join(', ')}`)
} catch (err) {
  console.log('  ✗ 导入失败')
  console.log('    ' + (err && err.message ? err.message : String(err)))
  if (err && err.stack) console.log(err.stack.split('\n').slice(0, 10).join('\n'))
  process.exitCode = 1
}

console.log(`\n裸标识符解析：${resolveOk ? '全部成功' : '有失败（见上）'}`)
