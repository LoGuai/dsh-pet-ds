#!/usr/bin/env node
/**
 * **给 agent / 自动化用的**一条命令安装入口。
 *
 * ## 与 `scripts/install.mjs` 的关系
 *
 * `install.mjs` 是**给人看**的：五步、带颜色、有解释、失败时给出手动命令。
 * 本脚本是给**agent 用**的：把"装 + 验"串成一次调用，**用退出码表达结论**，
 * 并在最后打印一段机器可读的摘要。
 *
 * agent 只要能跑命令并读退出码，就不需要理解任何 DSH 内部概念。
 *
 * ## 用法
 *
 * ```bash
 * node install.mjs                      # 装 + 验
 * node install.mjs --profile desktop    # 指定 profile
 * node install.mjs --dry-run            # 只看会改什么
 * node install.mjs --json               # 只输出一行 JSON 结果（便于程序解析）
 * ```
 *
 * ## 退出码
 *
 *   0  安装完成，且验证通过（重启 DSH 后即生效）
 *   1  安装或验证失败（stderr 里有原因）
 *
 * ## 它到底做了什么
 *
 *   1. 调 `scripts/install.mjs`：把插件登记进 profile 的 `package.json`
 *      （`dsh.profile.bundles` + `dependencies`），并跑 pnpm install；
 *   2. **额外**跑一次插件目录自己的 `pnpm install` —— 这一步不能省：
 *      ESM 解析裸标识符时从**插件真实路径**往上找 `node_modules`，
 *      而 profile 的那份不在解析链上。漏了它 DSH 会报
 *      `dsh-pet-ds (dsh-pet-ds): failed to import`；
 *   3. 跑 `probe-import-resolution.mjs` 验证解析链真的完好；
 *   4. 打印摘要 + 提醒重启 DSH。
 *
 * ⚠️ 最后一步（重启 DSH）**故意不自动做** —— 那会关掉正在跟用户对话的
 * 那个会话窗口。让调用方决定什么时候重启。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/** 本脚本就放在插件仓库根目录，所以 `HERE` 就是插件根。 */
const ROOT = HERE

const argv = process.argv.slice(2)
const has = (f) => argv.includes(`--${f}`)
const val = (f, d = null) => {
  const i = argv.indexOf(`--${f}`)
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1]
  const pre = argv.find((a) => a.startsWith(`--${f}=`))
  return pre ? pre.slice(f.length + 3) : d
}

const JSON_ONLY = has('json')
const DRY_RUN = has('dry-run')
const PROFILE = val('profile')

/** 结果汇总（`--json` 时原样输出）。 */
const summary = {
  ok: false,
  pluginRoot: ROOT,
  profile: PROFILE,
  dryRun: DRY_RUN,
  steps: [],
  restartRequired: true,
  error: null,
}

const say = (msg) => {
  if (!JSON_ONLY) console.log(msg)
}

/** 跑一条命令并把输出透传（失败不抛，返回结果）。 */
function run(cmd, args, opts = {}) {
  try {
    const out = execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
      ...opts,
    })
    return { ok: true, out: String(out) }
  } catch (err) {
    return {
      ok: false,
      out: `${String(err?.stdout ?? '')}${String(err?.stderr ?? '')}`,
      code: err?.status ?? 1,
    }
  }
}

function step(name, ok, detail) {
  summary.steps.push({ name, ok, detail: detail ?? null })
  if (!JSON_ONLY) console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  return ok
}

function finish(code) {
  summary.ok = code === 0
  if (JSON_ONLY) {
    console.log(JSON.stringify(summary))
  } else {
    console.log('')
    console.log(code === 0 ? '安装完成。' : '安装未完成 —— 见上面标 ✗ 的步骤。')
    if (code === 0) {
      console.log('')
      console.log('接下来：**重启 DSH**，插件是在启动时加载的。')
      console.log('重启后应看到：')
      console.log('  · 桌宠自动出现（配置 autoStart 默认为 true）')
      console.log('  · 模型工具 DSHpet_status / DSHpet_control / DSHpet_balance 可用')
      console.log('  · DSH 设置页里出现「桌宠」一栏')
    }
  }
  process.exit(code)
}

