/**
 * 好感度增长规则（`src/shared-core/affection-gain.js`）的检查。
 *
 * 这里只测**纯函数**：数值是否与用户指定的五条途径一致、冷却边界、
 * 低心情奖励的合并。主进程里的接入（谁在什么时机调）由自测覆盖。
 */

import assert from 'node:assert/strict'
import {
  AFFECTION_GAIN,
  LOW_MOOD_THRESHOLD,
  LOW_MOOD_CLICK_MOOD_GAIN,
  pickClickAffectionGain,
  clickAffectionReady,
  clickAffectionGain,
} from '../../src/shared-core/affection-gain.js'
import { initialAffection, applyAffectionGain, AFFECTION_MAX_HEARTS } from '../../src/shared-core/affection.js'

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

test('五条增长途径的数值与用户要求一致', () => {
  assert.equal(AFFECTION_GAIN.idleDialogue, 1, '闲置对话应 +1')
  assert.equal(AFFECTION_GAIN.clickMin, 2, '点击下限应 2')
  assert.equal(AFFECTION_GAIN.clickMax, 8, '点击上限应 8')
  assert.equal(AFFECTION_GAIN.clickCooldownMs, 5 * 60 * 1000, '点击冷却应 5 分钟')
  assert.equal(AFFECTION_GAIN.randomAction, 2, '随机动作应 +2')
  assert.equal(AFFECTION_GAIN.uptimeEveryMs, 10 * 60 * 1000, '运行时长周期应 10 分钟')
  assert.equal(AFFECTION_GAIN.uptimeGain, 5, '运行时长奖励应 +5')
  assert.equal(AFFECTION_GAIN.lowMoodClick, 10, '低心情点击应 +10')
  assert.equal(LOW_MOOD_THRESHOLD, 50, '低心情阈值应 50')
  assert.equal(LOW_MOOD_CLICK_MOOD_GAIN, 50, '低心情点击应 +50 心情')
})

test('点击增量落在 2~8 闭区间内（含两端可达）', () => {
  // rand=0 → 下限；rand 接近 1 → 上限
  assert.equal(pickClickAffectionGain(() => 0), 2)
  assert.equal(pickClickAffectionGain(() => 0.999999), 8)
  for (let i = 0; i < 200; i += 1) {
    const g = pickClickAffectionGain()
    assert.ok(g >= 2 && g <= 8, `抽到 ${String(g)}，应在 2~8`)
    assert.equal(Number.isInteger(g), true, '应为整数')
  }
})

test('冷却：从未点过就算就绪，刚点过要等满 5 分钟', () => {
  const now = 1_000_000
  assert.deepEqual(clickAffectionReady(null, now), { ready: true, waitMs: 0 })
  assert.deepEqual(clickAffectionReady(Number.NaN, now), { ready: true, waitMs: 0 })
  const justClicked = clickAffectionReady(now, now)
  assert.equal(justClicked.ready, false)
  assert.equal(justClicked.waitMs, 5 * 60 * 1000)
  // 差 1 毫秒仍未就绪
  assert.equal(clickAffectionReady(now - (5 * 60 * 1000) + 1, now).ready, false)
  // 刚好满 5 分钟就就绪
  assert.equal(clickAffectionReady(now - 5 * 60 * 1000, now).ready, true)
  // 超过也应当就绪
  assert.equal(clickAffectionReady(now - 6 * 60 * 1000, now).ready, true)
})

test('点击增量：普通心情给 2~8，低心情再 +10', () => {
  const now = 2_000_000
  const normal = clickAffectionGain({ lastAtMs: null, now, moodValue: 80, rand: () => 0 })
  assert.equal(normal.lowMood, false)
  assert.equal(normal.base, 2)
  assert.equal(normal.bonus, 0)
  assert.equal(normal.gain, 2)

  const low = clickAffectionGain({ lastAtMs: null, now, moodValue: 49, rand: () => 0 })
  assert.equal(low.lowMood, true, '心情 49 应算低心情')
  assert.equal(low.base, 2)
  assert.equal(low.bonus, 10)
  assert.equal(low.gain, 12)
})

test('低心情阈值边界：49 算低、50 不算', () => {
  const now = 3_000_000
  assert.equal(clickAffectionGain({ lastAtMs: null, now, moodValue: 49, rand: () => 0 }).lowMood, true)
  assert.equal(clickAffectionGain({ lastAtMs: null, now, moodValue: 50, rand: () => 0 }).lowMood, false)
})

test('冷却中：基础值与低心情奖励都不给', () => {
  const now = 4_000_000
  const cooling = clickAffectionGain({ lastAtMs: now - 1000, now, moodValue: 10, rand: () => 0 })
  assert.equal(cooling.coolingDown, true)
  assert.equal(cooling.gain, 0)
  assert.equal(cooling.bonus, 0, '低心情奖励也必须受冷却约束，否则连点能刷')
  // `lowMood` 仍然如实反映心情（渲染进程要靠它决定说什么）
  assert.equal(cooling.lowMood, true)
})

test('非法输入容错：不崩、按普通心情处理', () => {
  const now = 5_000_000
  const r = clickAffectionGain({ lastAtMs: null, now, moodValue: Number.NaN, rand: () => 0 })
  assert.equal(r.lowMood, false, '心情非法时不应判成低心情')
  assert.equal(r.gain, 2)
})

test('入账能真的推动爱心（与 applyAffectionGain 串起来）', () => {
  let state = initialAffection(0)
  // 攒 100 点晋 1 心
  const r = applyAffectionGain(state, 100, 1)
  state = r.state
  assert.equal(state.hearts, 1)
  assert.equal(state.value, 0)
  // 一路点到满级不会越界
  let guard = 0
  while (state.hearts < AFFECTION_MAX_HEARTS && guard < 10000) {
    state = applyAffectionGain(state, AFFECTION_GAIN.clickMax, 1).state
    guard += 1
  }
  assert.equal(state.hearts, AFFECTION_MAX_HEARTS)
})

console.log(`\n结果：${String(passed)}/${String(passed + failed)} 通过`)
if (failed > 0) process.exit(1)
