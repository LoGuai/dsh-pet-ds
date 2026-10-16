#!/usr/bin/env node
/**
 * 把桌宠插件安装进 DSH 的某个 profile。
 *
 * ## 设计原则：只操作 DSH 自己的文件，不重复实现它的逻辑
 *
 * 插件要装进哪里、写成什么形状，**不靠猜**。DSH 的 profile 就是
 * `$DSH_HOME/profiles/<名字>/`，安装状态**全部**体现在它自己的两个字段上：
 *
 * ```jsonc
 * // $DSH_HOME/profiles/<名字>/package.json
 * {
 *   "dsh": { "profile": { "bundles": [ ..., "dsh-pet-ds" ] } },
 *   "dependencies": { "dsh-pet-ds": "file:<本仓库路径>" }
 * }
 * ```
 *
 * 所以本脚本只做三件事：**改这两个字段 → 跑 pnpm install → 验证能解析到**。
 * 不去写 `cordis.yml`（DSH 自己从 bundles 组装）、不去假装知道它的内部 API。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/install.mjs                 # 装进探测到的 profile
 * node scripts/install.mjs --dry-run       # 只显示要改什么，不落盘
 * node scripts/install.mjs --profile work  # 指定 profile
 * node scripts/install.mjs --no-pnpm       # 跳过 pnpm install（自己手动装）
 * node scripts/install.mjs --uninstall     # 从 profile 里移除本插件
 * ```
 */

import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync, copyFileSync, lstatSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/** 插件仓库根目录（本脚本在 <root>/scripts/ 下）。 */
const PLUGIN_ROOT = resolve(HERE, '..')
const PLUGIN_NAME = 'dsh-pet-ds'

// ------------------------------------------------------------------ 输出小工具
const C = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  cyan: '\u001b[36m',
  bold: '\u001b[1m',
}
/** 无 TTY（被重定向）时不要输出颜色码，否则日志里全是乱码。 */
const useColor = process.stdout.isTTY && process.env.NO_COLOR === undefined
const paint = (color, text) => (useColor ? `${C[color]}${text}${C.reset}` : text)

const step = (n, total, text) => console.log(`\n${paint('bold', `[${String(n)}/${String(total)}]`)} ${text}`)
const ok = (text) => console.log(`  ${paint('green', '✓')} ${text}`)
const warn = (text) => console.log(`  ${paint('yellow', '!')} ${text}`)
const bad = (text) => console.log(`  ${paint('red', '✗')} ${text}`)
const info = (text) => console.log(`  ${paint('dim', text)}`)

/** 累积错误，最后一起报（避免装到一半才发现问题）。 */
const problems = []
const fail = (text) => {
  problems.push(text)
  bad(text)
}

// ------------------------------------------------------------------ 参数
const argv = process.argv.slice(2)
const hasFlag = (name) => argv.includes(`--${name}`)
const argValue = (name, dflt = null) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  if (hit) return hit.slice(name.length + 3)
  const i = argv.indexOf(`--${name}`)
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1]
  return dflt
}

const DRY_RUN = hasFlag('dry-run')
const SKIP_PNPM = hasFlag('no-pnpm')
const UNINSTALL = hasFlag('uninstall')
const USE_LINK = hasFlag('link')
const SHOW_HELP = hasFlag('help') || hasFlag('h')
const EXPLICIT_PROFILE = argValue('profile')

