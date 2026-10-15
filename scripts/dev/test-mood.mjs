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
  MOOD_DRIFT_INTERVAL_MS,
  MOOD_DRIFT_MIN,
  MOOD_DRIFT_MAX,
  MOOD_GAIN_PER_PET_MIN,
  MOOD_GAIN_PER_PET_MAX,
  MOOD_GAIN_PER_ACTION_MIN,
  MOOD_GAIN_PER_ACTION_MAX,
  MOOD_INITIAL,
  MOOD_MAX,
  MOOD_MIN,
  applyActionReward,
  applyDecay,
  applyDrift,
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
const MIN = MOOD_DRIFT_INTERVAL_MS

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

/*
 * 周期漂移（用户指定：每 5 分钟随机变化 −40 ~ +50）。
 *
 * ⚠️ 下面这些用例一律**注入确定的随机源**（第三个参数）。
 * 漂移量是随机的，不注入就没法断言具体数值 —— 而"跨几个周期、
 * 余数怎么留"这些算术必须能确定性验证。
 * 区间本身的边界由后面专门的一组用例覆盖。
 */
test('不足一个周期不结算', () => {
  const { state, delta, steps } = applyDrift(initialMood(T0), T0 + MIN - 1, () => 0)
  assert.equal(steps, 0)
  assert.equal(delta, 0)
  assert.equal(state.value, 100)
})

test('恰好一个周期结算一次（rand=0 → 取下界 −40）', () => {
  const { state, delta, steps } = applyDrift(initialMood(T0), T0 + MIN, () => 0)
  assert.equal(steps, 1)
  assert.equal(delta, MOOD_DRIFT_MIN)
  assert.equal(state.value, 100 + MOOD_DRIFT_MIN) // 60
})

test('跨多个周期就结算多次（每次独立取随机值）', () => {
  // rand 固定 0 → 每次都取 −40；7 个周期 → −280，但会被夹到 0。
  const { steps } = applyDrift(initialMood(T0), T0 + MIN * 7, () => 0)
  assert.equal(steps, 7)
  // 换个不会撞到下限的组合：起点 100、每周期 +50 → 夹在 100。
  const up = applyDrift({ value: 0, updatedAt: T0 }, T0 + MIN * 2, () => 0.999999)
  assert.equal(up.steps, 2)
  assert.equal(up.state.value, 100, '两次 +50 应当到上限 100')
})

test('余数留到下次，不被抹平', () => {
  // 走 2.5 个周期：只结算 2 次，updatedAt 停在 2 个周期处。
  const { state, steps } = applyDrift(initialMood(T0), T0 + Math.floor(MIN * 2.5), () => 0)
  assert.equal(steps, 2)
  assert.equal(state.updatedAt, T0 + MIN * 2)
  // 再走 0.5 个周期就正好凑满第 3 次。
  const second = applyDrift(state, T0 + MIN * 3, () => 0)
  assert.equal(second.steps, 1)
})

test('长时间离线会补算每一个跨过的周期（模拟被挂起）', () => {
  // 离线 1 小时 = 12 个周期，全部按 −40 算 → 夹到 0。
  const { state, steps } = applyDrift(initialMood(T0), T0 + 60 * 60 * 1000, () => 0)
  assert.equal(steps, 12, '1 小时应当结算 12 个 5 分钟周期')
  assert.equal(state.value, MOOD_MIN)
})

test('漂移不会越过下限 0', () => {
  const { state } = applyDrift(initialMood(T0), T0 + MIN * 500, () => 0)
  assert.equal(state.value, MOOD_MIN)
})

test('漂移不会越过上限 100', () => {
  const { state } = applyDrift({ value: 95, updatedAt: T0 }, T0 + MIN, () => 0.999999)
  assert.equal(state.value, MOOD_MAX, '95 + 50 应当夹到 100')
})

test('结算到 0 之后继续过时间：可能被抬起来，也可能仍为 0', () => {
  // 取下界 −40：一直是 0。
  assert.equal(applyDrift({ value: 0, updatedAt: T0 }, T0 + MIN * 10, () => 0).state.value, 0)
  // 取上界 +50：从 0 涨到 50（这正是"不再是单调衰减"的体现）。
  assert.equal(applyDrift({ value: 0, updatedAt: T0 }, T0 + MIN, () => 0.999999).state.value, 50)
})

test('漂移区间是 −40 ~ +50，且含两端', () => {
  assert.equal(MOOD_DRIFT_MIN, -40)
  assert.equal(MOOD_DRIFT_MAX, 50)
  assert.equal(pickGainInRange(MOOD_DRIFT_MIN, MOOD_DRIFT_MAX, () => 0), -40)
  assert.equal(pickGainInRange(MOOD_DRIFT_MIN, MOOD_DRIFT_MAX, () => 0.999999), 50)
  for (let i = 0; i < 2000; i += 1) {
    const v = pickGainInRange(MOOD_DRIFT_MIN, MOOD_DRIFT_MAX)
    assert.ok(Number.isInteger(v) && v >= -40 && v <= 50, `越界 ${String(v)}`)
  }
})

