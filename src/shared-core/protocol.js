/**
 * 跨进程协议 —— 宿主侧（DSH 插件）与桌宠侧（Electron 进程）之间**唯一**的契约。
 *
 * 两端都 import 本文件，因此字段名不会漂移；协议带 `v` 版本号，
 * 将来做加减字段时可以据此协商。设计上刻意保持"窄"：
 *  - 桌宠拿到的只有余额**数字**与工作档位，**永远拿不到 API Key**。
 *  - 有副作用的操作走命令（command），且命令必须被消费一次即失效。
 */

/** 协议版本。任何不兼容改动都要 +1。 */
export const PROTOCOL_VERSION = 1

/** 端点路径常量，避免两端各写一遍字符串。 */
export const ROUTES = Object.freeze({
  health: '/health',
  state: '/state',
  command: '/command',
})

/**
 * @typedef {'thinking' | 'working' | 'organizing' | 'waiting' | 'success' | 'failure' | 'idle'} WorkStatus
 *
 * 工作档位语义（对应 DSH 的真实事件）：
 *  - thinking    模型正在产出推理文本（reasoning-delta）
 *  - working     模型正在产出正文（text-delta）
 *  - organizing  正在调用/整理工具（tool-call-delta）
 *  - waiting     agent 空闲但队列里还有待办
 *  - success     一轮收尾且无错误
 *  - failure     出现 agent/error
 *  - idle        无事发生
 */

/**
 * @typedef {object} BalanceSnapshot
 * @property {'account' | 'apikey' | 'none'} source 数据来源；'none' 表示两条路都不可用。
 * @property {boolean} isAvailable
 * @property {string}  currency     'CNY' | 'USD'
 * @property {string}  total        十进制字符串，**不是 number**（避免浮点误差）。
 * @property {string}  granted
 * @property {string}  toppedUp
 * @property {number}  fetchedAt    Unix ms。
 * @property {boolean} stale        是否已过期（超过 3 个刷新周期）。
 * @property {string|null} error    最近一次失败原因；成功时为 null。
 */

/**
 * 宿主 → 桌宠的状态快照。桌宠只读，不改。
 * @typedef {object} StateSnapshot
 * @property {number} v
 * @property {string} plugin
 * @property {string} version
 * @property {number} seq           单调递增；桌宠据此判断是否有新变化。
 * @property {number} serverTime
 * @property {WorkStatus} workStatus
 * @property {string} workLabel     可直接显示的档位文案。
 * @property {BalanceSnapshot|null} balance
 * @property {number} lowBalanceThreshold
 * @property {string|null} message  待播报的一句话（已被 command 消费的语义之外的单向消息）。
 * @property {boolean} online       宿主是否健康（用于桌宠显示离线态）。
 */

/**
 * 宿主 → 桌宠的命令。桌宠取走后执行一次；宿主不重发已消费的命令。
 * @typedef {object} Command
 * @property {number} id
 * @property {'quit' | 'say' | 'reload-config'} kind
 * @property {string} [text]
 */

/**
 * 桌宠 → 宿主的命令出参（POST /command）。
 * @typedef {object} CommandResult
 * @property {boolean} ok
 * @property {string} [error]
 */

/**
 * 桌宠取状态时通过 query 自报的信息 —— 这是宿主判断"桌宠还活着吗"的唯一可信来源。
 * @param {URLSearchParams} params
 * @returns {{ pid: number|null, wait: number }}
 */
export function parseStateQuery(params) {
  const rawPid = Number(params.get('pid'))
  const rawWait = Number(params.get('wait'))
  return {
    pid: Number.isFinite(rawPid) && rawPid > 0 ? Math.floor(rawPid) : null,
    // 长轮询等待秒数，上限 60 秒，避免连接被中间层掐断。
    wait: Number.isFinite(rawWait) ? Math.min(60, Math.max(0, rawWait)) : 0,
  }
}

/**
 * 构造默认的空状态快照，保证两端字段永远齐全（避免 undefined 穿透到 UI）。
 * @param {{ plugin: string, version: string, lowBalanceThreshold: number }} opts
 * @returns {StateSnapshot}
 */
export function emptySnapshot(opts) {
  return {
    v: PROTOCOL_VERSION,
    plugin: opts.plugin,
    version: opts.version,
    seq: 0,
    serverTime: Date.now(),
    workStatus: 'idle',
    workLabel: '',
    balance: null,
    lowBalanceThreshold: opts.lowBalanceThreshold,
    message: null,
    online: true,
  }
}