const HELP_TEXT = `
${paint('bold', 'DSH 桌宠插件安装器')}

用法：
  node scripts/install.mjs [选项]

选项：
  --profile <名字|绝对路径>  指定装进哪个 profile。
                             默认取环境变量 DSH_PROFILE，再退回"唯一的那个"。
                             有多个 profile 又没指定时会报错并列出候选（不猜）。
  --link                     装完后把 node_modules 里的包换成指向本仓库的
                             目录联接，让**改源码立即生效**（开发时用）。
  --no-pnpm                  跳过 pnpm install，自己手动装。
  --dry-run                  只显示要改什么，不写任何文件。
  --uninstall                从 profile 移除本插件。
  --help, -h                 显示本帮助。

示例：
  node scripts/install.mjs                    # 正常安装
  node scripts/install.mjs --dry-run          # 先看看会改什么
  node scripts/install.mjs --link             # 安装 + 改完即生效
  node scripts/install.mjs --profile work     # 装进名为 work 的 profile
  node scripts/install.mjs --uninstall        # 卸载

它到底改了什么：
  只改 profile 的 package.json 里两个字段（并在首次改动前备份）：
    dsh.profile.bundles  ← 加入 "${PLUGIN_NAME}"
    dependencies         ← 加入 "file:<本仓库绝对路径>"
  然后跑 pnpm install 把依赖接进 node_modules，最后验证能解析到插件入口。

详细说明见 INSTALL.md
`

// ------------------------------------------------------------------ 探测器

/** DSH home：环境变量优先，其次 `~/.dsh`。 */
function resolveDshHome() {
  const fromEnv = String(process.env.DSH_HOME ?? '').trim()
  if (fromEnv) return resolve(fromEnv)
  return join(homedir(), '.dsh')
}

/**
 * 找要装进哪个 profile。
 *
 * `--profile` 既接受**名字**（相对 `$DSH_HOME/profiles/`）也接受**绝对路径** ——
 * 后者便于把 profile 放在别处、也便于自动化测试时用临时目录。
 *
 * 其余优先级：`--profile` > `$DSH_PROFILE` > 唯一的那个 profile。
 * 有多个又没说清时**明确报错并列出候选**，不替用户猜 —— 装错 profile
 * 的表现是"DSH 里看不到插件"，那种问题很难往回查。
 */
function resolveProfileDir(dshHome) {
  const profilesRoot = join(dshHome, 'profiles')

  if (EXPLICIT_PROFILE) {
    // 绝对路径 → 直接用；否则当作 profiles/ 下的名字。
    const dir = isAbsolute(EXPLICIT_PROFILE) ? resolve(EXPLICIT_PROFILE) : join(profilesRoot, EXPLICIT_PROFILE)
    if (!existsSync(dir)) {
      throw new Error(`指定的 profile 不存在：${dir}`)
    }
    return { name: isAbsolute(EXPLICIT_PROFILE) ? dir : EXPLICIT_PROFILE, dir, how: '命令行 --profile' }
  }

  const fromEnv = String(process.env.DSH_PROFILE ?? '').trim()
  if (fromEnv) {
    const dir = isAbsolute(fromEnv) ? resolve(fromEnv) : join(profilesRoot, fromEnv)
    if (existsSync(dir)) {
      return { name: fromEnv, dir, how: '环境变量 DSH_PROFILE' }
    }
    info(`环境变量 DSH_PROFILE=${fromEnv} 指向的目录不存在，改从 profiles/ 里探测`)
  }

  if (!existsSync(profilesRoot)) {
    throw new Error(`找不到 profiles 目录：${profilesRoot}（DSH 装过吗？）`)
  }
  const names = readdirSync(profilesRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)

  if (names.length === 0) throw new Error(`${profilesRoot} 下没有任何 profile`)
  if (names.length === 1) return { name: names[0], dir: join(profilesRoot, names[0]), how: '唯一候选' }

  throw new Error(
    `有多个 profile，无法确定装哪个：${names.join('、')}\n` +
      `    请用 --profile <名字> 指定，或设置环境变量 DSH_PROFILE`,
  )
}

/**
 * 找 Electron 运行时。
 *
 * 探测规则与插件的自动探测保持一致：`$DSH_HOME/electron/electron-<版本>/`。
 * （注意别在这里写带星号的 glob —— JSDoc 里出现 `星号+斜杠` 会提前闭合注释。）
 */
function findElectron(dshHome) {
  const base = join(dshHome, 'electron')
  if (!existsSync(base)) return null
  const exeName = process.platform === 'win32' ? 'electron.exe' : 'electron'
  const candidates = readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith('electron-'))
    .map((d) => join(base, d.name, exeName))
  return candidates.find((p) => existsSync(p)) ?? null
}

