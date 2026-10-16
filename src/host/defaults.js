/**
 * 插件配置的**运行时默认值** —— 独立成模块，便于单测。
 *
 * ## 与 `config-schema.js` 的分工（⚠️ 两者必须一致）
 *
 * 这里有**两份**默认值，各自有不同用途：
 *
 * | | 用途 |
 * |---|---|
 * | 本文件 `DEFAULTS` | **运行时回落**：`normalizeConfig()` 用它兜住非法/缺失的配置 |
 * | `config-schema.js` 的 `.default()` | **设置页显示**：DSH 表单读的是 schema 默认值 |
 *
 * 漂移了会出现"设置页显示 300、实际用 600"这种极难查的问题 ——
 * 所以 `scripts/dev/test-config-schema.mjs` 会**逐字段断言两者一致**，
 * 并把"两边字段集合相同"也钉住。
 *
 * 拆成两个文件而不是合并，是因为它们的**格式不同**：运行时这边是普通 JS 值，
 * schema 那边是 schemastery 表达式。合并会把 DSH 的包拖进纯数据模块，
 * 那样单测就跑不起来了。
 */

export const DEFAULTS = Object.freeze({
  /** 回环状态接口的起始端口；被占用时自动向后顺延。 */
  port: 47845,
  /** 显式指定 Electron 可执行文件；留空则自动探测。 */
  electronPath: '',
  /** 宿主启动后是否自动把桌宠叫起来。 */
  autoStart: true,
  /** 启动延迟，避开宿主 boot 高峰。 */
  startDelayMs: 3000,
  /** 打印桌宠子进程的输出，排障用。 */
  debug: false,
  /**
   * 宿主卸载（含 DSH 退出）时是否顺手关掉桌宠。
   *
   * ⚠️ 默认值从 `false` 改成了 **`true`**（用户要求："退出dsh时自动关闭"）。
   *
   * 原先默认 false 的理由是"桌宠是桌面常驻小玩意，宿主重启不该把它带走"。
   * 用户明确要求反过来：**退出 DSH 就关掉桌宠**。
   *
   * 这条路是可靠的：DSH 退出时会走 `app.current.fiber.dispose()`，
   * 那会执行本插件所有 `ctx.effect` 的清理器（已读 DSH 打包源码确认）。
   * 唯一的约束是它外面套着一个 **5 秒**的预算
   * （`PROCESS_SHUTDOWN_TIMEOUT_MS = 5e3`）—— 而桌宠用的是长轮询，
   * quit 命令基本能立即送达，所以这个预算足够。
   */
  stopOnUnload: true,
  /** 桌宠窗口宽度（CSS 像素）。高度按素材比例自动算。 */
  size: 260,
  /** 置顶。 */
  alwaysOnTop: true,
  /** 余额低于该值时进入"告急"档（面板据此变色）。 */
  lowBalanceThreshold: 10,
  /**
   * 余额**取数**周期（秒）—— 面板上那个数字多久刷新一次。用户指定 30 秒。
   *
   * ⚠️ 与 `refreshSeconds`（**播报**周期）是**两个独立的节奏**，不要合并：
   *   · 取数要密：否则面板"看着一直不变"（用户就是这么反馈的）；
   *   · 播报要疏：30 秒念一次会变成复读机，还会把一次消耗拆成好几段播报。
   *
   * 余额接口有限流，所以下限 5 秒。
   */
  balancePollSeconds: 30,
  /**
   * 余额**播报**周期（秒）。用户指定 5 分钟（300 秒）。
   *
   * 含义是"距上次播报不足这个时间就不播"—— 这段时间里的消耗会**累积**，
   * 到下一次到点时一次报出来（而不是每 30 秒报一次小额）。
   */
  refreshSeconds: 300,
  /** DeepSeek API 地址（可在自建/代理场景覆盖）。 */
  apiBase: 'https://api.deepseek.com',
  /** 读取 API Key 的凭据键名。 */
  credential: 'DEEPSEEK_API_KEY',
})
