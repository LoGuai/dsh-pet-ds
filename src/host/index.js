/**
 * DSH 桌宠插件 · 宿主半侧入口。
 *
 * 职责边界（重要）：
 *   · 余额与凭据只留在这里 —— 桌宠进程永远拿不到 API Key，只拿到余额数字。
 *   · 桌宠是一个独立的 Electron 透明窗口进程；本插件只监听回环地址、不对外暴露，
 *     也不注册到 Web UI 的路由表。
 *   · 桌宠被 spawn 成 detached 进程，宿主重启/卸载不会关掉它（除非显式配置）。
 *
 * 本阶段（阶段 4 最小框架）只实现：插件的装载/卸载生命周期、回环桥接、
 * 桌宠进程的启停与判活、以及三个模型工具。余额与工作档位的真实数据
 * 由后续阶段接入，当前明确标注为"未接入"，不返回任何模拟数据。
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { defineTool } from '@deepseek-ai/dsh-tools'

import { BridgeServer } from './bridge-server.js'
import { Supervisor } from './supervisor.js'
import { electronHelpText, resolveElectron } from './electron-locate.js'
import { createBalanceFetcher } from './balance.js'
import { buildBalanceAnnouncement } from '../shared-core/balance-announce.js'
import { PROTOCOL_VERSION } from '../shared-core/protocol.js'

export const name = 'dsh-pet-ds'

/**
 * 必需服务。tools 用于注册模型工具，credentials 留给后续阶段的余额查询。
 * 用 inject 声明而不是直接读 ctx.xxx，Cordis 会等这些服务就绪后再调用 apply。
 */
export const inject = ['tools', 'credentials']

const VERSION = '0.1.0'

const DEFAULTS = Object.freeze({
  /** 回环状态接口的起始端口；被占用时自动向后顺延。 */
  port: 47845,
  /** 显式指定 Electron 可执行文件；留空则自动探测。 */
  electronPath: '',
  /** 宿主启动后是否自动把桌宠叫起来。 */
  autoStart: true,
  /** 启动延迟，避开宿主 boot 高峰。 */
  startDelayMs: 3000,
  /** 打印桌宠子进程的输出，排障用。 */
  debug: false,
  /** 宿主卸载时是否顺手关掉桌宠。默认 false：桌宠是桌面常驻小玩意。 */
  stopOnUnload: false,
  /**
   * 桌宠窗口宽度（CSS 像素）。高度默认按 1:1 取，后续接入立绘素材后改为按比例。
   * 名字里的"宠物"保持中文注释说明，配置键用英文。
   */
  size: 260,
  /** 置顶。 */
  alwaysOnTop: true,
  /** 余额低于该值时进入"告急"档（面板据此变色）。 */
  lowBalanceThreshold: 10,
  /**
   * 余额缓存与**刷新/播报**周期（秒）。用户指定 5 分钟（300 秒）。
   *
   * 余额接口有限流，不能轮询太密；而"每 5 分钟播报一次消费"本身就是需求，
   * 所以缓存时长与刷新周期**共用同一个值** —— 分两处设只会在它们不一致时
   * 产生"播报的其实是缓存、根本没重新取数"这类很难查的问题。
   */
  refreshSeconds: 300,
  /** DeepSeek API 地址（可在自建/代理场景覆盖）。 */
  apiBase: 'https://api.deepseek.com',
  /** 读取 API Key 的凭据键名。 */
  credential: 'DEEPSEEK_API_KEY',
})

/**
 * 插件入口。
 * @param {import('@deepseek-ai/plugin').Context} ctx Cordis 上下文
 * @param {Record<string, unknown>} config 来自 cordis.patch.yml 的 config 块
 */
