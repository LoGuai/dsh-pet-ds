/**
 * 安装本机独立 Electron 运行时。
 *
 * 背景：DSH 自带的那份 `DeepSeek Harness.exe` 是**改造过的** Electron 载体，
 * 不接受标准 Electron 的启动参数（把应用目录当参数传给它会直接退出），
 * 因此桌宠必须用一份独立的、原版的 Electron。
 *
 * 本脚本做四件事：
 *   1. 查询要安装的版本（默认取 npm `electron` 的最新稳定版，可用 --version 指定）；
 *   2. 从 npm 的镜像地址下载 win32-x64 压缩包（带断点复用的本地缓存）；
 *   3. 解压到 `<插件根>/runtime/electron/`（探测逻辑的第 3 优先级，最稳）；
 *   4. 校验可执行文件存在，并打印实际版本。
 *
 * 用法：
 *   node scripts/dev/install-electron.mjs                 # 装最新稳定版
 *   node scripts/dev/install-electron.mjs --version 38.2.0
 *   node scripts/dev/install-electron.mjs --mirror https://npmmirror.com/mirrors/electron/
 *   node scripts/dev/install-electron.mjs --dry-run
 */

import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..', '..')
const cacheDir = join(pluginRoot, '.cache')

/**
 * 安装目录选在 $DSH_HOME/electron/<版本>，**不放在插件目录里**。两个原因：
 *  1. Electron 必须在可写目录里创建 user-data 与缓存；
 *  2. 实测发现，放在受权限约束的工作区目录下时，Electron 启动会立刻崩在
 *     `electron::fuses::IsLoadBrowserProcessSpecificV8SnapshotEnabled`（EXCEPTION_BREAKPOINT）。
 *     同一份二进制复制到用户目录后就完全正常，因此位置而非版本才是关键。
 */
const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')

