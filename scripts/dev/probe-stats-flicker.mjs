/**
 * 用 **CDP（Chrome DevTools Protocol）** 给桌宠渲染进程注入合成鼠标事件，
 * 记录 `hit` / `statsVisible` / `ignore` 的连续变化 —— 用来复现并定位
 * "光标不在桌宠身上时属性面板闪烁"。
 *
 * ## 为什么走 CDP 而不是给 pet-app 加测试代码
 *
 * 这是**排查阶段**的实验：先用最小侵入的手段搞清真相。
 * 确认根因后再决定是加测试钩子还是直接修 —— 不要为了排查就把
 * 实验代码沉进生产文件里。
 *
 * ## 要观测的量
 *
 * 闪烁的本质是 `setStatsVisible(hit)` 里 `hit` 在**连续的两帧 mousemove** 之间
 * 反复 true/false。所以记录：
 *
 *   · `hit`            —— 逐像素命中结果（role: 变化的直接原因）
 *   · `statsVisible`   —— 面板可见性（role: 现象）
 *   · `ignore`         —— 鼠标穿透状态（role: 可能与 hit 互为因果）
 *   · `frameRect`      —— 帧元素矩形（role: hit 的换算基准；若它会变就是根因）
 *   · `animFrameIndex` —— 当前动画帧号（role: 逐帧掩膜是否错位的证据）
 *
 * ## 用法
 *
 *   node scripts/dev/probe-stats-flicker.mjs
 *
 * 退出码 0 = 跑完（不表示"没闪烁"，闪烁情况打印在报告里）。
 */

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const PET_APP = join(ROOT, 'pet-app')

/** 调试端口：刻意避开常用端口。 */
const CDP_PORT = 49222

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (m) => console.log(`[flicker] ${m}`)

// ---------------------------------------------------------------- 找 Electron
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
  log('找不到 Electron 运行时，无法进行实验。')
  process.exit(1)
}
log(`Electron: ${electron}`)

/*
 * ⚠️ 必须先清掉已在运行的桌宠 —— 它有单实例锁，
 * 第二个实例会立刻退出，实验就观测不到任何东西。
 */
try {
  const out = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-Command', "(Get-Process -Name electron -ErrorAction SilentlyContinue | Measure-Object).Count"],
    { encoding: 'utf8' },
  )
  const n = Number(String(out).trim())
  if (n > 0) {
    log(`发现 ${String(n)} 个 electron 进程，先清掉（单实例锁）`)
    execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Get-Process -Name electron -ErrorAction SilentlyContinue | Stop-Process -Force'], { stdio: 'ignore' })
    await sleep(1500)
  }
} catch {
  // 忽略清理失败
}

// ---------------------------------------------------------------- 起桌宠（带调试端口）
/*
 * ⚠️ 不能继承 `ELECTRON_RUN_AS_NODE`：那会让 Electron 以纯 Node 模式启动、
 * 不建窗口（本机踩过）。
 */
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(electron, [PET_APP, `--remote-debugging-port=${String(CDP_PORT)}`], {
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: false,
})
const childOut = []
child.stdout.on('data', (d) => childOut.push(String(d)))
child.stderr.on('data', (d) => childOut.push(String(d)))

log(`桌宠已启动 pid=${String(child.pid)}，等调试端口就绪…`)

/** 等 CDP 的 /json 列表出现目标。 */
let target = null
for (let i = 0; i < 40; i++) {
  await sleep(500)
  try {
    const res = await fetch(`http://127.0.0.1:${String(CDP_PORT)}/json/list`)
    const list = await res.json()
    target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
    if (target) break
  } catch {
    // 还没起来
  }
}
if (!target) {
  log('调试端口没起来。子进程输出：')
  console.log(childOut.join('').slice(-2000))
  child.kill()
  process.exit(1)
}
log(`已连上调试目标：${target.url}`)

