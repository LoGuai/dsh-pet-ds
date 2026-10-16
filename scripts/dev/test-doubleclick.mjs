/**
 * 运行 `scripts/dev/test-doubleclick.ps1`。
 *
 * 它模拟**真正的双击**：`cmd /c install.cmd`，不带任何命令行开关。
 *
 * ## 为什么要专门测这条路
 *
 * 我开发时一直用 `-ExecutionPolicy Bypass -File install-pet.ps1` 测，
 * **掩盖了真实使用方式** —— 这台机器的执行策略是 `Restricted`，
 * 用户直接运行 .ps1 会报：
 *
 *     cannot be loaded because running scripts is disabled on this system
 *
 * 这正是用户实际撞到的问题。所以必须有一条测试完全按用户操作来
 * （走 `.cmd` 启动器、不传开关），否则同类问题还会漏。
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const PS1 = join(HERE, 'test-doubleclick.ps1')

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
  console.log('结果：双击启动器测试全部通过')
} catch (err) {
  const out = String(err?.stdout ?? '') + String(err?.stderr ?? '')
  for (const line of out.split(/\r?\n/)) {
    if (line.trim()) console.log(line.trimEnd())
  }
  console.log('结果：双击启动器测试有失败项')
  process.exit(1)
}
