/**
 * 端到端复现 `plugin_manager install_bundle` 的每一步，验证**本插件能装进去**。
 *
 * ## 为什么要单独"复现"一遍
 *
 * `installBundle()` 的实现散在 DSH 的 asar 里，它做的事按顺序是：
 *
 *   1. `parseInstallSpec(spec)` —— 判 spec 形状（tarball / path / git / registry）
 *   2. `pnpm add <spec>` —— 在 profile 目录里执行
 *   3. 比对 `dependencies` **前后差异**，取出**新增的那个包名**
 *      （差异不是一个 → `ambiguous-install`）
 *   4. 读该包的 manifest，**必须有 `dsh.bundle`**（否则 → `not-bundle`）
 *   5. 兼容性检查（manifest 里声明了 DSH 版本范围时）
 *   6. `bundlePatchPaths(dir, manifest.dsh.bundle)` 真的读那份 patch
 *   7. 启用 bundle → `reload()`
 *
 * 任何一步不满足，用户看到的就是"装不上"，而**失败点不在插件代码里** ——
 * 插件自己的单测全绿也发现不了。所以这里在**临时 profile** 上把 2–6 步
 * 真跑一遍（第 1 步由 `test-install-bundle-spec.mjs` 覆盖），
 * 这样"能不能被 install_bundle 装"就有了可重复的证据。
 *
 * ⚠️ 第 7 步（启用 + reload）需要活的 DSH，这里不做；它在重启 DSH 时发生。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/dev/verify-install-bundle.mjs                      # 用 dist/ 里的 tgz
 * node scripts/dev/verify-install-bundle.mjs <绝对路径.tgz|插件目录>
 * ```
 *
 * 退出码 0 = 每一步都过。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')

let failed = 0
function step(label, ok, extra) {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? `  ${extra}` : ''}`)
  if (!ok) failed += 1
  return ok
}

// ---------------------------------------------------------------- 准备
/** spec：命令行给了就用它，否则用 dist 里的 tgz。 */
function defaultSpec() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  return join(ROOT, 'dist', `${pkg.name}-${pkg.version}.tgz`)
}
const spec = process.argv[2] ? resolve(process.argv[2]) : defaultSpec()

console.log('复现 install_bundle 的每一步\n')
console.log(`  spec = ${spec}`)
step('spec 存在', existsSync(spec))
if (failed > 0) process.exit(1)

