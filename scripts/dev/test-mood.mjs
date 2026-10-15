/**
 * 心情值纯函数的单元测试。
 *
 * 为什么单独测这一块：心情的衰减是"按时间戳补算"的，跨周期、跨重启、上下夹取
 * 这些边界靠肉眼或手动点击都验不出来，而它又直接决定属性面板上的数字。
 * 这些函数是纯函数，因此可以给定时间戳做确定性断言。
 *
 * 运行：node scripts/dev/test-mood.mjs
 */

import assert from 'node:assert/strict'

import {
  MOOD_DECAY_INTERVAL_MS,
  MOOD_GAIN_PER_PET_MIN,
  MOOD_GAIN_PER_PET_MAX,
  MOOD_GAIN_PER_ACTION_MIN,
  MOOD_GAIN_PER_ACTION_MAX,
  MOOD_INITIAL,
  MOOD_MAX,
  MOOD_MIN,
  applyActionReward,
  applyDecay,
  applyPet,
  clampMood,
  initialMood,
  moodTier,
  normalizeMood,
  pickGainInRange,
  pickPetGain,
  pickActionGain,
} from '../../src/shared-core/mood.js'

let passed = 0
let failed = 0

/**
 * 跑一个用例。
 * @param {string} name
 * @param {() => void} fn
 */
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
const MIN = MOOD_DECAY_INTERVAL_MS

test('初始值为满值 100', () => {
  assert.equal(MOOD_INITIAL, 100)
  assert.equal(initialMood(T0).value, 100)
  assert.equal(initialMood(T0).updatedAt, T0)
})

test('启动即满值：新会话不受上一会话影响', () => {
  // 心情不落盘，所以"启动"总是等价于 initialMood(now)。
  // 上一会话结束时无论掉到多少，新会话都从 100 开始。
  const previousSessionEnd = { value: 37, updatedAt: T0 }
  assert.equal(previousSessionEnd.value, 37)
  assert.equal(initialMood(T0 + 999999).value, 100)
})

test('不足一个周期不衰减', () => {
  const { state, decayed } = applyDecay(initialMood(T0), T0 + MIN - 1)
  assert.equal(decayed, 0)
  assert.equal(state.value, 100)
})

test('恰好一个周期衰减 1 点', () => {
  const { state, decayed } = applyDecay(initialMood(T0), T0 + MIN)
  assert.equal(decayed, 1)
  assert.equal(state.value, 99)
})

test('跨多个周期一次算清（不逐周期循环）', () => {
  const { state, decayed } = applyDecay(initialMood(T0), T0 + MIN * 7)
  assert.equal(decayed, 7)
  assert.equal(state.value, 93)
})

test('余数留到下次，不被抹平', () => {
  // 走 2.5 个周期：只结算 2 点，updatedAt 停在 2 个周期处。
  const { state } = applyDecay(initialMood(T0), T0 + Math.floor(MIN * 2.5))
  assert.equal(state.value, 98)
  assert.equal(state.updatedAt, T0 + MIN * 2)
  // 再走 0.5 个周期就正好凑满第 3 个。
  const second = applyDecay(state, T0 + MIN * 3)
  assert.equal(second.decayed, 1)
  assert.equal(second.state.value, 97)
})

test('长时间离线（模拟重启）也只算一次', () => {
  // 离线 1 小时 = 20 个周期。
  const { state } = applyDecay(initialMood(T0), T0 + 60 * 60 * 1000)
  assert.equal(state.value, 80)
})

test('衰减不会低于 0', () => {
  const { state } = applyDecay(initialMood(T0), T0 + MIN * 500)
  assert.equal(state.value, MOOD_MIN)
})

test('结算到 0 之后继续过时间仍然停在 0', () => {
  const { state } = applyDecay({ value: 0, updatedAt: T0 }, T0 + MIN * 10)
  assert.equal(state.value, 0)
})

/*
 * ⚠️ 下面凡是关心"加减算术"的用例都**显式传 gain**。
 *
 * 点击加心情已改为随机区间（3~10，用户指定），若不给 gain，这些断言就会
 * 依赖随机数而时对时错。显式传值让"算术"与"取值区间"分开测 ——
 * 区间本身由本文件末尾那几条专门断言覆盖。
 */