// ---------------------------------------------------------------- 极简 CDP 客户端
/** 一个够用就好的 CDP 客户端（WebSocket + 递增 id + Promise 排队）。 */
function connectCdp(wsUrl) {
  return new Promise((resolvePromise, reject) => {
    const ws = new WebSocket(wsUrl)
    let nextId = 1
    const pending = new Map()
    ws.addEventListener('open', () => {
      resolvePromise({
        send(method, params = {}) {
          const id = nextId++
          return new Promise((res, rej) => {
            pending.set(id, { res, rej })
            ws.send(JSON.stringify({ id, method, params }))
          })
        },
        close: () => ws.close(),
      })
    })
    ws.addEventListener('error', (e) => reject(new Error(`WS 错误: ${String(e?.message ?? e)}`)))
    ws.addEventListener('message', (ev) => {
      let msg
      try {
        msg = JSON.parse(String(ev.data))
      } catch {
        return
      }
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.error) rej(new Error(JSON.stringify(msg.error)))
        else res(msg.result)
      }
    })
  })
}

const cdp = await connectCdp(target.webSocketDebuggerUrl)

/** 求值一个表达式并取回值。 */
async function evaluate(expression) {
  const r = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })
  if (r.exceptionDetails) throw new Error(`求值失败: ${JSON.stringify(r.exceptionDetails).slice(0, 300)}`)
  return r.result?.value
}

// ---------------------------------------------------------------- 装探测器
/*
 * 探测器要抓的是"hit 在连续两次 mousemove 之间变化"。
 * 直接读内部变量不行（它们是模块作用域的），所以从**可观测的后果**入手：
 *  · statsVisible → 面板的 `hidden` 属性（DOM 可见）
 *  · ignore       → 主进程侧状态（这里用 window.pet.setIgnoreMouse 的调用次数代理）
 *
 * 另外把 `frameEl.getBoundingClientRect()` 每次 mousemove 都记下来 ——
 * 如果它会变，就是 hit 抖动的根因。
 */
const installed = await evaluate(`
(() => {
  if (window.__flickerProbe) return 'already';
  const rec = { moves: [], ignoreCalls: 0, panelToggles: 0 };
  window.__flickerProbe = rec;

  // 1) 数 setIgnoreMouse 的调用次数（渲染进程侧的出口）
  if (window.pet && typeof window.pet.setIgnoreMouse === 'function') {
    const orig = window.pet.setIgnoreMouse.bind(window.pet);
    window.pet.setIgnoreMouse = (v) => { rec.ignoreCalls += 1; return orig(v); };
  }

  // 2) 监听面板 hidden 属性的变化（现象侧）
  const panel = document.getElementById('stats-panel') || document.querySelector('.stats-panel');
  if (panel) {
    rec.panelFound = true;
    let last = panel.hidden;
    rec.panelInitialHidden = last;
    new MutationObserver(() => {
      if (panel.hidden !== last) {
        last = panel.hidden;
        rec.panelToggles += 1;
        rec.moves.push({ t: Date.now(), kind: 'toggle', hidden: last });
      }
    }).observe(panel, { attributes: true, attributeFilter: ['hidden'] });
  } else {
    rec.panelFound = false;
  }

  // 3) 每次 mousemove 记录帧元素矩形 + 命中判定要用的量
  window.addEventListener('mousemove', (e) => {
    const f = document.getElementById('frame') || document.querySelector('.frame');
    let r = null;
    try { r = f ? f.getBoundingClientRect() : null; } catch { r = null; }
    rec.moves.push({
      t: Date.now(),
      kind: 'move',
      x: e.clientX, y: e.clientY,
      rect: r ? { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } : null,
    });
    if (rec.moves.length > 4000) rec.moves.splice(0, 2000);
  }, true);

  return 'installed';
})()
`)
log(`探测器：${String(installed)}`)

const panelInfo = await evaluate('JSON.stringify({found: window.__flickerProbe.panelFound, initialHidden: window.__flickerProbe.panelInitialHidden})')
log(`面板：${String(panelInfo)}`)

// ---------------------------------------------------------------- 驱动合成鼠标
/** 派发一次合成 mousemove。 */
async function moveTo(x, y) {
  await evaluate(
    `window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: ${String(x)}, clientY: ${String(y)} })), true`,
  )
}