/**
 * 读 JSON。
 *
 * ⚠️ 要**容忍 UTF-8 BOM**：Windows 上用 PowerShell 的
 * `Set-Content -Encoding utf8` 写出来的文件带头部 BOM（EF BB BF），
 * 而带 BOM 的文本是**非法 JSON** —— `JSON.parse` 会直接抛
 * `Unexpected token ''`。
 *
 * 用户手写 profile 配置时非常容易踩到这个（BOM 还是不可见的），
 * 所以这里主动剥掉，而不是把一个"看不出哪里错"的报错丢给用户。
 * 实测：本机 profile 的 package.json 就是带 BOM 的。
 */
function readJson(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    throw new Error(`读不到 ${file}：${err instanceof Error ? err.message : String(err)}`)
  }
  // 剥掉 BOM（可能不止一个，虽然正常只有一个）。
  while (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  try {
    return JSON.parse(text)
  } catch (err) {
    throw new Error(
      `${file} 不是合法 JSON：${err instanceof Error ? err.message : String(err)}\n` +
        `    请先修好它（或从备份恢复）再运行本脚本。`,
    )
  }
}

/** 写 JSON，保留 2 空格缩进与结尾换行（与 DSH 自己写的风格一致）。 */
function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/**
 * 把一个 profile 的 package.json 对象改成"装了本插件"的样子 —— **纯函数**。
 *
 * 抽出来是为了能单测（见 scripts/dev/test-install.mjs）：它决定了 DSH
 * 认不认这个插件，而写错的表现是"DSH 里看不到插件"，比报错难查得多。
 *
 * 两条规则各自的理由：
 *
 *  · **bundles 里只出现一次**：重复会让 DSH 把同一层 patch 叠两次。
 *    所以用 includes 判断，而不是无脑 push（重复运行安装器要幂等）。
 *
 *  · **依赖写成 `file:<绝对路径>`（正斜杠）**：不能用相对路径 ——
 *    profile 在 `~/.dsh/profiles/<名>/`，与插件仓库往往**不在同一个盘**，
 *    相对路径跨盘会解析失败（实测过，算出个不存在的路径）。
 *    正斜杠在 Windows 上 pnpm 也能正确解析（反斜杠在 npm 依赖说明符里
 *    是转义字符，容易出意外）。
 *
 * @param {object} pkg        profile 的 package.json 对象（会被就地修改）
 * @param {object} opts
 * @param {string} opts.pluginName
 * @param {string} opts.pluginRoot 插件仓库绝对路径
 * @param {boolean} [opts.uninstall]
 * @returns {object} 同一个 pkg（便于链式断言）
 */
export function applyInstallToPackageJson(pkg, opts) {
  const { pluginName, pluginRoot, uninstall = false } = opts

  // 结构可能缺失（新建的 profile 就只有一个 name），先补齐。
  pkg.dsh ??= {}
  pkg.dsh.profile ??= {}
  pkg.dsh.profile.bundles ??= []
  pkg.dependencies ??= {}

  if (uninstall) {
    pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((b) => b !== pluginName)
    delete pkg.dependencies[pluginName]
    return pkg
  }

  if (!pkg.dsh.profile.bundles.includes(pluginName)) {
    pkg.dsh.profile.bundles.push(pluginName)
  }
  pkg.dependencies[pluginName] = `file:${pluginRoot.replace(/\\/g, '/')}`
  return pkg
}

// ------------------------------------------------------------------ 主流程

