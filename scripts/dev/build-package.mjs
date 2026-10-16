/**
 * 生成**两种可分发的产物**，并**验证内容完整性**：
 *
 *   1. `dist/dsh-pet-ds-<版本>.tgz`        —— `pnpm pack`，按 `files` 白名单，用于 `pnpm add`
 *   2. `dist/dsh-pet-ds-<版本>-source.zip` —— `git archive`，按版本库，
 *      与 GitHub Release 的 `Source code (zip)` **格式一致**
 *
 * ## 为什么打完包要逐项断言
 *
 * "包能不能装"取决于**里面有没有该有的东西**：
 *  · 少了 `cordis.patch.yml` → DSH 不认它是 bundle 插件，装上也看不见；
 *  · 少了 `client/` → 设置页那一栏不出现（而且不报错）；
 *  · 少了 `pet-app/` → 插件加载得了，但桌宠窗口起不来；
 *  · 少了动画素材 → 桌宠能起来但没画面。
 *
 * 这几种失败都**不会在打包时报错**，而是在用户那边表现为"装了没用"。
 * 所以这里打完逐项断言，把问题挡在发布之前。
 *
 * ⚠️ 教训来自可用的第三方插件（`Yoshino-JF/dsh-deepseek-pet` 的 v0.2.4 发布说明）：
 * 桌宠本体曾被 `.gitignore` 排除，于是从 GitHub 源码安装时缺了它 ——
 * 插件能激活、健康检查回 200，但**桌宠不会出现**。
 * **仓库里必须包含运行所需的一切**，源码归档才自足。本仓库的素材
 * （116 个文件 / 112MB）就是**提交进版本库**的，正是为了这一点。
 *
 * ## 两种产物的差别
 *
 * | 产物 | 选取规则 | 用途 |
 * |---|---|---|
 * | `.tgz` | `package.json` 的 `files` 白名单 | `pnpm add` / 插件市场 |
 * | `-source.zip` | git 版本库（`git archive`） | 上传为 Source code / 手动安装 |
 *
 * 改 `files` 字段时要记得两边都验一遍。
 *
 * 运行：node scripts/dev/build-package.mjs
 *      （两个产物总是都生成 —— 发布时要一起核对，分开跑容易漏掉一边）
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
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
/*
 * agent 安装入口与它的说明**必须进包** —— 这份包的一个明确用途就是
 * "由 agent 自行安装"，缺了它们 agent 就没有可直接执行的入口。
 */
check('含 agent 安装入口 install.mjs', has('install.mjs'))
check('含 agent 安装说明 INSTALL-AGENT.md', has('INSTALL-AGENT.md'))
check('含解析链验证脚本 probe-import-resolution.mjs', has('scripts/dev/probe-import-resolution.mjs'))
check('含 README.md', has('README.md'))
check('含 LICENSE', has('LICENSE'))
check('含 LICENSE-ART.md（美术素材单独授权）', has('LICENSE-ART.md'))
check('含 RELEASE.md（发布流程）', has('RELEASE.md'))
check('含本版本发布说明 RELEASE-NOTES-*.md', entries.some((e) => /^RELEASE-NOTES-v.*\.md$/.test(e)))
check('含安装器 scripts/install.mjs', has('scripts/install.mjs'))

// 产物文件名里带版本号 —— 与 package.json 对不上会让人拿错包。
{
  const pkgJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  check(
    '产物文件名含 package.json 的版本号',
    tarball.includes(`-${pkgJson.version}.tgz`),
    `version=${pkgJson.version}`,
  )
}

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

// ---------------------------------------------------------------- 源码 zip
/*
 * `git archive` 导出**版本库**里的内容 —— 与 GitHub Release 页面那个
 * `Source code (zip)` **格式一致**（GitHub 也是用同一机制生成的）。
 *
 * 为什么还要自己生成一份：GitHub 打 tag 后会自动给，但
 *  · 本地要先核对归档内容（尤其"素材是不是真的进版本库了"）；
 *  · 有些环境不走 GitHub，需要直接分发源码归档。
 *
 * ⚠️ 只含**被跟踪**的文件，所以 `node_modules` / `.cache` / `dist` / `_research`
 * 天然不会进去；而 `assets/animations` 是提交进版本库的，**会**进去 ——
 * 这正是"源码归档必须自足"那条教训的要求。
 */