/** 读一次布局诊断（含 frame 矩形），用来选"透明处"与"角色处"。 */
const layout = await evaluate(
  `(() => {
     const d = typeof window.__petTestLayoutDiag === 'function' ? window.__petTestLayoutDiag() : null;
     const f = document.getElementById('frame') || document.querySelector('.frame');
     const r = f ? f.getBoundingClientRect() : null;
     return { diag: d, rect: r ? {l:r.left,t:r.top,w:r.width,h:r.height} : null };
   })()`,
)
log(`布局：${JSON.stringify(layout).slice(0, 300)}`)

// ---------------------------------------------------------------- 场景 1：光标停在透明处
/*
 * 选一个"在窗口内、但在角色之外"的点。窗口左上角通常就是透明区
 * （角色居中偏下，气泡区在上方）。
 */
console.log('')
log('=== 场景 A：把光标停在窗口左上角（透明区），连续派 mousemove，看面板是否来回切 ===')
await moveTo(2, 2)
await sleep(120)
const beforeA = await evaluate('JSON.stringify({toggles: window.__flickerProbe.panelToggles, ignoreCalls: window.__flickerProbe.ignoreCalls})')
log(`派发前：${String(beforeA)}`)

/*
 * 反复派同一个坐标 —— 这正是"光标不动"时 `forward: true` 会持续送回来的那种事件。
 * 若面板在这里来回切，说明 hit 不稳定（而不是"光标移动导致的正常切换"）。
 */
for (let i = 0; i < 40; i++) {
  await moveTo(2, 2)
  await sleep(50)
}
await sleep(300)
const afterA = await evaluate('JSON.stringify({toggles: window.__flickerProbe.panelToggles, ignoreCalls: window.__flickerProbe.ignoreCalls})')
log(`派发 40 次后：${String(afterA)}`)

// ---------------------------------------------------------------- 场景 2：光标停在角色上
console.log('')
log('=== 场景 B：光标移到角色中心，同样连续派 mousemove ===')
if (layout.rect) {
  const cx = Math.round(layout.rect.l + layout.rect.w / 2)
  const cy = Math.round(layout.rect.t + layout.rect.h / 2)
  const beforeB = await evaluate('JSON.stringify({toggles: window.__flickerProbe.panelToggles})')
  log(`派发前：${String(beforeB)}`)
  for (let i = 0; i < 40; i++) {
    await moveTo(cx, cy)
    await sleep(50)
  }
  await sleep(300)
  const afterB = await evaluate('JSON.stringify({toggles: window.__flickerProbe.panelToggles})')
  log(`派发 40 次后：${String(afterB)}`)
} else {
  log('拿不到帧矩形，跳过场景 B')
}

// ---------------------------------------------------------------- 取记录分析
console.log('')
log('=== 分析 ===')
const report = await evaluate(
  `(() => {
     const rec = window.__flickerProbe;
     const moves = rec.moves.filter((m) => m.kind === 'move');
     const toggles = rec.moves.filter((m) => m.kind === 'toggle');
     // 帧矩形是否变过
     const rects = new Set(moves.map((m) => m.rect ? [m.rect.l,m.rect.t,m.rect.w,m.rect.h].join(',') : 'null'));
     return {
       moveCount: moves.length,
       toggleCount: toggles.length,
       ignoreCalls: rec.ignoreCalls,
       distinctRects: [...rects].slice(0, 8),
       rectCount: rects.size,
       firstToggles: toggles.slice(0, 10).map((t) => ({ t: t.t, hidden: t.hidden })),
     };
   })()`,
)
console.log(JSON.stringify(report, null, 2))

// ---------------------------------------------------------------- 收尾
cdp.close()
try {
  child.kill()
} catch {
  // 忽略
}
await sleep(500)
log('实验结束（桌宠已关闭）')

console.log('')
log('结论怎么看：')
log('  · 场景 A 里 toggleCount 明显 > 2  → hit 在同一个坐标上不稳定，问题在渲染侧')
log('  · rectCount > 1                   → 帧元素矩形在变，hit 的换算基准不稳（可能的根因）')
log('  · ignoreCalls 很大                 → setIgnoreMouse 被反复调用（穿透状态在抖）')
