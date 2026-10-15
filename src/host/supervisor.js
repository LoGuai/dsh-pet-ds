/**
 * Supervisor —— 桌宠进程的监管者：启动、就绪等待、判活、软退出、硬杀。
 *
 * 关键设计（每条都对应一个真实踩过的坑）：
 *  1. **必须剥掉 ELECTRON_RUN_AS_NODE**：DSH 自己是 Electron 的 utility process，
 *     它给子进程留了这个变量。若不剥掉，我们 spawn 的 Electron 会退化成纯 Node
 *     进程，根本不显示窗口。（本机已实测：该变量值为 "1"。）
 *  2. **detached + unref**：桌宠是桌面常驻小玩意，宿主重启不应把它带走。
 *  3. **判活靠 pid 自报 + 时间窗**，不只靠我们手里的子进程句柄 ——
 *     用户可能自己双击启动了桌宠，那种情况下我们并没有句柄。
 *  4. **停止优先软退出**（通过状态接口下发 quit 命令），软退出失败再硬杀，
 *     避免直接 kill 掉不是我们启动的进程。
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

/** 桌宠超过这么久没来取状态，就认为它已经关了。 */
const ALIVE_WINDOW_MS = 30_000

export class Supervisor {
  /**
   * @param {object} options
   * @param {string} options.petAppDir   Electron 应用的目录（含 package.json）。
   * @param {string} options.electronPath Electron 可执行文件路径。
   * @param {string} options.stateUrl    桌宠轮询的状态地址。
   * @param {string} options.commandUrl  桌宠上报命令结果的地址（预留给后续）。
   * @param {(msg: string) => void} [options.log]
   * @param {boolean} [options.debug]    为真时把桌宠子进程的 stdout/stderr 打到宿主日志。
   */
  constructor(options) {
    this.petAppDir = options.petAppDir
    this.electronPath = options.electronPath
    this.stateUrl = options.stateUrl
    this.commandUrl = options.commandUrl
    this.debug = Boolean(options.debug)
    this._log = options.log ?? (() => {})
    /**
     * 桌宠进程退出时的回调。
     * 用途之一：自检模式的桌宠跑完就退出，此时开发宿主必须能感知并一并收尾，
     * 否则会留下一个只监听端口、没有桌宠可服务的孤儿进程（实测踩过这个坑）。
     * @type {((info: { code: number|null, signal: string|null }) => void) | null}
     */
    this._onPetExit = options.onPetExit ?? null

    /** @type {import('node:child_process').ChildProcess | null} */
    this._proc = null
    /** 最近一次取状态的时间戳。 */
    this._lastPollAt = 0
    /** 最近一次自报的 pid。 */
    this._lastPid = null
  }

  /** 记录一次桌宠取状态（由 Bridge Server 在 /state 命中时调用）。 */
  notePoll(pid) {
    this._lastPollAt = Date.now()
    if (pid !== null) this._lastPid = pid
  }

  /** 桌宠是否在最近的时间窗内取过状态。 */
  polledRecently() {
    return this._lastPollAt > 0 && Date.now() - this._lastPollAt < ALIVE_WINDOW_MS
  }

  /** 我们 spawn 的子进程是否仍活着。 */
  _ownedAlive() {
    return Boolean(this._proc) && this._proc.exitCode === null && !this._proc.killed
  }

  /** 桌宠是否在跑：我们起的进程活着，或最近还在轮询。 */
  isRunning() {
    return this._ownedAlive() || this.polledRecently()
  }

  /**
   * 当前有效的 pid。
   * 注意：必须与 isRunning() 配套使用 —— 当 isRunning() 为真仅仅因为"最近在轮询"时，
   * this._proc 是 null，直接读 this._proc.pid 会抛 TypeError。
   */
  livePid() {
    if (this._ownedAlive()) return this._proc.pid ?? null
    return this.polledRecently() ? this._lastPid : null
  }

