/**
 * 客户端设置表单与宿主配置 schema 的**一致性**检查。
 *
 * ## 为什么需要
 *
 * 设置页由两部分组成，而它们**天生容易漂移**：
 *
 *  · 宿主 `src/host/config-schema.js` —— 决定"哪些字段可编辑"、默认值、取值范围；
 *  · 客户端 `client/client.js` —— 手写的表单，决定"页面上画哪些控件、标什么默认值"。
 *
 * 客户端是**浏览器里跑的纯 JS**，拿不到宿主的 schema 模块（不能 import Host 包）。
 * 所以它内部必然要重复一份"字段清单 + 默认值"。一旦漂移，故障是**静默的**：
 *  · 客户端多写一个字段 → 保存时 Host 抛 `Config field "x" is not volatile`；
 *  · 客户端少写一个字段 → 那个配置干脆在页面上消失，不报错；
 *  · 默认值不一致 → "重置为默认"把值写成错的。
 *
 * 这个脚本把三者（schema / 客户端源码里的字段表 / 客户端的默认值表）互相对齐。
 *
 * ## 怎么比对
 *
 * 客户端源码里刻意留了两个**机器可读**的导出注释块：
 *
 * ```js
 * // @dsh-pet-fields: autoStart, startDelayMs, ...
 * // @dsh-pet-defaults: {"autoStart":true,"startDelayMs":3000,...}
 * ```
 *
 * 这个脚本用正则把它们抠出来比对。之所以用这种"注释即契约"的方式：
 * 客户端是 `window.__ModuleLoader__.load({...})` 外壳（**不是** ES 模块，
 * 没法 import），所以只能读源码文本。把契约写成固定格式的注释，
 * 既能被机器解析，也提醒改代码的人"这里要和宿主对上"。
 *
 * 运行：node scripts/dev/test-client-settings.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const CLIENT_FILE = join(ROOT, 'client', 'client.js')

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

// ------------------------------------------------------------------ 载入宿主 schema
// 宿主 schema 需要 DSH 自带的 schemastery；用与 test-config-schema.mjs 相同的
// 解析钩子把它指到从 app.asar 导出的副本。
const vendor = join(ROOT, '_research', 'schemastery')
process.env.DSH_PET_VENDOR_DIR = vendor
const { register } = await import('node:module')
register(pathToFileURL(join(HERE, 'schemastery-resolve-hook.mjs')).href, {
  parentURL: pathToFileURL(join(HERE, 'noop.mjs')).href,
})

const { Config, VOLATILE_FIELDS } = await import(
  pathToFileURL(join(ROOT, 'src', 'host', 'config-schema.js')).href
)
const { DEFAULTS } = await import(pathToFileURL(join(ROOT, 'src', 'host', 'defaults.js')).href)

const dict = Config.dict
const defaultOf = (name) => dict[name]?.meta?.default

// ------------------------------------------------------------------ 解析客户端契约
const src = readFileSync(CLIENT_FILE, 'utf8')

function extractFields() {
  const m = /\/\/\s*@dsh-pet-fields:\s*(.+)/.exec(src)
  assert.ok(m, 'client/client.js 里找不到 `// @dsh-pet-fields:` 契约注释')
  return m[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function extractDefaults() {
  const m = /\/\/\s*@dsh-pet-defaults:\s*(\{.*\})/.exec(src)
  assert.ok(m, 'client/client.js 里找不到 `// @dsh-pet-defaults:` 契约注释')
  return JSON.parse(m[1])
}

// ------------------------------------------------------------------ 结构检查

test('客户端文件存在且是 __ModuleLoader__ 外壳', () => {
  assert.ok(src.length > 500, 'client.js 太小，多半没写完')
  assert.ok(
    src.includes('window.__ModuleLoader__.load('),
    '客户端必须用 window.__ModuleLoader__.load({ id, factory }) 外壳 —— 这是 DSH 浏览器模块表的加载方式',
  )
})

test('外壳的 id 等于包名', () => {
  // id 与包名不一致会导致模块表里挂错名字，页面静默加载不到。
  const m = /__ModuleLoader__\.load\(\s*\{\s*id:\s*["'`]([^"'`]+)["'`]/.exec(src)
  assert.ok(m, '解析不出外壳的 id')
  assert.equal(m[1], 'dsh-pet-ds')
})

test('客户端没有 import Host 包或 Harness Client 包', () => {
  /*
   * DSH 官方 UI 规范明确禁止：普通 JS 没有类型检查，而这些包会变；
   * 一个抛错的组件会让**整个槽位空白**。
   * 允许的 require 只有浏览器模块表里稳定的那几个（react / react-dom / jsx-runtime）。
   */
  const requires = [...src.matchAll(/require\(\s*["'`]([^"'`]+)["'`]\s*\)/g)].map((m) => m[1])
  const banned = requires.filter(
    (r) => r.startsWith('@deepseek-ai/') || (!['react', 'react-dom', 'react/jsx-runtime'].includes(r) && !r.startsWith('node:')),
  )
  assert.deepEqual(banned, [], `客户端 require 了不该依赖的模块：${banned.join(', ')}`)
})

test('注册的是 settings.section 槽位', () => {
  assert.ok(src.includes('settings.section'), '没注册 settings.section')
  assert.ok(src.includes('whileServed'), '没用 whileServed 守卫 —— 命名空间未被服务时会画出空页面')
})

test('命名空间写的是 dsh-pet-ds（= 宿主 loader 行 id）', () => {
  assert.ok(src.includes("'dsh-pet-ds'") || src.includes('"dsh-pet-ds"'), '找不到命名空间字面量 dsh-pet-ds')
})

// ------------------------------------------------------------------ 一致性

test('客户端字段表 = 宿主的 volatile 字段集合', () => {
  /*
   * ⚠️ 这条最要紧：
   *  · 客户端多写 → 保存时 Host 抛 "Config field x is not volatile"；
   *  · 客户端少写 → 那个配置在页面上静默消失。
   */
  const clientFields = extractFields().slice().sort()
  const hostFields = [...VOLATILE_FIELDS].sort()
  assert.deepEqual(clientFields, hostFields)
})

test('客户端字段表里的字段确实都是 volatile', () => {
  for (const name of extractFields()) {
    assert.equal(dict[name]?.meta?.volatile, true, `${name} 在宿主 schema 里不是 volatile`)
  }
})

test('客户端默认值 = 宿主 schema 默认值 = DEFAULTS', () => {
  /*
   * ⚠️ 三处默认值漂移会让"重置为默认"写错值。
   * 客户端那份是手抄的（浏览器里拿不到 Host schema），所以必须机器校验。
   */
  const clientDefaults = extractDefaults()
  for (const name of extractFields()) {
    assert.equal(
      clientDefaults[name],
      defaultOf(name),
      `${name} 客户端默认值 ${JSON.stringify(clientDefaults[name])} ≠ schema 默认值 ${JSON.stringify(defaultOf(name))}`,
    )
    assert.equal(
      defaultOf(name),
      DEFAULTS[name],
      `${name} schema 默认值 ≠ DEFAULTS`,
    )
  }
})

test('客户端字段表与默认值表的键完全一致', () => {
  const fields = extractFields().slice().sort()
  const keys = Object.keys(extractDefaults()).sort()
  assert.deepEqual(keys, fields)
})

// ------------------------------------------------------------------ 收尾

console.log(`\n结果：${String(passed)}/${String(passed + failed)} 通过`)
if (failed > 0) process.exit(1)
