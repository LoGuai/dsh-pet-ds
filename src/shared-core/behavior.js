/**
 * 行为决策器（Behavior Engine）—— 全项目**唯一**的动画仲裁者。
 *
 * 为什么需要它：DSH 的工作状态事件、余额变化、鼠标点击、闲置计时、心情变化
 * 会在同一瞬间产生多个"想播某段动画"的诉求。如果每个来源各自指挥动画引擎，
 * 就会出现互相覆盖、闪烁、动画被打断到一半等问题。
 *
 * 本模块把这类冲突收敛成一个纯函数：所有来源先提交 Intent，
 * `tick()` 每次只吐出**一个** Decision，动画引擎永远只播这一个。
 *
 * 纯逻辑：不碰时间（now 由调用方注入）、不碰随机（rng 可注入），因此可做确定性单测。
 */

import { PRIORITY } from './intent.js'

/**
 * @typedef {object} Decision
 * @property {string} kind       要播放的动作/场景。
 * @property {number} [facing]   朝向，-1 朝左 / 1 朝右。
 * @property {string} [line]     要说的台词。
 * @property {number} [bubbleMs] 气泡停留时长。
 * @property {string} reason     为什么做出这个决定（调试用）。
 */

/**
 * @typedef {object} BehaviorEngineOptions
 * @property {() => number} [now]   注入时钟，默认 Date.now。
 * @property {() => number} [rng]   注入随机源，返回 [0,1)，默认 Math.random。
 * @property {number} [queueLimit]  待播队列上限，默认 8。
 * @property {number} [minHoldMs]   一个动作的最小展示时长，默认 600ms，
 *                                  用于抑制事件抖动导致的档位频闪（风险 R18）。
 */

/** 提交进决策器的意图条目。 */
class Entry {
  /** @param {import('./intent.js').Intent} intent @param {number} at */
  constructor(intent, at) {
    this.intent = intent
    this.submittedAt = at
  }

  /** 是否已过期。ttlMs 为 0 视为永不过期。 */
  expired(now) {
    const { ttlMs } = this.intent
    return ttlMs > 0 && now - this.submittedAt > ttlMs
  }
}

export class BehaviorEngine {
  /** @param {BehaviorEngineOptions} [options] */
  constructor(options = {}) {
    this._now = options.now ?? (() => Date.now())
    this._rng = options.rng ?? (() => Math.random())
    this._queueLimit = options.queueLimit ?? 8
    this._minHoldMs = options.minHoldMs ?? 600

    /** 待处理意图：@type {Entry[]} */
    this._pending = []
    /** 当前正在执行的动作：@type {{ intent: import('./intent.js').Intent, startedAt: number } | null} */
    this._current = null
    /** 冷却表：cooldownKey -> 冷却到期时间戳 @type {Map<string, number>} */
    this._cooldowns = new Map()
    /** 最近一次吐出的 decision，用于避免同帧重复输出 */
    this._lastEmitted = null
  }

  /**
   * 提交一个意图。可能被立即处理，也可能进入队列或被丢弃。
   * @param {import('./intent.js').Intent} intent
   * @returns {{ accepted: boolean, reason: string }}
   */
  submit(intent) {
    const now = this._now()

    // 冷却中：直接丢弃，避免同一段表演被连续触发（台词/动画都不连播同一段）。
    const cooldownMs = intent.cooldownMs ?? 0
    if (cooldownMs > 0) {
      const until = this._cooldowns.get(intent.cooldownKey) ?? 0
      if (now < until) return { accepted: false, reason: 'cooldown' }
    }

    // 队列去重：同一个 cooldownKey 已经在等待时，用新的替换旧的（保留最新诉求）。
    const dupIndex = this._pending.findIndex((e) => e.intent.cooldownKey === intent.cooldownKey)
    if (dupIndex >= 0) {
      this._pending[dupIndex] = new Entry(intent, now)
      return { accepted: true, reason: 'replaced-pending' }
    }

    if (this._pending.length >= this._queueLimit) {
      // 队列满了：丢弃优先级最低、且优先级低于新意图的那一个；否则直接拒绝。
      let worstIndex = -1
      let worstScore = Number.POSITIVE_INFINITY
      for (let i = 0; i < this._pending.length; i += 1) {
        const p = PRIORITY[this._pending[i].intent.priority]
        if (p < worstScore) {
          worstScore = p
          worstIndex = i
        }
      }
      if (worstIndex >= 0 && worstScore < PRIORITY[intent.priority]) {
        this._pending.splice(worstIndex, 1)
      } else {
        return { accepted: false, reason: 'queue-full' }
      }
    }

    this._pending.push(new Entry(intent, now))
    return { accepted: true, reason: 'queued' }
  }

