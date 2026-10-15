/**
 * 好感值的单元测试。
 *
 * 重点覆盖**晋心边界**与**满级封顶** —— 这两处靠点界面很难验：
 *  · 一开始是 0 心；攒满 100 变 1 心；
 *  · 恰好攒满阈值时该晋心（阶段值归 0、爱心 +1）；
 *  · 一次加很多点该连晋多心，且不丢点数；
 *  · 到 5 心后阶段值攒满 3000 就**彻底不再变化**（用户明确要求）。
 *
 * 运行：node scripts/dev/test-affection.mjs
 */

import assert from 'node:assert/strict'

import {
  AFFECTION_HEART_LABELS,
  AFFECTION_MAX_HEARTS,
  AFFECTION_STAGE_THRESHOLDS,
  affectionHeartsLabel,
  affectionProgress,
  affectionStagesPayload,
  applyAffectionGain,
  clampHearts,
  heartsFor,
  initialAffection,
  isMaxHearts,
  normalizeAffection,
  stageThresholdFor,
} from '../../src/shared-core/affection.js'

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

const T0 = 1_700_000_000_000

// ---------------------------------------------------------------- 等级表

test('五段阶段阈值是 100 / 200 / 500 / 1000 / 3000，最大 5 心', () => {
  assert.deepEqual(AFFECTION_STAGE_THRESHOLDS, [100, 200, 500, 1000, 3000])
  assert.equal(AFFECTION_MAX_HEARTS, 5)
})

test('stageThresholdFor 按爱心数取阈值，越界夹到合法值', () => {
  assert.equal(stageThresholdFor(0), 100, '0 心 → 攒满 100 得第 1 心')
  assert.equal(stageThresholdFor(1), 200)
  assert.equal(stageThresholdFor(2), 500)
  assert.equal(stageThresholdFor(3), 1000)
  assert.equal(stageThresholdFor(4), 3000)
  // 满级后仍返回 3000（作为阶段值的封顶值）。
  assert.equal(stageThresholdFor(5), 3000)
  assert.equal(stageThresholdFor(-3), 100)
  assert.equal(stageThresholdFor(99), 3000)
  assert.equal(stageThresholdFor(Number.NaN), 100)
})

test('clampHearts 与 isMaxHearts', () => {
  assert.equal(clampHearts(0), 0)
  assert.equal(clampHearts(5), 5)
  assert.equal(clampHearts(-1), 0)
  assert.equal(clampHearts(9), 5)
  assert.equal(clampHearts(2.9), 2)
  assert.equal(isMaxHearts(4), false)
  assert.equal(isMaxHearts(5), true)
})

// ---------------------------------------------------------------- 初始与容错

test('初始状态是 0 颗心、阶段 0（用户明确要求）', () => {
  const s = initialAffection(T0)
  assert.equal(s.value, 0)
  assert.equal(s.hearts, 0, '一开始是 0 心，不是 1 心')
  assert.equal(s.updatedAt, T0)
})

test('normalizeAffection 容错：脏数据都用安全值', () => {
  assert.equal(normalizeAffection(null, T0).hearts, 0)
  assert.equal(normalizeAffection(null, T0).value, 0)
  assert.equal(normalizeAffection({ value: 'x', hearts: 'y' }, T0).value, 0)
  assert.equal(normalizeAffection({ value: 50, hearts: 3 }, T0).hearts, 3)
  // 阶段值不能超过当前阈值。
  assert.equal(normalizeAffection({ value: 9999, hearts: 0 }, T0).value, 100)
  assert.equal(normalizeAffection({ value: 9999, hearts: 4 }, T0).value, 3000)
  assert.equal(normalizeAffection({ value: -50, hearts: 2 }, T0).value, 0)
  assert.equal(normalizeAffection({ value: 10, hearts: 1 }, T0).updatedAt, T0)
})

// ---------------------------------------------------------------- 晋心（核心）

test('未满阈值时只累加阶段值，爱心数不变', () => {
  let s = initialAffection(T0)
  for (const g of [10, 20, 30, 39]) s = applyAffectionGain(s, g, T0).state
  assert.equal(s.value, 99)
  assert.equal(s.hearts, 0, '还差 1 点，不该有爱心')
})

test('攒满 100 就晋为 1 心，且阶段值归 0', () => {
  const s = applyAffectionGain(initialAffection(T0), 99, T0).state
  const r = applyAffectionGain(s, 1, T0)
  assert.equal(r.state.hearts, 1, '攒满 100 应当是 1 心')
  assert.equal(r.state.value, 0, '晋心后阶段值必须归 0')
  assert.equal(r.heartsGained, 1)
})

