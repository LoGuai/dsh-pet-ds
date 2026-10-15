/**
 * 开发用宿主模拟器（mock host）。
 *
 * 它不加载 DSH，只做两件事：
 *   1. 起一个和真实 BridgeServer 完全同源的回环状态接口（直接 import 同一份实现）；
 *   2. 用与真实 Supervisor 完全同源的方式拉起桌宠进程。
 *
 * 因此它是**开发与验收工具**，同时也是"桌宠不依赖 DSH 也能跑"的证明。
 * 阶段 3 起，所有桌宠侧的改动都可以先用它验证，不必反复重启 DSH。
 *
 * 用法：
 *   node scripts/dev/mock-host.mjs                     # 起宿主 + 桌宠
 *   node scripts/dev/mock-host.mjs --no-pet            # 只起宿主（配合手工启动桌宠调试）
 *   node scripts/dev/mock-host.mjs --debug             # 打开桌宠子进程输出
 *   node scripts/dev/mock-host.mjs --pet-arg --selftest  # 把额外参数透传给桌宠（如自检模式）
 *
 * 起来之后可以在浏览器 / curl 里试：
 *   curl http://127.0.0.1:47845/health
 *   curl "http://127.0.0.1:47845/state?pid=1"
 */

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { BridgeServer } from '../../src/host/bridge-server.js'
import { Supervisor } from '../../src/host/supervisor.js'
import { resolveElectron, electronHelpText } from '../../src/host/electron-locate.js'
import { buildBalanceAnnouncement } from '../../src/shared-core/balance-announce.js'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..', '..')
const petAppDir = join(pluginRoot, 'pet-app')

const argv = process.argv.slice(2)
const startPet = !argv.includes('--no-pet')
const debug = argv.includes('--debug')
/**
 * `--no-demo`：关掉下面那个"每 15 秒轮换假工作状态"的演示。
 *
 * 为什么需要它：那个轮换会周期性地把宿主状态从 idle 切成 thinking，
 * 而"宿主开始工作"正是**唤醒睡眠**的正规条件之一 —— 于是桌宠每 15 秒
 * 被合法地叫醒一次。排查"睡觉自己中断"时这会制造假象
 * （我一开始就以为睡眠状态机有 bug，其实是演示轮换干的事）。
 * 要验证睡眠是否稳定，必须能把这个干扰源关掉。
 */
const demoEnabled = !argv.includes('--no-demo')
const petArgs = argv.reduce((acc, item, index) => {
  if (item === '--pet-arg' && argv[index + 1]) acc.push(argv[index + 1])
  return acc
}, [])

const log = (msg) => console.log(`[mock-host] ${msg}`)

const bridge = new BridgeServer({
  port: 47845,
  plugin: 'dsh-pet-ds',
  version: '0.1.0-dev',
  lowBalanceThreshold: 10,
  log,
})

const electron = resolveElectron({ pluginRoot, dshHome: process.env.DSH_HOME ?? '' })
if (!electron) {
  log(`未找到 Electron 运行时：\n${electronHelpText()}`)
}

const supervisor = new Supervisor({
  petAppDir,
  electronPath: electron ? electron.path : '',
  stateUrl: bridge.stateUrl(),
  commandUrl: bridge.commandUrl(),
  debug,
  // 与 bridge 的阈值保持一致；Supervisor 会把它作为 `--low-balance=` 传给桌宠。
  lowBalanceThreshold: 10,
  log,
  onPetExit: ({ code, signal }) => {
    // 桌宠进程没了。生产环境里这很正常（用户自己关掉了桌宠），宿主不必收尾；
    // 但**开发宿主**必须收尾，否则会留下一个只监听端口、没有桌宠可服务的孤儿进程，
    // 而且它会占着端口让下一次启动失败。实测踩过这个坑。
    log(`桌宠进程已退出（code=${String(code)} signal=${String(signal)}），开发宿主一并关闭`)
    void shutdown(0)
  },
})

/** 收尾：停桌宠、关接口、退出。重复调用是安全的。 */
let shuttingDown = false
async function shutdown(code) {
  if (shuttingDown) return
  shuttingDown = true
  clearInterval(demoTimer)
  // 假余额定时器也要收掉，否则它会给一个已经关掉的桥接写消息。
  if (fakeBalanceTimer) clearInterval(fakeBalanceTimer)
  try {
    const result = supervisor.stop(() => bridge.enqueueCommand('quit'))
    log(`停止桌宠：${JSON.stringify(result)}`)
  } catch (err) {
    log(`停止桌宠出错：${String(err)}`)
  }
  await bridge.close()
  process.exit(code)
}

bridge.setHooks({
  onPoll: (pid) => supervisor.notePoll(pid),
  onPetQuit: () => {
    // 桌宠自己退出了（例如自检模式跑完）。此时开发宿主也应一并收尾，
    // 否则会留下一个只监听端口、没有桌宠可服务的孤儿进程。
    log('桌宠主动退出，开发宿主一并关闭')
    void shutdown(0)
  },
})

