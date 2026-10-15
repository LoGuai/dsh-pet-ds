/**
 * 心情值 —— 单一真相源与纯函数。
 *
 * 设计要点：
 *  1. **按时间戳结算，而不是靠定时器累加**。定时器在系统休眠、进程被挂起、
 *     桌宠重启之后都会失准；而"上次结算时间"是持久化的，所以每次读写时
 *     按真实流逝时间补算即可，重启也不会丢失衰减。
 *  2. 衰减**分段结算**：跨过 n 个衰减周期就减 n 点，一次算清，不逐周期循环。
 *  3. 所有函数都是纯函数（输入状态 + 时间 → 输出状态），便于确定性测试。
 */

/** 心情上限（也是初始值）。 */
export const MOOD_MAX = 100

/** 心情下限。 */
export const MOOD_MIN = 0

/** 初始心情：满值。 */
export const MOOD_INITIAL = MOOD_MAX

/** 每经过这么长时间掉 1 点。 */
export const MOOD_DECAY_INTERVAL_MS = 3 * 60 * 1000

/**
 * 点击桌宠一次加多少心情 —— **随机区间**（用户指定 3~10）。
 *
 * 为什么是区间而不是定值：定值点几下就没新鲜感了，区间让每次互动有轻微变化。
 * 实际取值由 `pickPetGain()` 抽，`applyPet()` 也接受显式 gain（便于测试确定化）。
 */
export const MOOD_GAIN_PER_PET_MIN = 3
export const MOOD_GAIN_PER_PET_MAX = 10

/**
 * 触发一次**闲置随机动作**回复多少心情 —— 随机区间（用户指定 10~30）。
 *
 * 比点击给得多，因为它是"桌宠自己做了件事"，而闲置随机动作很稀少
 * （3 分钟门槛 + 每分钟 1/5 概率，期望约 5 分钟一次）。
 */
export const MOOD_GAIN_PER_ACTION_MIN = 10
export const MOOD_GAIN_PER_ACTION_MAX = 30

/**
 * 从区间里随机取一个整数（含两端）。
 * @param {number} min
 * @param {number} max
 * @param {() => number} [rand] 注入随机源，便于测试确定化
 */
export function pickGainInRange(min, max, rand = Math.random) {
  const lo = Math.min(min, max)
  const hi = Math.max(min, max)
  return lo + Math.floor(rand() * (hi - lo + 1))
}

/** 抽一次"点击加心情"的值（3~10）。 */
export function pickPetGain(rand = Math.random) {
  return pickGainInRange(MOOD_GAIN_PER_PET_MIN, MOOD_GAIN_PER_PET_MAX, rand)
}

/** 抽一次"闲置随机动作加心情"的值（10~30）。 */
export function pickActionGain(rand = Math.random) {
  return pickGainInRange(MOOD_GAIN_PER_ACTION_MIN, MOOD_GAIN_PER_ACTION_MAX, rand)
}

/**
 * @typedef {object} MoodState
 * @property {number} value 当前心情值
 * @property {number} updatedAt 上次结算的时间戳（毫秒）
 */

/** 取初始状态。 */
export function initialMood(now = Date.now()) {
  return { value: MOOD_INITIAL, updatedAt: now }
}

/** 把任意输入规整成合法的状态（用于读持久化数据时的容错）。 */
export function normalizeMood(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return initialMood(now)
  const value = Number(raw.value)
  const updatedAt = Number(raw.updatedAt)
  return {
    value: Number.isFinite(value) ? clampMood(value) : MOOD_INITIAL,
    updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : now,
  }
}

/** 把心情夹进 [0, 100]。 */
export function clampMood(value) {
  if (!Number.isFinite(value)) return MOOD_INITIAL
  return Math.min(MOOD_MAX, Math.max(MOOD_MIN, value))
}

/**
 * 按流逝时间结算衰减。
 *
 * @param {MoodState} state
 * @param {number} now
 * @returns {{ state: MoodState, decayed: number }} decayed = 本次掉了多少点
 */
export function applyDecay(state, now = Date.now()) {
  const current = normalizeMood(state, now)
  const elapsed = now - current.updatedAt
  if (elapsed < MOOD_DECAY_INTERVAL_MS) return { state: current, decayed: 0 }

  const steps = Math.floor(elapsed / MOOD_DECAY_INTERVAL_MS)
  const nextValue = clampMood(current.value - steps)
  const decayed = current.value - nextValue
  // 只把"已结算的整周期"推进到 updatedAt，余下的零头留到下次，避免时间被抹平。
  const nextUpdatedAt = current.updatedAt + steps * MOOD_DECAY_INTERVAL_MS
  return { state: { value: nextValue, updatedAt: nextUpdatedAt }, decayed }
}

/**
 * 互动（点击）一次：加心情。先结算衰减，再加。
 *
 * @param {MoodState} state
 * @param {number} now
 * @param {number} [gain] 缺省时从 MOOD_GAIN_PER_PET_MIN~MAX 里随机取
 * @param {() => number} [rand] 注入随机源（仅当未显式给 gain 时用）
 * @returns {{ state: MoodState, gained: number, decayed: number }}
 */
export function applyPet(state, now = Date.now(), gain = null, rand = Math.random) {
  const { state: settled, decayed } = applyDecay(state, now)
  const useGain = Number.isFinite(gain) ? gain : pickPetGain(rand)
  const nextValue = clampMood(settled.value + useGain)
  return {
    state: { value: nextValue, updatedAt: settled.updatedAt },
    gained: nextValue - settled.value,
    decayed,
  }
}

/**
 * 闲置随机动作触发时回复心情。先结算衰减，再加。
 *
 * @param {MoodState} state
 * @param {number} now
 * @param {number} [gain] 缺省时从 MOOD_GAIN_PER_ACTION_MIN~MAX 里随机取
 * @param {() => number} [rand]
 * @returns {{ state: MoodState, gained: number, decayed: number }}
 */
export function applyActionReward(state, now = Date.now(), gain = null, rand = Math.random) {
  const { state: settled, decayed } = applyDecay(state, now)
  const useGain = Number.isFinite(gain) ? gain : pickActionGain(rand)
  const nextValue = clampMood(settled.value + useGain)
  return {
    state: { value: nextValue, updatedAt: settled.updatedAt },
    gained: nextValue - settled.value,
    decayed,
  }
}

/**
 * 心情档位（供后续影响动作与台词用）。
 * 分档而非直接用数值，是为了让"什么心情播什么"这件事集中在这里定义。
 */
export function moodTier(value) {
  const v = clampMood(value)
  if (v >= 80) return 'happy'
  if (v >= 50) return 'normal'
  if (v >= 20) return 'low'
  return 'sad'
}

/** 档位 → 展示用短标签。 */
export const MOOD_TIER_LABELS = {
  happy: '心情很好',
  normal: '还不错',
  low: '有点低落',
  sad: '不开心',
}
