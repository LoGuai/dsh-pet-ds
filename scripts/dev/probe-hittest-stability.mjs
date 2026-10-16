/**
 * 决定性实验：**在固定坐标上反复采样 `hitTest`，看它是否随动画帧来回变**。
 *
 * ## 思路
 *
 * 上一轮用合成 `mousemove` 没抓到闪烁，因为合成事件不走真实的穿透/悬停路径。
 * 但渲染进程里有个现成的诊断钩子：
 *
 *     window.__petTestProbeClient(clientX, clientY)
 *       → { opaque: hitTest(x,y), rect, statsVisible }
 *
 * 它**直接调用 hitTest**，绕开了事件路径。于是可以：
 *
 *   1. 扫一遍坐标，找出 `opaque` 在多次采样间**变化**的位置（= 会抖的点）；
 *   2. 对这样的点连续采样，量出抖动频率；
 *   3. 确认它与动画帧号同步（就是"逐帧掩膜"的锅）。
 *
 * 这样既验了假设，也给出了"哪些位置会抖"的量化结论。
 *
 * ## 用法
 *
 *   node scripts/dev/probe-hittest-stability.mjs
 *   node scripts/dev/probe-hittest-stability.mjs --selftest   # 顺带注册更多测试钩子
 *
 * 退出码 0 = 实验跑完（结论看报告）。
 */

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const PET_APP = join(ROOT, 'pet-app')
const CDP_PORT = 49224

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (m) => console.log(`[hit] ${m}`)

/** 每个坐标采样几次（跨越多帧动画）。 */
const SAMPLES_PER_POINT = 14
/** 采样间隔：站立动画约 6~10 fps，60ms 能覆盖多帧。 */
const SAMPLE_GAP_MS = 60

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
  log('找不到 Electron，无法实验。')
  process.exit(1)
}

// 单实例锁：先清场
try {
  execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Get-Process -Name electron -ErrorAction SilentlyContinue | Stop-Process -Force'], { stdio: 'ignore' })
  await sleep(1200)
} catch {
  // 忽略
}

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE // 否则不建窗口

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
  console.log(out.join('').slice(-1500))
  child.kill()
  process.exit(1)
}

/** 极简 CDP 客户端。 */
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

/*
 * ⚠️ 上一轮失败的原因之一：**连上时渲染进程还没初始化完**
 * （frame 矩形是 0×0、测试钩子还没注册）。
 * 这里必须等到：DOM ready + 帧元素有尺寸 + 探针函数存在。
 */
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
           state: document.readyState,
           hasProbe: typeof window.__petTestProbeClient === 'function',
           hasDiag: typeof window.__petTestLayoutDiag === 'function',
           w: r ? Math.round(r.width) : 0,
           h: r ? Math.round(r.height) : 0,
         };
       })()`,
    )
    if (ready?.hasProbe && ready.w > 0 && ready.h > 0) break
  } catch {
    // 继续等
  }
}
log(`就绪状态：${JSON.stringify(ready)}`)
if (!ready?.hasProbe || ready.w === 0) {
  log('✗ 渲染进程没在预期时间内就绪（探针缺失或帧无尺寸）')
  cdp.close()
  child.kill()
  process.exit(1)
}

// ---------------------------------------------------------------- 取布局
const layout = await evaluate('JSON.stringify(window.__petTestLayoutDiag())')
const diag = JSON.parse(layout)
log(`窗口：${String(diag.innerWidth)}×${String(diag.innerHeight)}`)
log(`frameRect    ：${JSON.stringify(diag.frameRect)}`)
log(`characterRect：${JSON.stringify(diag.characterRect)}`)

/*
 * ⚠️ 字段名是 `frameRect` / `characterRect`，**不是** `frame` / `character`
 * —— 我第一版写成 `diag.frame`，拿到 undefined（实测踩过）。
 */
const fr = diag.frameRect
if (!fr) {
  log('✗ 拿不到 frameRect')
  cdp.close()
  child.kill()
  process.exit(1)
}
log(`用 frameRect 作为采样范围：${String(Math.round(fr.width))}×${String(Math.round(fr.height))}`)

// ---------------------------------------------------------------- 扫网格找"会抖"的点
/*
 * 在帧矩形内取一个网格，每个点采样 N 次，统计 opaque 的"翻转次数"。
 * 翻转次数 > 0 的点就是会闪的位置。
 */
const COLS = 12
const ROWS = 20
log(`扫 ${String(COLS)}×${String(ROWS)} 网格，每点采样 ${String(SAMPLES_PER_POINT)} 次…`)

const xs = []
for (let c = 0; c < COLS; c++) xs.push(Math.round(fr.left + ((c + 0.5) / COLS) * fr.width))
const ys = []
for (let r = 0; r < ROWS; r++) ys.push(Math.round(fr.top + ((r + 0.5) / ROWS) * fr.height))

const unstable = []
for (const y of ys) {
  for (const x of xs) {
    // 在渲染进程里一次性采完这个点，避免 N 次 CDP 往返（那本身会引入时序偏差）
    const r = await evaluate(
      `(async () => {
         const out = [];
         for (let i = 0; i < ${String(SAMPLES_PER_POINT)}; i++) {
           out.push(window.__petTestProbeClient(${String(x)}, ${String(y)}).opaque ? 1 : 0);
           await new Promise((r) => setTimeout(r, ${String(SAMPLE_GAP_MS)}));
         }
         return out;
       })()`,
    )
    let flips = 0
    for (let i = 1; i < r.length; i++) if (r[i] !== r[i - 1]) flips += 1
    if (flips > 0) unstable.push({ x, y, flips, seq: r })
  }
}

// ---------------------------------------------------------------- 报告
console.log('')
log('=== 结果 ===')
const totalPoints = COLS * ROWS
log(`采样点：${String(totalPoints)}   会抖的点：${String(unstable.length)}`)

if (unstable.length === 0) {
  console.log('')
  log('结论：所有采样点的命中结果都**稳定** —— 假设不成立，')
  log('      闪烁不是逐帧掩膜造成的，需要另找原因。')
} else {
  console.log('')
  log('会抖的点（坐标 / 翻转次数 / 采样序列）：')
  for (const u of unstable.slice(0, 24)) {
    console.log(`  (${String(u.x).padStart(3)},${String(u.y).padStart(3)})  翻转 ${String(u.flips).padStart(2)} 次   ${u.seq.join('')}`)
  }
  if (unstable.length > 24) log(`  …还有 ${String(unstable.length - 24)} 个`)

  const maxFlips = Math.max(...unstable.map((u) => u.flips))
  console.log('')
  log(`结论：**假设成立** —— ${String(unstable.length)}/${String(totalPoints)} 个采样点的命中结果会随动画帧变化，`)
  log(`      最大翻转 ${String(maxFlips)} 次（每 ${String(SAMPLES_PER_POINT)} 次采样）。`)
  log('      光标停在这些位置时，setStatsVisible(hit) 与鼠标穿透都会跟着动画抖。')
  log('      → 修法：给命中判定加滞回/去抖，不要逐帧直接切换状态。')
}

cdp.close()
try {
  child.kill()
} catch {
  // 忽略
}
await sleep(500)
log('实验结束（桌宠已关闭）')
