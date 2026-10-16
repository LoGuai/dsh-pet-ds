/**
 * 清单检查：插件**用到的裸标识符依赖，必须在 package.json 里声明**。
 *
 * ## 为什么需要（这条抓的是一个真实的、极难查的故障）
 *
 * 我给插件加了设置页（宿主侧声明 schemastery 的 `Config`），结果
 * **插件整个不加载** —— 工具消失、桥接端口不监听、桌宠不出现，而且
 * **插件自己一行日志都没有**（DSH 把加载异常记进它自己的日志，本机没有那个文件）。
 *
 * 根因：`src/host/config-schema.js` 里 `import z from '@deepseek-ai/schemastery'`，
 * 但 **package.json 没有声明这个依赖**。
 *
 * DSH 会给自己的一部分包（`@deepseek-ai/dsh-tools`、`@deepseek-ai/cordis` 等）
 * 注入模块解析，但**不是全部** —— `schemastery` 就不在其中。
 * 参照可用的第三方插件（[dsh-deepseek-pet](https://github.com/txlznbzsdj-collab/dsh-deepseek-pet)）：
 * 它把 `"@deepseek-ai/schemastery": "^3.18.1"` 明确写进了 `dependencies`。
 *
 * ## 判据
 *
 * 扫描 `src/**` 与 `client/**` 里所有 `import ... from '<裸标识符>'`，
 * 逐个要求它出现在 `dependencies` / `peerDependencies` / `optionalDependencies` 之一，
 * 或者是 Node 内建、或者是相对路径。
 *
 * > 为什么不把 `@deepseek-ai/dsh-tools` 也要求声明：它是 DSH **注入**的那一类，
 * > 声明了反而会去 npm 拉一份（可能与 DSH 自身版本冲突）。
 * > 白名单见下方 `INJECTED_BY_DSH`。
 *
 * 运行：node scripts/dev/test-manifest-deps.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')

let passed = 0
let failed = 0
function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`PASS  ${name}`)
  } catch (err) {
    failed += 1
    console.log(`FAIL  ${name}`)
    console.log(`      ${err instanceof Error ? err.message : String(err)}`)
  }
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/**
 * 递归收集某个目录下的 .js/.mjs 文件。
 */
function collectJs(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules') continue
      collectJs(p, out)
    } else if (/\.(mjs|js)$/.test(e.name)) {
      out.push(p)
    }
  }
  return out
}

/** 抓出一个文件里所有 `from '<specifier>'` 与 `import('<specifier>')`。 */
function specifiersOf(file) {
  const raw = readFileSync(file, 'utf8')
  /*
   * ⚠️ 先剥掉注释再扫。
   *
   * 否则 JSDoc 里的 `@param {import('@deepseek-ai/plugin').Context} ctx`
   * 会被当成真 import —— 它只是**类型注释**，运行时不需要那个包。
   * 第一版没剥，于是报了一个假阳性（实测踩过）。
   */
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const out = []
  for (const m of src.matchAll(/(?:^|\s)(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g)) out.push(m[1])
  for (const m of src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1])
  return out
}

/** 取包名（`@scope/name` 取两段，其余取一段）。 */
function packageNameOf(spec) {
  const parts = spec.split('/')
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

const declared = new Set([
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
  ...Object.keys(pkg.optionalDependencies ?? {}),
])

/**
 * "宿主提供"的包只能出现在 **peerDependencies** 里。
 *
 * `peerDependencies` 的语义就是"运行时由宿主提供" —— 对本插件来说
 * `@deepseek-ai/cordis`、`@deepseek-ai/dsh-tools` 正是如此：
 * DSH 会把它们给插件，声明成 `dependencies` 反而会去 npm 拉一份、
 * 可能与 DSH 自身的版本冲突（那类问题比缺依赖更难查）。
 */
const HOST_PROVIDED = new Set(['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools'])

const sources = [...collectJs(join(ROOT, 'src')), ...collectJs(join(ROOT, 'client'))]

const external = new Map() // 包名 -> 用它的文件集合
for (const file of sources) {
  for (const spec of specifiersOf(file)) {
    if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) continue
    if (spec.startsWith('file:')) continue
    const name = packageNameOf(spec)
    if (!external.has(name)) external.set(name, new Set())
    external.get(name).add(relative(ROOT, file).replace(/\\/g, '/'))
  }
}

// ------------------------------------------------------------------ 断言

test('能扫到源码里的外部依赖（否则说明扫描逻辑本身坏了）', () => {
  assert.ok(sources.length > 0, '没扫到任何源码文件')
  assert.ok(external.size > 0, '没扫到任何外部依赖 —— 扫描正则可能失效了')
})

test('用到的每个外部包都在 package.json 里声明了', () => {
  /*
   * ⚠️ 这条就是本次故障的护栏：`@deepseek-ai/schemastery` 没声明，
   * 导致模块导入失败 → 插件静默不加载。
   */
  const missing = []
  for (const [name, files] of external) {
    if (declared.has(name)) continue
    missing.push(`${name}（被 ${[...files].join(', ')} 使用）`)
  }
  assert.deepEqual(missing, [], `未声明的外部依赖：${missing.join('；')}`)
})

