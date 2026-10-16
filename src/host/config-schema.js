/**
 * 插件配置的 schema（schemastery）与默认值 —— **独立成模块**，便于单测。
 *
 * ## 为什么要有 schema —— DSH 设置页靠它工作
 *
 * DSH 的设置页表单是**从这份 schema 派生**的，而不是插件自己注册的：
 *  · 每个 loader 行（`id:`，本插件是 `dsh-pet-ds`）**自动**成为一个"设置命名空间"；
 *  · 条件是：该行的 fiber 处于 ACTIVE、`runtime.Config` 是 schemastery schema、
 *    **且至少有一个 `.volatile()` 字段**；
 *  · 表单里**只会出现标了 `.volatile()` 的字段**；写非 volatile 字段会被直接抛错
 *    （`Config field "x" is not volatile`）。
 *
 * 所以：想让某个配置出现在设置页上，就必须在这里声明它、并标 `.volatile()`。
 *
 * ## volatile 的语义（为什么它适合"改完立即生效"）
 *
 * volatile 字段的值能被 Loader**直接提交进运行中的 fiber**，不重新挂载插件。
 * 非 volatile 字段的改动走普通生命周期（可能 remount/restart）。
 * 桌宠这些参数都是"读一次就用"，标 volatile 最合适 —— 顺手也避免改个阈值
 * 就把宿主插件重挂一遍。
 *
 * ## 为什么只放这几个
 *
 * 设置页上只列**日常会调**的。像 `port`、`apiBase`、`credential`、`electronPath`
 * 这类"装错才会动、且改了要重启"的，标成非 volatile（在页面上不出现），
 * 仍然只能改 `cordis.patch.yml` —— 塞进常用设置栏只会干扰。
 *
 * ## ⚠️ 默认值必须与 `DEFAULTS` 一致
 *
 * 两边都是"默认值"，漂移了会出现"设置页显示 300、实际用 600"这种极难查的问题。
 * `scripts/dev/test-config-schema.mjs` 会逐字段断言两者一致。
 */

import z from '@deepseek-ai/schemastery'

/** UI 可编辑的字段（出现在设置页上）。单测据此断言 volatile 标记没有漏标/多标。 */
export const VOLATILE_FIELDS = Object.freeze([
  'autoStart',
  'startDelayMs',
  'stopOnUnload',
  'size',
  'alwaysOnTop',
  'lowBalanceThreshold',
  'refreshSeconds',
])

/** 只在 `cordis.patch.yml` 里改的字段（不出现在设置页上）。 */
export const NON_VOLATILE_FIELDS = Object.freeze([
  'port',
  'electronPath',
  'debug',
  'apiBase',
  'credential',
])

export const Config = z.object({
  /** 回环状态接口的起始端口。非 volatile：改了要重启才有意义。 */
  port: z
    .number()
    .min(1)
    .max(65535)
    .step(1)
    .default(47845)
    .description('桌宠回环状态接口的起始端口（被占用时自动向后顺延）。改动需重启 DSH。'),
  /** Electron 可执行文件路径。非 volatile。 */
  electronPath: z
    .string()
    .default('')
    .description('显式指定 Electron 可执行文件；留空则自动探测 $DSH_HOME/electron/。'),
  /** 宿主启动后是否自动把桌宠叫起来。 */
  autoStart: z.boolean().default(true).volatile().description('插件启用后自动把桌宠叫起来。'),
  /** 启动延迟（毫秒），避开宿主 boot 高峰。 */
  startDelayMs: z
    .number()
    .min(0)
    .max(60000)
    .step(100)
    .default(3000)
    .volatile()
    .description('自动启动的延迟（毫秒），用来避开 DSH 启动高峰。'),
  /** 打印桌宠子进程输出（排障用）。 */
  debug: z.boolean().default(false).description('把桌宠子进程的输出打到宿主日志，排障时打开。'),
  /** 宿主卸载（含 DSH 退出）时是否顺手关掉桌宠。 */
  stopOnUnload: z.boolean().default(true).volatile().description('退出 DSH 时一并关闭桌宠。'),
  /** 桌宠窗口宽度（CSS 像素）。 */
  size: z
    .number()
    .min(80)
    .max(1200)
    .step(20)
    .default(260)
    .volatile()
    .description('桌宠窗口宽度（CSS 像素），高度按素材比例自动算。'),
  /** 桌宠是否始终显示在最上层。 */
  alwaysOnTop: z
    .boolean()
    .default(true)
    .volatile()
    .description('让桌宠压在其他窗口之上；关掉后它就是普通窗口。'),
  /** 余额低于该值时面板转"告急"配色。 */
  lowBalanceThreshold: z
    .number()
    .min(0)
    .default(10)
    .volatile()
    .description('余额低于此值时，桌宠下方的余额面板转为"告急"配色。'),
  /** 余额刷新与播报周期（秒）。下限 5：接口有限流。 */
  refreshSeconds: z
    .number()
    .min(5)
    .max(3600)
    .step(1)
    .default(300)
    .volatile()
    .description('余额刷新与消费播报的周期（秒）。下限 5（接口有限流），默认 300（5 分钟）。'),
  /** DeepSeek API 地址。非 volatile。 */
  apiBase: z
    .string()
    .default('https://api.deepseek.com')
    .description('DeepSeek API 地址（自建或走代理时改这里）。'),
  /** 读取 API Key 的凭据键名。非 volatile。 */
  credential: z
    .string()
    .default('DEEPSEEK_API_KEY')
    .description('读取 API Key 的凭据键名（DSH 凭据库里的引用名）。'),
})
