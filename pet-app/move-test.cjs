/**
 * 受控实验：只反复 setPosition，完全不涉及鼠标事件，看窗口会不会自己变大。
 *
 * 目的：把"拖拽"这个复合行为拆开，单独验证最可疑的那一个动作。
 *  · 若尺寸稳定 → 问题不在 setPosition，而在鼠标按下时的某条路径；
 *  · 若尺寸变大 → 就是 setPosition 在带 min/max 锁的透明窗上触发了系统重算尺寸。
 *
 * 用法: electron pet-app --move-test=<次数>
 */

const { app, BrowserWindow } = require('electron')

const MOVE_COUNT = (() => {
  const hit = process.argv.find((a) => a.startsWith('--move-test='))
  return hit ? Number(hit.slice('--move-test='.length)) : 40
})()

const log = (msg) => process.stderr.write(`[movetest] ${msg}\n`)

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 240,
    height: 431,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    skipTaskbar: true,
    show: true,
    webPreferences: { backgroundThrottling: false },
  })

  win.once('ready-to-show', () => {
    const sizes = []
    win.on('resize', () => {
      const [w, h] = win.getSize()
      sizes.push({ w, h })
    })

    const [w0, h0] = win.getSize()
    const [x0, y0] = win.getPosition()
    log(`起始 ${w0}x${h0} @ (${x0},${y0})`)

    // 锁死尺寸，和产品代码一致
    win.setResizable(false)
    win.setMinimumSize(w0, h0)
    win.setMaximumSize(w0, h0)
    log(`已锁定为 ${w0}x${h0}`)

    let i = 0
    const timer = setInterval(() => {
      i += 1
      if (i > MOVE_COUNT) {
        clearInterval(timer)
        const [w1, h1] = win.getSize()
        const [x1, y1] = win.getPosition()
        log(`结束 ${w1}x${h1} @ (${x1},${y1})`)
        log(`尺寸变化 ${w1 - w0}x${h1 - h0}；resize 事件 ${sizes.length} 次`)
        if (sizes.length) {
          const uniq = [...new Set(sizes.map((s) => `${s.w}x${s.h}`))]
          log(`出现过的尺寸: ${uniq.join(' → ')}`)
        }
        app.exit(0)
        return
      }
      // 只移动，不改尺寸。步长 6px，模拟拖拽的一帧。
      win.setPosition(x0 - i * 6, y0 - i * 6)
    }, 16)
  })

  win.loadURL('data:text/html,<body style="margin:0;background:transparent"></body>')
})
