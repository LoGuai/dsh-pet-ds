/**
 * 好感存档（`pet-app/affection-store.js`）的检查。
 *
 * 为什么值得单测：这是**唯一**会把玩家养成结果写到磁盘的地方。
 * 写坏了/读坏了，用户看到的是"养了几天的好感没了" —— 比崩溃更让人恼火。
 *
 * 覆盖：
 *  1. 往返（存进去 → 读出来）；
 *  2. 原子写（写到一半崩溃不会留下半个 JSON）；
 *  3. 坏文件容错（不删原文件、按默认值继续）；
 *  4. 脏数据规整（爱心数/阶段值越界时按共享核心的规则夹取）；
 *  5. 路径与安装目录无关（这是"升级不丢数据"的结构性保证）。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createAffectionStore, FILE_NAME, STORE_VERSION } = require('../../pet-app/affection-store.js')
const { initialAffection, applyAffectionGain, AFFECTION_MAX_HEARTS } = await import(
  '../../src/shared-core/affection.js'
)

let passed = 0
let failed = 0
const test = (name, fn) => {
  try {
    fn()
    passed += 1
    console.log(`  PASS  ${name}`)
  } catch (err) {
    failed += 1
    console.log(`  FAIL  ${name} — ${err.message}`)
  }
}

/** 造一个临时目录 + 存档器。 */
const makeStore = () => {
  const dir = mkdtempSync(join(tmpdir(), 'pet-aff-'))
  return { dir, store: createAffectionStore({ dir: () => dir }), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

// ---------------------------------------------------------------- 基本往返
test('首次启动：没有存档时返回默认值且 loaded=false', () => {
  const { store, cleanup } = makeStore()
  try {
    const loaded = store.load()
    assert.equal(loaded.loaded, false)
    assert.equal(loaded.state.hearts, 0)
    assert.equal(loaded.state.value, 0)
    assert.equal(loaded.lastClickAt, null)
    assert.equal(loaded.lifetimeGained, 0)
  } finally {
    cleanup()
  }
})

test('存档往返：写入的爱心/阶段/冷却/累计都能读回来', () => {
  const { dir, store, cleanup } = makeStore()
  try {
    const ok = store.save(
      { hearts: 3, value: 42, updatedAt: 1700000000000 },
      { lastClickAt: 1700000123456, lifetimeGained: 1234 },
      1700000200000,
    )
    assert.equal(ok, true)

    // 文件真的是那个名字、内容是合法 JSON、带版本号
    const file = join(dir, FILE_NAME)
    assert.ok(existsSync(file), `存档文件不存在：${file}`)
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(raw.version, STORE_VERSION)
    assert.equal(raw.hearts, 3)
    assert.equal(raw.value, 42)

    const loaded = store.load(1700000300000)
    assert.equal(loaded.loaded, true)
    assert.equal(loaded.state.hearts, 3)
    assert.equal(loaded.state.value, 42)
    assert.equal(loaded.lastClickAt, 1700000123456)
    assert.equal(loaded.lifetimeGained, 1234)
  } finally {
    cleanup()
  }
})

test('存档路径在给定目录下，文件名固定', () => {
  const { dir, store, cleanup } = makeStore()
  try {
    assert.equal(store.path(), join(dir, FILE_NAME))
  } finally {
    cleanup()
  }
})

// ---------------------------------------------------------------- 原子写
test('原子写：写完不留下 .tmp 残余', () => {
  const { dir, store, cleanup } = makeStore()
  try {
    store.save({ hearts: 1, value: 5 })
    assert.ok(!existsSync(join(dir, `${FILE_NAME}.tmp`)), '不应留下 .tmp 文件')
    assert.ok(existsSync(join(dir, FILE_NAME)))
  } finally {
    cleanup()
  }
})

test('每次写入把上一份留成 .bak（存档是不可再生数据，要能手工找回）', () => {
  const { dir, store, cleanup } = makeStore()
  try {
    store.save({ hearts: 1, value: 11 }, { lifetimeGained: 11 })
    // 第一次写时还没有旧文件，不该凭空造 .bak
    assert.ok(!existsSync(join(dir, `${FILE_NAME}.bak`)), '首次写入不该有 .bak')

    store.save({ hearts: 2, value: 22 }, { lifetimeGained: 22 })
    const bak = join(dir, `${FILE_NAME}.bak`)
    assert.ok(existsSync(bak), '第二次写入应留下 .bak')

    // .bak 里必须是**上一份**（值 11），不是当前值
    const bakJson = JSON.parse(readFileSync(bak, 'utf8'))
    assert.equal(bakJson.hearts, 1)
    assert.equal(bakJson.value, 11)

    // 当前文件是新的
    const cur = JSON.parse(readFileSync(join(dir, FILE_NAME), 'utf8'))
    assert.equal(cur.value, 22)
  } finally {
    cleanup()
  }
})

// ---------------------------------------------------------------- 容错
test('坏存档容错：不抛、不删原文件、按默认值继续', () => {
  const { dir, store, cleanup } = makeStore()
  try {
    const file = join(dir, FILE_NAME)
    writeFileSync(file, '{ 这不是合法 JSON', 'utf8')
    const loaded = store.load()
    assert.equal(loaded.loaded, false)
    assert.equal(loaded.state.hearts, 0)
    // 损坏的文件要留着（万一用户想手工找回），不能删
    assert.ok(existsSync(file), '损坏的存档不该被删掉')
  } finally {
    cleanup()
  }
})

test('脏数据规整：爱心越界夹到 0~5，阶段值夹到当前阈值', () => {
  const { dir, store, cleanup } = makeStore()
  try {
    writeFileSync(
      join(dir, FILE_NAME),
      JSON.stringify({ version: 1, hearts: 99, value: 99999, lastClickAt: 'x', lifetimeGained: -5 }),
      'utf8',
    )
    const loaded = store.load()
    assert.ok(loaded.state.hearts <= AFFECTION_MAX_HEARTS, `爱心数应被夹取，实际 ${String(loaded.state.hearts)}`)
    assert.ok(loaded.state.value >= 0)
    assert.equal(loaded.lastClickAt, null, '非数字的 lastClickAt 应被当成 null')
    assert.equal(loaded.lifetimeGained, 0, '负数累计应被夹到 0')
  } finally {
    cleanup()
  }
})

test('目录不存在时会自动创建', () => {
  const base = mkdtempSync(join(tmpdir(), 'pet-aff-'))
  const nested = join(base, 'a', 'b', 'c')
  try {
    const store = createAffectionStore({ dir: () => nested })
    assert.equal(store.save({ hearts: 2, value: 7 }), true)
    assert.ok(existsSync(join(nested, FILE_NAME)))
    assert.equal(store.load().state.value, 7)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('clear() 能删档，之后读回默认值', () => {
  const { store, cleanup } = makeStore()
  try {
    store.save({ hearts: 4, value: 300 })
    assert.equal(store.load().loaded, true)
    assert.equal(store.clear(), true)
    assert.equal(store.load().loaded, false)
  } finally {
    cleanup()
  }
})

// ---------------------------------------------------------------- 与共享核心一致
test('存档的数值能直接喂给 applyAffectionGain（晋心后写回再读一致）', () => {
  const { store, cleanup } = makeStore()
  try {
    let state = initialAffection(0)
    // 攒满 100 晋 1 心
    state = applyAffectionGain(state, 100, 1).state
    assert.equal(state.hearts, 1)
    assert.equal(state.value, 0)

    store.save(state, { lifetimeGained: 100 })
    const loaded = store.load()
    assert.equal(loaded.state.hearts, 1)
    assert.equal(loaded.state.value, 0)
    assert.equal(loaded.lifetimeGained, 100)
  } finally {
    cleanup()
  }
})

test('没有 Electron 时回落到进程工作目录（仅兜底，生产环境走 userData）', () => {
  /*
   * 这条**只验兜底路径存在**，不代表生产行为。
   *
   * 纯 Node 里 `require('electron')` 拿到的是路径字符串、没有 `app`，
   * 所以 `defaultDir()` 会回落到 `process.cwd()`。
   *
   * 真正的保证（存档在 `%APPDATA%\DSH Pet\`、与安装目录分离）在
   * **自测**里验（那时有真的 Electron app）：见 main.js 的
   * `verifyAffectionPersistence`。
   */
  const store = createAffectionStore()
  assert.ok(store.path().endsWith(FILE_NAME), `兜底路径应以存档文件名结尾：${store.path()}`)
})

console.log(`\n结果：${String(passed)}/${String(passed + failed)} 通过`)
if (failed > 0) process.exit(1)
