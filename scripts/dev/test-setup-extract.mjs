/**
 * 验证 setup.exe 的**载荷解压**（`--selftest` 模式）。
 *
 * ## 为什么要单独一个脚本
 *
 * setup.exe 是 `/target:winexe`（GUI 子系统）编译的。直接 `& setup.exe`
 * 在 PowerShell 里**不会等它结束、也不捕获它的 stdout** ——
 * 实测表现为"输出 0 行、退出码为空"，而那**不代表它失败了**，
 * 只是没等它。这种假象很容易让人误判（我第一次就误判成"解压不工作"）。
 *
 * 所以这里：
 *   · 用 `Start-Process -Wait` 真正等它结束；
 *   · 结果从 setup.exe 自己写的**报告文件**里读（不依赖 stdout）；
 *   · 另外核对解出来的文件数 —— 这是比报告更硬的证据。
 *
 * ## 为什么值得验
 *
 * 载荷解压用 `installer/MiniZip.cs`，那是**本项目自己实现的 ZIP 解析器**
 * （为兼容 .NET Framework 4.0，不能用 `ZipFile`）。自己写的解析器最需要验证。
 *
 * 用法：node scripts/dev/test-setup-extract.mjs [目标目录]
 * 退出码 0 = 解压自检全部通过。
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runSetup } from './setup-runner.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')

/*
 * 用**非提权版**跑自动化测试。
 *
 * 正式版 `setup.exe` 带 `requireAdministrator` 清单，Windows 会在**加载 exe
 * 之前**就弹 UAC —— 自动化测试跑几次就弹几次，不可接受。
 * `setup-noelevate.exe` 的安装逻辑与正式版完全相同，只是不求提权。
 *
 * 生成测试版：`DSH_PET_SETUP_NO_ELEVATE=1 node scripts/dev/build-installer.mjs`
 */
const SETUP_ELEVATED = join(ROOT, 'dist', 'setup.exe')
const SETUP = join(ROOT, 'dist', 'setup-noelevate.exe')

/*
 * ⚠️ 目标目录**必须放在工作区内**。
 *
 * 第一版用 `%TEMP%`，结果 MiniZip 在建目录时收到
 * `UnauthorizedAccessException: 对路径 ...\Temp\st-target 的访问被拒绝`
 * —— 那是 DSH 的文件沙箱拦的（工作区外写入受限），**不是解压器的缺陷**。
 * 放在工作区内才能真实检验解压逻辑。
 */
const target = process.argv[2] ? resolve(process.argv[2]) : join(ROOT, '.cache', 'setup-extract-test')

const log = (m) => console.log(m)

if (!existsSync(SETUP)) {
  log(`✗ 找不到测试用的安装程序：${SETUP}`)
  log('  先生成（会额外产出非提权版，不影响正式产物）：')
  log('    $env:DSH_PET_SETUP_NO_ELEVATE=1; node scripts/dev/build-installer.mjs')
  log(`  （正式版在 ${SETUP_ELEVATED}，但它带 requireAdministrator，跑测试会弹 UAC）`)
  process.exit(1)
}
log(`测试用安装程序：${SETUP.split(/[\\/]/).pop()} — ${(statSync(SETUP).size / 1024 / 1024).toFixed(2)} MB`)
log(`目标目录：${target}`)

/*
 * 报告路径：setup.exe 把自检报告写在**目标目录的父目录**里
 * （见 Setup.cs 的 WriteReport —— 刻意不写 %TEMP%，那里可能被沙箱拒）。
 */
const REPORT = join(dirname(target), 'setup-selftest-report.txt')

// 清场
rmSync(target, { recursive: true, force: true })
rmSync(REPORT, { force: true })

/*
 * 调用 setup.exe 并等它结束。
 *
 * ⚠️ 不要自己拼 PowerShell —— GUI 子系统程序在 `&` 下会**立即返回**、
 * 在 `Start-Process -Wait` 下又会**挂住不返回**（两种都实测过）。
 * 统一走 setup-runner.mjs 里那套"启动 + 轮询进程"的做法。
 */
log('')
log('运行 setup.exe --selftest（GUI 子系统：启动后轮询等它结束）…')
const { output: setupOut, waitedMs } = await runSetup({
  setup: SETUP,
  args: ['--selftest', target],
  workDir: dirname(target),
  timeoutMs: 600000,
})
log(`  等待 ${(waitedMs / 1000).toFixed(1)} 秒`)
if (setupOut.trim()) {
  log('  setup.exe 输出：')
  for (const line of setupOut.split(/\r?\n/)) if (line.trim()) log('    ' + line.trimEnd())
}

// ---------------------------------------------------------------- 读报告
log('')
log('自检报告：')
let reportOk = false
if (existsSync(REPORT)) {
  const text = readFileSync(REPORT, 'utf8')
  for (const line of text.split(/\r?\n/)) {
    if (line.trim()) log('  ' + line.trimEnd())
  }
  reportOk = /自检通过/.test(text) && !/\[FAIL\]/.test(text)
} else {
  log('  ✗ 报告文件不存在 —— setup.exe 可能根本没跑起来')
}

// ---------------------------------------------------------------- 硬证据
/*
 * 报告是 setup.exe 自己写的，可能被写坏或漏写。用文件系统的事实交叉验证：
 * 解出来的文件数、关键文件、以及 PNG 二进制是否完好。
 */
log('')
log('文件系统核对（比报告更硬的证据）：')
let failed = 0
const check = (name, ok, detail) => {
  log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed += 1
}

const countFiles = (dir) => {
  let n = 0
  const walk = (d) => {
    let entries
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.isDirectory()) walk(join(d, e.name))
      else n += 1
    }
  }
  walk(dir)
  return n
}

if (!existsSync(target)) {
  check('目标目录已创建', false, target)
} else {
  const n = countFiles(target)
  check('解出了文件', n > 100, `${String(n)} 个`)

  const required = [
    'package.json',
    'cordis.patch.yml',
    'install.mjs',
    'src/host/index.js',
    'client/client.js',
    'pet-app/main.js',
    'assets/animations/stand/manifest.json',
    join('node_modules', '@deepseek-ai', 'schemastery', 'package.json'),
  ]
  for (const rel of required) {
    const full = join(target, rel)
    const ok = existsSync(full)
    check(`含 ${rel.replace(/\\/g, '/')}`, ok, ok ? `${String(statSync(full).size)} 字节` : '缺失')
  }

  const animRoot = join(target, 'assets', 'animations')
  const animCount = existsSync(animRoot) ? readdirSync(animRoot).length : 0
  check('动画动作目录数 = 10', animCount === 10, `实际 ${String(animCount)}`)

  /* 二进制抽查：PNG 头必须是 0x89 'P' 'N' 'G' */
  const png = join(animRoot, 'stand', 'frame_01.png')
  if (existsSync(png)) {
    const head = readFileSync(png)
    const okPng = head.length > 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47
    check('PNG 文件头正确（二进制未被损坏）', okPng, okPng ? `${String(head.length)} 字节` : '头部不是 PNG 签名')
  } else {
    check('PNG 文件头正确（二进制未被损坏）', false, '找不到 stand/frame_01.png')
  }
}

check('自检报告说"通过"', reportOk, existsSync(REPORT) ? '' : '报告缺失')

log('')
log(`结果：${failed === 0 ? '解压自检全部通过' : `${String(failed)} 项未通过`}`)
if (failed === 0) log('（目标目录保留，可自行查看：' + target + '）')
process.exitCode = failed === 0 ? 0 : 1
