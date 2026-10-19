/**
 * 生成"一键安装包"，产物统一命名为 **V<版本>**。
 *
 * ## 产物
 *
 * | 文件 | 用途 |
 * |---|---|
 * | `dist/V0.2.0.zip` | 一键安装包：解压后双击 `install.cmd` |
 * | `dist/V0.2.0.exe` | 图形安装器（`setup.exe` 的副本，仅改名） |
 * | `dist/V0.2.0-测试版.exe` | 不请求提权的版本（自动化测试用） |
 *
 * 包内文件：
 *   install.cmd / install-pet.ps1 / register-profile.mjs / dsh-pet-ds-<版本>.tgz
 *
 * ## 为什么 tgz 不改名
 *
 * `install-pet.ps1` 用 glob `dsh-pet-ds-*.tgz` 找包体，DSH 的依赖规范也认这个包名。
 * 把 tgz 改成 `V0.2.0.tgz` 会让一键安装直接找不到包 —— 所以只有**交付包**改名，
 * 包体保持 `dsh-pet-ds-<版本>.tgz`。
 *
 * 前提：先跑过 `build-package.mjs`（产出 tgz）与 `build-installer.mjs`（产出 exe）。
 *
 * 用法：node scripts/dev/build-oneclick-zip.mjs
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const DIST = join(ROOT, 'dist')

const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
const TAG = `V${version}`

const tgzName = `dsh-pet-ds-${version}.tgz`
const tgzPath = join(DIST, tgzName)
if (!existsSync(tgzPath)) {
  console.log(`  ✗ 缺少包体：${tgzName}`)
  console.log('    先运行：node scripts/dev/build-package.mjs')
  process.exit(1)
}

const pkgDir = join(DIST, TAG)
rmSync(pkgDir, { recursive: true, force: true })
mkdirSync(pkgDir, { recursive: true })

const files = [
  [join(ROOT, 'install.cmd'), 'install.cmd'],
  [join(ROOT, 'install-pet.ps1'), 'install-pet.ps1'],
  [join(ROOT, 'scripts', 'register-profile.mjs'), 'register-profile.mjs'],
  [tgzPath, tgzName],
]
for (const [from, to] of files) {
  if (!existsSync(from)) {
    console.log(`  ✗ 缺少源文件：${from}`)
    process.exit(1)
  }
  copyFileSync(from, join(pkgDir, to))
}

console.log(`  ${TAG}/`)
for (const name of readdirSync(pkgDir)) {
  const size = statSync(join(pkgDir, name)).size
  console.log(`    ${name.padEnd(28)} ${(size / 1024).toFixed(1)} KB`)
}

/* 打包成 zip（用户拿到的是这个） */
const zipPath = join(DIST, `${TAG}.zip`)
rmSync(zipPath, { force: true })
execFileSync('powershell.exe', [
  '-NoProfile',
  '-Command',
  `Compress-Archive -LiteralPath '${pkgDir}' -DestinationPath '${zipPath}' -CompressionLevel Optimal`,
])
console.log(`  ✓ ${TAG}.zip — ${(statSync(zipPath).size / 1024 / 1024).toFixed(2)} MB`)

/* 图形安装器改名（内容完全一致，只是让用户一眼看出是哪个版本） */
const setup = join(DIST, 'setup.exe')
if (existsSync(setup)) {
  copyFileSync(setup, join(DIST, `${TAG}.exe`))
  console.log(`  ✓ ${TAG}.exe — ${(statSync(join(DIST, `${TAG}.exe`)).size / 1024 / 1024).toFixed(2)} MB（setup.exe 的副本）`)
}
const setupNo = join(DIST, 'setup-noelevate.exe')
if (existsSync(setupNo)) {
  copyFileSync(setupNo, join(DIST, `${TAG}-测试版.exe`))
  console.log(`  ✓ ${TAG}-测试版.exe — ${(statSync(join(DIST, `${TAG}-测试版.exe`)).size / 1024 / 1024).toFixed(2)} MB`)
}

console.log('')
console.log('  验证：node scripts/dev/verify-release-zip.mjs')
