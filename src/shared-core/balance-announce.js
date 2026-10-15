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

/** 分档边界（含下界）。写成数组便于"改边界只改一处"。 */
export const BALANCE_TIERS = [
  { tier: 1, maxExclusive: 10, line: '余额告急了' },
  { tier: 2, maxExclusive: 20, line: '有些吃紧' },
  { tier: 3, maxExclusive: 50, line: '还很充裕' },
  { tier: 4, maxExclusive: Number.POSITIVE_INFINITY, line: '主人太有钱了' },
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
    if (v < t.maxExclusive) return { tier: t.tier, line: t.line }
  }
  // 不可达（最后一档的上界是 Infinity），保底返回第 4 档。
  const last = BALANCE_TIERS[BALANCE_TIERS.length - 1]
  return { tier: last.tier, line: last.line }
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
