/**
 * 复现"余额不更新"：把 `createBalanceFetcher` 的**缓存/刷新边界**量出来。
 *
 * ## 症状
 *
 * 用户报告桌宠面板显示 ¥38.44 **一直不变**，而实际余额是 ¥44.11。
 * 说明首次取到了，之后**周期刷新没有真正重新取数**。
 *
 * ## 怀疑点
 *
 * 桌宠每 300 秒调一次 `get({ fresh: false })`（见 pet-app/main.js 的
 * `startBalanceMonitor`），而缓存 TTL **也是 300 秒**
 * （`createBalanceFetcher({ refreshSeconds: 300 })`）。
 *
 * `get()` 里的判断是：
 *
 *     const age = lastGood ? Date.now() - lastGood.fetchedAt : Infinity
 *     if (!opts.fresh && age < ttlMs) return snapshot()   // 命中缓存，不发请求
 *
 * 也就是**同一周期**。定时器与"取数开始时刻"之间只差一次网络往返，
 * 所以每轮 age 只比 ttlMs 大一点点 —— 这个边界是否稳定通过，必须实测。
 *
 * 这个脚本用**注入的 fetch**（不联网）来数"到底发了几次请求"，
 * 并用**可注入的时钟**把时间推快，从而在几毫秒内模拟出多小时的行为。
 *
 * 用法：node .cache/probe-refresh.mjs
 */

import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/* 本脚本在 scripts/dev/ 下，仓库根要往上两级 */
const ROOT = resolve(HERE, '..', '..')

/* balance.js 是 ESM */
const { createBalanceFetcher } = await import(
  'file:///' + join(ROOT, 'src', 'shared-core', 'balance.js').replace(/\\/g, '/')
)

const log = (m) => console.log(m)

/* ---- 可控时钟 ---- */
let now = 1_700_000_000_000
const realNow = Date.now
Date.now = () => now

/* ---- 计数的假 fetch ---- */
let fetchCount = 0
let nextTotal = 38.44
const fakeFetch = async () => {
  fetchCount++
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({
      is_available: true,
      balance_infos: [
        { currency: 'CNY', total_balance: nextTotal.toFixed(2), granted_balance: '15.93', topped_up_balance: '28.18' },
      ],
    }),
  }
}

const resolveCredential = async () => ({ value: 'sk-fake' })
const TTL_SECONDS = 300

const fetcher = createBalanceFetcher({
  refreshSeconds: TTL_SECONDS,
  fetchImpl: fakeFetch,
  log: () => {},
})

log(`缓存 TTL = ${String(TTL_SECONDS)} 秒（桌宠的刷新周期也是 ${String(TTL_SECONDS)} 秒）`)
log(`peek().ttlMs = ${String(fetcher.ttlMs)}`)
log('')

log('=== 第 1 次：启动时立刻拉一次（fresh 默认 false，没有缓存所以会真发请求）===')
let snap = await fetcher.get({ resolveCredential })
log(`  请求次数=${String(fetchCount)}  显示余额=${String(snap.total)}  error=${String(snap.error)}`)

log('')
log('=== 之后每 300 秒调一次 get({fresh:false})，看会不会真的重新取数 ===')
for (let i = 1; i <= 5; i++) {
  now += TTL_SECONDS * 1000
  nextTotal = 38.44 + i /* 每次"服务端"都返回不同的值，便于看出有没有刷新 */
  const before = fetchCount
  snap = await fetcher.get({ resolveCredential })
  const refreshed = fetchCount > before
  log(
    `  第 ${String(i)} 轮（+${String(TTL_SECONDS)}s）：请求次数 ${String(before)}→${String(fetchCount)}` +
      `  ${refreshed ? '✅ 真刷新' : '❌ 命中缓存、没发请求'}  显示=${String(snap.total)}`,
  )
}

log('')
log('=== 结论 ===')
log(`  总请求次数：${String(fetchCount)}（期望：1 次启动 + 5 次周期 = 6）`)
if (fetchCount >= 6) {
  log('  ✅ 周期刷新能正常穿破缓存 —— 缓存边界不是问题。')
  log('     那"不更新"的原因在别处（定时器没跑 / 推送或渲染问题）。')
} else {
  log('  ❌ 周期刷新被缓存挡住了 —— 与用户症状一致（显示一直不变）。')
}

Date.now = realNow
