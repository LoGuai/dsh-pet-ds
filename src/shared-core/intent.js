/**
 * 桌宠意图（Intent）定义 —— 决策器的输入语言。
 *
 * 设计要点：
 *  - 所有外部输入（DSH 事件、余额变化、鼠标交互、心情、闲置计时）一律先翻译成 Intent，
 *    不允许任何模块绕过决策器直接指挥动画。这是"避免多个事件同时触发动画冲突"的结构性保证。
 *  - 本文件是**纯逻辑**：不碰 fs / net / DOM / Electron，可被宿主侧与桌宠侧同时引用，
 *    也可在 Node 里直接单测。
 *  - 用 JSDoc 提供类型，源码即运行代码（Node 24 默认不做类型剥离，故不引入 TS 构建步骤）。
 */

/**
 * @typedef {'ambient' | 'action' | 'event' | 'urgent'} IntentPriority
 *
 * 优先级语义（数值越大越优先）：
 *  - ambient  0  环境行为：闲置呼吸、随机小动作、漫游。随时可被打断。
 *  - action   1  用户交互：点击、摸头、戳脸。可被事件打断，但会打断环境行为。
 *  - event    2  工作状态：思考 / 工作 / 整理 / 等待 / 成功 / 失败。可打断交互与环境。
 *  - urgent   3  必须立刻表达：余额告急、被吓一跳、宿主离线告警。只有它能打断同类。
 */

/** 优先级数值表。数值必须与上面的语义一致。 */
export const PRIORITY = Object.freeze({
  ambient: 0,
  action: 1,
  event: 2,
  urgent: 3,
})

/**
 * @typedef {object} Intent
 * @property {string}  kind        动作/场景标识，例如 'idle'、'click'、'work-thinking'。
 * @property {IntentPriority} priority
 * @property {number}  ttlMs       存活时长；超时后该意图失效（0 表示永不过期）。
 * @property {boolean} interruptible 为 true 时，更高优先级可以中途抢占它。
 * @property {string}  cooldownKey 冷却键；相同键在冷却期内不再重复触发。
 * @property {number}  [cooldownMs] 冷却时长，默认取 kind 的默认值。
 * @property {number}  [weight]    同优先级竞争时的权重（可由心情调制），默认 1。
 * @property {string}  [line]      附带台词（可选）。
 * @property {number}  [bubbleMs]  台词气泡停留时长（可选）。
 * @property {number}  [facing]    -1 朝左 / 1 朝右；可选，缺省沿用当前朝向。
 * @property {string}  source      来源标记，便于调试与日志（'dsh' | 'balance' | 'mouse' | 'mood' | 'idle'）。
 */

/**
 * 构造一个 Intent，补齐默认值并做基本校验。
 * 让调用方少写样板，同时保证决策器拿到的结构一致。
 * @param {Partial<Intent> & { kind: string, source: string }} input
 * @returns {Intent}
 */
export function makeIntent(input) {
  if (!input || typeof input.kind !== 'string' || input.kind.length === 0) {
    throw new TypeError('makeIntent: kind is required')
  }
  const priority = input.priority ?? 'ambient'
  if (!(priority in PRIORITY)) {
    throw new TypeError(`makeIntent: unknown priority "${String(priority)}"`)
  }
  return {
    kind: input.kind,
    priority,
    ttlMs: Number.isFinite(input.ttlMs) ? Number(input.ttlMs) : 0,
    interruptible: input.interruptible !== false,
    cooldownKey: input.cooldownKey ?? input.kind,
    cooldownMs: Number.isFinite(input.cooldownMs) ? Number(input.cooldownMs) : 0,
    weight: Number.isFinite(input.weight) && Number(input.weight) > 0 ? Number(input.weight) : 1,
    line: typeof input.line === 'string' && input.line.length > 0 ? input.line : undefined,
    bubbleMs: Number.isFinite(input.bubbleMs) ? Number(input.bubbleMs) : undefined,
    facing: input.facing === -1 || input.facing === 1 ? input.facing : undefined,
    source: String(input.source),
  }
}
