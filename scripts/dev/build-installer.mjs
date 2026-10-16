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
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { manifestExecutionLevel, readEmbeddedManifest } from './pe-manifest.mjs'

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

/**
 * 找 Windows SDK 的 `mt.exe`（Manifest Tool）。
 *
 * 用途：把 `installer/setup.manifest` 嵌进 exe，让程序**启动时就要求管理员权限**。
 *
 * ## 为什么必须嵌清单
 *
 * `csc` 默认嵌的清单是 `requestedExecutionLevel level="asInvoker"` ——
 * **不请求提升**。于是安装程序以普通用户权限运行，遇到需要管理员权限的
 * 写入位置就会失败（用户实测："没有权限进行安装访问"）。
 *
 * ## 找不到 mt.exe 的情况
 *
 * Windows SDK 不是每台机器都装。找不到时**不静默跳过**：打印警告，
 * 并说明程序内置了"运行时自我提升"作为兜底（见 Setup.cs 的 EnsureElevated）
 * —— 那条路也能提升，只是会闪两个窗口、体验差一些。
 */
function findMt() {
  const roots = [
    'C:\\Program Files (x86)\\Windows Kits\\10\\bin',
    'C:\\Program Files\\Windows Kits\\10\\bin',
  ]
  for (const root of roots) {
    if (!existsSync(root)) continue
    /* 版本目录名形如 10.0.26100.0，挑字典序最大的（= 最新）。 */
    const versions = readdirSync(root)
      .filter((d) => /^\d+\.\d+\.\d+\.\d+$/.test(d))
      .sort()
      .reverse()
    for (const v of versions) {
      for (const arch of ['x64', 'x86']) {
        const p = join(root, v, arch, 'mt.exe')
        if (existsSync(p)) return p
      }
    }
  }
  return null
}

const csc = findCsc()
if (!csc) {
  log('✗ 找不到 csc.exe（.NET Framework 4.x）。')
  log('  它通常随 Windows 一起安装；缺失时请装 .NET Framework 4.x 后重试。')
  process.exit(1)
}
log(`编译器：${csc}`)

const mt = findMt()
log(mt ? `清单工具（备用）：${mt}` : '清单工具（备用）：未找到')

const manifestFile = join(INSTALLER_DIR, 'setup.manifest')

const setupExe = join(OUT_DIR, 'setup.exe')
const payloadZip = join(OUT_DIR, 'dsh-pet-ds-payload.zip')

/*
 * 是否**额外**产出不请求提升的测试版 `dist/setup-noelevate.exe`。
 *
 * 为什么需要它：正式版带 `requireAdministrator`，Windows 会在**加载 exe 之前**
 * 就弹 UAC —— 自动化测试跑几次就弹几次，不可接受。测试版用 `asInvoker`，
 * 安装逻辑与正式版完全相同，只是不求提权。
 *
 * **默认就产出**（而不是要求开发者记得设环境变量）：`npm test` 里的
 * test-setup-extract 需要它，忘了生成就会得到一个看起来像"安装器坏了"的
 * 失败。设 `DSH_PET_SETUP_NO_TEST_BUILD=1` 可跳过（省几秒编译）。
 *
 * 它**绝不覆盖** `dist/setup.exe`。
 */
const skipTestBuild = process.env.DSH_PET_SETUP_NO_TEST_BUILD === '1'
const wantTestBuild = !skipTestBuild
const setupTestExe = join(OUT_DIR, 'setup-noelevate.exe')

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

/**
 * 编译一个 setup exe。
 *
 * @param {string} outExe   输出路径
 * @param {boolean} elevate 是否请求管理员权限（加 `/win32manifest:`）
 */
