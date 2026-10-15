/**
 * 好感值 —— 等级（爱心数）与阶段阈值的**单一真相源**与纯函数。
 *
 * ## 规则（用户指定）
 *
 * **一开始是 0 颗心**；每攒满一段阶段好感值就晋一心：
 *
 * | 从 | 攒满 | 到 |
 * |---|---|---|
 * | 0 心 | 100 | 1 心 |
 * | 1 心 | 200 | 2 心 |
 * | 2 心 | 500 | 3 心 |
 * | 3 心 | 1000 | 4 心 |
 * | 4 心 | 3000 | 5 心（满级） |
 *
 * - **阶段好感值**是"当前这段里攒了多少"，从 0 开始；
 * - 攒满阈值后阶段值**归 0**、爱心数 +1（用户原话："超过上限后阶段好感值归0
 *   进入下一个等级（即爱心数加一）"）；
 * - **5 心为满级**：到顶后阶段值攒满 3000 就**不再变化**；
 * - 累计需要 `100+200+500+1000+3000 = 4800` 点才满级。
 *
 * ## 为什么状态存 `hearts` 而不是 `stage`
 *
 * 爱心数（0~5）是用户能直接看到的东西，也是规则的表述单位
 * （"爱心数加一"）。阶段阈值由它推导（`stageThresholdFor(hearts)`），
 * 不需要再单独存一个 stage 字段 —— 两个字段表示同一件事迟早会不同步。
 *
 * ## 关于"超过上限"
 *
 * 规则说"超过上限后归 0"。实现上是**逐点结算**：每加 1 点判一次，
 * 所以"超过上限"的那一刻就是"刚好攒满"的那一刻，不存在溢出量被丢掉的问题。
 * 逐点与"一次加一大笔"的结果完全等价（有单测钉住）。
 */

/**
 * 各阶段阈值：`AFFECTION_STAGE_THRESHOLDS[h]` = 从 `h` 颗心攒到 `h+1` 颗心
 * 所需的阶段好感值。
 *
 * 长度 = 5 = 晋心次数，所以爱心数的范围是 **0 ~ 5**（共 6 个状态）。
 */
export const AFFECTION_STAGE_THRESHOLDS = [100, 200, 500, 1000, 3000]

/** 爱心的最大数量（满级）。 */
export const AFFECTION_MAX_HEARTS = AFFECTION_STAGE_THRESHOLDS.length

/**
 * @typedef {object} AffectionState
 * @property {number} value 当前阶段的阶段好感值（0 ~ 当前阈值）
 * @property {number} hearts 爱心数（0 ~ AFFECTION_MAX_HEARTS）
 * @property {number} updatedAt 上次变化的时间戳（毫秒）
 */

/**
 * 取初始状态：**0 颗心、阶段 0**。
 *
 * @param {number} now
 * @returns {AffectionState}
 */
export function initialAffection(now = Date.now()) {
  return { value: 0, hearts: 0, updatedAt: now }
}

/** 把爱心数夹进 [0, AFFECTION_MAX_HEARTS]。 */
export function clampHearts(hearts) {
  if (!Number.isFinite(hearts)) return 0
  return Math.min(AFFECTION_MAX_HEARTS, Math.max(0, Math.floor(hearts)))
}

/**
 * 当前爱心数对应的**阶段阈值**（攒满就晋一心）。
 *
 * 已满级时返回最后一段的阈值（3000）—— 满级后阶段值就以它为上限。
 */
export function stageThresholdFor(hearts) {
  const h = clampHearts(hearts)
  // 满级时没有"下一段"，用最后一段的阈值作为封顶值。
  return AFFECTION_STAGE_THRESHOLDS[Math.min(h, AFFECTION_MAX_HEARTS - 1)]
}

/** 是否已满级（5 心）。 */
export function isMaxHearts(hearts) {
  return clampHearts(hearts) >= AFFECTION_MAX_HEARTS
}

/**
 * 把任意输入规整成合法的好感状态（读脏数据时容错）。
 *
 * @param {unknown} raw
 * @param {number} now
 * @returns {AffectionState}
 */
export function normalizeAffection(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return initialAffection(now)
  const hearts = clampHearts(Number(raw.hearts))
  const threshold = stageThresholdFor(hearts)
  const value = Number(raw.value)
  const updatedAt = Number(raw.updatedAt)
  return {
    value: Number.isFinite(value) ? Math.min(threshold, Math.max(0, Math.floor(value))) : 0,
    hearts,
    updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : now,
  }
}

