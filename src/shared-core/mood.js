/**
 * 心情值 —— 单一真相源与纯函数。
 *
 * 设计要点：
 *  1. **按时间戳结算，而不是靠定时器累加**。定时器在系统休眠、进程被挂起、
 *     桌宠重启之后都会失准；而"上次结算时间"是持久化的，所以每次读写时
 *     按真实流逝时间补算即可，重启也不会丢失结算。
 *  2. 周期结算**分段进行**：跨过 n 个周期就结算 n 次，一次算清。
 *  3. 所有函数都是纯函数（输入状态 + 时间 → 输出状态），便于确定性测试。
 */

/** 心情上限（也是初始值）。 */
export const MOOD_MAX = 100

/** 心情下限。 */
export const MOOD_MIN = 0

/** 初始心情：满值。 */
export const MOOD_INITIAL = MOOD_MAX

/**
 * 心情的**周期随机漂移**间隔：每 10 分钟结算一次。
 *
 * 演变过程：原为"每 3 分钟 −1"（固定衰减）→ 改为"每 5 分钟随机 −40 ~ +50"
 * → 再把间隔拉长为 **10 分钟**（用户指定）。
 *
 * ⚠️ 这个常量名保留 `DECAY` 是历史原因（原来确实是单调衰减），现在它是"随机漂移"，
 * 语义已不再是"只降不升"。改名会牵动主进程、渲染进程与多处测试，
 * 收益不抵风险，所以留着名字 + 这行说明。
 */
export const MOOD_DRIFT_INTERVAL_MS = 10 * 60 * 1000

/** 兼容旧名。新代码请用 MOOD_DRIFT_INTERVAL_MS。 */
export const MOOD_DECAY_INTERVAL_MS = MOOD_DRIFT_INTERVAL_MS

/**
 * 每个周期心情随机变化多少（用户指定 **−40 ~ +50**）。
 *
 * 注意**下界是负数**：心情既可能掉也可能涨，不再是单调衰减。
 * 区间不对称（正的多 10 点），长期看**平均每次 +5 点**，
 * 也就是心情会缓慢回升到上限附近。
 */
export const MOOD_DRIFT_MIN = -40
export const MOOD_DRIFT_MAX = 50

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
 * 按流逝时间结算**周期随机漂移**：每满一个 `MOOD_DRIFT_INTERVAL_MS`，
 * 心情随机变化 `MOOD_DRIFT_MIN ~ MOOD_DRIFT_MAX`（−40 ~ +50）点。
 *
 * 与旧实现（每周期固定 −1）的区别：
 *  · 变化量是**随机的**，且**可正可负**，所以心情不再是单调衰减；
 *  · 周期从 3 分钟改为 5 分钟，再改为 **10 分钟**。
 *
 * 跨过 n 个周期就结算 n 次（每次独立随机），一次算清 ——
 * 这样"桌宠被挂起很久后回来"不会只按一次算，也就不会因为一次随机值
 * 恰好是大正数而凭空跳到上限。
 *
 * @param {MoodState} state
 * @param {number} now
 * @param {() => number} [rand] 注入随机源，便于确定性测试
 * @returns {{ state: MoodState, delta: number, steps: number }}
 *          delta = 本次净变化（已含夹取，可能小于名义值）；steps = 结算了几个周期
 */
export function applyDrift(state, now = Date.now(), rand = Math.random) {
  const current = normalizeMood(state, now)
  const elapsed = now - current.updatedAt
  if (elapsed < MOOD_DRIFT_INTERVAL_MS) return { state: current, delta: 0, steps: 0 }

  const steps = Math.floor(elapsed / MOOD_DRIFT_INTERVAL_MS)
  let value = current.value
  for (let i = 0; i < steps; i += 1) {
    value = clampMood(value + pickGainInRange(MOOD_DRIFT_MIN, MOOD_DRIFT_MAX, rand))
  }
  const delta = value - current.value
  // 只把"已结算的整周期"推进到 updatedAt，余下的零头留到下次，避免时间被抹平。
  const nextUpdatedAt = current.updatedAt + steps * MOOD_DRIFT_INTERVAL_MS
  return { state: { value, updatedAt: nextUpdatedAt }, delta, steps }
}

/**
 * 兼容旧用法：语义上等价于"结算到期的心情变化"，但现在**可正可负**。
 *
 * 保留这个名字是因为主进程与多处测试都在用；`decayed` 字段名同理
 * （它现在表示"本次变化量"，掉下去时为正、涨上去时为负，与旧行为一致）。
 *
 * @deprecated 新代码请用 `applyDrift()`。
 */
export function applyDecay(state, now = Date.now(), rand = Math.random) {
  const { state: next, delta, steps } = applyDrift(state, now, rand)
  return { state: next, decayed: -delta, steps }
}

/**
 * 互动（点击）一次：加心情。**先结算到期的周期漂移**，再加。
 *
 * 先结算漂移是必要的：否则"挂起两小时后再点一下"会只加点击那点，
 * 而这两个小时里本该发生的周期变化要等到下次定时器 tick 才补算，
 * 面板上会看到数字先跳一下。
 *
 * @param {MoodState} state
 * @param {number} now
 * @param {number} [gain] 缺省时从 MOOD_GAIN_PER_PET_MIN~MAX 里随机取
 * @param {() => number} [rand] 注入随机源（仅当未显式给 gain 时用）
 * @returns {{ state: MoodState, gained: number }} gained = 实际增量（含夹取）
 */
export function applyPet(state, now = Date.now(), gain = null, rand = Math.random) {
  const { state: settled } = applyDrift(state, now, rand)
  const useGain = Number.isFinite(gain) ? gain : pickPetGain(rand)
  const nextValue = clampMood(settled.value + useGain)
  return {
    state: { value: nextValue, updatedAt: settled.updatedAt },
    gained: nextValue - settled.value,
  }
}

/**
 * 闲置随机动作触发时回复心情。同样**先结算到期的周期漂移**，再加。
 *
 * @param {MoodState} state
 * @param {number} now
 * @param {number} [gain] 缺省时从 MOOD_GAIN_PER_ACTION_MIN~MAX 里随机取
 * @param {() => number} [rand]
 * @returns {{ state: MoodState, gained: number }}
 */
export function applyActionReward(state, now = Date.now(), gain = null, rand = Math.random) {
  const { state: settled } = applyDrift(state, now, rand)
  const useGain = Number.isFinite(gain) ? gain : pickActionGain(rand)
  const nextValue = clampMood(settled.value + useGain)
  return {
    state: { value: nextValue, updatedAt: settled.updatedAt },
    gained: nextValue - settled.value,
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