test('晋心只消耗"刚好攒满"的那一点，其余点数继续累加', () => {
  /*
   * 逐点结算的直接体现，也是必须的：
   * 若把 gain 一次性加到阶段值上再判晋心，99 + 150 会变成"1 心、阶段 0"，
   * 那 149 点就凭空消失了 —— 加得越多丢得越多。
   *
   * 逐点走：150 点里第 1 点把阶段从 99 补到 100 → 晋心、阶段归 0；
   * 剩下 149 点继续累加 → 1 心、阶段 149。
   */
  const s = applyAffectionGain(initialAffection(T0), 99, T0).state
  const r = applyAffectionGain(s, 150, T0)
  assert.equal(r.state.hearts, 1)
  assert.equal(r.state.value, 149, `溢出量必须保留，实际 ${String(r.state.value)}`)
  assert.equal(r.heartsGained, 1)
})

test('精确验证五段阈值：每段"差 1 点不晋、加 1 点即晋"', () => {
  // 累计达到各段阈值即晋心：100 → 1 心，300 → 2 心，800 → 3 心，1800 → 4 心，4800 → 5 心。
  const cumulative = [100, 300, 800, 1800, 4800]
  cumulative.forEach((total, i) => {
    const before = applyAffectionGain(initialAffection(T0), total - 1, T0).state
    assert.equal(before.hearts, i, `累计 ${String(total - 1)} 点应当还是 ${String(i)} 心`)
    const at = applyAffectionGain(initialAffection(T0), total, T0).state
    assert.equal(at.hearts, i + 1, `累计 ${String(total)} 点应当是 ${String(i + 1)} 心`)
    assert.equal(at.value, 0, `刚好晋心时阶段值应为 0，实际 ${String(at.value)}`)
  })
})

test('一次加很多点会连晋多心，点数不丢', () => {
  // 0 心阶段 0 加 300：100 晋 1 心、200 晋 2 心，300 点刚好用尽 → 2 心、阶段 0。
  const r = applyAffectionGain(initialAffection(T0), 300, T0)
  assert.equal(r.state.hearts, 2, `应当连晋到 2 心，实际 ${String(r.state.hearts)}`)
  assert.equal(r.state.value, 0, `300 点刚好用尽，阶段应为 0，实际 ${String(r.state.value)}`)
  assert.equal(r.heartsGained, 2)

  // 多加 1 点才落在 2 心的阶段 1。
  const r2 = applyAffectionGain(r.state, 1, T0)
  assert.equal(r2.state.hearts, 2)
  assert.equal(r2.state.value, 1)
})

test('一次加满级：4800 点直达 5 心', () => {
  const r = applyAffectionGain(initialAffection(T0), 4800, T0)
  assert.equal(r.state.hearts, 5, `应当到 5 心，实际 ${String(r.state.hearts)}`)
  assert.equal(r.state.value, 0, '刚好用尽，阶段为 0')
  assert.equal(r.heartsGained, 5)
  assert.equal(r.capped, true)
})

test('逐点结算与"一次加"结果完全等价（可结合律）', () => {
  const once = applyAffectionGain(initialAffection(T0), 1234, T0).state
  let stepwise = initialAffection(T0)
  for (let i = 0; i < 1234; i += 1) stepwise = applyAffectionGain(stepwise, 1, T0).state
  assert.deepEqual(
    { hearts: once.hearts, value: once.value },
    { hearts: stepwise.hearts, value: stepwise.value },
    `一次加与逐点加必须等价：${JSON.stringify(once)} vs ${JSON.stringify(stepwise)}`,
  )
})

// ---------------------------------------------------------------- 满级封顶

test('满级后再加点只到 3000，不越界', () => {
  const maxed = { value: 0, hearts: 5, updatedAt: T0 }
  const r1 = applyAffectionGain(maxed, 1234, T0)
  assert.equal(r1.state.hearts, 5)
  assert.equal(r1.state.value, 1234)
  assert.equal(r1.capped, true)

  const r2 = applyAffectionGain(r1.state, 5000, T0)
  assert.equal(r2.state.value, 3000, '不得越过 3000')
  assert.equal(r2.state.hearts, 5, '爱心数不得继续增长（最多 5 颗）')
})

test('满级且阶段值到 3000 后，再加多少都不变（用户明确要求）', () => {
  const full = { value: 3000, hearts: 5, updatedAt: T0 }
  for (const g of [1, 100, 99999, Number.POSITIVE_INFINITY]) {
    const r = applyAffectionGain(full, g, T0)
    assert.equal(r.state.value, 3000, `加 ${String(g)} 后阶段值应仍为 3000`)
    assert.equal(r.state.hearts, 5)
    assert.equal(r.heartsGained, 0)
  }
})