/**
 * 给好感加值，并处理**晋心与满级封顶**。这是整个模块的核心。
 *
 * 行为：
 *  · 逐点结算（见下方说明）：每加 1 点，若阶段值攒满当前阈值则**归 0、爱心 +1**；
 *  · 已满 5 心时，阶段值夹在 3000（最后一段阈值）**不再变化**，爱心也不动；
 *  · 负数/0 被忽略（好感不会下降）。
 *
 * ⚠️ **为什么必须逐点结算**：晋心规则是"攒满 → 阶段值归 0"，
 * 这条规则本身不保留溢出量。若把 `gain` 一次性加到阶段值上再判晋心，
 * "阶段 90、阈值 100、加 150" 会变成"1 心、阶段 0"，那 140 点凭空消失 ——
 * 加得越多丢得越多。逐点走就没有这个问题，而且与"每攒满一点判一次"的直觉一致。
 *
 * 代价是一次加很多点时有循环开销；但好感增长是"每次事件加个位数"，
 * 即使以后有批量赠送（几千点）也就是几千次简单整数运算，可忽略。
 * 循环上界是 `add`，不存在死循环。
 *
 * @param {AffectionState} state
 * @param {number} gain 要加的点数
 * @param {number} now
 * @returns {{ state: AffectionState, gained: number, heartsGained: number, capped: boolean }}
 *          gained = 真正落进阶段值的点数；capped = 结果是否已满级
 */
export function applyAffectionGain(state, gain, now = Date.now()) {
  const current = normalizeAffection(state, now)
  const add = Number.isFinite(gain) && gain > 0 ? Math.floor(gain) : 0

  if (add === 0) {
    return { state: { ...current, updatedAt: now }, gained: 0, heartsGained: 0, capped: isMaxHearts(current.hearts) }
  }

  let hearts = current.hearts
  let value = current.value
  let heartsGained = 0
  let landed = 0

  for (let i = 0; i < add; i += 1) {
    // 已满级：阶段值累加到封顶值即止。
    if (isMaxHearts(hearts)) {
      const cap = stageThresholdFor(hearts)
      if (value >= cap) break
      value += 1
      landed += 1
      continue
    }
    value += 1
    landed += 1
    if (value >= stageThresholdFor(hearts)) {
      hearts += 1
      value = 0
      heartsGained += 1
    }
  }

  return {
    state: { value, hearts, updatedAt: now },
    gained: landed,
    heartsGained,
    capped: isMaxHearts(hearts),
  }
}

/** 阶段进度比例（0~1），供进度条用。 */
export function affectionProgress(state) {
  const s = normalizeAffection(state)
  const threshold = stageThresholdFor(s.hearts)
  if (!(threshold > 0)) return 1
  return Math.min(1, Math.max(0, s.value / threshold))
}

/**
 * 爱心显示串：实心 = 已达到，空心 = 还没到。长度恒为 5。
 *
 * 长度恒定很重要 —— 面板宽度因此不会随着心跳动，
 * 文字也不会因为爱心数变化而左右窜。
 *
 * @param {number} hearts 0~5
 */
export function heartsFor(hearts) {
  const h = clampHearts(hearts)
  return '♥'.repeat(h) + '♡'.repeat(AFFECTION_MAX_HEARTS - h)
}

/**
 * 爱心数对应的称呼。
 *
 * 6 个状态（0~5 心）对应 6 个称呼；索引即爱心数。
 */
export const AFFECTION_HEART_LABELS = ['陌生', '眼熟', '熟悉', '亲近', '信赖', '挚爱']

/** 取某个爱心数的称呼。 */
export function affectionHeartsLabel(hearts) {
  return AFFECTION_HEART_LABELS[clampHearts(hearts)]
}

/**
 * 下发给渲染进程的等级表。
 *
 * 渲染进程没有模块加载能力，阈值与称呼都得由主进程给 ——
 * 若两边各写一份，改了阈值就会出现"面板显示 0/100、实际按 200 晋心"这类错位。
 * 所以**只在这里定义一次**，主进程转发。
 *
 * @returns {{ hearts: number, threshold: number, label: string }[]}
 *          `hearts` = 该段开始时已有的爱心数，`threshold` = 攒满它需要的点数。
 */
export function affectionStagesPayload() {
  return AFFECTION_STAGE_THRESHOLDS.map((threshold, i) => ({
    hearts: i,
    threshold,
    label: AFFECTION_HEART_LABELS[i],
  }))
}
