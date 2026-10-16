/**
 * 宿主配置 schema 的单元测试。
 *
 * ## 为什么必须测
 *
 * DSH 设置页里能看到哪些字段，**完全由这份 schema 决定**：
 *  · 没有 `.volatile()` 的字段**根本不会出现在设置页上**（宿主连 describe 都跳过该行）；
 *  · 有 `.volatile()` 的字段会显示，且写它会直接提交进运行中的 fiber。
 *
 * 而这两种失败**都很难从现象反推**：
 *  · 漏标 → "设置页少了一栏/少了某个字段"，不报错；
 *  · 多标 → 用户改一个本该重启才生效的参数，它却"热改"了，行为诡异。
 *
 * 还有一类最隐蔽的：**默认值两处漂移**。`DEFAULTS`（运行时回落）与 schema
 * 的 `.default()`（设置页显示）是两份默认值，漂移了会出现
 * "设置页显示 300、实际用 600" 这种极难查的问题。
 *
 * ## 怎么在 DSH 之外跑
 *
 * schema 需要 `@deepseek-ai/schemastery`（DSH 自带的包，本仓库不装依赖）。
 * 脚本会先从 DSH 的 app.asar 里把它（及其依赖）导出到 `_research/schemastery/`，
 * 再用一个临时 package.json 让裸标识符能解析 —— 见 `prepareSchemastery()`。
 *
 * 运行：node scripts/dev/test-config-schema.mjs
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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

/**
 * 把 schemastery（及其依赖）从 DSH 的 app.asar 导出到本地。
 *
 * 为什么要这么绕：Node 的 ESM 解析器**不认 asar 归档**，
 * 而 schemastery 有依赖（cosmokit），需要真实的 node_modules 结构。
 *
 * @returns {string} 导出目录（其下 node_modules/@deepseek-ai/schemastery）
 */
function prepareSchemastery() {
  const vendor = join(ROOT, '_research', 'schemastery')
  const entry = join(vendor, 'node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.mjs')
  if (existsSync(entry)) return vendor

  const dump = join(ROOT, '.cache', 'asar-dump.mjs')
  if (!existsSync(dump)) throw new Error(`缺少 ${dump}（它负责从 app.asar 导出文件）`)

  mkdirSync(join(vendor, 'node_modules', '@deepseek-ai'), { recursive: true })
  for (const pkg of ['schemastery', 'cosmokit']) {
    execFileSync(
      process.execPath,
      [
        dump,
        '--extract',
        `dsh/node_modules/@deepseek-ai/${pkg}`,
        join(vendor, 'node_modules', '@deepseek-ai', pkg),
      ],
      { cwd: ROOT, stdio: 'ignore' },
    )
  }
  writeFileSync(
    join(vendor, 'package.json'),
    JSON.stringify({ name: 'dsh-pet-vendor', private: true }, null, 2),
  )
  return vendor
}

/*
 * 注册一个**解析钩子**，把裸标识符 `@deepseek-ai/schemastery` 指向导出目录。
 *
 * 为什么不在源码里做兼容：`config-schema.js` 用裸标识符导入是 DSH 的规范做法
 * （Loader 从 DSH 那边解析）。为了"能单测"去改源码（例如加环境变量分支）
 * 会把测试的痕迹留在生产代码里 —— 这里用钩子就完全不用动源码。
 *
 * ⚠️ 必须用 `module.register()` + `pathToFileURL`：`register()` 只接受 URL 字符串，
 * 传 `require.resolve(...)` 的裸路径会报 ERR_INVALID_ARG_VALUE。
 */
const vendorDir = prepareSchemastery()
process.env.DSH_PET_VENDOR_DIR = vendorDir
const { register } = await import('node:module')
register(pathToFileURL(join(HERE, 'schemastery-resolve-hook.mjs')).href, {
  parentURL: pathToFileURL(join(HERE, 'noop.mjs')).href,
})

// 被测的两个模块（钩子注册之后再导入，才会走改道）。
const { Config, VOLATILE_FIELDS, NON_VOLATILE_FIELDS } = await import(
  pathToFileURL(join(ROOT, 'src', 'host', 'config-schema.js')).href
)
const { DEFAULTS } = await import(pathToFileURL(join(ROOT, 'src', 'host', 'defaults.js')).href)

const json = Config.toJSON()
/** 字段名 → schema 节点。**不要走 `toJSON()`**：它把字段换成 uid 引用（只有 `refs`），
 *  而 `Config.dict` 直接给的就是节点，读 meta 更直接。 */
const dict = Config.dict

/**
 * 取字段的 schema 节点；用 `meta` 读 default / volatile / description。
 * @param {string} name
 */
function fieldNode(name) {
  return dict?.[name] ?? null
}
function fieldMeta(name) {
  return fieldNode(name)?.meta ?? null
}

/**
 * 取一个 volatile 字段的**当前值**。
 *
 * ⚠️ schemastery 对 volatile 字段解析出来的不是普通值，而是
 * `{ get(): T }` 这样的**访问器对象**（Loader 靠它把运行中 fiber 的活引用挂进去，
 * 所以 volatile 改动能不重挂就生效）。非 volatile 字段才是普通值。
 * 单测里要拿值就得先 `.get()`。
 */
