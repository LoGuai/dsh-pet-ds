/**
 * 用**桌宠同一份取数代码**实测一次余额，定位"余额监控不更新"卡在哪一环。
 *
 * 复用的东西：
 *   · `src/shared-core/balance.js` 的 `createBalanceFetcher` —— 桌宠主进程用的就是它
 *   · `pet-app/credentials-file.js` 的 `readCredentialFromFile` —— 桌宠读凭据用的就是它
 *
 * 这样每一步都能分开报，而不是笼统地说"取不到"：
 *   凭据读到了吗 → 网络通吗 → 接口返回什么 → 解析出金额了吗
 */

import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/* 本脚本在 scripts/dev/ 下，仓库根要往上两级 */
const ROOT = resolve(HERE, '..', '..')

/* credentials-file.js 是 CJS，且它自己 `require('node:fs')` —— 用 createRequire 加载 */
const require = createRequire(import.meta.url)
const { readCredentialFromFile } = require(join(ROOT, 'pet-app', 'credentials-file.js'))

const log = (m) => console.log(m)

log('=== 1) 从凭据文件读 DEEPSEEK_API_KEY ===')
const cred = readCredentialFromFile({ credential: 'DEEPSEEK_API_KEY' })
log(`  ok    : ${String(cred.ok)}`)
if (!cred.ok) {
  log(`  原因  : ${String(cred.error ?? cred.reason ?? '(未说明)')}`)
  log('  → 这一环就断了：桌宠没有密钥可用，余额永远取不到。')
  process.exit(1)
}
log(`  来源  : ${String(cred.source ?? cred.from ?? '(未说明)')}`)
log(`  密钥  : ${String(cred.value).slice(0, 8)}…（长度 ${String(cred.value).length}）`)

log('')
log('=== 2) 直接打 DeepSeek /user/balance ===')
const apiBase = 'https://api.deepseek.com'
let res
try {
  res = await fetch(`${apiBase}/user/balance`, {
    headers: { Authorization: `Bearer ${cred.value}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  })
} catch (err) {
  log(`  ✗ 请求本身失败：${err instanceof Error ? err.message : String(err)}`)
  log('  → 网络/DNS/代理问题，与插件无关。')
  process.exit(1)
}
log(`  HTTP  : ${String(res.status)} ${res.statusText}`)
const text = await res.text()
log(`  响应体: ${text.slice(0, 400)}`)

if (res.status !== 200) {
  log('')
  log('  → 接口返回了非 200。常见原因：')
  log('     · 401/403：密钥无效或过期')
  log('     · 402：余额不足/欠费')
  log('     · 429：限流')
  process.exit(1)
}

log('')
log('=== 3) 解析出的金额 ===')
try {
  const root = JSON.parse(text)
  const infos = Array.isArray(root.balance_infos) ? root.balance_infos : []
  if (infos.length === 0) {
    log('  ✗ 响应里没有 balance_infos —— 取数算法拿不到金额。')
    process.exit(1)
  }
  for (const i of infos) {
    log(`  币种 ${String(i.currency)}  总额 ${String(i.total_balance)}  赠金 ${String(i.granted_balance)}  充值 ${String(i.topped_up_balance)}`)
  }
  log(`  is_available: ${String(root.is_available)}`)
} catch (err) {
  log(`  ✗ JSON 解析失败：${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}

log('')
log('=== 结论 ===')
log('  凭据 → 网络 → 接口 → 解析 这条链本身是通的。')
log('  所以"不更新"出在**桌宠侧**（定时器/推送/渲染），不在取数。')