test('满级不会掉出 5 心（没有下降逻辑）', () => {
  const full = { value: 3000, hearts: 5, updatedAt: T0 }
  assert.equal(applyAffectionGain(full, -500, T0).state.hearts, 5)
  assert.equal(applyAffectionGain(full, 0, T0).state.value, 3000)
  assert.equal(applyAffectionGain(full, Number.NaN, T0).state.value, 3000)
})

test('好感不会下降：负数增量只更新时间戳', () => {
  const s = { value: 40, hearts: 2, updatedAt: T0 }
  const r = applyAffectionGain(s, -30, T0 + 1000)
  assert.equal(r.state.value, 40)
  assert.equal(r.state.hearts, 2)
  assert.equal(r.state.updatedAt, T0 + 1000)
  assert.equal(r.gained, 0)
})

// ---------------------------------------------------------------- 展示

test('爱心串：0 心全是空心；实心表示已达到的爱心数', () => {
  assert.equal(heartsFor(0), '♡♡♡♡♡', '0 心时应当全是空心')
  assert.equal(heartsFor(1), '♥♡♡♡♡')
  assert.equal(heartsFor(3), '♥♥♥♡♡')
  assert.equal(heartsFor(5), '♥♥♥♥♥')
  // 越界夹取，且**长度恒为 5**（面板宽度因此恒定，不会抖动）。
  for (const h of [-5, 0, 1, 3, 5, 9]) {
    assert.equal([...heartsFor(h)].length, AFFECTION_MAX_HEARTS, `爱心数 ${String(h)} 的串长必须是 5`)
  }
})

test('六档称呼：索引即爱心数', () => {
  assert.equal(AFFECTION_HEART_LABELS.length, 6)
  assert.equal(affectionHeartsLabel(0), '陌生')
  assert.equal(affectionHeartsLabel(1), '眼熟')
  assert.equal(affectionHeartsLabel(5), '挚爱')
  assert.equal(affectionHeartsLabel(99), '挚爱')
})

test('affectionProgress 是当前阶段的进度 0~1', () => {
  assert.equal(affectionProgress({ value: 0, hearts: 0, updatedAt: T0 }), 0)
  assert.equal(affectionProgress({ value: 50, hearts: 0, updatedAt: T0 }), 0.5)
  assert.equal(affectionProgress({ value: 150, hearts: 1, updatedAt: T0 }), 0.75, '1 心时阈值是 200')
  assert.equal(affectionProgress({ value: 3000, hearts: 5, updatedAt: T0 }), 1)
})

test('下发给渲染进程的等级表完整且与常量一致', () => {
  const payload = affectionStagesPayload()
  assert.equal(payload.length, AFFECTION_MAX_HEARTS)
  payload.forEach((row, i) => {
    assert.equal(row.hearts, i)
    assert.equal(row.threshold, AFFECTION_STAGE_THRESHOLDS[i])
    assert.equal(typeof row.label, 'string')
    assert.ok(row.label.length > 0)
  })
})

// ---------------------------------------------------------------- 综合

test('从零一路攒到满级：爱心单调递增，最终停在 5 心 / 3000', () => {
  let s = initialAffection(T0)
  let lastHearts = s.hearts
  let ups = 0
  // 每次加 37 点，够零碎，能覆盖各种边界余数。
  // 累计需要 4800 点，400 次 ×37 = 14800 点，足够到顶并验证封顶。
  for (let i = 0; i < 400; i += 1) {
    s = applyAffectionGain(s, 37, T0).state
    assert.ok(s.hearts >= lastHearts, '爱心数不该下降')
    assert.ok(s.hearts <= AFFECTION_MAX_HEARTS, `爱心数不得超过 5，实际 ${String(s.hearts)}`)
    if (s.hearts > lastHearts) ups += 1
    lastHearts = s.hearts
    assert.ok(
      s.value >= 0 && s.value <= stageThresholdFor(s.hearts),
      `阶段值必须落在 [0, 阈值] 内，实际 ${String(s.value)}（${String(s.hearts)} 心）`,
    )
  }
  assert.equal(s.hearts, 5, '最终应当到满级 5 心')
  assert.equal(s.value, 3000, '满级后应当攒满到 3000')
  assert.equal(ups, 5, `应当恰好晋心 5 次，实际 ${String(ups)}`)
})

console.log(`\n结果：${String(passed)}/${String(passed + failed)} 通过`)
if (failed > 0) process.exit(1)
