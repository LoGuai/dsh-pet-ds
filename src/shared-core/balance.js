/**
 * DeepSeek 余额查询 —— **纯逻辑 + 取数**，宿主与桌宠**共用同一份**。
 *
 * ## 为什么放在 shared-core
 *
 * 这份代码原先在 `src/host/balance.js`（只有宿主用）。后来按用户要求把余额取数
 * **搬到桌宠侧**（桌宠自己取，改完只需重启桌宠、不必重启 DSH），于是它必须
 * 两边都能读：
 *  · 宿主是 ESM，直接 `import`；
 *  · 桌宠是 CJS，靠 Node 的 `require(esm)` 能力 `require`（本机实测可用，
 *    见 README 的「共享核心」一节）。
 *
 * **刻意不做两份** —— 复制一份必然漂移（字段名、夹取、错误处理迟早不一致），
 * 而余额是要显示给用户看的数字，两份不一致会很难查。
 *
 * ## 凭据从哪来：由调用方注入
 *
 * 桌面侧与宿主侧的凭据来源**完全不同**：
 *  · 宿主：`ctx.credentials.resolve(name)` —— DSH 的凭据服务；
 *  · 桌宠：读 `$DSH_HOME/.credentials.yaml`（见 pet-app/credentials-file.js）。
 *
 * 所以这里只接受一个 `resolveCredential(name) => Promise<{value}|null>` 回调，
 * 不关心它从哪来。这样"怎么取数"只有一份，"密钥从哪读"各自实现。
 *
 * ## 数据源
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
 * 字段名与参考项目 `dsh-deepseek-pet` 的实现一致 —— 那是本机验证过能跑通的写法。
 * 金额一律当**字符串**处理，避免浮点误差。
 *
 * ## 缓存与失败处理
 *
 * - 默认 300 秒（5 分钟，用户指定）刷新一次；
 * - **取数失败时保留上一次的成功值**，只标记 `error` / `stale`，
 *   而不是把余额清成 null —— 否则一次网络抖动就会让面板上的数字消失；
 * - 超过 3 个刷新周期没成功 → `stale: true`，面板显示"已过期"。
 */

/** 数据来源标识。 */
export const BALANCE_SOURCE = 'apikey'

/** 默认 API 地址。 */
export const DEFAULT_API_BASE = 'https://api.deepseek.com'

/** 默认凭据键名。 */
export const DEFAULT_CREDENTIAL = 'DEEPSEEK_API_KEY'

/**
 * 归一化 API 地址：去掉尾部斜杠，空值回落默认。
 * @param {unknown} value
 */
export function normalizeApiBase(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return DEFAULT_API_BASE
  return raw.replace(/\/+$/, '')
}

/**
 * 把官方响应转成内部结构。
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
 * @param {object} [options]
 * @param {number} [options.refreshSeconds] 缓存时长（秒），最小 5
 * @param {string} [options.apiBase] 接口地址
 * @param {string} [options.credential] 凭据键名
 * @param {string} [options.currency] 官方没给币种时的回落值
 * @param {(msg: string) => void} [options.log]
 * @param {typeof fetch} [options.fetchImpl] 注入 fetch（便于单测，不必真联网）
 */
export function createBalanceFetcher(options = {}) {
  const ttlMs = Math.max(5, Number(options.refreshSeconds) || 300) * 1000
  const apiBase = normalizeApiBase(options.apiBase)
  const credential = String(options.credential ?? DEFAULT_CREDENTIAL)
  const fallbackCurrency = String(options.currency ?? 'CNY')
  const log = typeof options.log === 'function' ? options.log : () => {}
  const doFetch = typeof options.fetchImpl === 'function' ? options.fetchImpl : fetch

  /**
   * 最近一次成功取到的余额。失败时**不动它**。
   * @type {object|null}
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

    const res = await doFetch(`${apiBase}/user/balance`, {
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
     * @returns {Promise<object>} **永不 reject** —— 失败信息放在 error 字段里
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
