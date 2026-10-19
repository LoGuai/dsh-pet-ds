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

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
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

/*
 * 更新日志出两种范围、各三种格式：
 *  · `V0.2.0-更新日志.*` —— 只有本版本（用户拿到包想确认"这版改了什么"）
 *  · `全部更新日志.*`     —— 从最初版本到现在（想回看历史）
 *
 * 为什么放进交付包：不该让人为了看日志去翻仓库。而抽出来的是**定稿**，
 * 不会随后续改动变形（`全部更新日志` 则反映构建当时的最新状态）。
 *
 * 三种格式各有用途：
 *  · `.md`   —— 仓库同款；
 *  · `.txt`  —— UTF-8 **带 BOM + CRLF**，记事本双击不乱码；
 *  · `.docx` —— Python 生成（缺 Python 时跳过，不阻塞出包）。
 */
const CHANGELOG_SRC = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')
const changelogLines = CHANGELOG_SRC.split(/\r?\n/)

/* ---- 1) 单版本 ---- */
const changelogPath = join(DIST, `${TAG}-更新日志.md`)
{
  const re = new RegExp(`^##\\s*\\[${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`)
  const start = changelogLines.findIndex((l) => re.test(l))
  if (start < 0) {
    console.log(`  ✗ CHANGELOG.md 里找不到 ## [${version}] 段落`)
    process.exit(1)
  }
  let end = changelogLines.findIndex((l, i) => i > start && /^##\s/.test(l))
  if (end < 0) end = changelogLines.length

  const body = changelogLines
    .slice(start + 1, end)
    .join('\n')
    .replace(/\n+---\s*$/, '')
    .trim()
    /*
     * 独立文件里 `#` 是标题，小节应从 `##` 起 —— 而源文件里它们挂在
     * `## [版本]` 下面是 `###`。统一降一级，避免导出的文档层级跳号。
     */
    .replace(/^### /gm, '## ')

  writeFileSync(
    changelogPath,
    [
      `# ${TAG} 更新日志`,
      '',
      `> 完整历史见同目录的 \`全部更新日志\`（md / txt / docx 各一份）。`,
      '',
      body,
      '',
    ].join('\n'),
    'utf8',
  )
  console.log(`  ✓ ${TAG}-更新日志.md`)
}

/* ---- 2) 全部历史 ---- */
const allPath = join(DIST, '全部更新日志.md')
{
  /*
   * 只保留**版本段**，从第一个 `## [` 开始。
   *
   * 文件开头那段是「记录约定」（给维护者看的写法规则），不是更新日志内容；
   * 把它塞进给用户看的文档只会让人以为在讲功能。抽掉它，换一句自解释的引言。
   */
  const firstVersion = changelogLines.findIndex((l) => /^##\s*\[/.test(l))
  if (firstVersion < 0) {
    console.log('  ✗ CHANGELOG.md 里没有任何版本段')
    process.exit(1)
  }
  const body = changelogLines
    .slice(firstVersion)
    .join('\n')
    .replace(/\n+---\s*$/, '')
    .trim()
    .replace(/^---\s*$/gm, '')
  writeFileSync(
    allPath,
    [
      '# 桌宠插件 · 全部更新日志',
      '',
      '> 按版本从新到旧汇总。每条一句话；展开的细节见各版本的 RELEASE-NOTES。',
      '',
      body,
      '',
    ].join('\n'),
    'utf8',
  )
  console.log('  ✓ 全部更新日志.md')
}

/* ---- 3) 两种范围各出 txt 与 docx ---- */
const python = findPython()
const variants = [
  { base: `${TAG}-更新日志`, md: changelogPath },
  { base: '全部更新日志', md: allPath },
]
for (const v of variants) {
  const txtPath = join(DIST, `${v.base}.txt`)
  const mdText = readFileSync(v.md, 'utf8').replace(/\r?\n/g, '\r\n')
  writeFileSync(txtPath, `\uFEFF${mdText}`, 'utf8')
  console.log(`  ✓ ${v.base}.txt`)

  const docxPath = join(DIST, `${v.base}.docx`)
  if (!python) {
    console.log(`  [!] 没找到 python，跳过 ${v.base}.docx`)
    continue
  }
  try {
    execFileSync(
      python,
      [join(ROOT, 'scripts', 'dev', 'export-changelog-docx.py'), v.md, docxPath],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
    console.log(`  ✓ ${v.base}.docx`)
  } catch (err) {
    console.log(`  [!] ${v.base}.docx 生成失败（跳过）：${String(err.stderr ?? err.message).split('\n')[0]}`)
  }
}

/**
 * 找一个能用的 Python（要带 python-docx）。
 *
 * 优先环境变量 `DSH_PET_PYTHON`，其次 DSH 运行时的自带 Python ——
 * 不猜系统里装了什么，避免拿到一个没有 python-docx 的解释器。
 */
function findPython() {
  const candidates = [
    process.env.DSH_PET_PYTHON,
    join(process.env.USERPROFILE ?? '', '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'),
  ].filter(Boolean)
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

const files = [
  [join(ROOT, 'install.cmd'), 'install.cmd'],
  [join(ROOT, 'install-pet.ps1'), 'install-pet.ps1'],
  [join(ROOT, 'scripts', 'register-profile.mjs'), 'register-profile.mjs'],
  [tgzPath, tgzName],
  [changelogPath, `${TAG}-更新日志.md`],
  [join(DIST, `${TAG}-更新日志.txt`), `${TAG}-更新日志.txt`],
  [allPath, '全部更新日志.md'],
  [join(DIST, '全部更新日志.txt'), '全部更新日志.txt'],
]
/* docx 可能因为缺 Python 没生成 —— 有就放进去，没有不报错。 */
for (const base of [`${TAG}-更新日志`, '全部更新日志']) {
  const p = join(DIST, `${base}.docx`)
  if (existsSync(p)) files.push([p, `${base}.docx`])
}
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
