/**
 * 好感值的**增长规则** —— 单一真相源。
 *
 * ## 用户指定的五条途径（原文）
 *
 * 1. 闲置状态下随机触发对话时增加 **1** 好感值；
 * 2. 点击桌宠互动时增加**随机 2~8** 好感值，**每 5 分钟只能触发一次**；
 * 3. 桌宠触发随机动作时，增加 **2** 好感值；
 * 4. 桌宠每**连续运行 10 分钟**，增加 **5** 好感值；
 * 5. 心情值 **< 50** 时点击桌宠，增加 **10** 好感值。
 *
 * ## 两个需要解释的取舍
 *
 * ### 第 5 条与第 2 条共用同一个 5 分钟冷却
 *
 * 字面上只有第 2 条写了"每 5 分钟只能触发一次"。但第 2、5 条都挂在
 * **同一个动作**（点击）上：若第 5 条不受冷却约束，低心情时连点就能每次 +10，
 * 一分钟刷出上百点 —— 显然不是设计意图。所以两条一起受冷却约束。
 *
 * ### 第 4 条按"进程存活时间"算，而不是"闲置时间"
 *
 * "连续运行"指的是桌宠一直在跑（用户开着它），与用户是否在跟它互动无关。
 * 所以它由主进程的定时器结算，**不受**宿主忙闲与睡眠影响。
 *
 * 第 1 条与第 3 条为什么分开记：对话 +1、动作 +2 是两种不同的"陪伴"，
 * 数值不同正是用户指定的差异；而它们由**不同的事件**触发（说话 vs 做事），
 * 所以必须各自在自己的调用点入账，不能合并成一个"闲置事件 +3"。
 */

/** 低心情的阈值（点击时触发第 5 条、并改为 +50 心情）。 */
export const LOW_MOOD_THRESHOLD = 50

/** 低心情时点击，心情**立即**加多少（用户指定）。 */
export const LOW_MOOD_CLICK_MOOD_GAIN = 50

/** 好感度增长规则的数值表。改这里就等于改规则，别在各调用点写死。 */
export const AFFECTION_GAIN = Object.freeze({
  /** 1) 闲置主动对话 +1 */
  idleDialogue: 1,
  /** 2) 点击互动：随机 2~8 */
  clickMin: 2,
  clickMax: 8,
  /** 2) 点击互动的冷却：5 分钟 */
  clickCooldownMs: 5 * 60 * 1000,
  /** 3) 随机动作 +2 */
  randomAction: 2,
  /** 4) 每连续运行 10 分钟 +5 */
  uptimeEveryMs: 10 * 60 * 1000,
  uptimeGain: 5,
  /** 5) 低心情时点击 +10 */
  lowMoodClick: 10,
})

/**
 * 抽一次"点击互动"的好感增量（2~8，含两端）。
 *
 * @param {() => number} [rand] 注入随机源，便于测试确定化
 * @returns {number}
 */
export function pickClickAffectionGain(rand = Math.random) {
  const { clickMin, clickMax } = AFFECTION_GAIN
  const lo = Math.min(clickMin, clickMax)
  const hi = Math.max(clickMin, clickMax)
  return lo + Math.floor(rand() * (hi - lo + 1))
}

/**
 * 点击互动的好感冷却是否已过。
 *
 * @param {number | null} lastAtMs 上次因点击获得好感的时刻（null = 从未）
 * @param {number} now
 * @returns {{ ready: boolean, waitMs: number }}
 */
export function clickAffectionReady(lastAtMs, now) {
  if (!Number.isFinite(lastAtMs)) return { ready: true, waitMs: 0 }
  const elapsed = now - lastAtMs
  const waitMs = AFFECTION_GAIN.clickCooldownMs - elapsed
  return waitMs <= 0 ? { ready: true, waitMs: 0 } : { ready: false, waitMs }
}

/**
 * 一次点击应得的好感增量（把第 2 条与第 5 条合起来算）。
 *
 * @param {object} opts
 * @param {number | null} opts.lastAtMs 上次点击入账的时刻
 * @param {number} opts.now
 * @param {number} opts.moodValue 当前心情值
 * @param {() => number} [opts.rand]
 * @returns {{ gain: number, base: number, bonus: number, lowMood: boolean, coolingDown: boolean }}
 *          `gain` 为 0 且 `coolingDown` 为真时表示这次点击在冷却中
 */
export function clickAffectionGain(opts) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now()
  const { ready } = clickAffectionReady(opts.lastAtMs, now)
  const lowMood = Number.isFinite(opts.moodValue) && opts.moodValue < LOW_MOOD_THRESHOLD
  if (!ready) {
    // 冷却中：既不给基础值，也不给低心情奖励 —— 见文件头"共用冷却"。
    return { gain: 0, base: 0, bonus: 0, lowMood, coolingDown: true }
  }
  const base = pickClickAffectionGain(opts.rand)
  const bonus = lowMood ? AFFECTION_GAIN.lowMoodClick : 0
  return { gain: base + bonus, base, bonus, lowMood, coolingDown: false }
}
