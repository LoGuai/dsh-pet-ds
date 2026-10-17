/**
 * 余额变动播报 —— 纯逻辑，宿主与单测共用。
 *
 * ## 为什么单独放一个模块
 *
 * "这次花了多少、剩余多少、该说哪句"是可以**完全确定性验证**的算术 + 分档，
 * 不该埋在宿主的事件回调里。抽出来之后：
 *  · 宿主只负责"拿到新旧两次余额 → 调这里 → 把结果推给桌宠"；
 *  · 单测可以逐个边界核对（尤其是分档的临界值与充值/不变这两种边界）。
 *
 * ## 余额减少 ≠ 消耗
 *
 * 差值是新余额减去旧余额：
 *  · 差额 < 0（余额变少）→ 花掉了
 *  · 差额 = 0（没动）    → 没花
 *  · 差额 > 0（余额变多）→ 是**充值**或退费，绝不能播报成"花掉了 -8 元"
 *
 * 所以"消耗"只取下降的部分，上涨一律记 0。
 *
 * ## 分档（用户指定，按**剩余**余额分四档）
 *
 * | 档 | 剩余余额 | 台词 |
 * |---|---|---|
 * | 1 | < 10 | 余额告急了 |
 * | 2 | 10 ~ 20 | 有些吃紧 |
 * | 3 | 20 ~ 50 | 还很充裕 |
 * | 4 | > 50 | 主人太有钱了 |
 *
 * ⚠️ 原话里 10 与 20 各被两个档位同时提到（"<10 / 10~20"、
 * "10~20 / 20~50"）。实现上按惯例取**左闭右开**：
 * `[10, 20)` 属 2 档、`[20, 50)` 属 3 档、`50` 及以上属 4 档。
 * 即 10 → 2 档、20 → 3 档、50 → 4 档。
 */

import { balanceTierLine } from './voice-library.js'

/**
 * 分档边界（含下界）。写成数组便于"改边界只改一处"。
 *
 * ⚠️ 档位**短语**（"还很充裕"这类）现在来自语音库：
 * 用户要求"所有桌宠可触发的语音都归到语音库"，余额播报也算。
 * 这里只留**边界**，文字由 `balanceTierLine(tier)` 取。
 */
export const BALANCE_TIERS = [
  { tier: 1, maxExclusive: 10 },
  { tier: 2, maxExclusive: 20 },
  { tier: 3, maxExclusive: 50 },
  { tier: 4, maxExclusive: Number.POSITIVE_INFINITY },
]

/**
 * 按剩余余额取档位与台词。
 *
 * @param {number} remaining
 * @returns {{ tier: number, line: string }}
 */
export function balanceTierOf(remaining) {
  const v = Number.isFinite(remaining) ? remaining : 0
  for (const t of BALANCE_TIERS) {
    if (v < t.maxExclusive) return { tier: t.tier, line: balanceTierLine(t.tier) }
  }
  // 不可达（最后一档的上界是 Infinity），保底返回第 4 档。
  const last = BALANCE_TIERS[BALANCE_TIERS.length - 1]
  return { tier: last.tier, line: balanceTierLine(last.tier) }
}

/**
 * 金额格式化：去掉多余的尾零，但最多保留两位小数。
 *
 * 存在的理由：接口返回的是字符串（`"23.40"`），直接播报会念出
 * "花掉了 5.00 元"这种别扭的话。这里统一成 `5`、`5.5`、`5.55`。
 *
 * @param {number | string} value
 * @returns {string}
 */
export function formatMoney(value) {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').trim())
  if (!Number.isFinite(n)) return '0'
  // 先按两位小数取整（避免 0.1+0.2 这类浮点尾巴），再去掉尾零。
  const rounded = Math.round(n * 100) / 100
  return String(rounded)
}

/**
 * 算一次余额变动的播报内容。
 *
 * @param {object} args
 * @param {number} args.prevTotal 上一次的余额（首次播报时为 null）
 * @param {number} args.nextTotal 本次的余额
 * @param {string} [args.currency]
 * @returns {{ spent: number, remaining: number, tier: number, line: string, text: string, kind: 'spent' | 'toppedUp' | 'same' }}
 *          `text` 是给桌宠的完整句子；`kind` 便于日志区分三种情形。
 */
