/**
 * DeepSeek API 余额查询 —— 宿主半侧。
 *
 * ## 为什么放在宿主侧
 *
 * **API Key 绝不能进桌宠进程。** 桌宠是一个独立的 Electron 窗口进程，
 * 它只需要知道"余额是多少"这一个数字；把密钥交给它等于把密钥暴露在
 * 一个只用来画画的进程里。所以取数、缓存、错误处理都留在这里，
 * 桌宠通过回环接口只读到 `BalanceSnapshot`（见 shared-core/protocol.js）。
 *
 * ## 数据源
 *
 * 只有一条路，但它足够可靠：用凭据 `DEEPSEEK_API_KEY` 直查官方接口
 *
 * ```
 * GET {apiBase}/user/balance
 * Authorization: Bearer <key>
 * ```
 *
 * 响应形如：
 * ```json
 * { "is_available": true,
 *   "balance_infos": [{ "currency": "CNY", "total_balance": "12.34",
 *                       "granted_balance": "2.00", "topped_up_balance": "10.34" }] }
 * ```
 *
 * 字段名与参考项目 `dsh-deepseek-pet` 的实现一致 —— 那是本机验证过能跑通的写法，
 * 不是我猜的。金额一律当**字符串**处理（协议里也是 string），避免浮点误差。
 *
 * ## 缓存
 *
 * 默认 60 秒（用户可在配置里改）。缓存的必要性：
 *  · 余额接口有自己的限流，轮询太密会被拒；
 *  · 桌宠每几秒就来取一次状态，不能每次都去打真实接口。
 *
 * 取数失败时**保留上一次的成功值**并标记 `error` / `stale`，
 * 而不是把余额清成 null —— 否则一次网络抖动就会让面板上的数字消失。
 */

/** 数据来源标识。 */
export const BALANCE_SOURCE = 'apikey'

/**
 * @typedef {object} BalanceSnapshot
 * @property {'apikey' | 'none'} source
 * @property {boolean} isAvailable  官方返回的"账户是否可用"
 * @property {string} currency
 * @property {string} total
 * @property {string} granted
 * @property {string} toppedUp
 * @property {number} fetchedAt
 * @property {boolean} stale        超过 3 个刷新周期没成功取到数
 * @property {string|null} error
 */

/**
 * 归一化 API 地址：去掉尾部斜杠，空值回落默认。
 * @param {unknown} value
 */
function normalizeBase(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return 'https://api.deepseek.com'
  return raw.replace(/\/+$/, '')
}

/**
 * 把官方响应转成内部快照。
 * 缺失字段一律回落到安全默认值，不让一个畸形响应把面板搞坏。
 *
 * @param {unknown} data
 * @returns {{ isAvailable: boolean, currency: string, total: string, granted: string, toppedUp: string }}
 */
export function normalizeBalanceResponse(data) {
  const root = data && typeof data === 'object' ? data : {}
  const infos = Array.isArray(root.balance_infos) ? root.balance_infos : []
  const info = infos.length > 0 && infos[0] && typeof infos[0] === 'object' ? infos[0] : {}
  const asMoneyString = (v) => {
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (typeof v === 'number' && Number.isFinite(v)) return v.toFixed(2)
    return '0.00'
  }
  return {
    isAvailable: root.is_available === true,
    currency: typeof info.currency === 'string' && info.currency ? info.currency : 'CNY',
    total: asMoneyString(info.total_balance),
    granted: asMoneyString(info.granted_balance),
    toppedUp: asMoneyString(info.topped_up_balance),
  }
}

/**
 * 创建一个余额查询器。
 *
 * @param {object} options
 * @param {number} [options.refreshSeconds] 缓存时长（秒），最小 5
 * @param {string} [options.apiBase] 接口地址
 * @param {string} [options.credential] 凭据键名，默认 DEEPSEEK_API_KEY
 * @param {string} [options.currency] 官方没给币种时的回落值
 * @param {(msg: string) => void} [options.log]
 */
export function createBalanceFetcher(options = {}) {
  const ttlMs = Math.max(5, Number(options.refreshSeconds) || 60) * 1000
  const apiBase = normalizeBase(options.apiBase)
  const credential = String(options.credential ?? 'DEEPSEEK_API_KEY')
  const fallbackCurrency = String(options.currency ?? 'CNY')
  const log = typeof options.log === 'function' ? options.log : () => {}

  /**
   * 最近一次成功取到的余额。失败时**不动它** —— 见文件头的说明。
   * @type {BalanceSnapshot|null}
   */
  let lastGood = null
  /** 最近一次错误信息（成功时清空）。 */
  let lastError = null
  /** 正在进行的请求，避免并发重复打接口。 */
  let inflight = null

  /** 组一份当前可见的快照（可能是缓存值 + error/stale 标记）。 */
  function snapshot() {
    if (!lastGood) {
      return {
        source: BALANCE_SOURCE,
        isAvailable: false,
        currency: fallbackCurrency,
        total: '0.00',
        granted: '0.00',
        toppedUp: '0.00',
        fetchedAt: 0,
        stale: true,
        error: lastError ?? '尚未取到余额',
      }
    }
    const age = Date.now() - lastGood.fetchedAt
    return {
      ...lastGood,
      // 超过 3 个周期没刷新成功就标记为过期（界面据此淡化显示）。
      stale: age > ttlMs * 3,
      error: lastError,
    }
  }

  /**
   * 真正发一次请求。
   * @param {(name: string) => Promise<{ value?: string } | null>} resolveCredential
   */
  async function fetchOnce(resolveCredential) {
    const cred = await resolveCredential(credential)
    const key = cred && typeof cred.value === 'string' ? cred.value.trim() : ''
    if (!key) throw new Error(`凭据 ${credential} 未配置（无法查询余额）`)

    const res = await fetch(`${apiBase}/user/balance`, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) throw new Error(`HTTP ${String(res.status)} ${res.statusText}`)
    const data = await res.json()
    const parsed = normalizeBalanceResponse(data)
    lastGood = {
      source: BALANCE_SOURCE,
      isAvailable: parsed.isAvailable,
      currency: parsed.currency || fallbackCurrency,
      total: parsed.total,
      granted: parsed.granted,
      toppedUp: parsed.toppedUp,
      fetchedAt: Date.now(),
    }
    lastError = null
    return lastGood
  }

  return {
    /**
     * 取余额快照。
     *
     * @param {object} [opts]
     * @param {(name: string) => Promise<{ value?: string } | null>} opts.resolveCredential
     * @param {boolean} [opts.fresh] true = 忽略缓存强制刷新
     * @returns {Promise<BalanceSnapshot>} **永不 reject** —— 失败信息放在 error 字段里
     */
    async get(opts = {}) {
      const resolveCredential = opts.resolveCredential
      if (typeof resolveCredential !== 'function') {
        lastError = '凭据服务不可用'
        return snapshot()
      }

      const age = lastGood ? Date.now() - lastGood.fetchedAt : Number.POSITIVE_INFINITY
      if (!opts.fresh && age < ttlMs) return snapshot()

      // 已有请求在飞：复用它，不再发一个。
      if (inflight) return inflight

      inflight = (async () => {
        try {
          await fetchOnce(resolveCredential)
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err)
          log(`余额查询失败：${lastError}`)
        } finally {
          inflight = null
        }
        return snapshot()
      })()
      return inflight
    },

    /** 读当前快照（不发请求）。 */
    peek: snapshot,

    /** 缓存时长（毫秒），供自测断言。 */
    ttlMs,
  }
}
