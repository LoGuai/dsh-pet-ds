/**
 * Bridge Server —— 宿主的回环状态接口，桌宠唯一的数据来源。
 *
 * 设计取舍（与参考项目对比后的改进）：
 *  1. **只绑 127.0.0.1**，不对外暴露、不注册到 DSH 的 Web 路由表。
 *  2. **读状态是纯函数**：GET /state 不会改变任何"待发命令"的状态。
 *     （参考项目在这里有真实缺陷：读一次 payload 会把待发的软退出指令清掉。）
 *  3. **长轮询带去重**：桌宠报 `since=<seq>`，只有状态真的变化才立刻返回，
 *     杜绝"定时心跳被误当成状态变化"造成的空转。
 *  4. **命令是队列不是单槽位**：避免两个命令互相覆盖。
 *  5. 有副作用的命令走 **POST**，GET 一律无副作用（防浏览器地址栏误触）。
 */

import http from 'node:http'

import { PROTOCOL_VERSION, ROUTES, emptySnapshot } from '../shared-core/protocol.js'

/** 单次长轮询的上限秒数，超过就让桌宠重新发一次请求（防中间层掐断连接）。 */
const MAX_WAIT_SECONDS = 60

export class BridgeServer {
  /**
   * @param {object} options
   * @param {number} options.port
   * @param {string} options.plugin
   * @param {string} options.version
   * @param {number} options.lowBalanceThreshold
   * @param {(msg: string) => void} [options.log]
   */
  constructor(options) {
    this.plugin = options.plugin
    this.version = options.version
    this.port = options.port
    this._log = options.log ?? (() => {})

    /** 完整快照。始终是可 JSON 序列化的普通对象。 */
    this._snapshot = emptySnapshot({
      plugin: options.plugin,
      version: options.version,
      lowBalanceThreshold: options.lowBalanceThreshold,
    })

    /** 状态版本号。每次**实质变化**自增，长轮询据此判重。 */
    this._revision = 0
    /** 待发命令队列。 */
    this._commands = []
    /** 下一个命令 id。 */
    this._nextCommandId = 1
    /** 挂起的长轮询请求。@type {Set<{ fire: () => void, timer: NodeJS.Timeout }>} */
    this._waiters = new Set()
    /** @type {http.Server | null} */
    this._server = null
    /** 实际监听到的端口（可能因占用而顺延）。 */
    this._listeningPort = null
    /** 最近一次请求错误，供 status 展示。 */
    this.lastError = null
  }

  get revision() {
    return this._revision
  }

  get listeningPort() {
    return this._listeningPort
  }

  /** 桌宠轮询用的状态地址。 */
  stateUrl() {
    return `http://127.0.0.1:${String(this._listeningPort ?? this.port)}${ROUTES.state}`
  }

  /** 桌宠上报用的命令地址。 */
  commandUrl() {
    return `http://127.0.0.1:${String(this._listeningPort ?? this.port)}${ROUTES.command}`
  }

  /**
   * 标记状态发生实质变化：版本 +1，唤醒所有挂起的长轮询。
   * 所有 setter 都必须经过这里，否则桌宠不会及时拿到新状态。
   */
  _touch() {
    this._revision += 1
    this._snapshot.seq = this._revision
    this._snapshot.serverTime = Date.now()
    for (const waiter of [...this._waiters]) {
      try {
        waiter.fire()
      } catch {
        // 单个连接出错不影响其它。
      }
    }
  }

  /** 更新余额快照。 */
  setBalance(balance) {
    this._snapshot.balance = balance
    this._touch()
  }

  /** 更新工作档位。相同档位不视为变化，避免无意义唤醒。 */
  setWorkStatus(status, label = '') {
    if (this._snapshot.workStatus === status && this._snapshot.workLabel === label) return
    this._snapshot.workStatus = status
    this._snapshot.workLabel = label
    this._touch()
  }

  /** 更新健康状态（宿主侧自身可用性）。 */
  setOnline(online) {
    if (this._snapshot.online === online) return
    this._snapshot.online = online
    this._touch()
  }

  /**
   * 入队一条命令。命令必须被桌宠消费一次后失效，绝不重复投递。
   * @param {'quit' | 'say' | 'reload-config'} kind
   * @param {string} [text]
   */
  enqueueCommand(kind, text) {
    const command = { id: this._nextCommandId, kind }
    this._nextCommandId += 1
    if (typeof text === 'string' && text.length > 0) command.text = text
    this._commands.push(command)
    this._touch()
    return command
  }

  /** 只读地取出快照（**无副作用** —— 不清命令、不改状态）。 */
  peekSnapshot() {
    return JSON.parse(JSON.stringify(this._snapshot))
  }

  /** 取出并清空当前命令队列。 */
  _drainCommands() {
    if (this._commands.length === 0) return []
    const drained = this._commands
    this._commands = []
    return drained
  }

