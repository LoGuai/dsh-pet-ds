/**
 * DSH 桌宠插件 · 宿主半侧入口。
 *
 * 职责边界（重要）：
 *   · 桌宠是一个独立的 Electron 透明窗口进程；本插件只监听回环地址、不对外暴露。
 *   · 桌宠被 spawn 成 detached 进程，宿主重启不会带走它（但退出 DSH 会，
 *     见 `stopOnUnload`）。
 *
 * ## 余额与凭据（这条改过，别照旧注释理解）
 *
 * 这里**曾经**写着"余额与凭据只留在这里，桌宠进程永远拿不到 API Key"。
 * 后来按用户要求把余额取数**搬到了桌宠侧**（桌宠自己读凭据文件、自己取数、
 * 自己播报）—— 这条边界的真实情况是：
 *
 *   · DSH 把 API Key **明文**存在 `$DSH_HOME/.credentials.yaml`，本机任何进程都能读，
 *     所以"密钥绝不进桌宠"从一开始就不是一条真实的安全边界；
 *   · 现在守的是另一条：**密钥只进各自的主进程，绝不进渲染进程**
 *     （渲染进程每帧都在跑页面代码，还有 CSS/图片，那才是真风险）。
 *
 * 宿主侧保留 `createBalanceFetcher` 只为 `DSHpet_balance` 工具按需查询，
 * 不设定时器、不播报（否则两边各播一遍，用户会听到两次）。
 *
 * 完整说明见 README 的「API 余额监控」一节。
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { defineTool } from '@deepseek-ai/dsh-tools'

import { BridgeServer } from './bridge-server.js'
import { Supervisor } from './supervisor.js'
import { electronHelpText, resolveElectron } from './electron-locate.js'
import { createBalanceFetcher } from './balance.js'
import { PROTOCOL_VERSION } from '../shared-core/protocol.js'
import {
  LABEL_THINKING,
  STATUS_IDLE,
  STATUS_THINKING,
  createWorkStatusTracker,
} from '../shared-core/work-status.js'

/**
 * 插件配置的 **schema**（schemastery）—— 定义在 `./config-schema.js`。
 *
 * 单独成模块是为了**能独立单测**：DSH 设置页里能看到哪些字段完全由它决定
 * （只有 `.volatile()` 的字段会出现在页面上），而"字段没出现"这种故障
 * 不报错、很难从现象反推。
 */
import { Config } from './config-schema.js'

/**
 * 插件配置的**运行时默认值** —— 定义在 `./defaults.js`。
 *
 * ⚠️ 它与 `config-schema.js` 里的 `.default()` 是**两份默认值**，
 * 分别服务"运行时回落"与"设置页显示"。`scripts/dev/test-config-schema.mjs`
 * 会逐字段断言两者一致，防止出现"设置页显示 300、实际用 600"这种漂移。
 *
 * ⚠️⚠️ **必须写成 `import`，不能写成 `export { DEFAULTS } from './defaults.js'`。**
 * 再导出（re-export）**不会在模块内创建本地绑定**，而 `normalizeConfig()`
 * 里要用 `{ ...DEFAULTS }` —— 于是会在 `apply()` 里抛 ReferenceError。
 *
 * 后果极其隐蔽：Loader 把异常记进**它自己的日志**（本机 DSH 没有日志文件），
 * 表现是插件**静默不加载** —— 模型工具消失、桥接端口不监听，
 * 而 `node --check` 只验语法、**抓不到未定义标识符**。这个坑真踩过。
 */
import { DEFAULTS } from './defaults.js'

export { Config, DEFAULTS }

export const name = 'dsh-pet-ds'

/**
 * 必需服务。
 *
 * `tools` 用于注册模型工具，`credentials` 用于按需查余额。
 * 用 inject 声明而不是直接读 ctx.xxx，Cordis 会等这些服务就绪后再调用 apply。
 *
 * ⚠️ 这里**刻意不声明 `settings`**。设置页要用它，但它是个可选服务：
 * 写在顶层 `inject` 里的话，一个没挂 settings 的部署会让**整个插件不激活** ——
 * 桌宠本体（窗口、余额、动作）就全废了。所以改成在 apply 里用
 * `ctx.inject(['settings'], child => ...)` 局部注入（见下方"设置页支持"）。
 * 这正是 DSH 官方规范要求的做法。
 */
export const inject = ['tools', 'credentials']

/**
 * 协议版本号 —— 会随桥接状态接口一起下发给桌宠。
 *
 * ⚠️ 必须与 `package.json` 的 `version` 保持一致。
 * `scripts/dev/test-manifest-deps.mjs` 会断言这一点：
 * 漂移了会出现"界面显示 0.1.0、包却是 0.1.2"这种对不上号的怪事，
 * 而排查时第一眼就会看这个号。
 */