  /**
   * 推进一步：清理过期项、必要时抢占/切换，返回本步要执行的决定。
   * @returns {Decision | null} null 表示"维持现状"，调用方不要改变当前表演。
   */
  tick() {
    const now = this._now()

    // 1) 清理过期意图。
    this._pending = this._pending.filter((e) => !e.expired(now))

    // 2) 当前动作是否还在"最小展示期"内 —— 抑制频闪。
    if (this._current && now - this._current.startedAt < this._minHoldMs) {
      return null
    }

    // 3) 选出本轮最佳候选。
    let best = null
    let bestScore = -1
    for (const entry of this._pending) {
      const score = this._score(entry.intent)
      if (score > bestScore) {
        bestScore = score
        best = entry
      }
    }
    if (!best) {
      // 没有待处理意图：保持当前动作（例如 idle 一直循环），不打扰调用方。
      return null
    }

    const candidate = best.intent

    // 4) 抢占判定：当前动作不可打断，且候选优先级不高于当前 —— 排队等待。
    if (this._current) {
      const currentPriority = PRIORITY[this._current.intent.priority]
      const candidatePriority = PRIORITY[candidate.priority]
      if (!this._current.intent.interruptible && candidatePriority <= currentPriority) {
        return null
      }
    }

    // 5) 采纳：出队、记录冷却与当前动作。
    this._pending = this._pending.filter((e) => e !== best)
    const cooldownMs = candidate.cooldownMs ?? 0
    if (cooldownMs > 0) this._cooldowns.set(candidate.cooldownKey, now + cooldownMs)
    this._current = { intent: candidate, startedAt: now }

    /** @type {Decision} */
    const decision = {
      kind: candidate.kind,
      reason: `${candidate.source}:${candidate.priority}`,
    }
    if (candidate.facing !== undefined) decision.facing = candidate.facing
    if (candidate.line !== undefined) decision.line = candidate.line
    if (candidate.bubbleMs !== undefined) decision.bubbleMs = candidate.bubbleMs

    this._lastEmitted = decision
    return decision
  }

  /**
   * 通知决策器"当前动作已播完"，允许立刻切换到无最小展示期限制的下一个动作。
   * 环境行为（idle 等循环动作）不应调用它。
   */
  finishCurrent() {
    if (this._current) this._current = null
  }

  /** 当前动作标识，供调试与状态上报。 */
  get currentKind() {
    return this._current ? this._current.intent.kind : null
  }

  /** 待处理意图数量，供调试。 */
  get pendingCount() {
    return this._pending.length
  }

  /** 清空全部状态（用于断开连接后复位）。 */
  reset() {
    this._pending = []
    this._current = null
    this._cooldowns.clear()
    this._lastEmitted = null
  }

  /**
   * 打分：优先级为主，权重为次（权重可由心情调制）。
   * @param {import('./intent.js').Intent} intent
   */
  _score(intent) {
    const priority = PRIORITY[intent.priority]
    // 权重只影响同优先级内部的竞争，强制落在 [0,1) 内，绝不越级。
    const tieBreak = Math.min(Math.max(intent.weight, 0), 1)
    return priority + tieBreak * 0.999
  }
}