test('互动加固定值时按值相加', () => {
  const { state, gained } = applyPet({ value: 50, updatedAt: T0 }, T0, 10)
  assert.equal(state.value, 60)
  assert.equal(gained, 10)
})

test('互动不会超过 100', () => {
  const { state, gained } = applyPet({ value: 98, updatedAt: T0 }, T0, 10)
  assert.equal(state.value, MOOD_MAX)
  // 实际只加了 2 点，回报值必须反映真实增量而不是名义值。
  assert.equal(gained, 2)
})

test('互动前会先结算衰减', () => {
  // 过了 4 个周期：100 → 96，再加 10 → 100（夹住）。
  const { state, decayed } = applyPet(initialMood(T0), T0 + MIN * 4, 10)
  assert.equal(decayed, 4)
  assert.equal(state.value, 100)
})

test('互动在低心情时同样先算衰减', () => {
  const { state } = applyPet({ value: 30, updatedAt: T0 }, T0 + MIN * 3, 10)
  // 30 - 3 + 10 = 37
  assert.equal(state.value, 37)
})

// ---------------------------------------------------------------- 随机区间（用户指定）

test('点击加心情的区间是 3~10', () => {
  assert.equal(MOOD_GAIN_PER_PET_MIN, 3)
  assert.equal(MOOD_GAIN_PER_PET_MAX, 10)
})

test('闲置随机动作的区间是 10~30', () => {
  assert.equal(MOOD_GAIN_PER_ACTION_MIN, 10)
  assert.equal(MOOD_GAIN_PER_ACTION_MAX, 30)
})

test('pickGainInRange 含两端，且只产出区间内的整数', () => {
  // 用注入的随机源把两端都逼出来，这是"含两端"的确定性验证方式。
  assert.equal(pickGainInRange(3, 10, () => 0), 3)
  assert.equal(pickGainInRange(3, 10, () => 0.999999), 10)
  for (let i = 0; i < 2000; i += 1) {
    const v = pickGainInRange(3, 10)
    assert.ok(Number.isInteger(v) && v >= 3 && v <= 10, `越界 ${String(v)}`)
  }
})

test('pickPetGain 只产出 3~10', () => {
  for (let i = 0; i < 2000; i += 1) {
    const v = pickPetGain()
    assert.ok(v >= MOOD_GAIN_PER_PET_MIN && v <= MOOD_GAIN_PER_PET_MAX, `越界 ${String(v)}`)
  }
})

test('pickActionGain 只产出 10~30', () => {
  for (let i = 0; i < 2000; i += 1) {
    const v = pickActionGain()
    assert.ok(v >= MOOD_GAIN_PER_ACTION_MIN && v <= MOOD_GAIN_PER_ACTION_MAX, `越界 ${String(v)}`)
  }
})

test('applyPet 缺省 gain 时自己从区间取（多种取值都出现过）', () => {
  const seen = new Set()
  for (let i = 0; i < 300; i += 1) {
    const { state, gained } = applyPet({ value: 0, updatedAt: T0 }, T0)
    assert.ok(gained >= MOOD_GAIN_PER_PET_MIN && gained <= MOOD_GAIN_PER_PET_MAX, `越界 ${String(gained)}`)
    seen.add(gained)
  }
  assert.ok(seen.size > 1, `取值应当有变化，实际只有 ${[...seen].join(',')}`)
})

test('applyActionReward 缺省 gain 时自己从区间取', () => {
  const seen = new Set()
  for (let i = 0; i < 300; i += 1) {
    const { state, gained } = applyActionReward({ value: 0, updatedAt: T0 }, T0)
    assert.ok(gained >= MOOD_GAIN_PER_ACTION_MIN && gained <= MOOD_GAIN_PER_ACTION_MAX, `越界 ${String(gained)}`)
    seen.add(gained)
  }
  assert.ok(seen.size > 1, `取值应当有变化，实际只有 ${[...seen].join(',')}`)
})

