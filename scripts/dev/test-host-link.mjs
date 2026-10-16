/**
 * 静态检查：宿主插件的模块图里**有没有未定义的标识符**。
 *
 * ## 为什么必须有这个测试
 *
 * 我踩过一个非常隐蔽的坑：
 *
 * ```js
 * export { DEFAULTS } from './defaults.js'   // ← 再导出，不创建本地绑定
 * // ...
 * const out = { ...DEFAULTS }                // ← ReferenceError
 * ```
 *
 * 再导出（re-export）**不会**在当前模块里创建可用的本地绑定。
 * 而 `normalizeConfig()` 里要用 `DEFAULTS`，于是在 `apply()` 里抛 ReferenceError。
 *
 * 后果特别难查：
 *  · Loader 把异常记进**它自己的日志**（本机 DSH 根本没有日志文件）；
 *  · 表现是插件**静默不加载** —— 模型工具消失、桥接端口不监听；
 *  · `node --check` **只验语法**，未定义标识符它抓不到（语法完全合法）；
 *  · 已有的单测只 import `config-schema.js` / `defaults.js`，不 import 入口。
 *
 * ## 怎么查
 *
 * 用 `vm.SourceTextModule` 把模块图**链接并求值**（`link()` + `evaluate()`）。
 *
 * ⚠️ **只有 `evaluate()` 才会抓到未声明标识符** —— 实测这三种坏模式：
 *
 * | 坏模式 | 构造 | link | evaluate |
 * |---|---|---|---|
 * | `export { X } from './d'` 之后本地用 `X` | 通过 | 通过 | **抛 ReferenceError** |
 * | 直接用未声明的 `X` | 通过 | 通过 | **抛 ReferenceError** |
 * | `import { MISSING } from './d'` | 通过 | **抛**（不提供该导出） | — |
 *
 * 我第一版只做到 `link()`，于是"再导出 + 本地使用"这个真实踩过的坑
 * **照样漏掉**（测试全绿，bug 还在）。这是本文件最值得记的一点。
 *
 * 求值是安全的：宿主模块顶层只有声明与 `import`，没有副作用代码
 * （不建服务器、不起进程、不写文件）。外部依赖用空的合成模块顶替，
 * 所以 `import` 也不会真的去加载 DSH。
 *
 * 运行：node --experimental-vm-modules scripts/dev/test-host-link.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')

let passed = 0
let failed = 0

function pass(name, detail) {
  passed += 1
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`)
}
function fail(name, detail) {
  failed += 1
  console.log(`FAIL  ${name}`)
  if (detail) console.log(`      ${detail}`)
}

/** 外部依赖前缀（DSH 自带的包，本机不装）。 */
const EXTERNAL_PREFIX = '@deepseek-ai/'

const HAS_VM_MODULES = typeof vm.SourceTextModule === 'function'

/**
 * 造一个合成模块，用于顶替**本机不存在**的依赖。
 *
 * 两类目标，方式不同：
 *
 *  · **Node 内建**（`node:*`）—— 必须用**真实**内建的导出名与实现。
 *    第一版把 `node:path` 也换成假的，于是 `join` 变成 undefined，
 *    求值时误报 `join is not a function`（实测踩过）。
 *    `vm.SyntheticModule` 只能给"值"，所以这里直接 import 真模块再转发。
 *
 *  · **DSH 自带的包**（`@deepseek-ai/*`）—— 本机不装，给**能跑的最小桩**：
 *    `defineTool` 是恒等函数（插件拿它包一下工具定义）、`z` 是宽容的链式代理
 *    （schema 那一串 `.min().max().default().volatile()` 调用都要能过）。
 *    桩只要能撑过**模块顶层求值**就够了 —— 本测试不是要跑插件逻辑，
 *    而是要暴露"未声明标识符"这类绑定错误。
 */
function makeSynthetic(specifier, entries) {
  const names = Object.keys(entries)
  return new vm.SyntheticModule(
    names,
    function () {
      for (const [k, v] of Object.entries(entries)) this.setExport(k, v)
    },
    { identifier: `synthetic:${specifier}` },
  )
}

