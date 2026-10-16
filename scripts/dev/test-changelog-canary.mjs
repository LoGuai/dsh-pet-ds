/**
 * 金丝雀：验证 test-changelog.mjs **真的**能抓到问题，而不是恒真。
 *
 * 为什么必须做：一个"永远通过"的检查比没有检查更糟 —— 它会让人以为
 * 有保护。我第一次用 `node -e` 内联做这个金丝雀时，PowerShell 把
 * `replace` 的参数吃了，文件根本没被改动，于是"通过"是假的。
 * 所以改成写文件执行。
 *
 * 检查两件事：
 *   金丝雀 1：版本号在日志里不存在 → 必须失败
 *   金丝雀 2：当前版本段被清成空壳 → 必须失败
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')

const CHANGELOG = join(ROOT, 'CHANGELOG.md')
const PKG = join(ROOT, 'package.json')
const TEST = join(HERE, 'test-changelog.mjs')
const BAK_CL = join(ROOT, '.cache', 'canary-CHANGELOG.bak')
const BAK_PKG = join(ROOT, '.cache', 'canary-package.json.bak')

const log = (m) => console.log(m)

/** 跑检查脚本，返回退出码。 */
function runCheck() {
  try {
    execFileSync(process.execPath, [TEST], { encoding: 'utf8', stdio: 'pipe' })
    return 0
  } catch (err) {
    return typeof err?.status === 'number' ? err.status : 1
  }
}

/** 基线：原样必须通过。 */
function baseline() {
  const rc = runCheck()
  log(`  基线（原样）：exit=${String(rc)}  ${rc === 0 ? '✅ 通过' : '❌ 应通过却失败'}`)
  return rc === 0
}

let ok = true

copyFileSync(CHANGELOG, BAK_CL)
copyFileSync(PKG, BAK_PKG)
try {
  log('金丝雀 1：版本号改成日志里没有的值 → 期望失败')
  {
    const j = JSON.parse(readFileSync(PKG, 'utf8'))
    j.version = '9.9.9-canary'
    writeFileSync(PKG, `${JSON.stringify(j, null, 2)}\n`, 'utf8')
  }
  const rc = runCheck()
  log(`  exit=${String(rc)}  ${rc !== 0 ? '✅ 正确失败' : '❌ 恒真！检查形同虚设'}`)
  if (rc === 0) ok = false

  /* 恢复 package.json，进入金丝雀 2 */
  copyFileSync(BAK_PKG, PKG)

  log('')
  log('金丝雀 2：把当前版本段清成空壳 → 期望失败')
  {
    const v = JSON.parse(readFileSync(PKG, 'utf8')).version
    const lines = readFileSync(CHANGELOG, 'utf8').split(/\r?\n/)
    const esc = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`^##\\s*\\[${esc}\\]`)
    const start = lines.findIndex((l) => re.test(l))
    if (start < 0) {
      log(`  ⚠ 日志里找不到 ${v} 段，跳过这条金丝雀`)
    } else {
      let end = lines.length
      for (let i = start + 1; i < lines.length; i++) {
        if (/^##\s/.test(lines[i])) {
          end = i
          break
        }
      }
      /* 只留标题，其余内容删掉 */
      const out = [...lines.slice(0, start + 1), '', ...lines.slice(end)]
      writeFileSync(CHANGELOG, out.join('\n'), 'utf8')
      const rc2 = runCheck()
      log(`  exit=${String(rc2)}  ${rc2 !== 0 ? '✅ 正确失败' : '❌ 空壳没被拦住'}`)
      if (rc2 === 0) ok = false
    }
  }
} finally {
  copyFileSync(BAK_CL, CHANGELOG)
  copyFileSync(BAK_PKG, PKG)
  for (const f of [BAK_CL, BAK_PKG]) if (existsSync(f)) unlinkSync(f)
  log('')
  log('已恢复原文件。')
  if (!baseline()) ok = false
}

log('')
log(ok ? '结果：金丝雀全部符合预期 —— 检查确实有效' : '结果：金丝雀失败 —— 检查不可信')
process.exitCode = ok ? 0 : 1