test('dependencies 里的包确实都被用到了（没有多余依赖）', () => {
  /*
   * 反向检查：声明了却没人用，说明清单在腐烂。
   * `peerDependencies` 里的"宿主提供"包不参与这条 —— 它们语义上是
   * "运行时由宿主给"，不一定要被本插件直接 import。
   */
  const unused = Object.keys(pkg.dependencies ?? {}).filter((name) => !external.has(name))
  assert.deepEqual(unused, [], `dependencies 里声明了但没人用：${unused.join(', ')}`)
})

test('宿主提供的包只在 peerDependencies，不在 dependencies', () => {
  /*
   * 反向护栏：如果哪天有人"顺手"把 dsh-tools 写进 dependencies，
   * 它会从 npm 拉一份，可能与 DSH 自身版本冲突 —— 那类问题更难查。
   */
  const deps = pkg.dependencies ?? {}
  const wrongly = [...HOST_PROVIDED].filter((n) => n in deps)
  assert.deepEqual(wrongly, [], `不该放进 dependencies（宿主会提供）：${wrongly.join(', ')}`)
  const missingPeer = [...HOST_PROVIDED].filter((n) => !(n in (pkg.peerDependencies ?? {})))
  assert.deepEqual(missingPeer, [], `应声明为 peerDependency：${missingPeer.join(', ')}`)
})

test('schemastery 有声明（设置页 Config 依赖它）', () => {
  /*
   * 单独钉一条：这个包是"设置页能不能用"的前提，且它**不在** DSH 注入之列。
   * 少了它 = 插件完全不加载（不是只有设置页不可用）。
   */
  assert.ok(declared.has('@deepseek-ai/schemastery'), 'package.json 必须声明 @deepseek-ai/schemastery')
})

test('dsh.client 的 exports["./client"] 指向真实存在的文件', () => {
  // 这条坏了的表现是"设置页那一栏不出现"，也不报错。
  const target = pkg.exports?.['./client']
  const rel = typeof target === 'string' ? target : target?.default
  assert.ok(rel, 'exports["./client"] 没配')
  const abs = join(ROOT, rel)
  assert.ok(statSync(abs).isFile(), `exports["./client"] 指向的文件不存在：${rel}`)
})

test('版本号在三处保持一致', () => {
  /*
   * 版本号有三份，天然容易漂移：
   *  · package.json 的 version          —— 安装包的版本
   *  · pet-app/package.json 的 version  —— 桌宠窗口进程的版本
   *  · src/host/index.js 的 VERSION     —— 随桥接状态下发给桌宠
   *
   * 漂移了会出现"界面显示 0.1.0、包却是 0.1.2"这种对不上号的怪事，
   * 而排查时第一眼就会看这个号。
   */
  const petPkg = JSON.parse(readFileSync(join(ROOT, 'pet-app', 'package.json'), 'utf8'))
  const hostSrc = readFileSync(join(ROOT, 'src', 'host', 'index.js'), 'utf8')
  const m = /const VERSION = '([^']+)'/.exec(hostSrc)
  assert.ok(m, 'src/host/index.js 里找不到 `const VERSION = \'...\'`')
  assert.equal(petPkg.version, pkg.version, 'pet-app/package.json 的版本与主包不一致')
  assert.equal(m[1], pkg.version, 'src/host/index.js 的 VERSION 与主包不一致')
})

test('版本号是合法 semver（可发布到 npm）', () => {
  /*
   * ⚠️ 第一版这里写的是 `^\d+\.\d+\.\d+$` —— **过严**。
   * semver 允许 `-预发布` 与 `+构建` 后缀，而本仓库用了 `0.1.3-fix`
   * 这种"补丁版"命名，被那条断言误判成失败。
   *
   * 现在按 semver 的正式规则校验（足以挡住真实会出问题的写法）：
   *   ✅ 0.1.3 / 0.1.3-fix / 0.1.3-fix.1 / 0.1.3+build
   *   ❌ 0.1.3fix（`3fix` 不是数字 —— npm publish 会报 Invalid version）
   *   ❌ 1.0（只有两段）
   */
  const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
  assert.match(pkg.version, SEMVER, `版本号不是合法 semver：${pkg.version}`)
})

test('版本号没把后缀直接粘在补丁号后面（常见误写）', () => {
  /*
   * `0.1.3fix` 这种写法看着像版本号，其实**不合法**：
   * semver 要求预发布部分用 `-` 连接。粘在一起会让 npm 直接拒绝发布，
   * 而肉眼很难发现少了个连字符。
   */
  assert.doesNotMatch(
    pkg.version,
    /^\d+\.\d+\.\d+[A-Za-z]/,
    `版本号疑似漏了连字符（应为 0.1.3-fix 而非 0.1.3fix）：${pkg.version}`,
  )
})

console.log(`\n结果：${String(passed)}/${String(passed + failed)} 通过`)
if (failed > 0) {
  console.log('\n扫到的外部依赖：')
  for (const [name, files] of [...external].sort()) {
    const mark = declared.has(name) ? '已声明' : INJECTED_BY_DSH.has(name) ? 'DSH 注入' : '**未声明**'
    console.log(`  ${name.padEnd(34)} ${mark}   (${[...files].join(', ')})`)
  }
  process.exit(1)
}