const wantSourceZip = true // 两个产物总是都出：发布时要一起核对，分开跑容易漏掉一边
console.log('\n生成源码归档（git archive，与 GitHub 的 Source code 格式一致）…')

let sourceZip = null
{
  const pkgJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const name = pkgJson.name
  const version = pkgJson.version
  /* 顶层目录名与 GitHub 的归档习惯一致：`<包名>-<版本>/`。 */
  const prefix = `${name}-${version}/`
  const out = join(OUT_DIR, `${name}-${version}-source.zip`)

  try {
    /*
     * 指定 tag 时优先用 tag（发布对象就是它）；
     * 没有该 tag 就退回 HEAD（本地核对用）。
     */
    const tag = `v${version}`
    let treeish = tag
    try {
      execFileSync('git', ['rev-parse', '--verify', `refs/tags/${tag}`], { cwd: ROOT, stdio: 'ignore' })
    } catch {
      treeish = 'HEAD'
      check(`存在标签 ${tag}`, false, `没找到，退回 HEAD 导出（发布前请先打标签）`)
    }
    execFileSync('git', ['archive', '--format=zip', `--prefix=${prefix}`, '-o', out, treeish], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    sourceZip = existsSync(out) ? out : null
  } catch (err) {
    check('git archive 生成源码 zip', false, err instanceof Error ? err.message : String(err))
  }

  if (sourceZip) {
    const mb = (statSync(sourceZip).size / 1024 / 1024).toFixed(2)
    check('git archive 生成源码 zip', true, `${out} (${mb} MB)`)

    // 列条目并做**同一套**内容断言 —— 源码归档也必须自足。
    let zipEntries = []
    try {
      const listing = execFileSync('tar', ['-tf', sourceZip], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      zipEntries = String(listing)
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => s.replace(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), ''))
    } catch (err) {
      check('能读出源码 zip 内容', false, err instanceof Error ? err.message : String(err))
    }

    if (zipEntries.length > 0) {
      const zHas = (rel) => zipEntries.some((e) => e === rel || e.startsWith(rel + '/'))
      const zCount = (p) => zipEntries.filter((e) => e.startsWith(p + '/')).length
      console.log(`  （源码归档共 ${zipEntries.length} 个条目）`)
      check('源码 zip 含 package.json', zHas('package.json'))
      check('源码 zip 含 cordis.patch.yml', zHas('cordis.patch.yml'))
      check('源码 zip 含 install.mjs（agent 安装入口）', zHas('install.mjs'))
      check('源码 zip 含 INSTALL-AGENT.md', zHas('INSTALL-AGENT.md'))
      check('源码 zip 含 LICENSE-ART.md', zHas('LICENSE-ART.md'))
      check('源码 zip 含 RELEASE-NOTES-*.md', zipEntries.some((e) => /^RELEASE-NOTES-v.*\.md$/.test(e)))
      check('源码 zip 含宿主与客户端', zHas('src/host/index.js') && zHas('client/client.js'))
      check('源码 zip 含桌宠应用', zCount('pet-app') > 0, `${zCount('pet-app')} 个文件`)

      /*
       * ⚠️ 这一条是**发布质量的关键**：素材必须进版本库。
       * 参考项目的 v0.2.4 就是栽在这里 —— 桌宠本体被 .gitignore 排除，
       * 于是从源码安装时"插件能激活但桌宠不出现"。
       */
      const zAnim = zipEntries.filter((e) => e.startsWith('assets/animations/'))
      const zActions = new Set(zAnim.map((e) => e.split('/')[2]).filter((s) => s && !s.includes('.')))
      check(
        '源码 zip 含动画素材（否则装了没画面）',
        zActions.size > 0,
        `${zActions.size} 个动作，${zAnim.length} 个文件`,
      )
      check('源码 zip 不含 node_modules/', !zHas('node_modules'))
      check('源码 zip 不含 dist/', !zHas('dist'))
      check('源码 zip 不含 .cache/', !zHas('.cache'))
    }
  }
}

console.log(`\n结果：${failed === 0 ? '内容校验全部通过' : failed + ' 项未通过'}`)
console.log(`产物：`)
console.log(`  ${tarball}   ← pnpm 安装包`)
if (sourceZip) console.log(`  ${sourceZip}   ← 源码归档（可作 Source code 上传）`)
process.exitCode = failed === 0 ? 0 : 1
