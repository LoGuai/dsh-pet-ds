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

import { spawn, execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'

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
    /**
     * 余额"告急"阈值（元），下发给桌宠用 `--low-balance=` 接收。
     * 阈值是**用户配置**，宿主是唯一来源；桌宠不自己定。
     */
    this.lowBalanceThreshold = Number.isFinite(Number(options.lowBalanceThreshold))
      ? Number(options.lowBalanceThreshold)
      : 10
    /**
     * 余额刷新周期（秒），下发给桌宠用 `--balance-refresh=` 接收。
     *
     * **余额取数的主责在桌宠侧**（桌宠自己读凭据、自己直连接口、自己播报），
     * 所以"多久刷一次"必须由桌宠知道。宿主只是把用户配置透传下去。
     *
     * 下限 5 秒：接口有限流，更密没有意义；而且这个下限也方便开发期
     * 把它临时调小来观察刷新行为（不必改代码）。
     */
    this.balanceRefreshSeconds =
      Number.isFinite(Number(options.balanceRefreshSeconds)) && Number(options.balanceRefreshSeconds) >= 5
        ? Number(options.balanceRefreshSeconds)
        : 300
    this._log = options.log ?? (() => {})
    /**
     * 桌宠日志文件路径。
     *
     * **为什么默认就写文件**（而不是只在 debug 时才留日志）：
     *
     * 桌宠把日志写 stderr（`pet-app/main.js` 的 `log()`）。原先非 debug 模式下
     * 用 `stdio: 'ignore'`，这些日志**直接被丢弃** —— 于是"余额不更新"
     * 这类问题只能靠猜：看不到它有没有取到数、取到多少、失败在哪一步。
     * 我为了定位一次"余额不更新"，不得不自己拿相同参数另起一个副本才能看到日志，
     * 那不该是排障的常态。
     *
     * 现在**始终**把 stderr 落盘到 `<logDir>/pet.log`（超过 1 MB 轮转一次）。
     * 代价可忽略（日志很少），收益是任何异常都能事后查。
     */
    this.petLogPath = options.petLogPath ?? null

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

  /**
   * 把一行桌宠日志落盘（带时间戳），必要时轮转。
   *
   * 全程 try/catch：**日志失败绝不能影响桌宠本体**。
   * @param {string} line
   */
  _writePetLog(line) {
    if (!this.petLogPath) return
    try {
      const dir = dirname(this.petLogPath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      /* 超过 1 MB 就轮转一份 .1，避免长年运行把磁盘写满。 */
      if (existsSync(this.petLogPath) && statSync(this.petLogPath).size > 1024 * 1024) {
        try {
          renameSync(this.petLogPath, `${this.petLogPath}.1`)
        } catch {
          /* 轮转失败就继续追加，不做别的 */
        }
      }
      const stamp = new Date().toISOString().slice(11, 19)
      appendFileSync(this.petLogPath, `${stamp} ${line}\n`, 'utf8')
    } catch {
      /* 忽略：日志写入失败不影响桌宠 */
    }
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

  /**
   * 一个 pid 对应的进程**现在是否真的存在**。
   *
   * 用 `process.kill(pid, 0)`：信号 0 不真的发信号，只做存在性与权限检查。
   * pid 非法或进程已不存在会抛错 → 返回 false。
   *
   * ⚠️ 只看"我们自己的桌宠进程"是安全的：pid 来自桌宠在 `/state` 里的自报，
   * 或来自我们 spawn 的子进程。**绝不**拿它去判断别的进程。
   */
  _pidExists(pid) {
    const n = Number(pid)
    if (!Number.isInteger(n) || n <= 0) return false
    try {
      process.kill(n, 0)
      return true
    } catch {
      return false
    }
  }

  /**
   * 我们 spawn 的子进程句柄，**并且那个 pid 现在真的存在**。
   *
   * ⚠️ 为什么要额外查 pid，而不是只看 `_proc.exitCode === null`：
   * Node 的 `exitCode` 只有在 `'exit'` 事件抵达后才被填上。桌宠是被
   * `detached` 启动的，它的退出事件在某些路径下会晚到甚至不到 ——
   * 于是句柄看起来"还活着"，而进程其实早就没了。
   * 实测踩过：`stop` 报成功，紧接着 `start` 回 `already-running`，
   * 但系统里**一个 electron 进程都没有**。
   */
  _procAlive() {
    if (!this._proc) return false
    if (this._proc.exitCode !== null || this._proc.killed) return false
    return this._pidExists(this._proc.pid)
  }

  /**
   * 桌宠是否在跑 —— **唯一权威判据**。
   *
   * 规则：**一个 pid 只有在它现在真的存在时才算活。**
   *
   * 这是把原先三套互相冲突的信号收敛成一条的结果：
   *  · 子进程句柄（`exitCode`）—— 退出事件可能晚到甚至不到；
   *  · "最近 30 秒来轮询过"的窗口 —— 记录可能被污染的 pid 刷新；
   *  · 自报的 pid —— 原先完全不校验存在性。
   *
   * 三者各自都能单独说错话，合起来就出现"三个窗口都没有、却报 already-running"
   * 这种自相矛盾的状态。**过期就清掉记录**，让后续判断不被陈旧的窗口干扰。
   */
  isRunning() {
    if (this._procAlive()) return true

    // 句柄已失效 —— 顺手清掉，免得它继续参与判断。
    if (this._proc) this._proc = null

    if (!this.polledRecently()) return false

    // 自报 pid 不存在 → 窗口是陈旧的，清掉。
    if (!this._pidExists(this._lastPid)) {
      this._lastPollAt = 0
      this._lastPid = null
      return false
    }
    return true
  }

  /**
   * 当前有效的 pid。
   *
   * 与 `isRunning()` 共用同一条判据：**必须现在真的存在**。
   * 原先的实现只看"子进程句柄 + 轮询时间窗"，两者都可以单独说错话。
   * 于是可能返回一个早就死掉的 pid —— 那会让 `DSHpet_status` 报出一个
   * 查不到任何进程的号码（实测出现过 `pid 1` 这种明显荒谬的值，
   * 来自诊断请求里 `?pid=1` 污染）。
   */
  livePid() {
    if (this._proc && this._proc.exitCode === null && !this._proc.killed) {
      const p = this._proc.pid
      if (this._pidExists(p)) return p ?? null
      this._proc = null
    }
    if (this.polledRecently() && this._pidExists(this._lastPid)) return this._lastPid
    return null
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
      //
      // 余额告急阈值随启动参数下发：桌宠据此给面板换配色。
      // 放在应用目录**之后**，因为 Electron 要求应用路径必须是第一个非开关参数。
      const args = [
        this.petAppDir,
        `--low-balance=${String(this.lowBalanceThreshold)}`,
        `--balance-refresh=${String(this.balanceRefreshSeconds)}`,
        ...extraArgs,
      ]
      if (this.debug) args.push('--enable-logging')

      const child = spawn(this.electronPath, args, {
        detached: true,
        windowsHide: true,
        /*
         * **始终**接住 stderr（`pipe`），不再在非 debug 时用 `'ignore'`。
         *
         * 桌宠的 `log()` 全写 stderr；丢掉它就没法排障（见 petLogPath 的注释）。
         * 我们会**一直把管道读干**并落盘，所以不会因为缓冲区满而卡住子进程。
         * stdout 没有用途，保持 `'ignore'`。
         */
        stdio: ['ignore', 'ignore', 'pipe'],
        env,
        // 不要把 DSH 的 cwd 传给桌宠，避免影响它解析相对路径。
        cwd: this.petAppDir,
      })

      /*
       * 桌宠 stderr → 日志文件（始终）+ 宿主日志（debug 时）。
       *
       * ⚠️ 这里**必须**持续消费这个流：管道写满（约 64KB）会让桌宠的
       * `process.stderr.write` 阻塞，进而卡住它。所以即使不 debug 也要读，
       * 只是不往宿主日志里打。
       */
      if (child.stderr) {
        child.stderr.setEncoding?.('utf8')
        child.stderr.on('data', (chunk) => {
          const text = String(chunk)
          for (const raw of text.split(/\r?\n/)) {
            const line = raw.trimEnd()
            if (!line) continue
            this._writePetLog(line)
            if (this.debug) this._log(`[pet:err] ${line}`)
          }
        })
        child.stderr.on('error', () => {
          /* 读流出错不影响桌宠 */
        })
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
   * 请求停止桌宠 —— **并等到它真的消失**。
   *
   * ## 为什么要"等"
   *
   * 原先这里是**同步**的：下发 `quit` 命令后立刻返回，不等桌宠来取。
   * 而调用方（宿主卸载清理）紧接着就会 `process.exit()` ——
   * 命令还没被取走，宿主就没了，**桌宠留在桌面上变成孤儿**。
   * 实测确认过：开发宿主退出后桌宠仍在跑。
   *
   * 桌宠走的是 25 秒长轮询，而状态一变（队列里进了命令）服务端会立刻唤醒
   * 挂起的轮询，所以命令基本是**立即**送达的 —— 等它一会儿是划算的。
   * 但等不能无限等：DSH 给整个 dispose 的预算是 **5 秒**，
   * 所以超时后**硬杀兜底**。
   *
   * @param {() => boolean} requestSoftQuit 通过状态接口下发 quit 的回调
   * @param {object} [options]
   * @param {number} [options.softQuitTimeoutMs] 软退出最多等多久（默认 1500ms）
   * @returns {Promise<{ ok: boolean, status: 'stopped'|'quit-requested'|'not-running',
   *                     pid?: number|null, forced?: boolean, error?: string }>}
   */
  async stop(requestSoftQuit, options = {}) {
    const timeoutMs = Number.isFinite(Number(options.softQuitTimeoutMs))
      ? Math.max(200, Number(options.softQuitTimeoutMs))
      : 1500

    // 我们自己起的子进程：直接终止最可靠。
    if (this._procAlive()) {
      const pid = this._proc.pid
      const killed = this._terminate(pid)
      this._forget()
      this._log(killed ? `桌宠已关闭 pid=${String(pid)}` : `桌宠可能已提前退出 pid=${String(pid)}`)
      return { ok: true, status: killed ? 'stopped' : 'not-running', pid: pid ?? null }
    }

    // 不是我们起的（例如用户自己双击运行）→ 只能先软退出。
    if (this.polledRecently() && this._pidExists(this._lastPid)) {
      const pid = this._lastPid
      requestSoftQuit()
      const gone = await this._waitForExit(pid, timeoutMs)
      if (gone) {
        this._forget()
        return { ok: true, status: 'quit-requested', pid: pid ?? null }
      }
      // 软退出超时：硬杀兜底，否则宿主一退出它就成孤儿了。
      const killed = this._terminate(pid)
      this._forget()
      this._log(`软退出超时，已强制结束桌宠 pid=${String(pid)}（killed=${String(killed)}）`)
      return { ok: true, status: 'quit-requested', pid: pid ?? null, forced: true }
    }

    this._forget()
    return { ok: true, status: 'not-running' }
  }

  /**
   * 终止一个进程。
   *
   * Windows 上 `process.kill` 对 detached 子进程**不一定可靠**（实测：
   * 调用返回了但进程仍在跑），所以主用 `taskkill /F /T`。
   *
   * @returns {boolean} 是否成功发出了终止（不代表进程已消失）
   */
  _terminate(pid) {
    const n = Number(pid)
    if (!Number.isInteger(n) || n <= 0) return false
    try {
      if (process.platform === 'win32') {
        // /T 连同子进程（Electron 的 renderer/gpu 进程）一起结束。
        execFileSync('taskkill', ['/PID', String(n), '/T', '/F'], {
          stdio: 'ignore',
          timeout: 3000,
        })
      } else {
        process.kill(n, 'SIGTERM')
      }
      return true
    } catch {
      // taskkill 在进程已消失时会返回非 0 —— 那不算失败。
      return false
    }
  }

  /** 等一个 pid 消失，最多等 timeoutMs。 */
  async _waitForExit(pid, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (!this._pidExists(pid)) return true
      await new Promise((r) => setTimeout(r, 100))
    }
    return !this._pidExists(pid)
  }

  /** 清掉判活记录，让紧接着的 `start()` 能起来。 */
  _forget() {
    this._proc = null
    this._lastPollAt = 0
    this._lastPid = null
  }

  /** 运行状态摘要，供 DSHpet_status 工具展示。 */
  describe() {
    return {
      running: this.isRunning(),
      owned: this._procAlive(),
      pid: this.livePid(),
      lastPollAt: this._lastPollAt > 0 ? new Date(this._lastPollAt).toISOString() : null,
      electronPath: this.electronPath,
      petAppDir: this.petAppDir,
    }
  }
}