test('applyActionReward 同样会先结算衰减，且不超上限', () => {
  // 过了 4 个周期：100 → 96，再加 10~30 → 夹到 100。
  const { state, decayed } = applyActionReward(initialMood(T0), T0 + MIN * 4)
  assert.equal(decayed, 4)
  assert.equal(state.value, MOOD_MAX)
  // 低心情时按显式值精确相加。
  const mid = applyActionReward({ value: 30, updatedAt: T0 }, T0 + MIN * 3, 20)
  assert.equal(mid.state.value, 47) // 30 - 3 + 20
})

test('clampMood 夹取与容错', () => {
  assert.equal(clampMood(-5), 0)
  assert.equal(clampMood(150), 100)
  assert.equal(clampMood(Number.NaN), MOOD_INITIAL)
  assert.equal(clampMood(Number.POSITIVE_INFINITY), MOOD_INITIAL)
})

test('normalizeMood 容错：缺字段/脏数据都用安全值', () => {
  assert.equal(normalizeMood(null, T0).value, 100)
  assert.equal(normalizeMood(null, T0).updatedAt, T0)
  assert.equal(normalizeMood({ value: 'x', updatedAt: 'y' }, T0).value, 100)
  assert.equal(normalizeMood({ value: 80, updatedAt: 'y' }, T0).updatedAt, T0)
  // updatedAt 为未来时间时不应当产生负衰减
  const future = normalizeMood({ value: 77, updatedAt: T0 + MIN * 10 }, T0)
  assert.equal(future.value, 77)
})

test('心情档位边界', () => {
  assert.equal(moodTier(100), 'happy')
  assert.equal(moodTier(80), 'happy')
  assert.equal(moodTier(79), 'normal')
  assert.equal(moodTier(50), 'normal')
  assert.equal(moodTier(49), 'low')
  assert.equal(moodTier(20), 'low')
  assert.equal(moodTier(19), 'sad')
  assert.equal(moodTier(0), 'sad')
})

test('周期性互动的综合场景（固定 gain 时净持平）', () => {
  // 模拟：起始满值，每 3 分钟掉 1，途中每 30 分钟点一次、每次固定加 10。
  let state = initialMood(T0)
  let now = T0
  for (let i = 0; i < 10; i += 1) {
    now += 30 * 60 * 1000 // 30 分钟
    state = applyDecay(state, now).state
    state = applyPet(state, now, 10).state
  }
  // 每 30 分钟掉 10 点、加 10 点 → 净持平，应当仍在满值附近。
  assert.equal(state.value, 100)
})

test('周期性互动的综合场景（真实随机 gain 时缓慢下滑但不崩）', () => {
  /*
   * 点击加心情改为随机 3~10 后的**真实**行为：
   * 每 30 分钟衰减 10 点，而点击期望只加 6.5 点（(3+10)/2），
   * 所以长期是**净下降**的 —— 这是改区间的自然结果，不是 bug。
   *
   * 这里断言的是"下降得平缓、且始终在合法范围内"，而不是某个精确值
   * （随机数不可复现，断言精确值只会变成偶发失败）。
   */
  let state = initialMood(T0)
  let now = T0
  for (let i = 0; i < 20; i += 1) {
    now += 30 * 60 * 1000
    state = applyDecay(state, now).state
    state = applyPet(state, now).state
  }
  // 20 轮：最容易出现的量级是每轮净 -3~-4，即 100 附近降到 20~40。
  assert.ok(state.value >= MOOD_MIN, `不应低于下限，实际 ${String(state.value)}`)
  assert.ok(
    state.value <= MOOD_MAX,
    `不应超过上限，实际 ${String(state.value)}`,
  )
  assert.ok(
    state.value < MOOD_INITIAL,
    `长期应当下滑（每 30 分钟衰减 10、点击期望只加 6.5），实际 ${String(state.value)}`,
  )
  // 20 轮最多也就掉这么多；掉光了说明衰减或夹取算错了。
  assert.ok(state.value > 0, `20 轮内不该掉到 0，实际 ${String(state.value)}`)
})

console.log(`\n结果：${String(passed)}/${String(passed + failed)} 通过`)
if (failed > 0) process.exit(1)
