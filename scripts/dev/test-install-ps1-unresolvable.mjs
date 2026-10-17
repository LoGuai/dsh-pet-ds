/**
 * `test-install-ps1-unresolvable.ps1` 的 Node 包装（让 `npm test` 能统一调用）。
 *
 * 它验证的是**失败路径**：依赖装不上时必须回滚登记并明确报错，
 * 而不是留下"登记了但解析不到"的坏插件（DSH 会显示「异常 / 包不可用」）。
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PS1 = join(HERE, 'test-install-ps1-unresolvable.ps1')

if (!existsSync(PS1)) {
  console.log(`✗ 找不到测试脚本：${PS1}`)
  process.exit(1)
}

try {
  const out = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 900000 },
  )
  for (const line of out.split(/\r?\n/)) {
    if (line.trim()) console.log(line.trimEnd())
  }
  console.log('结果：依赖装不上时的回滚行为正确')
} catch (err) {
  const out = String(err?.stdout ?? '') + String(err?.stderr ?? '')
  for (const line of out.split(/\r?\n/)) {
    if (line.trim()) console.log(line.trimEnd())
  }
  console.log('结果：失败路径的断言有未通过项')
  process.exit(1)
}