/** 找 DSH 自带的 pnpm（版本与 DSH 一致，少一类环境差异）。 */
function findPnpm() {
  const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
  const runtimes = join(dshHome, 'dsh-runtimes')
  if (existsSync(runtimes)) {
    for (const rt of readdirSync(runtimes)) {
      const deps = join(runtimes, rt, 'dependencies')
      const node = join(deps, 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node')
      const script = join(deps, 'pnpm', 'bin', 'pnpm.mjs')
      if (existsSync(node) && existsSync(script)) return { node, script }
    }
  }
  return null
}
const pnpm = findPnpm()
step('找到 pnpm', Boolean(pnpm), pnpm ? pnpm.script : '（请把 pnpm 放上 PATH 后自行执行第 2 步）')

// ---------------------------------------------------------------- 临时 profile
/*
 * 用一个**临时 profile**，不碰真正的那个 —— 这条命令会真的装东西，
 * 而验证不应该改动用户环境。
 */
const tmp = join(process.env.TEMP ?? '/tmp', `dsh-ib-verify-${String(Date.now())}`)
mkdirSync(tmp, { recursive: true })
const profilePkg = join(tmp, 'package.json')
const baseManifest = {
  name: 'dsh-profile-verify',
  private: true,
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  dependencies: {},
}
writeFileSync(profilePkg, `${JSON.stringify(baseManifest, null, 2)}\n`, 'utf8')
console.log(`  临时 profile：${tmp}\n`)

/** 读 profile 的 dependencies。 */
const readDeps = () => JSON.parse(readFileSync(profilePkg, 'utf8')).dependencies ?? {}

try {
  // ---- 第 2 步：pnpm add <spec>
  console.log('[第 2 步] installBundle 执行的 pnpm add')
  const before = readDeps()
  if (pnpm) {
    const out = execFileSync(pnpm.node, [pnpm.script, 'add', spec], {
      cwd: tmp,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    })
    const tail = String(out).trim().split(/\r?\n/).slice(-3).join(' | ')
    step('pnpm add 退出码 0', true, tail)
  } else {
    step('pnpm 可用', false, '无法执行，后续步骤跳过')
    throw new Error('no pnpm')
  }

  // ---- 第 3 步：比对 dependencies 差异取包名
  console.log('\n[第 3 步] 比对 dependencies 差异，取新增包名')
  const after = readDeps()
  const installed = Object.keys(after).filter((k) => before[k] !== after[k])
  step('差异恰好一个包', installed.length === 1, JSON.stringify(installed))
  if (installed.length !== 1) throw new Error('ambiguous-install 会在这里发生')
  const name = installed[0]
  console.log(`      包名 = ${name}`)
  console.log(`      （键是包名，值是 spec：${after[name]}）`)

  // ---- 第 4 步：manifest 必须有 dsh.bundle
  console.log('\n[第 4 步] 读 manifest，检查 dsh.bundle')
  const req = createRequire(profilePkg)
  let dir = null
  try {
    dir = dirname(req.resolve(`${name}/package.json`))
  } catch {
    dir = null
  }
  step('解析到包目录', Boolean(dir), dir ?? '')
  if (!dir) throw new Error('解析不到包目录')

  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  step('manifest.name 与包名一致', manifest.name === name, `${String(manifest.name)}`)
  step('manifest.dsh.bundle 存在（否则 not-bundle）', Boolean(manifest.dsh?.bundle))

  // ---- 第 5 步：兼容性
  console.log('\n[第 5 步] 兼容性检查')
  const declaredDshRange =
    manifest.peerDependencies?.['@deepseek-ai/dsh'] ?? manifest.dependencies?.['@deepseek-ai/dsh']
  if (declaredDshRange === undefined) {
    step('未声明 DSH 版本范围 → 不触发兼容性拦截', true)
  } else {
    // 声明了就要能匹配；这里只报告，实际匹配由 DSH 自己做。
    console.log(`      声明了 @deepseek-ai/dsh: ${declaredDshRange} —— 需与当前 DSH 版本匹配`)
  }

  // ---- 第 6 步：bundlePatchPaths 要真读得到那份 patch
  console.log('\n[第 6 步] 读 dsh.bundle.patch 指向的配置行')
  const patchRel = manifest.dsh?.bundle?.patch
  step('bundle.patch 是字符串', typeof patchRel === 'string', String(patchRel))
  const patchAbs = patchRel ? join(dir, patchRel) : ''
  const hasPatch = Boolean(patchAbs) && existsSync(patchAbs)
  step('patch 文件存在', hasPatch, patchAbs)
  if (hasPatch) {
    const yml = readFileSync(patchAbs, 'utf8')
    step('含 insert 行（DSH 靠它把插件挂进配置树）', /insert\s*:/.test(yml))
    /*
     * ⚠️ 断言要容忍**缩进与引号**。
     *
     * 第一版写成 `yml.includes('id: ' + name)`，结果报了假失败 —— 实际内容是：
     *       - id: dsh-pet-ds        ← 有前导空格
     *         name: 'dsh-pet-ds'    ← name 的值**带单引号**
     * 一字不差地比字符串在这个文件里本来就是错的期望。
     */
    step(
      'insert 行的 id 是本插件',
      new RegExp(`^\\s*-\\s*id:\\s*["']?${name}["']?\\s*$`, 'm').test(yml),
    )
    step(
      'insert 行的 name 是本插件',
      new RegExp(`^\\s*name:\\s*["']?${name}["']?\\s*$`, 'm').test(yml),
    )
  }

  // ---- 附加：插件自带依赖能被解析（否则加载时 failed to import）
  console.log('\n[附加] 插件自己的裸标识符可解析（否则 DSH 报 failed to import）')
  const ownReq = createRequire(join(dir, 'package.json'))
  const wanted = ['@deepseek-ai/schemastery', '@deepseek-ai/dsh-tools', '@deepseek-ai/cordis']
  const bad = []
  for (const s of wanted) {
    try {
      ownReq.resolve(s)
    } catch {
      bad.push(s)
    }
  }
  step('三个关键依赖都能解析', bad.length === 0, bad.length ? `失败：${bad.join(', ')}` : '')
  step('插件自带 node_modules', existsSync(join(dir, 'node_modules')))

  console.log('\n[第 7 步] 启用 bundle → reload()  —— 需要活的 DSH，重启时发生，此处不做')
} finally {
  /*
   * 清理临时 profile。
   *
   * ⚠️ 必须**先摘联接再删**：pnpm 在 `node_modules` 里大量使用联接
   * （Windows 上是目录联接）。直接 `rmSync(recursive)` 在某些情况下会
   * 顺着联接删到链接目标 —— 那是别人的真实文件。
   *
   * 做法：自底向上遍历，遇到 LinkType 的目录用 `rmdir` 摘掉
   * （`rmdir` 对目录联接只删链接本身，不递归内容）。
   */
  const junctions = []
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (!e.isDirectory()) continue
      let isLink = false
      try {
        isLink = Boolean(statSync(p).isDirectory()) && Boolean(lstatSync(p).isSymbolicLink())
      } catch {
        isLink = false
      }
      // Windows 目录联接：lstat 标记为 symbolic link。
      if (isLink) junctions.push(p)
      else walk(p)
    }
  }
  walk(tmp)
  // 深的先摘（外层联接摘掉后内层就找不到了，所以深度倒序）。
  junctions.sort((a, b) => b.length - a.length)
  for (const j of junctions) {
    try {
      execFileSync('cmd', ['/c', 'rmdir', j], { stdio: 'ignore' })
    } catch {
      // 已不存在或无权限：交给 rmSync 兜底
    }
  }
  rmSync(tmp, { recursive: true, force: true })
  console.log(`\n（临时 profile 已清理：${String(!existsSync(tmp))}；摘除联接 ${String(junctions.length)} 个）`)
}

console.log(`\n结果：${failed === 0 ? '每一步都过 —— 可以被 install_bundle 安装' : `${String(failed)} 步未过`}`)
process.exitCode = failed === 0 ? 0 : 1