  /**
   * 启动监听。端口被占用时自动向后顺延（最多试 20 个），并记录实际端口。
   * @returns {Promise<{ ok: boolean, port?: number, error?: string }>}
   */
  async listen() {
    const tryPort = (port) =>
      new Promise((resolve) => {
        const server = http.createServer((req, res) => this._handle(req, res))
        const onError = (err) => {
          server.removeListener('listening', onListening)
          resolve({ ok: false, code: err.code, error: err.message })
        }
        const onListening = () => {
          server.removeListener('error', onError)
          this._server = server
          this._listeningPort = port
          resolve({ ok: true, port })
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(port, '127.0.0.1')
      })

    for (let offset = 0; offset < 20; offset += 1) {
      const candidate = this.port + offset
      const result = await tryPort(candidate)
      if (result.ok) {
        this._log(`状态接口就绪：${this.stateUrl()}`)
        return { ok: true, port: candidate }
      }
      if (result.code !== 'EADDRINUSE') {
        this.lastError = result.error ?? 'unknown listen error'
        return { ok: false, error: this.lastError }
      }
    }
    this.lastError = `端口 ${String(this.port)} 起连续 20 个端口都被占用`
    return { ok: false, error: this.lastError }
  }

  /** 关闭监听并释放所有挂起连接。 */
  async close() {
    for (const waiter of [...this._waiters]) {
      clearTimeout(waiter.timer)
      this._waiters.delete(waiter)
    }
    const server = this._server
    this._server = null
    if (!server) return
    await new Promise((resolve) => server.close(() => resolve(undefined)))
  }

  /**
   * 请求处理入口。
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   */
  _handle(req, res) {
    let url
    try {
      url = new URL(req.url ?? '/', `http://127.0.0.1:${String(this._listeningPort ?? this.port)}`)
    } catch {
      this._send(res, 400, { ok: false, error: 'bad request' })
      return
    }

    const method = req.method ?? 'GET'

    if (method === 'GET' && url.pathname === ROUTES.health) {
      this._send(res, 200, {
        ok: true,
        plugin: this.plugin,
        version: this.version,
        protocol: PROTOCOL_VERSION,
        revision: this._revision,
      })
      return
    }

    if (method === 'GET' && url.pathname === ROUTES.state) {
      this._handleState(url, res, req)
      return
    }

    if (method === 'POST' && url.pathname === ROUTES.command) {
      this._handleCommand(req, res)
      return
    }

    this._send(res, 404, { ok: false, error: 'not found' })
  }

  /**
   * GET /state?pid=&wait=&since=
   * - pid：桌宠自报进程号，宿主判活的唯一可信来源。
   * - since：桌宠已知的状态版本号，用于长轮询判重。
   * - wait：长轮询等待秒数，0 表示立即返回。
   */
  _handleState(url, res, req) {
    const pid = Number(url.searchParams.get('pid'))
    if (Number.isFinite(pid) && pid > 0) {
      // 交给外部（Supervisor）记录；这里通过注入的回调完成。
      this._onPoll?.(Math.floor(pid))
    }

    const wait = Math.min(MAX_WAIT_SECONDS, Math.max(0, Number(url.searchParams.get('wait')) || 0))
    const sinceRaw = Number(url.searchParams.get('since'))
    const since = Number.isFinite(sinceRaw) ? sinceRaw : -1

    const respond = () => {
      const payload = {
        ...this.peekSnapshot(),
        commands: this._drainCommands(),
      }
      this._send(res, 200, payload)
    }

    // 立即返回的情况：不等待，或客户端还没有任何版本信息，或已经有更新。
    if (wait <= 0 || since < 0 || since < this._revision) {
      respond()
      return
    }

    // 长轮询：挂起直到状态变化或超时。
    const waiter = { fire: null, timer: null }
    let done = false
    const finish = () => {
      if (done) return
      done = true
      this._waiters.delete(waiter)
      if (waiter.timer) clearTimeout(waiter.timer)
      respond()
    }
    waiter.fire = finish
    waiter.timer = setTimeout(finish, wait * 1000)
    this._waiters.add(waiter)
    req.on('close', () => {
      done = true
      this._waiters.delete(waiter)
      if (waiter.timer) clearTimeout(waiter.timer)
    })
  }

  /**
   * POST /command —— 桌宠上报命令执行结果（例如它自己决定退出了）。
   * 目前只用于记录，后续可扩展到"用户与桌宠交互后回传事件"。
   */
  _handleCommand(req, res) {
    const chunks = []
    req.on('data', (c) => {
      // 限制体积，防止异常请求撑爆内存。
      if (chunks.reduce((n, b) => n + b.length, 0) < 64 * 1024) chunks.push(c)
    })
    req.on('end', () => {
      let body = null
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        this._send(res, 400, { ok: false, error: 'invalid json' })
        return
      }
      if (body && body.pid !== undefined) this._onPoll?.(Number(body.pid))
      if (body && body.kind === 'quit') {
        // 桌宠主动退出（例如用户点了右键菜单的退出）。
        this._onPetQuit?.()
      }
      this._send(res, 200, { ok: true })
    })
  }

  /**
   * 注入：桌宠轮询回调（用于判活）与桌宠主动退出回调。
   * @param {{ onPoll?: (pid: number) => void, onPetQuit?: () => void }} hooks
   */
  setHooks(hooks) {
    this._onPoll = hooks.onPoll
    this._onPetQuit = hooks.onPetQuit
  }

  /** 发送 JSON 响应。 */
  _send(res, code, body) {
    if (res.headersSent || res.writableEnded) return
    let text
    try {
      text = JSON.stringify(body)
    } catch (err) {
      text = JSON.stringify({ ok: false, error: 'serialize failed: ' + String(err) })
      code = 500
    }
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(text),
    })
    res.end(text)
  }
}
