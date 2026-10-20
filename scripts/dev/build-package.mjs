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
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
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
/*
 * ⚠️ 这一行会**清空整个 `dist/`**，包括 `build-installer.mjs` 产出的
 * `setup.exe` / `setup-noelevate.exe`。
 *
 * 所以发布顺序必须是：
 *   1. `node scripts/dev/build-package.mjs`   （tgz + 载荷 + 源码归档）
 *   2. `node scripts/dev/build-installer.mjs` （把载荷嵌进 exe）
 *
 * 反过来跑（或先 build-installer 再 build-package）会得到一个"看起来构建成功、
 * 但 dist 里没有 exe"的结果 —— 实测踩过：build-installer 打印了
 * "已生成 145.93 MB"，紧接着跑 build-package 就把它们删了。
 */
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

// ---------------------------------------------------------------- 安装程序载荷
/*
 * setup.exe 内嵌用的载荷。
 *
 * 为什么不直接内嵌上面那个 `.tgz`：`.tgz` **不含 `node_modules`**，
 * 安装后要靠 pnpm 现装依赖（需要网络、也需要目标机有 pnpm）。
 * 而安装程序的目标是"装完即可用" —— 所以载荷要**自带依赖树**。
 *
 * 载荷 = `.tgz` 解包 + `pnpm install --prod` 补上 node_modules，再压成 zip
 * （安装程序用 .NET 的 `System.IO.Compression` 解，必须是 zip 格式；`.tgz`
 *  是 gzip+tar，.NET 解起来要自己写 tar 解析，不如直接给 zip）。
 */