function resolvedValue(resolved, name) {
  const v = resolved[name]
  if (v !== null && typeof v === 'object' && typeof v.get === 'function') return v.get()
  return v
}

// ------------------------------------------------------------------ 结构

test('Config 是合法 schemastery object schema', () => {
  assert.equal(Config.type, 'object')
  assert.equal(typeof dict, 'object')
  assert.ok(Object.keys(dict).length > 0)
})

test('至少有一个 volatile 字段（否则整个设置栏不会出现）', () => {
  /*
   * ⚠️ 这是最关键的一条：DSH 的 describe() 里 `volatileForm(schema) === undefined`
   * 时会把这一行**整条丢掉** —— 于是设置页里根本没有这个插件，也不报错。
   */
  const anyVolatile = Object.keys(dict).some((name) => fieldMeta(name)?.volatile === true)
  assert.ok(anyVolatile, '没有任何 volatile 字段 → DSH 设置页里看不到本插件')
})

test('VOLATILE_FIELDS 列出的字段确实都标了 volatile', () => {
  for (const name of VOLATILE_FIELDS) {
    const meta = fieldMeta(name)
    assert.ok(meta, `schema 里没有字段 ${name}`)
    assert.equal(meta.volatile, true, `${name} 应为 volatile`)
  }
})

test('NON_VOLATILE_FIELDS 列出的字段确实都没标 volatile', () => {
  for (const name of NON_VOLATILE_FIELDS) {
    const meta = fieldMeta(name)
    assert.ok(meta, `schema 里没有字段 ${name}`)
    assert.notEqual(meta.volatile, true, `${name} 不该是 volatile`)
  }
})

test('schema 字段集合 = volatile ∪ non-volatile（没有漏网的）', () => {
  const declared = new Set([...VOLATILE_FIELDS, ...NON_VOLATILE_FIELDS])
  const actual = new Set(Object.keys(dict))
  const missing = [...actual].filter((k) => !declared.has(k))
  const extra = [...declared].filter((k) => !actual.has(k))
  assert.deepEqual(missing, [], `schema 里有未归类的字段：${missing.join(', ')}`)
  assert.deepEqual(extra, [], `清单里有 schema 中没有的字段：${extra.join(', ')}`)
})

test('每个字段都有 description（设置页要显示说明）', () => {
  for (const name of Object.keys(dict)) {
    const meta = fieldMeta(name)
    const desc = meta?.description
    assert.ok(typeof desc === 'string' && desc.length > 0, `${name} 缺 description`)
  }
})

// ------------------------------------------------------------------ 默认值一致性

test('schema 默认值与 DEFAULTS 逐字段一致', () => {
  /*
   * ⚠️ 两份默认值漂移是最隐蔽的坑：设置页显示的是 schema 的 default，
   * 而运行时回落用的是 DEFAULTS。漂移了就会出现"设置页显示 300、实际用 600"。
   */
  const mismatch = []
  for (const name of Object.keys(dict)) {
    if (!(name in DEFAULTS)) {
      mismatch.push(`${name}: schema 有但 DEFAULTS 没有`)
      continue
    }
    const schemaDefault = fieldMeta(name)?.default
    if (schemaDefault !== DEFAULTS[name]) {
      mismatch.push(`${name}: schema=${JSON.stringify(schemaDefault)} vs DEFAULTS=${JSON.stringify(DEFAULTS[name])}`)
    }
  }
  for (const name of Object.keys(DEFAULTS)) {
    if (!(name in dict)) mismatch.push(`${name}: DEFAULTS 有但 schema 没有`)
  }
  assert.deepEqual(mismatch, [], mismatch.join('; '))
})

test('字段集合与 DEFAULTS 完全一致', () => {
  const a = Object.keys(dict).sort()
  const b = Object.keys(DEFAULTS).sort()
  assert.deepEqual(a, b)
})

// ------------------------------------------------------------------ 取值行为

test('空对象也能解析出完整默认值（不抛错）', () => {
  // Loader 在 cordis.patch.yml 的 config 块为空时也会走一次校验。
  const resolved = Config({})
  for (const name of Object.keys(dict)) {
    assert.ok(name in resolved, `解析结果缺 ${name}`)
  }
})

test('默认解析结果与原默认值一致', () => {
  const resolved = Config({})
  for (const [name, value] of Object.entries(DEFAULTS)) {
    assert.deepEqual(resolvedValue(resolved, name), value, `${name} 解析结果与默认不一致`)
  }
})

test('越界值会被约束拒绝（设置页因此能提示非法）', () => {
  // refreshSeconds 下限 5：接口有限流，配成 0.5 会把自己打限流。
  assert.throws(() => Config({ refreshSeconds: 1 }), /refreshSeconds|expected|>=|5/i)
})

test('合法值能正常解析', () => {
  const resolved = Config({ refreshSeconds: 60, lowBalanceThreshold: 20, autoStart: false })
  // volatile 字段解析成访问器对象，取值要 .get()。
  assert.equal(resolvedValue(resolved, 'refreshSeconds'), 60)
  assert.equal(resolvedValue(resolved, 'lowBalanceThreshold'), 20)
  assert.equal(resolvedValue(resolved, 'autoStart'), false)
})

console.log(`\n结果：${String(passed)}/${String(passed + failed)} 通过`)
if (failed > 0) process.exit(1)