const VERSION = '0.2.0'

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

  /*
   * ---------------------------------------------------------------- 设置页支持
   *
   * DSH 的设置页里，本插件的配置由**客户端**插件（`client/`）渲染，
   * 但"哪些字段可编辑"由这份宿主 schema 决定（只有 `.volatile()` 的会出现在页面上）。
   * 宿主这边只需要做一件事：告诉 settings 服务"**这个插件的设置页是自己画的**"。
   *
   * 为什么必须显式说这一句：settings 服务默认策略是 `autoGenerate: true`，
   * 意思是"客户端可以拿 schema 自己生成页面"。DSH 官方文档要求
   * "自带页面的插件要注册 `configure({ auto: false }, ctx.fiber)`"。
   * （附带发现：`autoGenerate` 在当前 DSH 版本里**没有任何客户端消费者** ——
   * 所有设置页都是插件手写的。这里仍然按官方要求注册，是为了语义正确、
   * 也为了将来真有渲染器时不会重复生成一份。）
   *
   * ⚠️ 两处细节很要紧：
   *
   * 1. **用 `ctx.inject(['settings'], child => ...)` 局部注入，不写进顶层 `inject`。**
   *    settings 是可选服务；写进顶层的话，一个没挂它的部署会让整个插件不激活 ——
   *    桌宠本体（窗口、余额、动作）就全废了。
   *
   * 2. **`configure` 要作为 effect 注册。** 官方原文：这样做之后
   *    "a late-loading or replaced Settings service picks the policy up"，
   *    也就是 settings 服务晚加载或被替换时策略仍然生效。
   */
  try {
    ctx.inject(['settings'], (child) => {
      try {
        child.effect(
          () => child.settings.configure({ auto: false }, ctx.fiber),
          'dsh-pet-ds: settings page policy',
        )
        say('已注册设置页策略（auto: false，页面由本插件的客户端渲染）')
      } catch (err) {
        say(`注册设置页策略失败（设置页会不可用，其它功能不受影响）：${errText(err)}`)
      }
    })
  } catch (err) {
    // 没有 settings 服务时 ctx.inject 的 child 不会执行 —— 这里兜住意外形状。
    say(`跳过设置页支持：${errText(err)}`)
  }

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
    // 余额**取数**周期透传给桌宠（面板刷新，默认 30 秒）。
    balancePollSeconds: cfg.balancePollSeconds,
    // 余额**播报**周期透传给桌宠（默认 300 秒）。
    balanceRefreshSeconds: cfg.refreshSeconds,
    /*
     * 桌宠日志文件。**始终**落盘 —— 桌宠的 log() 走 stderr，
     * 不落盘的话"余额不更新"这类问题完全无从观察（我是踩过才加的）。
     * 放在 DSH home 下，便于让用户直接发给我看。
     */
    petLogPath: dshHome ? join(dshHome, 'logs', 'dsh-pet-ds.log') : null,
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
   * ⚠️ **余额取数的主责已经搬到桌宠侧**（用户要求："让桌宠插件自身能实时自动
   * 更新余额监控，不需要进行别的操作"）。桌宠自己读 `$DSH_HOME/.credentials.yaml`
   * 拿密钥、自己直连接口、自己判断播报、自己推给渲染进程。
   *
   * 所以这里**不再定时拉取、也不再播报** —— 否则两个进程各拉一次、各播一次，
   * 用户会听到两遍、接口也会被多打一倍。留下这个 fetcher 实例只为
   * `DSHpet_balance` 工具服务：工具是用户显式查询，仍然需要能拿到数。
   *
   * 这么搬的收益：**改取数/播报逻辑只需重启桌宠，不用重启 DSH**；
   * 而且 DSH 没开时桌宠照样能显示余额。
   *
   * 取数算法本身在 `shared-core/balance.js`，**两边共用同一份**（没有复制），
   * 所以口径不会漂移。
   */
  const balance = createBalanceFetcher({
    refreshSeconds: cfg.refreshSeconds,
    apiBase: cfg.apiBase,
    credential: cfg.credential,
    log: say,
  })

  /**
   * 拉一次余额（**仅供 `DSHpet_balance` 工具**）。
   *
   * 顺带写进桥接快照：别的消费者（巡检脚本、将来的工具）仍能从
   * `/state` 读到余额，不必知道它实际是桌宠在维护。
   *
   * @param {boolean} [fresh] true = 忽略缓存强制刷新
   */
  const refreshBalance = async (fresh = false) => {
    try {
      const snap = await balance.get({
        resolveCredential: (nameKey) => ctx.credentials.resolve(nameKey),
        fresh,
      })
      bridge.setBalance(snap)
      return snap
    } catch (err) {
      // balance.get() 本身不 reject，这里是防御性的兜底。
      say(`余额查询异常（已忽略）：${errText(err)}`)
      return balance.peek()
    }
  }

  /*
   * 刻意**不**在启动时拉一次、也不设定时器：桌宠会自己取。
   * 宿主只在工具被调用时按需查询。
   */

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
      /*
       * ⚠️ 这里返回 Promise 是有意的：`stop()` 会**等到桌宠真的消失**
       * （软退出成功，或超时后强杀兜底）。
       *
       * 为什么必须等：DSH 退出时外面套着 5 秒预算
       * （`PROCESS_SHUTDOWN_TIMEOUT_MS`），而原先 `stop()` 是同步的 ——
       * 只把 quit 命令塞进队列就返回，紧接着进程就退出了，
       * **命令根本没送到桌宠**，桌宠留成孤儿（实测确认）。
       */
      try {
        return supervisor.stop(() => {
          bridge.enqueueCommand('quit')
        })
      } catch (err) {
        say(`关闭桌宠失败：${errText(err)}`)
      }
    }
    return undefined
  })

  // ------------------------------------------------- 工作状态联动（含"深度思考"）
  /*
   * 三档：`thinking`（深度求索中）/ `working`（干活中）/ `idle`。
   *
   * ⚠️ 历史：这里原先只发 working / idle，注释写着"细粒度档位放后续阶段" ——
   * 那个后续阶段一直没做，于是**真实 DSH 里永远不会触发深度思考动作**
   * （用户反馈"我开始思考之后，桌宠并没有同步播放深度思考动作"）。
   * 桌宠那边的状态机、素材、自测都齐了，唯独"没人告诉它该思考"，白做。
   *
   * 现在按 DSH 的模型流帧判定（见 shared-core/work-status.js）：
   *  · `reasoning-delta` → thinking（GUI 的"深度求索中…"就是它）；
   *  · `text-delta`      → working（开始写正文）；
   *  · 一轮里一旦开始写正文就不再回到 thinking，避免动作反复抽搐。
   */
  let userMsgAt = 0
  const workStatus = createWorkStatusTracker()
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
        if (running) {
          /*
           * 新一轮开始：先把档位切到"思考"。
           *
           * 为什么不是"等第一帧 reasoning 再说"：模型开口前有几百毫秒的静默，
           * 若这段不切，桌宠会先站一会儿再低头 —— 用户看起来就是"没同步"。
           * 真到了写正文的时候，`text-delta` 会把它切回 working。
           */
          workStatus.beginTurn()
          if (byUser) bridge.setWorkStatus(STATUS_THINKING, LABEL_THINKING)
        } else {
          bridge.setWorkStatus(STATUS_IDLE, '')
        }
      } catch (err) {
        say(`处理 agent/status 出错：${errText(err)}`)
      }
    })
    /*
     * 模型流帧：区分"思考"与"写正文"。
     *
     * 这里**不加 byUser 限制** —— 帧只在真的跑模型时才有，
     * 而且自动续跑时她也确实在思考，映射上去是对的。
     */
    ctx.on('agent/assistant-stream', (payload) => {
      try {
        const next = workStatus.acceptChunk(payload?.frame?.chunk)
        if (next) bridge.setWorkStatus(next.status, next.label)
      } catch (err) {
        say(`处理 agent/assistant-stream 出错：${errText(err)}`)
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
   * 两个周期都有下限 5 秒：余额接口有限流，配成 0.5 秒会把自己打限流，
   * 而且界面上根本看不出差别。上限 3600 秒（1 小时）—— 再长就不像"监控"了。
   *
   * `balancePollSeconds` = **取数**周期（面板刷新，默认 30）；
   * `refreshSeconds`       = **播报**周期（默认 300）。
   * 两者独立：合并会让面板显得一直不更新，或让播报变成每 30 秒一次的复读机。
   */
  const poll = Number(input.balancePollSeconds)
  if (Number.isFinite(poll) && poll >= 5 && poll <= 3600) out.balancePollSeconds = Math.floor(poll)
  else if (input.balancePollSeconds !== undefined) {
    say(
      `配置 balancePollSeconds 非法（${String(input.balancePollSeconds)}），已回落默认 ${String(DEFAULTS.balancePollSeconds)}`,
    )
  }

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
