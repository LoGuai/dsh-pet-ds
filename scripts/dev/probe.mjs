/**
 * 自动化冒烟探针：验证"桌宠进程真的起来了，并且真的在跟宿主通信"。
 *
 * 为什么需要它：桌宠是个 GUI 进程，无法用普通断言验证。但有一个可靠的可观测证据——
 * 桌宠会**自报 pid** 来长轮询状态接口。只要在这份日志里看到它反复出现，
 * 就说明：Electron 起来了 → 窗口建好了 → 渲染进程跑起来了 → 取状态循环通了。
 *
 * 用法：
 *   node scripts/dev/probe.mjs
 * 退出码 0 = 通过，1 = 失败。
 */

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'

import { BridgeServer } from '../../src/host/bridge-server.js'
import { Supervisor } from '../../src/host/supervisor.js'
import { resolveElectron } from '../../src/host/electron-locate.js'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..', '..')
const petAppDir = join(pluginRoot, 'pet-app')

/** 观察窗口：足够覆盖 Electron 冷启动 + 至少两轮取状态。 */
const OBSERVE_MS = 22_000
/** 期望至少看到这么多次"取状态"（长轮询 25s，但首次会立即返回）。 */
const MIN_POLLS = 2

const log = (msg) => console.log(`[probe] ${msg}`)

const bridge = new BridgeServer({
  port: 47945, // 刻意避开默认端口，避免和正在运行的正式桌宠抢
  plugin: 'dsh-pet-ds',
  version: '0.1.0-probe',
  lowBalanceThreshold: 10,
  log,
})

/** 记录观察到的轮询。 */
const polls = []
bridge.setHooks({
  onPoll: (pid) => {
    polls.push({ pid, at: Date.now() })
  },
  onPetQuit: () => log('桌宠主动退出'),
})

const electron = resolveElectron({ pluginRoot, dshHome: process.env.DSH_HOME ?? '' })
if (!electron) {
  log('未找到 Electron 运行时，探针无法进行。')
  process.exit(1)
}

/**
 * 先把已在运行的桌宠清掉。
 *
 * 原因：桌宠有单实例锁，若已有一个实例在跑，探针新起的那个会立刻退出（退出码 0），
 * 表现为"桌宠自报 pid 失败""监管者判定不存活"这类难以理解的失败。
 * 探针要测的是"能不能起来"，所以必须先保证场地是空的。
 */
const preexisting = (() => {
  try {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        "(Get-Process -Name electron -ErrorAction SilentlyContinue | Measure-Object).Count",
      ],
      { encoding: 'utf8', timeout: 15_000 },
    )
    return Number(out.trim()) || 0
  } catch {
    return 0
  }
})()
if (preexisting > 0) {
  log(`检测到已有 ${String(preexisting)} 个 electron 进程在运行（多半是另一个桌宠实例）。`)
  log('桌宠有单实例锁，会导致本次探针新起的实例立刻退出 —— 先清理再继续。')
  try {
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        'Get-Process -Name electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue',
      ],
      { encoding: 'utf8', timeout: 20_000 },
    )
    await new Promise((r) => setTimeout(r, 2500))
    log('已清理。')
  } catch (err) {
    log(`清理失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

const supervisor = new Supervisor({
  petAppDir,
  electronPath: electron.path,
  stateUrl: bridge.stateUrl(),
  commandUrl: bridge.commandUrl(),
  debug: false,
  log,
})

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// ------------------------------------------------------------------ 开始
log(`Electron: ${electron.path}（来源 ${electron.source}）`)

const listenResult = await bridge.listen()
if (!listenResult.ok) {
  log(`回环接口启动失败：${listenResult.error}`)
  process.exit(1)
}
supervisor.stateUrl = bridge.stateUrl()
supervisor.commandUrl = bridge.commandUrl()
check('回环接口监听成功', true, bridge.stateUrl())

const startResult = supervisor.start()
check('桌宠进程已 spawn', startResult.ok, JSON.stringify(startResult))

// 观察期：期间主动制造一次状态变化，验证长轮询会被唤醒。
const kickTimer = setTimeout(() => {
  log('推送一次状态变化（工作档位）以唤醒长轮询')
  bridge.setWorkStatus('thinking', '思考中…')
}, 8_000)

await new Promise((resolve) => setTimeout(resolve, OBSERVE_MS))
clearTimeout(kickTimer)

// ------------------------------------------------------------------ 断言
const uniquePids = [...new Set(polls.map((p) => p.pid))]
check('桌宠自报 pid（说明渲染进程与取状态循环在跑）', uniquePids.length > 0, `pids=${JSON.stringify(uniquePids)}`)
check(`取状态次数 >= ${String(MIN_POLLS)}`, polls.length >= MIN_POLLS, `实际 ${String(polls.length)} 次`)

const info = supervisor.describe()
check('监管者判定桌宠存活', info.running, `running=${String(info.running)} owned=${String(info.owned)} pid=${String(info.pid)}`)

const snap = bridge.peekSnapshot()
check('状态快照含协议版本与 seq', snap.v === 1 && typeof snap.seq === 'number', `v=${String(snap.v)} seq=${String(snap.seq)}`)

// 验证"读状态无副作用"：连续读两次不应改变命令队列。
bridge.enqueueCommand('say', '探针测试台词')
const before = JSON.stringify(bridge.peekSnapshot())
bridge.peekSnapshot()
bridge.peekSnapshot()
const after = JSON.stringify(bridge.peekSnapshot())
check('读状态是纯函数（无副作用）', before === after)

// ------------------------------------------------------------------ 收尾
log('停止桌宠…')
try {
  const stopResult = supervisor.stop(() => bridge.enqueueCommand('quit'))
  log(`停止结果：${JSON.stringify(stopResult)}`)
  // 给硬杀一点时间落地。
  await new Promise((resolve) => setTimeout(resolve, 1500))
  check('桌宠已停止', !supervisor.describe().running || stopResult.status === 'stopped', JSON.stringify(stopResult))
} catch (err) {
  check('桌宠已停止', false, String(err))
}

await bridge.close()

const failed = results.filter((r) => !r.ok)
log(`结果：${String(results.length - failed.length)}/${String(results.length)} 通过`)
if (failed.length > 0) {
  for (const f of failed) log(`  失败项：${f.name} — ${f.detail ?? ''}`)
  process.exit(1)
}
process.exit(0)