const listenResult = await bridge.listen()
if (!listenResult.ok) {
  log(`回环接口启动失败：${listenResult.error}`)
  process.exit(1)
}
supervisor.stateUrl = bridge.stateUrl()
supervisor.commandUrl = bridge.commandUrl()
log(`Electron: ${electron ? `${electron.path}（${electron.source}）` : '未找到'}`)

// 放一条初始状态，方便桌宠一上来就能显示点东西。
bridge.setWorkStatus('idle', '')

/**
 * 假余额 —— 用来目视确认下方那个**常驻余额面板**与**消费播报**是通的。
 *
 * 开发宿主没有真实 API Key（也不该有），所以这里给一个明确的**假值**。
 * 生产环境下余额由宿主的 balance.js 从官方接口取，与这里无关。
 *
 * 参数：
 *   `--no-balance`        不给余额，用来看"取不到数时面板显示 `--`"
 *   `--balance=23.45`     起始余额（默认 23.45）
 *   `--balance-step=-5`   每轮变化量（默认 0 = 不变）
 *   `--balance-every=5`   每几秒变一次（默认 5）
 *
 * 播报验证的用法：`--balance=23.45 --balance-step=-5` —— 每 5 秒余额掉 5 元，
 * 桌宠应当念"刚才花掉了¥5，还有¥18.45，有些吃紧。"（档位随余额下降而变）。
 * 传正值（`--balance-step=20`）可验证**充值不会被播报成消耗**。
 */
const balanceEnabled = !argv.includes('--no-balance')
const argValue = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  if (!hit) return dflt
  const n = Number(hit.slice(name.length + 3))
  return Number.isFinite(n) ? n : dflt
}
let fakeBalance = argValue('balance', 23.45)
const fakeBalanceStep = argValue('balance-step', 0)
const fakeBalanceEverySec = Math.max(1, argValue('balance-every', 5))

/** 组一份余额快照并写入桥接。 */
function pushFakeBalance() {
  bridge.setBalance({
    source: 'apikey',
    isAvailable: true,
    currency: 'CNY',
    total: fakeBalance.toFixed(2),
    granted: '0.00',
    toppedUp: fakeBalance.toFixed(2),
    fetchedAt: Date.now(),
    stale: false,
    error: null,
  })
}

if (balanceEnabled) {
  pushFakeBalance()
  log(`已放一条假余额（¥${fakeBalance.toFixed(2)}）；用 --no-balance 可关掉`)
  if (fakeBalanceStep !== 0) {
    log(`假余额每 ${String(fakeBalanceEverySec)} 秒变化 ${String(fakeBalanceStep)}（用来验证播报）`)
  }
}

/**
 * 假余额的定时变化。
 *
 * ⚠️ 这里**也走 `bridge.setMessage()`**，也就是与生产代码同一个播报通道 ——
 * 不是另写一套。这样开发宿主能真正验证"余额变化 → 一次性消息 → 桌宠念出来"
 * 这条链路，而不是只验证到余额面板更新。
 *
 * 用的是 `buildBalanceAnnouncement`（共享核心的纯逻辑），
 * 所以分档与"充值不算消耗"的行为与生产完全一致。
 */
let fakeBalanceTimer = null
if (balanceEnabled && fakeBalanceStep !== 0) {
  fakeBalanceTimer = setInterval(() => {
    const prev = fakeBalance
    fakeBalance = Math.max(0, fakeBalance + fakeBalanceStep)
    pushFakeBalance()
    const ann = buildBalanceAnnouncement({ prevTotal: prev, nextTotal: fakeBalance })
    bridge.setMessage(ann.text)
    log(`余额变化 ¥${prev.toFixed(2)} → ¥${fakeBalance.toFixed(2)}；播报：${ann.text}`)
  }, fakeBalanceEverySec * 1000)
}

if (startPet && electron) {
  const result = supervisor.start(petArgs)
  log(`启动桌宠：${JSON.stringify(result)}${petArgs.length ? `（额外参数 ${petArgs.join(' ')}）` : ''}`)
}

// 每 15 秒做一次"假的工作状态"轮换，用来目视确认气泡与档位切换是通的。
// ⚠️ 这会周期性触发"宿主开始工作"→ 唤醒睡眠，验证睡眠时请加 --no-demo。
let demoIndex = 0
const demoTicks = [
  { status: 'thinking', label: '思考中…' },
  { status: 'working', label: '干活中…' },
  { status: 'organizing', label: '整理中…' },
  { status: 'success', label: '完成！' },
  { status: 'idle', label: '' },
]
let demoTimer = null
if (demoEnabled) {
  demoTimer = setInterval(() => {
    const tick = demoTicks[demoIndex % demoTicks.length]
    demoIndex += 1
    bridge.setWorkStatus(tick.status, tick.label)
  }, 15_000)
  log('演示轮换已开启（每 15 秒切换一次假工作状态）；验证睡眠请加 --no-demo')
} else {
  log('演示轮换已关闭（--no-demo），宿主状态保持 idle')
}

process.on('SIGINT', () => {
  log('收到 Ctrl+C，退出')
  void shutdown(0)
})
process.on('uncaughtException', (err) => {
  log(`uncaughtException: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
})
process.on('unhandledRejection', (reason) => {
  log(`unhandledRejection: ${String(reason)}`)
})

log('就绪。按 Ctrl+C 退出。')
