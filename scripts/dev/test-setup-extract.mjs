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
  log('')
  log('  它由构建脚本产出（默认同时产出正式版与这个测试版）：')
  log('    node scripts/dev/build-installer.mjs')
  log('')
  log('  注意：`build-package.mjs` 只生成载荷，**不会**产出任何 exe。')
  log('  所以只跑过 build-package 的话，这里就会缺文件。')
  if (!existsSync(SETUP_ELEVATED)) {
    log(`  （正式版 ${SETUP_ELEVATED.split(/[\\/]/).pop()} 也不存在 —— 还没构建过安装器）`)
  } else {
    log(`  （正式版在 ${SETUP_ELEVATED}，但它带 requireAdministrator，跑测试会弹 UAC）`)
  }
  log('')
  log('  若只想跳过这一步：设 DSH_PET_SETUP_NO_TEST_BUILD=1 再构建。')
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
  const animDirs = existsSync(animRoot) ? readdirSync(animRoot) : []
  const animCount = animDirs.length
  /*
   * ⚠️ 刻意**不**写死"目录数 = 某个数字"。
   *
   * 原先断言 `animCount === 10`，于是每加一个动作（坐下就是加了 3 个目录）
   * 这条都会假失败 —— 而它想守的其实是"素材没有被打包漏掉"。
   * 改成"关键目录都在 + 数量不少于下限"，加动作时不必再改这里。
   */
  const requiredAnims = [
    'stand', 'hang', 'eat', 'sleep', 'awake',
    'head', 'chest', 'stomach', 'leg',
    'game-begin', 'game-loop', 'game-stop',
    'sit', 'sit-circle', 'sit-stop',
    'think-enter', 'think-loop', 'think-exit',
  ]
  const missingAnims = requiredAnims.filter((d) => !animDirs.includes(d))
  check(
    '关键动画动作目录都在',
    missingAnims.length === 0,
    missingAnims.length === 0
      ? `共 ${String(animCount)} 个目录，关键目录齐全`
      : `缺：${missingAnims.join(', ')}；实际有：${animDirs.join(', ')}`,
  )
  check('动画动作目录数不少于 10', animCount >= 10, `实际 ${String(animCount)}`)

  /*
   * 二进制抽查：帧文件必须是**完整的 WebP**（RIFF....WEBP）。
   *
   * 素材已从 PNG 换成 WebP（体积只有原来的 ~20%，alpha 无损），
   * 所以校验 WebP 头：偏移 0 处 "RIFF"，偏移 8 处 "WEBP"。
   * 这条能抓到"解压把二进制弄坏"这类真问题 —— 换格式不该把检查丢掉。
   */
  const frame = join(animRoot, 'stand', 'frame_01.webp')
  if (existsSync(frame)) {
    const head = readFileSync(frame)
    const okWebp =
      head.length > 12
      && head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46
      && head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50
    check('WebP 文件头正确（二进制未被损坏）', okWebp, okWebp ? `${String(head.length)} 字节` : '头部不是 WebP 签名')
  } else {
    check('WebP 文件头正确（二进制未被损坏）', false, '找不到 stand/frame_01.webp')
  }
}

check('自检报告说"通过"', reportOk, existsSync(REPORT) ? '' : '报告缺失')

log('')
log(`结果：${failed === 0 ? '解压自检全部通过' : `${String(failed)} 项未通过`}`)
if (failed === 0) log('（目标目录保留，可自行查看：' + target + '）')
process.exitCode = failed === 0 ? 0 : 1