/** `z` 的宽容桩：任何属性访问都返回一个"可继续链式调用且也能被当值用"的函数。 */
function makePermissiveZ() {
  const chain = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'toJSON') return () => ({})
      if (prop === 'then') return undefined // 别把它当 thenable
      return chain
    },
    apply() {
      return chain
    },
    construct() {
      return chain
    },
  })
  return new Proxy({}, {
    get(_t, prop) {
      if (prop === 'default') return chain
      return chain
    },
  })
}

/** 真实 Node 内建的导出名与值。 */
async function realBuiltinEntries(specifier) {
  const real = await import(specifier)
  const entries = {}
  for (const k of Object.keys(real)) entries[k] = real[k]
  return entries
}

/** DSH 自带包的最小桩。 */
function dshStubEntries(specifier) {
  // 插件里用的是 `import { defineTool } from '@deepseek-ai/dsh-tools'`。
  if (specifier.includes('dsh-tools')) {
    return { defineTool: (def) => def, default: {} }
  }
  // `import z from '@deepseek-ai/schemastery'`
  if (specifier.includes('schemastery')) {
    return { default: makePermissiveZ(), z: makePermissiveZ() }
  }
  // 其余（cordis 等）给个空壳；本测试不关心它们的行为。
  return { default: {}, Context: class {}, Service: class {}, Inject: {} }
}

/** 按 specifier 分发到正确的合成模块。 */
async function syntheticFor(specifier) {
  if (specifier.startsWith('node:')) {
    return makeSynthetic(specifier, await realBuiltinEntries(specifier))
  }
  return makeSynthetic(specifier, dshStubEntries(specifier))
}

/**
 * 建立并**链接**一个模块图。
 *
 * @param {string} entryAbs 入口绝对路径
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
async function linkModuleGraph(entryAbs) {
  const cache = new Map()
  /** 已链接过的模块（值可能是 in-flight 的 Promise）—— 避免重复 link。 */
  const linked = new Map()

  const load = async (absPath) => {
    const key = resolve(absPath)
    if (cache.has(key)) return cache.get(key)
    const source = readFileSync(key, 'utf8')
    /*
     * ⚠️ 构造 `SourceTextModule` 本身就可能抛（实测）：
     * 引用了模块里既没声明也没导入的名字时，V8 在**解析**阶段就报
     * `ReferenceError: X is not defined`。所以这一步的异常也要往上冒。
     */
    const mod = new vm.SourceTextModule(source, {
      identifier: pathToFileURL(key).href,
      initializeImportMeta(meta) {
        meta.url = pathToFileURL(key).href
      },
      importModuleDynamically: () => new vm.SyntheticModule([], () => {}),
    })
    cache.set(key, mod)
    return mod
  }

  /** 外部依赖 → 合成模块（见 `syntheticFor`）。 */
  const externalModule = (specifier) => syntheticFor(specifier)

  const linkOnce = async (mod) => {
    const key = mod.identifier
    const existing = linked.get(key)
    if (existing) return existing
    /*
     * ⚠️ 同一个模块可能既被当入口、又作为别人的依赖出现。
     * `link()` 对已链接的模块再调一次会抛 "Module status must be unlinked"，
     * 所以每个模块只链一次，并把结果缓存起来（实测踩过）。
     */
    const promise = (async () => {
      await mod.link(async (specifier, referencing) => {
        if (specifier.startsWith(EXTERNAL_PREFIX) || specifier.startsWith('node:')) {
          return externalModule(specifier)
        }
        if (specifier.startsWith('.')) {
          const base = dirname(fileURLToPath(referencing.identifier))
          const child = await load(resolve(base, specifier))
          await linkOnce(child)
          return child
        }
        return externalModule(specifier)
      })
    })()
    linked.set(key, promise)
    return promise
  }

  const entry = await load(entryAbs)
  await linkOnce(entry)
  return { ok: true }
}

/**
 * 链接**并求值**整个模块图 —— 求值才会暴露未声明标识符（见文件头对照表）。
 *
 * 求值是安全的：宿主模块顶层只有声明与 import，没有副作用代码。
 * `evaluate()` 对同一个模块只能调一次，所以结果也缓存。
 */