export function apply(ctx, config) {
  /**
   * 统一的日志出口。宿主日志吞掉异常，绝不因为日志本身把宿主搞挂。
   * @param {string} msg
   */
  const say = (msg) => {
    try {
      if (typeof ctx.logger?.info === 'function') ctx.logger.info(`[dsh-pet-ds] ${msg}`)
      else console.log(`[dsh-pet-ds] ${msg}`)
    } catch {
      // 忽略日志失败。
    }
  }

  say('apply() 开始装载')

  const cfg = normalizeConfig(config, say)

  // ---------------------------------------------------------------- 路径解析
  // 用 import.meta.resolve 解析自身 package.json，从而可靠地拿到插件根目录。
  // 这样无论插件被 pnpm 链接到哪、路径里有没有空格或中文，都能正确定位。
  const pluginRoot = resolvePluginRoot()
  const petAppDir = join(pluginRoot, 'pet-app')
  const dshHome = process.env.DSH_HOME ?? ''

  // ---------------------------------------------------------------- 桥接服务
  const bridge = new BridgeServer({
    port: cfg.port,
    plugin: name,
    version: VERSION,
    lowBalanceThreshold: cfg.lowBalanceThreshold,
    log: say,
  })

  // ---------------------------------------------------------------- 进程监管
  const electron = resolveElectron({
    configured: cfg.electronPath,
    pluginRoot,
    dshHome,
    dshInstallRoot: process.env.DSH_INSTALL_ROOT,
  })

  const supervisor = new Supervisor({
    petAppDir,
    electronPath: electron ? electron.path : join(pluginRoot, 'runtime', 'electron', 'electron.exe'),
    stateUrl: bridge.stateUrl(),
    commandUrl: bridge.commandUrl(),
    debug: cfg.debug,
    lowBalanceThreshold: cfg.lowBalanceThreshold,
    log: say,
  })

  // 桌宠轮询时自报 pid，用于判活；桌宠主动退出时同步状态。
  bridge.setHooks({
    onPoll: (pid) => {
      if (Number.isFinite(pid) && pid > 0) supervisor.notePoll(pid)
    },
    onPetQuit: () => say('桌宠主动退出'),
  })

  // ------------------------------------------------------------ 监听与自启动
  // 注意：apply 里的异步工作必须自己 catch，不能让 rejection 逃逸成 unhandled rejection
  // ——那会被 DSH 判定为致命错误并直接退出宿主进程。
  let listening = false

  const listenTask = (async () => {
    try {
      const result = await bridge.listen()
      if (!result.ok) {
        say(`回环接口启动失败：${result.error ?? '未知原因'}（桌宠将无法获取状态）`)
        return
      }
      listening = true
      // 端口可能顺延，把真实地址同步给监管者。
      supervisor.stateUrl = bridge.stateUrl()
      supervisor.commandUrl = bridge.commandUrl()
    } catch (err) {
      say(`回环接口异常：${errText(err)}`)
    }
  })()

  // ---------------------------------------------------------------- 余额监控
  /*
   * 取数、缓存、错误处理都在 balance.js 里；这里只负责"定时拉一次并写进桥接快照"。
   *
   * 之所以定时任务放在宿主：桌宠是独立进程，它只通过回环接口读快照，
   * 从不直接碰 API Key（见 balance.js 开头的说明）。
   *
   * 刷新节奏与缓存时长一致（默认 60 秒）。`fresh: true` 强制刷新仅供
   * `DSHpet_balance` 工具用（用户显式要"现在这个数"时才绕过缓存）。
   */
  const balance = createBalanceFetcher({
    refreshSeconds: cfg.refreshSeconds,
    apiBase: cfg.apiBase,
    credential: cfg.credential,
    log: say,
  })

  /**
   * 上一次成功取到的余额（数字），用于算"这 5 分钟花掉多少"。
   *
   * `null` 表示还没成功取过 —— 首次不播报（没有可比的上一次），
   * 见下面 refreshBalance 里的说明。
   * @type {number | null}
   */
  let lastBalanceTotal = null

  /**
   * 拉一次余额并写入桥接快照。失败也写 —— 快照里带 error，界面能显示"取数失败"。
   *
   * 拿到新余额后顺带**算一次播报**（用户要求）：告诉桌宠这 5 分钟花掉多少、
   * 还剩多少、该说哪句台词。播报内容由 shared-core/balance-announce.js 计算 ——
   * 那是纯逻辑，有单测覆盖分档的每个边界。
   */
  const refreshBalance = async (fresh = false) => {
    try {
      const snap = await balance.get({
        resolveCredential: (nameKey) => ctx.credentials.resolve(nameKey),
        fresh,
      })
      bridge.setBalance(snap)

      /*
       * 只在**真的取到数**时才播报。
       *
       * `fetchedAt > 0` 表示拿到过至少一次成功结果；取数失败时它是上一次的时间戳，
       * 而 `error` 非空。这两种情况都不该播报 —— 否则用户会听到
       * "刚才花掉了¥0，还有¥0" 这种由故障产生的假话。
       */
      const ok = Boolean(snap) && snap.fetchedAt > 0 && snap.error === null
      if (ok) {
        const nextTotal = Number(snap.total)
        const ann = buildBalanceAnnouncement({
          // 首次成功取数时 prevTotal 为 null → 视为"没花"，只报剩余与档位。
          prevTotal: lastBalanceTotal,
          nextTotal,
          currency: snap.currency,
        })
        /*
         * ⚠️ 首次取数（lastBalanceTotal === null）**不播报**。
         *
         * 理由：那一次没有"上一次余额"可比，"花掉了 ¥0" 是无意义的噪音，
         * 而且桌宠刚启动就冒一句会显得突兀。从第二次起才有真实差值可报。
         */
        if (lastBalanceTotal !== null) {
          bridge.setMessage(ann.text)
          say(`余额播报：${ann.text}（${ann.kind}，${String(ann.tier)} 档）`)
        }
        if (Number.isFinite(nextTotal)) lastBalanceTotal = nextTotal
      }
      return snap
    } catch (err) {
      // balance.get() 本身不 reject，这里是防御性的兜底。
      say(`余额刷新异常（已忽略）：${errText(err)}`)
      return balance.peek()
    }
  }

  // 按 refreshSeconds 周期刷新。
  const balanceTimer = setInterval(() => {
    void refreshBalance()
  }, Math.max(5, cfg.refreshSeconds) * 1000)
  // 立刻拉一次（不阻塞 apply）。
  void refreshBalance()

  ctx.effect(() => () => {
    clearInterval(balanceTimer)
  })

  /** 自动启动桌宠。所有异常就地吞掉，不影响宿主。 */
  const autoStartPet = () => {
    try {
      if (!cfg.autoStart) return
      if (!electron) {
        say(`已跳过自动启动：找不到 Electron 运行时。${electronHelpText()}`)
        return
      }
      if (!existsSync(join(petAppDir, 'package.json'))) {
        say(`已跳过自动启动：桌宠应用目录不存在（${petAppDir}）`)
        return
      }
      const result = supervisor.start()
      if (!result.ok && result.status !== 'already-running') {
        say(`自动启动桌宠未成功：${result.error ?? result.status}`)
      }
    } catch (err) {
      say(`自动启动桌宠出错（已忽略）：${errText(err)}`)
    }
  }

  // 启动延迟：避开宿主 boot 高峰，也等桥接先监听好。
  const bootTimer = setTimeout(() => {
    void listenTask.then(() => {
      autoStartPet()
    })
  }, Math.max(0, cfg.startDelayMs))

  // ---------------------------------------------------------------- 清理
  // 每个 effect 都必须回收，否则重载插件会泄漏端口与定时器。
  ctx.effect(() => () => {
    clearTimeout(bootTimer)
  })
  ctx.effect(() => () => {
    // 关闭回环接口。异步操作就地 catch。
    void bridge.close().catch((err) => say(`关闭回环接口失败：${errText(err)}`))
  })
  ctx.effect(() => () => {
    if (cfg.stopOnUnload) {
      try {
        supervisor.stop(() => {
          bridge.enqueueCommand('quit')
        })
      } catch (err) {
        say(`关闭桌宠失败：${errText(err)}`)
      }
    }
  })

  // ------------------------------------------------- 工作状态的粗粒度联动
  // 本阶段只做"有事在跑 / 空闲"两档，用来验证事件通路是通的。
  // 细粒度档位（思考/工作/整理/等待/成功/失败）需要 agent/assistant-stream，
  // 放到后续阶段接入，且会先做运行时探针确认。
  let userMsgAt = 0
  try {
    ctx.on('agent/inbox/inserted', (payload) => {
      try {
        const role = payload?.message?.role
        if (!role || role === 'user') userMsgAt = Date.now()
      } catch (err) {
        say(`处理 agent/inbox/inserted 出错：${errText(err)}`)
      }
    })
    ctx.on('agent/status', (payload) => {
      try {
        const running = payload?.status === 'running'
        // 只有"用户消息进入 inbox 后 10 秒内变为 running"才算用户主动发起，
        // 避免自动续跑 / 子代理 / 定时任务误触发。
        const byUser = running && Date.now() - userMsgAt < 10_000
        if (byUser) bridge.setWorkStatus('working', '干活中')
        else if (!running) bridge.setWorkStatus('idle', '')
      } catch (err) {
        say(`处理 agent/status 出错：${errText(err)}`)
      }
    })
  } catch (err) {
    say(`注册 DSH 事件失败（工作状态联动将不可用）：${errText(err)}`)
  }

  // ---------------------------------------------------------------- 模型工具
  ctx.tools.register(
    defineTool({
      name: 'DSHpet_status',
      description:
        '查看桌面桌宠（DSH 桌宠插件）的运行状态：进程是否在跑、pid、Electron 运行时、状态接口地址、最近一次取状态时间。',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: String(value?.summary ?? '') }],
      },
      execute: async () => {
        const info = supervisor.describe()
        const lines = [
          `桌宠：${info.running ? `运行中（pid ${String(info.pid)}${info.owned ? '，由插件启动' : '，非插件启动'}）` : '未运行'}`,
          `最近一次取状态：${info.lastPollAt ? new Date(info.lastPollAt).toLocaleString('zh-CN') : '从未'}`,
          `状态接口：${listening ? bridge.stateUrl() : '未就绪'}`,
          `Electron：${electron ? `${electron.path}（来源：${electron.source}）` : '未找到'}`,
          `桌宠应用目录：${petAppDir}${existsSync(join(petAppDir, 'package.json')) ? '' : '（不存在）'}`,
        ]
        return {
          ok: true,
          running: info.running,
          owned: info.owned,
          pid: info.pid,
          lastPollAt: info.lastPollAt,
          listening,
          endpoint: listening ? bridge.stateUrl() : null,
          electronPath: electron ? electron.path : null,
          electronSource: electron ? electron.source : null,
          petAppDir,
          protocol: PROTOCOL_VERSION,
          summary: lines.join('\n'),
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'DSHpet_control',
      description:
        '控制桌面桌宠：start=叫起来（已在跑则返回 already-running）、stop=关掉、status=运行状态、say=让桌宠说一句话（弹出气泡）。桌宠是独立进程，宿主重启不会关掉它。',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['start', 'stop', 'status', 'say'],
          description: 'start / stop / status / say',
        },
        text: { type: 'string', description: 'action=say 时桌宠要说的话（建议 40 字以内）' },
        seconds: { type: 'number', description: 'action=say 时气泡停留秒数（默认 8）' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: String(value?.summary ?? '') }],
      },
      execute: async (args) => {
        const action = args?.action ?? 'status'
        try {
          if (action === 'start') {
            if (!electron) {
              return { ok: false, summary: `启动失败：找不到 Electron 运行时。\n${electronHelpText()}` }
            }
            const result = supervisor.start()
            return {
              ...result,
              summary: result.ok
                ? result.status === 'already-running'
                  ? `桌宠已经在跑了（pid ${String(result.pid)}）`
                  : `桌宠已启动（pid ${String(result.pid)}）`
                : `启动失败：${result.error ?? result.status}`,
            }
          }

          if (action === 'stop') {
            const result = supervisor.stop(() => {
              bridge.enqueueCommand('quit')
            })
            const text =
              result.status === 'stopped'
                ? `桌宠已关闭（pid ${String(result.pid)}）`
                : result.status === 'quit-requested'
                  ? `已向桌宠发送退出指令（pid ${String(result.pid)}，它不是本插件启动的）`
                  : '桌宠本来就没在跑'
            return { ...result, summary: result.ok ? text : `关闭失败：${result.error ?? ''}` }
          }

          if (action === 'say') {
            const text = String(args?.text ?? '').trim()
            if (!text) return { ok: false, summary: 'action=say 需要同时提供 text' }
            if (!supervisor.isRunning()) {
              return { ok: false, summary: '桌宠没在跑，先执行 DSHpet_control action=start' }
            }
            bridge.enqueueCommand('say', text)
            return { ok: true, summary: `已让桌宠说：「${text}」` }
          }

          // status
          const info = supervisor.describe()
          return {
            ok: true,
            ...info,
            listening,
            endpoint: listening ? bridge.stateUrl() : null,
            summary: [
              `桌宠：${info.running ? `运行中（pid ${String(info.pid)}）` : '未运行'}`,
              `状态接口：${listening ? bridge.stateUrl() : '未就绪'}`,
              `Electron：${electron ? electron.path : '未找到'}`,
            ].join('\n'),
          }
        } catch (err) {
          return { ok: false, summary: `操作失败：${errText(err)}` }
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'DSHpet_balance',
      description:
        '查询 DeepSeek 账户余额（桌宠下方那个常驻面板显示的同一个数）。默认走缓存（约 60 秒），fresh=true 可强制立即重新查询。',
      parameters: {
        fresh: { type: 'boolean', description: 'true=忽略缓存立即重新查询' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: String(value?.summary ?? '') }],
      },
      execute: async (input) => {
        const fresh = input?.fresh === true
        const snap = await refreshBalance(fresh)
        const ok = Boolean(snap) && snap.error === null && snap.fetchedAt > 0

        if (!ok) {
          return {
            ok: false,
            summary: [
              `余额查询失败：${snap?.error ?? '未知原因'}`,
              `数据源：凭据 ${cfg.credential} → GET ${cfg.apiBase}/user/balance`,
              `（凭据未配置时请在 DSH 里设置 ${cfg.credential}）`,
            ].join('\n'),
            balance: snap ?? null,
          }
        }

        const symbol = snap.currency === 'USD' ? '$' : '¥'
        const low = Number(snap.total) < cfg.lowBalanceThreshold
        return {
          ok: true,
          summary: [
            `余额 ${symbol}${snap.total} ${snap.currency}` +
              (low ? `（低于阈值 ${String(cfg.lowBalanceThreshold)}）` : ''),
            `其中赠金 ${snap.granted}、充值 ${snap.toppedUp}`,
            `取数时间 ${new Date(snap.fetchedAt).toLocaleString()}` +
              (snap.stale ? '（已过期）' : ''),
          ].join('\n'),
          balance: snap,
        }
      },
    }),
  )

  say(
    `插件已装载：回环端口 ${String(cfg.port)}，桌宠应用 ${petAppDir}，Electron ${
      electron ? `已就绪（${electron.source}）` : '未找到'
    }`,
  )
}