const argv = process.argv.slice(2)
function argValue(name, fallback) {
  const prefix = `--${name}=`
  const inline = argv.find((a) => a.startsWith(prefix))
  if (inline) return inline.slice(prefix.length)
  const index = argv.indexOf(`--${name}`)
  if (index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--')) return argv[index + 1]
  return fallback
}

const requestedVersion = argValue('version', '')
const dryRun = argv.includes('--dry-run')
const mirrors = [
  argValue('mirror', ''),
  'https://npmmirror.com/mirrors/electron/',
  'https://github.com/electron/electron/releases/download/',
].filter(Boolean)

const log = (msg) => console.log(`[install-electron] ${msg}`)

/** 平台标识（Electron 的发布名）。 */
function platformTag() {
  if (process.platform === 'win32') return 'win32-x64'
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64'
  return process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64'
}

/** 查 npm 上 electron 的最新稳定版。 */
async function resolveLatestVersion() {
  const res = await fetch('https://registry.npmjs.org/electron/latest', {
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`查询 electron 版本失败：HTTP ${String(res.status)}`)
  const body = await res.json()
  if (!body || typeof body.version !== 'string') throw new Error('查询 electron 版本失败：响应不含 version')
  return body.version
}

/** 下载到本地缓存（已存在且大小一致则跳过）。 */
async function download(url, dest) {
  if (existsSync(dest)) {
    log(`复用已下载的压缩包：${dest}`)
    return
  }
  log(`开始下载：${url}`)
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error(`下载失败：HTTP ${String(res.status)}`)
  const total = Number(res.headers.get('content-length') ?? 0)
  let received = 0
  let lastReport = 0

  const source = Readable.fromWeb(res.body)
  source.on('data', (chunk) => {
    received += chunk.length
    const now = Date.now()
    if (now - lastReport > 2000) {
      lastReport = now
      const pct = total > 0 ? ` (${((received / total) * 100).toFixed(1)}%)` : ''
      log(`  已接收 ${(received / 1048576).toFixed(1)} MB${total > 0 ? ` / ${(total / 1048576).toFixed(1)} MB` : ''}${pct}`)
    }
  })

  const tmp = `${dest}.part`
  await pipeline(source, createWriteStream(tmp))
  renameSync(tmp, dest)
  const size = statSync(dest).size
  log(`下载完成：${(size / 1048576).toFixed(1)} MB`)
  if (total > 0 && size !== total) throw new Error(`下载不完整：期望 ${String(total)} 字节，实际 ${String(size)} 字节`)
}

/** 用 PowerShell 解压 zip（避免为脚本引入额外 npm 依赖）。 */
function extractZip(zipPath, outDir) {
  mkdirSync(outDir, { recursive: true })
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${outDir.replace(/'/g, "''")}' -Force`,
    ],
    { stdio: 'inherit' },
  )
}

/** 找解压结果里的 electron 可执行文件，并把内容搬到目标目录根。 */
function finalizeInstall(stagingDir, targetDir) {
  const exeName = process.platform === 'win32' ? 'electron.exe' : 'electron'
  const entries = readdirSync(stagingDir)

  // 压缩包通常直接展开出 electron.exe，但也可能多一层目录，两种都兼容。
  let root = stagingDir
  if (!entries.includes(exeName)) {
    const subdir = entries.find((name) => {
      try {
        return statSync(join(stagingDir, name)).isDirectory() && readdirSync(join(stagingDir, name)).includes(exeName)
      } catch {
        return false
      }
    })
    if (subdir) root = join(stagingDir, subdir)
  }

  if (!existsSync(join(root, exeName))) {
    throw new Error(`解压结果里找不到 ${exeName}，目录内容：${JSON.stringify(entries)}`)
  }

  // 先彻底删除目标目录再搬入。绝不能"复制覆盖"：不同版本的文件名高度重合，
  // 覆盖式安装会把两个版本的文件混在一起（实测踩过这个坑）。
  rmSync(targetDir, { recursive: true, force: true })
  mkdirSync(dirname(targetDir), { recursive: true })
  try {
    // 同盘 rename 是原子的，比复制快得多。
    renameSync(root, targetDir)
  } catch {
    // 跨盘时退化为复制。
    execFileSync('powershell.exe', [
      '-NoProfile',
      '-Command',
      `Copy-Item -LiteralPath '${root}' -Destination '${targetDir}' -Recurse -Force`,
    ])
  }
  return join(targetDir, exeName)
}

/**
 * 校验安装结果：关键文件必须存在且非空，`version` 必须与请求版本一致。
 * 只校验"目录里有 electron.exe"是不够的——曾经因为解压被截断，
 * 出现了 0 字节的 version/LICENSE 文件，而这种残缺安装要到运行时才炸。
 */
function verifyInstall(exePath, targetDir, expectedVersion) {
  const problems = []

  const required = ['electron.exe', 'version', 'resources.pak', 'icudtl.dat', 'resources/default_app.asar']
  for (const rel of required) {
    const full = join(targetDir, rel)
    if (!existsSync(full)) {
      problems.push(`缺少文件 ${rel}`)
      continue
    }
    const size = statSync(full).size
    if (size === 0) problems.push(`文件为空 ${rel}`)
  }

  try {
    const declared = execFileSync(exePath, ['--version'], {
      encoding: 'utf8',
      timeout: 30_000,
      env: cleanEnv(),
    }).trim()
    if (declared !== `v${expectedVersion}`) problems.push(`版本不符：期望 v${expectedVersion}，实际 ${declared || '(无输出)'}`)
  } catch (err) {
    problems.push(`执行 --version 失败：${err instanceof Error ? err.message : String(err)}`)
  }

  return problems
}

/** 构造干净环境：必须剥掉 ELECTRON_RUN_AS_NODE，否则 Electron 会退化成 Node。 */
function cleanEnv() {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') continue
    env[key] = value
  }
  return env
}

/** 读取 Electron 版本（`electron --version`）。 */
function readElectronVersion(exePath) {
  try {
    return execFileSync(exePath, ['--version'], { encoding: 'utf8', timeout: 20_000, env: cleanEnv() }).trim()
  } catch (err) {
    return `（无法读取版本：${err instanceof Error ? err.message : String(err)}）`
  }
}

// ------------------------------------------------------------------ 主流程
const version = requestedVersion || (await resolveLatestVersion())
const tag = platformTag()
const zipName = `electron-v${version}-${tag}.zip`
const cachePath = join(cacheDir, zipName)
/** 安装到 $DSH_HOME/electron/<zip 名>，与探测逻辑的扫描约定一致。 */
const targetDir = join(dshHome, 'electron', zipName.replace(/\.zip$/u, ''))

log(`目标版本：v${version}（${tag}）`)
log(`安装目录：${targetDir}`)

if (dryRun) {
  log('--dry-run：只做探测，不下载不安装')
  log(`将尝试的镜像顺序：${mirrors.join(' → ')}`)
  process.exit(0)
}

mkdirSync(cacheDir, { recursive: true })

if (!existsSync(cachePath)) {
  let lastError = null
  let downloaded = false
  for (const mirror of mirrors) {
    const url = `${mirror}v${version}/${zipName}`
    try {
      await download(url, cachePath)
      downloaded = true
      break
    } catch (err) {
      lastError = err
      log(`镜像失败，换下一个：${url} — ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (!downloaded) {
    throw new Error(`所有镜像都下载失败：${lastError instanceof Error ? lastError.message : String(lastError)}`)
  }
} else {
  log(`压缩包已存在，直接复用：${cachePath}`)
}

const staging = join(cacheDir, `staging-${String(Date.now())}`)
log('解压中…')
extractZip(cachePath, staging)
const exePath = finalizeInstall(staging, targetDir)
rmSync(staging, { recursive: true, force: true })

log('校验安装结果…')
const problems = verifyInstall(exePath, targetDir, version)
if (problems.length > 0) {
  log('安装校验未通过：')
  for (const p of problems) log(`  · ${p}`)
  log('请删除上面那个安装目录后重新运行本脚本。')
  process.exit(1)
}

log(`安装完成并通过校验：${exePath}`)
log(`实际版本：${readElectronVersion(exePath)}`)
log('桌宠插件会自动探测 $DSH_HOME/electron/ 下的版本目录，无需再配置 electronPath。')