function main() {
  if (SHOW_HELP) {
    console.log(HELP_TEXT)
    return 0
  }
  console.log(paint('bold', `\nDSH 桌宠插件安装器  ${PLUGIN_NAME}`))
  if (DRY_RUN) console.log(paint('yellow', '  （--dry-run：只显示要改什么，不落盘）'))

  const TOTAL = 5

  // ---- 1) 检查本仓库是否完整
  step(1, TOTAL, '检查插件本体')
  const pkgPath = join(PLUGIN_ROOT, 'package.json')
  if (!existsSync(pkgPath)) {
    fail(`找不到 ${pkgPath} —— 本脚本必须在插件仓库内运行（<root>/scripts/install.mjs）`)
    return 1
  }
  const pkg = readJson(pkgPath)
  if (pkg.name !== PLUGIN_NAME) {
    fail(`package.json 里的 name 是 "${String(pkg.name)}"，期望 "${PLUGIN_NAME}"`)
    return 1
  }
  ok(`插件包：${pkg.name} v${String(pkg.version)}`)
  info(`仓库路径：${PLUGIN_ROOT}`)

  // 运行需要的三个东西，缺一个装了也跑不起来。
  const petMain = join(PLUGIN_ROOT, 'pet-app', 'main.js')
  if (!existsSync(petMain)) fail(`缺桌宠入口：${petMain}`)
  else ok('桌宠入口存在（pet-app/main.js）')

  const animRoot = join(PLUGIN_ROOT, 'assets', 'animations')
  let animCount = 0
  if (existsSync(animRoot)) {
    animCount = readdirSync(animRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).length
  }
  if (animCount === 0) {
    fail(
      `缺动画素材：${animRoot}\n` +
        `    素材不在仓库里（体积大、且授权仅限作者本人）。\n` +
        `    请把素材放到该目录（每个动作一个子目录，含 manifest.json 与帧图）。`,
    )
  } else {
    ok(`动画素材：${String(animCount)} 个动作`)
  }

  const patchPath = join(PLUGIN_ROOT, 'cordis.patch.yml')
  if (!existsSync(patchPath)) fail(`缺 cordis.patch.yml（DSH 靠它把插件挂进配置树）`)
  else ok('cordis.patch.yml 存在')
  if (pkg.dsh?.bundle?.patch === undefined) {
    fail('package.json 里缺 dsh.bundle.patch —— DSH 不会识别为 bundle 插件')
  }

  if (problems.length > 0) {
    console.log(paint('red', '\n插件本体不完整，先解决上面的问题。'))
    return 1
  }

  // ---- 2) 定位 DSH 与 profile
  step(2, TOTAL, '定位 DSH 与目标 profile')
  const dshHome = resolveDshHome()
  if (!existsSync(dshHome)) {
    fail(`找不到 DSH home：${dshHome}\n    先运行一次 DSH，或设置环境变量 DSH_HOME。`)
    return 1
  }
  ok(`DSH home：${dshHome}`)
  info(`来源：${process.env.DSH_HOME ? '环境变量 DSH_HOME' : '默认 ~/.dsh'}`)

  let profile
  try {
    profile = resolveProfileDir(dshHome)
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err))
    return 1
  }
  ok(`目标 profile：${profile.name}（依据：${profile.how}）`)
  info(profile.dir)

  // ---- 3) 改 profile 的 package.json
  step(3, TOTAL, UNINSTALL ? '从 profile 移除本插件' : '把插件登记进 profile')
  const profilePkgPath = join(profile.dir, 'package.json')
  if (!existsSync(profilePkgPath)) {
    fail(`profile 里没有 package.json：${profilePkgPath}\n    先用 DSH 打开一次该 profile。`)
    return 1
  }
  const profilePkg = readJson(profilePkgPath)

  const before = {
    bundles: [...(profilePkg.dsh?.profile?.bundles ?? [])],
    dep: profilePkg.dependencies?.[PLUGIN_NAME],
  }

  applyInstallToPackageJson(profilePkg, {
    pluginName: PLUGIN_NAME,
    pluginRoot: PLUGIN_ROOT,
    uninstall: UNINSTALL,
  })

  const after = {
    bundles: profilePkg.dsh.profile.bundles,
    dep: profilePkg.dependencies[PLUGIN_NAME],
  }

  console.log('')
  info(`bundles: ${before.bundles.length === 0 ? '（空）' : before.bundles.join(', ')}`)
  info(`      →  ${after.bundles.length === 0 ? '（空）' : after.bundles.join(', ')}`)
  info(`dependencies[${PLUGIN_NAME}]: ${before.dep ?? '（无）'}  →  ${after.dep ?? '（已移除）'}`)

  if (DRY_RUN) {
    console.log(paint('yellow', '\n--dry-run：到此为止，没有写任何文件。'))
    return 0
  }

  // 先备份（只在第一次时备份，别把好备份覆盖成坏的）。
  const backupPath = `${profilePkgPath}.bak-before-${PLUGIN_NAME}`
  if (!existsSync(backupPath)) {
    copyFileSync(profilePkgPath, backupPath)
    ok(`已备份原配置：${backupPath}`)
  } else {
    info(`备份已存在（未覆盖）：${backupPath}`)
  }
  writeJson(profilePkgPath, profilePkg)
  ok(UNINSTALL ? '已从 profile 移除' : '已登记进 profile')

  // ---- 4) 依赖接线
  step(4, TOTAL, '把依赖装进 profile 的 node_modules')
  const linkPath = join(profile.dir, 'node_modules', PLUGIN_NAME)

  if (UNINSTALL) {
    info('卸载模式下不动 node_modules —— 需要时自己跑一次 pnpm install 清理')
  } else if (SKIP_PNPM) {
    warn('--no-pnpm：跳过了安装。请自己在 profile 目录里跑 pnpm install')
    info(`cd "${profile.dir}" && pnpm install`)
  } else {
    const pnpm = findPnpm(dshHome)
    if (!pnpm) {
      warn('找不到 pnpm。请自己在 profile 目录里跑一次 pnpm install：')
      info(`cd "${profile.dir}" && pnpm install`)
    } else {
      info(`用 ${pnpm.node} 执行 ${pnpm.script}`)
      const res = runPnpm(pnpm, profile.dir)
      if (res.ok) ok('pnpm install 完成')
      else {
        warn('pnpm install 失败，请手动在 profile 目录里跑一次：')
        info(`cd "${profile.dir}" && pnpm install`)
        if (res.tail) info(res.tail)
      }
    }
  }

  // ---- 5) 验证
  step(5, TOTAL, '验证 DSH 能解析到这个插件')

  if (UNINSTALL) {
    ok('已卸载。重启 DSH 后生效。')
    return 0
  }

  /*
   * `--link`：把 node_modules 里的包换成指向本仓库的目录联接，
   * 这样**改源码立即生效、不必重装**。
   *
   * 为什么需要这个开关：`pnpm install` 对 `file:` 依赖会做成**硬链接拷贝**
   * （放在 `node_modules/.pnpm/...` 里，再在顶层放一个拷贝）。硬链接与源文件
   * 共享数据块，所以"文件内容相同"时改源码确实会反映过去 —— 但**新增/删除
   * 文件不会**，而且 pnpm 重装后可能变成真正的拷贝。对"边改边看"的开发来说
   * 不可靠，所以提供一个明确的联接模式。
   */
  if (USE_LINK) {
    if (process.platform !== 'win32') {
      warn('--link 目前只实现了 Windows（目录联接）。其它平台请自行建符号链接。')
    } else {
      const linked = makeJunction(linkPath, PLUGIN_ROOT)
      if (linked.ok) ok(`已改为目录联接（改源码立即生效）：${linkPath} → ${PLUGIN_ROOT}`)
      else warn(`建联接失败：${linked.error}\n    可以手动执行：\n    cmd /c rmdir "${linkPath}"\n    cmd /c mklink /J "${linkPath}" "${PLUGIN_ROOT}"`)
    }
  }

  // 5a) 依赖是否已接线
  /*
   * 这一条是**致命**的：解析不到插件 = DSH 根本看不到它。
   * 所以下面要据它决定退出码与结论文案 —— 不能明明失败还说"安装完成"，
   * 那会让人以为装好了、然后对着空桌面找原因（实测在全新环境里就撞到过）。
   */
  let resolveOk = false

  if (existsSync(linkPath)) {
    ok('node_modules 里有这个包')
    /*
     * 判断它是"联接"还是"拷贝"：联接的情况下改源码立即生效，拷贝则不是。
     * 这个区别很影响开发体验，所以直接告诉用户现在是哪种。
     */
    const kind = detectLinkKind(linkPath)
    if (kind === 'junction' || kind === 'symlink') {
      ok('是链接（改源码立即生效）')
    } else {
      info('是拷贝（改源码不会自动生效）。想让改完即生效：node scripts/install.mjs --link')
    }
  } else {
    bad(`node_modules 里没有这个包：${linkPath}`)
    info('依赖没装上。请在 profile 目录里跑一次 pnpm install：')
    info(`cd "${profile.dir}" && pnpm install`)
  }

  // 5b) 真正解析一次（这是最有说服力的检查）
  try {
    const req = createRequire(join(profile.dir, 'package.json'))
    const resolved = req.resolve(`${PLUGIN_NAME}/package.json`)
    const got = JSON.parse(readFileSync(resolved, 'utf8'))
    if (got.name !== PLUGIN_NAME) {
      bad(`解析到的包名是 ${String(got.name)}，不是 ${PLUGIN_NAME}`)
    } else {
      resolveOk = true
      ok(`能解析到插件入口：${String(got.main ?? '(未声明 main)')}`)
      info(resolved)
    }
  } catch (err) {
    bad(`从 profile 解析不到 ${PLUGIN_NAME}：${err instanceof Error ? err.message : String(err)}`)
    info('DSH 现在看不到这个插件。先让 pnpm install 成功，再重启 DSH。')
  }

  /*
   * 5c / 5d 是**非致命**的：插件能加载，但桌宠窗口起不来、余额显示不了。
   * 它们单独列成"还需要什么"，而不是混在失败里 —— 否则用户分不清
   * "插件装坏了"和"还差一个运行时"。
   */
  const followUps = []

  const electron = findElectron(dshHome)
  if (electron) {
    ok(`Electron 运行时：${electron}`)
  } else {
    warn('没找到 Electron 运行时 —— 宿主插件能加载，但桌宠窗口起不来。')
    followUps.push({
      what: '装 Electron 运行时',
      how: 'node scripts/dev/install-electron.mjs --version 38.2.0',
      why: '必须装在工作区之外，原因见 INSTALL.md 的『装之前』一节',
    })
  }

  const creds = join(dshHome, '.credentials.yaml')
  if (existsSync(creds)) {
    ok(`凭据文件存在：${creds}`)
  } else {
    warn(`没找到凭据文件：${creds}`)
    followUps.push({
      what: '配置 DeepSeek API 凭据',
      how: '在 DSH 里配置 DEEPSEEK_API_KEY（或写入 $DSH_HOME/.credentials.yaml）',
      why: '没有它余额面板显示"未配置"，其它功能正常',
    })
  }

  // ---- 收尾（结论要如实反映成功/失败）
  if (!resolveOk) {
    console.log(`\n${paint('red', paint('bold', '安装未完成。'))}`)
    console.log('\nDSH 现在还看不到这个插件。请先解决上面标 ✗ 的问题（通常是 pnpm install），')
    console.log(`然后重跑：node scripts/install.mjs`)
    console.log(paint('dim', '\n详细排障见 INSTALL.md 的『排障』一节'))
    return 1
  }

  console.log(`\n${paint('green', paint('bold', '安装完成。'))}`)

  if (followUps.length > 0) {
    console.log(`\n${paint('yellow', paint('bold', '还差这几样（不影响插件加载）：'))}`)
    for (const item of followUps) {
      console.log(`  · ${paint('bold', item.what)}`)
      console.log(`      ${item.how}`)
      console.log(`      ${paint('dim', item.why)}`)
    }
  }

  console.log(`\n${paint('bold', '接下来：重启 DSH')}`)
  console.log('  · 插件是在 DSH 启动时加载的，**必须重启才会生效**；')
  console.log('  · 重启后桌宠会在几秒内自动出现（autoStart）。')
  console.log(`\n${paint('bold', '验证：')}`)
  console.log('  · 桌面上出现一个透明小窗（蓝发鲸鱼娘）；')
  console.log('  · 右键它应能看到「对话 / 动作 / 尺寸 / 置顶 …」菜单；')
  console.log('  · 下方常驻面板显示你的 API 余额。')
  console.log(`\n${paint('dim', '详细说明与排障见 INSTALL.md')}`)
  return 0
}