  /**
   * 启动桌宠。
   * @param {string[]} [extraArgs] 追加给桌宠进程的参数（开发期透传，如 --selftest）。
   * @returns {{ ok: boolean, status: 'started'|'already-running'|'missing'|'error', pid?: number|null, error?: string }}
   */
  start(extraArgs = []) {
    if (this.isRunning()) {
      return { ok: true, status: 'already-running', pid: this.livePid() }
    }

    if (!existsSync(this.electronPath)) {
      return { ok: false, status: 'missing', error: `找不到 Electron 可执行文件：${this.electronPath}` }
    }
    if (!existsSync(join(this.petAppDir, 'package.json'))) {
      return { ok: false, status: 'missing', error: `桌宠应用目录无效（缺 package.json）：${this.petAppDir}` }
    }

    try {
      // 关键：构造一份干净的环境。删掉会让 Electron 退化、以及会污染子进程的变量。
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      env.DSH_PET_STATE_URL = this.stateUrl
      env.DSH_PET_COMMAND_URL = this.commandUrl
      // Windows 上把 Electron 所在目录并入 PATH，便于它加载同目录的 dll。
      if (process.platform === 'win32') {
        env.PATH = `${join(this.electronPath, '..')}${delimiter}${env.PATH ?? ''}`
      }

      // 用标准 Electron 的参数形式：`electron <应用目录>`。
      // 注意不要用 `--app=<dir>` —— 那不是 Electron 的参数，会把应用目录当未知开关丢掉。
      const args = [this.petAppDir, ...extraArgs]
      if (this.debug) args.push('--enable-logging')

      const child = spawn(this.electronPath, args, {
        detached: true,
        windowsHide: true,
        stdio: this.debug ? ['ignore', 'pipe', 'pipe'] : 'ignore',
        env,
        // 不要把 DSH 的 cwd 传给桌宠，避免影响它解析相对路径。
        cwd: this.petAppDir,
      })

      if (this.debug && child.stdout && child.stderr) {
        child.stdout.on('data', (b) => this._log(`[pet:out] ${String(b).trimEnd()}`))
        child.stderr.on('data', (b) => this._log(`[pet:err] ${String(b).trimEnd()}`))
      }

      child.on('error', (err) => {
        this._log(`桌宠启动失败：${err.message}`)
        this._proc = null
      })
      child.on('exit', (code, signal) => {
        if (this.debug) this._log(`桌宠进程退出 code=${String(code)} signal=${String(signal)}`)
        this._proc = null
        // 通知外部（开发宿主据此收尾；生产环境里宿主不需要因此做任何事）。
        try {
          this._onPetExit?.({ code, signal })
        } catch (err) {
          this._log(`onPetExit 回调出错：${err instanceof Error ? err.message : String(err)}`)
        }
      })

      // 与宿主解绑：宿主退出不带走桌宠。
      child.unref()
      this._proc = child
      this._log(`桌宠已启动 pid=${String(child.pid)}`)
      return { ok: true, status: 'started', pid: child.pid ?? null }
    } catch (err) {
      return { ok: false, status: 'error', error: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * 请求停止桌宠。
   * @param {() => boolean} requestSoftQuit 通过状态接口下发 quit 的软退出回调；
   *        返回 true 表示桌宠不是我们启动的，已改走软退出。
   * @returns {{ ok: boolean, status: 'stopped'|'quit-requested'|'not-running', pid?: number|null, error?: string }}
   */
  stop(requestSoftQuit) {
    if (this._ownedAlive()) {
      const pid = this._proc.pid
      try {
        process.kill(pid)
        this._proc = null
        this._log(`桌宠已关闭 pid=${String(pid)}`)
        return { ok: true, status: 'stopped', pid: pid ?? null }
      } catch (err) {
        return { ok: false, status: 'stopped', error: err instanceof Error ? err.message : String(err) }
      }
    }

    if (this.polledRecently()) {
      // 不是我们启动的（例如用户自己双击运行）→ 只能软退出。
      requestSoftQuit()
      return { ok: true, status: 'quit-requested', pid: this._lastPid }
    }

    return { ok: true, status: 'not-running' }
  }

  /** 运行状态摘要，供 DSHpet_status 工具展示。 */
  describe() {
    return {
      running: this.isRunning(),
      owned: this._ownedAlive(),
      pid: this.livePid(),
      lastPollAt: this._lastPollAt > 0 ? new Date(this._lastPollAt).toISOString() : null,
      electronPath: this.electronPath,
      petAppDir: this.petAppDir,
    }
  }
}
