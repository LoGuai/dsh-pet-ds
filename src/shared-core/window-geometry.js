/**
 * 窗口几何计算 —— 纯函数，无副作用、不依赖 Electron。
 *
 * 单独抽出来是为了能真正被单测覆盖。这里的公式踩过坑：
 *
 *   e.screenX = 窗口左上角屏幕坐标 + e.clientX
 *
 * 这个等式本身没错，但**不能**由此推出"两次 clientX 之差就是窗口应移动的距离"。
 * 因为 clientX 的参考系是窗口自己，而我们每帧都在移动窗口：
 *
 *   第 1 次 mousemove：鼠标右移 10px，窗口没动 → clientX 报 110，算出 dx=10，窗口右移 10
 *   第 2 次 mousemove：鼠标没动，但窗口已右移 10px → 同一物理位置 clientX 只报 100
 *                     → 算出 dx=-10，窗口又左移 10  ← 正反馈震荡，表现为剧烈抖动
 *
 * 所以窗口位移必须用**屏幕绝对坐标**（screenX/screenY）算：
 *   窗口当前位置 = 拖拽开始时的窗口位置 + (当前鼠标屏幕坐标 − 开始时的鼠标屏幕坐标)
 */

/**
 * 计算拖拽过程中的窗口位置。
 *
 * @param {object} session 拖拽会话
 * @param {number} session.startWinX 拖拽开始时窗口的 x
 * @param {number} session.startWinY 拖拽开始时窗口的 y
 * @param {number} session.startMouseX 拖拽开始时鼠标的屏幕 x
 * @param {number} session.startMouseY 拖拽开始时鼠标的屏幕 y
 * @param {number} session.mouseX 当前鼠标的屏幕 x
 * @param {number} session.mouseY 当前鼠标的屏幕 y
 * @returns {{ x: number, y: number }}
 */
export function computeDragPosition(session) {
  const dx = session.mouseX - session.startMouseX
  const dy = session.mouseY - session.startMouseY
  return {
    x: Math.round(session.startWinX + dx),
    y: Math.round(session.startWinY + dy),
  }
}

/**
 * 由逻辑宽度算窗口物理尺寸。
 * 四舍五入保证**同一输入永远得到同一输出** —— 这是"尺寸对齐幂等"的前提。
 *
 * @param {number} width 逻辑宽度（CSS 像素）
 * @param {{ w: number, h: number }} aspect 素材宽高比
 * @param {{ min?: number, max?: number }} [limits]
 * @returns {{ width: number, height: number }}
 */
export function computeWindowSize(width, aspect, limits = {}) {
  const min = limits.min ?? 80
  const max = limits.max ?? 1200
  const clamped = Math.min(max, Math.max(min, Math.round(width)))
  const height = Math.round(clamped * (aspect.h / aspect.w))
  return { width: clamped, height: Math.min(max, Math.max(min, height)) }
}

/**
 * 把窗口限制在屏幕工作区内。
 * @param {{ x: number, y: number, width: number, height: number }} win
 * @param {{ x: number, y: number, width: number, height: number }} area 工作区
 * @returns {{ x: number, y: number }}
 */
export function clampIntoArea(win, area) {
  return {
    x: Math.min(Math.max(win.x, area.x), area.x + area.width - win.width),
    y: Math.min(Math.max(win.y, area.y), area.y + area.height - win.height),
  }
}
