/**
 * 用 **DSH 真实的那份 schemastery** 校验本插件的 `Config` —— 抓"解析失败"类问题。
 *
 * ## 为什么要单独验这一步
 *
 * Loader 在**调用 `apply` 之前**就会用插件声明的 `Config` 校验那一行的 config。
 * 所以如果 schema 本身有问题，症状是"插件完全没加载、而且插件自己的日志一句都没有"
 * —— 从现象看不出任何东西（本机 DSH 也没有日志文件）。
 *
 * 之前用从 app.asar **导出**的 schemastery 副本做过单测（12/12 通过），
 * 但那份是 ESM 版（`lib/index.mjs`）；DSH 实际解析到的是 **CJS 版**
 * （`lib/index.cjs`）。两者若有差异，单测就测不到真实的那个。
 * 所以这里用 `createRequire` 精确解析到 **DSH 会用的那个文件**再跑一遍。
 *
 * 必须用 **Electron 以 Node 模式**跑（纯 Node 不认 asar，解析会全部失败）。
 *
 * 运行（PowerShell）：
 *   $env:ELECTRON_RUN_AS_NODE=1
 *   & (Get-ChildItem "$env:USERPROFILE\.dsh\electron\electron-*\electron.exe").FullName scripts/dev/probe-schema-dsh.mjs
 */

import { createRequire } from 'node:module'

const ASAR = 'C:/Users/29845/AppData/Local/Programs/DeepSeek Harness/resources/app.asar'
const ANCHOR = `${ASAR}/dsh/node_modules/@deepseek-ai/cordis-plugin-loader/lib/index.js`
const req = createRequire(ANCHOR)

let failed = 0
const bad = (msg) => {
  failed += 1
  console.log('  ✗ ' + msg)
}
const good = (msg) => console.log('  ✓ ' + msg)

// ---------------------------------------------------------------- 1. 解析真实路径
console.log('运行时：node ' + process.versions.node)
const resolved = req.resolve('@deepseek-ai/schemastery')
console.log('DSH 会用的 schemastery：\n  ' + resolved + '\n')

/** 实际被解析到的那个文件（.cjs 还是 .mjs 很要紧）。 */
const isCjs = /\.cjs$/.test(resolved)

// ---------------------------------------------------------------- 2. 载入它
let z
try {
  if (isCjs) {
    z = req('@deepseek-ai/schemastery')
    z = z.default ?? z
    good('以 CJS 方式载入（与 DSH 的解析结果一致）')
  } else {
    z = (await import(resolved)).default
    good('以 ESM 方式载入')
  }
} catch (err) {
  bad('载入 schemastery 失败：' + (err?.message ?? String(err)))
  process.exit(1)
}

console.log('  z.object:', typeof z.object, ' z.number:', typeof z.number, ' z.boolean:', typeof z.boolean)
console.log('  z.string:', typeof z.string)

// ---------------------------------------------------------------- 3. 逐项复现 Config
/*
 * 刻意**手写一份与 src/host/config-schema.js 相同的 schema**，而不是 import 它 ——
 * 因为 import 会连带触发宿主模块的其它导入，把问题混在一起。
 * 目的是单纯验证"这些 schemastery 调用在 DSH 那份实现上成不成立"。
 */
console.log('\n逐项验证 config-schema.js 用到的调用：')
const probes = [
  ['z.number().min(1).max(65535).step(1).default(47845).description("x")', () => z.number().min(1).max(65535).step(1).default(47845).description('x')],
  ['z.string().default("")', () => z.string().default('')],
  ['z.boolean().default(true).volatile()', () => z.boolean().default(true).volatile()],
  ['z.number().min(0).max(60000).step(100).default(3000).volatile()', () => z.number().min(0).max(60000).step(100).default(3000).volatile()],
  ['z.number().min(0).default(10).volatile()', () => z.number().min(0).default(10).volatile()],
  ['z.number().min(5).max(3600).step(1).default(300).volatile()', () => z.number().min(5).max(3600).step(1).default(300).volatile()],
]
for (const [label, fn] of probes) {
  try {
    fn()
    good(label)
  } catch (err) {
    bad(label + '  →  ' + (err?.message ?? String(err)))
  }
}