export function buildBalanceAnnouncement({ prevTotal, nextTotal, currency = 'CNY' }) {
  const next = Number.isFinite(nextTotal) ? nextTotal : 0
  const hasPrev = Number.isFinite(prevTotal)
  const rawDelta = hasPrev ? next - prevTotal : 0
  // 只有"变少"才算消耗；变多（充值/退费）记 0，绝不播报负数消耗。
  const spent = rawDelta < 0 ? Math.abs(rawDelta) : 0
  const kind = rawDelta < 0 ? 'spent' : rawDelta > 0 ? 'toppedUp' : 'same'

  const { tier, line } = balanceTierOf(next)
  const symbol = currency === 'USD' ? '$' : '¥'

  return {
    spent,
    remaining: next,
    tier,
    line,
    kind,
    text: `刚才花掉了${symbol}${formatMoney(spent)}，还有${symbol}${formatMoney(next)}，${line}。`,
  }
}

/**
 * 是否应该把这次余额变化播报出去。
 *
 * 用户要求："如果 5 分钟内没有余额变化，则不播放提示。"
 *
 * 抽成独立纯函数而不是写在宿主的回调里，是为了让"播不播"这条规则
 * **可以被单测逐种情形钉住** —— 它决定了桌宠会不会变成复读机，值得单测。
 *
 * @param {object} args
 * @param {number|null} args.prevTotal 上一次的余额；null = 首次取数
 * @param {number} args.nextTotal 本次的余额
 * @returns {{ announce: boolean, reason: 'first' | 'unchanged' | 'spent' | 'toppedUp' }}
 *          `reason` 用于日志与断言，把"为什么不播"讲清楚
 */
export function shouldAnnounceBalance({ prevTotal, nextTotal }) {
  // 首次取数：没有"上一次"可比，"花掉了 ¥0" 是无意义的噪音。
  if (!Number.isFinite(prevTotal)) return { announce: false, reason: 'first' }

  const next = Number.isFinite(nextTotal) ? nextTotal : 0
  const delta = next - prevTotal

  if (delta === 0) return { announce: false, reason: 'unchanged' }
  // 注意"充值"要播报：余额确实变了，不说的话用户会奇怪"钱怎么突然多了"。
  if (delta < 0) return { announce: true, reason: 'spent' }
  return { announce: true, reason: 'toppedUp' }
}

/**
 * 播报闸门：距离上次播报是否已经够了间隔。
 *
 * ## 为什么需要它
 *
 * 取数节奏与播报节奏**是两件事**：
 *   · 面板要**及时**（用户要求 30 秒一轮，好看到余额在动）；
 *   · 播报要**克制**（用户要求"5 分钟内没有余额变化就不播"，
 *     否则 30 秒念一次会变成复读机）。
 *
 * 而 `shouldAnnounceBalance` 是"这次和上次比变了没有"—— 取数一变密，
 * **任何一次变化都会立刻播报**，于是消耗会被拆成好几次小播报念出来。
 * 所以播报必须再加一道"距上次播报至少 N 秒"的闸门。
 *
 * 这里做成纯函数，是为了让"什么情况下重算基准"这条规则能被单测钉住
 * —— 它决定了 `prevTotal` 何时推进，而 `prevTotal` 又决定了下次播报
 * 报的是"这 5 分钟花了多少"还是"这 30 秒花了多少"。
 *
 * ## 语义
 *
 * 到点了 → 用**现在**的余额做基准去比、并播报；
 * 没到点 → 基准**不动**（继续跟 5 分钟前那个值比），于是累积的消耗
 *          会在下一个到点的窗口里一次性播出来。
 *
 * @param {object} args
 * @param {number} args.now            当前时间戳（毫秒）
 * @param {number|null} args.lastAt    上次"推进基准"的时间戳；null = 还没播过
 * @param {number} args.intervalMs     播报间隔（毫秒）
 * @returns {{ due: boolean, reason: 'first' | 'due' | 'waiting', waitMs: number }}
 */
export function shouldRunAnnounceWindow({ now, lastAt, intervalMs }) {
  const interval = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 0

  /*
   * 还没播过 → 立刻"到点"。
   * 首次会被 shouldAnnounceBalance 以 'first' 拒掉（没有可比的上一次），
   * 但**基准必须在这里建立**，否则第一次播报会等到两个周期之后。
   */
  if (!Number.isFinite(lastAt)) return { due: true, reason: 'first', waitMs: 0 }

  const elapsed = Number(now) - Number(lastAt)
  if (elapsed >= interval) return { due: true, reason: 'due', waitMs: 0 }

  return { due: false, reason: 'waiting', waitMs: interval - elapsed }
}
