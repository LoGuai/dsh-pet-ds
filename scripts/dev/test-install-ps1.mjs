/**
 * 运行 `install-pet.ps1`（一键安装脚本）的沙箱测试。
 *
 * 真正的测试逻辑在 `scripts/dev/test-install-ps1.ps1` 里 —— 它是 PowerShell，
 * 因为它要**真的跑一遍安装流程**（调 pnpm、改 JSON、验结果），用同一种语言写最直接。
 *
 * 本文件只是个 Node 包装：让 `npm test` 能统一地用 `node xxx.mjs` 调用它。
 *
 * ## 这个测试最重要的是哪一条断言
 *
 * **"真实 profile 未被改动"**。
 *
 * 我在开发过程中两次把用户的真实 DSH 配置改掉，根因都是"以为在沙箱里跑、
 * 实际落到了真实目录"（`.cmd` 那版在脚本内部清空了传入的 DSH_HOME）。
 * 所以测试同时用**参数显式指定沙箱**（`-DshHome`）与**跑前跑后的
 * SHA256 比对**，双保险。
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')

const PS1 = join(HERE, 'test-install-ps1.ps1')

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
  /*
   * 把子进程输出原样转发（含它自己的 [OK]/[X] 明细），
   * 而不是只报一句成功 —— 出问题时这些明细就是线索。
   */
  for (const line of out.split(/\r?\n/)) {
    if (line.trim()) console.log(line.trimEnd())
  }
  console.log('结果：install-pet.ps1 沙箱测试全部通过')
} catch (err) {
  const out = String(err?.stdout ?? '') + String(err?.stderr ?? '')
  for (const line of out.split(/\r?\n/)) {
    if (line.trim()) console.log(line.trimEnd())
  }
  console.log('结果：install-pet.ps1 沙箱测试有失败项')
  process.exit(1)
}