/**
 * 判断 node_modules 里那个包是"链接"还是"拷贝"。
 *
 * `lstatSync` 不会跟随链接，所以能看出真身：目录联接在 Windows 上
 * 报告为 `isSymbolicLink() === true`；pnpm 的硬链接拷贝则是普通目录。
 *
 * @returns {'junction'|'symlink'|'copy'|'missing'}
 */
function detectLinkKind(p) {
  try {
    const st = lstatSync(p)
    if (st.isSymbolicLink()) return process.platform === 'win32' ? 'junction' : 'symlink'
    return 'copy'
  } catch {
    return 'missing'
  }
}

/**
 * 在 Windows 上把 `linkPath` 换成指向 `target` 的目录联接（junction）。
 *
 * 用 `mklink /J` 而不是符号链接：**联接不需要管理员权限**，符号链接需要
 * （除非开了开发者模式）。所以联接更适合"普通用户照着指引自己装"。
 */
function makeJunction(linkPath, target) {
  try {
    if (existsSync(linkPath) || isBrokenLink(linkPath)) {
      // 联接要用 rmdir 删（rmdir 只摘掉联接，不会删掉目标里的文件）。
      execFileSync('cmd', ['/c', 'rmdir', linkPath], { stdio: ['ignore', 'pipe', 'pipe'] })
    }
    execFileSync('cmd', ['/c', 'mklink', '/J', linkPath, target], { stdio: ['ignore', 'pipe', 'pipe'] })
    return { ok: true }
  } catch (err) {
    const out = `${String(err?.stdout ?? '')}${String(err?.stderr ?? '')}`.trim()
    return { ok: false, error: out || (err instanceof Error ? err.message : String(err)) }
  }
}