// ---------------------------------------------------------------- 4. 组装并解析
console.log('\n组装完整 Config 并解析：')
let Config
try {
  Config = z.object({
    port: z.number().min(1).max(65535).step(1).default(47845).description('x'),
    electronPath: z.string().default('').description('x'),
    autoStart: z.boolean().default(true).volatile().description('x'),
    startDelayMs: z.number().min(0).max(60000).step(100).default(3000).volatile().description('x'),
    debug: z.boolean().default(false).description('x'),
    stopOnUnload: z.boolean().default(true).volatile().description('x'),
    size: z.number().min(80).max(1200).step(20).default(260).volatile().description('x'),
    alwaysOnTop: z.boolean().default(true).volatile().description('x'),
    lowBalanceThreshold: z.number().min(0).default(10).volatile().description('x'),
    refreshSeconds: z.number().min(5).max(3600).step(1).default(300).volatile().description('x'),
    apiBase: z.string().default('https://api.deepseek.com').description('x'),
    credential: z.string().default('DEEPSEEK_API_KEY').description('x'),
  })
  good('z.object({...}) 构造成功')
} catch (err) {
  bad('z.object 构造失败：' + (err?.message ?? String(err)))
}

if (Config) {
  console.log('  toJSON 顶层键: ' + Object.keys(Config.toJSON()).join(', '))

  /*
   * 关键：用**真实 profile 里那一行的 config** 去解析。
   * cordis.patch.yml 里写了 port/size/autoStart/startDelayMs/debug/stopOnUnload/
   * lowBalanceThreshold/refreshSeconds/apiBase/credential —— 若其中任何一个
   * 与 schema 冲突（类型不符、越界），解析就会抛，插件直接不加载。
   */
  const realRowConfig = {
    port: 47845,
    size: 260,
    autoStart: true,
    startDelayMs: 3000,
    debug: false,
    stopOnUnload: true,
    lowBalanceThreshold: 10,
    refreshSeconds: 300,
    apiBase: 'https://api.deepseek.com',
    credential: 'DEEPSEEK_API_KEY',
  }
  try {
    const resolvedConfig = Config(realRowConfig)
    good('用真实 patch 行的 config 解析成功')
    const keys = Object.keys(resolvedConfig)
    console.log('      解析出 ' + keys.length + ' 个键: ' + keys.join(', '))
    for (const k of ['autoStart', 'startDelayMs', 'refreshSeconds', 'size']) {
      const v = resolvedConfig[k]
      const shown = v && typeof v === 'object' && typeof v.get === 'function' ? `{get()=${String(v.get())}}` : String(v)
      console.log(`      ${k} = ${shown}`)
    }
  } catch (err) {
    bad('解析真实 config 失败：' + (err?.message ?? String(err)))
  }

  // 空 config（patch 行不写 config 时的情形）
  try {
    Config({})
    good('空 config 解析成功（全部走默认值）')
  } catch (err) {
    bad('空 config 解析失败：' + (err?.message ?? String(err)))
  }

  // volatile 字段是否真的被标上（DSH 的 describe() 靠它决定要不要服务该命名空间）
  const metaOf = (n) => Config.dict?.[n]?.meta
  const vol = Object.keys(Config.dict ?? {}).filter((n) => metaOf(n)?.volatile === true)
  if (vol.length > 0) good('volatile 字段 ' + vol.length + ' 个: ' + vol.join(', '))
  else bad('没有任何 volatile 字段 —— DSH 设置页不会出现本插件')
}

console.log('\n结果：' + (failed === 0 ? '全部通过' : failed + ' 项失败'))
process.exitCode = failed === 0 ? 0 : 1
