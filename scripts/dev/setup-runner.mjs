/**
 * 调用 setup.exe 的**公共辅助**：启动它，然后等它真的结束。
 *
 * ## 为什么不能直接用 execFileSync / spawnSync
 *
 * setup.exe 是 `/target:winexe`（**GUI 子系统**）。这类程序在 PowerShell 里
 * 有几个反直觉的行为，我这几轮全踩过：
 *
 * | 调用方式 | 实测结果 |
 * |---|---|
 * | `& setup.exe ...` | **立即返回**（不等它），`$LASTEXITCODE` 为空 |
 * | `execFileSync(powershell -Command "& setup.exe ...")` | 同上，拿到的输出可能残缺 |
 * | `spawnSync(powershell -Command "Start-Process -Wait ...")` | **挂住不返回**（10 分钟以上） |
 * | `Start-Process -Wait` 直接调 | 有时**进程根本不出现** |
 *
 * 结论：**别依赖调用方式的返回值**。可靠的做法是
 *   1. 用一个 .ps1 脚本启动它（避开命令行引号问题）；
 *   2. 然后**轮询等 `setup` 进程消失**；
 *   3. 以**文件系统的产物**为最终判据，而不是退出码。
 *
 * @param {object} opts
 * @param {string} opts.setup   setup.exe 路径
 * @param {string[]} opts.args  传给 setup.exe 的参数
 * @param {Record<string,string>} [opts.env] 额外环境变量
 * @param {string} opts.workDir 放临时 .ps1 的目录
 * @param {number} [opts.timeoutMs] 最长等待（默认 10 分钟）
 * @returns {Promise<{output: string, waitedMs: number}>}
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 睡眠。 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** `setup` 进程当前有几个。 */
function runningSetupCount() {
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-Command', '(Get-Process -Name setup -ErrorAction SilentlyContinue | Measure-Object).Count'],
      { encoding: 'utf8' },
    )
    return Number(String(out).trim()) || 0
  } catch {
    return 0
  }
}

export async function runSetup({ setup, args, env = {}, workDir, timeoutMs = 600000 }) {
  const runner = join(workDir, 'run-setup.ps1')
  const lines = []
  /*
   * ⚠️ 先把控制台的**输出编码**设成 UTF-8。
   *
   * 安装器用 `Console.WriteLine` 输出中文（UTF-8 字节），而中文版 Windows 的
   * PowerShell 默认按 GBK 解码子进程输出 —— 于是拿到的是一堆乱码，
   * 测试里凡是"断言输出包含某个中文提示"的检查都会失效（看起来像功能没生效）。
   * 实测踩过：断言"检测到旧版本"明明该命中，却是红的。
   */
  lines.push('[Console]::OutputEncoding = [System.Text.Encoding]::UTF8')
  for (const [k, v] of Object.entries(env)) lines.push(`$env:${k} = '${v}'`)
  /*
   * 把子进程输出**重定向到文件**，而不是让 PowerShell 通过管道交回来。
   *
   * 为什么：安装器用 UTF-8 输出中文，而中文版 Windows 的 PowerShell 在
   * 管道/重定向下会用 GBK 去解码子进程的字节 —— 于是拿到的是一堆 `�`，
   * 信息已经丢了（utf8 解码 GBK 字节会产生替换字符，事后无法还原）。
   * 先把 `[Console]::OutputEncoding` 设成 UTF-8（上面那行）让 PowerShell 正确解码，
   * 再用 `Out-File -Encoding utf8` 落成 UTF-8 文件，Node 直接按 utf8 读。
   *
   * 实测：不落文件时，`/检测到旧版本/` 这类中文断言永远是红的，
   * 看起来像"功能没生效"，其实功能是对的、只是文本读坏了。
   */
  const outFile = join(workDir, 'setup-output.log')
  lines.push(`& '${setup}' ${args.map((a) => `'${a}'`).join(' ')} 2>&1 | Out-File -FilePath '${outFile}' -Encoding utf8`)
  writeFileSync(runner, lines.join('\r\n'), 'utf8')

  let output = ''
  const started = Date.now()

  /*
   * 先启动。用 `-File` 跑脚本（而不是 `-Command` 拼字符串），
   * 这样参数里的空格/引号不会出问题。
   *
   * ⚠️ 加一个短的 timeout：GUI 子系统程序会让这个 powershell **提前返回**，
   * 所以我们本来就不指望它的返回值，只借它把进程拉起来。
   */
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', runner], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: 120000,
    })
  } catch (err) {
    // 超时或非零都无所谓 —— 下面靠轮询进程判断真正的结束
  }

  /* 等 setup 进程真的消失。 */
  let waited = 0
  while (waited < timeoutMs) {
    if (runningSetupCount() === 0) break
    await sleep(1500)
    waited += 1500
  }
  await sleep(800) // 给它最后一点时间落盘

  /* 从文件里读真正的输出（UTF-8，去掉 BOM）。 */
  try {
    if (existsSync(outFile)) {
      output = readFileSync(outFile, 'utf8').replace(/^\uFEFF/, '')
    }
  } catch {
    // 读不到就算了，断言会给出"输出为空"的线索
  }

  return { output, waitedMs: Date.now() - started }
}

export { runningSetupCount }
