/**
 * 信息窗口（语音库 / 关于）的 preload。
 *
 * ## 为什么单独一个 preload
 *
 * 桌宠主窗口的 `preload.js` 暴露的是**交互 API**（拖动、点击、调尺寸…），
 * 那些能力给一个"只读的信息窗口"是不需要的，也是风险面。
 * 这里只暴露两件事：**接收数据**、**请求关闭**。
 *
 * 数据由主进程在页面加载完成后 `send` 一次（见 main.js 的 openInfoWindow）——
 * 而不是让页面自己去要：窗口只有展示职责，不该知道数据从哪来。
 */

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('infoApi', {
  /**
   * 订阅要展示的数据。
   * @param {(payload: object) => void} handler
   */
  onData: (handler) => {
    if (typeof handler !== 'function') return
    ipcRenderer.on('info:data', (_event, payload) => {
      handler(payload && typeof payload === 'object' ? payload : {})
    })
  },

  /** 打开网址（更新日志里可能带链接）。主进程会校验协议，unsafe 的一律拒绝。 */
  openExternal: (url) => ipcRenderer.send('info:open-external', String(url ?? '')),

  /**
   * 让桌宠随机说一句当前可用的台词。
   *
   * 原来右键菜单里的「对话」被重做成「语音库」窗口了（用户指定的 8 项菜单里
   * 没有「对话」），但"听她说一句"这个功能不该消失 —— 它和"看语音库"
   * 正好是同一件事的两个方向，所以搬到这里。
   */
  sayRandom: () => ipcRenderer.send('info:say-random'),

  /** 关闭本窗口。 */
  close: () => ipcRenderer.send('info:close'),
})