if (!JSON_ONLY) {
  console.log('DSH 桌宠插件 · 安装（agent 入口）')
  console.log(`  插件目录：${ROOT}`)
  console.log('')
}

// ---------------------------------------------------------------- 0) 预检
if (!JSON_ONLY) console.log('[0/3] 预检')
const pkgPath = join(ROOT, 'package.json')
if (!existsSync(pkgPath)) {
  summary.error = `找不到 ${pkgPath}`
  step('插件清单存在', false, summary.error)
  finish(1)
}
let pkg = null
try {
  pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
} catch {
  pkg = null
}
step('插件清单存在', true, pkg ? `${String(pkg.name)} v${String(pkg.version)}` : undefined)

for (const rel of ['cordis.patch.yml', 'src/host/index.js', 'client/client.js', 'scripts/install.mjs']) {
  step(`含 ${rel}`, existsSync(join(ROOT, rel)))
}

// ---------------------------------------------------------------- 1) 安装
if (!JSON_ONLY) console.log('\n[1/3] 登记进 profile 并装依赖')
const installArgs = [join(ROOT, 'scripts', 'install.mjs')]
if (PROFILE) installArgs.push('--profile', PROFILE)
if (DRY_RUN) installArgs.push('--dry-run')
const install = run(process.execPath, installArgs)
if (!JSON_ONLY) console.log(install.out.trimEnd())
step('scripts/install.mjs 成功', install.ok, install.ok ? null : `exit=${install.code}`)

if (DRY_RUN) {
  step('（--dry-run，跳过后续验证）', true)
  finish(install.ok ? 0 : 1)
}

if (!install.ok) {
  summary.error = 'install.mjs 失败'
  finish(1)
}

// ---------------------------------------------------------------- 2) 插件目录自己的依赖
/*
 * ⚠️ 这一步不能省。install.mjs 已经也会装插件目录，这里再**显式验一次**
 * （而不是盲信），因为失败的表现极隐蔽：依赖"装好了"但 DSH 报
 * `failed to import`，而插件自己一行日志都没有。
 */
if (!JSON_ONLY) console.log('\n[2/3] 确认插件目录的依赖（ESM 解析链）')
const probeScript = join(ROOT, 'scripts', 'dev', 'probe-import-resolution.mjs')
let probeOut = ''
if (existsSync(probeScript)) {
  /*
   * 用 **Electron 以 Node 模式**跑：纯 Node 不认 asar，而 DSH 注入的那类包
   * 解析要经过 asar。找不到 Electron 就退回普通 node（仍能验大部分）。
   */
  const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
  const elCandidates = []
  const electronDir = join(dshHome, 'electron')
  if (existsSync(electronDir)) {
    try {
      for (const d of readdirSync(electronDir)) {
        if (!d.startsWith('electron-')) continue
        elCandidates.push(
          join(electronDir, d, process.platform === 'win32' ? 'electron.exe' : 'electron'),
        )
      }
    } catch {
      // 忽略：找不到就用普通 node 兜底。
    }
  }
  const electron = elCandidates.find((p) => existsSync(p))
  const childEnv = { ...process.env }
  if (electron) childEnv.ELECTRON_RUN_AS_NODE = '1'
  const probe = run(electron ?? process.execPath, [probeScript], { env: childEnv })
  probeOut = probe.out
  if (!JSON_ONLY) console.log(probe.out.trimEnd())
  step('插件导入解析链验证通过', probe.ok, probe.ok ? null : '解析链仍有问题 —— DSH 会报 failed to import')
} else {
  step('找到验证脚本', false, `缺 ${probeScript}`)
}

// ---------------------------------------------------------------- 3) 结论
if (!JSON_ONLY) console.log('\n[3/3] 结论')
const allOk = summary.steps.every((s) => s.ok)
finish(allOk ? 0 : 1)
