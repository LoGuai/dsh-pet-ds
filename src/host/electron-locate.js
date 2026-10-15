/**
 * Electron 运行时的定位。
 *
 * ⚠️ 重要环境约束（本机实测，务必遵守）：
 * **Electron 必须安装在会话工作区之外。**
 * 同一份二进制放在 `D:\electron-test\` 或 `%LOCALAPPDATA%\Temp\` 下可正常运行，
 * 放在工作区内（如 `D:\dsh\pet\node_modules\electron\dist\`）则启动即崩，
 * 报 `EXCEPTION_BREAKPOINT @ electron::fuses::IsLoadBrowserProcessSpecificV8SnapshotEnabled`。
 * 因此官方推荐让人把 Electron 装进项目 node_modules 的做法在这里**行不通**，
 * 本项目的正式位置是 `$DSH_HOME/electron/<版本>/`。
 *
 * 探测顺序（命中即用）：
 *   1. 显式配置的 electronPath
 *   2. 环境变量 DSH_PET_ELECTRON
 *   3. $DSH_HOME/electron/<版本>/  ← **本项目的正式位置**
 *   4. LOCALAPPDATA/electron/...（@electron/get 的官方缓存形态）
 *   5. 当前进程可执行文件所在目录（插件跑在 DSH 里时的备用线索）
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/** DSH 桌面版的默认安装目录（Windows）。 */
const DSH_DEFAULT_WIN_DIR = join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness')

/** 候选可执行文件名（不同平台）。 */
function exeNames() {
  if (process.platform === 'win32') return ['electron.exe']
  if (process.platform === 'darwin') return ['Electron.app/Contents/MacOS/Electron', 'electron']
  return ['electron']
}

/** 在一个目录里按候选名找可执行文件。 */
function probeDir(dir) {
  if (!dir) return null
  try {
    if (!existsSync(dir)) return null
    for (const name of exeNames()) {
      const candidate = join(dir, name)
      if (existsSync(candidate)) return candidate
    }
  } catch {
    // 探测失败按"没找到"处理。
  }
  return null
}

/**
 * 在根目录下一层子目录里找 Electron。
 * 同时覆盖两种落盘形态：
 *   · 手工安装：$DSH_HOME/electron/electron-v38.2.0-win32-x64/electron.exe
 *   · 官方缓存：$LOCALAPPDATA/electron/Cache/<sha256>/electron-v38.2.0-win32-x64.zip（不解压，跳过）
 * @param {string} root
 * @returns {string | null}
 */
function probeVersionedRoot(root) {
  if (!root || !existsSync(root)) return null
  // 先看根目录有没有直接放着可执行文件。
  const direct = probeDir(root)
  if (direct) return direct
  try {
    for (const entry of readdirSync(root)) {
      const sub = join(root, entry)
      try {
        if (!statSync(sub).isDirectory()) continue
      } catch {
        continue
      }
      const found = probeDir(sub)
      if (found) return found
    }
  } catch {
    // 忽略：探测失败不应影响插件加载。
  }
  return null
}

/**
 * 从当前进程的可执行文件反推 Electron 所在目录（最后手段）。
 *
 * 插件运行在 DSH 的 utility process 里时，`process.execPath` 就是
 * `.../DeepSeek Harness/DeepSeek Harness.exe`。注意该文件是**改造过的** Electron 载体，
 * 不接受标准 Electron 参数（把应用目录传给它会直接退出），所以它只能算线索、不能当运行时用。
 * 这里仅在没有其它候选时用于定位"DSH 安装根"，真正的运行时仍应取自 $DSH_HOME。
 * @returns {string | null}
 */
function dirFromOwnExecutable() {
  try {
    const exec = process.execPath
    if (!exec) return null
    const name = basename(exec).toLowerCase()
    if (name === 'electron.exe' || name === 'electron') return dirname(exec)
  } catch {
    // 忽略。
  }
  return null
}

/**
 * 解析 Electron 可执行文件路径。
 * @param {object} options
 * @param {string} [options.configured] 插件配置里的 electronPath。
 * @param {string} options.pluginRoot 插件根目录（含 package.json 的那一层）。
 * @param {string} [options.dshHome]   DSH_HOME，正式安装位置就在它下面的 electron/。
 * @returns {{ path: string, source: string } | null}
 */
export function resolveElectron(options) {
  const dshHome =
    options.dshHome || process.env.DSH_HOME || join(process.env.USERPROFILE ?? '', '.dsh')

  // 1) 显式配置
  if (options.configured) {
    const found = probeDir(options.configured)
    if (found) return { path: found, source: 'config' }
  }

  // 2) 环境变量
  const fromEnv = process.env.DSH_PET_ELECTRON
  if (fromEnv) {
    const found = probeDir(fromEnv)
    if (found) return { path: found, source: 'env:DSH_PET_ELECTRON' }
  }

  // 3) 正式位置：$DSH_HOME/electron/<版本>/
  const foundInHome = probeVersionedRoot(join(dshHome, 'electron'))
  if (foundInHome) return { path: foundInHome, source: 'dsh-home' }

  // 4) 官方 @electron/get 缓存
  const foundInCache = probeVersionedRoot(join(process.env.LOCALAPPDATA ?? '', 'electron'))
  if (foundInCache) return { path: foundInCache, source: 'electron-cache' }

  // 5) 当前进程自身所在目录（备用线索）
  const own = dirFromOwnExecutable()
  if (own) {
    const found = probeDir(own)
    if (found) return { path: found, source: 'own-executable' }
  }

  return null
}

/**
 * 给出人类可读的排查建议，用于 Electron 找不到时的报错文案。
 */
export function electronHelpText() {
  return [
    '找不到 Electron 运行时。执行下面任一方式安装（推荐第 1 种）：',
    '',
    '  1) 用项目自带脚本安装到 $DSH_HOME/electron/（唯一被验证可用的位置）：',
    '       node scripts/dev/install-electron.mjs --version 38.2.0',
    '',
    '  2) 在插件配置里设置 electronPath 指向 electron.exe；',
    '  3) 设置环境变量 DSH_PET_ELECTRON 指向 electron.exe。',
    '',
    '注意：不要把 Electron 放进项目目录（例如 node_modules/electron）。',
    '   本机实测，工作区目录内的 electron.exe 启动即崩（EXCEPTION_BREAKPOINT），',
    '   必须安装在工作区之外。详见 src/host/electron-locate.js 顶部说明。',
  ].join('\n')
}
