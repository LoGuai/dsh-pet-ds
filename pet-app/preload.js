/**
 * 预加载脚本 —— 渲染进程与主进程之间唯一的通道。
 *
 * 遵循最小暴露原则：渲染进程拿不到 require、拿不到 ipcRenderer 本体，
 * 只能调用这里显式列出的几个方法。
 */

const { contextBridge, ipcRenderer } = require('electron')

/** 只允许这些频道从主进程推给渲染进程。 */
const INBOUND = [
  'pet:state',
  'pet:offline',
  'pet:say',
  'pet:reload-config',
  'pet:layout',
  /** 心情变化（属性面板用）。 */
  'pet:mood',
  /** 主进程要求播放某个动作（菜单入口触发）。 */
  'pet:play-action',
]

contextBridge.exposeInMainWorld('pet', {
  /** 取窗口初始信息（尺寸、置顶、最近一次状态）。 */
  getInitial: () => ipcRenderer.invoke('pet:get-initial'),

  /**
   * 拖拽开始。把按下那一刻的抓取偏移一并交给主进程，避免跟随启动时跳一下。
   * @param {number} x 光标屏幕 x（兜底诊断用）
   * @param {number} y 光标屏幕 y
   * @param {number} [offsetX] 光标相对窗口左上角的 x 偏移
   * @param {number} [offsetY] 光标相对窗口左上角的 y 偏移
   */
  dragStart: (x, y, offsetX, offsetY) => ipcRenderer.send('pet:drag-start', { x, y, offsetX, offsetY }),

  /**
   * 拖拽移动：上报鼠标的**屏幕绝对坐标**。
   * 刻意不传"相对窗口的位移" —— 窗口每帧都在动，相对坐标会形成反馈回路导致抖动。
   */
  dragTo: (x, y) => ipcRenderer.send('pet:drag-to', { x, y }),

  /** 拖拽结束：让主进程把窗口纠正回可见区域。 */
  dragEnd: () => ipcRenderer.send('pet:drag-end'),

  /**
   * 刻意**没有** resize 通道。
   * 窗口尺寸单向由主进程决定（见 pet:get-initial 的 logicalWidth），
   * 渲染进程没有任何途径改窗口尺寸 —— 曾经的回报式"尺寸对齐"是个正反馈闭环，
   * 在高 DPI 下会让窗口在拖拽时一点点变大。
   */

  /**
   * 逐像素命中测试的结果：光标下是透明像素时让窗口放行鼠标事件，
   * 这样角色周围的透明区域不会挡住桌面上的其他窗口。
   */
  setIgnoreMouse: (ignore) => ipcRenderer.send('pet:set-ignore-mouse', { ignore }),

  /** 请求调整桌宠尺寸（角色区域宽度，CSS 像素）。 */
  setSize: (petWidth) => ipcRenderer.send('pet:set-size', { petWidth }),

  /**
   * 互动一次（点击桌宠）：让主进程加心情。
   * 心情的数值与衰减归主进程管，因为它需要持久化到文件。
   */
  pet: () => ipcRenderer.send('pet:pet'),

  /**
   * 通知主进程"闲置随机动作已触发"，给它发心情奖励（10~30）。
   *
   * ⚠️ 只有**随机抽中**的动作才调这个 —— 菜单手动触发的动作不给奖励。
   * 分辨"随机还是手动"只有渲染进程做得到（它知道触发来源），
   * 所以由它来发这个信号，而不是让主进程去猜。
   *
   * @param {string} actionId 触发的动作 id（仅用于日志）
   */
  rewardAction: (actionId) => ipcRenderer.send('pet:action-reward', actionId),

  /** 请求触发指定动作（走主进程，与右键菜单同一条路径，避免两套逻辑）。 */
  triggerAction: (id) => ipcRenderer.send('pet:trigger-action', { id }),

  /** 弹出右键菜单。 */
  contextMenu: () => ipcRenderer.send('pet:context-menu'),

  /**
   * 订阅主进程推送。
   * 只接受白名单内的频道，且不把 event 对象暴露给页面（避免泄漏 sender）。
   * @param {string} channel
   * @param {(payload: unknown) => void} handler
   * @returns {() => void} 取消订阅
   */
  on: (channel, handler) => {
    if (!INBOUND.includes(channel)) {
      throw new Error(`pet.on: 未允许的频道 "${String(channel)}"`)
    }
    const wrapped = (_event, payload) => handler(payload)
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.removeListener(channel, wrapped)
  },
})