/**
 * 解析插件根目录。
 * 用 Node 的模块解析器定位自己的 package.json，比自己拼路径可靠
 * （pnpm 会做符号链接，安装路径也可能含空格或中文）。
 * @returns {string}
 */
function resolvePluginRoot() {
  try {
    const pkgUrl = import.meta.resolve('dsh-pet-ds/package.json')
    return dirname(fileURLToPath(pkgUrl))
  } catch {
    // 兜底：用本文件位置回推（src/host/index.js -> 插件根）。
    return join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  }
}

/**
 * 校验并归一化配置。非法值一律回落到默认值并记一条日志，
 * 绝不让错误配置导致插件加载失败（阶段 6 会改成 schema 硬校验）。
 * @param {unknown} raw
 * @param {(msg: string) => void} say
 */
function normalizeConfig(raw, say) {
  const input = raw && typeof raw === 'object' ? raw : {}
  /** @type {Record<string, unknown>} */
  const out = { ...DEFAULTS }

  const port = Number(input.port)
  if (Number.isFinite(port) && port > 0 && port < 65536) out.port = Math.floor(port)
  else if (input.port !== undefined) say(`配置 port 非法（${String(input.port)}），已回落默认 ${String(DEFAULTS.port)}`)

  const size = Number(input.size)
  if (Number.isFinite(size) && size >= 80 && size <= 1200) out.size = Math.floor(size)
  else if (input.size !== undefined) say(`配置 size 非法（${String(input.size)}），已回落默认 ${String(DEFAULTS.size)}`)

  const threshold = Number(input.lowBalanceThreshold)
  if (Number.isFinite(threshold) && threshold >= 0) out.lowBalanceThreshold = threshold

  /*
   * 余额相关配置。
   *
   * `refreshSeconds` 有下限 5 秒：余额接口有限流，配成 0.5 秒会把自己打限流，
   * 而且界面上根本看不出差别。上限 3600 秒（1 小时）—— 再长就不像"监控"了。
   */
  const refresh = Number(input.refreshSeconds)
  if (Number.isFinite(refresh) && refresh >= 5 && refresh <= 3600) out.refreshSeconds = Math.floor(refresh)
  else if (input.refreshSeconds !== undefined) {
    say(`配置 refreshSeconds 非法（${String(input.refreshSeconds)}），已回落默认 ${String(DEFAULTS.refreshSeconds)}`)
  }

  if (typeof input.apiBase === 'string' && input.apiBase.trim()) out.apiBase = input.apiBase.trim()
  if (typeof input.credential === 'string' && input.credential.trim()) out.credential = input.credential.trim()

  for (const key of ['autoStart', 'debug', 'stopOnUnload', 'alwaysOnTop']) {
    if (typeof input[key] === 'boolean') out[key] = input[key]
  }
  for (const key of ['electronPath']) {
    if (typeof input[key] === 'string') out[key] = input[key]
  }
  const delay = Number(input.startDelayMs)
  if (Number.isFinite(delay) && delay >= 0 && delay <= 60_000) out.startDelayMs = Math.floor(delay)

  return out
}

/** 统一的错误文本化，避免 [object Object]。 */
function errText(err) {
  return err instanceof Error ? err.message : String(err)
}
