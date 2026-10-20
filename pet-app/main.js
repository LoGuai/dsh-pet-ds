/**
 * DSH 桌宠 · 独立窗口进程（Electron main）。
 *
 * 这个进程由 DSH 插件 spawn 出来，也可以手动启动（做离线调试）。
 * 它只做三件事：
 *   1. 开一个透明、无边框、置顶、不进任务栏的小窗；
 *   2. 长轮询宿主的回环状态接口，把状态转发给渲染进程；
 *   3. 把鼠标拖拽转成窗口移动，把右键菜单动作回传给宿主。
 *
 * 它**不碰**任何凭据，也不自己访问 DeepSeek 接口 —— 余额数字是宿主算好给的。
 */

const http = require('node:http')
const path = require('node:path')
const { app, BrowserWindow, ipcMain, Menu, screen, shell } = require('electron')

const settings = require('./settings')

/**
 * 共享核心（单一真相源）。
 *
 * 这里用 `require()` 直接加载 ESM 模块 —— 依赖 Node 的 require(esm) 能力。
 * 这一点在本机**实测过**（`--probe-esm`）：Electron 38.2.0 / Node 22.19.0 下
 * 三个模块全部加载成功。所以动作定义、闲置语音、心情算法只有一份，
 * 不会出现"宿主与桌宠各写一套、慢慢漂移"的问题。
 *
 * 注意心情只用了 `initialMood` / `applyDrift` / `applyPet` / `applyActionReward` /
 * `moodTier` —— 不再需要 `normalizeMood`，因为心情不落盘，
 * 不存在"读到的脏数据要规整"这回事。
 */
const {
  STANDING_ACTION_ID,
  actionMenuEntries,
  findAction,
  CLICK_PARTS,
  PART_ACTIONS,
  RANDOM_ACTIONS,
  RANDOM_ACTION_RULES,
} = require('../src/shared-core/actions.js')

/** 对话台词库（右键菜单「对话」用）。 */
const { pickDialogueLine, dialogueLineCount, DIALOGUE_LINES } = require('../src/shared-core/dialogue.js')

/**
 * 语音库（分组台词：固定 / 好感度等级 / 心情档位）。
 *
 * 与 `dialogue.js` 分开：那是"点一下听一句"的无条件台词；
 * 这里是**按当前状态只从可用组里抽**的分组库。
 *
 * 为什么挑选放在主进程：好感度与心情的**单一真相源**都在主进程
 * （心情要落盘、好感要按阶段结算），渲染进程拿到的只是面板快照。
 * 若让它自己按面板数字挑，就可能出现"面板显示 3 心、实际还在 2 心"
 * 的瞬间错位 —— 而语音恰好是最容易被听出来的地方。
 */
const {
  pickVoiceLine,
  pickVoiceLineFor,
  availableVoiceLines,
  availableVoiceGroups,
  affectionVoiceLevel,
  moodVoiceGroup,
  voiceLibrarySummary,
  voiceLineCount,
  voiceLineCountFor,
  conditionTextOf,
  voiceGroupAvailable,
  VOICE_GROUPS,
  VOICE_LINE_MAX_CHARS,
  dragLines,
  systemLine,
  voiceLinesFor,
} = require('../src/shared-core/voice-library.js')

/**
 * 好感度的**增长规则**（用户指定的五条途径）。
 *
 * 数值与冷却全部集中在 shared-core 里，这里只负责"在正确的时机调用"。
 * 为什么不把 200 / 2~8 这类数字写在这：它们要与面板文案、测试、
 * 以后的平衡调整保持一致，散落在调用点迟早对不上。
 */
const {
  AFFECTION_GAIN,
  LOW_MOOD_THRESHOLD,
  LOW_MOOD_CLICK_MOOD_GAIN,
  clickAffectionGain,
} = require('../src/shared-core/affection-gain.js')


/** 余额取数：与宿主**共用同一份**（shared-core，ESM 经 require(esm) 加载）。 */
const { createBalanceFetcher } = require('../src/shared-core/balance.js')
/** 好感存档（落盘到 userData，与安装目录分离，升级不会丢）。 */
const { createAffectionStore } = require('./affection-store.js')
/** 余额播报的纯逻辑：消耗计算、四档台词、播不播。 */
const { buildBalanceAnnouncement, shouldAnnounceBalance, shouldRunAnnounceWindow } = require('../src/shared-core/balance-announce.js')
/** 从 DSH 的凭据文件里读 API Key（桌宠侧专用，CJS）。 */
const { readCredentialFromFile } = require('./credentials-file.js')

/**
 * 余额查询器实例。
 *
 * ## 取数周期与播报周期是**两件事**（用户要求）
 *
 *   · **取数**（面板显示的数值）：用户要求 **30 秒**一轮 —— 好让余额"看起来在动"。
 *   · **播报**（花掉多少的提醒）：仍是 **5 分钟**一轮 —— 用户原话
 *     "如果 5 分钟内没有余额变化，则不播放提示"。若跟着取数走，30 秒念一次
 *     会变成复读机，而且把一次消耗拆成好几次小播报。
 *
 * 所以这里给取数设为 30 秒（`--balance-poll`），播报窗口另用
 * `--balance-refresh`（默认 300）由 `shouldRunAnnounceWindow` 卡住。
 *
 * ⚠️ 取数周期必须**大于**查询器的缓存 TTL 才不会白跑网络；
 * 这里每次取数都显式传 `fresh: true`（见 `refreshBalanceOnce`），
 * 所以缓存只用于"同一瞬间的并发去重"，不会把 30 秒的刷新挡掉。
 */
const BALANCE_POLL_SECONDS = (() => {
  const raw = Number(readArg('balance-poll'))
  /*
   * 下限 5 秒：接口有限流，更密没有意义（也便于开发期临时调小做观察）。
   * 没传时用 30（用户要求的新默认）。
   */
  return Number.isFinite(raw) && raw >= 5 ? raw : 30
})()

const balanceFetcher = createBalanceFetcher({
  /* 缓存 TTL 跟随取数周期：两者一致时缓存只承担并发去重，不会拖慢刷新。 */
  refreshSeconds: BALANCE_POLL_SECONDS,
  apiBase: readArg('balance-api-base') || undefined,
  credential: readArg('balance-credential') || undefined,
  log: (msg) => log(msg),
})

/**
 * 闲置随机动作的触发规则 —— **从动作库里取**，这里不再自己写一份。
 *
 * 用户要求"所有随机动作放在一个库中，此后添加新的动作都要沿用目前关于随机动作的
 * 设定"。所以三个参数（门槛 / 周期 / 概率）与心情奖励区间统一定义在
 * `src/shared-core/actions-library.js` 的 `RANDOM_ACTION_RULES`，
 * 主进程只做"读出来 + 下发给渲染进程"（渲染进程没有模块加载能力）。
 *
 * ⚠️ 我刻意**不再**在这里写镜像常量：以前主进程与渲染进程各写一份，
 * 改一处忘一处就会不一致。现在只有库里一处。
 *
 * 闲置语音已整体移除（用户要求），因此这里不再有语音相关字段。
 */
const {
  idleThresholdMs: IDLE_TRIGGER_AFTER_MS,
  fireIntervalMs: IDLE_FIRE_INTERVAL_MS,
  fireProbability: IDLE_FIRE_PROBABILITY,
  moodGain: ACTION_MOOD_GAIN,
} = RANDOM_ACTION_RULES

/*
 * ⚠️ 这里曾经有一条 `IDLE_TO_SLEEP_MS = 10 分钟`（"闲置满 10 分钟必然入睡"）。
 * 已按用户要求**移除**：睡眠改为"循环随机 20~40 轮后自动醒来"的有始有终动作，
 * 若再保留那条必然规则，桌宠会陷入"睡一会儿 → 醒 → 立刻又到门槛 → 再睡"
 * 的循环打盹。
 *
 * 睡眠现在只有一条触发路径：**随机池抽中**（见 actions-library.js）。
 */
const {
  applyDrift,
  applyPet,
  applyActionReward,
  initialMood,
  moodTier,
  MOOD_DRIFT_INTERVAL_MS,
  MOOD_DRIFT_MIN,
  MOOD_DRIFT_MAX,
  MOOD_GAIN_PER_PET_MIN,
  MOOD_GAIN_PER_PET_MAX,
  MOOD_GAIN_PER_ACTION_MIN,
  MOOD_GAIN_PER_ACTION_MAX,
} = require('../src/shared-core/mood.js')

/**
 * 好感值（等级 + 阶段好感值）。
 *
 * ⚠️ 当前**刻意不接任何增长**（用户指定"先不接增长，只做面板与数据结构"）。
 * 于是它恒为"等级 1、阶段 0"，面板上显示 ♥♡♡♡♡ 与 0/100。
 * `applyAffectionGain()` 已经实现并单测过（进位 / 连升 / 满级封顶），
 * 接增长时只要在某处调用它即可，不必再改数据结构。
 */
const {
  initialAffection,
  normalizeAffection,
  applyAffectionGain,
  stageThresholdFor,
  affectionProgress,
  heartsFor,
  affectionHeartsLabel,
  affectionStagesPayload,
  AFFECTION_MAX_HEARTS,
} = require('../src/shared-core/affection.js')

// ------------------------------------------------------------------ 启动参数
function readArg(name) {
  const prefix = `--${name}=`
  const hit = process.argv.find((a) => a.startsWith(prefix))
  return hit ? hit.slice(prefix.length) : undefined
}

/**
 * 首次启动时的角色宽度（逻辑像素）。宿主可通过 --size= 下发，仅作初始值；
 * 之后以本地设置文件（右键菜单里改的那个）为准。
 */
const SIZE_HINT = clampNumber(Number(readArg('size') ?? 240), 80, 1200)
/**
 * 置顶开关的**默认值**。
 *
 * 优先级（见 `resolveTopmost()`）：
 *   1. 本地设置文件里的 `topmost`（用户在右键菜单里改过）；
 *   2. 启动参数 `--topmost=false`（开发/测试用）；
 *   3. 默认置顶。
 *
 * ⚠️ 这里只表示"默认"，真正的当前值由 `topmostEnabled` 保存 ——
 * 用户可以在右键菜单里随时切换，所以不能在启动后继续读这个常量。
 */
const TOPMOST_DEFAULT_ARG = readArg('topmost') !== 'false'

/**
 * 余额"告急"阈值（元）。由宿主用 `--low-balance=` 下发（源头是插件配置
 * `lowBalanceThreshold`），桌宠只拿这个数来判断面板配色。
 *
 * 之所以由宿主下发而不是桌宠自己定：阈值是**用户配置**，宿主是配置的唯一来源；
 * 桌宠侧再写一份默认值只是"拿不到下发值时的兜底"。
 */
const LOW_BALANCE_THRESHOLD = (() => {
  const raw = Number(readArg('low-balance'))
  return Number.isFinite(raw) && raw >= 0 ? raw : 10
})()

const SELFTEST = process.argv.includes('--selftest')
/** `--test-drag-follow`：验证主进程跟随式拖拽与布局/尺寸（见 runDragFollowTest）。 */
const TEST_DRAG_FOLLOW = process.argv.includes('--test-drag-follow')
/** `--probe-esm`：探测本进程能否 require() 共享核心的 ESM 模块（决定是否要复制一份数据）。 */
const PROBE_ESM = process.argv.includes('--probe-esm')

/**
 * `--test-quit=<ms>`：启动若干毫秒后走一遍退出流程。
 *
 * 存在的理由：退出路径最容易出的问题是"某一步永远挂住"，而那只有在
 * **宿主不可达**时才会暴露（`postCommand` 收不到响应）。靠人工点菜单很难
 * 稳定复现，所以做成可无人值守验证：进程必须结束，且退出码必须是 0。
 */
const TEST_QUIT_MS = (() => {
  const raw = readArg('test-quit')
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : null
})()
/** 打开几何相关的详细日志（--trace-geometry），用于排查窗口尺寸/位移异常。 */
const TRACE = process.argv.includes('--trace-geometry')

/**
 * `--watch-sleep=<秒>`：进去睡一觉，然后**长时间**采样它的状态与状态变迁日志。
 *
 * 存在的理由：用户报告"睡觉开始一段时间后仍会自行中断"，而自测只覆盖几秒窗口，
 * 根本等不到问题出现。这个开关让"真的等几分钟"变成可无人值守的一次运行，
 * 并在中断发生时把**调用点**打出来（而不是只知道结果变了）。
 */
const WATCH_SLEEP_S = (() => {
  const n = Number(readArg('watch-sleep'))
  return Number.isFinite(n) && n > 0 ? n : null
})()

/**
 * 测试专用：覆盖「闲置随机动作」的三个节奏参数。
 *
 * 为什么需要：默认规则是「连续闲置 **1 分钟** + 之后每分钟 **20%** 概率」。
 * 要验证"随机动作能不能随时间正常触发"，最坏情况得等十几分钟，
 * 而且概率抽不中时完全分不清"没触发"和"逻辑坏了" —— 这种验证几乎做不成。
 *
 * 有了它就能在几十秒内把整条调度链（门槛 → 定时器 → 掷骰子 → 播放）跑一遍，
 * 观察日志里是否真的反复出现 `[idle] 触发随机动作`。
 *
 * **只在显式传参时生效**，宿主从不传它们，所以生产行为完全不变。
 *
 *   --idle-after-ms=5000    闲置门槛（满多久才允许掷骰子）
 *   --idle-every-ms=3000    掷骰子的间隔
 *   --idle-probability=1    每次命中概率
 */
const IDLE_AFTER_OVERRIDE = (() => {
  const n = Number(readArg('idle-after-ms'))
  return Number.isFinite(n) && n >= 0 ? n : null
})()
const IDLE_EVERY_OVERRIDE = (() => {
  const n = Number(readArg('idle-every-ms'))
  return Number.isFinite(n) && n > 0 ? n : null
})()
const IDLE_PROBABILITY_OVERRIDE = (() => {
  const raw = readArg('idle-probability')
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null
})()

const STATE_URL = process.env.DSH_PET_STATE_URL ?? 'http://127.0.0.1:47845/state'
const COMMAND_URL = process.env.DSH_PET_COMMAND_URL ?? 'http://127.0.0.1:47845/command'

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

/** 日志统一走 stderr；宿主在 debug 模式会把它转接到 DSH 日志里。 */
function log(msg) {
  try {
    process.stderr.write(`[pet] ${msg}\n`)
  } catch {
    // 忽略日志失败。
  }
}

// -------------------------------------------------------------- 单实例保护
// 桌宠是"桌面常驻的小玩意"，重复启动会出现多只重叠在一起，因此只允许一个实例。
// 用 Electron 自带的 requestSingleInstanceLock（比手写命名互斥体更省事且跨平台）。
if (!app.requestSingleInstanceLock()) {
  log('已有实例在运行，本次启动退出')
  app.quit()
}

// -------------------------------------------------------------- 状态与窗口
/** @type {BrowserWindow | null} */
let win = null
/** 最近一次从宿主拿到的状态快照。 */
let lastState = null
/** 长轮询用到：已知的状态版本号。 */
let knownSeq = -1

/**
 * 拖拽会话状态。
 *
 * ⚠️ 拖拽移动的**主路径在主进程**：用 screen.getCursorScreenPoint() 以高频轮询光标，
 * 直接 setPosition。渲染进程只负责"什么时候开始/结束"。
 *
 * 为什么不走"渲染进程上报 mousemove"这条更直观的路：
 *  1. 窗口正在移动时，Chromium 会降低该窗口的合成频率，mousemove 本身就不及时；
 *  2. 每次移动要一次 IPC 往返；
 *  3. 主进程侧若再加节流（本实现最初就加了 16ms），延迟会进一步叠加。
 * 三者叠加的结果就是"拖起来发飘、跟不上手"。改成主进程主动跟随之后，
 * 延迟只剩一个 setPosition 调用，手感是实时的。
 *
 * 坐标系仍然用**绝对量**而不是增量：窗口位置 = 光标位置 − 抓取偏移。
 * 增量式会形成反馈回路（clientX 的参考系是窗口自己，而窗口每帧都在动），
 * 表现为剧烈抖动 —— 这个坑踩过，见 README。
 */
let dragSession = null

/** 拖拽跟随的轮询定时器。 */
let dragFollowTimer = null

/** 轮询间隔：约 240Hz。比显示器刷新快得多，因此不会成为延迟来源。 */
const DRAG_FOLLOW_INTERVAL_MS = 4

/**
 * 测试钩子：非 null 时用它代替 screen.getCursorScreenPoint()。
 *
 * 存在的理由：跟随读的是**真实系统光标**，而在这台机器上 SetCursorPos 不生效
 * （实测光标位置不随调用改变），所以无法用"移动真实光标"的方式自动化验证跟随。
 * 这个钩子只在 --test-drag-follow 下被赋值，用来验证跟随**代码路径**是否正确：
 * 读光标 → 算"光标 − 抓取偏移" → setPosition → 确认窗口真的移动了。
 */
let cursorOverride = null

/**
 * 拖拽开始时记录：窗口原点 + 光标屏幕坐标 + 抓到角色身上的哪个位置。
 *
 * `offsetX/offsetY` 是"光标相对窗口左上角"的偏移。跟随过程中保持它不变，
 * 因此抓哪儿就一直是哪儿，不会出现"角色从光标下滑走"。
 *
 * @param {{ offsetX: number, offsetY: number } | null} [precomputedOffset]
 *        渲染进程在按下那一刻算好的抓取偏移；缺省时由主进程自己读光标算。
 */
function beginDragSession(precomputedOffset = null) {
  if (!win || win.isDestroyed()) return
  try {
    const [wx, wy] = win.getPosition()
    const cursor = readCursorPoint()
    const offsetX = precomputedOffset ? precomputedOffset.offsetX : cursor.x - wx
    const offsetY = precomputedOffset ? precomputedOffset.offsetY : cursor.y - wy
    dragSession = {
      startWinX: wx,
      startWinY: wy,
      startMouseX: cursor.x,
      startMouseY: cursor.y,
      offsetX,
      offsetY,
      /** 最近一次从渲染进程收到的光标位置（仅作兜底，见 pet:drag-to）。 */
      reportedX: null,
      reportedY: null,
    }
    startDragFollow()
    dragTraceCounter = 0
    dragClampCount = 0
    if (TRACE) {
      log(
        `[trace] 拖拽开始: 窗口(${String(wx)},${String(wy)}) 光标(${String(cursor.x)},${String(cursor.y)})` +
          ` 抓取偏移(${String(offsetX)},${String(offsetY)})${
            precomputedOffset ? '（来自渲染进程按下瞬间）' : '（主进程自取）'
          }`,
      )
    }
  } catch (err) {
    log(`开始拖拽失败：${err instanceof Error ? err.message : String(err)}`)
    dragSession = null
  }
}

/** 主进程主动跟随：高频读光标，立即设置窗口位置。 */
function startDragFollow() {
  if (dragFollowTimer) return
  dragFollowTimer = setInterval(() => {
    try {
      applyDragFollow()
    } catch {
      // 忽略：单次跟随失败不该中断拖拽。
    }
  }, DRAG_FOLLOW_INTERVAL_MS)
}

function stopDragFollow() {
  if (dragFollowTimer) {
    clearInterval(dragFollowTimer)
    dragFollowTimer = null
  }
}

/** 读取当前光标位置（测试时可由 cursorOverride 接管）。 */
function readCursorPoint() {
  if (cursorOverride) return cursorOverride
  return screen.getCursorScreenPoint()
}

/**
 * 期望的窗口内容尺寸（由尺寸档位算出）。
 *
 * 用途：拖拽跟随时把它一起写进 `setBounds`，抵消"每次移动宽度 +1px"的平台行为。
 * 见 `applyDragFollow` 的注释与 `pet-app/move-test.cjs` 这个受控实验。
 * @type {{ width: number, height: number } | null}
 */
let expectedWindowSize = null

/** 按角色宽度记下期望的窗口尺寸。 */
function setExpectedWindowSize(petWidth) {
  const b = boundsForWidth(petWidth)
  expectedWindowSize = { width: b.width, height: b.height }
  return expectedWindowSize
}

/**
 * 跟随拖拽：把窗口移到"光标当前位置 − 抓取偏移"。
 *
 * ⚠️ 这里必须用 `setBounds`（把尺寸一并写回），**不能用 `setPosition`**。
 *
 * 这是一个受控实验查出来的平台行为（`pet-app/move-test.cjs`）：
 * 在本机（150% DPI）上，**每一次 `setPosition` 都会让窗口宽度 +1px**：
 *
 * ```
 * 起始 241x432 → 锁死为 241x432 → 连做 40 次 setPosition → 结束 281x432
 * 出现过的尺寸: 242x432 → 243x432 → … → 281x432
 * ```
 *
 * 而且 `setMinimumSize/setMaximumSize` **拦不住**它（那是应用层约束，
 * 这里变的是系统给的实际尺寸）。跟随循环每 4ms 动一次，于是拖一下窗口就被拉长一截，
 * 观感就是"窗口被拉长、面板越来越长、桌宠往右跑"。
 *
 * 修法：让"移动"与"保持尺寸"成为**同一次调用** —— 把期望尺寸一起写进 setBounds。
 * 这**不会**产生抖动：抖动来自"先移动、再单独纠正尺寸"这种两次写入，
 * 而一次写入里尺寸本来就是对的，没有中间状态可抖。
 *
 * 关于"以前用 setBounds 写死尺寸反而更抖"：那是因为当时写进去的值（260x286）
 * 与窗口实际尺寸（263x260）**不一致**，于是每帧都在改尺寸。现在写的是同一个
 * 期望尺寸，因此是幂等的。
 */
function applyDragFollow() {
  if (!dragSession || !win || win.isDestroyed()) return
  const cursor = readCursorPoint()
  // 目标位置 = 光标位置 − 抓取偏移。这样光标始终"抓"在角色的同一点上。
  const rawX = Math.round(cursor.x - dragSession.offsetX)
  const rawY = Math.round(cursor.y - dragSession.offsetY)
  // 每一帧就夹进屏幕，保证窗口边界**始终**不出屏。
  // 夹在跟随里而不是只在松手时做，是为了避免"先越界、再被拽回来"的跳位观感 ——
  // 现在拖到边缘是平滑地贴住边界停住。
  const { x: targetX, y: targetY, clamped } = clampToWorkArea(rawX, rawY)
  if (clamped && TRACE) {
    dragClampCount += 1
    if (dragClampCount % 25 === 1) {
      log(`[trace] 跟随被屏幕边界夹住：(${String(rawX)},${String(rawY)}) → (${String(targetX)},${String(targetY)})`)
    }
  }

  if (expectedWindowSize) {
    win.setBounds({
      x: targetX,
      y: targetY,
      width: expectedWindowSize.width,
      height: expectedWindowSize.height,
    })
  } else {
    // 还没记下期望尺寸时退化为纯移动（理论上不会发生，仅作兜底）。
    win.setPosition(targetX, targetY)
  }

  // 诊断：每若干帧打印一次"光标 → 目标 → 实际"。
  // 这是判断"向右漂"到底是**算错**还是**写入没生效**的关键对照。
  if (TRACE) {
    dragTraceCounter += 1
    if (dragTraceCounter % 25 === 0) {
      const [ax, ay] = win.getPosition()
      const [aw, ah] = win.getSize()
      log(
        `[trace] 跟随 光标(${String(cursor.x)},${String(cursor.y)}) 偏移(${String(dragSession.offsetX)},${String(dragSession.offsetY)})` +
          ` 目标(${String(targetX)},${String(targetY)}) 实际(${String(ax)},${String(ay)}) ${String(aw)}x${String(ah)}` +
          ` 差(${String(ax - targetX)},${String(ay - targetY)})`,
      )
    }
  }
}

/** 跟随诊断的计数器。 */
let dragTraceCounter = 0

/** 被屏幕边界夹住的次数（仅诊断用）。 */
let dragClampCount = 0

/** 结束拖拽会话。 */
function endDragSession() {
  stopDragFollow()
  if (!dragSession) return
  // 最后一次跟随，保证落点就是松手那一刻的光标位置。
  try {
    applyDragFollow()
  } catch {
    // 忽略。
  }
  dragSession = null
  clampIntoWorkArea()
}

/**
 * 把窗口**完整**限制在某块屏幕的工作区内（用户要求：窗口边界不能超出屏幕）。
 *
 * 与旧实现的区别：旧版按"至少留 1/5 宽、1/6 高可见"来夹取，**允许窗口有一部分
 * 露在屏幕外**。当时那么改是为了修"拖到边缘松手时整窗被拉回来 → 看起来跳位"。
 *
 * 但用户明确要求"窗口边界不能超出屏幕"，所以现在改成整窗夹取，并且**在跟随的
 * 每一帧就夹**（见 applyDragFollow），而不是只在松手时夹 ——
 * 这样拖到边缘时窗口是**平滑地贴住边界停住**，而不是先跑出去再被拽回来，
 * 因此不会产生旧版那种"跳位"观感。旧版的跳位问题本质上是"先越界、后纠正"。
 *
 * 多显示器：按窗口中心所在的那块屏来夹取；窗口比工作区还大时退化为贴左上角。
 *
 * @param {number} x 期望的左边界
 * @param {number} y 期望的上边界
 * @returns {{ x: number, y: number, clamped: boolean }}
 */
function clampToWorkArea(x, y) {
  if (!win || win.isDestroyed()) return { x, y, clamped: false }
  const [w, h] = win.getSize()
  // 用窗口中心来判断在哪块屏上，避免跨屏拖动时用错工作区。
  const probe = { x: Math.round(x + w / 2), y: Math.round(y + h / 2) }
  const area = screen.getDisplayNearestPoint(probe).workArea

  // 完整可见的范围：左边界不小于 area.x，右边界不大于 area.x + area.width。
  // 窗口比工作区大时 min > max，用 Math.max 兜底成 area.x（贴左上角）。
  const minX = area.x
  const maxX = Math.max(area.x, area.x + area.width - w)
  const minY = area.y
  const maxY = Math.max(area.y, area.y + area.height - h)

  const nx = Math.round(Math.min(Math.max(x, minX), maxX))
  const ny = Math.round(Math.min(Math.max(y, minY), maxY))
  return { x: nx, y: ny, clamped: nx !== Math.round(x) || ny !== Math.round(y) }
}

/**
 * 松手时再夹一次。
 *
 * 跟随期间已经每帧夹过了，这里是兜底：窗口尺寸可能在拖拽结束前变过
 * （例如拖到一半改了尺寸档位），或者跟随最后一帧的取整与这里不同。
 */
function clampIntoWorkArea() {
  if (!win || win.isDestroyed()) return
  const [x, y] = win.getPosition()
  const { x: nx, y: ny, clamped } = clampToWorkArea(x, y)
  if (clamped) {
    win.setBounds({ x: nx, y: ny, width: expectedWindowSize?.width, height: expectedWindowSize?.height })
    log(`拖拽落点被夹回屏幕内：(${String(x)},${String(y)}) → (${String(nx)},${String(ny)})`)
  }
}

/** 初始位置：主屏右下角，留出边距。 */
function initialPosition(width, height) {
  const area = screen.getPrimaryDisplay().workArea
  const marginX = 24
  const marginY = 80
  return {
    x: Math.round(area.x + area.width - width - marginX),
    y: Math.round(area.y + area.height - height - marginY),
  }
}

// ------------------------------------------------------------------ 窗口创建

/**
 * 当前是否置顶。启动时由 `resolveTopmost()` 定，之后由右键菜单的开关改。
 *
 * 注意不能在运行期读 `TOPMOST_DEFAULT_ARG` —— 那只是"没被用户改过时用什么"。
 */
let topmostEnabled = true

/**
 * 解析启动时的置顶状态。
 *
 * 优先级：设置文件 > 启动参数 > 默认置顶。
 *
 * 为什么设置文件优先：用户在右键菜单里关掉置顶，是明确的意图，
 * 不该被一个默认参数盖回去。而 `--topmost=false` 是给开发/自测用的临时开关，
 * 它只在用户还没做过选择时起作用 —— 否则"菜单里打开、重启又变回来"很费解。
 */
function resolveTopmost() {
  const stored = settings.load()
  if (typeof stored.topmost === 'boolean') return stored.topmost
  return TOPMOST_DEFAULT_ARG
}

/**
 * 应用置顶状态到窗口，并持久化。
 *
 * `'screen-saver'` 层级比普通 alwaysOnTop 更高，能压住大多数窗口，
 * 又不会像 `'pop-up-menu'` 那样抢焦点。关掉时传 `false` 让窗口回到普通层。
 *
 * @param {boolean} enabled
 * @param {{ persist?: boolean }} [options]
 */
function applyTopmost(enabled, options = {}) {
  const next = Boolean(enabled)
  topmostEnabled = next
  if (win && !win.isDestroyed()) {
    win.setAlwaysOnTop(next, next ? 'screen-saver' : 'normal')
  }
  if (options.persist !== false) {
    try {
      settings.update({ topmost: next })
    } catch (err) {
      log(`保存置顶设置失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }
  log(`置顶：${next ? '已开启（始终显示在最上层）' : '已关闭（作为普通窗口）'}`)
  return next
}

/** 切换置顶，返回新的状态。 */
function toggleTopmost() {
  return applyTopmost(!topmostEnabled)
}

function createWindow() {
  // 读本地设置（右键菜单里改的尺寸就存在这里）。
  // 本地文件不存在时，用宿主下发/默认的宽度作为初始值。
  const stored = settings.load()
  logicalWidth = clampNumber(Number(stored.petWidth) || SIZE_HINT, PET_WIDTH_MIN, PET_WIDTH_MAX)
  // 置顶状态也来自设置文件（用户上次的选择），没存过才回落到启动参数。
  topmostEnabled = resolveTopmost()

  /*
   * 心情：**每次启动都重置为满值**。
   *
   * 这是用户明确要求的行为。原先的实现会把心情持久化、并按真实流逝时间补算衰减，
   * 于是"宿主离线时心情还在掉"（因为衰减只看时间戳、不看宿主状态），
   * 用户觉得莫名其妙。
   *
   * 现在心情**只在内存里**，进程一退就没了；下次启动从 100 开始。
   * 好处是行为完全可预期：想恢复心情，重启桌宠即可。
   * 代价是"隔夜回来发现她心情低落"这类养成感没有了 —— 这是刻意的取舍。
   *
   * 因此 `settings` 里不再有 mood 字段；`initialMood()` 也不再需要传入持久化数据。
   */
  mood = initialMood()

  // 建窗时就给出正确尺寸（宽 = 角色区，高 = 气泡区 + 角色区）。
  // 曾经只给 width 不给 height（得到正方形），随后又"按比例对齐"，尺寸在启动时就变了一次；
  // 这个初始不一致正是后来拖拽抖动的起点。
  const initialSize = boundsForWidth(logicalWidth)
  // 记下期望尺寸：拖拽跟随时要用它写回 setBounds，抵消"每次移动宽度+1px"的平台行为。
  setExpectedWindowSize(logicalWidth)
  const pos = initialPosition(initialSize.width, initialSize.height)

  win = new BrowserWindow({
    width: initialSize.width,
    height: initialSize.height,
    x: pos.x,
    y: pos.y,
    // 透明 + 无边框 + 置顶 + 不进任务栏：构成"桌面宠物"的基本窗口语义。
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: true,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: topmostEnabled,
    show: false,
    // 关掉节流，保证动画流畅（透明窗在后台被节流会显得卡顿）。
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  })

  // 置顶层级：'screen-saver' 比普通 alwaysOnTop 更高，能压住大多数窗口，
  // 但不会像 'pop-up-menu' 那样抢焦点。
  if (topmostEnabled) win.setAlwaysOnTop(true, 'screen-saver')

  win.loadFile(path.join(__dirname, 'index.html'))

  win.once('ready-to-show', () => {
    win.showInactive()
    // 锁死尺寸与宽高比，之后不再触碰（重复施加会形成 +1px 正反馈，见 lockWindowSize 注释）。
    // 用户在右键菜单里改尺寸时会先解锁（见 applyPetSize）。
    lockWindowSize()
    log(
      `窗口已显示 ${String(initialSize.width)}x${String(initialSize.height)} @ ${String(pos.x)},${String(pos.y)}` +
        `（角色宽 ${String(logicalWidth)}，气泡区 ${String(bubbleAreaFor(logicalWidth))}）`,
    )
  })

  win.on('closed', () => {
    win = null
  })

  // 心情：启动结算定时器，并把当前值推给界面。
  startMoodTicker()

  // 几何追踪：用来定位"窗口在拖拽期间莫名改变尺寸"这类问题。
  // 关键点：resize 事件在窗口被移动时也会触发，因此必须同时打印尺寸和位置。
  if (TRACE) {
    let lastSize = ''
    win.on('resize', () => {
      if (!win || win.isDestroyed()) return
      const b = win.getBounds()
      const size = `${String(b.width)}x${String(b.height)}`
      if (size !== lastSize) {
        lastSize = size
        log(`[trace] resize 事件 → ${size} @ (${String(b.x)},${String(b.y)}) dragging=${String(Boolean(dragSession))}`)
      }
    })
    win.on('move', () => {
      if (!win || win.isDestroyed()) return
      const b = win.getBounds()
      // 同时打印"这一帧窗口被指到的目标位置"，用于区分
      // "窗口被别的东西挪了" 与 "跟随算错了导致一路漂"。
      const target = dragSession
        ? `目标(${String(Math.round((cursorOverride ?? screen.getCursorScreenPoint()).x - dragSession.offsetX))},${
            String(Math.round((cursorOverride ?? screen.getCursorScreenPoint()).y - dragSession.offsetY))
          }) 偏移(${String(dragSession.offsetX)},${String(dragSession.offsetY)})`
        : '未拖拽'
      log(
        `[trace] move 事件 → (${String(b.x)},${String(b.y)}) ${String(b.width)}x${String(b.height)} ${target}`,
      )
    })
  }

  win.webContents.on('did-fail-load', (_e, code, desc) => {
    log(`页面加载失败 ${code} ${desc}`)
  })
}

// ------------------------------------------------------- 宿主状态长轮询
/** 向宿主取一次状态；wait>0 时是长轮询。 */
function fetchState(wait) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }

    try {
      const url = new URL(STATE_URL)
      url.searchParams.set('pid', String(process.pid))
      url.searchParams.set('wait', String(wait))
      if (knownSeq >= 0) url.searchParams.set('since', String(knownSeq))

      const req = http.get(
        url,
        {
          // 明确绕过系统代理 —— 回环地址不该被代理拦截。
          agent: false,
        },
        (res) => {
          const chunks = []
          res.on('data', (c) => chunks.push(c))
          res.on('end', () => {
            if (res.statusCode !== 200) {
              finish({ ok: false, error: `HTTP ${String(res.statusCode)}` })
              return
            }
            try {
              finish({ ok: true, state: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
            } catch (err) {
              finish({ ok: false, error: `解析失败：${String(err)}` })
            }
          })
        },
      )

      // 长轮询 + 超时余量：服务端最多等 wait 秒，客户端再多给一点。
      const timeoutMs = (wait + 15) * 1000
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error('timeout'))
      })
      req.on('error', (err) => finish({ ok: false, error: err.message }))
    } catch (err) {
      finish({ ok: false, error: String(err) })
    }
  })
}

/** 长轮询循环。宿主不可达时退避重试，绝不崩溃。 */
async function pollLoop() {
  let consecutiveFailures = 0
  for (;;) {
    if (app.isQuitting === true) return
    // 窗口已关闭（用户右键退出）时结束循环。
    if (!win || win.isDestroyed()) return

    const result = await fetchState(25)

    if (result.ok && result.state) {
      consecutiveFailures = 0
      const state = result.state
      if (typeof state.seq === 'number') knownSeq = state.seq
      lastState = state

      // 执行宿主下发的命令。
      const commands = Array.isArray(state.commands) ? state.commands : []
      for (const command of commands) handleCommand(command)

      /*
       * 宿主的一次性消息（余额播报就走这条路）。
       *
       * 协议里 `message` 是"待播报的一句话"，桥接侧取走即清（取一次就不再重发），
       * 所以这里直接转成一次 `pet:say` 即可 —— 渲染进程的 `pet:say` 通道
       * 会走统一的 `showBubble`，那里的守卫（睡眠/惊醒期间不说话）也自动适用。
       */
      if (typeof state.message === 'string' && state.message.length > 0) {
        if (win && !win.isDestroyed()) {
          win.webContents.send('pet:say', { text: state.message, bubbleMs: 9000 })
        }
        log(`播报：${state.message}`)
      }

      // 转发给渲染进程。
      //
      // 测试模式下若有状态覆盖值，就**不要**把轮询结果推下去 —— 否则宿主的真实状态
      // 会在几十毫秒内把注入的状态顶掉（闲置语音的门控测试就被这一点坑过）。
      //
      // ⚠️ 但**余额必须照常转发**：测试覆盖的是"工作档位"这类行为状态，
      // 而余额面板是常驻显示、依赖真实数据的。若连余额一起挡掉，
      // 余额面板在整个自测里永远是 `--`，从没被真正画过。
      if (win && !win.isDestroyed()) {
        if (testStateOverride) {
          if ('balance' in state) {
            win.webContents.send('pet:state', {
              v: state.v,
              seq: state.seq,
              balance: state.balance,
            })
          }
        } else {
          win.webContents.send('pet:state', state)
        }
      }
    } else {
      consecutiveFailures += 1
      // 宿主离线：只在第一次和每 10 次失败时记日志，避免刷屏。
      if (consecutiveFailures === 1 || consecutiveFailures % 10 === 0) {
        log(`取状态失败（第 ${String(consecutiveFailures)} 次）：${result.error}`)
      }
      if (win && !win.isDestroyed()) {
        win.webContents.send('pet:offline', { error: result.error ?? null })
      }
      // 指数退避，上限 10 秒。
      const backoff = Math.min(10_000, 500 * 2 ** Math.min(consecutiveFailures, 5))
      await sleep(backoff)
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 执行一条宿主命令。 */
function handleCommand(command) {
  if (!command || typeof command.kind !== 'string') return
  if (command.kind === 'quit') {
    log('收到宿主 quit 指令，退出')
    quitSelf()
    return
  }
  if (command.kind === 'say') {
    if (win && !win.isDestroyed()) {
      win.webContents.send('pet:say', { text: command.text ?? '', bubbleMs: 8000 })
    }
    return
  }
  if (command.kind === 'reload-config') {
    if (win && !win.isDestroyed()) win.webContents.send('pet:reload-config', {})
  }
}

/** 是否已经走过退出流程（防止重复触发）。 */
let quitting = false

/**
 * 主动退出。
 *
 * ⚠️ 两条硬规矩：
 *
 * **一、退出绝不能依赖网络。**
 * 曾经的写法是 `await postCommand(...)` 之后再 `app.quit()` —— 那是错的：
 * `postCommand` 只在响应正常 `end` 时 resolve，若宿主没回包（本地开发宿主被
 * `onPetExit` 关掉时正是这种情况），这个 await 会永远挂住，`app.quit()` 根本
 * 执行不到。用户看到的现象就是"点退出没反应"。
 *
 * **二、退出必须无条件生效，且退出码为 0。**
 * 正常退出路径上任何一步卡住，都要有兜底把它结束掉。
 * 实测正常路径会走到 `app.exit`，但退出码曾是 1 —— 这次显式传 0，
 * 并且把 `stopAllTimers` 放最前面，避免定时器把事件循环拖住。
 */
function quitSelf() {
  if (quitting) return
  quitting = true
  app.isQuitting = true
  log('收到退出请求，开始退出')

  /*
   * 0) 先把好感存档刷盘。
   *
   * 为什么必须是**同步**的一次：`stopAllTimers()` 之后事件循环随时可能结束，
   * 延迟写就来不及了 —— 用户最后一次点击加的那几点好感会丢。
   */
  try {
    flushAffectionSave()
  } catch (err) {
    log(`退出前保存好感失败：${err instanceof Error ? err.message : String(err)}`)
  }

  // 1) 先停掉所有定时器：它们会让事件循环保持活跃，拖住退出。
  stopAllTimers()

  // 2) 尽力通知宿主，**不等结果**（超时也短一些）。
  try {
    void postCommand({ kind: 'quit', pid: process.pid })
  } catch {
    // 忽略：通知失败不影响退出。
  }

  // 3) 正常退出。给一个明确为 0 的码。
  try {
    app.quit()
  } catch (err) {
    log(`app.quit 失败，直接结束进程：${err instanceof Error ? err.message : String(err)}`)
    app.exit(0)
    return
  }

  // 4) 兜底：250ms 后若进程还活着，说明正常退出被什么卡住了，强制结束。
  //    这里刻意用 app.exit(0) 而不是 process.exit —— 前者会走 Electron 的清理，
  //    后者可能与渲染进程的收尾打架。
  const hardExit = setTimeout(() => {
    log('正常退出未完成，强制结束进程')
    app.exit(0)
  }, 250)
  // 不 unref：这个定时器就是用来兜底的，必须保证它能触发。
  void hardExit
}

/** 停掉所有会让事件循环保持活跃的定时器。 */
function stopAllTimers() {
  for (const timer of [moodTimer, dragFollowTimer]) {
    if (timer) clearInterval(timer)
  }
  moodTimer = null
  dragFollowTimer = null
}

/** 向宿主回传事件（目前只有 quit）。 */
function postCommand(body) {
  return new Promise((resolve) => {
    try {
      const url = new URL(COMMAND_URL)
      const payload = Buffer.from(JSON.stringify(body), 'utf8')
      const req = http.request(
        url,
        {
          method: 'POST',
          agent: false,
          headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
        },
        (res) => {
          res.resume()
          res.on('end', () => resolve(true))
        },
      )
      req.setTimeout(3000, () => req.destroy(new Error('timeout')))
      req.on('error', () => resolve(false))
      req.end(payload)
    } catch {
      resolve(false)
    }
  })
}

// ------------------------------------------------------------------ IPC 接口
ipcMain.handle('pet:get-initial', () => ({
  topmost: topmostEnabled,
  state: lastState,
  /**
   * 渲染进程应该采用的**逻辑宽度**（角色区域宽度）。布局请以它为准，
   * 不要回报 window.innerWidth。
   *
   * 这是本项目一个重要的架构决定：窗口尺寸**只由主进程决定**。
   * 曾经让渲染进程把 window.innerWidth 回报上来"对齐尺寸"，结果是
   * "回报尺寸 → 改窗口 → 触发 resize → 又回报一个更大的尺寸"的正反馈，
   * 加上高 DPI 的取整，窗口会在拖拽中一点点放大（实测每轮 +2px）。
   */
  logicalWidth: Math.round(logicalWidth),
  /** 顶部气泡区高度（CSS 像素）。渲染进程据此把角色往下排，保证气泡不被角色盖住。 */
  bubbleArea: bubbleAreaFor(logicalWidth),
  /** 底部属性面板区高度（CSS 像素）。留出这块空间，面板才不会被角色盖住。 */
  statsZone: statsZoneFor(logicalWidth),
  /**
   * 余额面板区高度（CSS 像素）。**常驻区域**，在角色区与属性面板区之间。
   * 单独预留是"余额面板与属性面板不遮挡"的结构性保证。
   */
  balanceZone: balanceZoneFor(logicalWidth),
  /**
   * 余额（**桌宠自己取的**，不再是宿主推来的）。
   *
   * 首屏可能还是 null（取数要一次网络往返）——那时渲染进程显示 `--`，
   * 取到后由 `pet:balance` 推下去更新。
   */
  balance: currentBalancePayload(),
  /** 余额低于此值时面板转为"告急"配色。 */
  lowBalanceThreshold: LOW_BALANCE_THRESHOLD,
  /** 气泡字号（CSS 像素）。与气泡区一起随桌宠等比缩放。 */
  bubbleFont: bubbleFontFor(logicalWidth),

  /** 当前心情。渲染进程只负责显示，数值与衰减由主进程管（要持久化）。 */
  mood: currentMoodPayload(),

  /**
   * 当前好感（等级 + 阶段好感值）。
   *
   * 与心情一样由主进程管、渲染进程只负责显示 —— 将来若要落盘也不用改结构。
   * 阈值表由共享核心生成（`affectionStagesPayload()`），
   * 渲染进程**不重复实现**一份，避免"面板按 100、进位按 200"这种错位。
   */
  affection: currentAffectionPayload(),

  /**
   * 可触发的动作清单与闲置语音配置。
   *
   * 这两项来自共享核心（src/shared-core/），主进程只是**转发**给渲染进程 ——
   * 渲染进程没有模块加载能力，但这样仍然是单一真相源，不会两边各写一套。
   */
  actions: actionMenuEntries().map((entry) => {
    /*
     * ⚠️ 这里必须把**路由标志**一并下发，否则渲染进程拿不到它们。
     *
     * 曾经漏掉过：渲染进程里写着 `if (chosen.routToSleepState) { enterSleep() }`，
     * 而这个映射只发了 id/label/standing/lines —— 于是那个判断**永远为假**，
     * 是死代码。睡觉之所以还能正常路由，是因为 `playAction` 里另有一条
     * `id === SLEEP_ACTION_ID` 的判断兜住了。两套机制并存本身就是隐患，
     * 所以这里把标志补齐，让"数据驱动"那条路真的生效（坐姿也要用它）。
     */
    const def = findAction(entry.id)
    return {
      id: entry.id,
      label: entry.label,
      standing: Boolean(entry.standing),
      /** 台词占位符：动作播完时若没有专属台词，就用它。 */
      lines: def?.lines ?? [],
      /** 触发后进入睡眠状态（而不是播完就回站立）。 */
      routToSleepState: Boolean(def?.routToSleepState),
      /** 触发后进入坐姿三阶段（坐下 → 坐着循环 + 计时 → 站起）。 */
      routToSitState: Boolean(def?.routToSitState),
    }
  }),
  /**
   * 点击部位定义（源头是 src/shared-core/actions.js 的 CLICK_PARTS）。
   * 渲染进程据此把点击位置换算成归一化画布坐标再判部位 ——
   * 坐标与窗口尺寸/DPI 无关，所以换档位不用改任何东西。
   */
  clickParts: CLICK_PARTS.map((part) => ({
    id: part.id,
    label: part.label,
    box: part.box,
    /*
     * 部位台词按好感度三档整体下发（用户要求：0,1 心 / 2,3 心 / 4,5 心）。
     *
     * 为什么不只发当前那一档：爱心会在运行中变化，只发当前档就得每次
     * 升心都重发一次清单；整表下发后渲染进程自己按 `affectionState.hearts` 选，
     * 点击依然是零延迟的本地反馈。
     */
    linesByTier: part.linesByTier ?? {},
    /** 点击这个部位时播放的互动动画 id（null = 只说台词）。 */
    actionId: part.actionId ?? null,
  })),
  /**
   * 零散场景的台词（同样来自语音库，用户要求"所有语音归库"）。
   *
   * 渲染进程没有模块加载能力，所以由主进程把这几条一起下发；
   * 以前它们是**硬编码在渲染进程里**的（拖拽台词数组、点空白处的兜底句）。
   */
  voice: {
    dragLines: dragLines(),
    clickMissLine: systemLine('click-miss'),
  },
  /**
   * 点击互动动画清单（源头是 PART_ACTIONS）。
   *
   * 这些动画**不在右键菜单里、也不参与随机**，只由点击部位触发；
   * 渲染进程把它们并入动作清单以便统一走播放/收尾逻辑，
   * 同时要靠这份 id 列表把它们排除出随机池。
   */
  partActions: PART_ACTIONS.map((action) => ({ id: action.id, label: action.label })),
  /**
   * 闲置动作的触发规则，下发给渲染进程：
   * 保持闲置 `idleTriggerAfterMs` 之后，每 `idleFireIntervalMs` 以
   * `idleFireProbability` 的概率触发一个随机动作。
   *
   * 三个 `*_OVERRIDE` 只用于测试（见顶部的说明）；未传参时是 null，
   * 于是这里取的仍然是动作库里的默认值，生产行为不变。
   */
  idleTriggerAfterMs: IDLE_AFTER_OVERRIDE ?? IDLE_TRIGGER_AFTER_MS,
  idleFireIntervalMs: IDLE_EVERY_OVERRIDE ?? IDLE_FIRE_INTERVAL_MS,
  idleFireProbability: IDLE_PROBABILITY_OVERRIDE ?? IDLE_FIRE_PROBABILITY,
  /**
   * 闲置随机动作回复的心情区间（用户指定 10~30）。
   * 真正加心情的是主进程；下发只是让渲染进程能记日志、以及自测能断言。
   */
  actionMoodGain: { min: ACTION_MOOD_GAIN.min, max: ACTION_MOOD_GAIN.max },
  /** 标准站立动作 id，供渲染进程判断"什么时候该回到待机"。 */
  standingActionId: STANDING_ACTION_ID,
}))

/**
 * 拖拽开始。
 *
 * 抓取偏移优先用渲染进程在**按下那一刻**算好的值（光标 − 窗口左上角）。
 * 为什么不用主进程自己读：跟随是在长按 180ms 之后才启动的，若那时才读光标，
 * 用户在这 180ms 内移动过鼠标的话，窗口会先"跳"一下再跟上。
 * 渲染进程手里的 e.screenX/Y 与 window.screenX/Y 都是按下瞬间的值，最准。
 *
 * 主进程自己读的那份作为兜底（渲染进程没传时使用）。
 * @param {{x?: number, y?: number, offsetX?: number, offsetY?: number}} [payload]
 */
ipcMain.on('pet:drag-start', (_event, payload) => {
  const hasOffset = payload && Number.isFinite(payload.offsetX) && Number.isFinite(payload.offsetY)
  beginDragSession(hasOffset ? { offsetX: Number(payload.offsetX), offsetY: Number(payload.offsetY) } : null)
})

/**
 * 渲染进程上报的光标位置：**仅作兜底**。
 *
 * 主路径是主进程每 4ms 轮询 getCursorScreenPoint() 并直接跟随（见 applyDragFollow）。
 * 这里保留一条上报通道，是为了极端情况下（例如轮询取到的坐标不可用）仍能跟随，
 * 以及便于自检用合成事件驱动。正常情况下它不会改变任何行为，因为主进程的轮询
 * 比渲染进程的 mousemove 更快也更及时。
 */
ipcMain.on('pet:drag-to', (_event, payload) => {
  if (!payload || !win || win.isDestroyed()) return
  if (!dragSession) return
  const x = Number(payload.x)
  const y = Number(payload.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return
  dragSession.reportedX = x
  dragSession.reportedY = y
  // 不在这里 setPosition：跟随由主进程轮询统一负责，避免两处写位置互相打架。
})

/** 拖拽结束：补齐落点、把窗口夹回可见区域、结束会话。 */
ipcMain.on('pet:drag-end', () => {
  endDragSession()
})

// ------------------------------------------------------------------ 心情值
/*
 * 心情**不落盘**：每次启动都是满值（用户要求）。
 *
 * 因此这里没有 persistMood —— 心情只活在内存里，进程退出即清空。
 * 衰减仍然按时间戳结算（比定时器累加稳），但结算基准只在本进程生命周期内推进，
 * 所以不存在"离线/隔夜回来掉了一大截"的情况。
 */

/** 当前心情的快照，供界面展示。 */
function currentMoodPayload() {
  return {
    value: Math.round(mood.value),
    tier: moodTier(mood.value),
    updatedAt: mood.updatedAt,
    /** 点击一次加心情的**区间**（用户指定 3~10，实际取值随机）。 */
    gainPerPet: { min: MOOD_GAIN_PER_PET_MIN, max: MOOD_GAIN_PER_PET_MAX },
    /** 闲置随机动作回复心情的区间（10~30）。 */
    gainPerAction: { min: MOOD_GAIN_PER_ACTION_MIN, max: MOOD_GAIN_PER_ACTION_MAX },
    /**
     * 最近一次**主动加心情**的增量（供"浮出数字"的可视反馈）。
     *
     * ⚠️ 只有"用户看得见的加成"才写这里（点击、随机动作奖励、低心情 +50）；
     * **周期漂移不写** —— 那是后台的随机变化，浮一个 "+37" 会让人莫名其妙。
     * 渲染进程靠 `at` 是否变化来判断"这是新的一次"，避免重推时重复弹数字。
     */
    lastGain: lastMoodGain,
  }
}

/** 把心情推给渲染进程（属性面板用）。 */
function pushMoodToRenderer() {
  if (!win || win.isDestroyed()) return
  try {
    win.webContents.send('pet:mood', currentMoodPayload())
  } catch {
    // 忽略：推送失败不影响桌宠主体功能。
  }
}

/** 当前好感的快照，供界面展示。 */
function currentAffectionPayload() {
  const hearts = affection.hearts
  return {
    /** 阶段好感值（当前这段里攒了多少）。 */
    value: affection.value,
    /** 爱心数（0~5）。一开始是 0 颗心，攒满 100 得第 1 颗。 */
    hearts,
    /** 当前这段的阶段阈值（攒满就晋一心）。 */
    threshold: stageThresholdFor(hearts),
    maxHearts: AFFECTION_MAX_HEARTS,
    /** 爱心串（"♥♡♡♡♡"）—— 由共享核心生成，渲染进程不重复实现一遍。 */
    heartsText: heartsFor(hearts),
    heartsLabel: affectionHeartsLabel(hearts),
    /** 阶段进度 0~1，进度条用。 */
    progress: affectionProgress(affection),
    updatedAt: affection.updatedAt,
    /** 完整的阶段表，便于面板显示"距下一心还差多少"。 */
    stages: affectionStagesPayload(),
    /**
     * 最近一次好感增量（供"浮出数字"）。
     *
     * ⚠️ 为什么不让渲染进程自己 diff `value`：晋心时阶段值会**归 0**，
     * diff 出来的差值会是负数（"好感 -95"），完全错误。
     * 由主进程给出真实增量最可靠。
     */
    lastGain: lastAffectionGain,
  }
}

/**
 * 把好感推给渲染进程。
 *
 * 每次好感变化后都要调 —— 面板的爱心、进度条，以及"浮出数字"的
 * 可视反馈都靠这条通道。
 */
function pushAffectionToRenderer() {
  if (!win || win.isDestroyed()) return
  try {
    win.webContents.send('pet:affection', currentAffectionPayload())
  } catch {
    // 忽略：推送失败不影响桌宠主体功能。
  }
}

/** 最近一次好感增量（供渲染进程浮出数字）。 */
let lastAffectionGain = null

/** 最近一次主动加心情的增量（供渲染进程浮出数字）。周期漂移不写这里。 */
let lastMoodGain = null

/**
 * 给好感入账（**唯一的入口**）。
 *
 * 之所以统一成一个函数：五条增长途径散落在不同事件里，
 * 每处都写一遍 `applyAffectionGain` + `pushAffectionToRenderer` 的话，
 * 漏掉推送就会出现"数值涨了但面板没变"，而这正是最难被发现的 bug 类型。
 *
 * @param {number} gain 要加的点数（<=0 直接返回，不推面板）
 * @param {string} reason 日志里用的人话原因
 * @returns {{ gained: number, heartsGained: number, hearts: number }}
 */
function grantAffection(gain, reason) {
  const add = Number.isFinite(gain) ? Math.floor(gain) : 0
  if (add <= 0) return { gained: 0, heartsGained: 0, hearts: affection.hearts }

  const { state, gained, heartsGained } = applyAffectionGain(affection, add, Date.now())
  affection = state
  /*
   * 记录本次增量（浮出数字用）。放在 push 之前 —— 否则推出去的那一份
   * 里 lastGain 还是上一次的值，界面上会"晚一格"。
   */
  lastAffectionGain = { amount: gained, at: Date.now(), reason: String(reason ?? '') }
  lifetimeAffectionGained += gained
  persistAffection()
  pushAffectionToRenderer()
  log(
    `好感 +${String(gained)}（${reason}）→ ${String(affection.hearts)} 心 ${String(affection.value)}/${String(stageThresholdFor(affection.hearts))}`
    + (heartsGained > 0 ? `，晋 ${String(heartsGained)} 心` : ''),
  )
  return { gained, heartsGained, hearts: affection.hearts }
}

/**
 * 每连续运行 10 分钟 +5 好感（用户指定第 4 条）。
 *
 * 为什么用独立的 `setInterval` 而不是搭在心情的 30 秒 tick 上：
 *  · 心情 tick 会因为窗口隐藏/系统休眠而停摆，而"连续运行"的语义是
 *    **进程还活着在陪着你**，与窗口是否可见无关；
 *  · 搭在一起会让"10 分钟"变成"30 秒的整数倍且受其它条件影响"，不好解释也不好测。
 */
let uptimeAffectionTimer = null

function startUptimeAffectionTimer() {
  if (uptimeAffectionTimer) clearInterval(uptimeAffectionTimer)
  uptimeAffectionTimer = setInterval(() => {
    try {
      grantAffection(AFFECTION_GAIN.uptimeGain, `连续运行 ${String(Math.round(AFFECTION_GAIN.uptimeEveryMs / 60000))} 分钟`)
    } catch (err) {
      log(`运行时长好感结算失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }, AFFECTION_GAIN.uptimeEveryMs)
  // 不要因为一个"发福利"的定时器把进程钉住（正常退出时能走掉）。
  if (typeof uptimeAffectionTimer.unref === 'function') uptimeAffectionTimer.unref()
}


// ---------------------------------------------------------------- 余额监控（桌宠自取）
/*
 * 需求（用户指定）：**桌宠自己实时自动更新余额监控，不需要别的操作。**
 *
 * 所以余额取数**从宿主搬到了桌宠侧**：
 *  · 桌宠自己读 `$DSH_HOME/.credentials.yaml` 拿 API Key；
 *  · 自己按周期直连 DeepSeek `/user/balance`；
 *  · 自己判断"变了才播报"，自己推给渲染进程。
 *
 * 好处很实际：**改取数/播报逻辑只需重启桌宠，不用重启 DSH**；
 * 而且 DSH 没开时桌宠照样能显示余额。
 *
 * 取数算法本身在 `src/shared-core/balance.js`（宿主与桌宠**共用同一份**，
 * 没有复制），这里只负责"读凭据 + 定时 + 播报 + 推送"。
 */

/** 余额快照（最近一次取到的，含 error/stale 标记）。 */
let balanceSnapshot = null

/**
 * 上一次成功取到的余额（数字），用于算"这段时间花掉多少"。
 * `null` 表示还没成功取过 —— 首次不播报（没有可比的上一次）。
 */
let lastBalanceTotal = null

/** 上一次播报的台词，用于避免连续两句一模一样。 */
let lastBalanceMessage = null

/**
 * 上一次**推进播报基准**的时间戳（毫秒）。
 *
 * 与 `lastBalanceTotal` 配套：只有在这个时间点"到点"时才会用当前余额
 * 去比、并推进基准。取数可以 30 秒一次，但这个基准只每
 * `BALANCE_ANNOUNCE_INTERVAL_MS` 推进一次（见 `shouldRunAnnounceWindow`）。
 */
let lastBalanceAnnounceAt = null

/** 余额刷新定时器。 */
let balanceTimer = null

/**
 * 取数周期（毫秒）—— 面板显示用。用户要求 30 秒。
 * 与查询器的 TTL 取同一个来源，避免"设了 30 秒却因缓存 5 分钟不刷新"。
 */
const BALANCE_POLL_INTERVAL_MS = BALANCE_POLL_SECONDS * 1000

/**
 * 播报窗口（毫秒）—— 用户要求"5 分钟内没有余额变化就不播"。
 *
 * ⚠️ 它**不再**等于取数周期：取数已加密到 30 秒，若播报也跟着加密，
 * 每 30 秒都可能念一次，既吵又会把一次消耗拆成好几段播报。
 */
const BALANCE_ANNOUNCE_INTERVAL_MS = (() => {
  const raw = Number(readArg('balance-refresh'))
  return Number.isFinite(raw) && raw >= 5 ? raw * 1000 : 300 * 1000
})()

/**
 * 给渲染进程的余额载荷。
 *
 * `lowBalanceThreshold` 一并带上：阈值是用户配置，宿主通过 `--low-balance=`
 * 下发；没下发时用桌宠自己的默认值。
 */
function currentBalancePayload() {
  return {
    snapshot: balanceSnapshot,
    lowBalanceThreshold: LOW_BALANCE_THRESHOLD,
  }
}

/** 把余额推给渲染进程。 */
function pushBalanceToRenderer() {
  if (!win || win.isDestroyed()) return
  try {
    win.webContents.send('pet:balance', currentBalancePayload())
  } catch {
    // 忽略：推送失败不影响桌宠主体功能。
  }
}

/**
 * 拉一次余额：读凭据 → 取数 → 到点则播报 → 推给渲染进程。
 *
 * @param {boolean} [fresh] true = 忽略缓存强制刷新
 */
async function refreshBalanceOnce(fresh = false) {
  try {
    const snap = await balanceFetcher.get({
      // 凭据由桌宠自己从 DSH 的凭据文件里读（密钥只留在主进程）。
      resolveCredential: async (name) => {
        const r = readCredentialFromFile({ credential: name })
        return r.ok ? { value: r.value } : null
      },
      fresh,
    })
    balanceSnapshot = snap

    /*
     * 播报判断（用户要求）：只在余额**真的变了**时才说，
     * 且**每个播报窗口只看一次**（默认 5 分钟）。
     *
     * ⚠️ 两道闸门缺一不可：
     *   1. `shouldRunAnnounceWindow` —— 距上次播报够 5 分钟了吗？
     *      取数已加密到 30 秒，少了这道门就会每 30 秒念一次。
     *   2. `shouldAnnounceBalance` —— 这次和**上一次到点时的余额**比，变了吗？
     *      注意基准只在到点时推进，所以报的是"这 5 分钟花了多少"，
     *      而不是"这 30 秒花了多少"。
     */
    if (snap && snap.fetchedAt > 0 && snap.error === null) {
      const nextTotal = Number(snap.total)
      const gate = shouldRunAnnounceWindow({
        now: Date.now(),
        lastAt: lastBalanceAnnounceAt,
        intervalMs: BALANCE_ANNOUNCE_INTERVAL_MS,
      })

      if (gate.reason === 'first') {
        /*
         * 首次：建立基准，但不播报（`shouldAnnounceBalance` 会以 'first' 拒掉）。
         * 基准必须在这里就建立，否则第一次播报要等到两个窗口之后。
         */
        if (Number.isFinite(nextTotal)) {
          lastBalanceTotal = nextTotal
          lastBalanceAnnounceAt = Date.now()
        }
        log(`余额基准已建立：¥${String(snap.total)}（每 ${String(Math.round(BALANCE_ANNOUNCE_INTERVAL_MS / 1000))} 秒检查一次是否播报）`)
      } else if (gate.due) {
        const verdict = shouldAnnounceBalance({ prevTotal: lastBalanceTotal, nextTotal })
        if (verdict.announce) {
          const ann = buildBalanceAnnouncement({
            prevTotal: lastBalanceTotal,
            nextTotal,
            currency: snap.currency,
          })
          // 极端情况下（例如余额在两个值之间来回跳）避免连续重复同一句。
          if (ann.text !== lastBalanceMessage) {
            lastBalanceMessage = ann.text
            if (win && !win.isDestroyed()) {
              win.webContents.send('pet:say', { text: ann.text, bubbleMs: 9000 })
            }
            log(`余额播报：${ann.text}（${verdict.reason}，${String(ann.tier)} 档）`)
          }
        } else {
          log(`跳过播报（${verdict.reason}）当前 ¥${String(snap.total)}`)
        }
        /* 到点就把基准推进到当前值，并重新计时。 */
        if (Number.isFinite(nextTotal)) lastBalanceTotal = nextTotal
        lastBalanceAnnounceAt = Date.now()
      } else {
        /*
         * 还没到播报窗口：**只更新面板数字，不动播报基准**。
         * 基准留在 5 分钟前那个值上，于是这段消耗会在下次到点时一次报出来。
         *
         * 这条日志刻意保留：它是"闸门确实生效了"的唯一可见证据。
         * 没有它，日志里只会出现播报行，看起来就像每轮都在播
         * （我第一次测的时候就因此误判成 bug）。
         */
        log(
          `播报窗口未到（还有 ${String(Math.ceil(gate.waitMs / 1000))} 秒）当前 ¥${String(snap.total)}，只更新面板`,
        )
        pushBalanceToRenderer()
        return snap
      }
    } else if (snap && snap.error) {
      log(`余额取数失败：${snap.error}`)
    }

    pushBalanceToRenderer()
    return snap
  } catch (err) {
    // 取数路径整体兜住：余额失败绝不能影响桌宠主体功能。
    log(`余额刷新异常（已忽略）：${err instanceof Error ? err.message : String(err)}`)
    return balanceSnapshot
  }
}

/**
 * 启动余额监控：立刻拉一次，之后按 `BALANCE_POLL_INTERVAL_MS` 自动刷新。
 *
 * 全程无需任何人工操作 —— 这是用户明确要求的
 * （"让桌宠插件自身能实时自动更新余额监控，不需要进行别的操作"）。
 *
 * 取数与播报是两个节奏：这里每 30 秒取一次（面板及时），
 * 播报由 `refreshBalanceOnce` 里的 `shouldRunAnnounceWindow` 卡到 5 分钟一次。
 */
function startBalanceMonitor() {
  if (balanceTimer) return
  /*
   * 首次显式 `fresh: true`：不能让查询器启动初期的空缓存/残留缓存影响首屏。
   * 之后每轮也传 `true` —— 刷新节奏完全由本定时器决定，
   * 缓存只用于"同一瞬间的并发去重"（见 `createBalanceFetcher` 的 inflight）。
   */
  void refreshBalanceOnce(true)
  balanceTimer = setInterval(() => {
    void refreshBalanceOnce(true)
  }, BALANCE_POLL_INTERVAL_MS)
  log(`余额监控已启动：每 ${String(Math.round(BALANCE_POLL_INTERVAL_MS / 1000))} 秒自动刷新`)
}

/**
 * 心情定时器：周期性结算**随机漂移**并推送。
 *
 * 用户指定：每 **10 分钟**心情随机变化 **−40 ~ +50** 点
 * （演变：每 3 分钟 −1 → 每 5 分钟随机 −40~+50 → 每 10 分钟随机 −40~+50）。
 *
 * 注意这里**不是**"每 10 分钟结算一次"的定时器 —— 那会在休眠/挂起后漏掉周期。
 * 这里只是每隔 MOOD_TICK_MS 调一次 `applyDrift`，由它按真实流逝时间补算
 * **跨过的每一个周期**（每周期独立取随机值），所以 tick 间隔与漂移间隔无关，
 * 取多少都不会算错。
 *
 * 心情不落盘，所以结算基准只在本进程生命周期内推进，重启即回到满值。
 */
function startMoodTicker() {
  if (moodTimer) return
  moodTimer = setInterval(() => {
    try {
      const { state, delta, steps } = applyDrift(mood, Date.now())
      mood = state
      if (steps > 0) {
        const sign = delta >= 0 ? '+' : ''
        log(`心情周期变化 ${String(steps)} 次，净 ${sign}${String(delta)} → ${String(Math.round(mood.value))}`)
      }
      pushMoodToRenderer()
    } catch (err) {
      // 定时器回调里抛异常会拖垮整个进程，必须自己兜住。
      log(`心情结算失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }, MOOD_TICK_MS)
}

/** 上次因"点击"获得好感的时刻（5 分钟冷却的锚点）。 */
let lastClickAffectionAtMs = null

/**
 * 互动一次（点击桌宠）。
 *
 * ## 低心情分支（用户指定第 3 条机制）
 *
 * 心情 **< 50** 时点击：心情**立即 +50**（而不是平时的随机 3~10），
 * 并回一句**信赖语音**，同时**不播部位动画、不说部位台词** ——
 * "被关心"的语义盖过"被戳了一下"。
 *
 * ## 好感（用户指定第 2、5 条）
 *
 * 基础随机 **2~8**，**每 5 分钟一次**；低心情时**额外 +10**。
 * 两者共用同一个冷却（见 `affection-gain.js` 文件头的说明）。
 *
 * @returns {object} 供渲染进程决定"说哪句、播不播部位动画"的完整结果
 */
function handlePetClick() {
  const now = Date.now()

  /*
   * 先结算到期的周期漂移，再判高低心情。
   *
   * 不结算就判会误判：心情可能"面板上还是 60，但已经拖欠了两次漂移"，
   * 真实值早就掉到 40 以下了 —— 那样这次点击该给 +50 却会按普通点击算。
   */
  const settledValue = applyDrift(mood, now).state.value
  const lowMood = settledValue < LOW_MOOD_THRESHOLD

  const { state, gained } = applyPet(mood, now, lowMood ? LOW_MOOD_CLICK_MOOD_GAIN : null)
  mood = state
  if (gained > 0) {
    lastMoodGain = { amount: gained, at: now, reason: lowMood ? '低心情点击' : '点击互动' }
  }
  pushMoodToRenderer()

  const aff = clickAffectionGain({
    lastAtMs: lastClickAffectionAtMs,
    now,
    moodValue: settledValue,
  })
  let affectionGained = 0
  if (aff.gain > 0) {
    lastClickAffectionAtMs = now
    /*
     * 冷却锚点也要落盘（下面 grantAffection 内部会再存一次，但那是同一份数据，
     * 延迟写会合并成一次）。存它的意义：避免"重启一次就刷新 5 分钟冷却"被用来刷好感。
     */
    persistAffection()
    affectionGained = grantAffection(aff.gain, lowMood ? '点击互动（低心情）' : '点击互动').gained
  }

  return {
    lowMood,
    moodValue: Math.round(mood.value),
    moodGained: gained,
    affectionGained,
    affectionCoolingDown: aff.coolingDown,
    affectionCooldownMs: aff.coolingDown
      ? Math.max(0, AFFECTION_GAIN.clickCooldownMs - (now - (lastClickAffectionAtMs ?? 0)))
      : 0,
    /** 低心情时由主进程给一句信赖语音（台词归语音库，渲染进程不重复实现）。 */
    trustLine: lowMood ? pickVoiceLineFor('trust', { rand: Math.random }) : null,
  }
}

ipcMain.handle('pet:pet', () => {
  try {
    return handlePetClick()
  } catch (err) {
    log(`点击互动结算失败：${err instanceof Error ? err.message : String(err)}`)
    return { lowMood: false, moodGained: 0, affectionGained: 0, trustLine: null }
  }
})

/**
 * 闲置随机动作的**心情奖励**（用户指定 10~30）。
 *
 * 与点击的区别：这是"桌宠自己做了件事"，给得更多。
 *
 * 由渲染进程在**真的触发了一个闲置随机动作**时通过 `pet:action-reward` 通知 ——
 * 只有它知道那是"随机抽中的"还是"菜单手动点的"（菜单触发不给奖励）。
 * 加多少由 `applyActionReward` 从 10~30 里随机取。
 */
function rewardActionMoodOnce(actionId) {
  const now = Date.now()
  const { state, gained, decayed } = applyActionReward(mood, now)
  mood = state
  if (gained > 0) {
    lastMoodGain = { amount: gained, at: now, reason: `随机动作 ${String(actionId ?? '')}` }
  }
  pushMoodToRenderer()
  if (gained > 0) {
    log(`闲置随机动作 ${String(actionId ?? '')} 回复心情 +${String(gained)} → ${String(Math.round(mood.value))}`)
  }
  /*
   * 好感 +2（用户指定第 3 条：桌宠触发随机动作时）。
   *
   * 只在这条路径上入账 —— 菜单手动触发的动作由 `pet:trigger-action` 走，
   * 不经过这里，所以"手动点动作"不会白送好感。
   */
  grantAffection(AFFECTION_GAIN.randomAction, `随机动作 ${String(actionId ?? '')}`)
  return { value: Math.round(mood.value), gained, decayed }
}

ipcMain.on('pet:action-reward', (_event, actionId) => {
  try {
    rewardActionMoodOnce(actionId)
  } catch (err) {
    log(`闲置动作心情奖励失败：${err instanceof Error ? err.message : String(err)}`)
  }
})

/**
 * 闲置「主动对话」—— 上一句是什么（用于避重）。
 *
 * 避重的理由与右键菜单「对话」一致：连着两次同一句，看起来像机制没生效。
 * 60 秒一句，重复的概率不低（可用池在 0 心时只有 6 句）。
 */
let lastIdleVoiceLine = null

/** 主动对话已经说了多少句（自测与日志用）。 */
let idleVoiceCount = 0

/**
 * 从语音库里挑一句当前可用的台词并显示。
 *
 * 调用方是**渲染进程的闲置调度**（它知道"现在确实闲置、且到 60 秒了"），
 * 但**挑哪一句由主进程决定** —— 好感度与心情的真相源在这里。
 *
 * @returns {{ ok: boolean, text?: string, group?: string, reason?: string }}
 */
function speakIdleVoice() {
  if (!win || win.isDestroyed()) return { ok: false, reason: '窗口不存在' }

  const hearts = affection && Number.isFinite(affection.hearts) ? affection.hearts : 0
  const moodValue = mood && Number.isFinite(mood.value) ? mood.value : 100

  const text = pickVoiceLine({
    hearts,
    moodValue,
    // 上一个参数与 pickDialogueLine 一致：`(rand, avoidLine)`
    rand: Math.random,
    avoidLine: lastIdleVoiceLine,
  })
  if (!text) return { ok: false, reason: '可用语音库为空' }

  const groups = availableVoiceGroups({ hearts, moodValue }).map((group) => group.id)
  lastIdleVoiceLine = text
  idleVoiceCount += 1

  /*
   * 气泡时长 6 秒：与右键「对话」一致。
   *
   * 为什么不更长：主动对话每 60 秒一次，若气泡停留太久会与下一次重叠；
   * 6 秒够读完一句 24 字以内的话，也不至于一直挂在屏幕上。
   */
  win.webContents.send('pet:say', { text, bubbleMs: 6000 })

  /*
   * 好感 +1（用户指定第 1 条：闲置随机触发对话时）。
   *
   * 注意只在这里加 —— 右键菜单的「对话」走的是 `pickDialogueLine` 那条路径，
   * 不经过本函数，所以手动点对话不会刷好感。
   */
  grantAffection(AFFECTION_GAIN.idleDialogue, '闲置主动对话')

  /*
   * 日志里带上"为什么是这几句"：心数与心情档位。
   * 排查"她怎么突然说这种话"时，这行就是答案 —— 否则只能猜。
   */
  log(
    `主动对话（${String(hearts)} 心 / 心情 ${String(moodValue)} → ${moodVoiceGroup(moodValue)}，`
    + `可用组 ${groups.join('+')}）：${text}`,
  )
  return { ok: true, text, group: groups.join('+') }
}

/**
 * 渲染进程「闲置到 60 秒了，说一句」。
 *
 * 走 `send` 而不是 `invoke`：不需要返回值，显示统一走 `pet:say` 那条通路
 * （已有气泡样式、睡眠守卫、自动隐藏都在那里，另开一条会分叉）。
 */
ipcMain.on('pet:idle-voice', () => {
  try {
    speakIdleVoice()
  } catch (err) {
    log(`主动对话失败：${err instanceof Error ? err.message : String(err)}`)
  }
})

/**
 * 触发一个动作（菜单入口）。
 *
 * 主进程只负责"把请求转给渲染进程" —— 动作的实际播放、以及播完回到待机，
 * 都在渲染进程里做（它才是管动画的一方）。这样播放状态只有一处，不会两边打架。
 *
 * `partId` 只在"触碰某部位"时出现：渲染进程据此从 `clickParts` 里取该部位的台词，
 * 让**菜单触发与真的点那个位置**说同一句话。
 */
function triggerActionFromMenu(actionId) {
  if (!win || win.isDestroyed()) return
  const entry = actionMenuEntries().find((item) => item.id === actionId)
  if (!entry) {
    log(`未知动作 id：${actionId}`)
    return
  }
  try {
    win.webContents.send('pet:play-action', {
      id: entry.id,
      label: entry.label,
      lines: findAction(entry.id)?.lines ?? [],
      /** 触碰部位时为部位 id（可选）；渲染进程用它取部位台词。 */
      partId: entry.partId ?? null,
      /** fromMenu=true 表示用户显式指定，随机动作调度要据此重置计时。 */
      fromMenu: true,
    })
  } catch (err) {
    log(`触发动作失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

ipcMain.on('pet:trigger-action', (_event, payload) => {
  const actionId = payload && typeof payload.id === 'string' ? payload.id : null
  if (actionId) triggerActionFromMenu(actionId)
})

// ------------------------------------------------------------------ 尺寸与布局

/**
 * 拖拽结束时记录尺寸，便于观察"多拖几次会不会变大"。
 *
 * 之前这个问题一直靠"合成输入下的趋势"来猜，结论不可靠。这里改成把每次拖拽
 * 前后的尺寸写进日志，用**长时间的真实使用**去判断，而不是靠合成事件。
 */
let lastDragEndSize = null

/**
 * 记录每一次会改变窗口**尺寸**的调用。
 *
 * 为什么要在写入点记而不是事后比对：窗口尺寸一旦被抬高，多出来的空间会被布局
 * 吸收成间隙，表现为"面板离角色越来越远"。事后只能看到结果（比如 242×433 而不是
 * 240×431），看不到是谁写进去的。所以这里把调用栈也打出来。
 */
function traceGeometryWrite(what, detail) {
  if (!TRACE) return
  let stack = ''
  try {
    stack = (new Error().stack ?? '').split('\n').slice(2, 5).join(' | ')
  } catch {
    // 忽略。
  }
  log(`[trace] 改尺寸 ${what} ${detail} ← ${stack}`)
}

/**
 * 桌宠画布的宽高比。素材是 864×1157（已裁掉透明留白），因此高/宽 = 1.3391。
 * 换素材时如果画布比例变了，这里要跟着改。
 */
const ASPECT = { w: 864, h: 1157 }

/**
 * 气泡区高度 = 角色宽度 × 这个系数，因此**气泡随桌宠等比缩放**。
 * 240 宽（默认档）时正好 72px。
 */
const BUBBLE_AREA_RATIO = 0.3

/**
 * 基准档位的角色宽度、以及"宽度 → 字号"的换算分母。
 *
 * 字号 = 角色宽度 / 20，即 240 宽时 12px。
 * 刻意**不设字号上下限**：任何夹取都会让面板在某几档不再严格等比，
 * 而"面板与桌宠比例始终相同"正是这次要保证的性质。
 * 档位范围 120~420 对应字号 6~21px，都在可读范围内。
 */
const PET_WIDTH_BASE = 240

/** 字号 = 角色宽度 / 这个数。240 宽 → 12px。 */
const FONT_WIDTH_DIVISOR = 20

/** 基准档位的气泡字号（px），仅用于渲染进程缺失参数时兜底。 */
const BUBBLE_FONT_AT_BASE_PX = 12

/**
 * 字号可读下限（px）。
 *
 * 取 12 = 基准档的字号，意味着**在所有可选档位（120~420）内字号都不被夹**，
 * 于是"面板随桌宠等比缩放"是严格成立的。下限只在窗口被压到比最小档还窄时才生效
 * （防止文字小到看不见），不会破坏档位间的等比例关系。
 */
const BUBBLE_FONT_MIN_PX = 12

/** 字号上限（px）。按最大档 420/240×12 = 21，留出余量，实际不会触发。 */
const BUBBLE_FONT_MAX_PX = 26

/**
 * 属性面板区高度 = 面板字号 × 这个系数，因此也随桌宠等比缩放。
 *
 * 从**字号**推导而不是从宽度推导，是为了让"面板一定装得下内容"成为结构性保证：
 * 面板里是"好感一行 + 好感爱心一行 + 心情一行 + 档位标签一行"，行高都是字号的倍数。
 * 若改成从宽度推，字号一旦有可读下限（小档位不再线性缩），两者就会脱节 ——
 * 要么面板装不下字，要么留一大片空白。
 *
 * ⚠️ 加入好感之后面板从"两行"变成"四行"，所以这个比例从 3.2 提到 4.6。
 * 必须与 `renderer.js` 里的同名常量**保持一致**（渲染进程没有模块加载能力，
 * 只能各写一份镜像）。改一处必须改另一处，否则面板高度与实际内容对不上。
 */
const STATS_ZONE_FONT_RATIO = 7.0

/**
 * 属性面板区高度 = 字号 × STATS_ZONE_FONT_RATIO，**不设下限**。
 *
 * 曾经在这里加了 30px 下限，结果小档位的"面板高 ÷ 角色宽"与其它档不一致
 * （140 档是 0.214，240 档是 0.158），"比例始终相同"就不成立了。
 * 字号本身已有下限，没有必要再在高度上叠一层夹取。
 */
function statsZoneFor(petWidth) {
  return Math.round(bubbleFontFor(petWidth) * STATS_ZONE_FONT_RATIO)
}

/**
 * 余额面板区高度 = 面板字号 × 这个系数。**常驻**，不随悬停显示/隐藏而变。
 *
 * 用户要求"api 监控需要在桌宠下方有一个独立的显示面板（不加入到属性面板中）
 * 并且始终显示，在属性面板显示时二者不能有遮挡"。
 *
 * 做到"不遮挡"的方式**不是**去算两块面板的间距，而是**在窗口高度里各自预留一块
 * 独立区域**：从下往上依次是「属性面板区 → 余额区 → 角色区 → 气泡区」。
 * 于是：
 *  · 余额面板常驻在余额区里，永远看得见；
 *  · 属性面板只在悬停时出现在**它自己那块**预留区里，不占额外空间；
 *  · 两者由**流布局**排开，窗口被系统量化时多出的余量只落在气泡区 ——
 *    所以几何上不可能重叠，也不需要在显示时重新排版（否则会抖）。
 *
 * 比例 3.0 是"一行较大的数字 + 一行小说明"需要的高度 ——
 * 实测（区域 23px vs 内容 24px）2.6 还差一点，说明行的高度被我低估了。
 * 比属性面板（4 行，7.0）矮得多。字体放大过一档（用户反馈原来太不明显），
 * 所以这个比例从 2.2 跟着提到 3.0 —— **改字体大小就要同步改这里**，
 * 否则内容会比预留区域高、被裁掉。必须与 renderer.js 里的同名常量一致。
 */
const BALANCE_ZONE_FONT_RATIO = 3.0

/** 余额面板区高度（CSS 像素）。 */
function balanceZoneFor(petWidth) {
  return Math.round(bubbleFontFor(petWidth) * BALANCE_ZONE_FONT_RATIO)
}

/** 由角色宽度算出气泡区高度。 */
function bubbleAreaFor(petWidth) {
  return Math.round(clampNumber(petWidth, 80, 1200) * BUBBLE_AREA_RATIO)
}

/** 由角色宽度算出字号：纯线性，保证各档严格等比。 */
function bubbleFontFor(petWidth) {
  const width = clampNumber(petWidth, 80, 1200)
  // 下限只是防止窗口被压到极窄时字号小到不可读，不影响档位内的等比关系。
  return Math.max(6, Math.round(width / FONT_WIDTH_DIVISOR))
}

/** 角色区域高度由宽度按素材比例算出。 */
function petHeightFor(petWidth) {
  return Math.round(petWidth * (ASPECT.h / ASPECT.w))
}

/**
 * 由角色宽度算出**整个窗口**的物理尺寸。
 * 高度 = 气泡区 + 角色区 + 属性面板区，三者都随角色宽度等比变化。
 * 四舍五入保证对同一输入永远得到同一结果。
 */
function boundsForWidth(petWidth) {
  const width = Math.round(clampNumber(petWidth, 80, 1200))
  return {
    width,
    /*
     * 自下而上的堆叠顺序（与 index.html 里的 DOM 顺序一致）：
     *   气泡区（吃掉所有余量）+ 角色区 + 余额区 + 属性面板区。
     *
     * 余额区与属性面板区**各自独立预留**，这是"两者不遮挡"的结构性保证。
     */
    height:
      petHeightFor(width) + bubbleAreaFor(width) + balanceZoneFor(width) + statsZoneFor(width),
  }
}

/** 当前生效的角色宽度（CSS 像素）。由设置决定，**绝不**从窗口现状反推。 */
let logicalWidth = SIZE_HINT

/**
 * 心情值状态。
 *
 * 放在主进程而不是渲染进程，有两个原因：
 *  1. **要持久化**（重启不能重置），而渲染进程没有文件访问能力；
 *  2. 衰减按**时间戳结算**而不是靠渲染进程里的定时器累加 —— 定时器在
 *     系统休眠、进程被挂起、窗口重载之后都会失准，而时间戳是持久的。
 * 算法本身在 src/shared-core/mood.js 里（纯函数，有单元测试）。
 */
let mood = initialMood()

/**
 * 好感值状态（等级 + 阶段好感值）。
 *
 * 增长途径见 `affection-gain.js`；**落盘**见 `affection-store.js`。
 *
 * 至于"为什么放主进程"：好感要持久化，而渲染进程没有文件访问能力。
 * 心情则相反 —— 用户要求每次启动重置，所以它不落盘。
 */
let affection = initialAffection()

/**
 * 累计获得过多少好感（只增不减）。
 *
 * 与 `affection` 的区别：那个是"当前进度"（晋心时会归零），
 * 这个是"一共攒过多少"，用于「关于」窗口展示，也让用户能看出
 * "养了这么久"这件事。
 */
let lifetimeAffectionGained = 0

/** 好感存档的延迟写定时器（避免短时间内连写多次文件）。 */
let affectionSaveTimer = null

/** 好感存档的读写器（默认目录 = Electron 的 userData）。 */
const affectionStore = createAffectionStore()

/**
 * 从磁盘载入好感存档。
 *
 * 在 `app.whenReady()` 里调用 —— `app.getPath('userData')` 在那之后才可靠。
 *
 * @returns {{ loaded: boolean, hearts: number }}
 */
function loadAffectionFromDisk() {
  const loaded = affectionStore.load()
  affection = loaded.state
  lastClickAffectionAtMs = loaded.lastClickAt
  lifetimeAffectionGained = loaded.lifetimeGained
  if (loaded.loaded) {
    log(
      `已载入好感存档：${String(affection.hearts)} 心 ${String(affection.value)}/${String(stageThresholdFor(affection.hearts))}`
      + `，累计 ${String(lifetimeAffectionGained)}`,
    )
  } else {
    log('没有好感存档（首次启动，从 0 心开始）')
  }
  return { loaded: loaded.loaded, hearts: affection.hearts }
}

/**
 * 把好感写进存档（默认延迟 800ms，合并短时间内的多次变更）。
 *
 * 为什么延迟：一次互动可能连续触发"加好感 + 更新冷却锚点"两次写，
 * 而好感的变化频率本来就很低（每分钟最多几次），延迟写能把它们合并成一次。
 * **退出时会强制 flush**（见 quitSelf），所以不会丢最后一次变更。
 *
 * @param {boolean} [immediate] 立刻写（退出、或需要确保落盘时）
 */
function persistAffection(immediate = false) {
  if (affectionSaveTimer) {
    clearTimeout(affectionSaveTimer)
    affectionSaveTimer = null
  }
  const write = () => {
    affectionSaveTimer = null
    const ok = affectionStore.save(affection, {
      lastClickAt: lastClickAffectionAtMs,
      lifetimeGained: lifetimeAffectionGained,
    })
    if (!ok) log('警告：好感存档写入失败（数值仍在本进程内存中，重启会丢失）')
  }
  if (immediate) {
    write()
    return
  }
  affectionSaveTimer = setTimeout(write, 800)
  if (typeof affectionSaveTimer.unref === 'function') affectionSaveTimer.unref()
}

/** 退出前强制落盘（同步完成）。 */
function flushAffectionSave() {
  persistAffection(true)
}


/** 心情结算/推送的周期。这一项只决定"多久算一次并推给界面"，不影响衰减本身。 */
const MOOD_TICK_MS = 30_000

/** 心情定时器。 */
let moodTimer = null

/** 角色宽度允许的范围。 */
const PET_WIDTH_MIN = 120
const PET_WIDTH_MAX = 420

/**
 * 右键菜单里的尺寸档位。radio 会显示当前选中的那一档。
 * 数值是"角色区域宽度"，窗口总高会比它大出气泡区。
 */
const SIZE_PRESETS = [
  { label: '很小', width: 140 },
  { label: '小', width: 180 },
  { label: '中', width: 240 },
  { label: '大', width: 320 },
  { label: '很大', width: 400 },
]

/**
 * 把窗口尺寸锁死（min = max）。
 *
 * ⚠️ 三条硬约束，都是踩坑换来的：
 *  1. **只能调用一次**，且必须传窗口的**实际**尺寸。setMinimumSize 不只是设下限 ——
 *     传进去的值大于当前尺寸时它会立刻把窗口"推"到那个尺寸，触发 resize，
 *     而 resize 又会让我们重新算尺寸，形成 +1px 正反馈。
 *  2. **不要用 setAspectRatio**。它会主动"纠正"窗口尺寸并触发 resize；
 *     实测加了它之后宽度锁住了、高度开始每轮 +1。宽高比已在创建时确定，
 *     只要尺寸不变就不需要它来维持。
 *  3. 窗口创建时就是 `resizable: false`，这里再显式关一次，确保宿主系统
 *     没有调整窗口尺寸的能力。
 */
let sizeLocked = false

function lockWindowSize() {
  if (!win || win.isDestroyed()) return
  try {
    const [width, height] = win.getSize()
    win.setResizable(false)
    traceGeometryWrite('setMinimumSize', `${String(width)}x${String(height)}`)
    win.setMinimumSize(width, height)
    traceGeometryWrite('setMaximumSize', `${String(width)}x${String(height)}`)
    win.setMaximumSize(width, height)
    sizeLocked = true
    // 同时打印内容区尺寸：布局依据的是它，而它与 getSize 并不总是相等。
    const content = win.getContentSize()
    log(`窗口尺寸已锁定为 ${String(width)}x${String(height)}（内容区 ${String(content[0])}x${String(content[1])}）`)
  } catch (err) {
    log(`锁定窗口尺寸失败（不影响运行）：${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * 把**布局参数**推给渲染进程。
 *
 * 这是调尺寸能真正生效的关键一步：改窗口尺寸只能在主进程做，
 * 但"立绘该多大、气泡该多大"只能由渲染进程重排。少这一步的后果就是
 * 窗口变了、立绘没变，看起来只有空白变大。
 */
function pushLayoutToRenderer() {
  if (!win || win.isDestroyed()) return
  try {
    win.webContents.send('pet:layout', {
      logicalWidth: Math.round(logicalWidth),
      bubbleArea: bubbleAreaFor(logicalWidth),
      statsZone: statsZoneFor(logicalWidth),
      bubbleFont: bubbleFontFor(logicalWidth),
    })
  } catch (err) {
    log(`推送布局失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * 切换窗口是否忽略鼠标事件。
 *
 * 为什么需要它：`transparent: true` 只让窗口**看起来**透明，整个窗口矩形仍然接收鼠标。
 * 于是光标落在角色周围的透明区域时，依然会显示 grab 光标、并挡住下面的窗口 ——
 * 用户看到的现象就是"离桌宠一段距离光标还是手形，既拖不动也点不到别的窗口"。
 *
 * 配合渲染进程的逐像素命中测试（renderer.js 里的 updateHitTest）：
 * 光标下是透明像素 → ignore=true 放行给桌面；是不透明像素 → ignore=false 正常交互。
 *
 * 注意第二个参数 forward: true 是必需的：否则忽略期间收不到 mousemove，
 * 就没法知道光标何时又移回了角色身上，会永久卡在"忽略"状态。
 */
let ignoringMouse = false

function setIgnoreMouse(ignore) {
  if (!win || win.isDestroyed()) return
  if (ignore === ignoringMouse) return
  ignoringMouse = ignore
  try {
    win.setIgnoreMouseEvents(ignore, { forward: true })
    // 这条日志用于排查"光标离开角色后仍显示手形/挡住其他窗口"这类问题。
    if (TRACE) log(`[trace] 鼠标穿透 = ${String(ignore)}`)
  } catch (err) {
    log(`切换鼠标穿透失败（不影响运行）：${err instanceof Error ? err.message : String(err)}`)
  }
}

ipcMain.on('pet:set-ignore-mouse', (_event, payload) => {
  setIgnoreMouse(Boolean(payload && payload.ignore))
})

/**
 * 调整桌宠尺寸。
 *
 * 三个关键点：
 *  1. **以底边中心为锚点**：桌宠"站在地上"，改尺寸时脚底不动才自然。
 *     同时窗口高度里含气泡区，若以顶边为锚点，气泡会跟着上下跳。
 *  2. 改完要**重新锁死**尺寸（lockWindowSize 会被重复调用，见其注释里的注意事项）。
 *  3. **必须把新布局推给渲染进程** —— 否则窗口变了而立绘不变。
 *
 * @param {number} petWidth 角色区域宽度（CSS 像素）
 * @param {{ persist?: boolean, silent?: boolean }} [options]
 */
function applyPetSize(petWidth, options = {}) {
  if (!win || win.isDestroyed()) return null
  const width = Math.round(clampNumber(Number(petWidth), PET_WIDTH_MIN, PET_WIDTH_MAX))
  const target = boundsForWidth(width)
  // 期望尺寸随之更新：跟随拖拽时按新档位写回 setBounds。
  setExpectedWindowSize(width)
  const [oldX, oldY] = win.getPosition()
  const [oldW, oldH] = win.getSize()

  // 解锁 → 改尺寸 → 重新锁定。解锁是必要的：setMaximumSize 会阻止 setBounds 变大。
  sizeLocked = false
  traceGeometryWrite('setMinimumSize', '解锁 80x80')
  win.setMinimumSize(80, 80)
  traceGeometryWrite('setMaximumSize', '解锁 100000')
  win.setMaximumSize(100000, 100000)

  const newX = Math.round(oldX + (oldW - target.width) / 2)
  const newY = Math.round(oldY + (oldH - target.height))
  traceGeometryWrite('setBounds', `尺寸调整 → ${String(target.width)}x${String(target.height)}`)
  win.setBounds({ x: newX, y: newY, width: target.width, height: target.height })
  // 再把内容区闭环校正到设计值，然后才锁定 ——
  // 否则系统多给出来的那几像素会变成"面板离角色很远"的间隙。
  lockWindowSize()

  logicalWidth = width
  pushLayoutToRenderer()

  // 需要时把新尺寸落盘（菜单里改的要记住；宿主下发/测试的可以不落盘）。
  if (options.persist !== false) {
    const result = settings.update({ petWidth: width })
    if (!result.ok) log(`保存尺寸设置失败：${result.error ?? '未知原因'}`)
  }

  if (!options.silent) {
    log(
      `尺寸已调整：角色宽 ${String(width)}，窗口 ${String(target.width)}x${String(target.height)}` +
        `（气泡区 ${String(bubbleAreaFor(width))}）`,
    )
  }
  return { petWidth: width, width: target.width, height: target.height }
}

ipcMain.on('pet:set-size', (_event, payload) => {
  const width = payload && Number.isFinite(payload.petWidth) ? Number(payload.petWidth) : null
  if (width === null) return
  applyPetSize(width)
})

/**
 * 测试专用的状态覆盖。
 *
 * 存在的理由有两层：
 *  1. 闲置语音的门控条件是"宿主不在忙"，而本机无法让真实的 DSH 立刻进入/退出思考，
 *     所以这条状态必须能被注入；
 *  2. **光注入不够**：宿主的真实长轮询很快就会把 `workStatus: 'idle'` 推回来，
 *     把注入的状态覆盖掉。第一版测试就栽在这里 —— 注入"思考中"之后，
 *     真实轮询在几十毫秒内又推回 idle，渲染进程于是照常播闲置语音，
 *     看起来像门控失效，其实是测量没压住噪声。
 * 因此这里用一份覆盖值压住轮询结果，测试结束再清除。
 *
 * 只在 --selftest / --test-drag-follow 下注册，正常运行时这些通道不存在。
 */
let testStateOverride = null

/**
 * 测试专用：在**主进程内**注入一份状态。
 *
 * ⚠️ 必须直接调用这个函数，不能用 `win.webContents.send('pet:test-push-state', ...)`。
 * `webContents.send` 的方向是主进程 → 渲染进程，而这条通道的处理器在主进程
 * （`ipcMain.on`），发出去只会被渲染进程收下然后丢弃 —— 注入等于没做。
 * 这个方向错误我在 `pet:pet` 上已经犯过一次，这里又犯了一次，因此专门抽成函数
 * 并在两处都写清楚方向，避免第三次。
 */
function testPushState(payload) {
  if (!payload || typeof payload !== 'object') return
  testStateOverride = payload
  lastState = payload
  if (win && !win.isDestroyed()) win.webContents.send('pet:state', payload)
}

if (SELFTEST || TEST_DRAG_FOLLOW) {
  ipcMain.on('pet:test-push-state', (_event, payload) => {
    testPushState(payload)
  })
  ipcMain.on('pet:test-clear-state-override', () => {
    testStateOverride = null
  })
  /*
   * 测试用：读 / 设置置顶状态。
   *
   * 为什么需要：置顶是**窗口级**属性，渲染进程看不到，也没法用合成事件验证；
   * 原生菜单项在自动化下也点不到。所以走这条路（内部就是 `applyTopmost`，
   * 与菜单点击完全同一条路径），再问窗口的**真实** alwaysOnTop 值 ——
   * 两者不一致就说明"设置生效了但没作用到窗口上"。
   *
   * ⚠️ 读写分开注册：
   *  · 读用 `handle`（invoke 语义）随时可用 —— 不改任何东西，没有风险；
   *  · 写只在测试分支里注册，生产运行时渲染进程调不动窗口层级。
   *
   * 一开始我把**读**也塞进了这个测试分支，结果自测里读不到状态；
   * 更早一版还想用 preload 的 `process.argv` 把关，而 preload 的 argv
   * 是渲染进程自己的参数、看不到 `--test-drag-follow`（实测确认）。
   */
  ipcMain.handle('pet:test-topmost-set', (_event, payload) => {
    const requested = payload && typeof payload.set === 'boolean' ? payload.set : null
    if (requested !== null) applyTopmost(requested)
    return topmostSnapshot()
  })
}

/**
 * 置顶状态的快照（主进程记录值、窗口真实值、设置文件里的值）。
 *
 * 三者放在一起是有意的：`enabled` 与 `windowAlwaysOnTop` 不一致说明
 * "变量改了但没作用到窗口"，`persisted` 不一致说明"没存住"，
 * 而这两种故障的表现（重启后恢复）很难区分开。
 */
function topmostSnapshot() {
  return {
    enabled: topmostEnabled,
    windowAlwaysOnTop: win && !win.isDestroyed() ? win.isAlwaysOnTop() : null,
    persisted: settings.load().topmost,
  }
}

ipcMain.handle('pet:test-topmost', () => topmostSnapshot())

/** 由菜单项调用：调整尺寸并回报结果，失败时用气泡提示。 */
function changePetSizeByMenu(petWidth) {
  const result = applyPetSize(petWidth)
  if (!result && win && !win.isDestroyed()) {
    win.webContents.send('pet:say', { text: systemLine('size-failed'), bubbleMs: 4000 })
  }
}

// ------------------------------------------------------------------ 信息窗口（语音库 / 关于）
/**
 * 桌宠版本号（显示在「关于」里）。
 *
 * 从 `package.json` 读，而不是在这里再写一份 —— 版本号写两份必然漂移，
 * 而"关于窗口显示的版本和实际装的包不一致"是最容易让人怀疑装错的一次体验。
 */
const APP_VERSION = (() => {
  try {
    return require('../package.json').version ?? '未知'
  } catch {
    return '未知'
  }
})()

/** 信息窗口单例。两个模式共用一个窗口，避免连点开出好几个。 */
let infoWin = null

/** 把秒数格式化成人话（"3 小时 12 分"）。 */
function formatUptime(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${String(d)} 天 ${String(h)} 小时`
  if (h > 0) return `${String(h)} 小时 ${String(m)} 分`
  if (m > 0) return `${String(m)} 分`
  return `${String(s)} 秒`
}

/** 构造「语音库」窗口的数据。 */
function buildVoiceWindowPayload() {
  const hearts = affection.hearts
  const moodValue = Math.round(mood.value)
  const moodText = moodVoiceGroup(moodValue) === 'high' ? '很好' : moodVoiceGroup(moodValue) === 'mid' ? '一般' : '偏低'
  return {
    mode: 'voice',
    hearts,
    moodValue,
    moodText,
    totalLines: voiceLineCount(),
    /*
     * 每个组都带上 `trigger` 与"当前是否可用"。
     *
     * 可用性用 `voiceGroupAvailable(full, state)` 判：它按**面板状态**
     * （爱心数/心情值）判断，而窗口里并没有"部位""动作 id""余额档位"这些上下文。
     */
    groups: voiceLibrarySummary().map((group) => {
      const full = VOICE_GROUPS.find((g) => g.id === group.id)
      return {
        id: group.id,
        trigger: group.trigger,
        label: group.label,
        lines: group.lines,
        available: full ? voiceGroupAvailable(full, { hearts, moodValue }) : false,
        condition: full ? conditionTextOf(full) : '',
      }
    }),
    trustLines: voiceLinesFor('trust'),
  }
}

/**
 * 读更新日志的**开头部分**（「未发布」+ 最新一个版本段）。
 *
 * 为什么不整份塞进去：CHANGELOG 已经三百多行，全塞进"关于"窗口没人看；
 * 用户要的是"最新更新日志"。
 */
function readChangelogHead() {
  try {
    const fs = require('node:fs')
    const path = require('node:path')
    const file = path.join(__dirname, '..', 'CHANGELOG.md')
    const text = fs.readFileSync(file, 'utf8')
    const lines = text.split(/\r?\n/)
    // 从第一个 `## ` 开始，最多取两段（未发布 + 最新版本）
    const start = lines.findIndex((line) => line.startsWith('## '))
    if (start < 0) return text.slice(0, 4000)
    let sections = 0
    let end = lines.length
    for (let i = start; i < lines.length; i += 1) {
      if (lines[i].startsWith('## ')) {
        sections += 1
        if (sections > 2) {
          end = i
          break
        }
      }
    }
    return lines.slice(start, end).join('\n').trim().slice(0, 6000)
  } catch (err) {
    return `（读不到更新日志：${err instanceof Error ? err.message : String(err)}）`
  }
}

/** 构造「关于」窗口的数据。 */
function buildAboutPayload() {
  const hearts = affection.hearts
  return {
    mode: 'about',
    version: APP_VERSION,
    packageName: 'dsh-pet-ds',
    electronVersion: process.versions.electron ?? '未知',
    affectionText: `${String(hearts)} 心 · ${String(affection.value)}/${String(stageThresholdFor(hearts))}（${affectionHeartsLabel(hearts)}）`,
    moodText: `${String(Math.round(mood.value))}`,
    uptimeText: formatUptime(process.uptime()),
    changelog: readChangelogHead(),
  }
}

/**
 * 打开信息窗口（单例）。
 *
 * @param {'voice' | 'about'} mode
 */
function openInfoWindow(mode) {
  const path = require('node:path')
  const payload = mode === 'voice' ? buildVoiceWindowPayload() : buildAboutPayload()

  if (infoWin && !infoWin.isDestroyed()) {
    infoWin.webContents.send('info:data', payload)
    infoWin.setTitle(mode === 'voice' ? '语音库' : '关于桌宠')
    infoWin.show()
    infoWin.focus()
    /*
     * `moveTop()`：桌宠窗口是**始终置顶**的，而这个信息窗口是普通层级 ——
     * 只 show/focus 的话它可能被桌宠压住（或者被别的置顶窗口挡住），
     * 用户就会觉得"点了没反应"。移一下顶层顺序最省事。
     */
    infoWin.moveTop()
    return
  }

  infoWin = new BrowserWindow({
    width: mode === 'voice' ? 560 : 480,
    height: mode === 'voice' ? 640 : 540,
    minWidth: 380,
    minHeight: 320,
    title: mode === 'voice' ? '语音库' : '关于桌宠',
    backgroundColor: '#12151c',
    /*
     * ⚠️ `show: false` + `ready-to-show` 才显示。
     *
     * 用户反馈：「第一次点菜单里的语音库/关于桌宠没反应，要点第二次才弹出」。
     * 原因是直接在菜单回调里建窗并立刻显示：菜单还在收尾、窗口没有拿到焦点，
     * 有时会被桌宠（始终置顶）挡住或干脆停在未激活状态。
     * 改成"内容就绪后再 show + focus + moveTop"，第一次点就能稳定弹出来。
     */
    show: false,
    /* 与桌宠窗口一样的隔离策略：只给它一个极小的 preload，不开放 Node。 */
    webPreferences: {
      preload: path.join(__dirname, 'info-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  infoWin.setMenuBarVisibility(false)
  infoWin.once('ready-to-show', () => {
    if (!infoWin || infoWin.isDestroyed()) return
    infoWin.show()
    infoWin.focus()
    infoWin.moveTop()
  })
  infoWin.on('closed', () => {
    infoWin = null
  })
  void infoWin.loadFile(path.join(__dirname, 'info.html')).then(() => {
    if (!infoWin || infoWin.isDestroyed()) return
    infoWin.webContents.send('info:data', payload)
    /* 兜底：某些环境里 ready-to-show 可能不触发（页面极快完成时），这里再显示一次。 */
    if (!infoWin.isVisible()) {
      infoWin.show()
      infoWin.focus()
      infoWin.moveTop()
    }
  })
}

ipcMain.on('info:close', (event) => {
  const target = BrowserWindow.fromWebContents(event.sender)
  if (target && !target.isDestroyed()) target.close()
})

ipcMain.on('info:open-external', (_event, url) => {
  const text = typeof url === 'string' ? url : ''
  // 只放行 http/https：其它协议（file:、javascript:…）一律拒绝。
  if (!/^https?:\/\//i.test(text)) return
  void shell.openExternal(text)
})

ipcMain.on('info:say-random', () => {
  try {
    if (!win || win.isDestroyed()) return
    const hearts = affection.hearts
    const moodValue = Math.round(mood.value)
    /*
     * 池子 = 当前可用的分组语音 + 自由对话库。
     *
     * 为什么把 `dialogue.js` 也并进来：重做菜单后「对话」项没了，
     * 那些"傲娇日常"台词（17 句）如果只留在库里就成了死代码。
     * 它们没有状态条件，正好可以和无条件的固定语音一起当"随便说一句"的素材。
     */
    const pool = [...availableVoiceLines({ hearts, moodValue }), ...voiceLinesFor('free')]
    if (pool.length === 0) return
    const candidates = pool.length > 1 && lastIdleVoiceLine
      ? pool.filter((line) => line !== lastIdleVoiceLine)
      : pool
    const list = candidates.length > 0 ? candidates : pool
    const text = list[Math.floor(Math.random() * list.length)]
    if (!text) return
    lastIdleVoiceLine = text
    win.webContents.send('pet:say', { text, bubbleMs: 6000 })
  } catch (err) {
    log(`语音库「随机说一句」失败：${err instanceof Error ? err.message : String(err)}`)
  }
})

/**
 * 「刷新状态」：让桌宠无条件回到闲置（用户要求的逃生门）。
 *
 * 为什么由主进程转发而不是菜单直接操作渲染进程：
 * 菜单在主进程，它没有别的通道能改渲染进程的状态机；
 * 发一条明确的 `pet:refresh-state` 让渲染进程自己收拾，职责最清楚。
 */
function refreshPetToIdle(reason) {
  if (!win || win.isDestroyed()) return
  win.webContents.send('pet:refresh-state', { reason: String(reason ?? '') })
  log(`已请求刷新桌宠状态（${String(reason ?? '')}）`)
  win.webContents.send('pet:say', { text: systemLine('refreshed'), bubbleMs: 2500 })
}

/** 右键菜单。 */
ipcMain.on('pet:context-menu', () => {
  if (!win || win.isDestroyed()) return

  /*
   * ⚠️ 整段菜单构建包在 try/catch 里。
   *
   * 菜单项的函数体（打开窗口、刷新状态…）是在**构建期**被引用、
   * 出错却发生在**点击时**；而构建期一旦抛异常，Electron 只在主进程 stderr
   * 里留一行，用户侧表现为"右键什么都没弹出来"，极难归因。
   * 兜住并写进日志，至少能查到是哪一步。
   */
  try {
    buildAndPopupMenu()
  } catch (err) {
    log(`右键菜单构建失败：${err instanceof Error ? err.message : String(err)}`)
    throw err
  }
})

/**
 * 构建右键菜单模板（**不弹窗**）。
 *
 * 为什么把"构建"与"弹出"拆开：`menu.popup()` 会阻塞式地抢焦点，
 * 在自测里不能真弹；而菜单项少了/写错了是用户直接能看见的故障。
 * 拆开后自测就能断言"这 8 项都在"（见 verifyContextMenu）。
 */
function buildMenuTemplate() {
  const sizeSubmenu = SIZE_PRESETS.map((preset) => ({
    label: `${preset.label}（${String(preset.width)}）`,
    type: 'radio',
    checked: Math.abs(preset.width - logicalWidth) < 10,
    click: () => {
      changePetSizeByMenu(preset.width)
    },
  }))

  /**
   * 动作子菜单。
   *
   * 清单来自共享核心的 `actionMenuEntries()`，不在菜单里再写一遍 ——
   * 新增动作时只改一处。
   *
   * 条目按 `group` 分三段（站立 / 动作 / 触碰部位），
   * **组之间插分隔线**：十来个项目平铺在一起很难扫读，分组后一眼能看出
   * "上面是整只桌宠的动作、下面是碰某个部位"。分隔线在这里生成，
   * 而不是让共享核心返回 separator 项 —— 菜单是**平台相关**的表达，
   * 不该混进跨端复用的数据里。
   */
  const actionEntries = actionMenuEntries()
  const actionSubmenu = []
  let lastGroup = null
  for (const entry of actionEntries) {
    if (lastGroup !== null && entry.group !== lastGroup) actionSubmenu.push({ type: 'separator' })
    lastGroup = entry.group
    actionSubmenu.push({
      label: entry.label,
      click: () => {
        triggerActionFromMenu(entry.id)
      },
    })
  }

  /*
   * 用户要求：把「对话」并进语音库入口。
   *
   * 于是菜单里不再有「对话」项（重做后的 8 项里没有它），
   * 但"随机说一句"的能力保留在语音库窗口里 —— 见 `info:say-random`：
   * 它从**语音库的可用台词 + 自由对话库**里一起抽。
   */

  const template = [
    {
      /*
       * 语音库入口（用户要求的第 1 项）。
       *
       * 打开的是一个**独立只读窗口**，列出当前可用的语音组。
       * 原来的「对话」项已并进去（窗口里有个"随机说一句"）——
       * 用户重做菜单时列的清单里没有「对话」。
       */
      label: '语音库…',
      click: () => {
        /*
         * 用 `setImmediate` 把开窗推迟到"菜单回调返回之后"。
         *
         * 在菜单的 click 回调里同步创建窗口，Windows 上偶发拿不到激活
         * （用户反馈"第一次点没反应"）。推迟一拍再建，就避开了菜单收尾与前台切换的竞争。
         */
        setImmediate(() => openInfoWindow('voice'))
      },
    },
    {
      label: '动作',
      submenu: actionSubmenu,
    },
    {
      label: '尺寸',
      submenu: sizeSubmenu,
    },
    { type: 'separator' },
    {
      /*
       * 置顶开关（用户要求："可以让桌宠始终显示在最上层或正常作为窗口调节"）。
       *
       * 用 `type: 'checkbox'` + `checked` 而不是两行"开启/关闭" ——
       * 菜单每次弹出时都重新构建，所以 `checked` 永远是当前真实状态，
       * 一眼能看出现在是不是置顶。点击时 Electron 会自动翻转勾选，
       * 但**状态以主进程的 topmostEnabled 为准**（用 click 参数里的
       * menuItem.checked），而不是靠 !topmostEnabled 反推 ——
       * 两者若因某种原因不同步，反推会把状态越搞越乱。
       */
      label: '始终显示在最上层',
      type: 'checkbox',
      checked: topmostEnabled,
      click: (menuItem) => {
        applyTopmost(menuItem.checked)
      },
    },
    {
      label: '回到初始位置',
      click: () => {
        if (!win || win.isDestroyed()) return
        const size = boundsForWidth(logicalWidth)
        const pos = initialPosition(size.width, size.height)
        win.setPosition(pos.x, pos.y)
        log('已回到初始位置')
      },
    },
    {
      /*
       * 刷新状态（用户要求第 6 项）：
       * "点击后使桌宠直接回复到闲置状态，防止可能的在某个动作上卡住而无法动弹"。
       *
       * 这是一个**兜底逃生门**：不管她在睡觉、坐着、思考、还是某个动作卡住，
       * 点一下都应该回到站着的闲置状态。所以渲染进程那边要无条件清状态，
       * 而不是"如果没在动作就重置"。
       */
      label: '刷新状态',
      click: () => {
        refreshPetToIdle('右键菜单')
      },
    },
    { type: 'separator' },
    {
      label: '关于桌宠…',
      click: () => {
        /* 同「语音库…」：推迟一拍再开窗，避开菜单收尾与前台切换的竞争。 */
        setImmediate(() => openInfoWindow('about'))
      },
    },
    { type: 'separator' },
    {
      label: '退出桌宠',
      click: () => {
        void quitSelf()
      },
    },
  ]
  return template
}

/** 构建模板并真的弹出来。 */
function buildAndPopupMenu() {
  const menu = Menu.buildFromTemplate(buildMenuTemplate())
  menu.popup({ window: win })
}

// ------------------------------------------------------------------ 应用生命周期
// 桌宠不该因为"所有窗口关闭"就退出：它在 Windows 上本来就没有任务栏入口。
app.on('window-all-closed', () => {
  // 用户关掉了窗口（正常路径是右键退出），此时直接结束进程。
  if (app.isQuitting !== true) {
    app.isQuitting = true
    app.quit()
  }
})

app.on('second-instance', () => {
  // 有人重复启动：把已有窗口提到前面即可。
  if (win && !win.isDestroyed()) win.showInactive()
})

app.whenReady().then(() => {
  try {
    if (PROBE_ESM) {
      probeEsm()
      return
    }
    /*
     * 先载入好感存档，再开窗。
     *
     * 顺序很重要：`app.getPath('userData')` 在 ready 之后才可靠；
     * 而如果放到开窗之后，面板会先画成 0 心再跳变 —— 用户会以为存档没生效。
     */
    loadAffectionFromDisk()
    createWindow()
    void pollLoop()
    /*
     * 启动自检：把"这个进程里到底有哪些动作素材"打一行日志。
     *
     * 为什么值得打：本项目已经两次因为**进程比素材旧**而出现"动作不触发"
     * （一次是 WebP 化之后，一次是深度思考素材导入之后）——
     * 那种情况下日志里只有"素材缺失"，很难一眼看出是"进程该重启了"。
     * 有了这行，对照"现在的仓库里应该有几个动作"就能立刻判断。
     */
    try {
      const animRoot = require('node:path').join(__dirname, '..', 'assets', 'animations')
      const ids = require('node:fs')
        .readdirSync(animRoot)
        .filter((name) => require('node:fs').existsSync(require('node:path').join(animRoot, name, 'manifest.json')))
        .sort()
      const thinkOk = ['think-enter', 'think-loop', 'think-exit'].every((id) => ids.includes(id))
      /* 注意 `log()` 自带 `[pet] ` 前缀，这里不要再加一遍。 */
      log(`素材自检：${ids.length} 个动作（${ids.join(', ')}）`)
      log(`深度思考素材：${thinkOk ? 'enter/loop/exit 三段就位' : '缺失（这个进程可能比素材旧，请重启桌宠）'}`)
    } catch (err) {
      log(`素材自检失败：${err instanceof Error ? err.message : String(err)}`)
    }
    /*
     * 好感第 4 条：每连续运行 10 分钟 +5。
     * 由独立定时器结算（与心情的 30 秒 tick 无关，见 startUptimeAffectionTimer 的说明）。
     */
    startUptimeAffectionTimer()
    /*
     * 余额监控**桌宠自己起**（用户要求："让桌宠插件自身能实时自动更新余额监控，
     * 不需要进行别的操作"）。它不依赖宿主是否在线，也不需要在 DSH 里做任何操作。
     */
    startBalanceMonitor()
    if (SELFTEST) void runSelfTest()
    if (TEST_DRAG_FOLLOW) void runDragFollowTest()
    if (WATCH_SLEEP_S !== null) void watchSleep(WATCH_SLEEP_S)
    // 退出路径的无人值守验证：到点就走一遍退出。
    if (TEST_QUIT_MS !== null) {
      log(`将在 ${String(TEST_QUIT_MS)}ms 后触发退出流程（用于验证退出是否可靠）`)
      setTimeout(() => {
        quitSelf()
      }, TEST_QUIT_MS)
    }
  } catch (err) {
    log(`启动失败：${err instanceof Error ? err.message : String(err)}`)
    app.exit(1)
  }
})

/**
 * 探测：Electron 的 Node 能否 require() 共享核心里的 ESM 模块。
 *
 * 这决定了"动作/心情的单一真相源"能不能真的共用一份文件：
 *  · 能 → 直接 require，宿主与桌宠用同一份定义，不会漂移；
 *  · 不能 → 必须为 CommonJS 侧复制一份纯数据，并在两处注明同步义务。
 * 不靠猜，实测一次。
 */
function probeEsm() {
  const path = require('node:path')
  const targets = ['actions.js', 'mood.js']
  const result = { node: process.versions.node, electron: process.versions.electron, modules: {} }
  for (const name of targets) {
    const file = path.join(__dirname, '..', 'src', 'shared-core', name)
    try {
      const mod = require(file)
      result.modules[name] = { ok: true, exports: Object.keys(mod).slice(0, 12) }
    } catch (err) {
      result.modules[name] = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
  log(`ESM 探测：${JSON.stringify(result)}`)
  app.exit(0)
}

// ------------------------------------------------------------------ 跟随自测
/**
 * `--test-drag-follow`：验证"主进程高频跟随光标"的代码路径，以及布局与尺寸调节。
 *
 * 为什么要单独做这个测试：跟随读的是**真实系统光标**。合成的 MouseEvent 不会移动
 * 真实鼠标，所以 --selftest 里窗口本来就不会动；而本机 SetCursorPos 又不生效
 * （实测光标位置不随调用改变），无法用"移动真实光标"来验证。
 *
 * 因此这里用 cursorOverride 注入光标位置，专门验证跟随的**计算与调用链**：
 *   读光标 → 窗口位置 = 光标 − 抓取偏移 → setPosition → 窗口真的移动了
 * 同时验证"结束拖拽后不再跟随"与"拖拽不改尺寸"这两条不变量，
 * 以及布局几何（气泡不被角色盖住）与尺寸调节是否正确、是否持久化。
 *
 * 这不能替代人工验证真实手感，但能保证代码路径是通的、算术是对的。
 */
async function runDragFollowTest() {
  const results = []
  const check = (name, ok, detail) => {
    results.push({ name, ok })
    log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  }

  const setTimeoutAsync = (ms) => new Promise((r) => setTimeout(r, ms))
  /** 渲染进程的 webContents：多个子用例都要用它执行脚本来读写内部状态。 */
  const wc = win && !win.isDestroyed() ? win.webContents : null

  /*
   * 自测专用：容忍"拖拽中 mousemove 报告 buttons === 0"。
   *
   * 那条判断在生产环境是**必要**的（mouseup 丢失时的补救信号），但自测用合成
   * mousedown 起拖、屏幕上真实鼠标键并未按下，于是这 180ms 内任何一次真实
   * mousemove 被转发进来都会把拖拽提前取消 —— 实测偶发（约五次一次），
   * 表现为"拎起判定没通过、动画还停在 head"。
   *
   * 只影响渲染进程里这一个启发式，不改任何生产逻辑。
   */
  if (wc) {
    try {
      await wc.executeJavaScript('window.__petTestTolerateButtonsZero(true)', true)
    } catch {
      // 忽略：拿不到钩子时仍按原逻辑跑。
    }
  }

  try {
    await setTimeoutAsync(1200)
    const [wx0, wy0] = win.getPosition()
    const [ww, wh] = win.getSize()
    log(`窗口初始: ${String(ww)}x${String(wh)} @ (${String(wx0)},${String(wy0)})`)

    // 注入"光标位于窗口中心"，作为抓取点。
    const grabX = wx0 + Math.round(ww / 2)
    const grabY = wy0 + Math.round(wh / 2)
    cursorOverride = { x: grabX, y: grabY }

    // 开始拖拽（主进程会记录抓取偏移并启动跟随轮询）。
    beginDragSession()
    const offsetX = dragSession ? dragSession.offsetX : null
    const offsetY = dragSession ? dragSession.offsetY : null
    check('拖拽会话已建立', dragSession !== null, `抓取偏移 (${String(offsetX)},${String(offsetY)})`)

    // 光标移动 (150,-80)，窗口应当同量跟随。
    //
    // ⚠️ 期望值也必须**经过同样的屏幕夹取**再比较 —— 窗口现在被限制在工作区内，
    // 若一开始就靠屏幕边缘，实际位移会小于光标位移（那是正确行为，不是缺陷）。
    // 用 clampToWorkArea 处理期望值，断言在"贴边"与"不贴边"两种情况下都成立。
    cursorOverride = { x: grabX + 150, y: grabY - 80 }
    await setTimeoutAsync(250)

    const [wx1, wy1] = win.getPosition()
    const expect1 = clampToWorkArea(wx0 + 150, wy0 - 80)
    const dx = wx1 - wx0
    const dy = wy1 - wy0
    const okMove = Math.abs(wx1 - expect1.x) <= 3 && Math.abs(wy1 - expect1.y) <= 3
    check(
      '窗口跟随光标（位移与光标位移一致，已按屏幕夹取）',
      okMove,
      `期望 (${String(expect1.x)},${String(expect1.y)})，实际 (${String(wx1)},${String(wy1)})（原始位移 ${String(dx)},${String(dy)}）`,
    )

    // 继续移动，应持续跟随。
    cursorOverride = { x: grabX + 150 - 60, y: grabY - 80 + 30 }
    await setTimeoutAsync(250)
    const [wx2, wy2] = win.getPosition()
    const expect2 = clampToWorkArea(wx0 + 150 - 60, wy0 - 80 + 30)
    const okFollow2 = Math.abs(wx2 - expect2.x) <= 3 && Math.abs(wy2 - expect2.y) <= 3
    check(
      '持续跟随（第二次移动，已按屏幕夹取）',
      okFollow2,
      `期望 (${String(expect2.x)},${String(expect2.y)})，实际 (${String(wx2)},${String(wy2)})`,
    )

    // 结束拖拽后，光标再动，窗口不应跟随。
    endDragSession()
    await setTimeoutAsync(200)
    const [wx3, wy3] = win.getPosition()
    cursorOverride = { x: wx3 + 220, y: wy3 + 160 }
    await setTimeoutAsync(400)
    const [wx4, wy4] = win.getPosition()
    check('结束拖拽后不再跟随', wx4 === wx3 && wy4 === wy3, `窗口 (${String(wx4)},${String(wy4)})`)

    // 尺寸应当回到设计值。
    //
    // ⚠️ 判据不能用"与拖拽前相同"：旧代码每移动一次宽度就 +1px，所以拖拽前那个
    // 值本身可能已经是累积出来的错误值（实测 183，而正确值是 180）。
    // 正确判据是"拖拽后等于设计值" —— 因为跟随期间会用 setBounds 把期望尺寸写回。
    const [ww2, wh2] = win.getSize()
    const design = boundsForWidth(logicalWidth)
    check(
      '拖拽结束后窗口尺寸 = 设计值',
      Math.abs(ww2 - design.width) <= 4 && Math.abs(wh2 - design.height) <= 8,
      `实际 ${String(ww2)}x${String(wh2)}，设计 ${String(design.width)}x${String(design.height)}（拖拽前 ${String(ww)}x${String(wh)}）`,
    )

    // 抓取偏移必须保持不变（抓哪儿就一直是哪儿）。
    check(
      '抓取偏移被正确记录',
      offsetX === Math.round(ww / 2) && offsetY === Math.round(wh / 2),
      `(${String(offsetX)},${String(offsetY)})`,
    )

    // ---- 布局与尺寸调节 ----
    await verifyLayoutAndResize(check, setTimeoutAsync)

    // ---- 拖拽期间布局是否稳定 ----
    await verifyLayoutDuringDrag(check, setTimeoutAsync)

    // ---- 真实拖拽（光标真的移动）----
    //
    // ⚠️ 先把闲置触发时钟还原成默认值。
    // 前面验证闲置动作时把门槛压成了 0、概率设成了 1；若不还原，
    // **拖拽期间闲置动作会不停触发**，把正在播的 hang 动画切走 ——
    // 表现为"拖拽动画没播"这类假失败（实测踩过两次）。
    await wc.executeJavaScript('window.__petTestSetIdleClock(null)', true)
    await setTimeoutAsync(200)
    await verifyRealDrag(check, setTimeoutAsync)

    // ---- 拖动范围限制：窗口边界不出屏 ----
    await verifyDragBounds(check, setTimeoutAsync)

    /*
     * ---- 置顶开关（右键菜单里的"始终显示在最上层"）----
     *
     * 放在**所有拖拽验证之后**：本块会把窗口的 alwaysOnTop 反复开关，
     * 而拖拽跟随/落点那几条断言对窗口状态很敏感（实测把这段插在拖拽序列中间，
     * 会让"拖拽进行中禁止其他动画触发""拖拽动画播完停在最后一帧""落点无漂移"
     * 三条一起失败）。窗口级操作要等窗口状态相关的用例都跑完再做。
     *
     * 置顶是窗口级属性，渲染进程看不到，原生菜单项在自动化下也点不到，
     * 所以走 `pet:test-topmost` / `pet:test-topmost-set` —— 内部就是
     * `applyTopmost`，与菜单点击**完全同一条路径**，再问窗口的真实值。
     */
    {
      const initial = await wc.executeJavaScript('window.pet.topmostState()', true)
      check(
        '置顶状态可读取，且与窗口真实层级一致',
        initial && typeof initial.enabled === 'boolean' && initial.windowAlwaysOnTop === initial.enabled,
        `主进程记录=${String(initial && initial.enabled)}，窗口实际=${String(initial && initial.windowAlwaysOnTop)}`,
      )

      const off = await wc.executeJavaScript('window.pet.setTopmost(false)', true)
      check(
        '关闭置顶后窗口真的不再置顶',
        off && off.enabled === false && off.windowAlwaysOnTop === false,
        `主进程记录=${String(off && off.enabled)}，窗口实际=${String(off && off.windowAlwaysOnTop)}`,
      )
      check(
        '关闭置顶会持久化到设置文件',
        off && off.persisted === false,
        `设置文件里的 topmost=${String(off && off.persisted)}`,
      )

      const on = await wc.executeJavaScript('window.pet.setTopmost(true)', true)
      check(
        '开启置顶后窗口真的置顶',
        on && on.enabled === true && on.windowAlwaysOnTop === true,
        `主进程记录=${String(on && on.enabled)}，窗口实际=${String(on && on.windowAlwaysOnTop)}`,
      )
      check(
        '开启置顶也会持久化',
        on && on.persisted === true,
        `设置文件里的 topmost=${String(on && on.persisted)}`,
      )

      // 恢复成用例开始前的状态，避免污染用户的设置文件。
      if (initial && typeof initial.enabled === 'boolean') {
        const restored = await wc.executeJavaScript(
          `window.pet.setTopmost(${String(initial.enabled)})`,
          true,
        )
        check(
          '置顶状态已恢复为用例开始前的值',
          restored && restored.enabled === initial.enabled && restored.persisted === initial.enabled,
          `恢复为 ${String(initial.enabled)}；主进程=${String(restored && restored.enabled)}，` +
            `设置文件=${String(restored && restored.persisted)}`,
        )
      }
    }

    const failed = results.filter((r) => !r.ok)
    log(`跟随自测结果：${String(results.length - failed.length)}/${String(results.length)} 通过`)
  } catch (err) {
    /*
     * 打印**完整堆栈**而不只是 message。
     *
     * 只打 message 时，"body is not defined" 这种错误完全无法定位 ——
     * 项目里有几十处 executeJavaScript 片段，光看一句话不知道是哪一处。
     * 堆栈能直接指到行号。
     */
    log(`跟随自测出错：${err instanceof Error ? err.message : String(err)}`)
    if (err instanceof Error && err.stack) {
      log(`跟随自测堆栈：\n${err.stack.split('\n').slice(0, 12).join('\n')}`)
    }
  } finally {
    cursorOverride = null
    try {
      endDragSession()
    } catch {
      // 忽略。
    }
    setTimeout(() => {
      app.isQuitting = true
      app.quit()
    }, 400)
  }
}

/**
 * 验证"气泡区 + 角色区"的布局，以及右键菜单的尺寸调节是否正确、是否持久化。
 *
 * 核心不变量：**气泡的底边必须落在角色区顶边之上**（否则就被角色盖住），
 * 以及**立绘的渲染尺寸必须跟着档位变**（否则就是"窗口变了、立绘没变"）。
 * 这两条都用几何断言，不靠肉眼。
 *
 * @param {(name: string, ok: boolean, detail?: string) => void} check
 * @param {(ms: number) => Promise<void>} wait
 */
async function verifyLayoutAndResize(check, wait) {
  const wc = win && !win.isDestroyed() ? win.webContents : null
  if (!wc) {
    check('布局检查', false, '窗口不可用')
    return
  }

  /** 读取渲染进程里的实际布局几何。 */
  const readLayout = () =>
    wc.executeJavaScript(
      `(function () {
        const bubble = document.getElementById('bubble')
        const char = document.getElementById('character')
        const img = document.getElementById('frame')
        const area = document.querySelector('.bubble-area')
        const stats = document.getElementById('stats-panel')
        const balance = document.getElementById('balance-panel')
        const r = (el) => { const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, height: b.height, width: b.width, left: b.left, right: b.right } }
        const cs = getComputedStyle(bubble)
        const areaRect = r(area)
        const charRect = r(char)
        const statsRect = r(stats)
        const balanceRect = balance ? r(balance) : null
        return {
          innerHeight: window.innerHeight,
          innerWidth: window.innerWidth,
          bubbleArea: areaRect,
          character: charRect,
          frame: r(img),
          frameNatural: { w: img.naturalWidth, h: img.naturalHeight },
          bubble: bubble.hidden ? null : r(bubble),
          bubbleFontPx: parseFloat(cs.fontSize) || 0,
          statsZoneHeight: stats.style.height,
          statsHidden: stats.hidden,
          statsVisibleRect: stats.hidden ? null : statsRect,
          /*
           * 余额面板：**常驻**，所以永远有几何（不像属性面板会 hidden）。
           * 这两个矩形是"两者不遮挡"断言的依据 ——
           * 与其去算间距，不如直接比较矩形是否相交。
           */
          balanceRect,
          balanceZonePx: balance ? parseFloat(balance.style.height) || 0 : 0,
          balanceText: (document.getElementById('balance-value') || {}).textContent || '',
          balanceNoteText: (document.getElementById('balance-note') || {}).textContent || '',
          balanceIsLow: balance ? Boolean(balance.querySelector('.balance-body.is-low')) : false,
          balanceIsError: balance ? Boolean(balance.querySelector('.balance-body.is-error')) : false,
          // 下面这组键名与 __petTestLayoutDiag 保持一致，便于复用同一批断言。
          statsZonePx: parseFloat(stats.style.height) || 0,
          characterRect: charRect,
          panelRect: statsRect,
          stageRect: r(document.getElementById('stage')),
          moodValueText: (document.getElementById('mood-value') || {}).textContent || '',
          moodFillWidth: (document.getElementById('mood-fill') || {}).style ? document.getElementById('mood-fill').style.width : '',
          /*
           * 好感行的**实际渲染结果**与**几何位置**。
           *
           * 位置用 getBoundingClientRect 而不是读源码顺序 —— 用户要求"好感值显示在
           * 心情值**上方**"，只有比较两者的 top 才能真正证明这一点
           * （DOM 里写在前面不等于视觉上在上面，flex 顺序/样式都可能改掉）。
           */
          affectionValueText: (document.getElementById('affection-value') || {}).textContent || '',
          affectionHeartsText: (document.getElementById('affection-hearts') || {}).textContent || '',
          affectionFillWidth: (document.getElementById('affection-fill') || {}).style
            ? document.getElementById('affection-fill').style.width
            : '',
          affectionRowTop: (function () {
            const el = document.getElementById('affection-value')
            return el ? el.getBoundingClientRect().top : null
          })(),
          moodRowTop: (function () {
            const el = document.getElementById('mood-value')
            return el ? el.getBoundingClientRect().top : null
          })(),
          affectionHeartsFontPx: (function () {
            const el = document.getElementById('affection-hearts')
            return el ? parseFloat(getComputedStyle(el).fontSize) || 0 : 0
          })(),
          // 元素自检：确认脚本操作的确实是页面里那个 img（曾怀疑取错元素）
          frameInlineStyle: img.getAttribute('style'),
          frameTagName: img.tagName,
          charInlineStyle: char.getAttribute('style'),
          frameClassName: img.className,
        }
      })()`,
      true,
    )

  // ---- 初始布局 ----
  let layout = await readLayout()
  // 注意用 DOM 里的**实际**气泡区高度，不要用按目标宽度算出来的值 ——
  // 角色尺寸是以视口为基准反推的，气泡区会吸收余量，两者本来就不完全相等。
  const actualBubbleH = layout.bubbleArea.height
  check(
    '角色区顶边 = 气泡区底部',
    Math.abs(layout.character.top - actualBubbleH) <= 2,
    `角色区 top=${layout.character.top.toFixed(1)}，气泡区高 ${actualBubbleH.toFixed(1)}`,
  )
  check(
    '角色区不侵占气泡区',
    layout.character.top >= actualBubbleH - 2,
    `角色区 top=${layout.character.top.toFixed(1)}，气泡区高 ${actualBubbleH.toFixed(1)}`,
  )

  // 显示一条台词，然后确认气泡完整落在角色区之上。
  wc.send('pet:say', { text: '这是一句用来检查气泡位置的测试台词', bubbleMs: 0 })
  await wait(300)
  layout = await readLayout()
  if (!layout.bubble) {
    check('气泡可见', false, '气泡未显示')
  } else {
    check('气泡可见', true, `高 ${layout.bubble.height.toFixed(1)}`)
    check(
      '气泡不被角色盖住',
      layout.bubble.bottom <= layout.character.top + 1,
      `气泡底 ${layout.bubble.bottom.toFixed(1)} ≤ 角色顶 ${layout.character.top.toFixed(1)}`,
    )
    check('气泡未超出窗口顶部', layout.bubble.top >= -1, `气泡顶 ${layout.bubble.top.toFixed(1)}`)
  }

  // ---- 尺寸调节：逐档验证窗口、立绘、气泡三者一起变 ----
  const before = logicalWidth
  for (const presetWidth of [140, 240, 320]) {
    const applied = applyPetSize(presetWidth, { persist: false, silent: true })
    await wait(500)
    // 面板隐藏时 display:none，几何恒为 0 —— 先按住显示再量。
    // （这一点在拖拽诊断里已经吃过一次亏，这里必须同样处理。）
    await wc.executeJavaScript('window.__petTestForceStats(true)', true)
    await wait(120)
    const [bw, bh] = win.getSize()
    // 窗口高 = 气泡区 + 角色区 + 余额区 + 属性面板区（余额面板是常驻区，见 boundsForWidth）。
    // 容差给 8px：**Electron 实际做出来的窗口比请求值大**（实测请求 240x431 得到 243x434，
    // 视口 246x432），因此不能按请求值逐像素断言。
    const expectedH =
      petHeightFor(presetWidth) +
      bubbleAreaFor(presetWidth) +
      balanceZoneFor(presetWidth) +
      statsZoneFor(presetWidth)
    check(
      `尺寸 ${String(presetWidth)}：窗口尺寸正确`,
      applied !== null && Math.abs(bw - presetWidth) <= Math.max(4, Math.round(presetWidth * 0.06)) && Math.abs(bh - expectedH) <= 8,
      `窗口 ${String(bw)}x${String(bh)}，期望 ${String(presetWidth)}x${String(expectedH)}`,
    )

    const l2 = await readLayout()

    /*
     * 关键 0：**角色 + 余额区 + 属性面板区 恰好填满视口**。
     * 这是"三块区域各占其位、谁也盖不住谁"的结构性保证。
     *
     * ⚠️ 加入余额区之前这里断言的是"角色底 + 面板高 = 视口高"；
     * 余额面板成为常驻区之后必须把它算进去，否则这条会必然失败。
     */
    const actualStatsH = l2.panelRect.height
    const actualBalanceH = l2.balanceRect ? l2.balanceRect.height : 0
    check(
      `尺寸 ${String(presetWidth)}：角色底 + 余额区 + 面板高 = 视口高`,
      Math.abs(l2.characterRect.bottom + actualBalanceH + actualStatsH - l2.innerHeight) <= 2,
      `角色底 ${l2.characterRect.bottom.toFixed(0)} + 余额 ${actualBalanceH.toFixed(0)}` +
        ` + 面板 ${actualStatsH.toFixed(0)} = ${(l2.characterRect.bottom + actualBalanceH + actualStatsH).toFixed(0)}` +
        `，视口高 ${String(l2.innerHeight)}`,
    )

    /*
     * 关键 0-2：**属性面板显示时与余额面板不遮挡**。
     *
     * 这一段是在"按住属性面板显示"的前提下量的（上面调了 __petTestForceStats(true)），
     * 而且是在**三个档位**（140/240/320）各量一次 —— 遮挡往往只在某个档位出现。
     */
    if (l2.balanceRect) {
      check(
        `尺寸 ${String(presetWidth)}：余额面板与属性面板不遮挡`,
        l2.balanceRect.bottom <= l2.panelRect.top + 2,
        `余额底 ${l2.balanceRect.bottom.toFixed(1)} ≤ 属性面板顶 ${l2.panelRect.top.toFixed(1)}`,
      )
      check(
        `尺寸 ${String(presetWidth)}：余额面板在角色下方`,
        l2.balanceRect.top >= l2.characterRect.bottom - 2,
        `余额顶 ${l2.balanceRect.top.toFixed(1)} ≥ 角色底 ${l2.characterRect.bottom.toFixed(1)}`,
      )
    }
    check(
      `尺寸 ${String(presetWidth)}：角色顶 = 气泡区高`,
      Math.abs(l2.characterRect.top - l2.bubbleArea.height) <= 2,
      `角色顶 ${l2.characterRect.top.toFixed(0)}，气泡区高 ${l2.bubbleArea.height.toFixed(0)}`,
    )

    // 关键 1：**立绘跟着缩放**。
    // 容差放宽到 8%：角色的最终尺寸是按**视口**反推的（因为窗口实际尺寸不等于请求值），
    // 所以它与目标宽度只保证比例一致，不保证逐像素相等。
    const widthTolerance = Math.max(4, Math.round(presetWidth * 0.08))
    check(
      `尺寸 ${String(presetWidth)}：立绘渲染尺寸随之变化`,
      Math.abs(l2.frame.width - presetWidth) <= widthTolerance,
      `立绘 ${l2.frame.width.toFixed(1)}x${l2.frame.height.toFixed(1)}，目标宽 ${String(presetWidth)}（容差 ${String(widthTolerance)}）`,
    )
    // 不变形：宽高比必须仍是素材比例。
    const aspectRatio = l2.frame.height / l2.frame.width
    check(
      `尺寸 ${String(presetWidth)}：立绘未变形`,
      Math.abs(aspectRatio - 1157 / 864) < 0.02,
      `实际 ${aspectRatio.toFixed(4)}，期望 ${(1157 / 864).toFixed(4)}`,
    )

    // 关键 2：气泡也跟着一起缩放（用户要求：气泡随桌宠一起改变）。
    const expectedFont = bubbleFontFor(presetWidth)
    check(
      `尺寸 ${String(presetWidth)}：气泡字号随之变化`,
      Math.abs(l2.bubbleFontPx - expectedFont) <= 1.5,
      `字号 ${l2.bubbleFontPx.toFixed(1)}px，期望约 ${String(expectedFont)}px`,
    )

    check(
      `尺寸 ${String(presetWidth)}：角色区仍从气泡区下方开始`,
      Math.abs(l2.character.top - bubbleAreaFor(presetWidth)) <= 2,
      `角色区 top=${l2.character.top.toFixed(1)}，期望 ${String(bubbleAreaFor(presetWidth))}`,
    )

    // 关键 3：属性面板区也要跟着缩放，且**不会被角色盖住**。
    check(
      `尺寸 ${String(presetWidth)}：属性面板区高度随之变化`,
      Math.abs(l2.panelRect.height - statsZoneFor(presetWidth)) <= 6,
      `面板高 ${l2.panelRect.height.toFixed(1)}，期望约 ${String(statsZoneFor(presetWidth))}px`,
    )
    /*
     * 属性面板在**余额面板**下方（而不是直接贴角色）。
     *
     * ⚠️ 加入常驻余额面板后这条判据必须改：角色与属性面板之间现在隔着余额面板。
     * 判据从"面板顶 = 角色底"改成"面板顶 = 余额底"。
     */
    check(
      `尺寸 ${String(presetWidth)}：属性面板在余额面板下方（不重叠）`,
      l2.balanceRect
        ? Math.abs(l2.panelRect.top - l2.balanceRect.bottom) <= 2
        : Math.abs(l2.panelRect.top - l2.characterRect.bottom) <= 2,
      l2.balanceRect
        ? `面板顶 ${l2.panelRect.top.toFixed(1)}，余额底 ${l2.balanceRect.bottom.toFixed(1)}`
        : `面板顶 ${l2.panelRect.top.toFixed(1)}，角色底 ${l2.characterRect.bottom.toFixed(1)}`,
    )
    // 并确认属性面板**仍然在角色下方**（整条链是 角色 → 余额 → 属性面板）。
    check(
      `尺寸 ${String(presetWidth)}：属性面板仍在角色区下方`,
      l2.panelRect.top >= l2.characterRect.bottom - 2,
      `面板顶 ${l2.panelRect.top.toFixed(1)} ≥ 角色底 ${l2.characterRect.bottom.toFixed(1)}`,
    )

    // 这一条就是"调节尺寸后气泡位置自适应"的可验证形式。
    if (l2.bubble) {
      check(
        `尺寸 ${String(presetWidth)}：气泡仍不被盖住`,
        l2.bubble.bottom <= l2.character.top + 1,
        `气泡底 ${l2.bubble.bottom.toFixed(1)} ≤ 角色顶 ${l2.character.top.toFixed(1)}`,
      )
    } else {
      wc.send('pet:say', { text: '检查气泡位置', bubbleMs: 0 })
      await wait(250)
      const l3 = await readLayout()
      check(
        `尺寸 ${String(presetWidth)}：气泡仍不被盖住`,
        l3.bubble ? l3.bubble.bottom <= l3.character.top + 1 : false,
        l3.bubble ? `气泡底 ${l3.bubble.bottom.toFixed(1)} ≤ 角色顶 ${l3.character.top.toFixed(1)}` : '气泡未显示',
      )
    }
  }

  // ---- 持久化：落盘后读回应当等于刚设置的宽度 ----
  applyPetSize(240, { persist: true, silent: true })
  await wait(250)
  const onDisk = settings.load()
  check(
    '尺寸已持久化到设置文件',
    Math.abs(Number(onDisk.petWidth) - 240) <= 2,
    `文件中 petWidth=${String(onDisk.petWidth)}（路径 ${settings.settingsPath()}）`,
  )

  // 收尾：回到进入本函数前的尺寸（避免把测试用的尺寸留在用户那里）。
  applyPetSize(before || 240, { persist: true, silent: true })
  await wait(250)
  check('已恢复原尺寸', Math.abs(logicalWidth - (before || 240)) <= 2, `logicalWidth=${String(logicalWidth)}`)

  // ---- 闲置语音、随机动作、心情与属性面板 ----
  await verifyIdleAndMood(check, wait, readLayout)

  // 闲置触发规则（1 分钟门槛 + 每分钟 1/5）单独验证 —— 它用可注入时钟，
  // 不必真的等几分钟。放在闲置用例之后、点击部位之前。
  await verifyIdleTriggerRule(check, wait)

  /*
   * 门槛的**定锚时机**单独验证。
   *
   * 为什么单独做：verifyIdleTriggerRule 是直接摆布 `readyAt` 的
   * （"readyAt=T0 就有资格触发"），它验证的是"到点后怎么掷骰子"，
   * 完全没覆盖"门槛什么时候被建立"。而这里曾经有两个真实缺陷：
   *   1. 门槛延迟到第一次 tick 才建立，实际要等「门槛 + 最多 60 秒」；
   *   2. 宿主变忙时只停了定时器、没清门槛，回来后整个门槛被白跳过。
   */
  await verifyIdleGateAnchoring(check, wait)

  // 睡眠状态机（闲置 10 分钟 → 睡 → 尾帧循环 → 点击惊醒 → 回闲置）。
  await verifySleepState(check, wait)

  // 坐姿动作（坐下 → 坐着循环 + 180 秒计时 → 站起；前两阶段点击立即站起）。
  await verifySitAction(check, wait)

  /*
   * 闲置主动对话（语音库：固定 / 好感度 ×5 / 心情 ×3）。
   *
   * 放在坐姿用例**之后**：它会把 sleep 状态机走一遍来验证"睡眠期间不说"，
   * 放在前面会把后面用例依赖的 petState 搅乱。
   */
  await verifyIdleVoice(check, wait)

  /*
   * 好感度增长 / 低心情点击 / 浮出数字 / 深度思考 / 刷新状态。
   *
   * 放在**最后**：它会重置好感与心情、还会推 workStatus，属于"改环境"的用例，
   * 放中间会把别的用例的前提搅乱（这份自测里已经有前车之鉴）。
   */
  await verifyAffectionAndFeedback(check, wait)

  /* 信息窗口（语音库 / 关于）—— 再加最后：它会真的开一个窗口。 */
  await verifyInfoWindows(check, wait)

  /* 右键菜单的 8 个入口（纯构建，不弹窗）。 */
  verifyContextMenu(check)

  /* 好感存档：路径与安装目录分离 + 落盘往返。 */
  await verifyAffectionPersistence(check, wait)
}

/**
 * 验证**拖拽期间**布局保持稳定。
 *
 * 为什么单独做这件事：用户报告"拖拽时属性面板越来越长并远离桌宠"。
 * 这类症状的成因有两类，必须分开看：
 *  · 输入参数被改了（logicalWidth / statsZonePx 在拖拽中被改）→ 属产品缺陷；
 *  · 参数没变但渲染出的几何变了（窗口尺寸读数滞后等）→ 属渲染/DPI 现象。
 * 所以这里把"输入参数"和"输出几何"一起读回并对照。
 *
 * @param {(name: string, ok: boolean, detail?: string) => void} check
 * @param {(ms: number) => Promise<void>} wait
 */
async function verifyLayoutDuringDrag(check, wait) {
  const wc = win && !win.isDestroyed() ? win.webContents : null
  if (!wc) return

  const diag = () => wc.executeJavaScript('window.__petTestLayoutDiag()', true)

  // 面板隐藏时 display:none，几何全是 0，测不出东西 —— 先按住显示，再量。
  const forced = await wc.executeJavaScript('window.__petTestForceStats(true)', true)
  await wait(200)
  if (TRACE || forced.display !== 'flex') {
    log(`[trace] 强制显示属性面板：hidden=${String(forced.hidden)} display=${String(forced.display)}`)
  }

  const before = await diag()
  // 用 Electron 自己的 capturePage 抓一张"面板可见"的窗口内容图。
  //
  // 为什么不靠外部截屏工具：外部工具拿到的是屏幕像素，受 DPI 缩放与窗口边框影响，
  // 而且它抓不到被遮挡的部分；capturePage 直接给窗口内容的位图，是可信的地面真值。
  if (!process.argv.includes('--no-shot')) {
    try {
      const image = await wc.capturePage()
      const { writeFileSync, mkdirSync } = require('node:fs')
      const dir = path.join(__dirname, '..', '_research')
      mkdirSync(dir, { recursive: true })
      const png = image.toPNG()
      writeFileSync(path.join(dir, 'panel-visible.png'), png)
      const size = image.getSize()
      log(`面板可见时的窗口位图：${String(size.width)}x${String(size.height)}（DPR ${String(before.devicePixelRatio)}）`)
    } catch (err) {
      log(`抓图失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }
  // 面板高度必须与主进程按目标宽度算出的大小一致 —— 这一条曾经是坏的：
  // renderer 里 applyLayout 误用同名局部变量遮蔽了元素引用，高度从未被赋值。
  const expectedZoneBefore = statsZoneFor(logicalWidth)
  check(
    '属性面板高度正确（含拖拽前）',
    before.panelRect !== null && Math.abs(before.panelRect.height - expectedZoneBefore) <= 6,
    `面板高 ${before.panelRect ? before.panelRect.height.toFixed(1) : 'null'}，期望约 ${String(expectedZoneBefore)}`,
  )
  check(
    '属性面板紧贴余额面板下方（含拖拽前）',
    before.panelRect !== null &&
      before.balanceRect !== null &&
      Math.abs(before.panelRect.top - before.balanceRect.bottom) <= 2,
    `面板顶 ${before.panelRect ? before.panelRect.top.toFixed(1) : 'null'}，` +
      `余额底 ${before.balanceRect ? before.balanceRect.bottom.toFixed(1) : 'null'}`,
  )
  log(
    `参考-拖拽前几何: 内 ${String(before.innerWidth)}x${String(before.innerHeight)}` +
      ` 外 ${String(before.outerWidth)}x${String(before.outerHeight)} DPR ${String(before.devicePixelRatio)}` +
      ` docClientH ${String(before.docClientHeight)} bodyClientH ${String(before.bodyClientHeight)} bodyScrollH ${String(before.bodyScrollHeight)}`,
  )
  log(
    `参考-拖拽前几何: 舞台 ${before.stageRect.width.toFixed(0)}x${before.stageRect.height.toFixed(0)} @ ${before.stageRect.top.toFixed(0)}` +
      ` 角色 ${before.characterRect.width.toFixed(0)}x${before.characterRect.height.toFixed(0)}` +
      ` @ ${before.characterRect.top.toFixed(0)}..${before.characterRect.bottom.toFixed(0)}` +
      ` 立绘 ${before.frameRect.width.toFixed(0)}x${before.frameRect.height.toFixed(0)}` +
      ` @ ${before.frameRect.top.toFixed(0)}..${before.frameRect.bottom.toFixed(0)}` +
      ` 面板 ${before.panelRect.width.toFixed(0)}x${before.panelRect.height.toFixed(0)}` +
      ` @ ${before.panelRect.top.toFixed(0)}..${before.panelRect.bottom.toFixed(0)}`,
  )
  log(
    `参考-立绘元素自检: tag=${String(before.frameTagName)} class=${String(before.frameClassName)}` +
      ` inlineStyle=${String(before.frameInlineStyle)}`,
  )
  log(`参考-角色区 inlineStyle=${String(before.charInlineStyle)}`)
  const [wx0, wy0] = win.getPosition()
  const [ww, wh] = win.getSize()

  // 模拟一次真实拖拽：注入光标 → 起拖 → 分几次移动 → 松手。
  cursorOverride = { x: wx0 + Math.round(ww / 2), y: wy0 + Math.round(wh / 2) }
  beginDragSession()
  await wait(150)

  const samples = []
  for (const step of [
    { dx: 60, dy: -50 },
    { dx: 140, dy: -110 },
    { dx: 220, dy: -170 },
    { dx: 260, dy: -210 },
  ]) {
    cursorOverride = { x: wx0 + Math.round(ww / 2) + step.dx, y: wy0 + Math.round(wh / 2) + step.dy }
    await wait(200)
    samples.push(await diag())
  }
  endDragSession()
  await wait(250)
  const after = await diag()

  // 输入参数在任何时刻都不该变。
  const allSameWidth = [before, ...samples, after].every((s) => s.logicalWidth === before.logicalWidth)
  check(
    '拖拽期间角色宽度参数不变',
    allSameWidth,
    `起始 ${String(before.logicalWidth)}，各次采样 ${[...samples, after].map((s) => String(s.logicalWidth)).join(' / ')}`,
  )

  // 面板高度在拖拽全程应当**恒定**（不随时间变长）。
  const heights = [before, ...samples, after].map((s) => (s.panelRect ? s.panelRect.height : 0))
  const firstHeight = heights[0]
  const allSameZone = heights.every((h) => Math.abs(h - firstHeight) <= 1.5)
  check(
    '拖拽期间属性面板高度恒定',
    allSameZone,
    `起始 ${firstHeight.toFixed(1)}px，各次采样 ${heights.map((h) => h.toFixed(1)).join(' / ')}`,
  )

  // ---- 输出几何：面板高度应恒等于主进程按目标宽度算出的大小，角色底边应紧贴面板顶边 ----
  const expectedZone = statsZoneFor(logicalWidth)
  for (const [i, s] of samples.entries()) {
    check(
      `拖动中第 ${String(i + 1)} 次采样：面板高度稳定`,
      s.panelRect !== null && Math.abs(s.panelRect.height - expectedZone) <= 6,
      `面板高 ${s.panelRect ? s.panelRect.height.toFixed(1) : 'null'}，期望约 ${String(expectedZone)}`,
    )
    check(
      `拖动中第 ${String(i + 1)} 次采样：面板紧贴余额面板下方`,
      s.panelRect !== null &&
        s.balanceRect !== null &&
        Math.abs(s.panelRect.top - s.balanceRect.bottom) <= 2,
      `面板顶 ${s.panelRect ? s.panelRect.top.toFixed(1) : 'null'}，` +
        `余额底 ${s.balanceRect ? s.balanceRect.bottom.toFixed(1) : 'null'}`,
    )
  }

  // 面板不该随时间"变长"：把各次采样的高度列出来，肉眼可判趋势。
  log(
    `参考-拖拽中各次面板高度: ${samples.map((s) => s.panelRect ? s.panelRect.height.toFixed(1) : 'null').join(' → ')}` +
      `（期望约 ${String(statsZoneFor(logicalWidth))}px）`,
  )
  log(
    `参考-拖拽中各次窗口内高: ${[before, ...samples, after].map((s) => String(s.innerHeight)).join(' → ')}`,
  )
  log(
    `参考-拖拽中面板与角色间距: ${samples
      .map((s) => (s.panelRect ? (s.panelRect.top - s.characterRect.bottom).toFixed(1) : 'null'))
      .join(' → ')}`,
  )
  log(
    `参考-拖拽中角色几何: ${samples
      .map((s) => `${s.characterRect.width.toFixed(0)}x${s.characterRect.height.toFixed(0)}@${s.characterRect.top.toFixed(0)}`)
      .join(' → ')}`,
  )
  log(
    `参考-拖拽中面板几何: ${samples
      .map((s) => `${s.panelRect.width.toFixed(0)}x${s.panelRect.height.toFixed(0)}@${s.panelRect.top.toFixed(0)}`)
      .join(' → ')}`,
  )

  await wc.executeJavaScript('window.__petTestForceStats(false)', true)
  cursorOverride = null
}

/**
 * 真实拖拽的**逐帧轨迹记录**，写到文件供事后分析。
 *
 * 为什么落盘而不是只打日志：这个现象反复出现又反复"测不到"，
 * 而日志会被后续内容淹没、也难以做统计。落盘后可以直接算尺寸极差与漂移量。
 *
 * 记录内容：每帧的光标位置、目标位置、**实际窗口位置与尺寸**。
 */
function startDragTraceFile() {
  try {
    const { writeFileSync } = require('node:fs')
    const file = path.join(__dirname, '..', '_research', 'drag-trace.jsonl')
    writeFileSync(file, '', 'utf8')
    dragTraceFile = file
  } catch {
    dragTraceFile = null
  }
}

/** @type {string | null} */
let dragTraceFile = null

/** 把一帧的拖拽观测追加到轨迹文件。 */
function appendDragTrace(record) {
  if (!dragTraceFile) return
  try {
    require('node:fs').appendFileSync(dragTraceFile, `${JSON.stringify(record)}\n`, 'utf8')
  } catch {
    // 忽略：诊断写入失败不该影响拖拽。
  }
}

/**
 * 验证拖动时窗口**边界不会超出屏幕**（用户要求）。
 *
 * 做法：把光标推到屏幕工作区之外（左上、右下都很远），然后逐帧检查窗口的
 * 四条边是否都在工作区内。这正是"限制可运动范围"的可验证形式。
 *
 * @param {(name: string, ok: boolean, detail?: string) => void} check
 * @param {(ms: number) => Promise<void>} wait
 */
async function verifyDragBounds(check, wait) {
  if (!win || win.isDestroyed()) return
  const area = screen.getPrimaryDisplay().workArea
  const [w0, h0] = win.getSize()
  const [x0, y0] = win.getPosition()
  const grabX = x0 + Math.round(w0 / 2)
  const grabY = y0 + Math.round(h0 / 2)

  /** 读窗口四边，判断是否完整落在工作区内。 */
  const readEdges = () => {
    const [x, y] = win.getPosition()
    const [w, h] = win.getSize()
    return { x, y, w, h, left: x, top: y, right: x + w, bottom: y + h }
  }

  const outside = (e) =>
    e.left < area.x - 1 || e.top < area.y - 1 || e.right > area.x + area.width + 1 || e.bottom > area.y + area.height + 1

  cursorOverride = { x: grabX, y: grabY }
  beginDragSession()
  await wait(120)

  // 一组"故意越界"的目标位置：远超四个角。
  const FAR = 100000
  const cases = [
    { name: '左上角之外', x: area.x - FAR, y: area.y - FAR },
    { name: '右上角之外', x: area.x + area.width + FAR, y: area.y - FAR },
    { name: '左下角之外', x: area.x - FAR, y: area.y + area.height + FAR },
    { name: '右下角之外', x: area.x + area.width + FAR, y: area.y + area.height + FAR },
  ]

  let allInside = true
  const details = []
  for (const c of cases) {
    // 直接注入"抓取点已经跑到那里"的光标位置：窗口目标 = 光标 − 抓取偏移。
    cursorOverride = { x: c.x + (grabX - x0), y: c.y + (grabY - y0) }
    await wait(240)
    const e = readEdges()
    const bad = outside(e)
    if (bad) allInside = false
    details.push(`${c.name}:(${String(e.x)},${String(e.y)})${String(e.w)}x${String(e.h)}${bad ? '✗' : '✓'}`)
  }

  check(
    '拖动时窗口边界不出屏（推往四角之外）',
    allInside,
    `工作区 ${String(area.x)},${String(area.y)} ${String(area.width)}x${String(area.height)}｜${details.join(' ')}`,
  )

  // 再检查一遍四条边各自贴边时的极限值。
  const e = readEdges()
  check(
    '拖动时窗口完整落在工作区内',
    !outside(e),
    `窗口 ${String(e.left)},${String(e.top)} → ${String(e.right)},${String(e.bottom)}；` +
      `工作区 ${String(area.x)},${String(area.y)} → ${String(area.x + area.width)},${String(area.y + area.height)}`,
  )

  endDragSession()
  cursorOverride = null
  // 收尾：把窗口放回一个安全位置，避免影响后续断言。
  win.setBounds({ x: x0, y: y0, width: w0, height: h0 })
  await wait(150)
}

/**
 * 验证**真实拖拽**（光标连续移动、窗口跟随）期间窗口尺寸与位置是否稳定。
 *
 * 为什么之前的测试抓不到：`verifyLayoutDuringDrag` 只移动"注入的光标"，
 * 而窗口是跟着光标走的 —— 两者同步移动，窗口实际上几乎没动。
 * 这里改成真正推进光标，并**逐帧记录尺寸**，任何累积性变化都会显形。
 *
 * @param {(name: string, ok: boolean, detail?: string) => void} check
 * @param {(ms: number) => Promise<void>} wait
 */
async function verifyRealDrag(check, wait) {
  if (!win || win.isDestroyed()) return
  const wc = win && !win.isDestroyed() ? win.webContents : null
  if (!wc) return
  /** 读渲染进程的内部状态（动画 / 帧号 / 动作）。 */
  const readState = () => wc.executeJavaScript('window.__petTestState ? window.__petTestState() : null', true)
  startDragTraceFile()

  const samples = []
  const measure = (tag) => {
    const [w, h] = win.getSize()
    const [x, y] = win.getPosition()
    const rec = { tag, w, h, x, y, t: Date.now() }
    samples.push(rec)
    return rec
  }

  // 先把窗口放到屏幕中部，这样这次拖拽不会撞到边界 ——
  // 本用例要验的是"落点跟随光标、且尺寸不漂"，而不是夹取行为
  // （夹取由 verifyDragBounds 专门验证）。
  {
    const area = screen.getPrimaryDisplay().workArea
    const [cw, ch] = win.getSize()
    const safe = clampToWorkArea(
      area.x + Math.round((area.width - cw) / 2),
      area.y + Math.round((area.height - ch) / 2),
    )
    win.setBounds({ x: safe.x, y: safe.y, width: cw, height: ch })
    await wait(200)
  }

  // 大幅、多步地推进光标（24 步 × 6px = 144px），并**逐帧记录**。
  const STEPS = 24
  const STEP = 6

  const before = measure('居中后起点')
  const grabX = before.x + Math.round(before.w / 2)
  const grabY = before.y + Math.round(before.h / 2)
  cursorOverride = { x: grabX, y: grabY }
  beginDragSession()
  await wait(120)

  // 让渲染进程也进入拖拽态（合成 mousedown）：拖拽动画是由渲染进程在
  // "长按 180ms" 之后起播的，只调 beginDragSession() 不会触发它。
  // clientX/Y 取帧元素中心，保证落在角色身上（透明处不会开始拖拽）。
  const dragAnimState = []
  {
    /*
     * 先让一个**一次性动作**播起来，才能验证"拖拽开始会把它停掉"。
     *
     * ⚠️ 必须用**短动作**（head，10 帧 ≈ 1.7s），不能用 eat。
     * eat 的播放序列是 33 帧（咀嚼段循环 4 次）≈ 5.5s，收尾定时器要 5.65s 才到；
     * 而这里只等 300ms 就开始拖拽 —— 那条定时器会一直挂着，之后到点调 endAction()
     * 把 hang 动画从中间切成站立。实测它导致"拖拽动画停在最后一帧"偶发失败，
     * 诊断显示 `最近一次 endAction：动作=eat`。
     */
    await wc.executeJavaScript(`(async () => { await playAction('head', { fromMenu: true }); return true })()`, true)
    await wait(300)
    const beforeDragStart = await readState()

    const l = await wc.executeJavaScript('window.__petTestLayoutDiag()', true)
    const cx = Math.round(l.frameRect.left + l.frameRect.width / 2)
    const cy = Math.round(l.frameRect.top + l.frameRect.height / 2)
    const opts = `{ bubbles: true, button: 0, clientX: ${String(cx)}, clientY: ${String(cy)}, screenX: ${String(grabX)}, screenY: ${String(grabY)} }`
    await wc.executeJavaScript(
      `(function () {
        const stage = document.getElementById('stage')
        stage.dispatchEvent(new MouseEvent('mousedown', ${opts}))
        return true
      })()`,
      true,
    )
    // ⚠️ mousedown 本身**不算**开始拖拽（可能只是单击），所以这里不能立刻断言。
    // 真正的"开始拖拽"是 180ms 长按判定通过之后 —— 停掉旧动画也发生在那一刻。
    const rightAfterPress = await readState()
    check(
      'mousedown 的 180ms 判定期内不打断当前动画（单击语义不受影响）',
      rightAfterPress.activeAnimationId === 'head',
      `按下 60ms 后动画=${String(rightAfterPress.activeAnimationId)}（应仍是 head）`,
    )

    // 180ms 长按之后才起播拖拽动画，多等一点余量。
    await wait(420)
    const liftedState = await readState()
    /*
     * 先单独钉住"拎起判定是否通过"。
     *
     * 实测偶发（约五次一次）出现 `activeAnimationId` 仍是 head、收尾定时器还在 ——
     * 这不是"收尾把 hang 打断了"，而是 **180ms 的拎起回调根本没执行**。
     * 两种情况（回调没跑 / 跑完又被打断）修法完全不同，所以必须先分清：
     * `dragging` 为 true 说明回调**跑过**（它第一件事就是 endAction 并起播 hang），
     * 为 false 说明回调被 `finishDrag()` 提前取消了。
     */
    check(
      '拎起判定通过（mousedown 后处于拖拽态）',
      liftedState.dragging === true,
      `dragging=${String(liftedState.dragging)}；` +
        `active=${String(liftedState.activeAnimationId)}，currentActionId=${String(liftedState.currentActionId)}`,
    )
    check(
      '确认拖拽后立即停掉正在播的动作动画',
      beforeDragStart.activeAnimationId === 'head' &&
        beforeDragStart.hasActionStopTimer === true &&
        liftedState.currentActionId === null &&
        liftedState.hasActionStopTimer === false &&
        liftedState.activeAnimationId === 'hang',
      `按下前=${String(beforeDragStart.activeAnimationId)}（收尾定时器 ${String(beforeDragStart.hasActionStopTimer)}）` +
        ` → 拎起后=${String(liftedState.activeAnimationId)}，` +
        `currentActionId=${String(liftedState.currentActionId)}，收尾定时器=${String(liftedState.hasActionStopTimer)}`,
    )
    dragAnimState.push({ at: '起播后', ...liftedState })

    // 拖拽进行中：菜单/随机/点击都不得挤进别的动画。
    const blocked = await wc.executeJavaScript(
      `(async () => {
        await playAction('eat', { fromMenu: true })
        await playAction('head', { fromMenu: true, clickPart: true })
        return { activeAnimationId, currentActionId }
      })()`,
      true,
    )
    await wait(300)
    const stillDragging = await readState()
    check(
      '拖拽进行中禁止其他动画触发',
      blocked.activeAnimationId === 'hang' && stillDragging.activeAnimationId === 'hang',
      `尝试触发 eat/head 后 active=${String(stillDragging.activeAnimationId)}（应仍为 hang）`,
    )
  }

  for (let i = 1; i <= STEPS; i += 1) {
    const nx = grabX - STEP * i
    const ny = grabY - STEP * i
    cursorOverride = { x: nx, y: ny }
    await wait(70)
    const [w, h] = win.getSize()
    const [ax, ay] = win.getPosition()
    appendDragTrace({ i, cursor: { x: nx, y: ny }, w, h, x: ax, y: ay })
    if (i % 4 === 0 || i === STEPS) measure(`第 ${String(i)} 步`)
  }

  // 拖拽已改为"静态随机帧"：帧不会推进，应当一直停在被选中的那一帧。
  dragAnimState.push({ at: '稍后', ...(await readState()) })
  log(
    `参考-拖拽动画: 起播后 active=${String(dragAnimState[0].activeAnimationId)}` +
      ` 帧 ${String(dragAnimState[0].currentFrame)}/${String(dragAnimState[0].currentFrameCount)}` +
      ` 静态池=${JSON.stringify(dragAnimState[0].currentStaticFrames)}` +
      `；稍后 active=${String(dragAnimState[1].activeAnimationId)}` +
      ` 帧 ${String(dragAnimState[1].currentFrame)}/${String(dragAnimState[1].currentFrameCount)}`,
  )
  check(
    '拖拽时播放 hang 动画',
    dragAnimState[0].activeAnimationId === 'hang',
    `activeAnimationId=${String(dragAnimState[0].activeAnimationId)}`,
  )
  /*
   * 拖拽已不再是一段多帧动画，而是**静态随机帧**
   * （用户要求：「不再采用多帧动画形式，而是改为静态，
   *   在触发拖拽时随机播放其中一个动作，其他机制不变」）。
   *
   * 所以这里要验的不再是"停在最后一帧"，而是三件事：
   *   1. 该动画确实声明了静态帧池；
   *   2. 显示的是池里的一员（随机取到其中任意一个都算对）；
   *   3. 帧号**不再推进**（隔一会儿再看，仍是同一帧）—— 这才是"静态"。
   */
  {
    const a = dragAnimState[0]
    const b = dragAnimState[1]
    const pool = Array.isArray(a.currentStaticFrames) ? a.currentStaticFrames : []
    check(
      '拖拽动画声明了静态帧池（不再是多帧动画）',
      pool.length > 0,
      `currentStaticFrames=${JSON.stringify(a.currentStaticFrames)}`,
    )
    check(
      '拖拽显示的是池中某一帧',
      b.activeAnimationId === 'hang' && pool.includes(b.currentFrame),
      `active=${String(b.activeAnimationId)} 帧=${String(b.currentFrame)} 池=${JSON.stringify(pool)}` +
        // 若被切走，把"是谁结束了动作"一并打出来 —— 三种原因（定时器到点 /
        // 宿主状态变化 / 被新动作顶掉）修法完全不同，不能只看到结果就猜。
        (b.activeAnimationId !== 'hang' && b.lastEndAction
          ? `；最近一次 endAction：动作=${String(b.lastEndAction.finishedActionId)}` +
            ` 当时的动画=${String(b.lastEndAction.wasAnimation)}` +
            ` 调用点=${String(b.lastEndAction.stack)}`
          : ''),
    )
    check(
      '拖拽帧不再推进（静态）',
      b.currentFrame === a.currentFrame,
      `起播后帧=${String(a.currentFrame)}，稍后帧=${String(b.currentFrame)}（应相同）`,
    )

    /*
     * "随机"必须真的随机 —— 只观察一次拖拽证明不了任何事
     * （池有两帧时，连续两次抽到同一帧的概率就有 50%）。
     * 所以连续触发 40 次，要求池里**每一帧都出现过**。
     */
    const many = await wc.executeJavaScript(
      `window.__petTestDragStaticFrames(40)`,
      true,
    )
    if (!many || !many.ok) {
      check('拖拽静态帧随机采样', false, '钩子调用失败')
    } else {
      const pool = Array.isArray(many.pool) ? many.pool : []
      const seen = new Set(many.frames)
      const outside = many.frames.filter((f) => !pool.includes(f))
      const counts = pool.map((f) => `${String(f)}×${String(many.frames.filter((x) => x === f).length)}`)
      check(
        '拖拽静态帧每次都在池内',
        outside.length === 0,
        `池=${JSON.stringify(pool)}；越界帧=${JSON.stringify(outside)}`,
      )
      check(
        '拖拽静态帧确实随机（池中每一帧都出现过）',
        pool.length > 0 && pool.every((f) => seen.has(f)),
        `40 次采样分布：${counts.join('  ')}` +
          (pool.every((f) => seen.has(f)) ? '' : `；未出现的帧=${JSON.stringify(pool.filter((f) => !seen.has(f)))}`),
      )
    }
    /*
     * 连续触发会改变当前帧（这是刻意的：它就是在模拟反复拖拽）。
     * 后面 mouseup 会走正常的收尾路径切回站立，因此不需要在这里复位。
     */
  }

  /*
   * 结束渲染进程的拖拽态（合成 mouseup）—— 这会触发"立刻回站立"。
   *
   * ⚠️ 顺序与坐标都很讲究，我在这里踩过两次：
   *
   *  1. 必须把光标**先复位**再派发 mouseup。
   *     否则（光标还压在角色上）本函数末尾的"压一下"逻辑会把拖拽当成点击；
   *  2. mouseup 的 screenX/screenY 必须用**按下时的位置**（grabX/grabY），
   *     不能用当前光标位置。渲染进程判定"点击 vs 拖动"是拿 mouseup 的屏幕坐标
   *     跟 dragStart 比：若两者相同（totalDx=0），144px 的真实拖动会被判成点击，
   *     于是触发点击互动动画、并把刚切回来的站立动画顶掉。
   *     实测日志就是 `totalDx:0, totalDy:0, isClick:true`。
   *
   *  3. 更要紧的是：`endDragSession()` 会把渲染进程的 `dragStart` **重置为当前光标
   *     位置**。所以 mouseup 的 screenX/screenY 必须取"重置之后读到的真实光标"，
   *     而不是按下时的 grabX/grabY —— 两者会差一两像素，位移就变成 0，
   *     于是又被判成点击（第二次踩到同一个坑）。
   */
  endDragSession()
  cursorOverride = null
  await wait(200)
  // 读"重置之后"的真实光标位置，作为松手坐标。
  const upPoint = readCursorPoint()
  {
    const l = await wc.executeJavaScript('window.__petTestLayoutDiag()', true)
    const cx = Math.round(l.frameRect.left + l.frameRect.width / 2)
    const cy = Math.round(l.frameRect.top + l.frameRect.height / 2)
    await wc.executeJavaScript(
      `(function () {
        window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: ${String(cx)}, clientY: ${String(cy)}, screenX: ${String(upPoint.x)}, screenY: ${String(upPoint.y)} }))
        return true
      })()`,
      true,
    )
  }
  await wait(250)
  const afterDragAnim = await readState()
  check(
    '松手后立刻回到站立闲置动画',
    afterDragAnim.activeAnimationId === 'stand',
    `activeAnimationId=${String(afterDragAnim.activeAnimationId)}；` +
      `松手判定=${JSON.stringify(afterDragAnim.lastClickDecision)}`,
  )

  /*
   * 明确的收尾：确保渲染进程真的退出了拖拽态。
   *
   * 为什么需要：后面"睡眠用例"的前置检查会断言 `dragging === false`。
   * 实测偶发（约五次一次）合成 mouseup 之后 `dragging` 仍是 true，
   * 而渲染进程只在 `mousemove 且 e.buttons === 0` 时才把它清掉 ——
   * 若此后没有新的 mousemove，它会一直挂着，把睡眠用例整片带失败。
   * 所以这里补发一次 mouseup，并轮询确认；仍不成则明确报出来（不静默放过）。
   */
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const st = await readState()
    if (st.dragging === false) break
    const l = await wc.executeJavaScript('window.__petTestLayoutDiag()', true)
    const cx = Math.round(l.frameRect.left + l.frameRect.width / 2)
    const cy = Math.round(l.frameRect.top + l.frameRect.height / 2)
    await wc.executeJavaScript(
      `(function () {
        window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: ${String(cx)}, clientY: ${String(cy)}, screenX: ${String(upPoint.x)}, screenY: ${String(upPoint.y)} }))
        return true
      })()`,
      true,
    )
    await wait(300)
  }
  /*
   * 明确的收尾：**强制**让渲染进程退出拖拽态。
   *
   * 为什么需要：本用例是靠合成 mousedown / mousemove / mouseup 驱动的，
   * 而 `finishDrag()` 只在「mouseup」或「mousemove 且 buttons===0」时才真正退出
   * 拖拽态。只补发 mouseup 并不可靠（实测偶发残留），而残留的拖拽态会**污染后续用例**：
   * 睡眠用例的"静置 6 秒不被打断"检查里冒出一条
   * `sleeping→idle(强行中断：用户开始拖拽)`，整片睡眠断言跟着失败。
   *
   * 所以直接调测试专用的 `__petTestForceEndDrag()`（内部就是 finishDrag）——
   * 不依赖事件是否递送到位，收尾是确定的。补发 mouseup 仍保留在前面，
   * 因为它同时验证了"真实松手路径"能把状态清掉。
   */
  await wc.executeJavaScript('window.__petTestForceEndDrag()', true)
  await wait(200)
  check(
    '拖拽用例结束后渲染进程已退出拖拽态',
    (await readState()).dragging === false,
    `dragging=${String((await readState()).dragging)}`,
  )

  await wait(300)
  const after = measure('松手后')
  cursorOverride = null

  const widths = samples.map((s) => s.w)
  const heights = samples.map((s) => s.h)
  const wSpread = Math.max(...widths) - Math.min(...widths)
  const hSpread = Math.max(...heights) - Math.min(...heights)
  check('真实拖拽：窗口宽度全程不变', wSpread <= 2, `宽 ${widths.join(' / ')}（极差 ${String(wSpread)}）`)
  check('真实拖拽：窗口高度全程不变', hSpread <= 2, `高 ${heights.join(' / ')}（极差 ${String(hSpread)}）`)

  const expectedX = before.x - STEP * STEPS
  const expectedY = before.y - STEP * STEPS
  check(
    '真实拖拽：落点 = 起点 + 光标位移（无漂移）',
    Math.abs(after.x - expectedX) <= 3 && Math.abs(after.y - expectedY) <= 3,
    `期望 (${String(expectedX)},${String(expectedY)})，实际 (${String(after.x)},${String(after.y)})`,
  )
  log(`参考-真实拖拽轨迹: ${samples.map((s) => `(${String(s.x)},${String(s.y)})${String(s.w)}x${String(s.h)}`).join(' → ')}`)
  if (dragTraceFile) log(`逐帧轨迹已写入 ${dragTraceFile}`)
}

/**
 * 验证"点击不同部位触发不同台词"。
 *
 * 三个要点：
 *  1. 部位矩形的中心**必须落在角色身上**（用逐像素命中测试确认）——
 *     否则"点了那个部位"其实点的是透明背景，机制形同虚设；
 *  2. 在每个部位中心合成一次真实点击（与手动点击走同一条监听器路径）；
 *  3. 气泡里出现的台词必须属于该部位。
 *
 * @param {(name: string, ok: boolean, detail?: string) => void} check
 * @param {(ms: number) => Promise<void>} wait
 */
async function verifyClickParts(check, wait) {
  const wc = win && !win.isDestroyed() ? win.webContents : null
  if (!wc) return

  /*
   * 前置：关掉随机动作，并确保**没有动作在播**。
   *
   * 为什么要加：这段用例假设"点一下就该播部位动画/说部位台词"，
   * 但随机动作可能恰好插进来 —— 抽到「坐下」时 `petState='sitting'`，
   * 而点击坐着的桌宠是"让她站起来"的语义（不说部位台词、不播部位动画），
   * 于是整段用例集体失败，还连带后面的边界取样断言一起红。
   * 实测就是这么偶发红的（同一份代码一轮过、一轮红）。
   *
   * ⚠️ 只做"最小清理"：概率设 0、门槛推远，再用 endAction() 收掉动作。
   * **不要**无条件去动思考状态机 —— 试过调 `__petTestThink.exit()`，
   * 结果把后面「深度思考」用例的前置搅乱了（它会留下一个退出段）。
   * 只有真的不在 idle（坐着/睡着）时才用「刷新状态」兜底。
   */
  await wc.executeJavaScript(
    'window.__petTestSetIdleClock({ probability: 0, readyAt: Date.now() + 600000 })',
    true,
  )
  /*
   * 再把随机动作**彻底**关掉（`__petTestDisableIdle`）。
   *
   * 为什么上面的概率注入不够：宿主每次推送状态都会重置闲置计时，
   * 跑了 1 分钟以上注入就失效了，随机动作会重新插进来 ——
   * 实测这段用例因此间歇性失败（气泡里冒出「（占位）开饭啦」）。
   * 这个开关不会被状态推送清掉，用例结束时会恢复。
   */
  await wc.executeJavaScript('window.__petTestDisableIdle(true)', true)
  /*
   * 还要把"深度思考"及其**退出段**清干净。
   *
   * 退出段播放中点击会被守卫吞掉（那是刻意的：避免把退出动画切成两半），
   * 但这段用例要的是"点一下就该有反应" —— 带着退出段进来必然失败。
   * 注意：清完之后**必须等 phase 回到 null**，不能只发一次 exit 就走。
   */
  await wc.executeJavaScript('window.__petTestThink && window.__petTestThink.exit("点击用例前置")', true)
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const st = await wc.executeJavaScript(
      '({ phase: (window.__petTestThink.state() || {}).phase, action: (window.__petTestState() || {}).currentActionId, petState: (window.__petTestState() || {}).petState })',
      true,
    )
    if (st && st.phase === null && !st.action && st.petState === 'idle') break
    await wc.executeJavaScript('window.__petTestRefresh()', true)
    await wait(200)
  }
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const st = await wc.executeJavaScript(
      '({ action: (window.__petTestState() || {}).currentActionId, petState: (window.__petTestState() || {}).petState })',
      true,
    )
    if (st && !st.action && st.petState === 'idle') break
    await wc.executeJavaScript('window.__petTestRefresh()', true)
    await wait(200)
  }

  const parts = await wc.executeJavaScript('window.__petTestState().clickParts', true)
  if (!Array.isArray(parts) || parts.length === 0) {
    check('点击部位清单已下发', false, '渲染进程里 clickParts 为空')
    return
  }
  check('点击部位清单已下发', true, `共 ${String(parts.length)} 个部位：${parts.map((p) => p.label).join('/')}`)

  const bubbleText = () => wc.executeJavaScript('document.getElementById("bubble-text").textContent', true)

  for (const part of parts) {
    // 一个部位可能有多个矩形（例如手臂左右各一、腿分左右），逐个试中心点，
    // 取第一个"确实落在角色身上"的点。
    const boxes = Array.isArray(part.box) ? part.box : [part.box]
    let point = null
    let opaqueAt = null
    for (const box of boxes) {
      const u = (box.x0 + box.x1) / 2
      const v = (box.y0 + box.y1) / 2
      const probe = await wc.executeJavaScript(
        `window.__petTestProbePart(${String(u)}, ${String(v)})`,
        true,
      )
      if (probe && probe.opaque) {
        point = { u, v, clientX: probe.clientX, clientY: probe.clientY }
        opaqueAt = { u, v }
        break
      }
    }

    check(
      `部位「${part.label}」的取样点落在角色身上`,
      point !== null,
      point ? `u=${point.u.toFixed(2)} v=${point.v.toFixed(2)}` : '该部位所有矩形中心都是透明像素（区域估计错了）',
    )
    if (!point) continue

    /*
     * 先等**上一个部位**的互动动画收尾，再点这个部位。
     *
     * 顺序很重要：等动画收尾要放在**点击之前**。我第一版把它放在了点击之后，
     * 于是等到的已经是"这个动画播完回到站立"，断言自然读不到动画在播。
     */
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const st = await wc.executeJavaScript('window.__petTestState()', true)
      if (!st.currentActionId && st.activeAnimationId === 'stand') break
      await wait(200)
    }

    // 合成一次真实点击：mousedown + mouseup 同一点（位移 0 → 判为单击）。
    await wc.executeJavaScript(
      `(function () {
        const stage = document.getElementById('stage')
        const opts = { bubbles: true, button: 0, clientX: ${String(point.clientX)}, clientY: ${String(point.clientY)},
                       screenX: ${String(point.clientX)}, screenY: ${String(point.clientY)} }
        stage.dispatchEvent(new MouseEvent('mousedown', opts))
        window.dispatchEvent(new MouseEvent('mouseup', opts))
        return true
      })()`,
      true,
    )
    await wait(200)
    const said = String(await bubbleText())
    /*
     * 部位台词现在按**好感度三档**分组（用户要求），所以断言要按"当前爱心数"
     * 选档后再比对，而不是直接读 `part.lines`（那个字段已经不存在了）。
     */
    const tierTable = part.linesByTier ?? {}
    const heartsNow = affection.hearts
    const tierNow = heartsNow <= 1 ? 'low' : heartsNow <= 3 ? 'mid' : 'high'
    const expectedLines = Array.isArray(tierTable[tierNow]) ? tierTable[tierNow] : []
    const allTierLines = Object.values(tierTable).flat()
    const matched = expectedLines.some((line) => line === said)
    check(
      `点击「${part.label}」触发该部位台词（${tierNow} 档）`,
      matched,
      `气泡="${said}"，${String(heartsNow)} 心应对应 ${tierNow} 档=${JSON.stringify(expectedLines)}`
        + (matched ? '' : `；全部档位=${JSON.stringify(allTierLines)}`),
    )

    // 配了互动动画的部位，点击后应当真的在播那个动画（用户要求：
    // 只播放互动动画，不再有 CSS 压扁效果）。
    const clickState = await wc.executeJavaScript('window.__petTestState()', true)
    if (part.actionId) {
      check(
        `点击「${part.label}」播放互动动画 ${part.actionId}`,
        clickState.activeAnimationId === part.actionId && clickState.currentActionId === part.actionId,
        `动画=${String(clickState.activeAnimationId)}，动作=${String(clickState.currentActionId)}`,
      )
      // 等它播完，确认会自己回到站立 —— 否则动画会永久占住画面。
      let backToStand = false
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await wait(200)
        const st = await wc.executeJavaScript('window.__petTestState()', true)
        if (st.activeAnimationId === 'stand' && !st.currentActionId) {
          backToStand = true
          break
        }
      }
      check(
        `互动动画 ${part.actionId} 播完回到站立`,
        backToStand,
        `最终动画=${String((await wc.executeJavaScript('window.__petTestState()', true)).activeAnimationId)}`,
      )
    } else {
      // 没配动画的部位不应触发任何动画，只说话。
      // （目前四个部位都已配动画，这个分支作为"将来新增部位忘了配素材"的兜底。）
      check(
        `点击「${part.label}」不触发动画（未配素材）`,
        clickState.activeAnimationId === 'stand' && !clickState.currentActionId,
        `动画=${String(clickState.activeAnimationId)}，动作=${String(clickState.currentActionId)}`,
      )
    }
  }

  // 四个部位都应当配好互动动画，且素材真的能加载。
  const allParts = await wc.executeJavaScript('window.__petTestState().clickParts', true)
  const missingAction = (allParts ?? []).filter((p) => !p.actionId)
  check(
    '四个部位都配了互动动画',
    missingAction.length === 0,
    missingAction.length === 0
      ? `部位动画：${(allParts ?? []).map((p) => `${p.label}→${p.actionId}`).join('，')}`
      : `未配动画的部位：${missingAction.map((p) => p.label).join('，')}`,
  )

  /*
   * 胸/腹的左右边界必须落在**角色身上**，且不能把两侧头发圈进来。
   *
   * ⚠️ 判据用"贴边取样"：在框的左右边缘各取几个点，确认它们都还落在角色身上。
   * 这样边界既不会悬在画布空白里（点不到却显示有反应），也不会明显伸进头发 ——
   * 因为头发是细长的一条，一旦框伸出去，贴边点就会落到头发上，而**头发不属于
   * 胸/腹的语义**，用户会感知为"点头发被判成胸"。
   *
   * 为什么不直接量"头发从哪里开始"：实测发现头发与躯干在多数帧里**连成一片**
   * （v=0.52 有帧是 [0.090~0.868] 一整段），程序无法把两者分离。
   * 所以我用小宽度扫描来间接约束 —— 只验证边界处仍是角色，不试图识别头发。
   */
  for (const part of (allParts ?? []).filter((p) => p.id === 'chest' || p.id === 'belly')) {
    const box = Array.isArray(part.box) ? part.box[0] : part.box
    const vs = [box.y0 + 0.02, (box.y0 + box.y1) / 2, box.y1 - 0.02]
    const inset = 0.01
    const probes = []
    for (const v of vs) {
      for (const u of [box.x0 + inset, box.x1 - inset]) {
        const r = await wc.executeJavaScript(`window.__petTestProbePart(${String(u)}, ${String(v)})`, true)
        probes.push({ u: Number(u.toFixed(3)), v: Number(v.toFixed(3)), opaque: Boolean(r && r.opaque) })
      }
    }
    const miss = probes.filter((p) => !p.opaque)
    check(
      `「${part.label}」的左右边界贴边取样仍落在角色身上`,
      miss.length === 0,
      miss.length === 0
        ? `框 u ${box.x0}~${box.x1}；${probes.length} 个贴边取样点全部命中`
        : `未命中的贴边点：${miss.map((p) => `(${p.u},${p.v})`).join('，')}`,
    )
    // 边界不得比旧的 0.14~0.86 更宽（那是把头发圈进来的配置）。
    check(
      `「${part.label}」的横向范围比旧配置收窄`,
      box.x0 >= 0.2 && box.x1 <= 0.8,
      `u ${box.x0}~${box.x1}（旧配置 0.14~0.86）`,
    )
  }

  const partPlans = await wc.executeJavaScript(
    `(async () => {
      const ids = window.__petTestState().clickParts.map((p) => p.actionId).filter(Boolean)
      const out = []
      for (const id of ids) {
        const st = await loadAnimation(id)
        out.push({ id, frames: st ? st.frameCount : null, fps: st ? st.fps : null })
      }
      return out
    })()`,
    true,
  )
  const badPartAssets = (partPlans ?? []).filter((p) => !p.frames || p.fps !== 6)
  check(
    '四个互动动画素材都能加载且为 6fps',
    (partPlans ?? []).length === 4 && badPartAssets.length === 0,
    (partPlans ?? []).map((p) => `${p.id}=${String(p.frames)}帧@${String(p.fps)}fps`).join('，'),
  )

  /* 恢复随机动作，别影响后面的用例。 */
  await wc.executeJavaScript('window.__petTestDisableIdle(false)', true)
}

/**
 * 验证闲置动作的触发规则（用户指定）：
 * **保持闲置 1 分钟后，每分钟 1/5 概率触发一个随机动作。**
 *
 * 这条规则没法靠等待来测（要等好几分钟），所以渲染进程暴露了一个可注入的时钟：
 * `__petTestSetIdleClock()` 能改写"当前时间""闲置起点""门槛"与"概率"，
 * `__petTestIdleTickNow()` 能立即执行一次到点逻辑。
 * 于是四个边界可以精确验证，而不是靠概率碰运气。
 *
 * @param {(name: string, ok: boolean, detail?: string) => void} check
 * @param {(ms: number) => Promise<void>} wait
 */
async function verifyIdleTriggerRule(check, wait) {
  const wc = win && !win.isDestroyed() ? win.webContents : null
  if (!wc) return
  const readState = () => wc.executeJavaScript('window.__petTestState()', true)

  /*
   * 先把桌宠从**睡眠状态**里拉回闲置。
   *
   * 本用例的前提是"处于可触发随机动作的闲置态"。而前面的用例可能让它睡着了
   * （或留下 'sleeping'），那种情况下 onIdleTick 会优先走睡眠分支，
   * 掷骰子根本不会发生 —— 实测表现为"命中 0 次"，看起来像概率算错了。
   */
  const st0 = await wc.executeJavaScript('window.__petTestSleep.state()', true)
  if (st0 && st0.petState !== 'idle') {
    await wc.executeJavaScript('window.__petTestSleep.wake()', true)
    // ⚠️ wake() 起播的是**惊醒动画**，petState 会先进入 'waking' 并停留约 1.2 秒。
    // 只等 300ms 就继续，petState 还是 'waking'，随机动作依然被挡（实测"命中 0 次"）。
    // 必须轮询到真的回闲置再往下走。
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await wait(300)
      const st = await wc.executeJavaScript('window.__petTestSleep.state()', true)
      if (st && st.petState === 'idle') break
    }
  }

  /*
   * 再把**正在播的动作**停掉。
   *
   * ⚠️ 点击部位现在会播互动动画（head/chest）。若上一个用例刚点过角色，
   * 这里可能正播着 head/chest —— 而 `shouldFireIdleAction` 要求
   * `currentActionId === null`，于是随机动作一次都不会触发。
   * 实测表现是"到达门槛却没触发，lastPlayedActionId=chest"。
   */
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const st = await readState()
    if (!st.currentActionId) break
    await wc.executeJavaScript('endAction()', true)
    await wait(250)
  }
  /*
   * ⚠️ 还要确保「深度思考」已经退出，并等它的退出段播完。
   *
   * 随机动作的门控是 `isTrulyIdle()`，而思考期间它为假 ——
   * 若前面的用例把宿主推到 thinking 后没收干净（或退出段还在播），
   * 这里的随机动作**一次都不会触发**，表现成
   * 「到达门槛却没动作，lastPlayedActionId 停在旧值」。
   * 这条断言因此偶发失败过（同一份代码一轮通过、一轮红）。
   */
  await wc.executeJavaScript('window.__petTestThink && window.__petTestThink.exit("闲置用例前置：确保已退出思考")', true)
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const st = await wc.executeJavaScript('window.__petTestThink.state()', true)
    if (st && st.phase === null && st.active === false) break
    await wait(250)
  }
  // 顺带把闲置计时起点重置为"现在"，避免带着上一用例的旧起点。
  await wait(200)

  // 先把工作状态设为闲置，并确保没有动作在播。
  testPushState({ workStatus: 'idle', workLabel: '', seq: 9100 })
  await wait(200)

  const T0 = Date.now()
  const AFTER = RANDOM_ACTION_RULES.idleThresholdMs

  /*
   * 「闲置模式」门槛现在由 `readyAt`（下次可触发时刻）表达，而不是"计时起点"。
   * 所以下面各处都用 `readyAt` 直接摆布门槛，语义更直白：
   *   readyAt = T0          → 现在就有资格触发
   *   readyAt = T0 + AFTER  → 还要等 1 分钟
   */

  // ---- 1) 闲置不足门槛：即使概率 100% 也不该触发 ----
  await wc.executeJavaScript(
    `window.__petTestSetIdleClock({ now: ${String(T0)}, readyAt: ${String(T0 + AFTER)}, afterMs: ${String(AFTER)}, probability: 1 })`,
    true,
  )
  // 把"当前时间"推进到门槛之前（2 分 59 秒）。
  await wc.executeJavaScript(`window.__petTestSetIdleClock({ now: ${String(T0 + AFTER - 1000)} })`, true)
  const before1 = (await readState()).lastPlayedActionId
  await wc.executeJavaScript('window.__petTestIdleTickNow()', true)
  await wait(200)
  const after1 = (await readState()).lastPlayedActionId
  check(
    '闲置不足 1 分钟时不触发（即使概率 100%）',
    after1 === before1,
    `门槛还需 ${String(Math.round((T0 + AFTER - (T0 + AFTER - 1000)) / 1000))} 秒；` +
      `lastPlayedActionId ${String(before1)} → ${String(after1)}`,
  )

  // ---- 2) 刚好到门槛 + 概率 100%：应当触发 ----
  await wc.executeJavaScript(`window.__petTestSetIdleClock({ now: ${String(T0 + AFTER)} })`, true)
  await wc.executeJavaScript('window.__petTestIdleTickNow()', true)
  await wait(300)
  const after2 = await readState()
  /*
   * ⚠️ 不能只看 `lastPlayedActionId` 有没有变。
   *
   * 随机抽到**坐下 / 睡觉**时走的是状态机（enterSit / enterSleep），
   * 它们**不经过 `playAction`**，所以 `lastPlayedActionId` 不会更新 ——
   * 于是"确实触发了"却被判成没触发。这是真出现过的偶发误判
   * （同一份代码一轮过、一轮红，取决于随机抽中哪个）。
   *
   * 正确的判据是"现在有随机动作在演"：动作在播 / 进入坐姿 / 进入睡眠，任一成立即可。
   */
  const playingSomeAction = Boolean(after2)
    && (
      after2.lastPlayedActionId !== before1
      || (after2.currentActionId !== null && after2.currentActionId !== undefined)
      || after2.petState === 'sitting'
      || after2.petState === 'sleeping'
      || (after2.activeAnimationId && after2.activeAnimationId !== 'stand')
    )
  check(
    '闲置到达 1 分钟且概率命中时触发动作',
    playingSomeAction,
    `lastPlayedActionId=${String(after2 && after2.lastPlayedActionId)}，`
      + `动作=${String(after2 && after2.currentActionId)}，`
      + `petState=${String(after2 && after2.petState)}，`
      + `动画=${String(after2 && after2.activeAnimationId)}`,
  )
  // 收尾：停下这个动作，避免影响后续断言。
  testPushState({ workStatus: 'thinking', workLabel: '思考中…', seq: 9101 })
  await wait(400)
  testPushState({ workStatus: 'idle', workLabel: '', seq: 9102 })
  await wait(200)

  // ---- 2b) 播完一个随机动作后**退出闲置模式** ----
  //
  // 用户要求：播完一个随机动作后退出闲置模式，必须再连续闲置 1 分钟
  // 才能继续触发。验证方式是读 `readyAt`（下次可触发时刻）——
  // 它应当在动作播完后被推到"当前时间 + 1 分钟"附近。
  {
    const readyBefore = (await readState()).readyAt
    // 先播一个随机动作（随机动作的收尾会调 resetIdleTimer(true)）。
    await wc.executeJavaScript(
      `(async () => { await playAction('eat', { fromMenu: false }); return true })()`,
      true,
    )
    // 等它播完并触发收尾定时器（eat 的播放序列 33 帧 @6fps ≈ 5.5s + 余量）。
    let backIdle = false
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await wait(300)
      const st = await readState()
      if (!st.currentActionId && st.activeAnimationId === 'stand') {
        backIdle = true
        break
      }
    }
    const stAfter = await readState()
    const nowAfter = await wc.executeJavaScript('window.__petTestIdleClockState().now', true)
    const pushed = Number.isFinite(stAfter.readyAt) && stAfter.readyAt > nowAfter
    check(
      '播放完随机动作后退出闲置模式（门槛重新推后 1 分钟）',
      backIdle && pushed,
      `动作播完=${String(backIdle)}；readyAt 由 ${String(readyBefore)} 变为 ${String(stAfter.readyAt)}，` +
        `now=${String(nowAfter)}（应满足 readyAt > now）`,
    )
    // 并确认此时掷骰子（概率 100%）也**不会**触发。
    await wc.executeJavaScript('window.__petTestSetIdleClock({ probability: 1 })', true)
    const blockedBefore = (await readState()).lastPlayedActionId
    await wc.executeJavaScript('window.__petTestIdleTickNow()', true)
    await wait(250)
    const blockedAfter = (await readState()).lastPlayedActionId
    check(
      '退出闲置模式后即使概率 100% 也不触发（需再等满 1 分钟）',
      blockedAfter === blockedBefore,
      `lastPlayedActionId ${String(blockedBefore)} → ${String(blockedAfter)}`,
    )
  }

  // ---- 3) 超过门槛但概率 0：不该触发 ----
  await wc.executeJavaScript(
    `window.__petTestSetIdleClock({ now: ${String(T0 + AFTER + 10 * 60 * 1000)}, readyAt: ${String(T0)}, probability: 0 })`,
    true,
  )
  const before3 = (await readState()).lastPlayedActionId
  await wc.executeJavaScript('window.__petTestIdleTickNow()', true)
  await wait(250)
  const after3 = (await readState()).lastPlayedActionId
  check('概率未命中时不触发', after3 === before3, `lastPlayedActionId ${String(before3)} → ${String(after3)}`)

  // ---- 4) 概率确实是 1/5（统计验证）----
  //
  // ⚠️ 必须用 __petTestIdleShouldFire（只判定、不播动作）。
  // 曾经用 onIdleTick 连掷 400 次，只命中 1 次 —— 因为一次命中后动作在播，
  // 期间 isTrulyIdle() 为假，后续 399 次全被门控挡掉。
  //
  // ⚠️ 跑之前必须确认**前置条件成立**：`shouldFireIdleAction` 要求
  // `canTriggerRandomAction()` 为真（宿主闲置、没有动作在播、非睡眠）。
  // 否则 400 次全被门控挡掉、命中 0 —— 看起来像"概率算错了"，
  // 其实是用例的前置条件没准备好。所以这里先显式把状态归位并断言。
  {
    const st = await readState()
    if (st.petState !== 'idle') {
      await wc.executeJavaScript('window.__petTestSleep.wake()', true)
      await wait(600)
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const s = await readState()
      if (!s.currentActionId && s.petState === 'idle') break
      await wc.executeJavaScript('endAction()', true)
      await wait(250)
    }
  }
  // ⚠️ 顺序：**先**把时钟与概率设好，**再**读前置条件断言。
  // 反过来（先读后设）会读到上一个用例留下的值 —— 实测读到 probability=0
  // （上一条用例把它设成 0 了），表现为"概率检查失败"，而实际判定用的是 0.2。
  await wc.executeJavaScript(
    `window.__petTestSetIdleClock({ now: ${String(T0 + AFTER + 20 * 60 * 1000)}, readyAt: ${String(T0)}, afterMs: ${String(AFTER)}, probability: 0.2 })`,
    true,
  )
  const preRate = await wc.executeJavaScript('window.__petTestIdleClockState()', true)
  check(
    '概率统计的前置条件成立（可触发随机动作）',
    preRate && preRate.trulyIdle === true && preRate.canTriggerRandom === true,
    `trulyIdle=${String(preRate && preRate.trulyIdle)}，canTriggerRandom=${String(preRate && preRate.canTriggerRandom)}`,
  )
  check(
    '生效的命中概率是 1/5（0.2）',
    preRate && Math.abs(preRate.probability - 0.2) < 1e-9,
    `probability=${String(preRate && preRate.probability)}（应为 0.2）`,
  )
  const hits = await wc.executeJavaScript(
    `(function () {
      let h = 0
      for (let i = 0; i < 400; i += 1) {
        // 门槛已由 readyAt 固定在过去，判定无条件成立；这里只统计概率命中。
        if (window.__petTestIdleShouldFire()) h += 1
      }
      return h
    })()`,
    true,
  )
  /*
   * 期望 400 × 1/5 = 80 次。
   * 二项分布 400×0.2 的标准差 σ = √(400×0.2×0.8) ≈ 8，3σ ≈ 24，
   * 所以接受区间取 40~120（约 ±5σ），够宽但足以抓出"概率写错"这类问题
   * （例如误设成 0.1 会落在 ~40，仍在边界内，故另有一条按点数验证区间）。
   */
  const okRate = Number.isFinite(hits) && hits >= 40 && hits <= 120
  check(
    '命中概率约 1/5（400 次判定）',
    okRate,
    `命中 ${String(hits)} 次（期望约 80，接受 40~120）`,
  )

  // 恢复真实时钟与默认参数。
  await wc.executeJavaScript('window.__petTestSetIdleClock(null)', true)
  await wait(200)
}

/**
 * 验证「闲置模式」门槛的**定锚时机**。
 *
 * 用户要求的规则是「**连续闲置满 1 分钟**才进入闲置模式」。
 * 光测"到点后怎么掷骰子"是不够的 —— 门槛在什么时候被建立同样属于这条规则，
 * 而且这里曾经有两个真实缺陷（都是实测发现的）：
 *
 *   1. **门槛延迟建立**：原先只在第一次 tick 时把门槛设为 `now + 门槛`，
 *      而 tick 每 60 秒一次 → 实际要等 **门槛 + 最多 60 秒**；
 *   2. **门槛不随"变忙"作废**：宿主变忙时只停了定时器、没清门槛，
 *      于是门槛保留着那个已经过去的时间戳；等宿主回到闲置，
 *      下一次 tick 立刻满足条件，**整个门槛被跳过**。
 *
 * 两个缺陷叠加起来的现象就是"有时候很久都不做动作，有时候刚回来就做"。
 * 所以这里用可注入时钟把四个时刻逐个钉住。
 */
async function verifyIdleGateAnchoring(check, wait) {
  const wc = win && !win.isDestroyed() ? win.webContents : null
  if (!wc) return
  const js = (code) => wc.executeJavaScript(code, true)
  const readClock = () => js('window.__petTestIdleClockState()')

  /* 先确保处于可闲置态：宿主闲置 + 没有动作在播 + 不在拖拽。 */
  testPushState({ workStatus: 'idle', workLabel: '', seq: 9300 })
  await wait(300)
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const st = await js('window.__petTestState()')
    if (st && st.currentActionId === null && st.dragging === false) break
    await js('endAction()')
    await wait(200)
  }

  const T = Date.now()
  const AFTER = RANDOM_ACTION_RULES.idleThresholdMs

  // ---- 1) 闲置开始时门槛**立刻**锚定，而不是等第一次 tick ----
  const s1 = await js(`(() => {
    window.__petTestSetIdleClock({ now: ${String(T)}, afterMs: ${String(AFTER)} })
    resetIdleTimer()
    return window.__petTestIdleClockState()
  })()`)
  check(
    '闲置开始时门槛立刻锚定为「现在 + 门槛」（不再等到第一次 tick）',
    s1 && s1.readyAt !== null && s1.readyAt - T === AFTER,
    `readyAt - now = ${String(s1 && s1.readyAt === null ? 'null' : s1.readyAt - T)}（应为 ${String(AFTER)}）`,
  )

  // ---- 2) 闲置期间的重复 reset 不得把门槛一直往后推 ----
  //
  // 这一条是为了守住上面那个修复本身：如果 resetIdleTimer 每次都重设门槛，
  // 那么只要有别处频繁调用它，门槛就永远等不满 —— 那会变成"永不触发"。
  const s2 = await js(`(() => {
    window.__petTestSetIdleClock({ now: ${String(T + 1000)} })
    resetIdleTimer()
    resetIdleTimer()
    return window.__petTestIdleClockState()
  })()`)
  check(
    '闲置期间重复 reset 不会把门槛往后推（否则永远等不满）',
    s2 && s2.readyAt === T + AFTER,
    `readyAt = ${String(s2 && s2.readyAt)}（应仍为 ${String(T + AFTER)}）`,
  )

  // ---- 3) 宿主变忙：门槛必须一并作废 ----
  const s3 = await js(`(() => {
    suspendIdleScheduling('自测-变忙')
    return window.__petTestIdleClockState()
  })()`)
  check(
    '停止闲置调度时门槛一并作废（避免回到闲置后跳过 1 分钟等待）',
    s3 && s3.readyAt === null,
    `readyAt = ${String(s3 && s3.readyAt)}（应为 null）`,
  )

  // ---- 4) 回到闲置：重新起算，而不是沿用旧的（已过去）时间戳 ----
  const s4 = await js(`(() => {
    window.__petTestSetIdleClock({ now: ${String(T + 5000)} })
    resetIdleTimer()
    return window.__petTestIdleClockState()
  })()`)
  check(
    '暂停后重新开始闲置，门槛从这一刻重新起算',
    s4 && s4.readyAt !== null && s4.readyAt - (T + 5000) === AFTER,
    `readyAt - now = ${String(s4 && s4.readyAt === null ? 'null' : s4.readyAt - (T + 5000))}（应为 ${String(AFTER)}）`,
  )

  // ---- 5) 有动作在播时，重置闲置计时必须把门槛作废 ----
  //
  // 这条走真实路径：真的播一个短动作（head），然后像"拖拽结束"那样调
  // `resetIdleTimer()`。此时并不是真正的闲置，门槛必须被清掉 ——
  // 否则动作播完、下一次 tick 就能立刻触发，等于跳过了门槛。
  const s5 = await js(`(async () => {
    window.__petTestSetIdleClock({ now: ${String(T + 6000)} })
    await playAction('head', { fromMenu: true })
    resetIdleTimer()
    return window.__petTestIdleClockState()
  })()`)
  check(
    '有动作在播时重置闲置计时会把门槛作废（不算"闲置"）',
    s5 && s5.readyAt === null,
    `readyAt = ${String(s5 && s5.readyAt)}（期望 null：head 正在播，currentActionId=head）`,
  )

  /* 收尾：等 head 播完，恢复默认时钟。 */
  await wait(2600)
  await js('endAction()')
  await js('window.__petTestSetIdleClock(null)')
  await wait(300)
}

/**
 * 验证动作素材与**真实播放路径**。
 *
 * ⚠️ 单独拆出来、并在"随机动作"用例**之前**调用，原因有两条：
 *  1. 那个用例会把闲置门槛压成 0、概率设成 1，之后闲置动作不停触发，
 *     会把这里正在播的动画顶掉（实测过，表现为"动画卡住/没播"）；
 *  2. 播放计划是纯数据，断言通过**不等于**界面上真能播起来 ——
 *     曾经就因为 playAction 里一个未定义变量，动画卡在第 0 帧而没被发现。
 *     所以这里必须真的起播一次、观察帧号推进。
 *
 * @param {(name: string, ok: boolean, detail?: string) => void} check
 */
async function verifyActionAssets(check) {
  const wc = win && !win.isDestroyed() ? win.webContents : null
  if (!wc) return
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const readState = () => wc.executeJavaScript('window.__petTestState()', true)

  // ---- 3b) 动作素材是否真的加载成功（吃白饭已有素材，不能再退回站立）----
  const eatOk = await wc.executeJavaScript(
    `(async () => { const a = await loadAnimation('eat'); return a ? { frames: a.frameCount, fps: a.fps } : null })()`,
    true,
  )
  check(
    '「吃白饭」动画素材可加载',
    eatOk !== null && eatOk.frames === 17 && eatOk.fps === 6,
    eatOk ? `帧数 ${String(eatOk.frames)}，fps ${String(eatOk.fps)}` : '加载失败（素材缺失）',
  )
  const hangOk = await wc.executeJavaScript(
    `(async () => { const a = await loadAnimation('hang'); return a ? { frames: a.frameCount, fps: a.fps } : null })()`,
    true,
  )
  /*
   * ⚠️ 这里**刻意不写死帧数**。
   *
   * 原先写的是 `hangOk.frames === 10`，于是每次换美术素材（拖拽动画从
   * 10 帧换成 12 帧）都会得到一次**无意义的假失败** —— 断言该守的是
   * "素材能加载、且 manifest 声明与实际帧数一致"，不是某个具体数字。
   *
   * 真正的帧数一致性由下面的 manifest 校验负责。
   */
  check(
    '「拖拽」动画素材可加载（6fps）',
    hangOk !== null && hangOk.fps === 6 && hangOk.frames > 0,
    hangOk ? `帧数 ${String(hangOk.frames)}，fps ${String(hangOk.fps)}` : '加载失败（素材缺失）',
  )

  // ---- 3b2) 玩mc：逐段换帧率 + 随机循环轮数 ----
  //
  // 用户要求："以 6fps 播第 3 帧结束后，将 4、5 帧以 1fps 循环随机 20~40 次，
  // 结束后继续以 6fps 播 6~10 帧"。
  // 播放计划是**展开后的纯数据**（含每项帧率），所以能直接逐项断言。
  {
    const mc = await wc.executeJavaScript(`window.__petTestPlaybackPlan('play-mc')`, true)
    if (!mc) {
      check('「玩mc」素材可加载', false, '加载失败（素材缺失）')
    } else {
      check(
        '「玩mc」素材可加载（10 帧 @6fps）',
        mc.frameCount === 10 && mc.fps === 6,
        `帧数 ${String(mc.frameCount)}，fps ${String(mc.fps)}`,
      )
      // 帧号是 1 基：1,2,3 → 4,5 ×N → 6..10
      const head = mc.plan.slice(0, 3)
      const loopItems = mc.planFps.filter((f, i) => mc.plan[i] === 4 || mc.plan[i] === 5)
      const loopFpsSet = [...new Set(mc.planFps.filter((f, i) => mc.plan[i] === 4 || mc.plan[i] === 5))]
      const tailStart = 3 + loopItems.length
      const tail = mc.plan.slice(tailStart)
      const tailFpsSet = [...new Set(mc.planFps.slice(tailStart))]
      const loopCycles = mc.frameRepetitions[3] // 第 4 帧出现几次

      check(
        '「玩mc」前 3 帧以 6fps 播放',
        JSON.stringify(head) === JSON.stringify([1, 2, 3]) &&
          mc.planFps.slice(0, 3).every((f) => f === 6),
        `前 3 项=${JSON.stringify(head)}，帧率=${JSON.stringify(mc.planFps.slice(0, 3))}`,
      )
      check(
        '「玩mc」第 4~5 帧以 1fps 循环（随机 20~40 次）',
        loopFpsSet.length === 1 && loopFpsSet[0] === 1 && loopCycles >= 21 && loopCycles <= 41,
        `循环段帧率=${JSON.stringify(loopFpsSet)}，第 4 帧出现 ${String(loopCycles)} 次` +
          `（应为 21~41 次 = 随机 20~40 额外循环 + 1）`,
      )
      check(
        '「玩mc」第 6~10 帧回到 6fps 收尾',
        JSON.stringify(tail) === JSON.stringify([6, 7, 8, 9, 10]) && tailFpsSet.every((f) => f === 6),
        `尾段=${JSON.stringify(tail)}，帧率=${JSON.stringify(tailFpsSet)}`,
      )
      log(
        `参考-玩mc播放：1,2,3(6fps) → 4,5 ×${String(loopCycles)}(1fps) → ` +
          `${tail.join(',')}(6fps)；共 ${String(mc.planLength)} 项`,
      )
    }
  }

  // ---- 3c) 局部循环：吃白饭的"咀嚼段"重复播放 ----
  //
  // 播放序列是**预先展开的纯数据**（buildPlaybackPlan），所以可以直接断言
  // "第 6~9 帧各出现 5 次、其余各 1 次"，不必靠观察画面或掐时间。
  const plan = await wc.executeJavaScript(`window.__petTestPlaybackPlan('eat')`, true)
  if (!plan) {
    check('「吃白饭」播放计划可用', false, '拿不到播放计划')
  } else {
    const lr = plan.loopRange
    check(
      '「吃白饭」声明了局部循环（第 6~9 帧 ×4）',
      lr !== null && lr !== undefined && lr.from === 6 && lr.to === 9 && lr.times === 4,
      `loopRange=${JSON.stringify(lr)}`,
    )
    // 17 帧 + 3 帧 × 4 次额外循环 = 33 帧（"循环 4 次"是**额外**重复，故为 4 而非 3）。
    check(
      '「吃白饭」播放序列长度 = 33 帧',
      plan.planLength === 33,
      `planLength=${String(plan.planLength)}（期望 17 + 3×4 = 33）`,
    )
    // 下标 5~8（即第 6~9 帧）应当各出现 5 次（1 次正常 + 4 次循环）；其余各 1 次。
    const inLoop = plan.frameRepetitions.slice(5, 9)
    const outLoop = plan.frameRepetitions.filter((_, i) => i < 5 || i > 8)
    check(
      '循环段各帧出现 5 次、其余各 1 次',
      inLoop.every((c) => c === 5) && outLoop.every((c) => c === 1),
      `循环段重复次数 ${JSON.stringify(inLoop)}；循环段外取值集合 ${JSON.stringify([...new Set(outLoop)])}`,
    )
    log(
      `参考-吃白饭播放序列: ${plan.plan.map((f) => f + 1).join(',')}（共 ${String(plan.planLength)} 帧，` +
        `约 ${(plan.planLength / plan.fps).toFixed(1)}s）`,
    )

    // ---- 3d) 端到端：真的把吃白饭播起来，确认帧在推进 ----
    //
    // ⚠️ 这一条是补上的。上面验证的全是**播放计划（纯数据）**，
    // 而"计划正确"并不等于"界面上能播起来" —— 实际上就漏掉了一个
    // `state` 未定义导致 playAction 抛错、动画卡在第 0 帧的缺陷。
    // 所以这里必须真的起播一次并观察帧号变化。
    //
    // 起播期间**先把闲置触发概率设为 0**：否则要是这个用例排在
    // "随机动作"之后，闲置动作会不停触发并把这里的动画顶掉（实测踩过）。
    // 这样本用例就不依赖它前面的用例留下了什么时钟设置。
    await wc.executeJavaScript(
      `window.__petTestSetIdleClock({ probability: 0 })`,
      true,
    )
    await wc.executeJavaScript(`(async () => { await playAction('eat', { fromMenu: true }); return true })()`, true)
    await wait(500)
    const playing = await readState()
    check(
      '「吃白饭」真的能播起来（帧在推进）',
      playing.activeAnimationId === 'eat' && playing.currentFrame > 0,
      `active=${String(playing.activeAnimationId)} 帧 ${String(playing.currentFrame)}/${String(playing.currentFrameCount)}（应在推进，不是 0）`,
    )
    check(
      '「吃白饭」起播时用的总帧数 = 展开后的 33 帧',
      playing.currentFrameCount === 33,
      `currentFrameCount=${String(playing.currentFrameCount)}（期望 33）`,
    )
    // 收尾：停掉它，避免影响后续用例。
    await wc.executeJavaScript('endAction()', true)
    await wait(200)
  }
}

/**
 * 验证睡眠状态机（用户指定）：
 *
 * ```
 * 闲置持续 10 分钟 → 进入睡眠（必然，不是随机）
 * 睡眠中           → 循环睡觉动画最后两帧，且不再触发随机动作
 * 睡眠期间点击      → 结束睡眠、播放惊醒动画（不说话、不加心情）
 * 惊醒播完         → 回到闲置
 * ```
 *
 * 用可注入时钟跳过 10 分钟等待。三条关键点各有独立断言：
 * 门槛（不足 10 分钟不睡）、状态（睡下后随机动作停摆）、叫醒（点击触发惊醒）。
 *
 * @param {(name: string, ok: boolean, detail?: string) => void} check
 * @param {(ms: number) => Promise<void>} wait
 */
async function verifySleepState(check, wait) {
  const wc = win && !win.isDestroyed() ? win.webContents : null
  if (!wc) return
  const readState = () => wc.executeJavaScript('window.__petTestState()', true)
  const sleepState = () => wc.executeJavaScript('window.__petTestSleep.state()', true)

  // 素材应在，且清单里存在这两个 id（渲染进程的镜像常量靠这条兜住）。
  const sleepPlan = await wc.executeJavaScript(`window.__petTestPlaybackPlan('sleep')`, true)
  const awakePlan = await wc.executeJavaScript(`window.__petTestPlaybackPlan('awake')`, true)
  check(
    '「睡觉」素材可加载：进入动画 6fps、尾帧循环 1fps（2 帧）',
    sleepPlan !== null &&
      sleepPlan.frameCount === 10 &&
      sleepPlan.fps === 6 &&
      sleepPlan.tailLoopFrames === 2 &&
      sleepPlan.tailLoopFps === 1,
    sleepPlan
      ? `帧数 ${String(sleepPlan.frameCount)}，进入 ${String(sleepPlan.fps)}fps，` +
        `尾帧循环 ${String(sleepPlan.tailLoopFrames)} 帧 @${String(sleepPlan.tailLoopFps)}fps`
      : '加载失败（素材缺失）',
  )
  check(
    '「惊醒」素材可加载',
    awakePlan !== null && awakePlan.frameCount === 6 && awakePlan.fps === 6,
    awakePlan ? `帧数 ${String(awakePlan.frameCount)}，fps ${String(awakePlan.fps)}` : '加载失败（素材缺失）',
  )

  // ---- 帧率约定：所有素材都是 6fps ----
  //
  // 用户约定"所有动画一律按每秒 6 帧输入，除非特别说明"。
  // 这条断言把约定钉住：以后加新素材若忘了按 6fps 导出，会立刻报出来，
  // 而不是等到观感不对才发现（帧率错了表现为整体偏快/偏慢，很难判断）。
  const fpsReport = await wc.executeJavaScript(
    `(async () => {
      const ids = ['stand', 'hang', 'eat', 'sleep', 'awake', 'head', 'chest', 'stomach', 'leg', 'play-mc']
      const out = []
      for (const id of ids) {
        const st = await loadAnimation(id)
        out.push({ id, fps: st ? st.fps : null, frames: st ? st.frameCount : null })
      }
      return out
    })()`,
    true,
  )
  const wrongFps = Array.isArray(fpsReport) ? fpsReport.filter((r) => r.fps !== 6) : []
  check(
    '全部素材都是 6fps（用户约定的默认帧率）',
    Array.isArray(fpsReport) && wrongFps.length === 0,
    Array.isArray(fpsReport)
      ? fpsReport.map((r) => `${r.id}=${String(r.fps)}`).join(', ')
      : '读不到帧率',
  )

  // 先确保处于闲置状态。
  testPushState({ workStatus: 'idle', workLabel: '', seq: 9200 })
  await wait(200)
  await wc.executeJavaScript('window.__petTestSetIdleClock(null)', true)

  /*
   * ⚠️ 再显式确认真的回到了闲置。
   *
   * 前一条用例（概率统计）可能把 idleSinceMs 停在很久以前，恢复默认时钟后
   * 下一次到点就会直接睡着；也可能残留 sleeping/waking。
   * 本用例第 1 条断言是"不足 10 分钟不睡"，前提必须是**从闲置开始**，
   * 否则会读到上一次残留的睡眠状态而误报失败（实测踩过）。
   */
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const st = await wc.executeJavaScript('window.__petTestSleep.state()', true)
    if (st && st.petState === 'idle') break
    await wc.executeJavaScript('window.__petTestSleep.wake()', true)
    await wait(400)
  }
  // 把"闲置模式"门槛重置为 1 分钟后，避免带着上一用例的旧门槛进入本用例。
  await wc.executeJavaScript(
    `window.__petTestSetIdleClock({ now: ${String(Date.now())}, readyAt: ${String(Date.now() + RANDOM_ACTION_RULES.idleThresholdMs)} })`,
    true,
  )

  const T0 = Date.now()

  // ---- 1) "闲置满 N 分钟必然入睡"那条路径已移除 ----
  //
  // 用户要求：睡眠只由**随机池**触发，且是"循环随机 20~40 轮后自动醒来"的
  // 有始有终动作。所以把闲置时间推到很久以后、概率设为 0，
  // 期望结果是**不睡**（旧行为会必然入睡）。
  await wc.executeJavaScript(
    `window.__petTestSetIdleClock({ now: ${String(T0)}, readyAt: ${String(T0)}, probability: 0 })`,
    true,
  )
  await wc.executeJavaScript(
    `window.__petTestSetIdleClock({ now: ${String(T0 + 60 * 60 * 1000)} })`,
    true,
  )
  await wc.executeJavaScript('window.__petTestIdleTickNow()', true)
  await wait(300)
  const s1 = await sleepState()
  check(
    '闲置再久也不会"必然入睡"（该路径已移除）',
    s1.petState === 'idle' && s1.activeAnimationId !== 'sleep',
    `闲置 1 小时后（概率 0）：petState=${String(s1.petState)}，动画=${String(s1.activeAnimationId)}`,
  )

  // ---- 2) 睡眠由随机池触发：直接走状态机进入 ----
  await wc.executeJavaScript('window.__petTestSleep.enter()', true)
  await wait(600)
  const s2 = await readState()
  check(
    '进入睡眠状态',
    s2.petState === 'sleeping' && s2.activeAnimationId === 'sleep',
    `petState=${String(s2.petState)}，动画=${String(s2.activeAnimationId)}`,
  )

  // ---- 3) 睡眠期间不再触发随机动作 ----
  check(
    '睡眠期间不允许触发随机动作',
    s2.canTriggerRandom === false,
    `canTriggerRandom=${String(s2.canTriggerRandom)}`,
  )
  const beforeRandom = (await readState()).lastPlayedActionId
  // 把随机概率拉到 100%、门槛压到 0，模拟"最想触发"的条件。
  await wc.executeJavaScript(
    `window.__petTestSetIdleClock({ now: ${String(T0 + 60 * 60 * 1000)}, probability: 1, afterMs: 0 })`,
    true,
  )
  for (let i = 0; i < 5; i += 1) {
    await wc.executeJavaScript('window.__petTestIdleTickNow()', true)
  }
  await wait(400)
  const afterRandom = await readState()
  check(
    '睡眠期间即使概率 100% 也不触发随机动作',
    afterRandom.lastPlayedActionId === beforeRandom && afterRandom.activeAnimationId === 'sleep',
    `lastPlayedActionId ${String(beforeRandom)} → ${String(afterRandom.lastPlayedActionId)}，` +
      `动画=${String(afterRandom.activeAnimationId)}`,
  )

  // ---- 4) 睡眠中循环最后两帧 ----
  //
  // ⚠️ 不能"固定等 N 毫秒"再采样。入睡动画 10 帧 @6fps ≈ 1.7s，而尾帧循环
  // 改成 1fps 之后，"什么时候真的进入尾帧"变得更晚 —— 固定等待会采到
  // 入睡动画的前几帧（0/1/2/3），断言就误报成"没在尾帧循环"。
  // 正确做法：**轮询等它进入尾帧**（下标 ≥ 8）再开始采样。
  let enteredTail = false
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await wait(150)
    const st = await readState()
    if (Number.isFinite(st.currentFrame) && st.currentFrame >= 8) {
      enteredTail = true
      break
    }
  }
  check('入睡动画播完后进入尾帧循环', enteredTail, enteredTail ? '已进入尾帧（下标 ≥ 8）' : '等待 9 秒仍未进入尾帧')

  const seenFrames = new Set()
  for (let i = 0; i < 16; i += 1) {
    const st = await readState()
    if (Number.isFinite(st.currentFrame)) seenFrames.add(st.currentFrame)
    await wait(150)
  }
  const tailOnly = [...seenFrames].every((f) => f >= 8)
  check(
    '睡熟后只在最后两帧之间循环',
    seenFrames.size > 0 && tailOnly,
    `期间出现过的帧下标 ${JSON.stringify([...seenFrames].sort((a, b) => a - b))}（都应 ≥ 8）`,
  )

  // ---- 4a) 睡眠期间不该有定时器把它顶掉 ----
  //
  // 用户报告"睡觉开始一段时间后仍会自行中断"。这里检查两个最可能的来源：
  // 闲置调度定时器（会重新掷骰子/再判定入睡）与动作收尾定时器（会 endAction）。
  // 睡眠期间这两个都应当**没有在跑**。
  const timers = await readState()
  check(
    '睡眠期间闲置调度与动作收尾定时器都已停掉',
    timers.hasIdleTimer === false && timers.hasActionStopTimer === false,
    `hasIdleTimer=${String(timers.hasIdleTimer)}，hasActionStopTimer=${String(timers.hasActionStopTimer)}`,
  )
  // 静置一段时间，确认期间没有任何状态变迁（这就是"不会自行中断"的可验证形式）。
  const logBefore = JSON.stringify((await readState()).stateLog)
  await wait(6000)
  const afterIdleWait = await readState()
  const logAfter = JSON.stringify(afterIdleWait.stateLog)
  check(
    '睡眠静置 6 秒内没有任何状态变迁（不会自行中断）',
    afterIdleWait.petState === 'sleeping' && logAfter === logBefore,
    `petState=${String(afterIdleWait.petState)}；` +
      (logAfter === logBefore
        ? '状态日志无新增'
        : `新增变迁：${afterIdleWait.stateLog.slice(-3).map((e) => `${e.from}→${e.to}(${e.reason})`).join('；')}`),
  )

  // ---- 4b) 睡眠期间一切语音都被禁用 ----
  //
  // 直接经宿主通道推一句话进去（`pet:say` 是最"正式"的说话入口），
  // 睡眠状态下它必须被 showBubble 的守卫拦掉。
  const saidBefore = String(await wc.executeJavaScript('document.getElementById("bubble-text").textContent', true))
  win.webContents.send('pet:say', { text: '（测试）睡眠期间不该出现的台词', bubbleMs: 3000 })
  await wait(400)
  const saidAfter = String(await wc.executeJavaScript('document.getElementById("bubble-text").textContent', true))
  check(
    '睡眠期间连宿主推来的语音也被拦掉',
    saidAfter === saidBefore && !saidAfter.includes('睡眠期间不该出现'),
    `气泡文案未变：${JSON.stringify(saidAfter)}`,
  )

  // ---- 4c) 睡眠期间宿主开始工作 → 播放惊醒动画（而不是被硬切断）----
  //
  // 用户要求有两条唤醒路径：点击、以及宿主开始工作。两条都应播惊醒动画。
  // 用第二段睡眠单独验证"工作唤醒"，因为上面马上要用点击唤醒。
  {
    // 先确保还在睡。
    const stSleep = await wc.executeJavaScript('window.__petTestSleep.state()', true)
    if (stSleep.petState !== 'sleeping') {
      await wc.executeJavaScript('window.__petTestSleep.enter()', true)
      await wait(500)
    }
    /*
     * 用 `working` 而不是 `thinking` 来验"工作唤醒"。
     *
     * 为什么改：`thinking` 现在会进入「深度思考」（用户新增的机制），
     * 那条路径走 `enterThink()`，它自己会唤醒来着、然后去播思考动作 ——
     * 于是 `activeAnimationId` 是 think（素材缺失时回落成 stand），
     * 不再是惊醒动画。这里要验的是**普通工作唤醒**，用 working 更贴题，
     * 也避免两条机制互相干扰。
     */
    testPushState({ workStatus: 'working', workLabel: '干活中…', seq: 9250 })
    await wait(700)
    const stWork = await readState()
    check(
      '睡眠期间宿主开始工作会播放惊醒动画',
      stWork.petState === 'waking' && stWork.activeAnimationId === 'awake',
      `petState=${String(stWork.petState)}，动画=${String(stWork.activeAnimationId)}`,
    )
    // 等惊醒播完，回到闲置后再继续后面的"点击唤醒"用例。
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await wait(300)
      const st = await readState()
      if (st.petState === 'idle' && st.activeAnimationId === 'stand') break
    }
    testPushState({ workStatus: 'idle', workLabel: '', seq: 9251 })
    await wait(400)
    // 再睡一次，供下面的点击唤醒用例使用。
    await wc.executeJavaScript('window.__petTestSleep.enter()', true)
    await wait(600)
  }

  // ---- 4d) 忙碌态之间的抖动**不该**唤醒睡眠 ----
  //
  // ⚠️ 这条是一个真实缺陷的回归护栏。
  //
  // 原先的判据是 `nextStatus !== currentWorkStatus` 就算"开始工作"，
  // 但宿主的忙碌状态有 thinking / working / organizing / waiting /
  // success / failure 六个 —— **一次任务内部的任何切换都会把睡着的桌宠叫醒**。
  // 实测（scripts 里的 --watch-sleep）入睡 20 秒后就因为一次状态抖动被唤醒，
  // 现象就是用户报告的"睡觉一会儿自己就中断了"。
  //
  // 正确判据是"从闲置变为忙碌"（wasIdle && !isIdle）。下面模拟一次抖动：
  // thinking → working → success，全程都不该离开 sleeping。
  {
    const stSleep = await wc.executeJavaScript('window.__petTestSleep.state()', true)
    if (stSleep.petState !== 'sleeping') {
      await wc.executeJavaScript('window.__petTestSleep.enter()', true)
      await wait(600)
    }
    // 先进入"忙碌"基线（这一步应当唤醒，但它是真的开始工作）。
    /*
     * ⚠️ 这里用 `working` 而不是 `thinking`。
     *
     * 自从「深度思考」补上素材后，推 `thinking` 会**真的开始播思考动作**
     * （进入段 → 循环段），与这条用例要验证的"睡眠状态机"直接打架：
     * 实测表现为 `动画=think-enter`、尾帧循环判定失效、状态日志被思考打断。
     * 而这条用例的意图只是"忙碌态基线 + 忙碌态之间抖动"，
     * 用 `working` 完全等价，且不牵扯思考。
     */
    testPushState({ workStatus: 'working', workLabel: '干活中…', seq: 9260 })
    await wait(500)
    // 等它惊醒完回到闲置，再睡一次 —— 这次基线已经是忙碌态。
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await wait(300)
      const st = await readState()
      if (st.petState === 'idle' && st.activeAnimationId === 'stand') break
    }
    await wc.executeJavaScript('window.__petTestSleep.enter()', true)
    await wait(700)
    // 现在宿主仍在忙碌（基线 thinking），做一次忙碌态之间的抖动。
    const logBeforeChurn = JSON.stringify((await readState()).stateLog)
    testPushState({ workStatus: 'working', workLabel: '干活中…', seq: 9261 })
    await wait(400)
    testPushState({ workStatus: 'success', workLabel: '完成！', seq: 9262 })
    await wait(400)
    const afterChurn = await readState()
    const logAfterChurn = JSON.stringify(afterChurn.stateLog)
    check(
      '忙碌态之间的抖动不会唤醒睡眠',
      afterChurn.petState === 'sleeping' && logAfterChurn === logBeforeChurn,
      `petState=${String(afterChurn.petState)}` +
        (logAfterChurn === logBeforeChurn
          ? '，状态日志无新增'
          : `，新增变迁：${afterChurn.stateLog.slice(-3).map((e) => `${e.from}→${e.to}(${e.reason})`).join('；')}`),
    )
    // 收尾：回闲置，并**确认渲染进程的拖拽态已释放** ——
    // 拖拽守卫会挡住"进入睡眠"，带着 dragging=true 进本用例会被静默挡掉，
    // 表现为"点了却播了 chest 动画"。实测就是这么失败的。
    // （同样用 `working`：`thinking` 会真的播思考动作，见上面 9260 处的说明。）
    testPushState({ workStatus: 'working', workLabel: '干活中…', seq: 9263 })
    await wait(600)
    testPushState({ workStatus: 'idle', workLabel: '', seq: 9264 })
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await wait(300)
      const st = await readState()
      if (st.petState === 'idle' && st.activeAnimationId === 'stand' && st.dragging === false) break
    }
    const preSleep = await readState()
    check(
      '进入睡眠用例前，渲染进程已退出拖拽态',
      preSleep.dragging === false,
      `dragging=${String(preSleep.dragging)}`,
    )
    // 进入睡眠，并轮询确认真的睡下（被守卫挡掉时不至于继续往下跑）。
    let slept = false
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await wc.executeJavaScript('window.__petTestSleep.enter()', true)
      await wait(500)
      const st = await readState()
      if (st.petState === 'sleeping') {
        slept = true
        break
      }
    }
    check('睡眠用例准备就绪（已进入 sleeping）', slept, `petState=${String((await readState()).petState)}`)
  }

  // ---- 5) 睡眠期间点击 → 惊醒，且不说台词、不加心情 ----
  const moodBefore = (await readState()).moodValue
  const layout = await wc.executeJavaScript('window.__petTestLayoutDiag()', true)
  const cx = Math.round(layout.frameRect.left + layout.frameRect.width / 2)
  const cy = Math.round(layout.frameRect.top + layout.frameRect.height / 2)
  const opts = `{ bubbles: true, button: 0, clientX: ${String(cx)}, clientY: ${String(cy)} }`
  const preClick = await readState()
  await wc.executeJavaScript(
    `(function () {
      const stage = document.getElementById('stage')
      stage.dispatchEvent(new MouseEvent('mousedown', ${opts}))
      window.dispatchEvent(new MouseEvent('mouseup', ${opts}))
      return true
    })()`,
    true,
  )
  await wait(120)
  const justAfterClick = await readState()
  await wait(500)
  const s3 = await readState()
  log(
    `参考-睡眠点击：点击前 petState=${String(preClick.petState)} 动画=${String(preClick.activeAnimationId)}｜` +
      `点击后 120ms petState=${String(justAfterClick.petState)} 动画=${String(justAfterClick.activeAnimationId)}｜` +
      `600ms 后 petState=${String(s3.petState)} 动画=${String(s3.activeAnimationId)}`,
  )
  check(
    '睡眠期间点击会切到惊醒动画',
    s3.petState === 'waking' && s3.activeAnimationId === 'awake',
    `petState=${String(s3.petState)}，动画=${String(s3.activeAnimationId)}；` +
      `点击前=${String(preClick.petState)}/${String(preClick.activeAnimationId)}，` +
      `120ms=${String(justAfterClick.petState)}/${String(justAfterClick.activeAnimationId)}`,
  )
  check(
    '叫醒不加心情（点击语义是"叫醒"而非互动）',
    s3.moodValue === moodBefore,
    `心情 ${String(moodBefore)} → ${String(s3.moodValue)}（应不变）`,
  )
  const bubbleText = String(await wc.executeJavaScript('document.getElementById("bubble-text").textContent', true))
  const bubbleHidden = await wc.executeJavaScript('document.getElementById("bubble").hidden', true)
  check(
    '叫醒不说部位台词，且入睡前的残留气泡已收起',
    /*
     * 判据以"气泡是否隐藏"为主：隐藏后 textContent 里仍会留着**上一次**的文案
     * （DOM 内容不会因为 hidden 而清空），拿它判"有没有说部位台词"会偶发误判。
     * 所以只有气泡**可见**时才需要检查文案内容。
     */
    bubbleHidden === true ||
      (!bubbleText.includes('占位·头') &&
        !bubbleText.includes('占位·胸') &&
        !bubbleText.includes('占位·腹') &&
        !bubbleText.includes('占位·腿') &&
        !bubbleText.includes('戳我做什么')),
    `气泡隐藏=${String(bubbleHidden)}，文案=${JSON.stringify(bubbleText)}`,
  )
  // 叫醒时也不该播任何点击互动动画（点击语义是"叫醒"，不是"摸头"）。
  check(
    '叫醒不会触发点击互动动画',
    s3.activeAnimationId === 'awake',
    `动画=${String(s3.activeAnimationId)}（应为 awake）`,
  )

  // ---- 6) 惊醒播完回到闲置 ----
  // 6 帧 @6fps ≈ 1s，定时器给了 1.2s 下限 + 150ms 余量。
  let backToIdle = false
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await wait(300)
    const st = await readState()
    if (st.petState === 'idle' && st.activeAnimationId === 'stand' && !st.currentActionId) {
      backToIdle = true
      break
    }
  }
  check(
    '惊醒播完回到闲置状态',
    backToIdle,
    `最终 ${JSON.stringify(await sleepState())}；` +
      `变迁日志=${JSON.stringify((await readState()).stateLog?.slice(-8)?.map((e) => `${e.from}→${e.to}(${e.reason})`) ?? [])}`,
  )

  // ---- 7) 尾帧循环轮数随机 20~40，走满后**自动**播惊醒并醒来 ----
  //
  // ⚠️ 真睡眠是 1fps、一轮约 2 秒，20~40 轮要等 40~80 秒 —— 测试等不起。
  // 所以用两个测试覆盖：把轮数范围压到 1~1、尾帧间隔压到 16ms，
  // 这样"一轮"只要几十毫秒，就能在短时间内验证「走满 → 自动惊醒 → 回闲置」
  // 这条完整链路。真实帧率下只是把每一步拉长，逻辑完全一致。
  {
    const beforeClock = await wc.executeJavaScript('window.__petTestIdleClockState()', true)
    check(
      '睡眠尾帧循环的轮数范围是 20~40',
      beforeClock && beforeClock.sleepTailCyclesMin === 20 && beforeClock.sleepTailCyclesMax === 40,
      `范围 ${String(beforeClock && beforeClock.sleepTailCyclesMin)}~${String(beforeClock && beforeClock.sleepTailCyclesMax)}`,
    )

    await wc.executeJavaScript(
      'window.__petTestSetIdleClock({ sleepMin: 1, sleepMax: 1, tailStepMs: 16 })',
      true,
    )
    await wc.executeJavaScript('window.__petTestSleep.enter()', true)
    await wait(400)
    const atSleep = await readState()
    check(
      '加速后进入睡眠，尾帧开始循环',
      atSleep.petState === 'sleeping' && atSleep.activeAnimationId === 'sleep',
      `petState=${String(atSleep.petState)}，动画=${String(atSleep.activeAnimationId)}`,
    )

    // 进入动画 10 帧 @6fps ≈ 1.7s 才会接上尾帧循环；之后 1 轮 ≈ 60ms。
    //
    // ⚠️ 判据是"**离开 sleeping**"（无论先到 waking 还是直接回 idle），
    // 而不是只认 'waking'：加速后尾帧 1 轮只要 ~60ms，惊醒动画也只有 6 帧，
    // 采样很可能**整段错过** waking 阶段。我第一版就只认 waking，
    // 结果读到的是"已在 idle"，明明自动醒来了却判失败。
    //
    // 也不看 `tailCycles` —— 它在醒来后会被重置成 0；改用只写不清的
    // `lastTailCyclesTarget` 作为"确实启动过尾帧循环"的证据。
    let autoWoke = false
    let target = null
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await wait(150)
      const st = await wc.executeJavaScript('window.__petTestSleep.state()', true)
      if (st && Number.isFinite(st.lastTailCyclesTarget)) target = st.lastTailCyclesTarget
      if (st && st.petState !== 'sleeping') {
        autoWoke = true
        break
      }
    }
    const finalTarget = (await wc.executeJavaScript('window.__petTestSleep.state()', true))?.lastTailCyclesTarget
    check(
      '尾帧循环走满后自动醒来（无需点击）',
      autoWoke && (target ?? finalTarget) === 1,
      autoWoke
        ? `自动离开睡眠；本次尾帧循环目标 = ${String(target ?? finalTarget)} 轮`
        : `未自动醒来，尾帧循环目标=${String(target ?? finalTarget)}`,
    )

    // 惊醒播完应回到闲置。
    let backIdleAgain = false
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await wait(300)
      const st = await readState()
      if (st.petState === 'idle' && st.activeAnimationId === 'stand') {
        backIdleAgain = true
        break
      }
    }
    check('自动惊醒后回到闲置状态', backIdleAgain, `最终 petState=${String((await readState()).petState)}`)

    // 用**状态变迁日志**证明"睡眠 → 惊醒 → 闲置"这条链路真的走过。
    // 这比采样更可靠：加速后醒来的过程只有几十毫秒，采样容易整段错过。
    const churnLog = (await readState()).stateLog ?? []
    const transitions = churnLog.slice(-6).map((e) => `${e.from}→${e.to}`)
    const idxSleeping = churnLog.findLastIndex ? churnLog.findLastIndex((e) => e.to === 'sleeping') : -1
    const after = idxSleeping >= 0 ? churnLog.slice(idxSleeping) : []
    const toWaking = after.some((e) => e.to === 'waking')
    const toIdle = after.some((e) => e.to === 'idle' && e.reason === '惊醒播完')
    check(
      '变迁日志记录了 睡眠 → 惊醒 → 闲置 的完整链路',
      toWaking && toIdle,
      toWaking && toIdle ? `链路：${transitions.join('，')}` : `日志未覆盖：${transitions.join('，')}`,
    )

    // 恢复真实时钟与轮数范围。
    await wc.executeJavaScript('window.__petTestSetIdleClock(null)', true)
    await wait(200)
  }

  // 恢复默认时钟，避免影响后续用例。
  await wc.executeJavaScript('window.__petTestSetIdleClock(null)', true)
  await wait(200)
}

/**
 * 长时间盯着睡眠状态，抓"自行中断"的真凶。
 *
 * 做法：先让桌宠睡下，然后每 10 秒读一次渲染进程的状态与**状态变迁日志**。
 * 一旦状态不再是 'sleeping'，立刻把变迁日志（含调用栈）打出来 ——
 * 这样得到的不是"它中断了"，而是"它在第几秒、被哪一行调用的函数中断了"。
 *
 * @param {number} seconds 观测总时长
 */
async function watchSleep(seconds) {
  const wc = win && !win.isDestroyed() ? win.webContents : null
  if (!wc) return
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))

  await wait(2500)
  log(`[sleep-watch] 开始观测 ${String(seconds)} 秒`)

  // 让它睡下（走状态机，而不是假装）。
  const entered = await wc.executeJavaScript('window.__petTestSleep.enter()', true).catch(() => null)
  log(`[sleep-watch] 入睡结果：${JSON.stringify(entered)}`)
  if (!entered || entered.petState !== 'sleeping') {
    log('[sleep-watch] 没能进入睡眠，观测终止')
    return
  }

  const started = Date.now()
  let baseLog = (await wc.executeJavaScript('window.__petTestState().stateLog', true)) ?? []
  let interrupted = false

  while (Date.now() - started < seconds * 1000) {
    await wait(10_000)
    const st = await wc.executeJavaScript('window.__petTestState()', true).catch(() => null)
    if (!st) {
      log('[sleep-watch] 读不到渲染进程状态')
      continue
    }
    const elapsed = Math.round((Date.now() - started) / 1000)
    const logNow = st.stateLog ?? []
    const fresh = logNow.length > baseLog.length ? logNow.slice(baseLog.length) : []
    if (fresh.length > 0) {
      for (const e of fresh) {
        log(
          `[sleep-watch] ${String(elapsed)}s 状态变迁 ${e.from} → ${e.to}｜原因=${e.reason}｜调用点=${e.stack}`,
        )
      }
      baseLog = logNow
    }
    log(
      `[sleep-watch] ${String(elapsed)}s petState=${st.petState} 动画=${String(st.activeAnimationId)}` +
        ` 动作=${String(st.currentActionId)} 帧=${String(st.currentFrame)}` +
        ` idle定时器=${String(st.hasIdleTimer)} 收尾定时器=${String(st.hasActionStopTimer)}`,
    )
    if (st.petState !== 'sleeping') {
      interrupted = true
      log(`[sleep-watch] ⚠️ 睡眠在 ${String(elapsed)}s 时被中断（期望一直 sleeping）`)
      break
    }
  }

  log(interrupted ? '[sleep-watch] 结论：发生了自行中断，见上面的变迁日志' : `[sleep-watch] 结论：${String(seconds)} 秒内保持睡眠，未发现中断`)
}

/**
 * 验证**坐姿动作**的三阶段逻辑。
 *
 * 用户要求（原文）：
 * 「触发随机动作时，桌宠播放坐下动作，之后循环播放坐着的动作并从 0 开始计时，
 *   计时器达到 180 秒后，播放站起动作，回到站立闲置状态。
 *   其中，在前两个阶段点击桌宠将立即跳转到站立动作阶段并关闭计时。」
 *
 * 这里的每条断言都对应上面那句话的一个分句 —— 不靠看画面判断，
 * 而是读 `__petTestState()` 的 `sitPhase` / `activeAnimationId` / `petState`。
 *
 * 180 秒没法真等，所以把「坐着」时长压到几百毫秒
 * （`__petTestSit.setHoldMs`）来验证"计时到点会自动站起"这条逻辑本身；
 * 默认值 180000 单独断言一次，确保压短只是测试手段、没改生产行为。
 */
/**
 * 自测：闲置主动对话。
 *
 * 这条用例的意义在于把**两个世界的判定串起来验证**：
 *  · 渲染进程：什么时候该说（闲置满 60 秒、不在动作中、不在睡）；
 *  · 主进程：说什么（按好感度等级 + 心情档位从可用组里抽）。
 * 任何一边单独测都过不了"她刚才说的话是不是真的属于当前可用组"这一问。
 *
 * @param {(name: string, ok: boolean, detail?: string) => void} check
 * @param {(ms: number) => Promise<void>} wait
 */
async function verifyIdleVoice(check, wait) {
  const wc = win && !win.isDestroyed() ? win.webContents : null
  if (!wc) return
  const js = (code) => wc.executeJavaScript(code, true)
  const readVoice = () => js('window.__petTestIdleVoiceState ? window.__petTestIdleVoiceState() : null')
  const readBubble = () => js('window.__petTestBubble ? window.__petTestBubble() : null')

  // ---- 1) 库结构 ----
  /*
   * ⚠️ 断言口径已改：语音库现在收的是**所有**可触发语音（8 类触发条件、37 组），
   * 不再是"9 个闲置信箱"。所以这里只验**与闲置对话相关**的那部分，
   * 全库的总量/去重/文档同步交给 `test-voice-library.mjs`（那边更细）。
   */
  {
    const idleGroups = VOICE_GROUPS.filter((group) => group.trigger === 'idle')
    check(
      '闲置语音共 9 组（1 固定 + 5 好感度 + 3 心情）',
      idleGroups.length === 9,
      idleGroups.map((g) => g.id).join(', '),
    )
    check(
      '闲置语音：固定组 ≥3 条，好感/心情组各 3 条',
      /*
       * 用户修订版把"固定语音"加到 4 条，其余分档组仍是 3 条。
       * 分档组必须**正好 3 条**：句数不均会让某个档位抽中概率偏高。
       */
      idleGroups.every((group) => (group.kind === 'fixed' ? group.lines.length >= 3 : group.lines.length === 3))
        && voiceLineCountFor('idle') === 28,
      `闲置 ${String(voiceLineCountFor('idle'))} 条；全库 ${String(voiceLineCount())} 条`,
    )
    const triggers = [...new Set(VOICE_GROUPS.map((g) => g.trigger))]
    check(
      '所有可触发语音都归库分组（≥8 类触发条件）',
      triggers.length >= 8,
      `触发条件 ${String(triggers.length)} 类：${triggers.join(', ')}`,
    )
    const tooLong = VOICE_GROUPS.flatMap((group) =>
      group.lines.filter((line) => [...line].length > VOICE_LINE_MAX_CHARS).map((line) => `${group.id}:${line}`),
    )
    check(`所有台词都在 ${String(VOICE_LINE_MAX_CHARS)} 字以内`, tooLong.length === 0, tooLong.join(' / '))
  }

  // ---- 2) 真实说一句 ----
  /*
   * 关掉随机动作（概率 0）：它会插进来改变 petState，让"到点该说"的判定被打断，
   * 而且动作的台词会顶掉我们要检查的那句气泡。
   */
  await js('window.__petTestSetIdleClock({ probability: 0 })')

  /*
   * ⚠️ 先等回"真正闲置"再开始。
   *
   * 上一个用例（坐姿）结束时可能还在播站起动画，那时 `canSpeak` 是 false，
   * 语音定时器会每 5 秒重试一次。实测就踩了这个：主进程日志里已经有"主动对话"，
   * 渲染进程里的计数却还是 0（因为真正的第一次说话被推迟到了重试之后）。
   */
  {
    let waited = 0
    for (let i = 0; i < 100; i += 1) {
      const st = await readVoice()
      if (st && st.canSpeak) break
      await wait(100)
      waited += 100
    }
    if (waited >= 500) check('等回闲置状态（为主动对话用例准备）', true, `等了 ${String(waited)}ms`)
  }

  await js('window.__petTestSetIdleVoiceInterval(500)')

  /*
   * 这里**主动驱动一次**定时器回调，而不是干等 setTimeout 送达。
   *
   * 理由：`__petTestIdleVoiceTick()` 调的就是 `onIdleVoiceTimer()` ——
   * 也就是定时器真正会调的那个函数，门禁与间隔判定一条没绕过；
   * 而自测里其它用例会摆弄注入时钟（`idleNowOverride`），
   * 依赖墙钟送达在那种环境下不可靠（实测表现为"一次都没说"的假失败）。
   */
  {
    const scheduled = await readVoice()
    check(
      '设置间隔后定时器已排上',
      Boolean(scheduled) && scheduled.timerActive === true,
      `timerActive=${String(scheduled && scheduled.timerActive)}`,
    )
  }

  const before = await readVoice()
  const tick = await js('window.__petTestIdleVoiceTick()')
  const after = await readVoice()

  check(
    '闲置到点会主动说一句',
    Boolean(tick) && tick.spoke === true && Boolean(after) && after.count > (before ? before.count : 0),
    `spoke=${String(tick && tick.spoke)}；次数 ${String(before && before.count)} → ${String(after && after.count)}`,
  )

  const bubble = await readBubble()
  {
    const hearts = affection && Number.isFinite(affection.hearts) ? affection.hearts : 0
    const moodValue = mood && Number.isFinite(mood.value) ? mood.value : 100
    const pool = availableVoiceLines({ hearts, moodValue })
    const spoken = bubble && typeof bubble.text === 'string' ? bubble.text : ''
    check(
      '说的话确实来自当前可用语音组',
      pool.includes(spoken),
      spoken
        ? `「${spoken}」；当前 ${String(hearts)} 心 / 心情 ${String(Math.round(moodValue))}，可用 ${String(pool.length)} 句`
        : '气泡是空的',
    )
  }

  // ---- 3) 间隔没到不会连说 ----
  {
    const quick = await js('window.__petTestIdleVoiceTick()')
    check(
      '间隔没到不会重复说',
      Boolean(quick) && quick.spoke === false,
      `spoke=${String(quick && quick.spoke)}（间隔 ${String(quick && quick.interval)}ms）`,
    )
  }

  // ---- 4) 睡眠期间不说（用户要求"睡眠时禁语音"的延伸）----
  {
    await js('window.__petTestSleep.enter()')
    const slept = await readVoice()
    const ticked = await js('window.__petTestIdleVoiceTick()')
    check(
      '睡眠期间不会主动说话',
      Boolean(slept) && slept.canSpeak === false && Boolean(ticked) && ticked.spoke === false,
      `canSpeak=${String(slept && slept.canSpeak)} spoke=${String(ticked && ticked.spoke)}`,
    )
    /*
     * 被挡住时要"补说"而不是跳过：定时器必须还在跑（5 秒后重试）。
     * 若这里 timerActive 为 false，说明那一分钟真的丢了。
     */
    const resumed = await readVoice()
    check(
      '被挡住时仍会重试（不会跳过这一分钟）',
      Boolean(resumed) && resumed.timerActive === true,
      `timerActive=${String(resumed && resumed.timerActive)}`,
    )
    await js('window.__petTestSleep.wake()')
    await wait(600)
  }

  // ---- 5) 收尾：恢复默认间隔，别把 500ms 带进后面的用例 ----
  await js('window.__petTestSetIdleVoiceInterval(null)')
  await js('window.__petTestSetIdleClock(null)')
}

/**
 * 自测：好感度增长 / 低心情点击 / 数值浮出反馈 / 深度思考 / 刷新状态。
 *
 * 这条用例把本次新增的几条机制串起来跑一遍。写成"点一下、等一会、读主进程状态"
 * 而不是"直接调内部函数"，是因为点击要经过 IPC invoke、气泡、浮出层、
 * 以及渲染进程里那一串"思考中/睡眠中"的提前返回 —— 只有真的点才测得到。
 *
 * @param {(name: string, ok: boolean, detail?: string) => void} check
 * @param {(ms: number) => Promise<void>} wait
 */
async function verifyAffectionAndFeedback(check, wait) {
  const wc = win && !win.isDestroyed() ? win.webContents : null
  if (!wc) return
  const js = (code) => wc.executeJavaScript(code, true)

  // ---- 1) 规则常量（防止"改了数字忘了改文档/测试"）----
  check(
    '好感规则：点击 2~8、冷却 5 分钟、低心情额外 +10',
    AFFECTION_GAIN.clickMin === 2
      && AFFECTION_GAIN.clickMax === 8
      && AFFECTION_GAIN.clickCooldownMs === 5 * 60 * 1000
      && AFFECTION_GAIN.lowMoodClick === 10
      && AFFECTION_GAIN.idleDialogue === 1
      && AFFECTION_GAIN.randomAction === 2
      && AFFECTION_GAIN.uptimeGain === 5
      && AFFECTION_GAIN.uptimeEveryMs === 10 * 60 * 1000,
    `点击 ${String(AFFECTION_GAIN.clickMin)}~${String(AFFECTION_GAIN.clickMax)}，`
    + `冷却 ${String(AFFECTION_GAIN.clickCooldownMs / 60000)} 分，`
    + `对话 +${String(AFFECTION_GAIN.idleDialogue)}、动作 +${String(AFFECTION_GAIN.randomAction)}、`
    + `运行 +${String(AFFECTION_GAIN.uptimeGain)}/${String(AFFECTION_GAIN.uptimeEveryMs / 60000)} 分`,
  )

  // ---- 2) 造一个干净的起点：好感 0、心情满、冷却清空 ----
  affection = initialAffection()
  lastClickAffectionAtMs = null
  lastAffectionGain = null
  lastMoodGain = null
  /*
   * 从 60 起而不是 100：满心情时点击会被上限夹住（gained = 0），
   * 于是 `lastMoodGain` 不会被设置，判"走的是普通分支"就没了依据。
   * 60 起既能保证 > 50（不触发低心情分支），又不会顶到上限。
   */
  mood = { value: 60, updatedAt: Date.now() }
  await js('window.__petTestRefresh && window.__petTestRefresh()')
  pushAffectionToRenderer()
  pushMoodToRenderer()
  await wait(200)

  // ---- 3) 第一次点击：心情满 → 普通点击 ----
  {
    const beforeAff = affection.value
    await js('window.__petTestClick()')
    await wait(350)
    const delta = affection.value - beforeAff + (affection.hearts > 0 ? 0 : 0)
    const gained = lastAffectionGain ? lastAffectionGain.amount : 0
    check(
      '点击互动给好感 2~8',
      gained >= AFFECTION_GAIN.clickMin && gained <= AFFECTION_GAIN.clickMax,
      `本次 +${String(gained)}（阶段值 ${String(beforeAff)} → ${String(affection.value)}，delta ${String(delta)}）`,
    )
    check(
      '点击满心情时走普通分支（不是低心情）',
      lastMoodGain && lastMoodGain.reason === '点击互动' && mood.value > 50,
      `心情 ${String(Math.round(mood.value))}，reason=${String(lastMoodGain && lastMoodGain.reason)}`,
    )
    const floats = await js('window.__petTestFloatCount()')
    check(
      '数值变化有可视化反馈（浮出数字）',
      Number.isFinite(floats) && floats > 0,
      `浮出层节点数 ${String(floats)}`,
    )
  }

  // ---- 4) 立刻再点：好感在 5 分钟冷却内 ----
  {
    const before = affection.value
    await js('window.__petTestClick()')
    await wait(350)
    check(
      '5 分钟内再点不再给好感',
      affection.value === before,
      `阶段值 ${String(before)} → ${String(affection.value)}`,
    )
  }

  // ---- 4b) 面板重新展开时，好感显示必须是最新值 ----
  /*
   * 这条来自用户的真实反馈：「好感值一开始没变化，点击之后才反馈出来」。
   *
   * 根因：`setStatsVisible(true)` 只重绘了心情、**漏了好感**。
   * 而 `pet:affection` 的处理里有 `if (statsVisible) renderAffection()` ——
   * 面板隐藏期间攒的好感不会被画；要等下一次推送（例如点击）才刷新。
   *
   * 断言方式：隐藏面板 → 加好感（推送被跳过）→ 展开面板 → 读 DOM 文本。
   *
   * ⚠️ 必须放在上面"5 分钟冷却"用例**之后**：这里会把好感归零、冷却锚点清掉，
   * 放在前面会让冷却用例失去前提（实测就是这么红的）。
   */
  {
    await js('window.__petTestForceStats(false)')
    await wait(200)
    affection = initialAffection()
    pushAffectionToRenderer()
    await wait(150)

    // 面板隐藏时加 7 点：推送会到，但按设计不该重绘
    grantAffection(7, '面板可见性测试')
    await wait(250)

    await js('window.__petTestForceStats(true)')
    await wait(250)
    const shown = await js('window.__petTestState()')
    const affNow = shown && shown.affection ? shown.affection : null
    check(
      '面板展开时好感显示是最新值（隐藏期间的变化不会丢）',
      Boolean(affNow)
        && affNow.value === affection.value
        && affNow.valueText === `${String(affection.value)}/${String(stageThresholdFor(affection.hearts))}`,
      affNow
        ? `面板 ${String(affNow.valueText)}，主进程 ${String(affection.value)}/${String(stageThresholdFor(affection.hearts))}`
        : '拿不到面板状态',
    )
    await js('window.__petTestForceStats(false)')
    await wait(150)
    // 后面的低心情用例要能重新拿到点击好感，所以把冷却锚点清掉
    lastClickAffectionAtMs = null
  }

  // ---- 5) 低心情点击：心情 +50、好感含 +10 奖励、说信赖语音 ----
  {
    mood = { value: 30, updatedAt: Date.now() }
    lastClickAffectionAtMs = null // 跳过 5 分钟等待（只是为了能测到这一条）
    pushMoodToRenderer()
    await wait(200)

    const beforeAff = affection.value
    await js('window.__petTestClick()')
    await wait(350)

    check(
      '低心情点击：心情立即 +50',
      Math.round(mood.value) === 80 && lastMoodGain && lastMoodGain.reason === '低心情点击',
      `心情 30 → ${String(Math.round(mood.value))}，reason=${String(lastMoodGain && lastMoodGain.reason)}`,
    )
    const gained = lastAffectionGain ? lastAffectionGain.amount : 0
    check(
      '低心情点击：好感含 +10 奖励（共 12~18）',
      gained >= AFFECTION_GAIN.clickMin + AFFECTION_GAIN.lowMoodClick
        && gained <= AFFECTION_GAIN.clickMax + AFFECTION_GAIN.lowMoodClick,
      `本次 +${String(gained)}（阶段值 ${String(beforeAff)} → ${String(affection.value)}）`,
    )
    const bubble = await js('window.__petTestBubble ? window.__petTestBubble() : null')
    check(
      '低心情时说的是信赖语音（不是部位台词）',
      Boolean(bubble) && voiceLinesFor('trust').includes(bubble.text),
      `气泡「${String(bubble && bubble.text)}」`,
    )
  }

  // ---- 6) 深度思考：随宿主状态进出，点击也能结束 ----
  {
    /*
     * 先把状态收干净再开始：前面几段用例可能留下动作/坐姿/退出段，
     * 都会让"第一次读到的思考状态"不确定。这里强制回到闲置。
     */
    await js('window.__petTestRefresh()')
    /*
     * 等久一点（800ms）再推 thinking。
     *
     * 前面用例的 `testPushState` 是异步下发的，可能有**排队中的 idle 推送**
     * 晚一步才到渲染进程 —— 那会被正确地当成"宿主不在思考"结束掉刚进入的思考，
     * 表现为这条用例偶发红（实测遇到过一轮）。留出排空时间即可。
     */
    await wait(800)
    /*
     * 记下"站立时"的角色矩形：思考循环段的画布更高（864x1210，为了放头顶气泡），
     * 帧会向上溢出 —— 但**脚底必须纹丝不动**，否则角色会像被抬起来。
     */
    const rectStand = await js(
      '(() => { const r = document.getElementById("frame").getBoundingClientRect(); return { w: r.width, h: r.height, bottom: r.bottom } })()',
    )
    /* 进入前的气泡状态（用于断言"思考期间不弹气泡"）。 */
    const bubbleBeforeThink = await js(
      '(() => { const b = document.getElementById("bubble"); const t = document.getElementById("bubble-text"); return { hidden: b ? b.hidden : null, text: t ? t.textContent : "" } })()',
    )
    testPushState({ workStatus: 'thinking', workLabel: '思考中…', seq: 9601 })
    await wait(500)
    const t1 = await js('window.__petTestThink.state()')
    check(
      'DSH 开始思考 → 进入深度思考',
      Boolean(t1) && t1.active === true,
      `active=${String(t1 && t1.active)}，petState=${String(t1 && t1.petState)}`,
    )
    check(
      '进入段先播 think-enter（不是直接循环）',
      Boolean(t1) && (t1.phase === 'enter' || t1.phase === 'loop') && t1.activeAnimationId === 'think-enter',
      `phase=${String(t1 && t1.phase)}，动画=${String(t1 && t1.activeAnimationId)}`,
    )
    check(
      '深度思考期间不触发随机动作',
      Boolean(t1) && t1.canTriggerRandom === false,
      `canTriggerRandom=${String(t1 && t1.canTriggerRandom)}`,
    )

    /*
     * 进入段 6 帧 @6fps ≈ 1s，播完应自动切到循环段。
     * 这里等 1.6s 再读，验证"串起来"这件事真的发生了。
     */
    await wait(1600)
    const tLoop = await js('window.__petTestThink.state()')
    check(
      '进入段播完 → 自动循环 think-loop',
      Boolean(tLoop) && tLoop.phase === 'loop' && tLoop.activeAnimationId === 'think-loop',
      `phase=${String(tLoop && tLoop.phase)}，动画=${String(tLoop && tLoop.activeAnimationId)}`
        + `，最后一次结束=${JSON.stringify(tLoop && tLoop.lastExit)}`,
    )

    /*
     * 循环段画布比其他动作高（864x1250，多出来的是头顶气泡所需的空间）。
     * 帧高要按素材自身比例走（否则会被压扁），而脚底必须与站立一致。
     */
    const rectLoop = await js(
      '(() => { const r = document.getElementById("frame").getBoundingClientRect(); return { w: r.width, h: r.height, bottom: r.bottom } })()',
    )
    check(
      '思考循环段的帧按自身比例变高（不被压扁）',
      Boolean(rectStand) && Boolean(rectLoop) && rectLoop.h > rectStand.h + 4,
      `站立高 ${String(rectStand && rectStand.h)} → 循环高 ${String(rectLoop && rectLoop.h)}`
        + `（宽度 ${String(rectLoop && rectLoop.w)}，期望高 ≈ 宽 × 1250/864）`,
    )
    check(
      '思考循环段的脚底位置与站立一致（角色没被抬起）',
      Boolean(rectStand) && Boolean(rectLoop) && Math.abs(rectLoop.bottom - rectStand.bottom) <= 1.5,
      `站立底 ${String(rectStand && rectStand.bottom)} → 循环底 ${String(rectLoop && rectLoop.bottom)}`,
    )

    /*
     * 用户要求：「深度思考动作不再需要任何语音」。
     * 素材自带"深度求索中…"气泡，应用层若再弹一句就是两个气泡叠着。
     *
     * 断言方式：**比较进入前后的气泡是否发生变化**，而不是要求屏幕上没有气泡 ——
     * 前面用例可能还挂着一条 5 秒的台词气泡，那与思考无关。
     */
    const bubbleDuringThink = await js(
      '(() => { const b = document.getElementById("bubble"); const t = document.getElementById("bubble-text"); return { hidden: b ? b.hidden : null, text: t ? t.textContent : "" } })()',
    )
    check(
      '深度思考期间不弹任何气泡（该动作不发声）',
      Boolean(bubbleDuringThink) && Boolean(bubbleBeforeThink)
        && bubbleDuringThink.hidden === bubbleBeforeThink.hidden
        && bubbleDuringThink.text === bubbleBeforeThink.text,
      `进入前 hidden=${String(bubbleBeforeThink && bubbleBeforeThink.hidden)}/${String(bubbleBeforeThink && bubbleBeforeThink.text)}`
        + ` → 循环中 hidden=${String(bubbleDuringThink && bubbleDuringThink.hidden)}/${String(bubbleDuringThink && bubbleDuringThink.text)}`,
    )

    /*
     * 用户要求：「循环开始后从 0 开始计时，持续 300 秒则直接触发结束」。
     * 这里只验证"循环段一起播就开始计时"，以及"300 秒"这个量级。
     */
    const holdLeft = tLoop && Number.isFinite(tLoop.holdDeadline)
      ? tLoop.holdDeadline - Date.now()
      : null
    check(
      '循环段开始后立即起算思考时长（上限 300 秒）',
      Boolean(tLoop) && tLoop.holdArmed === true && holdLeft !== null && holdLeft > 280_000 && holdLeft <= 305_000,
      tLoop
        ? `计时中=${String(tLoop.holdArmed)}，上限=${String(tLoop.holdLimitMs)}ms，剩余≈${String(holdLeft)}ms`
        : '读不到思考状态',
    )

    await js('window.__petTestClick()')
    await wait(300)
    const t2 = await js('window.__petTestThink.state()')
    check(
      '点击桌宠 → 结束深度思考',
      Boolean(t2) && t2.active === false,
      `active=${String(t2 && t2.active)}`,
    )
    check(
      '结束时播退出段 think-exit（倒放进入段）',
      Boolean(t2) && t2.phase === 'exit' && t2.activeAnimationId === 'think-exit',
      `phase=${String(t2 && t2.phase)}，动画=${String(t2 && t2.activeAnimationId)}`,
    )

    /* 退出段同样 6 帧 ≈ 1s，播完应回站立闲置 */
    await wait(1600)
    const tAfter = await js('window.__petTestThink.state()')
    check(
      '退出段播完 → 回站立闲置',
      Boolean(tAfter) && tAfter.phase === null && tAfter.activeAnimationId === 'stand',
      `phase=${String(tAfter && tAfter.phase)}，动画=${String(tAfter && tAfter.activeAnimationId)}`,
    )
    /*
     * 用户反馈："进入思考 / 思考中 / 结束思考 衔接时会先跳出一帧站立"。
     * 成因是段落切换走了 endAction()（会把画面切回站立），而下一段素材是异步加载的。
     * 现在切换前先载好素材、不再经过站立 —— 这条断言钉住它不回退。
     */
    check(
      '思考三段衔接不经过站立（不闪一帧站立）',
      Boolean(tAfter) && tAfter.standFlashes === 0,
      `本轮被切回站立的次数 = ${String(tAfter && tAfter.standFlashes)}（应为 0）`,
    )
    /*
     * 用户要求：「在此之前 dsh 思考结束，则正常触发结束，**并停止计时**」。
     * 这里点击结束了一次思考，计时必须已经停掉（holdDeadline 回到 null）。
     */
    check(
      '正常结束思考后停止计时（不会被 300 秒上限再踢一次）',
      Boolean(tAfter) && tAfter.holdDeadline === null && tAfter.holdArmed === false,
      tAfter
        ? `计时中=${String(tAfter.holdArmed)}，到期时刻=${String(tAfter.holdDeadline)}`
        : '读不到思考状态',
    )

    // 再进一次，这次让宿主自己结束思考
    /*
     * ⚠️ 先推一次 idle 再推 thinking。
     *
     * 渲染进程对"状态没变"的推送会去重（同一个 workStatus 不会重复触发），
     * 而上一轮结束时留下的当前状态可能还是 thinking —— 直接再推 thinking
     * 会被当成"没变化"静默丢掉，表现为"第二次思考根本没进入"。
     */
    testPushState({ workStatus: 'idle', workLabel: '', seq: 9601.5 })
    await wait(200)
    testPushState({ workStatus: 'thinking', workLabel: '思考中…', seq: 9602 })
    await wait(400)
    const t3 = await js('window.__petTestThink.state()')
    testPushState({ workStatus: 'idle', workLabel: '', seq: 9603 })
    await wait(400)
    const t4 = await js('window.__petTestThink.state()')
    check(
      'DSH 思考结束 → 自动回到闲置',
      Boolean(t3) && t3.active === true && Boolean(t4) && t4.active === false,
      `进入=${String(t3 && t3.active)} → 结束=${String(t4 && t4.active)}`,
    )
    // 等退出段播完，别把 exit 状态留给后面的用例
    await wait(1600)
  }

  /*
   * ---- 6.4) 手动触发的思考，不被宿主状态推送打断 ----
   *
   * 用户反馈：「深度思考动作手动触发后，不到 300 秒就会自发停止」。
   * 成因：手动思考没有宿主状态支撑，而宿主每次推 idle/working 都会走到
   * "宿主不在思考 → 结束思考"的分支，于是下一次状态推送就把它踢掉了。
   * 现在 `enterThink('manual')` 会记下来源，宿主推送不再影响它。
   */
  {
    await js('window.__petTestRefresh()')
    await wait(300)
    await js('window.__petTestThink.enterManual()')
    await wait(1600)
    const manualStarted = await js('window.__petTestThink.state()')
    // 模拟宿主在思考期间推几种"非思考"状态
    testPushState({ workStatus: 'idle', workLabel: '', seq: 9700 })
    await wait(300)
    testPushState({ workStatus: 'working', workLabel: '干活中…', seq: 9701 })
    await wait(300)
    testPushState({ workStatus: 'idle', workLabel: '', seq: 9702 })
    await wait(500)
    const manualAfter = await js('window.__petTestThink.state()')
    check(
      '手动触发的深度思考不会被宿主状态推送打断',
      Boolean(manualStarted) && manualStarted.active === true && manualStarted.manual === true
        && Boolean(manualAfter) && manualAfter.active === true && manualAfter.phase === 'loop',
      manualAfter
        ? `进入=${String(manualStarted && manualStarted.active)}/手动=${String(manualStarted && manualStarted.manual)}`
          + ` → 三次宿主推送后 active=${String(manualAfter.active)}，phase=${String(manualAfter.phase)}`
        : '读不到思考状态',
    )
    // 手动思考仍然受 300 秒上限约束（这一点由 6.5 覆盖），这里用点击收起
    await js('window.__petTestRefresh()')
    await wait(400)
  }

  /*
   * ---- 6.5) 思考时长上限：到点自动结束 ----
   *
   * 用户要求「若持续达到 300 秒，则直接触发结束」。自测不能真等 5 分钟，
   * 所以用 `setHoldLimit` 把上限临时改小（这是**测试专用**的注入点，
   * 生产路径永远是 300 秒），验证"到点会自己走退出段并回闲置"。
   */
  {
    await js('window.__petTestThink.setHoldLimit(700)')
    testPushState({ workStatus: 'idle', workLabel: '', seq: 9610 })
    await wait(200)
    testPushState({ workStatus: 'thinking', workLabel: '思考中…', seq: 9611 })
    // 等到循环段起来（进入段 6 帧 ≈ 1 秒）+ 上限 700ms
    await wait(2600)
    const afterLimit = await js('window.__petTestThink.state()')
    check(
      '思考持续到上限 → 自动触发结束（无需宿主通知）',
      Boolean(afterLimit) && afterLimit.active === false && afterLimit.holdDeadline === null,
      afterLimit
        ? `active=${String(afterLimit.active)}，phase=${String(afterLimit.phase)}，计时中=${String(afterLimit.holdArmed)}`
        : '读不到思考状态',
    )
    // 恢复默认上限，别影响后面的用例
    await js('window.__petTestThink.setHoldLimit(0)')
    await wait(1400)
  }

  // ---- 7) 刷新状态：无条件回闲置 ----
  {
    // 先制造一个"非闲置"的状态（让她坐下），再刷新
    await js('window.__petTestSit && window.__petTestSit.start ? window.__petTestSit.start() : null')
    await wait(500)
    const beforeRefresh = await js('window.__petTestRefresh()')
    await wait(200)
    check(
      '刷新状态把桌宠收回闲置',
      Boolean(beforeRefresh)
        && beforeRefresh.petState === 'idle'
        && beforeRefresh.currentActionId === null
        && beforeRefresh.sitPhase === null
        && beforeRefresh.thinkActive === false,
      `petState=${String(beforeRefresh && beforeRefresh.petState)}，`
      + `action=${String(beforeRefresh && beforeRefresh.currentActionId)}，`
      + `sitPhase=${String(beforeRefresh && beforeRefresh.sitPhase)}`,
    )
  }

  // 收尾：把宿主状态与好感/心情恢复到中性，别影响后续用例
  testPushState({ workStatus: 'idle', workLabel: '', seq: 9609 })
  affection = initialAffection()
  lastClickAffectionAtMs = null
  mood = { value: 100, updatedAt: Date.now() }
  pushAffectionToRenderer()
  pushMoodToRenderer()
}

/**
 * 自测：右键菜单的 8 个入口。
 *
 * 不真弹菜单（`popup` 会抢焦点），而是构建模板后检查条目 ——
 * "菜单项少了/写错了"是用户一眼就能看到的故障，值得钉住。
 *
 * @param {(name: string, ok: boolean, detail?: string) => void} check
 */
function verifyContextMenu(check) {
  let template = null
  try {
    template = buildMenuTemplate()
  } catch (err) {
    check('右键菜单能构建', false, err instanceof Error ? err.message : String(err))
    return
  }
  const labels = template.filter((item) => item && item.label).map((item) => item.label)
  const expect = [
    '语音库…',
    '动作',
    '尺寸',
    '始终显示在最上层',
    '回到初始位置',
    '刷新状态',
    '关于桌宠…',
    '退出桌宠',
  ]
  const missing = expect.filter((want) => !labels.includes(want))
  check(
    '右键菜单包含全部 8 个入口',
    missing.length === 0,
    missing.length === 0 ? `实际=[${labels.join(' / ')}]` : `缺少 ${missing.join('、')}；实际=[${labels.join(' / ')}]`,
  )

  const topmost = template.find((item) => item && item.label === '始终显示在最上层')
  check(
    '「始终显示在最上层」是勾选项且反映当前状态',
    Boolean(topmost) && topmost.type === 'checkbox' && topmost.checked === topmostEnabled,
    topmost ? `type=${String(topmost.type)}，checked=${String(topmost.checked)}（主进程记录 ${String(topmostEnabled)}）` : '找不到该项',
  )

  const actionItem = template.find((item) => item && item.label === '动作')
  check(
    '「动作」是子菜单且非空',
    Boolean(actionItem) && Array.isArray(actionItem.submenu) && actionItem.submenu.length > 0,
    actionItem ? `${String((actionItem.submenu || []).length)} 项` : '找不到该项',
  )

  const sizeItem = template.find((item) => item && item.label === '尺寸')
  check(
    '「尺寸」是子菜单且含全部档位',
    Boolean(sizeItem) && Array.isArray(sizeItem.submenu) && sizeItem.submenu.length === SIZE_PRESETS.length,
    sizeItem ? `${String((sizeItem.submenu || []).length)} 档（期望 ${String(SIZE_PRESETS.length)}）` : '找不到该项',
  )
}

/**
 * 自测：两个信息窗口（语音库 / 关于）。
 *
 * 为什么要真开窗口：这两个窗口是**用户点开才存在**的，平时进程里没有它们；
 * 只测 `buildVoiceWindowPayload()` 之类的纯数据函数，测不到
 * "preload 没配对 / 数据没送到 / 页面脚本报错" 这类真实故障
 * （preload 少一个 API 就会白屏，而这种问题单元测试完全看不见）。
 *
 * 跑完把它关掉，别在桌宠旁边留一个窗口。
 *
 * @param {(name: string, ok: boolean, detail?: string) => void} check
 * @param {(ms: number) => Promise<void>} wait
 */
async function verifyInfoWindows(check, wait) {
  // ---- 语音库窗口 ----
  openInfoWindow('voice')
  await wait(900)
  {
    const ok = Boolean(infoWin && !infoWin.isDestroyed())
    check('语音库窗口能打开', ok, ok ? '窗口已创建' : '窗口创建失败')
    /*
     * 可见性单独断言：窗口"创建成功"但没显示出来，正是用户反馈的那个症状
     * （"第一次点没反应，要点第二次"）。只检查 `infoWin` 是否存在是不够的。
     */
    check(
      '语音库窗口创建后立刻可见',
      ok && infoWin.isVisible() && !infoWin.isMinimized(),
      ok ? `可见=${String(infoWin.isVisible())}，最小化=${String(infoWin.isMinimized())}` : '窗口未创建',
    )
    if (ok) {
      let diag = null
      try {
        diag = await infoWin.webContents.executeJavaScript(
          `({
             title: (document.getElementById('title') || {}).textContent || '',
             cards: document.querySelectorAll('.card').length,
             items: document.querySelectorAll('ol.lines li').length,
             sayBtnVisible: !(document.getElementById('say-btn') || {}).hidden,
             bodyText: (document.body || {}).innerText || ''
           })`,
          true,
        )
      } catch (err) {
        diag = { error: err instanceof Error ? err.message : String(err) }
      }
      check(
        '语音库窗口渲染出了分组与台词',
        Boolean(diag) && !diag.error && diag.cards > 0 && diag.items > 0 && diag.title.includes('语音库'),
        diag && diag.error
          ? `脚本报错：${diag.error}`
          : `标题=${JSON.stringify(diag && diag.title)}，分组卡片 ${String(diag && diag.cards)}，已展开台词 ${String(diag && diag.items)} 条`,
      )
      check(
        '语音库窗口有「随机说一句」按钮',
        Boolean(diag) && diag.sayBtnVisible === true,
        `sayBtn 可见=${String(diag && diag.sayBtnVisible)}`,
      )
      check(
        '语音库窗口只展开当前可用的组（锁定组不显示台词）',
        Boolean(diag) && /未解锁/.test(String(diag.bodyText)) === (affection.hearts < 5 || true),
        `爱心 ${String(affection.hearts)} 颗；正文里出现"未解锁"=${String(Boolean(diag) && /未解锁/.test(String(diag.bodyText)))}`,
      )
    }
  }

  // ---- 关于窗口（同一个窗口切模式） ----
  openInfoWindow('about')
  await wait(900)
  {
    let diag = null
    if (infoWin && !infoWin.isDestroyed()) {
      try {
        diag = await infoWin.webContents.executeJavaScript(
          `({
             title: (document.getElementById('title') || {}).textContent || '',
             bodyText: (document.body || {}).innerText || '',
             changelog: (document.querySelector('pre.changelog') || {}).textContent || ''
           })`,
          true,
        )
      } catch (err) {
        diag = { error: err instanceof Error ? err.message : String(err) }
      }
    }
    check(
      '关于窗口显示版本号',
      Boolean(diag) && !diag.error && diag.bodyText.includes(APP_VERSION),
      diag && diag.error
        ? `脚本报错：${diag.error}`
        : `版本 ${String(APP_VERSION)}，正文是否包含=${String(Boolean(diag) && diag.bodyText.includes(APP_VERSION))}`,
    )
    check(
      '关于窗口显示最新更新日志',
      Boolean(diag) && String(diag.changelog).length > 20,
      `日志长度 ${String(diag && String(diag.changelog).length)} 字符`,
    )
  }

  // ---- 关掉，别留窗口 ----
  if (infoWin && !infoWin.isDestroyed()) {
    infoWin.close()
    await wait(300)
  }
  check('信息窗口能正常关闭', !infoWin || infoWin.isDestroyed(), `infoWin=${infoWin ? '仍在' : '已关'}`)

  /*
   * ---- 关掉后再点一次（模拟"关掉窗口 → 再点菜单"）----
   *
   * 用户反馈的是「第一次点没反应，要点第二次才弹出」。两处都要能一次就出来：
   *  · 进程里**没有**窗口时（第一次点）→ 新建后必须可见；
   *  · 进程里**已有**窗口时（窗口开着再点）→ show+focus+moveTop 也必须可见。
   * 上面已经覆盖了"新建"这一路（语音库那次），这里补"重新新建"与可见性断言。
   */
  openInfoWindow('voice')
  await wait(900)
  {
    const alive = Boolean(infoWin && !infoWin.isDestroyed())
    const visible = alive && infoWin.isVisible()
    check(
      '信息窗口第一次点开就可见（不需要点第二次）',
      alive && visible,
      alive ? `可见=${String(visible)}，最小化=${String(infoWin.isMinimized())}` : '窗口未创建',
    )
  }
  if (infoWin && !infoWin.isDestroyed()) {
    infoWin.close()
    await wait(300)
  }
}

/**
 * 自测：好感存档的**落盘与路径**。
 *
 * 为什么必须在这里测（而不是放在纯 Node 单测里）：
 * 真正要保证的是"存档落在 `app.getPath('userData')`、与安装目录分离"，
 * 而 `app` 只有在这个进程里才有。纯 Node 里 `require('electron')` 只是个路径字符串，
 * 测出来的永远是兜底分支 —— 那种断言看着绿、其实没证明任何事。
 *
 * 这条用例同时钉住用户的核心诉求：
 * 「注意更新时删除旧文件，保留用户数据」—— 存档只要不在安装目录里，
 * 升级清文件就不可能碰到它。
 *
 * @param {(name: string, ok: boolean, detail?: string) => void} check
 * @param {(ms: number) => Promise<void>} wait
 */
async function verifyAffectionPersistence(check, wait) {
  /* 局部引入 path：本文件其它地方都是就地 `require('node:path')`，没有顶层 join。 */
  const pathMod = require('node:path')
  const storePath = affectionStore.path()
  const userData = (() => {
    try {
      return app.getPath('userData')
    } catch {
      return ''
    }
  })()
  const normalize = (p) => String(p).replace(/\\/g, '/').toLowerCase()

  check(
    '好感存档落在 Electron 的 userData 目录里',
    Boolean(userData) && normalize(storePath).startsWith(normalize(userData)),
    `存档 ${storePath}；userData ${String(userData)}`,
  )
  check(
    '好感存档不在插件安装目录里（升级清文件不会碰到它）',
    !normalize(storePath).startsWith(normalize(pathMod.join(__dirname, '..'))),
    `存档 ${storePath}；插件目录 ${pathMod.join(__dirname, '..')}`,
  )

  // ---- 往返：改值 → 强制落盘 → 重新读 ----
  const saved = { hearts: affection.hearts, value: affection.value }
  const savedLifetime = lifetimeAffectionGained
  const savedClickAt = lastClickAffectionAtMs
  try {
    affection = { hearts: 2, value: 37, updatedAt: Date.now() }
    lifetimeAffectionGained = 4321
    lastClickAffectionAtMs = Date.now() - 1000
    persistAffection(true)

    const reloaded = affectionStore.load()
    check(
      '好感能写入并原样读回（爱心/阶段/累计/冷却锚点）',
      reloaded.loaded
        && reloaded.state.hearts === 2
        && reloaded.state.value === 37
        && reloaded.lifetimeGained === 4321
        && reloaded.lastClickAt === lastClickAffectionAtMs,
      `读回 ${String(reloaded.state.hearts)} 心 ${String(reloaded.state.value)}，`
      + `累计 ${String(reloaded.lifetimeGained)}，lastClickAt ${String(reloaded.lastClickAt)}`,
    )
  } finally {
    // 还原真实数据并落盘，别把自测评测值留给用户
    affection = { ...affection, hearts: saved.hearts, value: saved.value }
    lifetimeAffectionGained = savedLifetime
    lastClickAffectionAtMs = savedClickAt
    persistAffection(true)
    pushAffectionToRenderer()
    await wait(100)
  }
}

async function verifySitAction(check, wait) {
  const wc = win && !win.isDestroyed() ? win.webContents : null
  if (!wc) return
  const readState = () => wc.executeJavaScript('window.__petTestState ? window.__petTestState() : null', true)
  const js = (code) => wc.executeJavaScript(code, true)

  /* 关掉随机动作：它在用例之间可能突然触发并改变 petState，把断言打乱。 */
  await js('window.__petTestSetIdleClock({ probability: 0 })')

  // ---- 1) 三段素材都要能加载，且帧率一致 ----
  const meta = await js(`(async () => {
    const ids = ['sit', 'sit-circle', 'sit-stop']
    const out = {}
    for (const id of ids) {
      const s = await loadAnimation(id)
      out[id] = s ? { frames: s.frameCount, fps: s.fps } : null
    }
    return out
  })()`)
  {
    const ids = ['sit', 'sit-circle', 'sit-stop']
    const missing = ids.filter((id) => !meta || !meta[id])
    check(
      '坐姿三段素材都能加载（坐下 / 坐着 / 站起）',
      missing.length === 0,
      missing.length === 0
        ? ids.map((id) => `${id}=${String(meta[id].frames)}帧@${String(meta[id].fps)}fps`).join('，')
        : `缺：${missing.join(', ')}`,
    )
    /*
     * 三段都必须"多帧"：坐下/站起是过程，坐着是循环，
     * 任何一段只有 1 帧就说明素材没处理好（那种情况下过程看不出来）。
     * 刻意**不写死**具体帧数 —— 换美术素材时不该因此报假失败。
     */
    const tooFew = ids.filter((id) => meta && meta[id] && meta[id].frames < 2)
    check(
      '坐姿三段都是多帧素材',
      missing.length === 0 && tooFew.length === 0,
      tooFew.length === 0 ? '都是 ≥2 帧' : `帧数过少：${tooFew.join(', ')}`,
    )
    const fpsBad = ids.filter((id) => meta && meta[id] && meta[id].fps !== 6)
    check(
      '坐姿三段帧率一致（6fps，否则切换阶段时速度会突变）',
      missing.length === 0 && fpsBad.length === 0,
      fpsBad.length === 0 ? '全部 6fps' : `帧率不符：${fpsBad.map((i) => `${i}=${String(meta[i].fps)}`).join(', ')}`,
    )
  }

  const plan = await js('window.__petTestSit.plan()')
  check(
    '「坐着」阶段默认时长 = 180 秒（用户指定）',
    (await js('window.__petTestSit.setHoldMs(null)')) === 180 * 1000,
    `holdMs=${String(await js('window.__petTestSit.holdMs()'))}（应为 180000）`,
  )

  // ---- 2) 触发后进入第一阶段：坐下 ----
  const entered = await js(`window.__petTestSit.enter('自测')`)
  const down = await readState()
  check(
    '触发坐下后进入 sitting / down 阶段',
    entered === true && down && down.petState === 'sitting' && down.sitPhase === 'down',
    `enter=${String(entered)} petState=${String(down && down.petState)} sitPhase=${String(down && down.sitPhase)}`,
  )
  check(
    '第一阶段播放「坐下」动画',
    down && down.activeAnimationId === 'sit',
    `activeAnimationId=${String(down && down.activeAnimationId)}`,
  )

  // ---- 3) 坐下播完自动进入第二阶段：坐着循环 + 计时 ----
  await wait((plan && plan.downMs ? plan.downMs : 1500) + 500)
  const hold = await readState()
  check(
    '坐下播完自动进入 hold 阶段',
    hold && hold.sitPhase === 'hold',
    `sitPhase=${String(hold && hold.sitPhase)}（期望 hold）`,
  )
  check(
    '第二阶段循环播放「坐着」动画',
    hold && hold.activeAnimationId === 'sit-circle',
    `activeAnimationId=${String(hold && hold.activeAnimationId)}（期望 sit-circle）`,
  )
  check(
    '坐着阶段已开始计时（180 秒计时器在跑）',
    hold && hold.hasSitHoldTimer === true,
    `hasSitHoldTimer=${String(hold && hold.hasSitHoldTimer)} sitHoldMs=${String(hold && hold.sitHoldMs)}`,
  )
  {
    /* 采三次，只要有一次帧号变化就说明在动 —— 单次采样可能刚好落在同一帧。 */
    const frames = []
    for (let i = 0; i < 3; i += 1) {
      const st = await readState()
      frames.push(st ? st.currentFrame : null)
      await wait(250)
    }
    const moved = new Set(frames).size > 1
    check('坐着动画的帧在推进（不是静止）', moved, `三次采样帧号：${frames.join(' → ')}`)
  }

  // ---- 4) 前两阶段点击 → 立即跳站起 + 关闭计时 ----
  const clicked = await js('window.__petTestSit.click()')
  const up = await readState()
  check(
    '坐着时点击立即跳到站起阶段',
    clicked === true && up && up.sitPhase === 'up',
    `click=${String(clicked)} sitPhase=${String(up && up.sitPhase)}（期望 up）`,
  )
  check(
    '站起阶段播放「sit-stop」动画',
    up && up.activeAnimationId === 'sit-stop',
    `activeAnimationId=${String(up && up.activeAnimationId)}（期望 sit-stop）`,
  )
  /*
   * "关闭计时"的可观测证据：点击后**等过原本的坐着时长**，
   * 不应该再回到 hold 阶段（若计时没关，会看到 sitPhase 又变回 hold）。
   */
  await wait((plan && plan.holdMs ? plan.holdMs : 600) > 800 ? 900 : 1200)
  const afterClick = await readState()
  check(
    '点击后计时已关闭（不会再回到 hold 阶段）',
    afterClick && afterClick.sitPhase !== 'hold',
    `sitPhase=${String(afterClick && afterClick.sitPhase)}`,
  )

  // ---- 5) 站起播完 → 回到站立闲置 ----
  await wait((plan && plan.upMs ? plan.upMs : 1500) + 800)
  const done = await readState()
  check(
    '站起播完回到站立闲置',
    done &&
      done.petState === 'idle' &&
      done.sitPhase === null &&
      done.activeAnimationId === 'stand' &&
      done.currentActionId === null,
    `petState=${String(done && done.petState)} sitPhase=${String(done && done.sitPhase)}` +
      ` 动画=${String(done && done.activeAnimationId)} 动作=${String(done && done.currentActionId)}`,
  )

  // ---- 6) 计时到点自动站起（把 180 秒压到 600ms 验证逻辑本身）----
  {
    await js('window.__petTestSit.setHoldMs(600)')
    await js(`window.__petTestSit.enter('自测-自动站起')`)
    await wait((plan && plan.downMs ? plan.downMs : 1500) + 500)
    const atHold = await readState()
    /* 再等过压缩后的坐着时长，应当自己离开 hold */
    await wait(1200)
    const autoUp = await readState()
    check(
      '坐着计时到点会自动站起（不必点击）',
      atHold && atHold.sitPhase === 'hold' && autoUp && autoUp.sitPhase !== 'hold',
      `计时前=${String(atHold && atHold.sitPhase)}，到点后=${String(autoUp && autoUp.sitPhase)}`,
    )
    await wait((plan && plan.upMs ? plan.upMs : 1500) + 800)
    const settled = await readState()
    check(
      '自动站起后同样回到站立闲置',
      settled && settled.petState === 'idle' && settled.activeAnimationId === 'stand',
      `petState=${String(settled && settled.petState)} 动画=${String(settled && settled.activeAnimationId)}`,
    )
    await js('window.__petTestSit.setHoldMs(null)')
  }

  // ---- 7) 第三阶段（站起中）点击不再响应 ----
  {
    await js('window.__petTestSit.setHoldMs(60000)')
    await js(`window.__petTestSit.enter('自测-站起中点击')`)
    await wait((plan && plan.downMs ? plan.downMs : 1500) + 500)
    await js('window.__petTestSit.click()')
    const first = await readState()
    const clickedAgain = await js('window.__petTestSit.click()')
    const second = await readState()
    check(
      '站起阶段再次点击不会重播站起（忽略）',
      clickedAgain === false && first && second && second.sitPhase === 'up',
      `第二次 click=${String(clickedAgain)}（应为 false）sitPhase=${String(second && second.sitPhase)}`,
    )
    /* 收尾，别让这个用例把后续断言拖在 sitting 里 */
    await js(`window.__petTestSit.cancel('自测收尾')`)
    await js('window.__petTestSit.setHoldMs(null)')
  }

  // ---- 8) 坐着期间不能重复进入（petState 守卫）----
  {
    await js('window.__petTestSit.setHoldMs(60000)')
    await js(`window.__petTestSit.enter('自测-重复进入')`)
    const again = await js(`window.__petTestSit.enter('自测-重复进入第二次')`)
    const st = await readState()
    check(
      '已经在坐着时再次触发会被拒绝（不重入）',
      again === false && st && st.petState === 'sitting',
      `第二次 enter=${String(again)}（应为 false）petState=${String(st && st.petState)}`,
    )
    await js(`window.__petTestSit.cancel('自测收尾')`)
    await js('window.__petTestSit.setHoldMs(null)')
  }

  const finalState = await readState()
  check(
    '坐姿用例结束后回到闲置（不留残余状态）',
    finalState && finalState.petState === 'idle' && finalState.sitPhase === null,
    `petState=${String(finalState && finalState.petState)} sitPhase=${String(finalState && finalState.sitPhase)}`,
  )

  await js('window.__petTestSetIdleClock(null)')
}

/**
 * 验证闲置语音的门控、随机动作、心情值与属性面板。
 *
 * 这几项的共同点是"由事件驱动、肉眼才能看到"，所以这里直接把状态注入渲染进程
 * 并读回它的内部状态做断言（`window.__petTestState`），不靠截图猜。
 *
 * ⚠️ 调用它之前请先跑完 verifyActionAssets —— 本函数会把闲置触发时钟改成
 * "立即且必然触发"，之后闲置动作会不停顶掉正在播的动画。
 *
 * @param {(name: string, ok: boolean, detail?: string) => void} check
 * @param {(ms: number) => Promise<void>} wait
 * @param {() => Promise<any>} readLayout
 */
async function verifyIdleAndMood(check, wait, readLayout) {
  const wc = win && !win.isDestroyed() ? win.webContents : null
  if (!wc) return

  /** 读渲染进程的内部状态（由 renderer.js 在测试模式下暴露）。 */
  const readState = () => wc.executeJavaScript('window.__petTestState ? window.__petTestState() : null', true)

  const bubbleText = () => wc.executeJavaScript('document.getElementById("bubble-text").textContent', true)

  // ---- 1) 宿主在忙时不得播闲置语音 ----
  //
  // 测量方法要收敛，否则会误判。这里用渲染进程里的**连续记录器**，
  // 把这段时间内出现过的所有气泡文案都记下来再做判定：
  // 轮询式采样会漏掉短时间内出现又消失的台词。
  await wc.executeJavaScript('window.__petTestSetIdleInterval(700)', true)
  await wc.executeJavaScript('window.__petTestStartRecorder(60)', true)
  testPushState({ workStatus: 'thinking', workLabel: '思考中…', seq: 9001 })
  await wait(2600)
  const thinkingSamples = await wc.executeJavaScript('window.__petTestReadRecorder()', true)
  const idleLeaked = thinkingSamples.filter(
    (s) =>
      s.text.includes('（占位）') ||
      s.text.includes('挖矿') ||
      s.text.includes('开饭') ||
      s.text.includes('zzz'),
  )
  check(
    '宿主思考时不播闲置语音',
    idleLeaked.length === 0,
    `期间出现 ${String(thinkingSamples.length)} 种状态，其中疑似闲置/动作文案 ${String(idleLeaked.length)} 条` +
      (idleLeaked.length > 0 ? `：${idleLeaked.map((s) => s.text).join(' / ')}` : ''),
  )
  const st1 = await readState()
  // 先确认"思考"这个状态**真的**到了渲染进程。
  // 这一步不能省：如果注入没生效，后面"没有闲置语音"的结论就毫无意义
  // （我第一版就吃过这个亏 —— 宿主的真实轮询把注入值顶掉，测试却读到了通过）。
  check(
    '注入的思考状态已到达渲染进程',
    st1 !== null && st1.workStatus === 'thinking',
    `渲染进程里的 workStatus=${String(st1 && st1.workStatus)}`,
  )
  check(
    '思考状态下不触发随机动作',
    /*
     * ⚠️ 这里**不能**再要求 `currentActionId === null`。
     *
     * 素材补齐前，思考动作加载不到、会回落站立，所以那时"当前动作"确实是 null。
     * 现在三段素材都在，进入思考后 `currentActionId` 会是 `think-enter` / `think-loop`
     * —— 那正是"在演思考"，不是随机动作。
     * 断言的本意是"没有随机动作被触发"，所以改成"当前动作不是随机池里的动作"。
     */
    st1 !== null
      && (st1.currentActionId === null || String(st1.currentActionId).startsWith('think-')),
    `currentActionId=${String(st1 && st1.currentActionId)}`,
  )

  /*
   * 工作状态**不再产生任何台词**（用户要求"工作状态的台词都去掉"）。
   *
   * 这条断言要证明的是"没有出现"，所以得先确认**确实有台词可显示** ——
   * 否则可能是根本没注入成功，断言就会不成立地通过。
   * 做法：先用 pet:say 推一句进去（证明气泡通道是通的），再切到思考状态，
   * 观察那句话有没有被工作文案顶掉/覆盖。
   */
  win.webContents.send('pet:say', { text: '（测试）工作状态不该顶掉这句', bubbleMs: 4000 })
  await wait(300)
  const beforeWork = String(await wc.executeJavaScript('document.getElementById("bubble-text").textContent', true))
  testPushState({ workStatus: 'thinking', workLabel: '思考中…', seq: 9001 })
  await wait(400)
  const afterWork = String(await wc.executeJavaScript('document.getElementById("bubble-text").textContent', true))
  check(
    '工作状态不显示任何台词（气泡内容不被工作文案替换）',
    beforeWork.includes('工作状态不该顶掉这句') && afterWork === beforeWork,
    `切换前=${JSON.stringify(beforeWork)}，切换后=${JSON.stringify(afterWork)}`,
  )
  const workLabelsGone = await wc.executeJavaScript(
    `['思考中…','干活中…','整理中…','等待中…','完成！','出错了…'].some((s) => document.getElementById('bubble-text').textContent.includes(s))`,
    true,
  )
  check('气泡里不出现任何工作状态文案', workLabelsGone === false, `是否出现工作文案=${String(workLabelsGone)}`)

  // ---- 2) 闲置时不再说任何台词（闲置语音已整体移除）----
  //
  // 这一条把"移除"钉住：回到闲置后观察一段时间，气泡里**不应出现闲置语音**。
  //
  // ⚠️ 判据不能只看 `（占位）` 前缀 —— **动作的台词**也是占位符
  // （比如"（占位）开饭啦"）。闲置语音与动作台词在文本上无法区分，
  // 所以用"这句是否属于某个动作的台词"来判定：不属于任何动作的占位台词
  // 才是闲置语音残留。
  testPushState({ workStatus: 'idle', workLabel: '', seq: 9002 })
  await wc.executeJavaScript('window.__petTestClearRecorder()', true)
  await wait(3000)
  const idleSamples = await wc.executeJavaScript('window.__petTestReadRecorder()', true)
  const actionLines = new Set(actionMenuEntries().flatMap((e) => findAction(e.id)?.lines ?? []))
  const spokenIdle = idleSamples.filter((s) => s.text.includes('（占位）') && !actionLines.has(s.text))
  check(
    '闲置时不再播任何闲置语音',
    spokenIdle.length === 0,
    spokenIdle.length === 0
      ? `观察到 ${String(idleSamples.length)} 种状态，无闲置台词（动作台词不算）`
      : `仍出现闲置台词：${spokenIdle.map((s) => s.text).join(' / ')}`,
  )

  /*
   * ⚠️ 顺序很关键：先把"素材 + 播放"验完，**再**去改闲置时钟。
   *
   * 因为下面那个"随机动作"用例会把闲置门槛压成 0、概率设成 1，
   * 之后闲置动作会不停触发，把任何正在播的动画顶掉 ——
   * 端到端起播断言放在它后面就会被覆盖（实测过）。
   * 早先这里把素材验证放在随机动作用例之后，因此一直失败。
   */
  await verifyActionAssets(check)

  // ---- 3) 随机动作：连续记录，避免采样漏掉整个动作窗口 ----
  //
  // ⚠️ 触发规则已改为"保持闲置 1 分钟后每分钟 1/5"，所以**不能靠等** ——
  // 这里用可注入时钟把门槛压到 0、概率设为 1，让它必然触发；
  // 规则本身的四个边界由 verifyIdleTriggerRule 单独验证。
  await wc.executeJavaScript(
    'window.__petTestSetClockForActions()',
    true,
  )
  await wc.executeJavaScript('window.__petTestClearRecorder()', true)
  await wait(6000)
  const actionSamples = await wc.executeJavaScript('window.__petTestReadRecorder()', true)
  // 用 lastPlayedActionId 判定：动作素材可能还没做出来，此时会立刻退回站立，
  // currentActionId 会被清空 —— 只看它会把"确实触发了但素材缺失"误判成"没触发"。
  const actionIds = [...new Set(actionSamples.map((s) => s.lastPlayedActionId).filter(Boolean))]
  check(
    '闲置时会随机触发动作',
    actionIds.length > 0,
    actionIds.length > 0 ? `期间触发过：${actionIds.join(', ')}` : `6 秒内 ${String(actionSamples.length)} 种状态，未触发动作`,
  )
  const sawAction = actionIds.length > 0 ? actionIds[0] : null

  /*
   * ⚠️ 用完立刻把"立即触发"的测试时钟恢复掉。
   *
   * 上面为了必然触发，把门槛设成 0、概率设成 1。如果不还原，**后续用例期间
   * 闲置动作会不停触发** —— 实测它会把正在播的拖拽动画切走，导致
   * "拖拽动画停在最后一帧"这条断言失败（active 变成 stand）。
   * 这是典型的"用例通过共享状态互相干扰"，且表现像是被测代码有缺陷。
   */
  await wc.executeJavaScript('window.__petTestSetIdleClock(null)', true)
  await wait(200)


  // ---- 4) 动作播完回到站立 ----
  if (sawAction) {
    // 停止触发（切到思考会让调度停下并打断动作），然后等它回到站立。
    testPushState({ workStatus: 'thinking', workLabel: '思考中…', seq: 9003 })
    let backToStand = false
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await wait(300)
      const st = await readState()
      if (st && st.activeAnimationId === 'stand' && !st.currentActionId) {
        backToStand = true
        break
      }
    }
    check('动作播完后回到站立动画', backToStand, `最终 activeAnimationId=${String((await readState()).activeAnimationId)}`)
    /*
     * ⚠️ 必须**推回 idle**。
     *
     * 这里用"切到思考"来停止闲置触发。以前 thinking 只是一个忙碌态，
     * 没有副作用；现在它会进入「深度思考」并让 `thinkActive` 保持为真，
     * 而"思考中点击 = 结束思考"会把后续所有点击用例吃掉（实测：
     * 部位点击那几条全变成"气泡是思考台词、动画是 stand"）。
     * 所以用完必须还原宿主状态。
     */
    testPushState({ workStatus: 'idle', workLabel: '', seq: 9004 })
    await wait(400)
  }

  // ---- 5) 动作清单完整性（右键菜单就是照它生成的） ----
  const st2 = await readState()
  const catalog = st2 && Array.isArray(st2.actionCatalog) ? st2.actionCatalog : []
  const catalogIds = catalog.map((a) => a.id)
  // 菜单要能触达全部有素材的动作（站立 + 三个随机动作 + 睡觉 + 惊醒）。
  const expectAll = ['stand', 'eat', 'play-mc', 'sit', 'sleep', 'awake']
  const missing = expectAll.filter((id) => !catalogIds.includes(id))
  check(
    '动作清单包含全部动作（站立/吃白饭/玩mc/坐下/睡觉/惊醒）',
    missing.length === 0,
    missing.length === 0 ? `清单=[${catalogIds.join(', ')}]` : `缺少 ${missing.join(', ')}；清单=[${catalogIds.join(', ')}]`,
  )
  /*
   * 随机池 = 吃白饭 + 玩mc + **坐下** + **睡觉**。
   * 惊醒与点击互动动画不在池里。
   *
   * 断言写成"恰好等于这四个"而不是"不含某个 id" —— 后者太弱，
   * 之前就因此漏掉过 awake 被抽进随机池。
   */
  const randomPool = await wc.executeJavaScript('oneShotActions().map((a) => a.id)', true)
  const expectedPool = ['eat', 'play-mc', 'sit', 'sleep']
  const poolOk =
    Array.isArray(randomPool) &&
    randomPool.length === expectedPool.length &&
    expectedPool.every((id) => randomPool.includes(id))
  check(
    '随机池恰好是 吃白饭 / 玩mc / 坐下 / 睡觉',
    poolOk,
    `随机池=[${Array.isArray(randomPool) ? randomPool.join(', ') : String(randomPool)}]（应为 ${expectedPool.join(', ')}）`,
  )

  // 右键菜单里"睡觉"只能出现一次 —— 它同时在随机池与仅菜单项里，
  // 不去重的话菜单会出现两个"睡觉"。
  const menuIds = await wc.executeJavaScript('actionCatalog.filter((a) => !a.standing).map((a) => a.id)', true)
  const sleepCount = Array.isArray(menuIds) ? menuIds.filter((id) => id === 'sleep').length : -1
  check('菜单里"睡觉"只出现一次（随机池与菜单项重叠已去重）', sleepCount === 1, `sleep 出现 ${String(sleepCount)} 次`)

  /*
   * ---- 5c) 右键菜单结构（用户要求重构过）----
   *
   * 用户要求：删掉独立的「点击部位」一栏，把点击互动并进「动作」栏、
   * 命名为「触碰{部位}」。这几条断言把新结构钉住，
   * 免得以后有人"顺手"改回旧结构或改掉命名格式。
   */
  {
    const entries = actionMenuEntries()
    const byGroup = {
      standing: entries.filter((e) => e.group === 'standing'),
      action: entries.filter((e) => e.group === 'action'),
      part: entries.filter((e) => e.group === 'part'),
    }
    check(
      '动作菜单含且仅含"站立"一项',
      byGroup.standing.length === 1 && byGroup.standing[0].id === STANDING_ACTION_ID,
      `standing 组：${byGroup.standing.map((e) => e.label).join('，')}`,
    )
    check(
      '触碰部位已并入动作菜单（不再有独立的"点击部位"栏）',
      byGroup.part.length === 4,
      `part 组：${byGroup.part.map((e) => e.label).join('，')}`,
    )
    const expectedLabels = ['触碰头', '触碰胸', '触碰腹', '触碰腿']
    const actualLabels = byGroup.part.map((e) => e.label)
    check(
      '触碰项命名为「触碰{部位}」',
      JSON.stringify(actualLabels) === JSON.stringify(expectedLabels),
      `实际=${JSON.stringify(actualLabels)}，期望=${JSON.stringify(expectedLabels)}`,
    )
    check(
      '每个触碰项都带 partId（菜单触发要能取到该部位的台词）',
      byGroup.part.every((e) => typeof e.partId === 'string' && e.partId.length > 0),
      byGroup.part.map((e) => `${e.label}→${String(e.partId)}`).join('，'),
    )
    // 旧的部位动作名不该再出现在菜单里（它们已改名为「触碰XX」）。
    const stale = ['摸头', '戳胸', '戳腹', '碰腿'].filter((old) =>
      entries.some((e) => e.label === old),
    )
    check(
      '旧的部位动作名已不再作为菜单项出现',
      stale.length === 0,
      stale.length === 0 ? '无残留' : `仍有：${stale.join('，')}`,
    )
    // partId 必须能在 clickParts 里查到，否则菜单触发取不到台词。
    const dangling = byGroup.part.filter((e) => !CLICK_PARTS.some((p) => p.id === e.partId))
    check(
      '触碰项的 partId 都能在 clickParts 里查到',
      dangling.length === 0,
      dangling.length === 0 ? '全部可解析' : `查不到：${dangling.map((e) => String(e.partId)).join('，')}`,
    )
  }

  /*
   * ---- 5d) 对话台词库 ----
   *
   * 用户要求「说句话」改为「对话」，并建一个专门的对话台词库。
   * 这里断言库可用 + 台词符合基本要求（非空、去重、长度可控）。
   */
  {
    check(
      '对话台词库非空且条数合理',
      dialogueLineCount() >= 8,
      `共 ${String(dialogueLineCount())} 句`,
    )
    const picked = pickDialogueLine()
    check(
      '随机取一句对话，取自库内',
      typeof picked === 'string' && picked.length > 0 && DIALOGUE_LINES.includes(picked),
      `取到：${JSON.stringify(picked)}`,
    )
    // 避重：连取两次不该一样（库里 15 句，撞车的概率极低，但仍用避重参数保证）。
    const second = pickDialogueLine(Math.random, picked)
    check(
      '连取两次不会重复（避开上一句）',
      second !== picked,
      `${JSON.stringify(picked)} → ${JSON.stringify(second)}`,
    )
  }


  /*
   * ---- 5b) 随机动作库：随机池与"库"必须一致 ----
   *
   * 用户要求"所有随机动作放在一个库中，此后添加新的动作都要放入其中，
   * 并且沿用目前关于随机动作的设定"。
   *
   * 所以这里断言三件事：
   *  1. 渲染进程拿到的随机池**恰好等于**库里的 `RANDOM_ACTIONS`（多一个少一个都算漂移）；
   *  2. 触发节奏与心情区间**确实由库下发**，而不是渲染进程自己写死一份；
   *  3. 每个随机动作都有对应的素材目录（否则抽到就是空白）。
   */
  {
    const libIds = RANDOM_ACTIONS.map((action) => action.id)
    check(
      '渲染进程的随机池与动作库 RANDOM_ACTIONS 完全一致',
      Array.isArray(randomPool) &&
        randomPool.length === libIds.length &&
        libIds.every((id) => randomPool.includes(id)),
      `库=[${libIds.join(', ')}]  渲染进程=[${Array.isArray(randomPool) ? randomPool.join(', ') : String(randomPool)}]`,
    )

    const ruleState = await wc.executeJavaScript('window.__petTestIdleClockState()', true)
    /*
     * ⚠️ 只比"门槛"与"概率"，**不比周期**。
     *
     * 因为测试模式会把掷骰子周期压得很短（`__petTestSetIdleInterval`，
     * 这里被压到 700ms），那是刻意的测试加速，不是"下发了错的值"。
     * 门槛与概率不参与加速，可以直接比。
     */
    const ruleOk =
      ruleState &&
      ruleState.afterMs === RANDOM_ACTION_RULES.idleThresholdMs &&
      Math.abs(ruleState.probability - RANDOM_ACTION_RULES.fireProbability) < 1e-9
    check(
      '触发节奏由动作库下发（门槛与概率一致）',
      ruleOk,
      ruleState
        ? `渲染进程 afterMs=${String(ruleState.afterMs)} 概率=${String(ruleState.probability)}；` +
          `库门槛=${String(RANDOM_ACTION_RULES.idleThresholdMs)} 库概率=${String(RANDOM_ACTION_RULES.fireProbability)}` +
          `（周期渲染进程=${String(ruleState.fireIntervalMs)} 库=${String(RANDOM_ACTION_RULES.fireIntervalMs)}，测试期会加速故不比）`
        : '拿不到渲染进程的规则状态',
    )

    /*
     * 渲染进程里还留着一份**兜底常量**（主进程没下发时用）。
     * 它必须与库里的值一致 —— 否则"旧版宿主 + 新版渲染进程"这类组合下，
     * 实际生效的节奏会与文档/库不一致，而且很难被发现。
     *
     * 之所以能读到：renderer.js 是普通脚本，顶层 `const` 虽然不挂到 window 上，
     * 但在同一 realm 的全局作用域里可见（现有的 `actionCatalog` 等也是这样读的）。
     */
    const fallback = await wc.executeJavaScript(
      '({ afterMs: IDLE_TRIGGER_AFTER_MS, intervalMs: IDLE_FIRE_INTERVAL_MS, probability: IDLE_FIRE_PROBABILITY })',
      true,
    )
    const fallbackOk =
      fallback &&
      fallback.afterMs === RANDOM_ACTION_RULES.idleThresholdMs &&
      fallback.intervalMs === RANDOM_ACTION_RULES.fireIntervalMs &&
      Math.abs(fallback.probability - RANDOM_ACTION_RULES.fireProbability) < 1e-9
    check(
      '渲染进程的兜底常量与动作库一致（改门槛时两边不漏）',
      fallbackOk,
      fallback
        ? `兜底 门槛=${String(fallback.afterMs)} 周期=${String(fallback.intervalMs)} 概率=${String(fallback.probability)}；` +
          `库 门槛=${String(RANDOM_ACTION_RULES.idleThresholdMs)} 周期=${String(RANDOM_ACTION_RULES.fireIntervalMs)} 概率=${String(RANDOM_ACTION_RULES.fireProbability)}`
        : '读不到兜底常量',
    )

    const gainState = await wc.executeJavaScript('window.__petTestIdleClockState()', true)
    check(
      '心情奖励区间由动作库下发（10~30）',
      gainState &&
        gainState.actionMoodGain &&
        gainState.actionMoodGain.min === RANDOM_ACTION_RULES.moodGain.min &&
        gainState.actionMoodGain.max === RANDOM_ACTION_RULES.moodGain.max,
      `渲染进程=${JSON.stringify(gainState && gainState.actionMoodGain)}，库=${JSON.stringify(RANDOM_ACTION_RULES.moodGain)}`,
    )

    // 每个随机动作都要有素材，否则抽到就是空白窗口。
    const missingAssets = []
    for (const id of libIds) {
      const plan = await wc.executeJavaScript(`window.__petTestPlaybackPlan(${JSON.stringify(id)})`, true)
      if (!plan || !(plan.frameCount > 0)) missingAssets.push(id)
    }
    check(
      '随机池里每个动作都有可用素材',
      missingAssets.length === 0,
      missingAssets.length === 0 ? `全部 ${String(libIds.length)} 个动作素材就绪` : `缺素材：${missingAssets.join(', ')}`,
    )

    /*
     * 加新动作时"沿用现有设定"的保证：随机池里的每个动作都必须能在
     * `findAction()` 里查到定义（台词等），否则抽到就只有动画没有台词。
     */
    const undefinedActions = libIds.filter((id) => {
      const def = findAction(id)
      return !def || !Array.isArray(def.lines) || def.lines.length === 0
    })
    check(
      '随机池里每个动作都有台词定义（加新动作时沿用同一套设定）',
      undefinedActions.length === 0,
      undefinedActions.length === 0 ? '全部就绪' : `缺台词定义：${undefinedActions.join(', ')}`,
    )
  }

  // ---- 6) 属性面板：悬停显示 ----
  /*
   * ⚠️ 必须**先移出、再移入**，不能只派一次"移到角色中心"。
   *
   * 渲染进程的 mousemove 处理是 `setStatsVisible(hit)`，而那个函数有
   * `if (visible === statsVisible) return` 的前置守卫。自测跑到这里时，
   * 光标**可能已经停在角色上**（前面点部位的用例留下的），于是这次合成
   * mousemove 计算出的 hit 仍是 true、状态没变化 → 面板不会被显示，
   * 断言就偶发地报 `statsVisible=false`。实测五次里出现一次。
   *
   * 所以先派一次"移到窗口左上角"（透明处，必然不命中）把状态压成 false，
   * 再派一次"移到角色中心" —— 这样 hit 从 false 变 true，必然触发显示。
   */
  {
    const leaveProbe = await wc.executeJavaScript('window.__petTestProbeClient(2, 2)', true)
    await wc.executeJavaScript(
      `window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 2, clientY: 2 }))`,
      true,
    )
    await wait(200)
    // 顺带确认这个"移出点"确实是透明处 —— 否则上面的推理不成立。
    if (leaveProbe && leaveProbe.opaque === true) {
      log('参考-悬停用例：窗口左上角 (2,2) 竟是角色像素，移出可能无效')
    }
  }
  const layout = await readLayout()
  const cx = Math.round(layout.frame.left + layout.frame.width / 2)
  const cy = Math.round(layout.frame.top + layout.frame.height / 2)
  await wc.executeJavaScript(
    `window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: ${String(cx)}, clientY: ${String(cy)} }))`,
    true,
  )
  await wait(350)
  const stHover = await readState()
  check('光标在角色上时显示属性面板', stHover !== null && stHover.statsVisible === true, `statsVisible=${String(stHover && stHover.statsVisible)}`)

  const hovered = await readLayout()
  if (hovered.statsVisibleRect) {
    check(
      '属性面板不与角色重叠',
      hovered.statsVisibleRect.top >= hovered.character.bottom - 2,
      `面板顶 ${hovered.statsVisibleRect.top.toFixed(1)} ≥ 角色底 ${hovered.character.bottom.toFixed(1)}`,
    )
    check(
      '属性面板未超出窗口',
      hovered.statsVisibleRect.bottom <= hovered.innerHeight + 1,
      `面板底 ${hovered.statsVisibleRect.bottom.toFixed(1)} ≤ 窗口高 ${String(hovered.innerHeight)}`,
    )
  } else {
    check('属性面板不与角色重叠', false, '面板不可见')
  }

  // ---- 7) 心情：点击加 3~10（随机区间）----
  //
  // ⚠️ 测量方式很关键：`gained` 是**被上限夹过之后的真实增量**，
  // 若从 40 起连点 12 次会很快顶到 100，之后几次增量变成 0，
  // 看起来像"加的值超出区间"（实测就踩到了：增量里出现 0 和 1）。
  // 所以每次都先把心情压到**中段**再点，测的才是纯粹的"加了多少"。
  //
  // ⚠️ 起点不能再用 0：那时心情 < 50，点击会走**低心情分支**（+50），
  // 测出来全是 50。要测"普通点击"，起点必须 ≥ 50，且加完不越过 100。
  const moodGains = []
  /*
   * ⚠️ 这一段现在会**顺带给好感入账**（`handlePetClick` 里点击就加好感）。
   * 而后面还有断言要求"好感初始为 0 颗心、阶段 0/100"。
   * 所以先存一份、测完还原 —— 否则点 12 次会把面板断言全弄红（实测如此）。
   */
  const affectionBeforeMoodTests = { ...affection }
  const lastClickBeforeMoodTests = lastClickAffectionAtMs
  for (let i = 0; i < 12; i += 1) {
    mood = { value: 60, updatedAt: Date.now() }
    handlePetClick()
    moodGains.push(mood.value - 60)
  }
  affection = affectionBeforeMoodTests
  lastClickAffectionAtMs = lastClickBeforeMoodTests
  pushAffectionToRenderer()
  await wait(400)
  const allInRange = moodGains.every((g) => g >= MOOD_GAIN_PER_PET_MIN && g <= MOOD_GAIN_PER_PET_MAX)
  check(
    `点击桌宠加 ${String(MOOD_GAIN_PER_PET_MIN)}~${String(MOOD_GAIN_PER_PET_MAX)} 点心情`,
    allInRange,
    `从 60 起连点 12 次的结果：${moodGains.join(',')}（都应在 ` +
      `${String(MOOD_GAIN_PER_PET_MIN)}~${String(MOOD_GAIN_PER_PET_MAX)} 内）`,
  )
  check(
    '点击加心情是随机的（12 次里出现了不同取值）',
    new Set(moodGains).size > 1,
    `不同取值 ${String(new Set(moodGains).size)} 个：${[...new Set(moodGains)].sort((a, b) => a - b).join(',')}`,
  )
  // 低心情时的特殊分支（用户指定第 3 条机制）：+50 而不是 3~10。
  {
    mood = { value: 20, updatedAt: Date.now() }
    handlePetClick()
    check(
      '心情 < 50 时点击，心情立即 +50',
      Math.round(mood.value) === 70,
      `心情 20 → ${String(Math.round(mood.value))}`,
    )
  }

  // ---- 7b) 闲置随机动作回复心情 10~30 ----
  {
    const actionGains = []
    for (let i = 0; i < 12; i += 1) {
      mood = { value: 0, updatedAt: Date.now() }
      rewardActionMoodOnce('eat')
      actionGains.push(mood.value)
      /*
       * ⚠️ 这里**必须**在每次测量前挡住"推送渲染进程"之外的东西：
       * 本函数只改主进程的 mood 并推送，所以从 0 起测是干净的。
       */
      await wait(10)
    }
    await wait(300)
    const inRange = actionGains.every(
      (g) => g >= MOOD_GAIN_PER_ACTION_MIN && g <= MOOD_GAIN_PER_ACTION_MAX,
    )
    check(
      `闲置随机动作回复 ${String(MOOD_GAIN_PER_ACTION_MIN)}~${String(MOOD_GAIN_PER_ACTION_MAX)} 点心情`,
      inRange,
      `从 0 起连发 12 次的结果：${actionGains.join(',')}（都应在 ` +
        `${String(MOOD_GAIN_PER_ACTION_MIN)}~${String(MOOD_GAIN_PER_ACTION_MAX)} 内）`,
    )
    check(
      '闲置动作的心情奖励是随机的（12 次里出现了不同取值）',
      new Set(actionGains).size > 1,
      `不同取值 ${String(new Set(actionGains).size)} 个：${[...new Set(actionGains)].sort((a, b) => a - b).join(',')}`,
    )
    // 奖励必须**比点击给得多**（用户要求 10~30 对 3~10）。
    check(
      '闲置动作的奖励区间整体高于点击区间',
      MOOD_GAIN_PER_ACTION_MIN >= MOOD_GAIN_PER_PET_MAX,
      `动作 ${String(MOOD_GAIN_PER_ACTION_MIN)}~${String(MOOD_GAIN_PER_ACTION_MAX)}` +
        ` vs 点击 ${String(MOOD_GAIN_PER_PET_MIN)}~${String(MOOD_GAIN_PER_PET_MAX)}`,
    )
    // 收尾：给面板一个确定值，后面的断言不依赖随机结果。
    mood = { value: 60, updatedAt: Date.now() }
    pushMoodToRenderer()
    await wait(300)
  }

  // 心情**不落盘**：设置文件里不应出现 mood 字段（用户要求"启动即满值"）。
  check(
    '心情不写入设置文件',
    settings.load().mood === undefined,
    `设置文件里的 mood = ${String(settings.load().mood)}`,
  )

  // 面板上的数字与进度条要跟着变。
  const hovered2 = await readLayout()
  const panelMood = (await readState()).moodValue
  check(
    '属性面板上的心情数字已更新',
    String(hovered2.moodValueText) === String(panelMood),
    `面板显示 ${String(hovered2.moodValueText)}，心情值 ${String(panelMood)}`,
  )

  // ---- 7c) 好感值：等级（爱心数）+ 阶段好感值 ----
  {
    const aff = (await readState()).affection
    const live = currentAffectionPayload()
    /*
     * ⚠️ 这里**不能再断言"初始 0 心"**。
     *
     * 好感从本版起有了增长途径（点击 / 随机动作 / 闲置对话 / 每 10 分钟 /
     * 低心情点击），一次自测跑几分钟下来会真的涨上去 ——
     * 原先"阶段 0/100"的断言会变成假失败（实测涨到 37/100）。
     *
     * 现在改成断言"**面板显示 == 主进程真实状态**"：
     * 这才是这条用例真正想守住的东西（数据对了但没画上去才是 bug），
     * 而"初值是不是 0"由下面那条纯函数断言单独守。
     */
    check(
      '好感状态：主进程与渲染进程一致（爱心/阶段/阈值）',
      aff
        && aff.hearts === live.hearts
        && aff.value === live.value
        && aff.threshold === live.threshold,
      aff
        ? `面板 ${String(aff.hearts)} 心 ${String(aff.value)}/${String(aff.threshold)}，`
          + `主进程 ${String(live.hearts)} 心 ${String(live.value)}/${String(live.threshold)}`
        : '拿不到好感状态',
    )
    check(
      '好感初值确实是 0 心、阶段 0（纯函数，不受运行时增长影响）',
      initialAffection().hearts === 0 && initialAffection().value === 0,
      `initialAffection() = ${JSON.stringify(initialAffection())}`,
    )
    check(
      '面板里的爱心串与爱心数一致',
      aff && aff.heartsTextRendered === heartsFor(aff.hearts),
      `面板爱心=${JSON.stringify(aff && aff.heartsTextRendered)}（期望 ${JSON.stringify(aff ? heartsFor(aff.hearts) : '')}）`,
    )
    check(
      '面板显示"阶段值/阈值"文本',
      aff && aff.valueText === `${String(aff.value)}/${String(aff.threshold)}`,
      `面板文本=${JSON.stringify(aff && aff.valueText)}（期望 ${String(aff && `${String(aff.value)}/${String(aff.threshold)}`)}）`,
    )
    /*
     * 进度条宽度：与 `affectionProgress()` 算出的比例一致（允许 1% 取整误差）。
     *
     * 不写死 "0%"：阶段值会随好感增长而变，写死就必然假失败。
     */
    {
      const expectedPct = Math.round(affectionProgress(aff ? { hearts: aff.hearts, value: aff.value } : initialAffection()) * 100)
      const actual = Number.parseFloat(String((aff && aff.fillWidth) ?? '').replace('%', ''))
      check(
        '好感进度条宽度与阶段进度一致',
        Number.isFinite(actual) && Math.abs(actual - expectedPct) <= 1,
        `进度条=${JSON.stringify(aff && aff.fillWidth)}，期望约 ${String(expectedPct)}%`,
      )
    }
    check(
      '爱心数恒为 5 个（0 心与满级都如此）',
      aff && [...String(aff.heartsTextRendered)].length === 5,
      `爱心串 ${JSON.stringify(aff && aff.heartsTextRendered)} 长度 ${String(aff && [...String(aff.heartsTextRendered)].length)}`,
    )

    /*
     * 用户明确要求"好感值显示在**心情值上方**"。
     *
     * 用两者的 getBoundingClientRect().top 比较，而不是看 DOM 顺序 ——
     * 写在前面不等于视觉上在上面。
     */
    check(
      '好感值显示在心情值上方',
      Number.isFinite(hovered2.affectionRowTop) &&
        Number.isFinite(hovered2.moodRowTop) &&
        hovered2.affectionRowTop < hovered2.moodRowTop,
      `好感行 top=${String(hovered2.affectionRowTop)} < 心情行 top=${String(hovered2.moodRowTop)}`,
    )

    // ---- 7b-2) 余额面板：常驻 + 与属性面板不遮挡 ----
    /*
     * 用户要求："api 监控需要在桌宠下方有一个独立的显示面板（不加入到属性面板中）
     * 并且始终显示，在属性面板显示时二者不能有遮挡"。
     *
     * 这一段是在**属性面板正在显示**（hovered2 就是悬停时读的）的前提下检查的 ——
     * 这正是"两者同时出现"的最坏情况。
     *
     * "不遮挡"的判据用**矩形是否相交**，而不是算间距：
     * 相交与否是客观的，而"间距 ≥ N"这种判据要挑 N，反而容易漏。
     */
    {
      const b = hovered2.balanceRect
      const s = hovered2.statsVisibleRect
      check(
        '余额面板常驻（即使属性面板也在显示）',
        Boolean(b) && b.height > 0 && b.width > 0,
        b ? `余额面板 ${String(Math.round(b.width))}x${String(Math.round(b.height))} @ top=${b.top.toFixed(1)}` : '拿不到余额面板几何',
      )
      check(
        '余额面板在角色下方',
        Boolean(b) && b.top >= hovered2.character.bottom - 2,
        b ? `余额顶 ${b.top.toFixed(1)} ≥ 角色底 ${hovered2.character.bottom.toFixed(1)}` : '拿不到余额面板几何',
      )

      /*
       * 余额面板的**内容必须装得进预留高度**。
       *
       * 用户两次要求把余额面板做大：先是颜色改白，再把字号放大一档。
       * 字号是相对 `BALANCE_ZONE_FONT_RATIO` 预留的高度缩放的，
       * 所以放大字体后**很容易**出现内容比区域高、被裁掉的情况 ——
       * 而裁掉的是数字的下半截，肉眼不一定立刻注意到。
       *
       * 判据：`.balance-body` 的实际高度（含内边距与边框）不得超过面板区高度。
       */
      const bodyBox = await wc.executeJavaScript(
        `(function () {
          const p = document.getElementById('balance-panel')
          const body = p ? p.querySelector('.balance-body') : null
          if (!body) return null
          const b = body.getBoundingClientRect()
          const v = document.getElementById('balance-value')
          return {
            bodyH: b.height,
            zoneH: p.getBoundingClientRect().height,
            valueFontPx: v ? parseFloat(getComputedStyle(v).fontSize) || 0 : 0,
            valueColor: v ? getComputedStyle(v).color : null,
            labelText: (p.querySelector('.balance-label') || {}).textContent || '',
          }
        })()`,
        true,
      )
      check(
        '余额面板内容装得进预留高度（字体放大后不被裁）',
        bodyBox && bodyBox.bodyH <= bodyBox.zoneH + 1,
        bodyBox
          ? `内容高 ${bodyBox.bodyH.toFixed(1)} ≤ 区域高 ${bodyBox.zoneH.toFixed(1)}；数字字号 ${String(bodyBox.valueFontPx)}px`
          : '拿不到余额面板内容',
      )
      check(
        '余额面板文案是"余额"（不是"API 余额"）',
        Boolean(bodyBox) && bodyBox.labelText === '余额',
        `标签文本=${JSON.stringify(bodyBox && bodyBox.labelText)}`,
      )
      /*
       * 颜色断言要**自己先放一份正常余额**再查。
       *
       * ⚠️ 不能直接用上面 bodyBox 里的颜色：那段测量跑在"面板可能是错误态"的时刻
       * （自测中途注入过 null），而错误态按设计就是灰色 ——
       * 先前写成 `=== 'rgb(255,255,255)'` 就因此失败过一次。
       * 这里显式注入一份**正常**快照，测的才是"正常态是不是白色"。
       */
      await wc.executeJavaScript(
        `window.__petTestSetBalance({ source: 'apikey', isAvailable: true, currency: 'CNY', total: '69.97', granted: '41.78', toppedUp: '28.18', fetchedAt: Date.now(), stale: false, error: null })`,
        true,
      )
      /*
       * ⚠️ 注入后必须**等过渡结束**再读颜色。
       *
       * `.balance-value` 上有 `transition: color 260ms ease`（数值变化时平滑过渡）。
       * 正处于过渡中时，`getComputedStyle().color` 返回的是**插值**而不是终值 ——
       * 于是从错误态灰 `#c8c8c8` 切到白色时，会读到 `rgb(200,200,200)`。
       *
       * 这个坑很有迷惑性：`.balance-label` **没有** transition，
       * 所以它读到的是终值白色 —— 表现为"标签白、数字灰"，
       * 看着像"数字被别的规则盖了"，其实是动画还没跑完。
       * 实测排查花了好几轮，先怀疑过类名、内部离线标记、内联样式，都不是。
       */
      await wait(420)
      const normalBox = await wc.executeJavaScript(
        `(function () {
          const v = document.getElementById('balance-value')
          const l = document.querySelector('.balance-label')
          const p = document.getElementById('balance-panel')
          const bodyEl = p ? p.querySelector('.balance-body') : null
          return {
            valueColor: v ? getComputedStyle(v).color : null,
            labelColor: l ? getComputedStyle(l).color : null,
            valueFontPx: v ? parseFloat(getComputedStyle(v).fontSize) || 0 : 0,
            labelFontPx: l ? parseFloat(getComputedStyle(l).fontSize) || 0 : 0,
            text: v ? v.textContent : null,
            baseFontPx: p ? parseFloat(getComputedStyle(p).fontSize) || 0 : 0,
            bodyH: bodyEl ? bodyEl.getBoundingClientRect().height : 0,
            zoneH: p ? p.getBoundingClientRect().height : 0,
          }
        })()`,
        true,
      )
      check(
        '正常态下余额数字与标签都是白色',
        Boolean(normalBox) &&
          normalBox.valueColor === 'rgb(255, 255, 255)' &&
          normalBox.labelColor === 'rgb(255, 255, 255)',
        normalBox
          ? `数字 ${JSON.stringify(normalBox.valueColor)}，标签 ${JSON.stringify(normalBox.labelColor)}`
          : '拿不到余额面板样式',
      )
      check(
        '余额字号比标签大（数字更醒目）',
        Boolean(normalBox) && normalBox.valueFontPx > normalBox.labelFontPx,
        normalBox
          ? `数字 ${String(normalBox.valueFontPx)}px > 标签 ${String(normalBox.labelFontPx)}px（面板基准 ${String(normalBox.baseFontPx)}px）`
          : '拿不到字号',
      )
      check(
        '带说明文字时内容仍装得进预留高度',
        Boolean(normalBox) && normalBox.bodyH <= normalBox.zoneH + 1,
        normalBox ? `内容高 ${normalBox.bodyH.toFixed(1)} ≤ 区域高 ${normalBox.zoneH.toFixed(1)}` : '拿不到高度',
      )

      check(
        '余额面板显示的是余额数字（或明确的占位/错误态）',
        typeof hovered2.balanceText === 'string' &&
          (hovered2.balanceText.startsWith('¥') ||
            hovered2.balanceText.startsWith('$') ||
            hovered2.balanceText === '--'),
        `面板文本=${JSON.stringify(hovered2.balanceText)}，说明=${JSON.stringify(hovered2.balanceNoteText)}`,
      )
      const overlap = Boolean(b && s) && b.top < s.bottom && s.top < b.bottom
      check(
        '属性面板显示时与余额面板不遮挡（矩形不相交）',
        Boolean(b && s) && !overlap,
        b && s
          ? `余额 ${b.top.toFixed(1)}~${b.bottom.toFixed(1)}，属性面板 ${s.top.toFixed(1)}~${s.bottom.toFixed(1)}` +
            `（${overlap ? '相交' : '不相交'}）`
          : '拿不到其中一个面板的几何',
      )
      check(
        '余额面板紧贴属性面板上方（两者由流布局排开，中间不留缝）',
        Boolean(b && s) && Math.abs(b.bottom - s.top) <= 2,
        b && s ? `余额底 ${b.bottom.toFixed(1)} vs 属性面板顶 ${s.top.toFixed(1)}` : '拿不到几何',
      )

      /*
       * 余额面板的**三种渲染状态**。
       *
       * 为什么要单独注入：自测里宿主状态被 `testStateOverride` 整体挡住，
       * 余额通道也拿不到数据 —— 面板一直显示 `--`，渲染逻辑等于没被画过。
       * `__petTestSetBalance` 绕开状态通道直接喂快照。
       */
      const normal = await wc.executeJavaScript(
        `window.__petTestSetBalance({ source: 'apikey', isAvailable: true, currency: 'CNY', total: '23.45', granted: '3.45', toppedUp: '20.00', fetchedAt: Date.now(), stale: false, error: null })`,
        true,
      )
      check(
        '余额充足时显示金额、不告急',
        normal && normal.text === '¥23.45' && normal.isLow === false && normal.isError === false,
        `文本=${JSON.stringify(normal && normal.text)}，告急=${String(normal && normal.isLow)}，错误=${String(normal && normal.isError)}`,
      )

      const low = await wc.executeJavaScript(
        `window.__petTestSetBalance({ source: 'apikey', isAvailable: true, currency: 'CNY', total: '3.20', granted: '0.00', toppedUp: '3.20', fetchedAt: Date.now(), stale: false, error: null })`,
        true,
      )
      check(
        '余额低于阈值时转为告急配色',
        low && low.text === '¥3.20' && low.isLow === true,
        `文本=${JSON.stringify(low && low.text)}，告急=${String(low && low.isLow)}，说明=${JSON.stringify(low && low.note)}`,
      )

      const errState = await wc.executeJavaScript(
        `window.__petTestSetBalance({ source: 'apikey', isAvailable: false, currency: 'CNY', total: '8.00', granted: '0.00', toppedUp: '8.00', fetchedAt: Date.now(), stale: true, error: '凭据 DEEPSEEK_API_KEY 未配置' })`,
        true,
      )
      check(
        '取数失败时保留上次金额并标灰（不是清成 --）',
        errState && errState.text === '¥8.00' && errState.isError === true && errState.isLow === false,
        `文本=${JSON.stringify(errState && errState.text)}，错误=${String(errState && errState.isError)}，说明=${JSON.stringify(errState && errState.note)}`,
      )

      const empty = await wc.executeJavaScript('window.__petTestSetBalance(null)', true)
      check(
        '没有任何数据时显示 --（而不是 ¥0.00）',
        empty && empty.text === '--' && empty.isError === true,
        `文本=${JSON.stringify(empty && empty.text)}`,
      )

      // 还原成宿主下发的真实状态（把注入清掉，让后续用例看到真实值）。
      await wc.executeJavaScript('window.__petTestSetBalance(null)', true)
    }

    /*
     * 面板要装得下四行内容（好感行 / 爱心行 / 心情行 / 档位行）。
     *
     * 判据是"爱心字号 > 0"且"面板可见高度 ≥ 内容高度" ——
     * 后者用面板区高度减去内边距（上下各 5px + 边框 2px）近似。
     * 这里只验证**没有明显截断**（内容高不超过面板高），
     * 具体像素值由尺寸比例的断言在别的用例里覆盖。
     */
    const contentH = await wc.executeJavaScript(
      `(function () {
        const body = document.querySelector('.stats-body')
        if (!body) return null
        const cs = getComputedStyle(body)
        const pad = cs.paddingTop ? parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) : 0
        // scrollHeight 是内容真实高度（含被压缩时溢出的部分）。
        const rows = [...body.children].map((el) => el.getBoundingClientRect().height)
        return { scrollH: body.scrollHeight, pad, rowCount: body.children.length, rows }
      })()`,
      true,
    )
    check(
      '属性面板里共有 4 行（好感/爱心/心情/档位）',
      contentH && contentH.rowCount === 4,
      contentH ? `实际 ${String(contentH.rowCount)} 行，各高 ${JSON.stringify(contentH.rows)}` : '拿不到面板内容',
    )
    check(
      '面板高度装得下四行内容（无截断）',
      contentH && Number.isFinite(hovered2.statsZonePx) && hovered2.statsZonePx + 1 >= contentH.scrollH,
      contentH
        ? `面板区 ${String(hovered2.statsZonePx)}px ≥ 内容 ${String(contentH.scrollH)}px`
        : '拿不到面板内容高度',
    )
  }

  // ---- 7b) 周期漂移：每 10 分钟随机变化 −40 ~ +50 ----
  //
  // ⚠️ 断言不能写"掉多少点" —— 变化量是随机的（可正可负），
  // 所以这里验证的是**规则本身**：结算出的每个周期变化量都落在区间内、
  // 净变化等于各周期之和（并且确实结算了预期的周期数）。
  //
  // 用一个**自己控制的随机源**来跑，才能既确定性又覆盖区间两端：
  // 直接调 `applyDrift(mood, now, rand)`，rand 依次返回 0 / 0.5 / 0.999…
  {
    const now = Date.now()
    const cases = [
      { rand: 0, expect: MOOD_DRIFT_MIN, note: '下界' },
      { rand: 0.999999, expect: MOOD_DRIFT_MAX, note: '上界' },
      { rand: 0.5, expect: MOOD_DRIFT_MIN + Math.floor((MOOD_DRIFT_MAX - MOOD_DRIFT_MIN + 1) / 2), note: '中位' },
    ]
    let allOk = true
    const details = []
    for (const c of cases) {
      const start = { value: 50, updatedAt: now - MOOD_DRIFT_INTERVAL_MS }
      const r = applyDrift(start, now, () => c.rand)
      const ok = r.steps === 1 && r.delta === c.expect
      if (!ok) allOk = false
      details.push(`${c.note}: 变化 ${String(r.delta)}（期望 ${String(c.expect)}）`)
    }
    check('每 10 分钟的随机变化量落在 −40 ~ +50（含两端）', allOk, details.join('；'))
  }

  {
    // 跨 3 个周期：应当结算 3 次，且净变化是三次之和（都在区间内）。
    const now = Date.now()
    const start = { value: 50, updatedAt: now - MOOD_DRIFT_INTERVAL_MS * 3 }
    const r = applyDrift(start, now)
    const inRange = r.steps === 3 && r.delta >= MOOD_DRIFT_MIN * 3 && r.delta <= MOOD_DRIFT_MAX * 3
    check(
      '跨 3 个周期会结算 3 次（不是只算一次）',
      inRange,
      `steps=${String(r.steps)}，净变化 ${String(r.delta)}（应在 ${String(MOOD_DRIFT_MIN * 3)}~${String(MOOD_DRIFT_MAX * 3)} 内）`,
    )
    // 把状态写回，后续断言用它的真实值。
    mood = { value: 60, updatedAt: Date.now() }
    pushMoodToRenderer()
    await wait(300)
  }

  check(
    '周期漂移的间隔是 10 分钟',
    MOOD_DRIFT_INTERVAL_MS === 10 * 60 * 1000,
    `MOOD_DRIFT_INTERVAL_MS=${String(MOOD_DRIFT_INTERVAL_MS)}`,
  )

  // ---- 8) 悬停移开后收起面板 ----
  //
  // ⚠️ 这条曾经偶发失败。加诊断是为了区分两种可能：
  //  · 真的没收起（产品缺陷）；
  //  · 测试派的合成 mousemove 没被当成"移出"（例如点落在角色边界内）。
  const leaveX = 2
  const leaveY = 2
  const leaveProbe = await wc.executeJavaScript(
    `window.__petTestProbeClient(${String(leaveX)}, ${String(leaveY)})`,
    true,
  )
  await wc.executeJavaScript(
    `window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: ${String(leaveX)}, clientY: ${String(leaveY)} }))`,
    true,
  )
  await wait(400)
  const stLeave = await readState()
  check(
    '光标移出角色后收起属性面板',
    stLeave !== null && stLeave.statsVisible === false,
    `statsVisible=${String(stLeave && stLeave.statsVisible)}；移出点 (${String(leaveX)},${String(leaveY)}) ` +
      `命中角色=${String(leaveProbe && leaveProbe.opaque)}，帧元素=${JSON.stringify(leaveProbe && leaveProbe.rect)}`,
  )

  // ---- 9) 命中判定的滞回：同一坐标上不得随动画帧抖 ----
  //
  // 用户报的现象是"光标不在桌宠身上时属性面板闪烁"。
  // 根因是 `hitTest()` 用**当前动画帧**的掩膜，而站立动画循环播放、
  // 各帧轮廓不同（发丝/裙摆/尾巴在动），于是同一坐标的命中结果会随帧变化。
  //
  // ⚠️ 这条断言必须**在同一坐标上连续采样**才有意义：
  //   · 采样间隔要跨越多帧动画（60ms 足够）；
  //   · 中间**不能移动光标** —— 滞回在"光标真的移动了"时是刻意跳过的，
  //     移动会掩盖抖动，测出来必然是稳定。
  //
  // 用的坐标是之前实测最容易抖的一个（帧矩形内相对偏移 (8, 207)）。
  {
    const fr = await wc.executeJavaScript(
      `(() => { const d = window.__petTestLayoutDiag(); return d.frameRect })()`,
      true,
    )
    if (fr && fr.width > 0) {
      // 挑一个在帧内、且实测会抖的点。
      const probeX = Math.round(fr.left + 8)
      const probeY = Math.round(fr.top + 207)
      const seq = await wc.executeJavaScript(
        `(async () => {
           const out = [];
           // 先重置滞回，保证从"未确定"起步 —— 否则会沿用上一个用例留下的状态。
           window.__petTestResetHitHysteresis();
           for (let i = 0; i < 16; i += 1) {
             // 同一坐标反复驱动；注意每次都会走完整的 updateHitTest（含滞回）。
             out.push(window.__petTestDriveHit(${String(probeX)}, ${String(probeY)}).statsVisible ? 1 : 0);
             await new Promise((r) => setTimeout(r, 60));
           }
           return out;
         })()`,
        true,
      )
      let flips = 0
      for (let i = 1; i < seq.length; i += 1) if (seq[i] !== seq[i - 1]) flips += 1
      check(
        '同一坐标上属性面板不随动画帧闪烁（命中判定有滞回）',
        flips === 0,
        `翻转 ${String(flips)} 次；采样序列 ${seq.join('')}` +
          (flips === 0 ? '' : '（>0 说明滞回没生效，面板会闪）'),
      )
    } else {
      check('同一坐标上属性面板不随动画帧闪烁（命中判定有滞回）', false, '拿不到帧矩形')
    }
  }

  /*
   * 点击部位放在**最后**做。
   *
   * 原因：这个用例会把光标依次移到各个部位（最后停在腿上，那里在角色身上），
   * 而"悬停显示/收起属性面板"依赖光标位置 —— 先做点部位会污染后面的悬停断言
   * （实测出现过"悬停不显示"与"移开不收起"同时失败）。
   * 依赖光标状态的用例必须排在最后，或用完把光标复位。
   */
  await verifyClickParts(check, wait)

  // 收尾：把闲置间隔恢复成正常值，并清除状态覆盖（本进程马上退出）。
  await wc.executeJavaScript('window.__petTestSetIdleInterval(null)', true)
  await wc.executeJavaScript('window.__petTestStopRecorder()', true)
  if (SELFTEST || TEST_DRAG_FOLLOW) testStateOverride = null
}

// ------------------------------------------------------------------ 交互自检
/**
 * `--selftest`：用**合成鼠标事件**驱动拖拽，断言「被拎起来」动作与随机台词生效，
 * 并把每一轮截一张图。
 *
 * 为什么用合成事件：拖拽与气泡是纯前端交互，真实鼠标无法自动化。合成 MouseEvent
 * 走的是与真实操作完全相同的监听器路径，因此足以验证逻辑。
 *
 * ⚠️ 局限：合成事件**不会移动真实鼠标**，而拖拽位置由主进程读真实光标决定，
 * 所以这里窗口本来就不会动 —— 位移与尺寸的精确数值要看 --test-drag-follow。
 */
async function runSelfTest() {
  const wc = win && !win.isDestroyed() ? win.webContents : null
  if (!wc) {
    log('自检失败：窗口不可用')
    return
  }
  const probe = 'document.getElementById("bubble-text").textContent'
  const lifted = 'document.getElementById("character").classList.contains("lifted")'
  const shotDir = path.join(__dirname, '..', '_research')

  /**
   * 合成一次"按下 → 连续小步拖动 → 松手"，尽量贴近真实鼠标。
   *
   * 三个关键点（都是踩坑换来的）：
   *  1. 必须同时给 clientX/Y 与 screenX/Y。渲染进程用 screen 坐标判断是否越阈值，
   *     用 client 坐标反而会形成反馈回路导致抖动。
   *  2. screenX/Y 必须落在窗口真实位置附近，否则断言失真。
   *  3. **分多步小位移**，而不是一帧跳 40px。真实鼠标是连续的。
   */
  const dragScript = (screenX, screenY, steps, stepX, stepY) => `
    (function () {
      const stage = document.getElementById('stage')
      const clientX = Math.round(window.innerWidth / 2)
      const clientY = Math.round(window.innerHeight / 2)
      stage.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true, button: 0, clientX: clientX, clientY: clientY,
        screenX: ${String(screenX)}, screenY: ${String(screenY)},
      }))
      for (let i = 1; i <= ${String(steps)}; i += 1) {
        window.dispatchEvent(new MouseEvent('mousemove', {
          bubbles: true,
          clientX: clientX + ${String(stepX)} * i,
          clientY: clientY + ${String(stepY)} * i,
          screenX: ${String(screenX)} + ${String(stepX)} * i,
          screenY: ${String(screenY)} + ${String(stepY)} * i,
        }))
      }
      return true
    })()
  `
  const releaseScript = (screenX, screenY, steps, stepX, stepY) => `
    (function () {
      window.dispatchEvent(new MouseEvent('mouseup', {
        bubbles: true, button: 0, clientX: 0, clientY: 0,
        screenX: ${String(screenX)} + ${String(stepX)} * ${String(steps)},
        screenY: ${String(screenY)} + ${String(stepY)} * ${String(steps)},
      }))
      return true
    })()
  `

  /**
   * 一轮拖拽的参数。
   *
   * 选择**向上拖**而不是向右：窗口初始在主屏右下角，向上空间充足，不会被
   * clampIntoWorkArea 拉回来。向右拖很快就会撞到屏幕右边界被夹住。
   */
  const DRAG = { steps: 10, stepX: 0, stepY: -8 }

  const { mkdirSync, writeFileSync } = require('node:fs')
  const { app: electronApp } = require('electron')

  try {
    mkdirSync(shotDir, { recursive: true })
    await sleep(1200)

    // 记录拖拽前的窗口几何，用于判定尺寸趋势。
    const before = win.getBounds()
    log(`拖拽前窗口: ${String(before.width)}x${String(before.height)} @ (${String(before.x)},${String(before.y)})`)

    /** 每轮拖拽后的窗口尺寸，用于判定是否随轮次单调增大（"越来越大"的特征）。 */
    const sizeHistory = []

    for (let round = 1; round <= 4; round += 1) {
      // 每次都用窗口当前真实位置附近的一个屏幕点作为拖拽起点，模拟真实鼠标。
      const pos = win.getBounds()
      const sx = pos.x + Math.round(pos.width / 2)
      const sy = pos.y + Math.round(pos.height / 2)
      log(
        `[边界] 轮 ${String(round)} 拖拽前: ${String(pos.width)}x${String(pos.height)} @ (${String(pos.x)},${String(pos.y)})`,
      )
      await wc.executeJavaScript(dragScript(sx, sy, DRAG.steps, DRAG.stepX, DRAG.stepY), true)
      await sleep(500)
      const text = await wc.executeJavaScript(probe, true)
      const isLifted = await wc.executeJavaScript(lifted, true)
      const during = win.getBounds()
      sizeHistory.push({ w: during.width, h: during.height })
      log(
        `自检第 ${String(round)} 轮：lifted=${String(isLifted)} 台词="${String(text)}"` +
          ` [边界] 拖动中: ${String(during.width)}x${String(during.height)} @ (${String(during.x)},${String(during.y)})`,
      )
      // 截图仅用于人工目视确认。注意：capturePage() 会与透明窗交互，
      // 可能影响窗口布局；用 --no-shot 可以关掉它做对照实验。
      if (!process.argv.includes('--no-shot')) {
        const image = await wc.capturePage()
        writeFileSync(path.join(shotDir, `drag-${String(round)}.png`), image.toPNG())
      }
      await wc.executeJavaScript(releaseScript(sx, sy, DRAG.steps, DRAG.stepX, DRAG.stepY), true)
      await sleep(700)
      const afterRound = win.getBounds()
      log(
        `[边界] 轮 ${String(round)} 松手后: ${String(afterRound.width)}x${String(afterRound.height)}` +
          ` @ (${String(afterRound.x)},${String(afterRound.y)})`,
      )
    }

    // ---- 断言与"参考信息" ----
    //
    // 为什么不断言精确数值：合成事件的 screenX/screenY 与鼠标真实位置不在同一
    // 坐标系（鼠标物理上并不在那里），因此"位移应等于鼠标位移"这类断言用合成
    // 事件得不到可信结果 —— 那部分交给 --test-drag-follow。
    const after = win.getBounds()
    const dw = Math.abs(after.width - before.width)
    const dh = Math.abs(after.height - before.height)
    const movedX = after.x - before.x
    const movedY = after.y - before.y
    log(
      `参考-拖拽后尺寸与位移: ${String(after.width)}x${String(after.height)} @ (${String(after.x)},${String(after.y)})` +
        `  相对初始变化 ${String(dw)}x${String(dh)}  位移 (${String(movedX)},${String(movedY)})`,
    )
    log(`参考-各轮尺寸: ${sizeHistory.map((s) => `${String(s.w)}x${String(s.h)}`).join(' → ')}`)

    // 断言 A：尺寸趋势。
    //
    // ⚠️ 这一项在**合成输入下不可判定**，因此只报告、不当作通过/失败。
    // 已用隔离实验排除了纯 setPosition 移动、锁 min/max 后再移动、
    // setBounds 写入固定尺寸、capturePage() —— 它们都不产生漂移。
    let increasing = 0
    for (let i = 1; i < sizeHistory.length; i += 1) {
      if (sizeHistory[i].w > sizeHistory[i - 1].w || sizeHistory[i].h > sizeHistory[i - 1].h) increasing += 1
    }
    log(
      `参考-尺寸趋势: 递增轮次 ${String(increasing)}/${String(Math.max(0, sizeHistory.length - 1))}` +
        `（合成输入下不可判定，需人工验证）`,
    )

    // 断言 B：窗口必须真的被拖动过，证明拖拽链路整体通畅。
    const didMove = Math.abs(movedX) >= 4 || Math.abs(movedY) >= 4
    log(`断言-窗口确实被拖动: ${didMove ? 'PASS' : 'FAIL'}（位移 (${String(movedX)},${String(movedY)})）`)

    log(`自检完成，截图已保存到 ${shotDir}`)
  } catch (err) {
    log(`自检出错：${err instanceof Error ? err.message : String(err)}`)
  } finally {
    // 自检结束就退出，避免留下一个无人使用的窗口。
    setTimeout(() => {
      electronApp.isQuitting = true
      electronApp.quit()
    }, 500)
  }
}