async function evaluateModuleGraph(entryAbs) {
  const evaluated = new Map()
  const cache = new Map()

  const load = async (absPath) => {
    const key = resolve(absPath)
    if (cache.has(key)) return cache.get(key)
    const source = readFileSync(key, 'utf8')
    const mod = new vm.SourceTextModule(source, {
      identifier: pathToFileURL(key).href,
      initializeImportMeta(meta) {
        meta.url = pathToFileURL(key).href
      },
      importModuleDynamically: () => new vm.SyntheticModule([], () => {}),
    })
    cache.set(key, mod)
    return mod
  }

  const linkOnce = async (mod) => {
    const key = mod.identifier
    if (evaluated.has(key)) return evaluated.get(key)
    const promise = (async () => {
      await mod.link(async (specifier, referencing) => {
        if (specifier.startsWith(EXTERNAL_PREFIX) || specifier.startsWith('node:')) {
          return syntheticFor(specifier)
        }
        if (specifier.startsWith('.')) {
          const base = dirname(fileURLToPath(referencing.identifier))
          const child = await load(resolve(base, specifier))
          await linkOnce(child)
          return child
        }
        return syntheticFor(specifier)
      })
      await mod.evaluate()
      return true
    })()
    evaluated.set(key, promise)
    return promise
  }

  await linkOnce(await load(entryAbs))
  return { ok: true }
}

// ------------------------------------------------------------------ 主体

if (!HAS_VM_MODULES) {
  fail(
    '运行环境支持 vm.SourceTextModule',
    '需要 `node --experimental-vm-modules`。没有它就只能退回语法检查 —— 而那正是漏掉本次 bug 的原因。',
  )
} else {
  pass('运行环境支持 vm.SourceTextModule')

  /*
   * 逐个文件当入口链接。Node 会连带检查它 import 的整条链，
   * 所以任何一处"再导出写错 + 本地使用"都会被抓到。
   */
  const ENTRIES = [
    'src/host/index.js',
    'src/host/config-schema.js',
    'src/host/defaults.js',
    'src/host/balance.js',
    'src/host/bridge-server.js',
    'src/host/supervisor.js',
    'src/host/electron-locate.js',
    'src/shared-core/protocol.js',
    'src/shared-core/balance-announce.js',
    'src/shared-core/dialogue.js',
  ]

  for (const rel of ENTRIES) {
    const abs = join(ROOT, rel)
    try {
      await evaluateModuleGraph(abs)
      pass(`模块图可链接求值、无未声明标识符：${rel}`)
    } catch (err) {
      fail(`模块图可链接求值、无未声明标识符：${rel}`, err instanceof Error ? err.message : String(err))
    }
  }

  /*
   * **自证**：故意造一个"再导出 + 本地使用"的坏模块，确认这条检查真能抓到。
   * 没有这个反例，测试可能因为"链接根本没走到那个分支"而假绿。
   *
   * ⚠️ 报错可能出现在**两个阶段**（实测都遇到过）：
   *  · 构造 `SourceTextModule` 时（语法/早期解析错误）；
   *  · 链接时（绑定检查）。
   * 所以两个阶段都要捕获，否则自证会误判成"失败"。
   */
  try {
    const dep = join(ROOT, '.cache', 'link-check-dep.mjs')
    const bad = join(ROOT, '.cache', 'link-check-canary.mjs')
    writeFileSync(dep, 'export const VALUE = 1\n', 'utf8')
    writeFileSync(
      bad,
      "export { VALUE } from './link-check-dep.mjs'\nconst x = { ...VALUE }\nexport default x\n",
      'utf8',
    )
    let caught = null
    try {
      await evaluateModuleGraph(bad)
    } catch (err) {
      caught = err instanceof Error ? err.message : String(err)
    }
    assert.ok(caught, '应该报错（VALUE 未被本地绑定）')
    assert.match(caught, /VALUE is not defined/)
    pass('自证：这个检查确实能抓到「再导出 + 本地使用」的错误', caught.split('\n')[0])
  } catch (err) {
    fail('自证：这个检查确实能抓到「再导出 + 本地使用」的错误', err instanceof Error ? err.message : String(err))
  }
}

console.log(`\n结果：${String(passed)}/${String(passed + failed)} 通过`)
if (failed > 0) process.exit(1)