const PAYLOAD_NAME = 'dsh-pet-ds-payload.zip'
console.log('\n生成安装程序载荷（含依赖树，供 setup.exe 内嵌）…')
{
  /*
   * ⚠️⚠️ 暂存目录**必须放在仓库之外**（这里用系统临时目录）。
   *
   * 踩过的坑：一开始把暂存目录放在 `dist/.payload-staging`（仓库内），
   * 结果 `pnpm install` 输出 "Already up to date"、暂存目录里**没有**
   * node_modules —— 而仓库根却有了。
   *
   * 原因：仓库根有 `pnpm-workspace.yaml`（`packages: - .`），
   * pnpm 会**向上寻找工作区根**，于是把这次安装归到仓库根去做了。
   * 放进系统临时目录就与工作区无关了。
   */
  const os = await import('node:os')
  const staging = join(os.tmpdir(), `dsh-pet-payload-${String(Date.now())}`)
  const inner = join(staging, 'package')
  const zipPath = join(OUT_DIR, PAYLOAD_NAME)
  try {
    rmSync(staging, { recursive: true, force: true })
    mkdirSync(staging, { recursive: true })

    // 1) 解出 .tgz 里的 package/ 内容
    execFileSync('tar', ['-xzf', tarball, '-C', staging], { stdio: ['ignore', 'pipe', 'pipe'] })
    check('载荷：.tgz 解包成功', existsSync(join(inner, 'package.json')))

    // 2) 在暂存目录里装生产依赖
    /*
     * `--prod` 只跳过 devDependencies，**peerDependencies 仍会装**
     * （这是需要的：`@deepseek-ai/cordis` 与 `dsh-tools` 是 peer，
     *  但桌宠侧要能解析到它们）。
     *
     * ⚠️⚠️ 必须用 `--config.node-linker=hoisted`（不能用 pnpm 默认的隔离布局）。
     *
     * 原因（实测踩到，很隐蔽）：pnpm 默认把每个包放进 `.pnpm/<名字>@<版本>/`
     * 再在 `node_modules/<包名>` 建**联接**指过去。而
     * `Compress-Archive`（以及绝大多数 zip 工具）**不保留联接** ——
     * 于是解压出来的包里 `node_modules/@deepseek-ai/` **是个空目录**，
     * `@deepseek-ai/schemastery` 在 `node_modules` 顶层找不到。
     *
     * 那会让装完的插件在 DSH 里报 `failed to import`（正是本项目踩过的坑），
     * 而解压自检会全部通过（因为我们只查了关键文件，没查链接）。
     *
     * `hoisted` 让 pnpm 把依赖摊平成**真实目录**，零链接，zip 往返无损。
     */
    try {
      execFileSync(
        pnpm.cmd,
        [...pnpm.args, 'install', '--prod', '--ignore-scripts', '--config.node-linker=hoisted'],
        {
          cwd: inner,
          stdio: ['ignore', 'pipe', 'pipe'],
          maxBuffer: 32 * 1024 * 1024,
        },
      )
    } catch (err) {
      const out = `${String(err?.stdout ?? '')}${String(err?.stderr ?? '')}`
      throw new Error(`pnpm install 失败：${out.trim().split(/\r?\n/).slice(-6).join(' | ').slice(0, 400)}`)
    }
    check('载荷：依赖安装成功', existsSync(join(inner, 'node_modules')))

    /*
     * 关键断言：载荷里**不能有任何链接**。
     *
     * 因为载荷要经过 zip 往返，而 zip 不保留链接 —— 有链接就会变成
     * "解压后目录存在但内容不在"的隐蔽故障（见上面 node-linker 的说明）。
     * 这条断言把那个故障挡在构建期。
     */
    {
      const links = []
      const walk = (dir) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const p = join(dir, e.name)
          try {
            if (lstatSync(p).isSymbolicLink()) {
              links.push(relative(inner, p).replace(/\\/g, '/'))
              continue
            }
          } catch {
            continue
          }
          if (e.isDirectory()) walk(p)
        }
      }
      walk(inner)
      check(
        '载荷：不含任何链接（zip 不保留链接，有链接会导致解压后依赖丢失）',
        links.length === 0,
        links.length === 0 ? '' : `发现 ${String(links.length)} 个，例如 ${links.slice(0, 3).join(', ')}`,
      )
    }

    // 3) 压成 zip
    rmSync(zipPath, { force: true })
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `Compress-Archive -Path '${inner.replace(/'/g, "''")}\\*' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    check(
      '载荷生成成功',
      existsSync(zipPath),
      `${PAYLOAD_NAME} (${(statSync(zipPath).size / 1024 / 1024).toFixed(2)} MB)`,
    )
  } catch (err) {
    check('载荷生成成功', false, err instanceof Error ? err.message.slice(0, 300) : String(err))
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

check('含 package.json', has('package.json'))
check('含 cordis.patch.yml（DSH 靠它识别为 bundle 插件）', has('cordis.patch.yml'))
check('含宿主入口 src/host/index.js', has('src/host/index.js'))
check('含配置 schema src/host/config-schema.js', has('src/host/config-schema.js'))
check('含客户端 client/client.js（设置页那一栏靠它）', has('client/client.js'))
check('含手动安装指引 docs/INSTALL-MANUAL.md', has('docs/INSTALL-MANUAL.md'))
check('含桌宠应用 pet-app/', countUnder('pet-app') > 0, `${countUnder('pet-app')} 个文件`)
check('含安装指引 INSTALL.md', has('INSTALL.md'))
/*
 * agent 安装入口与它的说明**必须进包** —— 这份包的一个明确用途就是
 * "由 agent 自行安装"，缺了它们 agent 就没有可直接执行的入口。
 */
check('含 agent 安装入口 install.mjs', has('install.mjs'))
check('含 agent 安装说明 docs/INSTALL-AGENT.md', has('docs/INSTALL-AGENT.md'))
check('含解析链验证脚本 probe-import-resolution.mjs', has('scripts/dev/probe-import-resolution.mjs'))
/*
 * `install_bundle` 契约的两个脚本也要进包：
 *  · `verify-install-bundle.mjs` 让使用者**自证**这个包能被官方命令装；
 *  · `test-install-bundle-spec.mjs` 钉住 DSH 的 spec 判据（离线可跑）。
 */
check('含 install_bundle 验证脚本 verify-install-bundle.mjs', has('scripts/dev/verify-install-bundle.mjs'))
check('含 spec 契约测试 test-install-bundle-spec.mjs', has('scripts/dev/test-install-bundle-spec.mjs'))
check('含 README.md', has('README.md'))
check('含 LICENSE', has('LICENSE'))
check('含 LICENSE-ART.md（美术素材单独授权）', has('LICENSE-ART.md'))
check('含 docs/RELEASE.md（发布流程）', has('docs/RELEASE.md'))
check('含历史发布说明 docs/RELEASE-NOTES-*.md', entries.some((e) => /^docs\/RELEASE-NOTES-v.*\.md$/.test(e)))
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
     * 指定 tag 时优先用 tag（发布对象就是它）；没有该 tag 就退回 HEAD。
     *
     * ⚠️ 要试**两种**写法：本仓库用过 `v0.1.3fix`（无连字符，按用户指定）
     * 而版本号是 `0.1.3-fix`（合法 semver）。只按版本号拼 tag 会找不到
     * —— 实测踩过，会退化成"用 HEAD 导出"，而 HEAD 可能领先于 tag。
     */
    const candidates = [`v${version}`, `v${version.replace(/-/g, '')}`]
    let treeish = 'HEAD'
    let usedTag = null
    for (const tag of candidates) {
      try {
        execFileSync('git', ['rev-parse', '--verify', `refs/tags/${tag}`], { cwd: ROOT, stdio: 'ignore' })
        treeish = tag
        usedTag = tag
        break
      } catch {
        // 试下一个
      }
    }
    if (usedTag === null) {
      check(
        `存在标签 ${candidates.join(' 或 ')}`,
        false,
        '都没找到，退回 HEAD 导出（发布前请先打标签）',
      )
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
      check('源码 zip 含 docs/INSTALL-AGENT.md', zHas('docs/INSTALL-AGENT.md'))
      check('源码 zip 含 LICENSE-ART.md', zHas('LICENSE-ART.md'))
      check('源码 zip 含 docs/RELEASE-NOTES-*.md', zipEntries.some((e) => /^docs\/RELEASE-NOTES-v.*\.md$/.test(e)))
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

/*
 * 额外产出固定文件名的安装包，专门当 **GitHub Release 附件**。
 *
 * 为什么固定名：安装 URL 想写死成
 *   https://github.com/liuguanyu9719-source/dsh-pet-ds/releases/latest/download/dsh-pet-ds.tgz
 * 就必须每次都上传同名附件；带版本号的文件名做不到"永远指向最新"。
 *
 * 为什么需要附件而不是 git 地址：git 地址会被 pnpm 当 git 依赖，克隆整份仓库
 * （本仓库历史约 300MB）；附件是单个 tarball，只下一次（约 33MB）。
 */
{
  const releaseDir = join(OUT_DIR, 'release')
  mkdirSync(releaseDir, { recursive: true })
  copyFileSync(tarball, join(releaseDir, 'dsh-pet-ds.tgz'))
  console.log(`  ${join(releaseDir, 'dsh-pet-ds.tgz')}   ← Release 附件（固定名）`)
  const pkgVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
  console.log(`\n从 GitHub URL 安装（把其中一行交给 install_bundle）：`)
  console.log(`  锁定版本（tag 快照）  https://github.com/liuguanyu9719-source/dsh-pet-ds/archive/refs/tags/v${pkgVersion}.tar.gz`)
  console.log(`  永远最新（Release 附件） https://github.com/liuguanyu9719-source/dsh-pet-ds/releases/latest/download/dsh-pet-ds.tgz`)
}

console.log(`\n结果：${failed === 0 ? '内容校验全部通过' : failed + ' 项未通过'}`)
console.log(`产物：`)
console.log(`  ${tarball}   ← pnpm 安装包`)
if (sourceZip) console.log(`  ${sourceZip}   ← 源码归档（可作 Source code 上传）`)
process.exitCode = failed === 0 ? 0 : 1
