/**
 * 编译安装程序 setup.exe。
 *
 * ## 为什么用 csc.exe 而不是 dotnet SDK
 *
 * 本机装了 .NET 7 运行时，但**没装 SDK**（`dotnet build` 用不了）。
 * 而 Windows 自带 .NET Framework 4.0 的 `csc.exe`：
 *
 *   C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe
 *
 * 用它编译出来的 exe **在任何现代 Windows 上都能跑**，而且不需要安装任何东西。
 *
 * ## 载荷怎么进 exe：用 `csc /resource:`，不用字节字面量
 *
 * 一开始我把载荷生成为 `Payload.g.cs`（一个巨大的 `byte[]` 字面量，
 * 分 1833 块拼装）。结果源码 **409 MB**、1.15 亿个数组元素，
 * csc 编译**几分钟都没完**（实测转后台后仍未结束，只能放弃）。
 *
 * 改用 `csc /resource:<zip>,payload`：编译**秒级**完成，资源名固定为 `payload`。
 * 代价是取资源时资源名写错只会返回 null（不抛异常），所以这里加了两道校验：
 *   · 编译后检查 exe 体积**确实包含**载荷；
 *   · 运行时取不到会给出可读的失败信息（见 Setup.cs 的 LoadPayload）。
 *
 * 用法：node scripts/dev/build-installer.mjs
 */

import { execFileSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const INSTALLER_DIR = join(ROOT, 'installer')
const OUT_DIR = join(ROOT, 'dist')

/** 内嵌资源名 —— 必须与 Setup.cs 里 `GetManifestResourceStream("payload")` 一致。 */
const RESOURCE_NAME = 'payload'

const log = (m) => console.log(m)

/** 找 Windows 自带的 csc.exe（.NET Framework）。 */
function findCsc() {
  const windir = process.env.WINDIR ?? 'C:\\Windows'
  const candidates = [
    join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ]
  for (const c of candidates) if (existsSync(c)) return c
  return null
}

const csc = findCsc()
if (!csc) {
  log('✗ 找不到 csc.exe（.NET Framework 4.x）。')
  log('  它通常随 Windows 一起安装；缺失时请装 .NET Framework 4.x 后重试。')
  process.exit(1)
}
log(`编译器：${csc}`)

const setupExe = join(OUT_DIR, 'setup.exe')
const payloadZip = join(OUT_DIR, 'dsh-pet-ds-payload.zip')

let failed = 0
const check = (name, ok, detail) => {
  log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed += 1
}

// ---------------------------------------------------------------- 1) 前置
log('')
log('[1/3] 检查前提')
if (!existsSync(payloadZip)) {
  log(`✗ 找不到载荷：${payloadZip}`)
  log('  先跑：node scripts/dev/build-package.mjs')
  process.exit(1)
}
const payMb = statSync(payloadZip).size / 1024 / 1024
check('载荷存在', true, `${payMb.toFixed(2)} MB`)

const sources = [join(INSTALLER_DIR, 'Setup.cs'), join(INSTALLER_DIR, 'MiniZip.cs')]
for (const s of sources) {
  check(`源文件 ${s.split(/[\\/]/).pop()}`, existsSync(s))
}
if (failed > 0) {
  log('\n✗ 前提不满足，中止。')
  process.exit(1)
}

// ---------------------------------------------------------------- 2) 编译
log('')
log('[2/3] 编译 setup.exe')
/*
 * /target:winexe    —— GUI 程序（不弹控制台窗口）
 * /optimize+        —— 开优化
 * /platform:anycpu  —— 32/64 位 Windows 都能跑
 * /resource:...,name—— 把载荷内嵌成名为 `payload` 的资源（名要与 Setup.cs 一致）
 *
 * ⚠️ 不加 /win32icon：本仓库只有 svg 没有 .ico，而指定的图标文件不存在会让编译直接失败。
 */
const cscArgs = [
  '/nologo',
  '/target:winexe',
  '/optimize+',
  '/platform:anycpu',
  `/out:${setupExe}`,
  `/resource:${payloadZip},${RESOURCE_NAME}`,
  ...sources,
]

log(`  资源：${payloadZip.split(/[\\/]/).pop()} → 资源名 "${RESOURCE_NAME}"`)
const started = Date.now()
try {
  const out = execFileSync(csc, cscArgs, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  if (out.trim()) log(out.trim())
} catch (err) {
  log('✗ 编译失败：')
  log(String(err?.stdout ?? '').slice(-3000))
  log(String(err?.stderr ?? '').slice(-3000))
  process.exit(1)
}
log(`  ✓ 编译完成（耗时 ${((Date.now() - started) / 1000).toFixed(1)} 秒）`)

// ---------------------------------------------------------------- 3) 校验
log('')
log('[3/3] 校验产物')
const exeOk = existsSync(setupExe)
check('setup.exe 已生成', exeOk, exeOk ? `${(statSync(setupExe).size / 1024 / 1024).toFixed(2)} MB` : '')
if (exeOk) {
  /*
   * 关键断言：exe 必须**明显大于**载荷。
   *
   * 若资源名写错或忘了内嵌，csc 仍会成功产出一个几百 KB 的 exe ——
   * 那个 exe 能打开、界面正常，但一点"开始安装"就报"缺少载荷"。
   * 这种失败从界面上一眼看不出，所以必须在这里挡住。
   */
  const exeMb = statSync(setupExe).size / 1024 / 1024
  check(
    'exe 体积包含载荷（说明内嵌成功、资源名一致）',
    exeMb >= payMb * 0.98,
    `exe ${exeMb.toFixed(1)} MB ≥ 载荷 ${payMb.toFixed(1)} MB`,
  )
}

log('')
log(`结果：${failed === 0 ? '安装程序构建成功' : `${String(failed)} 项未通过`}`)
if (exeOk) log(`产物：${setupExe}`)
process.exitCode = failed === 0 ? 0 : 1