test('漂移周期是 5 分钟', () => {
  assert.equal(MOOD_DRIFT_INTERVAL_MS, 5 * 60 * 1000)
  // 旧名保留为别名，避免外部引用找不到。
  assert.equal(MOOD_DECAY_INTERVAL_MS, MOOD_DRIFT_INTERVAL_MS)
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

test('互动前会先结算到期的漂移', () => {
  /*
   * 过了 4 个周期（rand=0 → 每次 −40）：100 −160 → 夹到 0，再加 10 → 10。
   *
   * 这条同时验证了"先结算漂移、再加点击值"这个顺序 ——
   * 若顺序反了（先加后结算），结果会是 100 + 10 = 100 → 再 −160 → 0。
   */
  const { state } = applyPet(initialMood(T0), T0 + MIN * 4, 10, () => 0)
  assert.equal(state.value, 10, '先被漂移压到 0，再加 10')
})

test('互动在中间心情时同样先算漂移', () => {
  // rand=0.5 → 每次 +5；过 3 个周期 = +15，再加 10 → 55。
  const { state } = applyPet({ value: 30, updatedAt: T0 }, T0 + MIN * 3, 10, () => 0.5)
  assert.equal(state.value, 55)
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

test('applyActionReward 同样先结算漂移，且不超上限', () => {
  // rand=0.999999 → 每次 +50；过 4 个周期 → 夹在 100，再加 10~30 仍是 100。
  const { state } = applyActionReward(initialMood(T0), T0 + MIN * 4, null, () => 0.999999)
  assert.equal(state.value, MOOD_MAX)
  // 显式 gain 时按"漂移后 + gain"精确相加：rand=0.5 → 每周期 +5。
  const mid = applyActionReward({ value: 30, updatedAt: T0 }, T0 + MIN * 3, 20, () => 0.5)
  assert.equal(mid.state.value, 65) // 30 + 15 + 20
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

test('周期性综合场景：漂移取中位时心情回升到上限', () => {
  /*
   * 模拟：每 30 分钟结算一次（= 6 个 5 分钟周期），每 30 分钟点一次固定 +10。
   * rand=0.5 → 每次漂移 +5，6 次 = +30；点击 +10 → 每 30 分钟净 +40 → 很快封顶。
   *
   * 这条说明**新机制下心情长期是回升的**（区间正的多 10 点，平均每次 +5），
   * 与旧的"每 3 分钟 −1 单调衰减"完全相反。
   */
  let state = initialMood(T0)
  let now = T0
  const mid = () => 0.5
  for (let i = 0; i < 10; i += 1) {
    now += 30 * 60 * 1000
    state = applyDrift(state, now, mid).state
    state = applyPet(state, now, 10, mid).state
  }
  assert.equal(state.value, MOOD_MAX, '每 30 分钟净 +40，10 轮后应当封顶')
})

test('周期性综合场景：漂移取最负值时心情被压到下限', () => {
  // 只结算、不点击，rand=0 → 每次 −40，心情一路掉到 0 并停住。
  let state = initialMood(T0)
  let now = T0
  for (let i = 0; i < 10; i += 1) {
    now += 30 * 60 * 1000
    state = applyDrift(state, now, () => 0).state
  }
  assert.equal(state.value, MOOD_MIN)
})

test('周期性综合场景（真实随机源）：始终落在 [0,100] 且不崩', () => {
  /*
   * 用真实 Math.random 跑长程，断言的是**不变式**而不是具体数值
   * （随机序列不可复现，断言精确值只会变成偶发失败）：
   *  · 心情始终在 [0, 100]；
   *  · 漂移确实有升有降（不是单调）。
   */
  let state = initialMood(T0)
  let now = T0
  let sawUp = false
  let sawDown = false
  for (let i = 0; i < 500; i += 1) {
    now += 5 * 60 * 1000
    const before = state.value
    const r = applyDrift(state, now)
    state = r.state
    if (state.value > before) sawUp = true
    if (state.value < before) sawDown = true
    assert.ok(state.value >= MOOD_MIN && state.value <= MOOD_MAX, `越界 ${String(state.value)}`)
  }
  assert.ok(sawUp && sawDown, `漂移应当有升有降，实际 up=${String(sawUp)} down=${String(sawDown)}`)
})

console.log(`\n结果：${String(passed)}/${String(passed + failed)} 通过`)
if (failed > 0) process.exit(1)
