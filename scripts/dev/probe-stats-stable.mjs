/**
 * 验证滞回修复：**在不稳定坐标上驱动 `updateHitTest`，`statsVisible` 不应再抖**。
 *
 * ## 与上一个实验的区别
 *
 * `probe-hittest-stability.mjs` 用的是 `__petTestProbeClient`——它直接调
 * `hitTest()`，绕过 `updateHitTest`，所以**测的永远是原始命中值**
 * （修了也不会变）。它证明了"原始命中值会随帧抖"，那是**根因证据**。
 *
 * 这个脚本换成调 `updateHitTest`（经 `mousemove` 路径），再看 `statsVisible`：
 *  · 修复前：`statsVisible` 会跟着抖；
 *  · 修复后：滞回把它压住，`statsVisible` 保持稳定。
 *
 * ## 用法
 *
 *   node scripts/dev/probe-stats-stable.mjs
 *
 * 退出码 0 = 面板稳定（修复生效）。
 */

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const PET_APP = join(ROOT, 'pet-app')
const CDP_PORT = 49225

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (m) => console.log(`[stable] ${m}`)

/** 上一轮实验实测出的、最会抖的几个坐标（相对 frameRect 的左上角）。 */
const UNSTABLE_OFFSETS = [
  [83, 60],
  [99, 72],
  [8, 207],
  [159, 207],
  [129, 268],
  [23, 231],
]

/** 每个坐标采样几次（要跨多帧动画）。 */
const SAMPLES = 16
const GAP_MS = 70

function findElectron() {
  const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
  const dir = join(home, 'electron')
  if (!existsSync(dir)) return null
  for (const d of readdirSync(dir)) {
    if (!d.startsWith('electron-')) continue
    const exe = join(dir, d, process.platform === 'win32' ? 'electron.exe' : 'electron')
    if (existsSync(exe)) return exe
  }
  return null
}

const electron = findElectron()
if (!electron) {
  log('找不到 Electron')
  process.exit(1)
}

try {
  execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Get-Process -Name electron -ErrorAction SilentlyContinue | Stop-Process -Force'], { stdio: 'ignore' })
  await sleep(1200)
} catch {
  // 忽略
}

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(electron, [PET_APP, `--remote-debugging-port=${String(CDP_PORT)}`], {
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: false,
})
const out = []
child.stdout.on('data', (d) => out.push(String(d)))
child.stderr.on('data', (d) => out.push(String(d)))

let target = null
for (let i = 0; i < 50; i++) {
  await sleep(500)
  try {
    const res = await fetch(`http://127.0.0.1:${String(CDP_PORT)}/json/list`)
    target = (await res.json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
    if (target) break
  } catch {
    // 等
  }
}
if (!target) {
  log('调试端口没起来')
  console.log(out.join('').slice(-1200))
  child.kill()
  process.exit(1)
}

const cdp = await new Promise((res, rej) => {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  let id = 1
  const pending = new Map()
  ws.addEventListener('open', () =>
    res({
      send: (method, params = {}) =>
        new Promise((r2, j2) => {
          const myId = id++
          pending.set(myId, { r2, j2 })
          ws.send(JSON.stringify({ id: myId, method, params }))
        }),
      close: () => ws.close(),
    }),
  )
  ws.addEventListener('error', (e) => rej(new Error(String(e?.message ?? e))))
  ws.addEventListener('message', (ev) => {
    let m
    try {
      m = JSON.parse(String(ev.data))
    } catch {
      return
    }
    if (m.id && pending.has(m.id)) {
      const { r2, j2 } = pending.get(m.id)
      pending.delete(m.id)
      if (m.error) j2(new Error(JSON.stringify(m.error)))
      else r2(m.result)
    }
  })
})

async function evaluate(expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400))
  return r.result?.value
}

// 等就绪
log('等渲染进程初始化…')
let ready = null
for (let i = 0; i < 60; i++) {
  await sleep(500)
  try {
    ready = await evaluate(
      `(() => {
         const f = document.getElementById('frame');
         const r = f ? f.getBoundingClientRect() : null;
         return {
           hasProbe: typeof window.__petTestProbeClient === 'function',
           hasHyst: typeof window.__petTestHitHysteresis === 'function',
           w: r ? Math.round(r.width) : 0,
         };
       })()`,
    )
    if (ready?.hasProbe && ready.hasHyst && ready.w > 0) break
  } catch {
    // 继续
  }
}
log(`就绪：${JSON.stringify(ready)}`)
if (!ready?.hasHyst) {
  log('✗ 找不到 __petTestHitHysteresis —— 修复代码没生效？')
  cdp.close()
  child.kill()
  process.exit(1)
}

const diag = JSON.parse(await evaluate('JSON.stringify(window.__petTestLayoutDiag())'))
const fr = diag.frameRect
log(`frameRect：${JSON.stringify(fr)}`)
log(`滞回参数：${JSON.stringify(await evaluate('JSON.stringify(window.__petTestHitHysteresis())'))}`)

// ---------------------------------------------------------------- 逐点驱动
/*
 * 关键：这里**必须走 mousemove 事件**（才会经过 updateHitTest 里的滞回），
 * 不能用 __petTestProbeClient（它直接调 hitTest，绕过滞回）。
 */
console.log('')
log(`在不稳定坐标上派 mousemove，各 ${String(SAMPLES)} 次，记录 statsVisible…`)

let unstablePanels = 0
for (const [ox, oy] of UNSTABLE_OFFSETS) {
  const x = Math.round(fr.left + ox)
  const y = Math.round(fr.top + oy)
  const seq = await evaluate(
    `(async () => {
       const out = [];
       for (let i = 0; i < ${String(SAMPLES)}; i++) {
         window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: ${String(x)}, clientY: ${String(y)} }));
         await new Promise((r) => setTimeout(r, ${String(GAP_MS)}));
         out.push(window.__petTestProbeClient(${String(x)}, ${String(y)}).statsVisible ? 1 : 0);
       }
       return out;
     })()`,
  )
  let flips = 0
  for (let i = 1; i < seq.length; i++) if (seq[i] !== seq[i - 1]) flips += 1
  const mark = flips === 0 ? '✓ 稳定' : '✗ 仍在抖'
  if (flips > 0) unstablePanels += 1
  log(`  (${String(x).padStart(3)},${String(y).padStart(3)})  ${mark}  翻转 ${String(flips)} 次   ${seq.join('')}`)
}

// ---------------------------------------------------------------- 结论
console.log('')
if (unstablePanels === 0) {
  log(`✓ 修复生效：${String(UNSTABLE_OFFSETS.length)} 个原先会抖的坐标上，面板状态全部稳定。`)
} else {
  log(`✗ 仍有 ${String(unstablePanels)} 个坐标在抖 —— 滞回没压住，需要加大 HIT_CONFIRM_SAMPLES 或另找原因。`)
}

cdp.close()
try {
  child.kill()
} catch {
  // 忽略
}
await sleep(500)
log('结束')
process.exitCode = unstablePanels === 0 ? 0 : 1
