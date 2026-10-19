/**
 * 验证"交付 zip"本身能装上 —— 解压 → 双击式 `cmd /c install.cmd` → 检查登记结果。
 *
 * ## 为什么值得单独一件事
 *
 * 平时的测试跑的是 `dist\桌宠插件-一键安装` **目录**。但用户拿到的是 **zip**，
 * 中间隔了一步解压：目录层级多一层、文件名可能被改、`Compress-Archive`
 * 可能漏掉空目录或改编码。这些都可能让"目录能装、zip 不能装"。
 *
 * 所以这里按用户的真实动作来：解压到沙箱 → `cmd /c install.cmd`（不带任何参数）。
 *
 * 用法：node scripts/dev/verify-release-zip.mjs dist/V0.2.0.zip
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')

const zipPath = resolve(process.argv[2] ?? join(ROOT, 'dist', 'V0.2.0.zip'))
if (!existsSync(zipPath)) {
  console.log(`  ✗ 找不到 zip：${zipPath}`)
  process.exit(1)
}

let failed = 0
const check = (name, ok, detail) => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed += 1
}

const sandbox = join(ROOT, '.cache', 'release-zip-check')
rmSync(sandbox, { recursive: true, force: true })
mkdirSync(sandbox, { recursive: true })

/* 解压（模拟用户右键解压） */
console.log(`  解压 ${zipPath.split(/[\\/]/).pop()} …`)
execFileSync('powershell.exe', [
  '-NoProfile',
  '-Command',
  `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${sandbox}' -Force`,
])

/* 找到解压出来的目录（zip 里只有一个顶层目录） */
const { readdirSync } = await import('node:fs')
const topDirs = readdirSync(sandbox, { withFileTypes: true }).filter((e) => e.isDirectory())
check('解压出一个顶层目录', topDirs.length === 1, topDirs.map((d) => d.name).join(', '))
const pkgDir = join(sandbox, topDirs[0]?.name ?? '')
check('目录名就是 V0.2.0', topDirs[0]?.name === 'V0.2.0', topDirs[0]?.name ?? '')

for (const f of ['install.cmd', 'install-pet.ps1', 'register-profile.mjs']) {
  check(`包里有 ${f}`, existsSync(join(pkgDir, f)))
}
const tgzs = readdirSync(pkgDir).filter((f) => /^dsh-pet-ds-.*\.tgz$/.test(f))
check('包里有包体 tgz（文件名能被安装脚本的 glob 找到）', tgzs.length === 1, tgzs.join(', '))

/* 交付包内附本版更新日志：用户拿到 zip 后不用再去仓库翻 CHANGELOG。 */
const logs = readdirSync(pkgDir).filter((f) => /^V.+更新日志\.md$/.test(f))
check('包里有本版更新日志', logs.length === 1, logs.join(', '))
if (logs.length === 1) {
  const logText = readFileSync(join(pkgDir, logs[0]), 'utf8')
  check(
    '更新日志里有「新增」与「修复」两节',
    logText.includes('## 新增') && logText.includes('## 修复'),
    `${String(logText.split(/\r?\n/).length)} 行`,
  )
}

/* 造一个沙箱 DSH 配置目录，让安装脚本往这里装 */
const home = join(sandbox, 'home')
const profileDir = join(home, 'profiles', 'desktop')
mkdirSync(profileDir, { recursive: true })
writeFileSync(
  join(profileDir, 'package.json'),
  JSON.stringify(
    {
      name: 'dsh-profile-desktop',
      private: true,
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
      dependencies: {},
    },
    null,
    2,
  ),
  'utf8',
)
/* 联接 dsh-runtimes，脚本才找得到 node/pnpm */
const realRuntimes = join(process.env.USERPROFILE ?? '', '.dsh', 'dsh-runtimes')
if (existsSync(realRuntimes)) {
  try {
    execFileSync('cmd', ['/c', 'mklink', '/J', join(home, 'dsh-runtimes'), realRuntimes], { stdio: 'ignore' })
  } catch {
    /* 已存在就算了 */
  }
}
/* 预置 electron，跳过下载 */
const electronDir = join(home, 'electron', 'electron-v38.2.0-win32-x64')
mkdirSync(electronDir, { recursive: true })
writeFileSync(join(electronDir, 'electron.exe'), 'stub', 'utf8')

/*
 * 双击式安装：`cmd /c install.cmd`（不带参数，靠 DSH_HOME 环境变量指路）。
 *
 * ⚠️ 不能把带空格的中文路径直接塞进 `cmd /c "..."`：Node 会把参数再包一层引号
 * 并转义，cmd 拿到的是字面量 `\"D:\...\install.cmd\"`，报
 * "is not recognized as an internal or external command"。
 * 所以写一个临时 .cmd 去 `call` 它 —— 这也更接近"双击"的真实情形。
 */
console.log('  模拟双击 install.cmd …')
const runner = join(sandbox, 'run-install.cmd')
writeFileSync(
  runner,
  [
    '@echo off',
    `set "DSH_HOME=${home}"`,
    `call "${join(pkgDir, 'install.cmd')}" < nul`,
    'exit /b %ERRORLEVEL%',
  ].join('\r\n'),
  'utf8',
)

let out = ''
try {
  out = execFileSync('cmd', ['/c', runner], {
    encoding: 'utf8',
    cwd: pkgDir,
    timeout: 600000,
  })
} catch (err) {
  out = String(err.stdout ?? '') + String(err.stderr ?? '')
}

const profile = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
check('bundles 已加入 dsh-pet-ds', (profile.dsh?.profile?.bundles ?? []).includes('dsh-pet-ds'), JSON.stringify(profile.dsh?.profile?.bundles))
check('dependencies 已指向包体', String(profile.dependencies?.['dsh-pet-ds'] ?? '').startsWith('file:'), String(profile.dependencies?.['dsh-pet-ds']))
check('原生 bundles 未被删掉', (profile.dsh?.profile?.bundles ?? []).includes('@deepseek-ai/dsh-base'))

const hostJs = join(profileDir, 'node_modules', 'dsh-pet-ds', 'src', 'host', 'index.js')
check('插件真的落到了 profile 里', existsSync(hostJs), hostJs)
check('装好的插件里有入口 src/host/index.js', existsSync(hostJs))
check('没有出现"解析不到"的错误', !/无法解析|not resolvable|ERR_MODULE_NOT_FOUND/i.test(out), out.split('\n').filter((l) => /✗|\[X\]/.test(l)).slice(0, 2).join(' | '))

/* 版本核对 */
let installedVersion = null
try {
  installedVersion = JSON.parse(readFileSync(join(profileDir, 'node_modules', 'dsh-pet-ds', 'package.json'), 'utf8')).version
} catch {
  installedVersion = null
}
check('装好的版本是 0.2.0', installedVersion === '0.2.0', String(installedVersion))

rmSync(sandbox, { recursive: true, force: true })
console.log('')
console.log(failed === 0 ? '结果：交付 zip 可正常安装' : `结果：${String(failed)} 项未通过`)
process.exit(failed === 0 ? 0 : 1)
