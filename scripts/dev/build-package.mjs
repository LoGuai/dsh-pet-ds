/**
 * 生成**可分发的安装包**（`.tgz`），并**验证包内容完整性**。
 *
 * ## 为什么要单独一个脚本
 *
 * `pnpm pack` 一条命令就能出包，但"包能不能装"取决于**里面有没有该有的东西**：
 *  · 少了 `cordis.patch.yml` → DSH 不认它是 bundle 插件，装上也看不见；
 *  · 少了 `client/` → 设置页那一栏不出现（而且不报错）；
 *  · 少了 `pet-app/` → 插件加载得了，但桌宠窗口起不来；
 *  · 少了动画素材 → 桌宠能起来但没画面。
 *
 * 这几种失败都**不会在打包时报错**，而是在用户那边表现为"装了没用"。
 * 所以这里打完包**逐项断言**，把问题挡在发布之前。
 *
 * ## 包会很大（约 112MB），主体是动画素材
 *
 * 素材不在版本库里（授权仅限作者本人），但**必须进安装包** ——
 * 否则用户装了看不到桌宠。仓库与安装包的区别就在这里：
 *  · 仓库：源码 + 文档（约 1MB）；
 *  · 安装包：源码 + 文档 + **全部素材**（约 112MB）。
 *
 * 产物写到 `dist/`（已 gitignore）。
 *
 * 运行：node scripts/dev/build-package.mjs
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const OUT_DIR = join(ROOT, 'dist')

let failed = 0
function check(name, ok, detail) {
  if (ok) {
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    failed += 1
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// ---------------------------------------------------------------- 找 pnpm
/**
 * 优先用 DSH 自带的 pnpm（版本与 DSH 一致，少一类环境差异）。
 * 找不到就回落到 PATH 上的 `pnpm`。
 */
function findPnpm() {
  const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
  const runtimeRoot = join(dshHome, 'dsh-runtimes')
  if (existsSync(runtimeRoot)) {
    const exe = process.platform === 'win32' ? 'node.exe' : 'node'
    for (const rt of readdirSync(runtimeRoot, { withFileTypes: true })) {
      if (!rt.isDirectory()) continue
      const deps = join(runtimeRoot, rt.name, 'dependencies')
      const node = join(deps, 'node', 'bin', exe)
      const script = join(deps, 'pnpm', 'bin', 'pnpm.mjs')
      if (existsSync(node) && existsSync(script)) return { cmd: node, args: [script], label: `DSH 自带（${rt.name}）` }
    }
  }
  return { cmd: 'pnpm', args: [], label: 'PATH 上的 pnpm' }
}

// ---------------------------------------------------------------- 打包
console.log('生成安装包…')
rmSync(OUT_DIR, { recursive: true, force: true })
mkdirSync(OUT_DIR, { recursive: true })

const pnpm = findPnpm()
console.log(`  使用 ${pnpm.label}`)

let tarball = null
try {
  const out = execFileSync(pnpm.cmd, [...pnpm.args, 'pack', '--pack-destination', OUT_DIR], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  })
  // `pnpm pack` 最后一行是产物绝对路径。
  const lines = String(out).trim().split(/\r?\n/).filter(Boolean)
  tarball = lines[lines.length - 1].trim()
  if (!existsSync(tarball)) tarball = null
} catch (err) {
  console.log('  ✗ pnpm pack 失败')
  console.log('    ' + String(err?.stdout ?? '').slice(-1200))
  console.log('    ' + String(err?.stderr ?? '').slice(-1200))
  process.exit(1)
}

check('pnpm pack 产出 tgz', Boolean(tarball), tarball ?? '找不到产物')
if (!tarball) process.exit(1)

const sizeMb = (statSync(tarball).size / 1024 / 1024).toFixed(2)
console.log(`\n产物：${tarball}  (${sizeMb} MB)`)

// ---------------------------------------------------------------- 校验包内容
console.log('\n校验包内容（用 tar -tzf 列出条目）：')
let entries = []
try {
  const listing = execFileSync('tar', ['-tzf', tarball], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  entries = String(listing)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    // npm 包的路径形如 `package/xxx`
    .map((s) => s.replace(/^package\//, ''))
} catch (err) {
  check('能读出包内容', false, err instanceof Error ? err.message : String(err))
}

const has = (rel) => entries.some((e) => e === rel || e.startsWith(rel + '/'))
const countUnder = (prefix) => entries.filter((e) => e.startsWith(prefix + '/')).length

check('含 package.json', has('package.json'))
check('含 cordis.patch.yml（DSH 靠它识别为 bundle 插件）', has('cordis.patch.yml'))
check('含宿主入口 src/host/index.js', has('src/host/index.js'))
check('含配置 schema src/host/config-schema.js', has('src/host/config-schema.js'))
check('含客户端 client/client.js（设置页那一栏靠它）', has('client/client.js'))
check('含桌宠应用 pet-app/', countUnder('pet-app') > 0, `${countUnder('pet-app')} 个文件`)
check('含安装指引 INSTALL.md', has('INSTALL.md'))
check('含 README.md', has('README.md'))
check('含 LICENSE', has('LICENSE'))
check('含安装器 scripts/install.mjs', has('scripts/install.mjs'))

// 动画素材：每个动作一个子目录，含 manifest.json
const animEntries = entries.filter((e) => e.startsWith('assets/animations/'))
const animActions = new Set(
  animEntries.map((e) => e.split('/')[2]).filter((s) => s && !s.includes('.')),
)
const animManifests = animEntries.filter((e) => e.endsWith('manifest.json')).length
check('含动画素材（安装包的主体）', animActions.size > 0, `${animActions.size} 个动作，${animEntries.length} 个文件`)
check('每个动作都有 manifest.json', animManifests === animActions.size, `${animManifests} 个 manifest / ${animActions.size} 个动作`)

/*
 * ⚠️ 不该进包的东西。这些一旦混进去，包会白白变大或泄露本机信息。
 */
check('不含 .cache/', !has('.cache'))
check('不含 _research/', !has('_research'))
check('不含 .git/', !has('.git'))
check('不含 node_modules/', !has('node_modules'))
check('不含 dist/', !has('dist'))

// ---------------------------------------------------------------- 汇总
console.log('\n包内文件数：' + entries.length)
if (animActions.size > 0) {
  console.log('动画动作：' + [...animActions].sort().join(', '))
}

console.log(`\n结果：${failed === 0 ? '包内容校验全部通过' : failed + ' 项未通过'}`)
console.log(`产物：${tarball}`)
process.exitCode = failed === 0 ? 0 : 1
