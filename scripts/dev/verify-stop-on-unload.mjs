/**
 * 验证「宿主退出时能不能真的关掉桌宠」。
 *
 * 做法：起一个开发宿主（mock-host），等桌宠起来，然后调用监管者的
 * `stop()` —— 那正是 `stopOnUnload` 走的那条路 —— 看桌宠进程是否真的消失。
 *
 * 为什么必须实测：`stop()` 有两条分支（我们自己的子进程 / 不是我们的子进程），
 * 走的是不同机制（kill vs 下发 quit 命令）。哪条生效取决于桌宠是不是宿主起的，
 * 靠读代码判断不可靠。
 *
 * 运行：node scripts/dev/verify-stop-on-unload.mjs
 */

import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const NODE = process.execPath
const MOCK = new URL('./mock-host.mjs', import.meta.url).pathname.replace(/^\//, '')

/** 用 CIM 查桌宠进程（比 tasklist 好解析）。 */
async function listPetPids() {
  const { execFile } = await import('node:child_process')
  return new Promise((resolve) => {
    execFile(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { $_.CommandLine -like '*pet-app*' -and $_.CommandLine -notmatch '--type=' } | Select-Object -ExpandProperty ProcessId",
      ],
      (err, stdout) => {
        if (err) return resolve([])
        resolve(
          String(stdout)
            .split(/\r?\n/)
            .map((s) => Number(s.trim()))
            .filter((n) => Number.isInteger(n) && n > 0),
        )
      },
    )
  })
}

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) {
    passed += 1
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    failed += 1
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('起一个开发宿主（debug 打开，便于看它自己的日志）…')
const host = spawn(NODE, [MOCK, '--debug', '--no-demo'], { stdio: ['pipe', 'pipe', 'pipe'] })
let hostLog = ''
host.stdout.on('data', (b) => {
  hostLog += String(b)
})
host.stderr.on('data', (b) => {
  hostLog += String(b)
})

// 等桌宠起来（startDelayMs 3 秒 + 窗口创建）
let petPids = []
for (let i = 0; i < 30; i += 1) {
  await sleep(1000)
  petPids = await listPetPids()
  if (petPids.length > 0) break
}
check('开发宿主把桌宠叫起来了', petPids.length > 0, `pid=${petPids.join(',')}`)

if (petPids.length === 0) {
  console.log('\n桌宠没起来，后续断言无法进行。宿主日志尾部：')
  console.log(hostLog.split('\n').slice(-25).join('\n'))
  host.kill()
  process.exit(1)
}

// 让桌宠稳定下来（完成第一次轮询）
await sleep(6000)

/*
 * 模拟「宿主卸载」：让开发宿主走一遍它自己的完整退出流程。
 *
 * ⚠️ 两种错误做法都实测过，都会**测不出任何东西**（假失败）：
 *
 *  1. `process.kill(pid, 'SIGINT')` —— Windows 上**不会触发** Node 的
 *     'SIGINT' 处理器，子进程直接以 exitCode 1 结束（已用最小样例确认）；
 *  2. `taskkill`（不带 /F）—— 对无窗口的控制台程序同样不触发任何处理器。
 *
 * 所以用 **stdin** 作为退出触发通道（所有平台都可靠），
 * mock-host 收到一行 `quit` 就会走与 Ctrl+C 完全相同的 `shutdown()`。
 *
 * 这对应真实场景：DSH 优雅退出 → `fiber.dispose()` → 本插件的
 * `ctx.effect` 清理器 → `supervisor.stop()`。
 */
console.log('\n关闭开发宿主（模拟宿主卸载）…')
const { execFileSync } = await import('node:child_process')
try {
  host.stdin.write('quit\n')
} catch {
  // 已经退了也无所谓
}

// 给宿主时间跑完清理（DSH 给 dispose 的预算是 5 秒，这里宽松些）
let after = petPids
for (let i = 0; i < 20; i += 1) {
  await sleep(1000)
  after = await listPetPids()
  if (after.length === 0) break
}
check(
  '宿主退出后桌宠被一并关闭（stopOnUnload 生效）',
  after.length === 0,
  after.length === 0 ? '桌宠进程已消失' : `仍在跑：pid=${after.join(',')}`,
)

// 收尾：无论结果如何都不要留孤儿
if (after.length > 0) {
  for (const pid of after) {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore' })
    } catch {
      // 忽略
    }
  }
  console.log('  （已强制清理残留的桌宠进程）')
}
try {
  host.kill('SIGKILL')
} catch {
  // 忽略
}

console.log('\n宿主日志里的关闭/播报相关行：')
const interesting = hostLog
  .split('\n')
  .filter((l) => /关闭|停止|quit|桌宠进程退出|stopOnUnload|shutdown/i.test(l))
  .slice(-14)
for (const l of interesting) console.log('  ' + l.trim())

console.log(`\n结果：${String(passed)}/${String(passed + failed)} 通过`)
process.exit(failed > 0 ? 1 : 0)