/** 断掉的链接：`existsSync` 会返回 false，但 `lstat` 能看到它。 */
function isBrokenLink(p) {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * 找 pnpm。
 *
 * DSH 自己带了一个 pnpm（在运行时目录里），优先用它 —— 版本与 DSH 一致，
 * 不会因为用户机器上的 pnpm 版本差异出怪问题。
 */
function findPnpm(dshHome) {
  const runtimeRoot = join(dshHome, 'dsh-runtimes')
  if (!existsSync(runtimeRoot)) return null
  const exeName = process.platform === 'win32' ? 'node.exe' : 'node'
  for (const rt of readdirSync(runtimeRoot, { withFileTypes: true })) {
    if (!rt.isDirectory()) continue
    const deps = join(runtimeRoot, rt.name, 'dependencies')
    const node = join(deps, 'node', 'bin', exeName)
    const script = join(deps, 'pnpm', 'bin', 'pnpm.mjs')
    if (existsSync(node) && existsSync(script)) return { node, script }
  }
  return null
}

/** 在 profile 目录里跑 pnpm install。 */
function runPnpm(pnpm, cwd) {
  try {
    execFileSync(pnpm.node, [pnpm.script, 'install'], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10 * 60 * 1000,
    })
    return { ok: true }
  } catch (err) {
    const out = `${String(err?.stdout ?? '')}${String(err?.stderr ?? '')}`.trim()
    const lines = out.split(/\r?\n/).filter(Boolean)
    return { ok: false, tail: lines.slice(-6).join('\n    ') }
  }
}

/*
 * 顶层执行：任何未预料的异常都要转成可读报错 + 非 0 退出码。
 *
 * ⚠️ 只在**直接运行**时执行；被 `import`（单测会这么做）时不要跑安装流程 ——
 * 否则测试一 import 就把插件装一遍。
 */
const isDirectRun =
  process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))

if (isDirectRun) {
  try {
    process.exitCode = main()
  } catch (err) {
    console.error(`\n${paint('red', '安装器出错：')}${err instanceof Error ? err.message : String(err)}`)
    if (err instanceof Error && err.stack) {
      console.error(paint('dim', err.stack.split('\n').slice(1, 6).join('\n')))
    }
    process.exitCode = 1
  }
}