function compile(outExe, elevate) {
  /*
   * /target:winexe    —— GUI 程序（不弹控制台窗口）
   * /optimize+        —— 开优化
   * /platform:anycpu  —— 32/64 位 Windows 都能跑
   * /resource:...,name—— 把载荷内嵌成名为 `payload` 的资源（名要与 Setup.cs 一致）
   * /win32manifest:   —— 请求管理员权限的清单
   *
   * ⚠️ 不加 /win32icon：本仓库只有 svg 没有 .ico，而指定的图标文件不存在会让编译直接失败。
   */
  const args = [
    '/nologo',
    '/target:winexe',
    '/optimize+',
    '/platform:anycpu',
    `/out:${outExe}`,
    `/resource:${payloadZip},${RESOURCE_NAME}`,
  ]

  /*
   * 用 csc 的 `/win32manifest:` 把清单**直接编进去** —— 比事后用 mt.exe 嵌省一步，
   * 也不依赖 Windows SDK。清单的作用见 installer/setup.manifest 的注释：
   * 让程序**启动时就要求管理员权限**。
   *
   * 不加它的话 csc 会嵌一个 `asInvoker`（不提升）的默认清单，安装到
   * `C:\Program Files` 这类位置会在**解压到一半**才失败（报错晚且难懂）。
   */
  if (elevate) {
    if (existsSync(manifestFile)) {
      args.push(`/win32manifest:${manifestFile}`)
    } else {
      log('  ⚠ 找不到 setup.manifest —— 将以内置的默认清单（不提升）编译。')
      log('    安装到需要管理员权限的位置时会失败；用户得手动"以管理员身份运行"。')
    }
  }
  args.push(...sources)

  try {
    const out = execFileSync(csc, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    if (out.trim()) log(out.trim())
  } catch (err) {
    log('✗ 编译失败：')
    log(String(err?.stdout ?? '').slice(-3000))
    log(String(err?.stderr ?? '').slice(-3000))
    process.exit(1)
  }
}

const started = Date.now()
log(`  资源：${payloadZip.split(/[\\/]/).pop()} → 资源名 "${RESOURCE_NAME}"`)
log(`  清单：${existsSync(manifestFile) ? '请求管理员权限（requireAdministrator）' : '（缺失）'}`)
compile(setupExe, true)
log(`  ✓ 正式版编译完成（耗时 ${((Date.now() - started) / 1000).toFixed(1)} 秒）`)

/*
 * 可选：额外编一个**不请求提升**的版本给自动化测试用。
 *
 * 为什么：正式版带 `requireAdministrator`，Windows 在**加载 exe 之前**就弹 UAC，
 * 测试跑几次就弹几次。测试版用 `asInvoker`，安装逻辑完全相同、只是不求提权。
 * 它**不会覆盖** `dist/setup.exe`。
 */
if (wantTestBuild) {
  compile(setupTestExe, false)
  log(`  ✓ 测试版编译完成：${setupTestExe.split(/[\\/]/).pop()}（asInvoker，供自动化测试）`)
}

// ---------------------------------------------------------------- 3) 校验
log('')
log('[3/3] 校验产物')
/**
 * 校验一个产物的载荷体积与清单权限级别。
 *
 * @param {string} exe        产物路径
 * @param {string} expected   期望的 `requestedExecutionLevel` 级别
 * @param {string} label      打印用的名字
 */
function verify(exe, expected, label) {
  const ok = existsSync(exe)
  check(`${label} 已生成`, ok, ok ? `${(statSync(exe).size / 1024 / 1024).toFixed(2)} MB` : '')
  if (!ok) return

  /*
   * 关键断言：exe 必须**明显大于**载荷。
   *
   * 若资源名写错或忘了内嵌，csc 仍会成功产出一个几百 KB 的 exe ——
   * 那个 exe 能打开、界面正常，但一点"开始安装"就报"缺少载荷"。
   * 这种失败从界面上一眼看不出，所以必须在这里挡住。
   */
  const exeMb = statSync(exe).size / 1024 / 1024
  check(
    `${label} 体积包含载荷（内嵌成功、资源名一致）`,
    exeMb >= payMb * 0.98,
    `${exeMb.toFixed(1)} MB ≥ 载荷 ${payMb.toFixed(1)} MB`,
  )

  /*
   * 关键断言：清单里真的写进了期望的权限级别。
   *
   * 这条挡住"清单没编进去"这种**静默失败**：csc 会照样产出能用的 exe，
   * 只是清单是默认的 `asInvoker` —— 于是安装到需要管理员权限的位置时
   * 会在**解压到一半**才失败，而不是启动时就弹 UAC。
   *
   * ⚠️ 必须**按 PE 资源的方式**去读，不能把 exe 当文本搜。第一版就是那么写的，
   * 结果误判：真正的清单资源是 UTF-16（UTF-8 搜不到），而 csc 又把清单源的
   * XML 文本也存进 exe，于是本脚本注释里的 `asInvoker` 被当成清单内容、
   * 两种都命中，断言必然失败。详见 pe-manifest.mjs 的说明。
   */
  const level = manifestExecutionLevel(readEmbeddedManifest(exe))
  check(
    `${label} 清单级别 = ${expected}`,
    level === expected,
    level == null ? 'PE 资源里读不到应用清单 —— manifest 没编进去' : `实际 "${level}"`,
  )
}

verify(setupExe, 'requireAdministrator', 'setup.exe（正式版）')
if (wantTestBuild) verify(setupTestExe, 'asInvoker', 'setup-noelevate.exe（测试版）')

log('')
log(`结果：${failed === 0 ? '安装程序构建成功' : `${String(failed)} 项未通过`}`)
log(`产物：${setupExe}`)
if (wantTestBuild) log(`      ${setupTestExe}（测试用，勿发布）`)
process.exitCode = failed === 0 ? 0 : 1
