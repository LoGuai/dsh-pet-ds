/**
 * 桌宠渲染进程。
 *
 * 本阶段职责（刻意的边界）：
 *   · 拖拽移动窗口（点选与拖拽用位移阈值区分）
 *   · 点击 Q 弹反馈
 *   · 自动眨眼
 *   · 显示宿主推来的工作状态与台词气泡
 *   · 宿主离线时给出提示，并在恢复后自动隐藏
 *
 * 它不做任何网络请求：所有数据由主进程通过 IPC 推来（余额数字也是），
 * 因此页面里没有、也永远不会有 API Key。
 */

/* eslint-env browser */

const stage = document.getElementById('stage')
const character = document.getElementById('character')
const frameEl = document.getElementById('frame')
const bubble = document.getElementById('bubble')
const bubbleText = document.getElementById('bubble-text')
const offlineTag = document.getElementById('offline')
const bubbleAreaEl = document.querySelector('.bubble-area')
const statsPanel = document.getElementById('stats-panel')
const balancePanel = document.getElementById('balance-panel')
const balanceValueEl = document.getElementById('balance-value')
const balanceNoteEl = document.getElementById('balance-note')
const moodFill = document.getElementById('mood-fill')
const moodValueEl = document.getElementById('mood-value')
const moodTierEl = document.getElementById('mood-tier')
const affectionFill = document.getElementById('affection-fill')
const affectionValueEl = document.getElementById('affection-value')
const affectionHeartsEl = document.getElementById('affection-hearts')

/** 判定为点击而非拖拽的位移阈值（像素）。 */
const CLICK_THRESHOLD_PX = 4

/**
 * 是否**容忍**"拖拽中 mousemove 报告 buttons === 0"。
 *
 * 生产环境必须是 `false`：那是"mouseup 丢了"的补救信号（见 mousemove 处理器）。
 * 但自测用合成 mousedown 起拖，真实鼠标键并未按下，于是任何一次真实 mousemove
 * 都会带着 `buttons === 0` 把拖拽提前取消 —— 造成偶发失败。
 * 测试开始时把它置为 true，见 `window.__petTestTolerateButtonsZero`。
 */
let tolerateButtonsZero = false

/** 角色画布宽高比。素材已裁去透明留白，为 864×1157。 */
const ASPECT_W = 864
const ASPECT_H = 1157

/** 基准档位的角色宽度；字号按"宽度 ÷ FONT_WIDTH_DIVISOR"等比换算。 */
const PET_WIDTH_BASE = 240
const FONT_WIDTH_DIVISOR = 20
const BUBBLE_FONT_AT_BASE_PX = 12
/**
 * 字号下限只用于防止极窄窗口下文字不可读。
 * 刻意取很小，这样在所有**可选档位**内字号都不被夹 ——
 * "面板随桌宠等比缩放"才严格成立。
 */
const BUBBLE_FONT_MIN_PX = 6

/**
 * 气泡区与属性面板区的高度比例（相对目标角色宽度）。
 *
 * 这两个比例是**设计的一部分**，必须与主进程里的同名常量保持一致：
 * 主进程用它们算窗口该多大，渲染进程用它们算内部怎么分。
 * 两边不一致就会出现"窗口给了空间但内容没占满"的空隙。
 */
const BUBBLE_AREA_RATIO = 0.3
const STATS_ZONE_RATIO = 0.16

/**
 * 属性面板区高度 = 字号 × 这个系数。**必须与 main.js 里的
 * STATS_ZONE_FONT_RATIO 完全一致**。
 *
 * ⚠️ 这里踩过一个代价不小的坑：这个常量一度只在 main.js 定义，
 * 而 renderer.js 的 applyLayout 也用了同名变量却忘了声明 —— 结果
 * `Math.round(font * undefined)` 得到 NaN，尺寸被赋成非法的 `"NaNpx"`，
 * **浏览器会静默忽略非法样式**，元素于是退回素材原始尺寸（864×1157）。
 * 表现为"窗口变了、立绘不变"，而且控制台没有任何报错。
 */
const STATS_ZONE_FONT_RATIO = 7.0

/**
 * 余额面板区高度 = 面板字号 × 这个系数。**必须与 main.js 里的
 * BALANCE_ZONE_FONT_RATIO 完全一致**。
 *
 * 余额面板是**常驻**的（用户要求），所以它占窗口里单独预留的一块区域，
 * 而不是叠在别的东西上面。属性面板有它自己那块 —— 两者由流布局排开，
 * 因此"属性面板显示时盖住余额面板"在几何上不可能发生。
 *
 * 比例 3.0 是"一行较大的数字 + 一行小说明"需要的高度 ——
 * 实测（区域 23px vs 内容 24px）2.6 还差一点，说明行的高度被我低估了。
 * 比属性面板（4 行，7.0）矮得多。字体放大过一档（用户反馈原来太不明显），
 * 所以这个比例从 2.2 跟着提到 3.0 —— **改字体大小就要同步改这里**。
 */
const BALANCE_ZONE_FONT_RATIO = 3.0

/**
 * 长按多久才进入"被拎起来"。
 * 借鉴参考项目：单击（想触发互动）不应该闪出拎起动作，所以拎起需要按住一小会儿。
 * 180ms 与参考项目一致。
 */
const LIFT_HOLD_MS = 180

/** 拖拽动画的素材 id（对应 assets/animations/hang）。 */
const DRAG_ANIMATION_ID = 'hang'

/**
 * 睡觉与惊醒的素材 id。
 *
 * ⚠️ 必须与 src/shared-core/actions.js 里的 SLEEP_ACTION_ID / WAKE_ACTION_ID
 * 保持一致。渲染进程没有模块加载能力，所以这里是一份**镜像常量**；
 * 自测里有一条断言核对"清单里存在这两个 id"，防止两边写歪。
 */
const SLEEP_ACTION_ID = 'sleep'
const WAKE_ACTION_ID = 'awake'

/**
 * 睡眠尾帧循环的轮数范围（用户指定：随机 20~40 轮后结束并播惊醒动画）。
 *
 * 一轮 = 把"最后两帧"走一遍。尾帧循环是 1fps、2 帧，所以一轮约 2 秒，
 * 20~40 轮 ≈ **40~80 秒**睡眠，然后自动醒来 ——
 * 睡眠因此变成有始有终的随机动作，而不是"一直睡到被点击"。
 */
const SLEEP_TAIL_CYCLES_MIN = 20
const SLEEP_TAIL_CYCLES_MAX = 40

/** 轮数范围（测试可覆盖，便于把一轮压到极短来验证"自动醒来"）。 */
let sleepTailCyclesMin = SLEEP_TAIL_CYCLES_MIN
let sleepTailCyclesMax = SLEEP_TAIL_CYCLES_MAX

/**
 * 尾帧循环的间隔覆盖（毫秒）；null = 按帧率算。
 * 只给测试用：真睡眠是 1fps、一轮约 2 秒，20~40 轮要等 40~80 秒，
 * 测试不可能等那么久，所以需要能在测试里把一轮压到毫秒级。
 */
let tailLoopStepOverride = null

/**
 * 最近一次睡眠的尾帧循环轮数目标（诊断/测试用）。
 *
 * ⚠️ 存在的理由：`state.tailCycles` 会在下一次 `startTailLoop` / `enterSleep` 时被
 * **清零**，而醒来之后测试读到的就只剩 0 —— 明明"循环 N 轮后醒来"已经发生，
 * 断言却拿不到证据（实测就是这样）。这个变量只写不清，用于事后核对。
 */
let lastSleepTailCycles = null

/** 取本次睡眠要循环的轮数（在范围内随机，含两端）。 */
function pickSleepTailCycles() {
  const lo = Math.max(1, Math.min(sleepTailCyclesMin, sleepTailCyclesMax))
  const hi = Math.max(lo, Math.max(sleepTailCyclesMin, sleepTailCyclesMax))
  return lo + Math.floor(Math.random() * (hi - lo + 1))
}

/**
 * 工作档位文案 —— **已废弃，不再展示**（用户要求"工作状态的台词都去掉"）。
 *
 * 保留这份映射与 `pet:state` 里的 `workLabel` 通道，是为了：
 *  · 宿主仍然按协议发送状态，将来要恢复展示时不用改宿主；
 *  · 自测里还用它做断言（例如"注入的思考状态已到达渲染进程"）。
 *
 * ⚠️ 关键改动：`applyState()` 里**不再把 label 写进气泡**。
 * 工作状态现在只用于**门控**（决定闲置计时、是否打断睡眠），不产生任何台词。
 */
const WORK_LABELS = {
  thinking: '思考中…',
  working: '干活中…',
  organizing: '整理中…',
  waiting: '等待中…',
  success: '完成！',
  failure: '出错了…',
  idle: '',
}

/**
 * 被拎起来时随机弹的台词。
 * 放在渲染进程里是刻意的：这些台词不需要宿主参与，本地即时反馈体验更好
 * （不必等一次 IPC 往返）。将来若要支持用户自定义台词，再改成由宿主下发。
 */
const DRAG_LINES = ['啊！放我下来啦', '要、要干什么', '好的，现在我被用户拎起来了']

/** 上一次说过的台词下标，用于避免连续两次抽到同一句。 */
let lastDragLineIndex = -1

/**
 * 随机取一句拖拽台词，保证不与上一次重复。
 * @returns {string}
 */
function pickDragLine() {
  if (DRAG_LINES.length === 1) return DRAG_LINES[0]
  let index = lastDragLineIndex
  // 最多试 8 次，避免在极小集合上死循环。
  for (let attempt = 0; attempt < 8 && index === lastDragLineIndex; attempt += 1) {
    index = Math.floor(Math.random() * DRAG_LINES.length)
  }
  lastDragLineIndex = index
  return DRAG_LINES[index]
}

// ---------------------------------------------------------------- 拖拽状态
let dragging = false
let dragStart = null
/** 「被拎起来」的延迟计时器：长按 LIFT_HOLD_MS 后才真正拎起。 */
let liftHoldTimer = null
/** 主进程推送的最近状态，用于避免重复弹同样的气泡。 */
let lastWorkLabel = ''
/** 气泡自动隐藏的定时器，以及当前占用气泡的种类。 */
const bubbleTimers = { say: null, work: null }
/** 谁在占用气泡：'say' 优先级高于 'work'。 */
let bubbleOwner = null

// ---------------------------------------------------------------- 气泡
/**
 * 显示气泡。
 * @param {string} text
 * @param {'say' | 'work'} kind
 * @param {number} [autoHideMs] 为 0 或缺省表示常驻
 */
function showBubble(text, kind, autoHideMs) {
  if (!text) return
  /*
   * 睡眠期间**禁用一切语音**（用户要求）。
   *
   * 入口放在这里而不是各个调用点：气泡是唯一的说话通道，
   * 在这里拦一次就能覆盖所有来源（闲置动作、菜单、叫醒、宿主推送…），
   * 也比在每个调用点各写一遍守卫更不容易漏。
   *
   * 为什么"入睡时那句"还能显示：`enterSleep()` 是先弹台词、后把
   * petState 置为 'sleeping' 的，所以它发生在状态生效**之前**——
   * 那句是"我要睡了"的预告，不是睡梦中的呓语。
   * `wakeFromSleep()` 里的惊醒台词是在 'waking' 期间弹的，
   * 因此会被这条守卫挡掉（叫醒按用户要求不说话）。
   */
  if (petState === 'sleeping' || petState === 'waking') return
  // 说话气泡优先级更高：工作状态不能盖掉用户看得见的话。
  if (kind === 'work' && bubbleOwner === 'say') return

  const timerKey = kind === 'work' ? 'work' : 'say'
  if (bubbleTimers[timerKey]) {
    clearTimeout(bubbleTimers[timerKey])
    bubbleTimers[timerKey] = null
  }

  // 换主人时，要把上一位的定时器一并清掉，否则它到点后会把新气泡关掉。
  if (bubbleOwner !== null && bubbleOwner !== kind) {
    const otherKey = bubbleOwner === 'work' ? 'work' : 'say'
    if (bubbleTimers[otherKey]) {
      clearTimeout(bubbleTimers[otherKey])
      bubbleTimers[otherKey] = null
    }
  }

  bubbleOwner = kind
  bubbleText.textContent = text
  bubble.classList.toggle('work', kind === 'work')
  bubble.hidden = false

  if (autoHideMs && autoHideMs > 0) {
    bubbleTimers[timerKey] = setTimeout(() => {
      bubbleTimers[timerKey] = null
      // 只有仍归自己占用时才隐藏，避免把后来者的气泡关掉。
      if (bubbleOwner === kind) {
        bubble.hidden = true
        bubbleOwner = null
      }
    }, autoHideMs)
  }
}

function hideBubble() {
  for (const key of Object.keys(bubbleTimers)) {
    if (bubbleTimers[key]) {
      clearTimeout(bubbleTimers[key])
      bubbleTimers[key] = null
    }
  }
  bubble.hidden = true
  bubbleOwner = null
}

// ---------------------------------------------------------------- 逐帧动画
/*
 * 站立待机动画：12 帧、6fps、2 秒一轮，无限循环。
 *
 * 素材：assets/animations/stand/frame_01.png ~ frame_12.png（1254×1254 RGBA）
 * 清单：assets/animations/stand/manifest.json
 *
 * 三个设计决定：
 *  1. 帧的**垂直微调**从清单的 drawOffsetY 读取，不硬编码在代码里。
 *     素材画布里人物位置帧间有约 40px 浮动（原意是呼吸起伏），成品观感偏大；
 *     对每帧做一次垂直位移把起伏压到 16px（约 ±0.6% 画布高），变成"极其微弱"。
 *  2. 用 CSS transform 施加位移，**不改动素材文件** —— 避免重新编码造成的画质损失。
 *     偏移按百分比给出（相对画布高度），因此换窗口尺寸时视觉幅度成比例不变。
 *  3. 呼吸起伏与一次眨眼都已画在帧里，所以不需要额外的 CSS 呼吸动画，
 *     也不需要独立的眨眼定时器。
 */

/** 默认帧率；清单里有 fps 时以清单为准。 */
const ANIM_FPS_DEFAULT = 6

/** 清单读不到时按这个帧数尝试加载（与当前素材一致）。 */
const FALLBACK_FRAME_COUNT = 12

/** 站立动画的加载状态。 */
/**
 * 已加载动画的注册表：id → 动画状态。
 *
 * 通用化的理由：现在有多个动作（站立 + 吃白饭/睡觉/玩mc），
 * 它们共用同一套素材约定（`assets/animations/<id>/frame_NN.png` + `manifest.json`），
 * 因此加载、播放、命中掩膜三件事都可以共用一份实现。
 *
 * 内存策略：**站立常驻**（要一直循环），一次性动作**按需加载、播完释放**，
 * 避免每加一个动作就常驻十几张 PNG（当前单帧约 1MB）。
 * @type {Map<string, AnimationState>}
 */
const animations = new Map()

/**
 * @typedef {object} AnimationState
 * @property {string} id
 * @property {HTMLImageElement[]} images
 * @property {number[]} offsetRatios 每帧的垂直微调比例（相对画布高度）
 * @property {number} frameCount
 * @property {number} fps
 * @property {number} index 当前帧序号（0 基）
 * @property {ReturnType<typeof setInterval> | null} timer
 * @property {boolean} ready
 * @property {boolean} loop 是否循环
 */

/** 新建一个空的动画状态。 */
function createAnimationState(id) {
  return {
    id,
    images: [],
    offsetRatios: [],
    frameCount: 0,
    fps: ANIM_FPS_DEFAULT,
    index: 0,
    timer: null,
    ready: false,
    loop: true,
    /**
     * 局部循环配置（来自清单 `loopRange`）：
     * `times` 表示该段**额外重复**几次，因此实际播放次数是 `times + 1`。
     * @type {{ from: number, to: number, times: number } | null}
     */
    loopRange: null,
    /**
     * 展开后的播放计划（帧序号数组）。一次性播放走它，
     * 因此"第 6~9 帧循环 4 次"是**纯数据**，可以被直接断言。
     * @type {number[]}
     */
    playbackPlan: [],
    /** 播放计划里的当前位置。 */
    planCursor: 0,
    /**
     * 进入动画播完后，**循环最后几帧**（0 = 不循环，停在最后一帧）。
     * 来自清单 `tailLoopFrames` —— 睡觉用它维持"睡熟后的起伏"。
     */
    tailLoopFrames: 0,
    /**
     * 尾帧循环用的帧率（来自清单 `tailLoopFps`），缺省与动画一致。
     * 睡觉的起伏很慢，用 1fps（用户指定）比 6fps 自然。
     */
    tailLoopFps: null,
    /** 已完成的循环次数（诊断用）。 */
    loopCount: 0,
  }
}

/** 当前正在播放的动画 id。 */
let activeAnimationId = 'stand'

/** 取当前动画状态。 */
function activeAnimation() {
  return animations.get(activeAnimationId) ?? null
}

/** 由动作 id 与帧序号算出图片路径。 */
function framePathFor(id, index) {
  const n = String(index + 1).padStart(2, '0')
  return `../assets/animations/${id}/frame_${n}.png`
}

/** 清单路径。 */
function manifestPathFor(id) {
  return `../assets/animations/${id}/manifest.json`
}

/** 素材画布高度的兜底值（像素），用于把清单里的像素偏移换算成比例。 */
const SOURCE_CANVAS_HEIGHT_FALLBACK = 1157

/**
 * 读取某个动画的清单。
 * 读不到时返回 `{ ok: false }`，由调用方决定怎么降级。
 * @param {string} id
 */
async function loadManifestFor(id) {
  try {
    const res = await fetch(manifestPathFor(id), { cache: 'no-store' })
    if (!res.ok) throw new Error(`HTTP ${String(res.status)}`)
    const data = await res.json()
    const frameCount = Number.isFinite(data.frameCount) ? data.frameCount : 0
    const fps = Number.isFinite(data.fps) && data.fps > 0 ? data.fps : ANIM_FPS_DEFAULT
    // 换算偏移时必须用**素材自身的画布高度**，不能写死 ——
    // 素材被裁剪过（1254 → 1157），写死会让偏移比例算错。
    const canvasHeight =
      Number.isFinite(data.sourceCanvasHeight) && data.sourceCanvasHeight > 0
        ? data.sourceCanvasHeight
        : SOURCE_CANVAS_HEIGHT_FALLBACK
    const rawOffsets = Array.isArray(data.drawOffsetY) ? data.drawOffsetY : []
    // 换算成"相对画布高度的比例"，正值 = 人物向上移动。
    const offsets = rawOffsets.map((v) => (Number.isFinite(v) ? Number(v) / canvasHeight : 0))
    /*
     * 可选的局部循环：`loopRange: { from, to, times }`，from/to 是 **1 基帧号**
     * （与素材文件名一致，便于对着帧图配置）。用于把动作的"持续段"拉长，
     * 例如吃白饭的"咀嚼"那几帧重复若干次再继续收尾。
     */
    const lr = data.loopRange
    const loopRange =
      lr && Number.isFinite(lr.from) && Number.isFinite(lr.to) && Number.isFinite(lr.times)
        ? {
            from: Number(lr.from),
            to: Number(lr.to),
            times: Number(lr.times),
            /**
             * 循环段**自己的帧率**（可选）。玩mc 要求第 4~5 帧用 1fps 循环，
             * 而首尾段仍是 6fps —— 所以帧率必须随段走，不能整套一个值。
             * ⚠️ 这里曾经漏掉这个字段（只取了 from/to/times），
             * 结果循环段仍按 6fps 播，断言报"循环段帧率=[6]"。
             */
            fps: Number.isFinite(lr.fps) && lr.fps > 0 ? Number(lr.fps) : null,
          }
        : null
    /** 循环轮数的**范围**（可选）：每次播放随机取一个，见 rebuildPlaybackPlan。 */
    const cr = data.loopRangeCyclesRange
    const loopRangeCyclesRange =
      cr && Number.isFinite(cr.min) && Number.isFinite(cr.max)
        ? { min: Number(cr.min), max: Number(cr.max) }
        : null
    /*
     * 可选的尾帧循环：`tailLoopFrames: 2` 表示"进入动画播完后，循环最后 2 帧"。
     * 用于睡觉 —— 躺下的过程播一次，之后一直循环睡熟的轻微起伏。
     */
    const tailLoopFrames = Number.isFinite(data.tailLoopFrames) ? Math.max(0, Math.floor(data.tailLoopFrames)) : 0
    // 尾帧循环的帧率（可选）：睡觉用 1fps 让起伏更慢。
    const tailLoopFps = Number.isFinite(data.tailLoopFps) && data.tailLoopFps > 0 ? Number(data.tailLoopFps) : null
    return {
      ok: true,
      frameCount,
      fps,
      offsets,
      canvasHeight,
      loop: data.loop !== false,
      loopRange,
      loopRangeCyclesRange,
      tailLoopFrames,
      tailLoopFps,
    }
  } catch {
    return {
      ok: false,
      frameCount: 0,
      fps: ANIM_FPS_DEFAULT,
      offsets: [],
      canvasHeight: SOURCE_CANVAS_HEIGHT_FALLBACK,
      loop: true,
      loopRange: null,
      loopRangeCyclesRange: null,
      tailLoopFrames: 0,
      tailLoopFps: null,
    }
  }
}

/**
 * 预加载某个动画的全部帧。
 * @param {string} id
 * @param {AnimationState} state
 * @param {number} frameCount
 * @returns {Promise<number>} 成功加载的帧数
 */
async function preloadFrames(id, state, frameCount) {
  if (!(frameCount > 0)) return 0
  const tasks = []
  for (let i = 0; i < frameCount; i += 1) {
    tasks.push(
      new Promise((resolve) => {
        const img = new Image()
        img.onload = () => {
          // decode() 让浏览器提前完成解码，切帧时不会卡一下。
          const done = () => resolve(true)
          if (typeof img.decode === 'function') img.decode().then(done, done)
          else done()
        }
        img.onerror = () => resolve(false)
        img.src = framePathFor(id, i)
        state.images[i] = img
      }),
    )
  }
  const results = await Promise.all(tasks)
  return results.filter(Boolean).length
}

/**
 * 加载一个动画（幂等：已就绪时直接返回）。
 * @param {string} id
 * @returns {Promise<AnimationState | null>} 成功返回状态，失败返回 null
 */
async function loadAnimation(id) {
  const existing = animations.get(id)
  if (existing && existing.ready) return existing

  const state = existing ?? createAnimationState(id)
  animations.set(id, state)

  const manifest = await loadManifestFor(id)
  const frameCount = manifest.frameCount > 0 ? manifest.frameCount : FALLBACK_FRAME_COUNT
  state.frameCount = frameCount
  state.fps = manifest.fps
  state.offsetRatios = manifest.offsets
  state.loop = manifest.loop
  state.loopRange = manifest.loopRange
  state.loopRangeCyclesRange = manifest.loopRangeCyclesRange ?? null
  state.tailLoopFrames = manifest.tailLoopFrames ?? 0
  state.tailLoopFps = manifest.tailLoopFps ?? null
  rebuildPlaybackPlan(state)

  const loaded = await preloadFrames(id, state, frameCount)
  if (loaded >= 2) {
    state.ready = true
    return state
  }
  // 加载失败：不留下半成品状态，避免下次被误判为"已就绪"。
  animations.delete(id)
  return null
}

/** 释放一个动画占用的内存（用于一次性动作播完回收）。 */
function disposeAnimation(id) {
  if (id === 'stand') return // 站立常驻，不释放
  const state = animations.get(id)
  if (!state) return
  stopLoop(id)
  state.images = []
  state.offsetRatios = []
  state.ready = false
  animations.delete(id)
}

/**
 * 加载站立动画。
 *
 * 分两级降级，保证任何一步失败都还能看到东西：
 *  1. 清单读不到（例如 CSP 拦了 fetch）→ 用兜底参数，仍然播帧、只是不做偏移；
 *  2. 帧也加载不到 → 直接把第 1 帧的路径塞给 img，并显示"素材缺失"提示。
 *     这条路径很重要：曾经因为漏了它，清单 fetch 失败时窗口完全空白，
 *     从外面看就像桌宠根本没启动。
 */
async function loadStandAnimation() {
  const state = await loadAnimation('stand')
  if (state) {
    activeAnimationId = 'stand'
    showFrame(0)
    // 先建命中掩膜再开播：保证一上来就有正确的鼠标穿透行为。
    buildHitMasks()
    startLoop('stand')
    return
  }

  // 退路：直接给 img 一个路径（加载失败时浏览器控制台会给出原因），并显式提示。
  frameEl.src = framePathFor('stand', 0)
  offlineTag.hidden = false
  offlineTag.textContent = '动画素材缺失'
}

/** 显示当前动画的指定帧，并施加该帧的垂直微调。 */
function showFrame(index) {
  const state = activeAnimation()
  if (!state) return
  const img = state.images[index]
  if (!img) return
  state.index = index
  frameEl.src = img.src
  // translateY 为正表示向下；清单里的 offset 正值表示"人物上移"，所以要取负。
  const ratio = state.offsetRatios[index] ?? 0
  frameEl.style.transform = ratio === 0 ? '' : `translateY(${(-ratio * 100).toFixed(3)}%)`
  // 帧变了，布局可能微动，重新做一次命中判断，避免穿透状态与画面不同步。
  resyncHitTest()
}

/** 开始循环播放指定动画（站立这类"永远循环"的动画用它）。 */
function startLoop(id) {
  const state = animations.get(id)
  if (!state || !state.ready || state.timer) return
  const step = Math.max(16, Math.round(1000 / state.fps))
  state.timer = setInterval(() => {
    try {
      if (activeAnimationId !== id) return
      showFrame((state.index + 1) % state.frameCount)
    } catch {
      // 忽略：单帧切换失败不该中断桌宠。
    }
  }, step)
}

/**
 * 按**播放计划**播放一个一次性动画，播完停在最后一帧。
 *
 * 与 `startLoop` 的区别：`startLoop` 是"永远循环"（站立用），
 * 而这个函数走 `state.playbackPlan`，到末尾就停下并**保持最后一帧**，
 * 同时支持局部循环（`loopRange`）—— 吃白饭的咀嚼段就是靠它重复播放的。
 *
 * @param {string} id
 * @returns {boolean} 是否成功起播
 */
function startPlanPlayback(id) {
  const state = animations.get(id)
  if (!state || !state.ready) return false
  // 清掉可能残留的定时器，避免两个播放循环同时改帧。
  stopLoop(id)
  /*
   * 重建播放计划：若清单给了 `loopRangeCyclesRange`（玩mc 的随机 20~40 轮），
   * 这里会**重新抽一次轮数** —— 保证每次播放的长度都不一样。
   */
  rebuildPlaybackPlan(state)

  /** 取某一帧该停多少毫秒（按该帧自己的 fps）。 */
  const stepFor = (fps) => Math.max(16, Math.round(1000 / (fps > 0 ? fps : state.fps)))

  /**
   * 播放下一帧；到末尾时做收尾。
   *
   * ⚠️ 用**链式 setTimeout** 而不是固定 setInterval：同一套动画里可能
   * 逐段用不同帧率（玩mc 前 3 帧 6fps → 4~5 帧 1fps 循环 → 6~10 帧 6fps），
   * 固定间隔没法表达"这一帧停 167ms、那一帧停 1000ms"。
   */
  const advance = () => {
    if (activeAnimationId !== id) return
    const item = nextPlanItem(state)
    if (item === null) {
      /*
       * 到序列末尾：如果这个动画声明了尾帧循环，就接着循环尾部窗口；
       * 否则停下并保持最后一帧（不回第 0 帧，也不切动画）。
       *
       * 睡眠的尾帧循环**有轮数上限**（用户指定随机 20~40 轮）：走满后
       * 自动播惊醒动画醒来。其余动画（如拖拽）没有上限，一直保持。
       */
      stopLoop(id)
      if (state.tailLoopFrames > 0) {
        if (id === SLEEP_ACTION_ID) {
          const cycles = pickSleepTailCycles()
          lastSleepTailCycles = cycles
          console.log(`[sleep] 尾帧循环 ${String(cycles)} 轮后自动醒来（1fps、2 帧 ≈ ${String(cycles * 2)} 秒）`)
          startTailLoop(id, state.tailLoopFrames, state.tailLoopFps, cycles, () => {
            void wakeFromSleep()
          })
        } else {
          startTailLoop(id, state.tailLoopFrames, state.tailLoopFps)
        }
      }
      return
    }
    showFrame(item.index)
    state.timer = setTimeout(advance, stepFor(item.fps))
  }

  // 第 0 帧已经在外面显示过了，这里从第 1 项之后的节奏接着走。
  state.timer = setTimeout(advance, stepFor(state.playbackPlan[0]?.fps ?? state.fps))
  return true
}

/**
 * 启动"尾帧循环"：反复播放最后 N 帧。
 *
 * 用途：进入睡眠状态后，播完"躺下"的进入动画就循环最后两帧（睡觉时的轻微起伏），
 * 期间不再触发随机动作与语音。
 *
 * 与 `startLoop`（整个动画循环）的区别：这里只循环一个**尾部窗口**，
 * 前面的"进入"帧只播一次。
 *
 * @param {string} id 动画 id
 * @param {number} n 循环最后几帧
 * @param {number} [fps] 尾帧循环用的帧率，缺省与动画一致。
 *        睡觉的起伏很慢，用 1fps 比 6fps 自然得多（用户指定）。
 * @param {number} [maxCycles] 最多循环几轮（一轮 = 把这段帧走一遍）。
 *        传了就在走满后自动停；省略则一直循环到被主动停掉。
 * @param {() => void} [onComplete] 达到 `maxCycles` 时的回调（循环已停）。
 * @returns {boolean}
 */
function startTailLoop(id, n, fps, maxCycles, onComplete) {
  const state = animations.get(id)
  if (!state || !state.ready) return false
  stopLoop(id)

  const frames = Math.max(1, Math.min(Math.floor(n) || 1, state.frameCount))
  const from = state.frameCount - frames
  const useFps = Number.isFinite(fps) && fps > 0 ? fps : state.fps
  // 测试可以覆盖这个间隔（把一轮压到毫秒级），否则按帧率算。
  const step =
    Number.isFinite(tailLoopStepOverride) && tailLoopStepOverride > 0
      ? Math.max(16, Math.round(tailLoopStepOverride))
      : Math.max(16, Math.round(1000 / useFps))
  const limit = Number.isFinite(maxCycles) && maxCycles > 0 ? Math.floor(maxCycles) : null
  let index = from
  let cycles = 0
  state.tailCycles = 0

  const tick = () => {
    if (activeAnimationId !== id) return
    index += 1
    if (index >= state.frameCount) {
      // 走完一轮：这里不是"回到开头"，而是"又循环了一遍"。
      cycles += 1
      state.tailCycles = cycles
      if (limit !== null && cycles >= limit) {
        // 达到轮数上限：停下并通知调用方（睡眠就是靠它在 20~40 轮后醒来）。
        stopLoop(id)
        if (typeof onComplete === 'function') onComplete()
        return
      }
      index = from
    }
    showFrame(index)
    state.timer = setTimeout(tick, step)
  }
  state.timer = setTimeout(tick, step)
  return true
}

/**
 * 停止指定动画的播放定时器。
 *
 * ⚠️ 播放用的是链式 `setTimeout`（因为同一动画里可能逐段换帧率），
 * 所以这里也统一用 `clearTimeout`。浏览器里 `clearTimeout`/`clearInterval`
 * 共用同一个句柄池、可以互换，但混用会让人怀疑"是不是漏清了"，
 * 保持与创建方式一致更清楚。
 */
function stopLoop(id) {
  const state = animations.get(id)
  if (!state || !state.timer) return
  clearTimeout(state.timer)
  clearInterval(state.timer)
  state.timer = null
}

/** 是否存在正在跑的播放定时器（诊断/测试用）。 */
function isPlaying(id) {
  const state = animations.get(id)
  return Boolean(state && state.timer)
}

/**
 * 播放一个**一次性**动画：从第 0 帧放到最后一帧，然后**停在最后一帧**。
 *
 * 与一次性动作（`playAction`）的区别：动作播完后会退回站立，而这个函数
 * **不自己退场** —— 由调用方（拖拽逻辑）决定什么时候中断它。
 * 拖拽动画就需要这个语义：拎着的时候一直维持最后一帧，松手立刻切回站立。
 *
 * @param {string} id
 * @returns {Promise<boolean>} 是否成功起播（素材缺失时返回 false）
 */
async function playOneShotHoldLast(id) {
  const state = await loadAnimation(id)
  if (!state) return false

  activeAnimationId = id
  showFrame(0)
  buildHitMasks()
  // 走播放计划：支持 loopRange，且到末尾自动停在最后一帧。
  startPlanPlayback(id)
  return true
}

/**
 * 展开一条**播放计划**：把 0..frameCount-1 依次走过，其中如果清单指定了
 * `loopRange`，就把这段帧**额外重复 times 次**。
 *
 * 为什么展开成数组而不是在回调里临时改游标：展开之后整条播放序列是**纯数据**，
 * 可以直接断言（例如"第 6~9 帧应该出现 5 次"），不必靠观察画面或数时间。
 * 代价是极长的循环会占内存，但这里 times 是个位数、帧数几十，完全无所谓。
 *
 * @param {{frameCount: number, fps?: number, loopRange?: {from: number, to: number, times: number, fps?: number} | null}} state
 * @returns {{index: number, fps: number}[]} 播放项；`[]` 表示无法播放
 */
function buildPlaybackPlan(state) {
  const n = state.frameCount
  if (!(n > 0)) return []

  const baseFps = state.fps > 0 ? state.fps : ANIM_FPS_DEFAULT
  /** 造一个播放项：这一帧用哪个帧率播。 */
  const item = (index, fps) => ({ index, fps: fps > 0 ? fps : baseFps })

  const lr = state.loopRange
  if (!lr) {
    return Array.from({ length: n }, (_, i) => item(i, baseFps))
  }

  // 清单里的 from/to 是 **1 基帧号**（与素材文件名一致），这里转成 0 基下标。
  const from = clampIndex(lr.from - 1, n)
  const to = clampIndex(lr.to - 1, n)
  // 区间非法（from > to）时退化为正常播放，不让一个坏配置把动画搞死。
  if (from > to) return Array.from({ length: n }, (_, i) => item(i, baseFps))

  /*
   * 循环段**自己的帧率**（可选）。
   *
   * 这是为"玩mc"加的：用户要求"第 4~5 帧以每秒 1 帧循环 20~40 次，
   * 结束后继续以每秒 6 帧播放 6~10 帧"。所以同一套动画里必须能**逐段换帧率**，
   * 播放项带上 fps 之后，播放器照着走就行，不必再关心分段。
   */
  const loopFps = lr.fps > 0 ? lr.fps : baseFps
  const times = Math.max(1, Math.floor(lr.times) || 1)
  const plan = []
  // 第一段：从第 0 帧一路走到 loopRange 的起点之前（动画原速）。
  for (let i = 0; i < from; i += 1) plan.push(item(i, baseFps))
  /*
   * 第二段：loopRange **先正常播 1 次，再额外循环 `times` 次**，共 times+1 次。
   * 这一段用 loopFps（玩mc 的 4~5 帧用 1fps）。
   *
   * ⚠️ 这里差 1 过：一开始只循环 `times` 次，于是用户要的"循环 4 次后再播后面"
   * 实际只出现了 4 次（含正常那一次）。语义上"循环 N 次"指的是**额外重复 N 次**，
   * 因此总次数是 times + 1。
   */
  for (let t = 0; t <= times; t += 1) {
    for (let i = from; i <= to; i += 1) plan.push(item(i, loopFps))
  }
  // 第三段：loopRange 之后接着走完（回到动画原速）。
  for (let i = to + 1; i < n; i += 1) plan.push(item(i, baseFps))
  return plan
}

/** 把下标夹进 [0, n-1]。 */
function clampIndex(i, n) {
  if (!Number.isFinite(i)) return 0
  return Math.max(0, Math.min(n - 1, Math.floor(i)))
}

/**
 * 重建播放计划。
 *
 * ⚠️ 与"只建一次"的区别：若清单给了 `loopRangeCyclesRange`（玩mc 的"随机 20~40 次"），
 * **每次播放前都要重取一个随机轮数** —— 否则一次抽中的轮数会被永久固化，
 * 每次都播同样的长度，"随机"就名存实亡。
 *
 * @param {object} state 动画状态
 */
function rebuildPlaybackPlan(state) {
  if (state.loopRange && state.loopRangeCyclesRange) {
    const { min, max } = state.loopRangeCyclesRange
    const lo = Number.isFinite(min) ? Math.max(1, Math.floor(min)) : 1
    const hi = Number.isFinite(max) ? Math.max(lo, Math.floor(max)) : lo
    // **额外**循环的轮数（计划里总次数是 times + 1，见 buildPlaybackPlan）。
    state.loopRange = { ...state.loopRange, times: lo + Math.floor(Math.random() * (hi - lo + 1)) }
  }
  state.playbackPlan = buildPlaybackPlan(state)
  state.planCursor = 0
  return state.playbackPlan
}

/**
 * 取"播放计划里的下一项"。
 * @returns {{index: number, fps: number} | null} null = 已到序列末尾，应当停下
 */
function nextPlanItem(state) {
  const plan = state.playbackPlan
  if (!Array.isArray(plan) || plan.length === 0) return null
  state.planCursor += 1
  if (state.planCursor >= plan.length) return null
  return plan[state.planCursor]
}

/**
 * 取"播放计划里的下一帧下标"。
 * @returns {number | null} null = 已到序列末尾，应当停下
 */
function nextFrameIndex(state) {
  const item = nextPlanItem(state)
  if (item === null) {
    // 没有播放计划（例如循环动画）：退化为简单的下一帧 + 取模。
    if (!Array.isArray(state.playbackPlan) || state.playbackPlan.length === 0) {
      return (state.index + 1) % Math.max(1, state.frameCount)
    }
    return null
  }
  return item.index
}

/** 播放计划的长度（帧数）。非一次性动画退化为 frameCount。 */
function planLengthOf(state) {
  if (!state) return 0
  if (Array.isArray(state.playbackPlan) && state.playbackPlan.length > 0) return state.playbackPlan.length
  return state.frameCount
}

/**
 * 测试用：报告某个动画的播放计划，用来验证"局部循环"确实生效。
 *
 * 因为播放序列是**预先展开的纯数据**，这里能直接给出可断言的数字：
 *  · `planLength` —— 整条序列多少帧（决定动作时长）；
 *  · `frameRepetitions[i]` —— 第 i 帧在序列里出现几次（循环段的帧应当明显多于 1）；
 *  · `loopRange` —— 清单里声明的循环区间（1 基帧号）。
 *
 * @param {string} id
 */
window.__petTestPlaybackPlan = async (id) => {
  const state = await loadAnimation(id)
  if (!state) return null
  const plan = state.playbackPlan
  const reps = new Array(state.frameCount).fill(0)
  for (const item of plan) reps[item.index] += 1
  return {
    frameCount: state.frameCount,
    fps: state.fps,
    loop: state.loop,
    loopRange: state.loopRange,
    tailLoopFrames: state.tailLoopFrames,
    tailLoopFps: state.tailLoopFps,
    planLength: planLengthOf(state),
    /** 播放序列（帧下标，1 基便于对着素材看）。 */
    plan: plan.map((item) => item.index + 1),
    /** 每一项的帧率 —— 用来验证"逐段换帧率"。 */
    planFps: plan.map((item) => item.fps),
    /** 每一帧在序列里出现几次。 */
    frameRepetitions: reps,
  }
}

/**
 * 帧切换后重新判断光标是否还在角色身上。
 * 用最后一次已知的光标位置；没有位置信息时不动。
 */
let lastCursor = null
function resyncHitTest() {
  if (!lastCursor || dragging) return
  updateHitTest(lastCursor.x, lastCursor.y)
}

// ---------------------------------------------------------------- 逐像素命中测试
/*
 * 为什么需要它：`transparent: true` 只让窗口**看起来**透明，整个窗口矩形仍然接收鼠标。
 * 于是光标落在角色周围的透明区域时，依然显示 grab 光标并挡住下面的窗口 ——
 * 现象就是"离桌宠一段距离光标还是手形，既拖不动也点不到别的窗口"。
 *
 * 做法：把**当前动画每一帧**的 alpha 通道降采样成一张小掩膜（HIT_MASK_WIDTH 宽），
 * 鼠标移动时查表判断光标下是不是角色，是则正常交互、否则把事件放行给桌面。
 *
 * 为什么要降采样：直接对 864×1157 做 getImageData 再逐次查表，每次切帧要读约 100 万像素，
 * 6fps 下开销明显。降到 128 宽后只有原来的 1/45，精度对"点没点到人"完全够用。
 * 阈值取偏高一点（40/255）：宁可把边缘判成透明（放行），也不要误吃桌面上的点击。
 *
 * 掩膜跟着**动作**走：切到一次性动作时重建一次，否则命中判定会与画面不符。
 */

/** 命中掩膜的宽度。 */
const HIT_MASK_WIDTH = 128

/** alpha 高于此值才算"点在角色身上"。 */
const HIT_ALPHA_THRESHOLD = 40

/** 当前动画的命中掩膜（跟着动作切换重建）。 */
let hitMasks = []

/** 复用同一个离屏画布，避免反复创建。 */
let hitCanvas = null
let hitCtx = null

/**
 * 为**当前动画**的所有帧建立命中掩膜。
 * 失败时不影响动画播放，只是退回"整个窗口都响应鼠标"的旧行为。
 */
function buildHitMasks() {
  try {
    hitMasks = []
    const state = activeAnimation()
    if (!state) return
    hitCanvas = document.createElement('canvas')
    hitCtx = hitCanvas.getContext('2d', { willReadFrequently: true })
    if (!hitCtx) return
    const first = state.images[0]
    if (!first) return
    const maskH = Math.max(1, Math.round((HIT_MASK_WIDTH * first.naturalHeight) / first.naturalWidth))
    hitCanvas.width = HIT_MASK_WIDTH
    hitCanvas.height = maskH

    for (let i = 0; i < state.frameCount; i += 1) {
      const img = state.images[i]
      if (!img) continue
      hitCtx.clearRect(0, 0, HIT_MASK_WIDTH, maskH)
      hitCtx.drawImage(img, 0, 0, HIT_MASK_WIDTH, maskH)
      hitMasks[i] = hitCtx.getImageData(0, 0, HIT_MASK_WIDTH, maskH).data
    }
  } catch {
    // 建掩膜失败：不影响动画，只是没有穿透能力。
    hitMasks = []
  }
}

/**
 * 光标位置是否落在角色身上。
 * @param {number} clientX
 * @param {number} clientY
 * @returns {boolean} true = 命中角色，应当正常接收鼠标事件。
 */
function hitTest(clientX, clientY) {
  const state = activeAnimation()
  const data = state ? hitMasks[state.index] : null
  if (!data || !hitCanvas) return true // 没有掩膜就按"全部命中"处理（旧行为）
  const rect = frameEl.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return true

  // 注意：帧元素上可能有 translateY 的微调，getBoundingClientRect 已经把它算进去了。
  const u = (clientX - rect.left) / rect.width
  const v = (clientY - rect.top) / rect.height
  if (u < 0 || u > 1 || v < 0 || v > 1) return false

  const mx = Math.min(hitCanvas.width - 1, Math.max(0, Math.floor(u * hitCanvas.width)))
  const my = Math.min(hitCanvas.height - 1, Math.max(0, Math.floor(v * hitCanvas.height)))
  return data[(my * hitCanvas.width + mx) * 4 + 3] > HIT_ALPHA_THRESHOLD
}

/** 上一次下发的"是否忽略鼠标"状态，避免每次 mousemove 都发 IPC。 */
let lastIgnoreState = null

/**
 * 命中判定要连续多少次与当前状态**不同**才允许翻转。
 *
 * ## 为什么必须有这个滞回（实测数据）
 *
 * `hitTest()` 用的是**当前动画帧**的掩膜，而站立动画是循环的、
 * 各帧的角色轮廓并不完全一样（发丝、裙摆、尾巴在动）。于是靠近轮廓边界的
 * 像素会**随动画帧**在"命中 / 不命中"之间反复切换 —— 光标一动不动也会抖。
 *
 * 本机实测（把 `__petTestProbeClient` 在帧矩形内打 12×20 网格、每点采样 14 次）：
 *
 *     240 个采样点里，**22 个**的命中结果会变化，最多翻转 4 次
 *     采样序列形如  11100011100000 / 00011000111111 / 10011111111111
 *
 * 后果是 `setStatsVisible(hit)` 与鼠标穿透**跟着动画一起闪** ——
 * 现象就是用户报的"光标不在桌宠身上时属性面板闪烁"。
 *
 * ## 取值依据
 *
 * 站行动画约 6~10 fps（每帧 100~160ms），而 mousemove 在几十毫秒级到来。
 * 取 3 次：既能滤掉"单帧边缘像素"这种一两帧的抖动，
 * 又不至于让真实进出变得迟钝。
 *
 * ⚠️ 不要调成 1（等于没有滞回）；也不要太大 —— 那会让滞回在真实移动时
 * 也生效，表现为"面板慢半拍"。
 */
const HIT_CONFIRM_SAMPLES = 3

/**
 * 两次采样之间光标移动超过这么多像素，就认为**用户真的在移动光标**，
 * 于是跳过滞回、立即采纳判定结果。
 *
 * ## 为什么需要这个区分
 *
 * 滞回的目的是滤掉"**同一个位置**上、因动画换帧导致的抖动"。
 * 而"光标从这里移到那里"是**真实的意图变化**，必须立刻响应 ——
 * 否则会看到"面板在该出现的时候慢半拍"。
 *
 * 实测症状（就是加这个判断的原因）：先停在一个会显示面板的点，
 * 再移到另一个不该显示的点，序列是 `1000000000…` ——
 * 第一次采样仍读到旧状态，要 3 次采样后才翻过来。
 *
 * 取 3 像素：远大于手抖/亚像素抖动，又远小于有意的移动。
 */
const HIT_MOVE_RESET_PX = 3

/** 与当前生效状态不同的命中结果已连续出现多少次。 */
let hitPendingCount = 0
/** 当前生效的命中状态（滞回后的结果）。 */
let hitStable = null
/**
 * 是否已有确定过的命中状态。
 *
 * 与 `hitStable !== null` 分开是因为：拖拽结束后要**重新开始**滞回
 * （把 `hitStable` 置回 null），此时也需要"首次立即采纳"的快路径。
 */
let hasHitStable = false
/** 上一次用于判定的光标位置（用来识别"用户真的移动了"）。 */
let lastHitProbe = null

/**
 * 记录光标位置并按需更新鼠标穿透状态。
 *
 * ⚠️ 这里**不能**直接用单次 `hitTest` 的结果去切换状态（见 HIT_CONFIRM_SAMPLES
 * 的说明）——必须经过连续采样确认，否则面板与穿透会跟着动画帧闪。
 *
 * @param {number} clientX
 * @param {number} clientY
 */
function updateHitTest(clientX, clientY) {
  try {
    lastCursor = { x: clientX, y: clientY }
    if (dragging) return

    const raw = hitTest(clientX, clientY)

    /*
     * 先判断"用户是否真的移动了光标"。
     *
     * 滞回只该滤掉**同一位置**上因动画换帧造成的抖动；真实的移动必须立刻响应。
     * 实测症状（加这个判断的原因）：先停在会显示面板的点，再移到不该显示的点，
     * 采样序列是 `1000000000…` —— 第一次仍读到旧状态，要 3 次采样才翻过来。
     */
    let moved = false
    if (lastHitProbe === null) {
      moved = true
    } else {
      const dx = clientX - lastHitProbe.x
      const dy = clientY - lastHitProbe.y
      moved = dx * dx + dy * dy > HIT_MOVE_RESET_PX * HIT_MOVE_RESET_PX
    }
    lastHitProbe = { x: clientX, y: clientY }

    /*
     * 滞回：只有"与当前稳定值不同"的采样连续出现够多次，才真的翻转。
     *
     * ⚠️ 两种情况直接采纳、不等确认：
     *   · 还没有确定过的状态（首帧、或刚从拖拽恢复）—— 否则启动后面板慢半拍；
     *   · 光标真的移动了 —— 那是用户的意图，不该被去抖拖住。
     */
    if (!hasHitStable || moved) {
      hasHitStable = true
      hitStable = raw
      hitPendingCount = 0
    } else if (raw === hitStable) {
      hitPendingCount = 0
    } else {
      hitPendingCount += 1
      if (hitPendingCount < HIT_CONFIRM_SAMPLES) return // 还在确认中：状态保持不变
      hitStable = raw
      hitPendingCount = 0
    }

    // 悬停在角色身上时显示属性面板。复用（滞回后的）命中结果，
    // 因此"光标在透明区域"不会误触发面板 —— 与鼠标穿透行为一致。
    setStatsVisible(hitStable)
    const ignore = !hitStable
    if (ignore === lastIgnoreState) return
    lastIgnoreState = ignore
    window.pet.setIgnoreMouse(ignore)
  } catch {
    // 忽略：命中测试失败不该影响交互。
  }
}

/**
 * 测试用：读回滞回状态。
 * @returns {{ stable: boolean|null, pending: number, samples: number }}
 */
window.__petTestHitHysteresis = () => ({
  stable: hitStable,
  pending: hitPendingCount,
  samples: HIT_CONFIRM_SAMPLES,
  hasStable: hasHitStable,
})

/**
 * 测试用：把滞回状态重置成"尚未确定"。
 *
 * 为什么需要：滞回的物理量是"连续采样次数"，而采样发生在真实的 mousemove 流里。
 * 想从零验证"首次立即采纳"与"边界抖动被滤掉"这两件事，就必须能把状态清干净。
 */
window.__petTestResetHitHysteresis = () => {
  hitStable = null
  hitPendingCount = 0
  hasHitStable = false
  lastHitProbe = null
  return true
}

/**
 * 测试用：**不经事件**直接驱动一次命中判定（走完整的 `updateHitTest` 路径）。
 *
 * ## 为什么需要它
 *
 * 用户报的"光标不在桌宠身上时属性面板闪烁"，根因是**同一坐标上
 * `hitTest()` 的结果会随动画帧变化**（实测 240 个采样点里 22 个会变，
 * 详见 `HIT_CONFIRM_SAMPLES` 的注释）。
 *
 * 复现/验证这件事需要在**同一个坐标**上连续采样 —— 而合成 `mousemove`
 * 每次都要跨 CDP 往返，既慢又引入时序偏差。这个钩子让一整轮采样
 * 在渲染进程里跑完，节奏可控。
 *
 * ## 返回值刻意只含纯数据
 *
 * 它可能被 `executeJavaScript` 送回主进程，而 Electron 的 IPC
 * **无法克隆函数**（带上函数会报 "An object could not be cloned"）——
 * 所以不要在这里返回 `hitTest` 之类的函数。
 *
 * @param {number} clientX
 * @param {number} clientY
 * @returns {{hit: boolean, stable: boolean|null, pending: number, statsVisible: boolean}}
 */
window.__petTestDriveHit = (clientX, clientY) => {
  updateHitTest(clientX, clientY)
  return {
    hit: hitTest(clientX, clientY),
    stable: hitStable,
    pending: hitPendingCount,
    statsVisible,
  }
}


// ---------------------------------------------------------------- 点击反馈
/*
 * 曾经这里有一个 `popOnce()`：点击时给 `.character` 加 `pop` 类，
 * 用 CSS 动画做一次"Q 弹压扁"。
 *
 * **用户要求去掉它，只播放互动动画。** 两个理由：
 *  · 压扁是 CSS 对整块立绘做缩放，会与逐帧互动动画的姿态变化打架
 *    （一边在演"被摸头"，一边整块被压扁，看起来像两套动作叠在一起）；
 *  · 互动动画本身就是反馈，再叠一个挤压是多余的。
 *
 * 因此 `popOnce()` 已删除，`.pop` 的 CSS 也不再被使用。
 */

// ---------------------------------------------------------------- 拖拽实现
/*
 * 分工：**渲染进程只负责"何时开始/结束"，移动完全由主进程做。**
 *
 * 主进程每 4ms 用 screen.getCursorScreenPoint() 读光标，直接
 * setPosition(光标 − 抓取偏移)，因此延迟只有一个 setPosition 调用，手感是实时的。
 *
 * 为什么不走"渲染进程上报 mousemove → 主进程移动"这条更直观的路（最初就是这么写的）：
 *   1. 窗口正在移动时 Chromium 会降低该窗口的合成频率，mousemove 本身就不及时；
 *   2. 每次移动要一次 IPC 往返；
 *   3. 主进程侧再加节流（最初加了 16ms）会进一步叠加延迟。
 * 三者叠加就是"拖起来发飘、跟不上手"。
 *
 * 坐标系仍然用**绝对量**而非增量。踩过的坑：
 *
 *   e.screenX = 窗口左上角屏幕坐标 + e.clientX
 *
 * 这个等式没错，但**不能**由此推出"两次 clientX 之差就是窗口应移动的距离"。
 * 因为 clientX 的参考系是窗口自己，而窗口每帧都在移动：
 *
 *   第 1 次 mousemove：鼠标右移 10px，窗口没动 → clientX 报 110，算出 dx=10，窗口右移 10
 *   第 2 次 mousemove：鼠标没动，但窗口已右移 10px → 同一物理位置 clientX 只报 100
 *                     → 算出 dx=-10，窗口又左移 10  ← 正反馈震荡，表现为剧烈抖动
 *
 * 所以这里只上报 screenX/screenY（屏幕绝对坐标，不随窗口移动而变），且现在连上报
 * 都不需要了 —— 主进程自己就能拿到光标位置。
 */
stage.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return
  dragging = true
  /*
   * 拖拽期间 `updateHitTest` 直接 return（不更新穿透/面板），
   * 所以恢复时必须把滞回**重置成"尚未确定"**，让松手后第一次
   * mousemove 立即采纳 —— 否则会沿用拖拽前的旧状态，
   * 表现为"拖到别处松手后，面板还赖着显示/隐藏一阵子"。
   */
  hitStable = null
  hitPendingCount = 0
  hasHitStable = false
  // 位置也要清掉：否则松手后第一次采样会与自己比较、判成"没移动"而走滞回。
  lastHitProbe = null
  // 只记起点，不做判定 —— 判定留到 mouseup 之后（借鉴参考项目）。
  dragStart = { x: e.screenX, y: e.screenY }
  document.body.classList.add('dragging')
  character.classList.add('dragging')
  // 开始拖拽：把**按下那一刻**算好的抓取偏移交给主进程。
  //
  // 偏移 = 光标屏幕坐标 − 窗口左上角屏幕坐标。这两个量在按下瞬间都能拿到，
  // 因此主进程一启动跟随就能用正确的偏移，不会出现"先跳一下再跟上"
  // （跟随是在长按 180ms 之后才启动的，那时光标可能已经移开了）。
  // window.screenX/Y 在极少数环境下不可靠，所以主进程仍保留自取的兜底。
  const offsetX = Number.isFinite(window.screenX) ? e.screenX - window.screenX : undefined
  const offsetY = Number.isFinite(window.screenY) ? e.screenY - window.screenY : undefined
  window.pet.dragStart(e.screenX, e.screenY, offsetX, offsetY)

  /*
   * 指针捕获：窗口跟着光标移动时，鼠标很容易滑到窗口之外；不捕获就收不到 mouseup，
   * 拖拽会停不下来。捕获后事件持续送到本元素，松手一定能被收到。
   *
   * 早期版本曾判断"捕获会破坏窗口拖拽"而不使用它 —— 那是个误判，真正原因是
   * 坐标系用错了（拿 clientX 之差当窗口位移，形成反馈回路）。现在坐标系已改为
   * 屏幕绝对坐标 + 主进程跟随，捕获是安全且必要的。
   */
  try {
    stage.setPointerCapture(e.pointerId)
  } catch {
    // 不支持捕获时退化：后面还有 buttons===0 与 mouseleave 两道兜底。
  }

  /*
   * ⚠️ 这里**不能**立刻停掉当前动画。
   *
   * mousedown 既可能是拖拽的开始，也可能只是一次**单击**（松手时才判定）。
   * 我第一版在这里就停了动画，结果睡眠状态下点一下会被当成"开始拖拽"，
   * 走 interruptSleep() 把 petState 直接置成 idle —— 于是"点击叫醒"永远
   * 走不到 wakeFromSleep，反而播了部位互动动画（chest）。
   *
   * 正确做法：把"停掉当前动画"放到 180ms 的拎起判定**之内**，
   * 也就是下面 liftHoldTimer 的回调里。单击不会触发它，因此点击语义不受影响。
   */
  if (liftHoldTimer) clearTimeout(liftHoldTimer)
  liftHoldTimer = setTimeout(() => {
    liftHoldTimer = null
    if (!dragging) return

    // 确认为拖拽（长按已达 180ms）：先停掉当前动画。
    if (petState === 'sleeping' || petState === 'waking') {
      // 睡眠状态被拖起来：退出睡眠（不播惊醒，见 interruptSleep 的说明）。
      interruptSleep('用户开始拖拽')
    } else {
      // 停掉正在播的一次性动作（例如"吃白饭"播到一半就被拎起来）。
      endAction()
    }

    character.classList.add('lifted')
    // 只在真正拎起来时说这一句，避免每动一下就换一句。
    showBubble(pickDragLine(), 'say', 0)
    void playDragAnimation()
  }, LIFT_HOLD_MS)
})

window.addEventListener('mousemove', (e) => {
  if (!dragging) {
    // 未拖拽时：按光标下的像素决定是否把鼠标事件放行给桌面。
    updateHitTest(e.clientX, e.clientY)
    return
  }
  // 拖拽中：位置**由主进程跟随**（它每 4ms 读一次光标并立即设置窗口位置），
  // 这里不再上报坐标 —— 上报会多一次 IPC 往返，反而让跟随变慢。
  // 但要瞄一眼按键是否还按着：万一 mouseup 丢了，这是最可靠的补救信号。
  //
  // ⚠️ 自测下这个启发式必须**关掉**：自测是用合成 mousedown 起拖的，
  // 屏幕上真实的鼠标键并没有按下，所以这 180ms 内任何一次真实 mousemove
  // 被转发进来都会带着 `buttons === 0`，把拖拽提前取消 ——
  // 表现为偶发（约五次一次）"拎起判定没通过、还停在 head / 站立"。
  // 真拖拽时 `buttons` 就是 1，这条启发式在生产环境是有效的，所以只在测试里禁用。
  if (!tolerateButtonsZero && e.buttons === 0) finishDrag()
})

/**
 * 光标移出窗口时恢复接收事件。
 *
 * 实测 `setIgnoreMouseEvents(true, { forward: true })` 确实能把鼠标事件送回本窗口，
 * 所以穿透通常能靠 mousemove 自动解除。但为避免"进入穿透 → 光标直接移出窗口 →
 * 再无事件"这种边界情况把窗口永久卡在穿透态，这里再加一道保险。
 */
window.addEventListener('mouseleave', () => {
  if (dragging) return
  // 属性面板跟着收起，否则光标离开后它会一直亮着。
  setStatsVisible(false)
  if (lastIgnoreState !== true) return
  lastIgnoreState = false
  window.pet.setIgnoreMouse(false)
})

window.addEventListener('mouseup', (e) => {
  if (!dragging) return
  finishDrag(e)
})

/**
 * 播放"被拎起来"的拖拽动画（assets/animations/hang）。
 *
 * 素材约定与站立一致（864×1157、同一裁剪框、同一脚底基准线），
 * `loop: false`，播完**停在最后一帧**（拎着期间一直维持那个姿势）。
 * 帧数与 fps 由 `manifest.json` 决定，这里不写死 —— 换美术素材时
 * 不必改代码（帧数一致性由 `scripts/dev/test-animations.mjs` 守着）。
 *
 * 素材缺失时静默退回：仍然显示 CSS 的 `.lifted` 摆动占位，
 * 不留空白窗口（与一次性动作同样的降级策略）。
 */
async function playDragAnimation() {
  try {
    const ok = await playOneShotHoldLast(DRAG_ANIMATION_ID)
    if (!ok) console.warn(`拖拽动画 ${DRAG_ANIMATION_ID} 素材缺失，退回 CSS 摆动占位`)
  } catch (err) {
    console.warn('播放拖拽动画失败：', err)
  }
}

/**
 * 中断拖拽动画并立即回到站立闲置动画。
 *
 * "立即"是刻意的：用户要求松手即回闲置，不要等当前动画播完。
 * 因此这里直接停掉 hang 的定时器、切回 stand 并从第 0 帧重新起播 ——
 * 注意是**从第 0 帧**开始，而不是接着站立动画原来的进度，
 * 这样回到闲置的动作有一个明确的起点，不会显得像是从半途接上来的。
 */
function endDragAnimation() {
  // 停掉拖拽动画本身（它可能正停在最后一帧）。
  stopLoop(DRAG_ANIMATION_ID)

  /*
   * 正常路径：拖拽动画还在播 → 立刻切回站立闲置。
   *
   * ⚠️ 若 `activeAnimationId` 已经不是 hang（理论上不该发生 ——
   * 拖拽期间 `playAction` 有守卫、点击互动也被"松手才算点击"的判定挡住），
   * 这里**不再强行回站立**：强行切会把睡眠/惊醒的画面也一起掰掉。
   * 早先我为了兜住一个用例放宽过这里，结果引入了更隐蔽的副作用，后来收紧了。
   * 真出现"拖拽后停在别的动画上"，应当去修那个让别的动画挤进来的入口，
   * 而不是在这里兜底。
   */
  if (activeAnimationId !== DRAG_ANIMATION_ID) return

  const standState = animations.get('stand')
  if (standState && standState.ready) {
    activeAnimationId = 'stand'
    showFrame(0)
    buildHitMasks()
    startLoop('stand')
  }
}

/**
 * 结束拖拽。
 * @param {MouseEvent} [e] 松手事件；缺省时按"不算点击"处理（用于兜底路径）。
 */
function finishDrag(e) {
  if (!dragging) return
  dragging = false
  if (liftHoldTimer) {
    clearTimeout(liftHoldTimer)
    liftHoldTimer = null
  }
  try {
    if (e && stage.hasPointerCapture && stage.hasPointerCapture(e.pointerId)) {
      stage.releasePointerCapture(e.pointerId)
    }
  } catch {
    // 忽略。
  }
  document.body.classList.remove('dragging')
  character.classList.remove('dragging')
  const wasLifted = character.classList.contains('lifted')
  character.classList.remove('lifted')

  // 立刻中断拖拽动画并回到站立闲置动画（用户要求：松手即回闲置）。
  // 注意这里不销毁 hang 素材 —— 下次拖拽还要用，而它只有十几帧，
  // 留在内存里省掉每次拖拽的重新加载（与一次性动作"播完释放"的策略不同）。
  endDragAnimation()

  // 让主进程补齐落点并夹回可见区域（它内部会做最后一次跟随）。
  window.pet.dragEnd()

  if (!e) {
    dragStart = null
    return
  }

  // 点击 vs 拖动：比较按下与松手时鼠标的屏幕位置（借鉴参考项目）。
  // 拖动过程中不判定，因此鼠标轻微抖动不会被误判成拖动。
  const totalDx = Math.abs(e.screenX - dragStart.x)
  const totalDy = Math.abs(e.screenY - dragStart.y)
  const isClick = e.button === 0 && totalDx < CLICK_THRESHOLD_PX && totalDy < CLICK_THRESHOLD_PX

  /*
   * 诊断：把"这次算点击还是拖动"的输入记下来。
   *
   * 为什么需要：实测出现过"光标明明移动了 144px，松手却被判成点击"的情况，
   * 从外部只能看到"松手后没回站立"，无从判断是判定算错了还是别的路径改了画面。
   */
  lastClickDecision = {
    dragStart: { ...dragStart },
    upScreen: { x: e.screenX, y: e.screenY },
    totalDx,
    totalDy,
    threshold: CLICK_THRESHOLD_PX,
    isClick,
    wasLifted,
    activeAnimationId,
  }

  if (isClick) {
    /*
     * 睡眠期间点击 = **叫醒**（用户要求）。
     *
     * 这条语义与普通点击不同：不说部位台词、不加心情，只播惊醒动画。
     * 惊醒动画自己播完后退回闲置，所以这里不需要额外的收尾。
     */
    if (petState === 'sleeping') {
      dragStart = null
      void wakeFromSleep()
      return
    }
    // 惊醒动画播放中再点击：忽略，避免把惊醒动画打断成半截状态。
    if (petState === 'waking') {
      dragStart = null
      return
    }

    /*
     * 按部位互动（用户要求：**只播放互动动画**，不再有压扁效果）。
     *
     * 命中部位时：
     *  · 该部位配了互动动画 → 播它（动画自带姿态变化，就是反馈本身）；
     *  · 没配（腹部、腿）→ 只说话，不播动画；
     *  · 没命中任何部位 → 通用台词。
     * 台词仍然按部位取，心情照旧 +10。
     */
    const hitPart = resolveClickPart(e.clientX, e.clientY)
    const partLine = hitPart ? pickPartLine(hitPart.part.lines) : ''
    showBubble(partLine || '唔…戳我做什么？', 'say', 2500)

    const partActionId = hitPart && typeof hitPart.part.actionId === 'string' ? hitPart.part.actionId : ''
    if (partActionId) {
      // 直接调用 playAction，而不是走主进程 IPC —— 点击是本进程的事件，
      // 本地播放少一次往返，反馈更即时。
      void playAction(partActionId, { fromMenu: false, clickPart: true })
    }

    // 互动加心情。数值由主进程结算（见 pet-app/main.js 的心情小节）。
    try {
      window.pet.pet()
    } catch {
      // 忽略：心情通道失败不该影响点击反馈。
    }
  } else if (wasLifted && bubbleOwner === 'say') {
    // 台词在松手后再停留一会儿，让用户来得及读完。
    showBubble(bubbleText.textContent, 'say', 2600)
  }
  dragStart = null
  // 拖拽结束：重新起算闲置调度（拖拽期间不会触发闲置语音/动作）。
  resetIdleTimer()
}

// 右键菜单
stage.addEventListener('contextmenu', (e) => {
  e.preventDefault()
  window.pet.contextMenu()
})

// ---------------------------------------------------------------- 尺寸
/*
 * 窗口尺寸**只由主进程决定**，渲染进程只按它下发的参数做布局。
 *
 * 这里曾经有 syncWindowSize()，把 window.innerWidth 回报给主进程"对齐尺寸"。
 * 那是个闭环：回报尺寸 → 改窗口 → 触发 resize → 又回报一个不同的尺寸。
 * 加上高 DPI 取整，窗口会在拖拽中一点点放大（实测每轮 +2px）。
 *
 * 现在下发的有两个量：
 *  · logicalWidth —— 角色区域的宽度（CSS 像素）
 *  · bubbleArea   —— 顶部气泡区的高度（固定像素，不随桌宠缩放）
 *
 * 角色高度在这里按素材比例算出，并**精确设置到 img 上**，不用 object-fit：
 * 否则当角色区比例与素材比例不符时会产生 letterbox，而 getBoundingClientRect
 * 会把留白算进去，逐像素命中测试就会失准。
 */
let logicalWidth = 0

/** 顶部气泡区高度（CSS 像素）。 */
let bubbleAreaPx = 0

/** 底部属性面板区高度（CSS 像素）。 */
let statsZonePx = 0

/**
 * 按真实视口重排布局。
 *
 * ⚠️ 这里有一个必须讲清楚的事实：**窗口的实际尺寸不等于我们请求的尺寸，
 * 而且它在拖拽过程中会不断变化。**
 *
 * 实测（`--trace-geometry` 日志 + `capturePage` 位图）：
 *  · 请求 240×431 的窗口，渲染视口拿到的是 242×432；
 *  · 拖拽移动时，Windows 会按 DPI 网格**逐帧量化**窗口尺寸，
 *    视口高在 324→325→…→331 之间来回变，宽度也 ±1~4px 地漂。
 *  · 空闲时完全稳定（静置 8 秒零变化），只有移动时才这样。
 *
 * 我曾经用"看门狗"每 30ms 把尺寸纠正回设计值 —— 那是治标不治本，
 * 而且**纠正本身把窗口来回拽，造成了肉眼可见的抖动**（用户的原话）。
 *
 * 现在改成**让布局对窗口尺寸免疫**，这才是根本解法：
 *
 *   面板贴窗口底边   → 它永远在最后一行像素上，不可能漂移
 *   角色紧贴面板上方 → 两者之间零间隙，不可能被拉开
 *   多出的空间全给顶部气泡区 → 那是视觉上"空"的地方，变大看不出来
 *
 * 于是无论 Windows 把窗口量化成多大，桌宠与面板都始终锁在一起。
 * 代价只是"基准大的那几像素会让角色略大一点"，而这远好于漂移与抖动。
 *
 * @param {number} targetWidth 目标角色宽度（CSS 像素，来自设置档位）
 */
function applyLayout(targetWidth) {
  if (!Number.isFinite(targetWidth) || targetWidth <= 0) return
  logicalWidth = targetWidth

  const viewportH = window.innerHeight
  const viewportW = window.innerWidth
  if (!(viewportH > 0)) return

  // 字号按目标宽度换算（设计比例），而不是按最终像素宽度 ——
  // 避免"窗口被系统量化 → 字号跟着抖"。
  const font = Math.max(BUBBLE_FONT_MIN_PX, Math.round(targetWidth / FONT_WIDTH_DIVISOR))

  // 面板区高度按字号算（与主进程同式）。
  const statsH = Math.round(font * STATS_ZONE_FONT_RATIO)
  // 余额区也按字号算。它**常驻**，所以和属性面板一样要先从可用高度里扣掉。
  const balanceH = Math.round(font * BALANCE_ZONE_FONT_RATIO)
  // 角色拿到除两块面板之外的全部高度；宽度由素材宽高比反推。
  const petH = Math.max(1, viewportH - statsH - balanceH)
  let petWidth = Math.round((petH * ASPECT_W) / ASPECT_H)
  let petHeight = petH
  // 不要宽于视口（否则立绘会被裁）。
  if (petWidth > viewportW) {
    petWidth = viewportW
    petHeight = Math.round((petWidth * ASPECT_H) / ASPECT_W)
  }
  // 气泡区吃掉剩下的余量：它锚在顶部，变大也看不出来，而且不会影响
  // "角色紧贴余额面板、余额面板紧贴属性面板"这条不变量。
  const bubbleHeight = Math.max(0, viewportH - petHeight - balanceH - statsH)

  /*
   * 防线：任何一个尺寸算成 NaN/0，写进样式都会被浏览器**静默忽略**，
   * 元素就会退回素材原始尺寸，表现为"窗口变了、立绘不变"且毫无报错。
   * 这种情况极难从现象反推，所以这里直接拦下来并显式报警。
   */
  if (!Number.isFinite(petWidth) || !Number.isFinite(petHeight) || petWidth <= 0 || petHeight <= 0) {
    console.error('布局计算出非法尺寸，已放弃本次布局', { petWidth, petHeight, font, statsH, balanceH, viewportH })
    return
  }

  // --- 应用 ---
  // 三块区域是 flex 纵列的连续项：气泡区（吃掉余量）→ 角色区 → 余额区 → 属性面板区。
  // 它们靠**流布局**依次相邻：无论 Windows 把窗口量化成多高，多出的余量
  // 都只会落在顶部气泡区，所以"余额面板与属性面板不遮挡"是结构性成立的。
  if (bubbleAreaEl) bubbleAreaEl.style.height = `${String(bubbleHeight)}px`
  if (balancePanel) {
    balancePanel.style.height = `${String(balanceH)}px`
    balancePanel.style.fontSize = `${String(font)}px`
  }
  if (statsPanel) {
    statsPanel.style.height = `${String(statsH)}px`
    statsPanel.style.fontSize = `${String(font)}px`
  }
  if (bubble) bubble.style.fontSize = `${String(font)}px`

  // 内边距同步缩放，气泡框才会跟着一起变大变小。
  const padScale = targetWidth / PET_WIDTH_BASE
  bubble.style.padding = `${String(Math.max(3, Math.round(6 * padScale)))}px ${String(Math.max(5, Math.round(10 * padScale)))}px`
  bubble.style.borderRadius = `${String(Math.max(6, Math.round(10 * padScale)))}px`

  // 角色区与立绘：尺寸精确设置（不用 object-fit），避免比例不符时产生 letterbox 影响命中测试。
  if (character) {
    character.style.width = `${String(petWidth)}px`
    character.style.height = `${String(petHeight)}px`
  }
  if (frameEl) {
    frameEl.style.width = `${String(petWidth)}px`
    frameEl.style.height = `${String(petHeight)}px`
  }

  // 尺寸变了以后，光标相对角色的位置也变了 → 重算一次命中。
  resyncHitTest()
}

// ---------------------------------------------------------------- 与主进程通信
async function boot() {
  try {
    const initial = await window.pet.getInitial()
    if (initial && initial.state) applyState(initial.state)
    /*
     * 余额：**由桌宠主进程自己取**（读凭据文件 + 直连接口），随初始载荷带下来。
     *
     * 首次启动时它可能还是 `null` —— 取数要一次网络往返，`getInitial` 不等它。
     * 那时面板显示 `--`，取到后由 `pet:balance` 推下来刷新。
     */
    if (initial && initial.balance) {
      const b = initial.balance
      if (b.snapshot !== undefined) balanceState = b.snapshot ?? null
      if (Number.isFinite(b.lowBalanceThreshold)) lowBalanceThreshold = b.lowBalanceThreshold
    }
    if (initial && Number.isFinite(initial.lowBalanceThreshold)) {
      lowBalanceThreshold = initial.lowBalanceThreshold
    }
    // 首屏先画一次：即便还没有余额数据，也要把 `--` 画出来而不是留空白。
    renderBalance()
    // 布局参数由主进程下发，渲染进程只读它们做布局，绝不回报自己的 innerWidth。
    if (initial) {
      applyLayout(initial.logicalWidth)
      // 动作清单与心情：都来自主进程（源头是 src/shared-core/）。
      // 注：闲置语音已整体移除（用户要求），因此这里不再有 idleLines 相关字段。
      if (Array.isArray(initial.actions)) actionCatalog = initial.actions
      if (Array.isArray(initial.clickParts)) clickParts = initial.clickParts
      /*
       * 把点击互动动画也并进动作清单。
       *
       * 为什么要并入：这样点击互动就能复用 `playAction` 的整套播放/收尾逻辑
       * （素材加载、按播放计划推进、播完回站立），不必另写一份播放代码。
       * 代价是它们会出现在 actionCatalog 里，所以随机池必须按 id 排除它们
       * （见 oneShotActions）。
       *
       * 标记 `clickPart: true` 是为了让它们**不出现在右键菜单/清单展示**里 ——
       * 菜单只列 `initial.actions`，这份标记供诊断与断言使用。
       */
      if (Array.isArray(initial.partActions)) {
        const existing = new Set(actionCatalog.map((a) => a.id))
        for (const pa of initial.partActions) {
          if (existing.has(pa.id)) continue
          actionCatalog = [...actionCatalog, { id: pa.id, label: pa.label, standing: false, clickPart: true, lines: [] }]
        }
      }
      // 闲置动作的触发规则（由主进程下发，源头是动作库的 RANDOM_ACTION_RULES）。
      if (Number.isFinite(initial.idleTriggerAfterMs)) idleTriggerAfterMs = initial.idleTriggerAfterMs
      if (Number.isFinite(initial.idleFireIntervalMs)) idleFireIntervalMs = initial.idleFireIntervalMs
      if (Number.isFinite(initial.idleFireProbability)) idleFireProbability = initial.idleFireProbability
      if (
        initial.actionMoodGain &&
        Number.isFinite(initial.actionMoodGain.min) &&
        Number.isFinite(initial.actionMoodGain.max)
      ) {
        actionMoodGainRange = { min: initial.actionMoodGain.min, max: initial.actionMoodGain.max }
      }
      if (initial.mood) {
        moodState = { value: Number(initial.mood.value), tier: String(initial.mood.tier ?? 'happy') }
        renderMood()
      }
      if (initial.affection) {
        affectionState = { ...affectionState, ...initial.affection }
        renderAffection()
      }
      // 起始工作状态：拿不到就当作闲置。
      currentWorkStatus = initial.state && typeof initial.state.workStatus === 'string' ? initial.state.workStatus : 'idle'
    }
  } catch {
    // 忽略：拿不到初始状态时仍可正常播放动画。
  }

  // 读清单 → 预加载帧 → 开始循环。整段包在 try 里：动画失败绝不能拖垮桌宠。
  try {
    await loadStandAnimation()
  } catch {
    // loadStandAnimation 内部已有分级降级，这里只是最后一道保险。
    try {
      frameEl.src = framePathFor('stand', 0)
    } catch {
      // 忽略。
    }
  }

  // 动画就绪后再起闲置调度：否则可能在还没画面时就开始说话/做动作。
  resetIdleTimer()
}

/** 应用一次宿主状态。 */
function applyState(state) {
  if (!state) return

  // 离线提示：只要拿到状态就说明在线。
  offlineTag.hidden = true

  /*
   * 工作状态**不再显示任何台词**（用户要求）。
   *
   * 这里原本会把"思考中… / 干活中… / 完成！"等写进气泡。现在一律不写：
   * 工作状态只用于**门控**（闲置计时、打断睡眠），桌宠不再替宿主播报状态。
   * 若之前显示的是 work 气泡，这里顺手收起，避免残留一句话挂在那儿。
   */
  if (bubbleOwner === 'work') hideBubble()
  lastWorkLabel = ''

  // 工作状态的门控：只有宿主处于 idle 时才允许触发动作/进入睡眠。
  //
  // ⚠️ 关键：唤醒睡眠的判据是"**从闲置变成忙碌**"，而不是"状态字符串变了"。
  //
  // 这是排查"睡觉一会儿就自己醒"时找到的真凶：宿主的状态并不只有
  // idle / 忙碌两种，它在忙碌时还会在 thinking / working / organizing /
  // waiting / success / failure 之间来回切。原先的写法是
  // `nextStatus !== currentWorkStatus` 就当成"开始工作"，于是
  // **一次任务内部的任何状态抖动都会把睡着的桌宠叫醒**。
  // 实测：入睡 20 秒后因为一次 thinking → 别的忙碌态切换就被唤醒。
  //
  // 正确判据：`wasIdle && !isIdle` —— 即"之前闲置，现在忙了"，这才是
  // 用户所说的"开始工作"。
  const nextStatus = typeof state.workStatus === 'string' ? state.workStatus : 'idle'
  const wasIdle = currentWorkStatus === 'idle'
  const isIdle = nextStatus === 'idle'
  currentWorkStatus = nextStatus

  // 忙碌态之间的抖动（thinking ↔ working ↔ success…）什么也不做：
  // 既不改闲置计时，也不唤醒睡眠。
  if (wasIdle === isIdle) return

  if (isIdle) {
    // 刚回到闲置：重新起算闲置计时。
    //
    // ⚠️ 但**正在惊醒时不要重置** —— 惊醒是"被叫醒"的收尾，重置会
    // 把 petState 从 'waking' 里拽出来，动画就断了。
    // 惊醒播完时 finishWake() 自己会重置。
    if (petState === 'idle') resetIdleTimer()
    return
  }

  // 从闲置变为忙碌（这才是"DSH 开始工作"）：停掉闲置调度。
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  /*
   * 睡眠中开始工作 = 与"用户点击"同一种唤醒（用户要求）：
   * **播放惊醒动画**，而不是被硬生生切断。
   */
  if (petState === 'sleeping') {
    void wakeFromSleep()
  } else if (petState === 'idle' && currentActionId !== null) {
    // 普通动作在工作开始时要打断（例如"吃白饭"播到一半就开始思考）。
    endAction()
  }
}

window.pet.on('pet:state', (state) => {
  try {
    applyState(state)
  } catch {
    // 忽略：单个状态处理失败不应让桌宠停止工作。
  }
})

/**
 * 余额（**由桌宠主进程自己取**，不再来自宿主快照）。
 *
 * 用户要求"让桌宠插件自身能实时自动更新余额监控，不需要进行别的操作"，
 * 所以取数搬到了桌宠主进程；渲染进程只是被动接收并显示。
 */
window.pet.on('pet:balance', (payload) => {
  try {
    if (!payload) return
    if (payload.snapshot !== undefined) {
      balanceState = payload.snapshot ?? null
      // 主进程能取到数就说明它活着，顺手清掉离线的降级标记。
      if (balanceState) hostOffline = false
    }
    if (Number.isFinite(payload.lowBalanceThreshold)) {
      lowBalanceThreshold = payload.lowBalanceThreshold
    }
    renderBalance()
  } catch {
    // 忽略：余额渲染失败不该影响其它功能。
  }
})

window.pet.on('pet:offline', () => {
  offlineTag.hidden = false
  /*
   * 宿主离线**不再**把余额面板标灰。
   *
   * 余额现在由桌宠自己取，与宿主在不在线无关 —— 宿主离线时余额照样是真实值，
   * 标灰反而会让人以为"余额不可信了"。
   */
})

window.pet.on('pet:say', (payload) => {
  const text = payload && typeof payload.text === 'string' ? payload.text : ''
  const ms = payload && Number.isFinite(payload.bubbleMs) ? payload.bubbleMs : 8000
  if (text) showBubble(text, 'say', ms)
})

window.pet.on('pet:reload-config', () => {
  // 本阶段没有可重载的配置；保留通路，后续阶段实现。
})

/**
 * 主进程改了窗口尺寸后推来的新布局参数。
 *
 * 这条通道是必需的：调整尺寸由主进程执行（它才能改窗口），但**重新计算立绘尺寸
 * 与气泡字号只能在渲染进程做**。早先只在启动时算过一次布局，所以调档时
 * 表现为"窗口变了、立绘没变"。
 */
window.pet.on('pet:layout', (payload) => {
  try {
    if (!payload) return
    applyLayout(payload.logicalWidth)
  } catch {
    // 忽略：布局更新失败不该中断桌宠。
  }
})

// ---------------------------------------------------------------- 动作播放
/*
 * 动作分两类：
 *  · 站立（standing）：常驻循环，不做事时的默认状态
 *  · 一次性动作：吃白饭 / 睡觉zzz / 玩mc，播完**自动回到站立**继续循环
 *
 * 播放状态（currentActionId / actionStopTimer）只有这一处，随机调度与右键菜单
 * 都走同一个入口 playAction()，因此不会出现"菜单点了动作但随机调度又插进来"的冲突。
 */

/** 当前正在播放的一次性动作 id；null = 在待机。 */
let currentActionId = null

/** 一次性动作的时长兜底定时器（帧播完/素材缺失时用来收尾）。 */
let actionStopTimer = null

/** 动作清单（由主进程下发，源头是 src/shared-core/actions.js）。 */
let actionCatalog = []

/**
 * 点击部位定义（由主进程下发，源头是 src/shared-core/actions.js 的 CLICK_PARTS）。
 * 坐标为素材画布的归一化值，因此与窗口尺寸/DPI 无关。
 */
let clickParts = []

/** 上一次播过的一次性动作 id，用于避免连续抽到同一个。 */
let lastRandomActionId = null

/**
 * 最近一次**尝试播放**的动作 id。
 *
 * 单独记一份的理由：动作素材可能还没做出来，此时会立刻退回站立动画，
 * `currentActionId` 随即被清空 —— 从外面看就像"根本没触发动作"。
 * 这个字段保留"确实尝试过什么"，便于诊断与测试。
 */
let lastPlayedActionId = null

/**
 * 取**可随机触发**的一次性动作（不含站立、惊醒、点击互动）。
 *
 * `oneShotActions` 这个函数名现在有点名不副实了 —— 它返回的是"随机池"。
 * 睡觉**在**随机池里（用户要求），但抽中它会走睡眠状态机而不是普通一次性播放；
 * 那个路由由 `triggerRandomAction` 处理（依据定义里的 `routToSleepState`）。
 *
 * ⚠️ 三类要排除，理由不同：
 *  · 站立 —— 是待机动画，不是"做一个动作"；
 *  · 惊醒 —— 只在"叫醒"时播放，随机抽到会很突兀；
 *  · 点击互动（head/chest/stomach/leg）—— 只在点击对应部位时播放。
 *
 * 排除方式是**按 id 黑名单**，而不是靠清单里的字段 —— 因为清单由主进程下发，
 * 渲染进程改动字段的可见性容易两边不一致。
 * 这里踩过两次：先漏了 awake，又漏了点击互动动画。
 * 所以自测的断言写成"随机池**恰好等于** eat, play-mc, sleep"，而不是"不含某个 id"。
 */
function oneShotActions() {
  const excluded = new Set([WAKE_ACTION_ID, ...partActionIds()])
  return actionCatalog.filter((action) => action.standing !== true && !excluded.has(action.id))
}

/** 点击互动动画的 id 集合（由主进程下发的 clickParts 里带 actionId 的项推导）。 */
function partActionIds() {
  return clickParts.map((part) => part.actionId).filter((id) => typeof id === 'string' && id)
}

/** 按 id 在**本进程拿到的动作清单**里找定义。 */
function findCatalogAction(id) {
  return actionCatalog.find((action) => action.id === id) ?? null
}

/**
 * 播放一个动作。
 *
 * @param {string} id
 * @param {{ fromMenu?: boolean, clickPart?: boolean, partId?: string|null }} [options]
 *        `partId` —— 从菜单「触碰{部位}」触发时带上，用于取**该部位的台词**，
 *        让"菜单触发"与"真的点那个位置"说同一句话。
 */
async function playAction(id, options = {}) {
  const entry = actionCatalog.find((action) => action.id === id)
  const label = entry ? entry.label : id

  // 站立的语义是"结束当前动作"。
  if (entry && entry.standing) {
    endAction()
    return
  }

  // 已经在播这个动作：不重入，避免定时器叠起来。
  if (currentActionId === id) return

  /*
   * 拖拽期间**禁止其他动画触发**（用户要求）。
   *
   * ⚠️ 这个守卫必须在**所有**分支之前，包括下面 sleep / awake 的早返回 ——
   * 否则拖拽时点右键"睡觉"仍会切走拖拽动画。我第一版就把它放在了后面，绕不过去。
   *
   * 放在 `playAction` 里是因为它是"非拖拽动画"的统一入口（菜单、随机动作、
   * 点击互动都走它），拦一次就全覆盖，比在每个调用点各写守卫更不容易漏。
   * 拖拽动画本身不走这里（它用 playOneShotHoldLast），不会被误拦。
   */
  if (dragging) {
    console.warn(`拖拽进行中，忽略动作 ${id}`)
    return
  }

  /*
   * 从菜单手动触发「睡觉」/「惊醒」时，走**状态机**而不是普通一次性动作：
   *  · 睡觉 → 进入 'sleeping'（循环尾帧、停掉随机动作，直到被叫醒）；
   *  · 惊醒 → 进入 'waking'（播完回到 'idle'）。
   * 否则手动睡下后不会维持睡眠姿态，与自动进入睡眠的行为不一致。
   */
  if (id === SLEEP_ACTION_ID) {
    void enterSleep()
    return
  }
  if (id === WAKE_ACTION_ID) {
    void wakeFromSleep()
    return
  }

  // 先停掉上一个动作，保证任何时刻只播一个。
  endAction()
  currentActionId = id
  /*
   * ⚠️ 这里**不写** `lastRandomActionId`。
   *
   * 它表示"上一次**随机抽中**的动作"，只用于随机抽取时避免连续重复
   * （见 triggerRandomAction）。原先这里无条件写入，导致菜单手动触发或点击互动
   * 也会占据这个位置 —— 于是"上一次随机动作"被非随机来源污染，
   * 反重复逻辑挡错了对象。赋值现在只在 triggerRandomAction 里做。
   */
  lastPlayedActionId = id

  const loaded = await loadAnimation(id)
  // 素材可能还没做出来。这时**不能留一个空白窗口**：
  // 退回站立动画，并用气泡说明，同时把这件事记进控制台便于排查。
  if (!loaded) {
    if (entry && entry.lines && entry.lines[0]) showBubble(entry.lines[0], 'say', 4000)
    console.warn(`动作 ${id} 的动画素材缺失，已退回站立动画`)
    currentActionId = null
    return
  }

  activeAnimationId = id
  showFrame(0)
  buildHitMasks()
  // 走播放计划：支持 loopRange（吃白饭的咀嚼段循环），到末尾自动停在最后一帧。
  //
  // ⚠️ 这里曾经写成 `state.planCursor = 0` —— 而 `state` 在这个作用域**并不存在**
  // （那个名字是测试读状态用的）。ReferenceError 让后面的 showFrame/起播全部没执行，
  // 表现为"动作卡在第 0 帧"。教训：**纯数据的单元断言（播放计划）过了，不代表
  // 真的能在界面上播起来** —— 播放路径本身也需要一条端到端断言。
  startPlanPlayback(id)

  // 台词：一次性动作配一句（占位符在 shared-core 里）。
  //
  // ⚠️ 从菜单「触碰{部位}」触发时（options.partId）要改用**该部位的台词** ——
  // 素材 id（如 stomach）与部位 id（belly）并不同名，而且部位台词本来就定义在
  // clickParts 里，所以按 partId 去那里取，而不是用动作自己的 lines。
  const partDef = options.partId ? clickParts.find((p) => p.id === options.partId) : null
  const bubbleLine = partDef && partDef.lines && partDef.lines[0] ? partDef.lines[0] : null
  if (bubbleLine) showBubble(bubbleLine, 'say', 5000)
  else if (entry && entry.lines && entry.lines[0]) showBubble(entry.lines[0], 'say', 5000)

  /*
   * 播完回到站立。时长按**播放计划**的长度算，而不是帧数 ——
   * 清单里的 `loopRange` 会把某些帧重复若干次（例如吃白饭的咀嚼段循环 4 次），
   * 用帧数算会让定时器提前触发、把动画从中间切断。
   */
  const frames = Math.max(1, planLengthOf(loaded))
  const fps = loaded.fps > 0 ? loaded.fps : 6
  const onceMs = Math.round((frames / fps) * 1000)
  // 循环动作（清单 loop:true）在"一次性"语境下也按一遍算，否则永远不结束。
  const holdMs = Math.max(1200, onceMs + 150)
  actionStopTimer = setTimeout(() => {
    actionStopTimer = null
    /*
     * ⚠️ 拖拽期间**不许**收尾。
     *
     * 为什么需要：拖拽开始时 `endAction()` 会把 `currentActionId` 清空并停掉
     * 当时的收尾定时器，但**这个回调仍可能因种种时序原因被触发**
     * （例如定时器在 `endAction()` 之前就已进入任务队列）。而它的第一件事就是
     * `endAction()`，那会把正在播的**拖拽动画**从中间切成站立 ——
     * 实测现象：`active=stand（期望 hang）`，诊断里写着
     * `最近一次 endAction：动作=head`。短动作（head 10 帧 ≈ 1.85s）的收尾
     * 正好落在拖拽动画的播放窗口里，最容易撞上。
     *
     * 修法不是"想办法把定时器清干净"（时序问题清不干净），而是**让收尾自己判断**：
     * 正在拖拽就什么都不做 —— 那个动作早就被 `endAction()` 结束过了。
     */
    if (dragging) return
    endAction()
    /*
     * 什么时候该重置闲置计时：
     *  · fromMenu（右键手动触发）—— 不重置，用户主动操作不代表"闲置结束"；
     *  · clickPart（点击部位互动）—— 不重置。它是一次即时互动，
     *    重置会让"闲置模式"被每次点按不断推迟；
     *  · 随机动作播完 —— **要**重置，而且**退出闲置模式**（传 true）：
     *    按用户要求，播完一个随机动作后必须再连续闲置 3 分钟才能继续触发。
     */
    if (options.fromMenu || options.clickPart) return
    resetIdleTimer(true)
  }, holdMs)
}

/** 最近一次 endAction 的上下文（诊断用）。 */
let lastEndActionInfo = null

/** 最近一次"点击还是拖动"的判定输入（诊断用）。 */
let lastClickDecision = null

/** 结束当前一次性动作，回到站立循环。 */
function endAction() {
  if (actionStopTimer) {
    clearTimeout(actionStopTimer)
    actionStopTimer = null
  }
  const finished = currentActionId
  /*
   * 诊断：记录"动作是怎么结束的"。
   *
   * 为什么需要它：曾出现"拖拽动画播到一半被切回站立"，但从外部只能看到结果，
   * 无法区分是**动作定时器到点**、还是**宿主状态变化打断**、还是**被新动作顶掉**。
   * 这三种原因的修法完全不同，所以这里把终态与调用栈摘要留下来供测试断言。
   */
  lastEndActionInfo = {
    finishedActionId: finished,
    wasAnimation: activeAnimationId,
    hadStopTimer: finished !== null,
    at: Date.now(),
    stack: String(new Error().stack ?? '').split('\n').slice(1, 4).join(' | '),
  }
  /*
   * ⚠️ 特别记录"在 waking 期间结束动作"（诊断"卡在 waking"用）。
   *
   * 惊醒是靠一个 `actionStopTimer` 到点后调 `finishWake()` 来收尾的；
   * 若这个定时器在唤醒过程中被别的 `endAction()` 清掉，`finishWake()` 就永远不会执行，
   * petState 会**永久停在 'waking'**。
   * 现在 `armWakingWatchdog()` 会兜底（6 秒后强制收尾），这里保留少量记录
   * 以便兜底真的触发时能看出是被谁清的。
   */
  if (petState === 'waking') {
    wakingEndInfo.push({
      at: Date.now(),
      clearedStopTimer: actionStopTimer !== null,
      finishedActionId: finished,
      stack: lastEndActionInfo.stack,
    })
    if (wakingEndInfo.length > 5) wakingEndInfo.shift()
  }
  currentActionId = null
  if (finished) disposeAnimation(finished)

  // 回到站立。
  if (activeAnimationId !== 'stand') {
    activeAnimationId = 'stand'
    const stand = animations.get('stand')
    if (stand && stand.ready) {
      showFrame(0)
      buildHitMasks()
      startLoop('stand')
    }
  }
}

// ---------------------------------------------------------------- 闲置动作调度
/*
 * 需求（用户指定）：
 *
 *   保持闲置 **3 分钟**后，**每分钟**都有 **1/10** 的概率触发一个随机闲置动作。
 *
 * 也就是说：
 *  · 连续闲置满 3 分钟才进入「闲置模式」；
 *  · 之后每分钟掷一次骰子（命中概率 1/5），命中就随机做一个动作
 *    （吃白饭 / 玩mc / 睡觉）；
 *  · 播完一个动作后**退出闲置模式**，要再连续闲置 3 分钟才能继续触发；
 *  · 期望等待 ≈ 5 分钟一次（几何分布），不会"到点必做"。
 *
 * 门控仍然是 `isTrulyIdle()`：宿主一进入思考/干活，或用户开始拖拽，
 * 闲置计时就**从零重新起算** —— 否则"我一直在用，它却突然开始吃饭"会很怪。
 *
 * 这里的"闲置语音"已整体去掉（用户要求）：闲置时只会做动作，不会说话。
 *
 * ⚠️ 下面这三个常量是**兜底默认值**，真实值由主进程从动作库
 * （`src/shared-core/actions-library.js` 的 `RANDOM_ACTION_RULES`）下发覆盖。
 * 之所以还留一份：渲染进程可能因为旧版主进程/通信失败而拿不到下发值，
 * 那时用默认值仍能正常工作。**改触发节奏请改库，不要改这里。**
 */

/** 需要连续闲置多久才进入「闲置模式」（毫秒）。 */
const IDLE_TRIGGER_AFTER_MS = 3 * 60 * 1000

/** 掷骰子的周期（毫秒）。 */
const IDLE_FIRE_INTERVAL_MS = 60 * 1000

/** 每次掷骰子命中的概率。用户指定 **1/5**。 */
const IDLE_FIRE_PROBABILITY = 0.2

/**
 * 闲置随机动作回复的心情区间（用户指定 10~30）。
 *
 * 只是**展示与兜底**用 —— 真正加心情的是主进程（心情归它管），
 * 这里拿到区间是为了在日志/自测里能说明"这次该给多少"。
 * 同样由主进程下发覆盖。
 */
let actionMoodGainRange = { min: 10, max: 30 }

/**
 * 闲置计时的起点（毫秒时间戳）；null = 当前不在闲置。 */
let idleSinceMs = null

/** 掷骰子的调度定时器。 */
let idleTimer = null

/**
 * 测试用：可注入的"当前时间"。
 * 为 null 时用真实时间。测试靠它跳过 3 分钟等待，而不必真的等。
 */
let idleNowOverride = null

/** 取当前时间（测试可注入）。 */
function idleNow() {
  return idleNowOverride ?? Date.now()
}

/** 宿主当前的工作档位。'idle' 之外的任何值都表示 DSH 在忙。 */
let currentWorkStatus = 'idle'

/**
 * 桌宠自己的状态机（与宿主的 workStatus 正交）。
 *
 * ```
 * 'idle'     普通闲置：可触发随机动作（睡眠也由随机动作触发）
 * 'sleeping' 睡眠中：循环睡觉动画的尾帧；**不再触发随机动作**；点击可叫醒
 * 'waking'   惊醒动画播放中：播完回到 'idle'
 * ```
 */
let petState = 'idle'

/**
 * 「闲置模式」的下一次可触发时刻（毫秒时间戳）；null = 门槛尚未起算。
 *
 * 用户要求：连续闲置满 3 分钟才进入闲置模式（可掷骰子触发）；
 * **播完一个随机动作后退出闲置模式**，之后要再连续闲置 3 分钟才能继续触发。
 *
 * 用"时刻"而不是"计时起点"，是因为随动作播完的重置要表达成"推后 3 分钟"，
 * 写成时刻最直白；判定也只有一句 `now < idleReadyAtMs`。
 */
let idleReadyAtMs = null

/**
 * 状态变迁日志（诊断用，最近 40 条）。
 *
 * 为什么需要：睡眠"过一会儿自己中断"这类问题，现象只告诉你"结果变了"，
 * 而切换 petState 的地方有好几处（点击唤醒、宿主开始工作、拖拽中断、
 * 惊醒播完）。光看代码猜不出是哪一处，必须把**每次变迁的调用点**记下来。
 */
const stateLog = []

/** 记录一次状态变迁。 */
function setPetState(next, reason) {
  if (next === petState) return
  const from = petState
  petState = next
  stateLog.push({
    at: Date.now(),
    from,
    to: next,
    reason,
    stack: String(new Error().stack ?? '')
      .split('\n')
      .slice(2, 5)
      .map((s) => s.trim())
      .join(' | '),
  })
  if (stateLog.length > 40) stateLog.shift()
  if (TRACE_STATE) console.log(`[petState] ${from} → ${next}（${reason}）`)
}

/**
 * `waking` 状态的看门狗：确保惊醒动画一定会收尾。
 *
 * 为什么需要（这是排查出的一个**真实缺陷**）：
 * 惊醒是靠一个 `actionStopTimer` 到点调 `finishWake()` 来收尾的，而
 * `endAction()` 会**无条件**清掉 `actionStopTimer`。于是在"唤醒进行中又被
 * 别的路径调了一次 `endAction()`"的竞态下，收尾定时器被清掉、
 * `finishWake()` 永远不执行，`petState` 就**永久卡在 'waking'** ——
 * 之后 `canTriggerRandomAction()` 恒为 false，所有随机动作（含睡眠）全废。
 * 实测这是偶发（五次里两三次），且一旦发生会让后续一整片用例连锁失败。
 *
 * 修法不是"找到那一次竞态"（它依赖时序，难稳定复现），而是让 `waking`
 * **自带兜底**：进入 waking 时起一个略长于收尾时限的看门狗，到点若仍是 waking
 * 就强制收尾。正常路径下 `finishWake()` 会先跑并把看门狗清掉，
 * 所以兜底只在异常时生效 —— 属于"防御性修复"，不是掩盖问题：
 * 触发时会在控制台留下 `waking 看门狗触发` 的告警。
 */
let wakingWatchdog = null

/** 惊醒收尾的时限（毫秒）：与 wakeFromSleep 里排的时间一致。 */
function armWakingWatchdog() {
  clearWakingWatchdog()
  wakingWatchdog = setTimeout(() => {
    wakingWatchdog = null
    if (petState !== 'waking') return
    console.warn('[pet] waking 看门狗触发：惊醒收尾定时器未生效，强制回到闲置')
    finishWakeInfo = { at: Date.now(), before: petState, watchdog: true, currentActionId, activeAnimationId }
    endAction()
    setPetState('idle', '惊醒看门狗兜底')
    resetIdleTimer(true)
  }, 6000)
}

/** 清掉 waking 看门狗。 */
function clearWakingWatchdog() {
  if (wakingWatchdog) {
    clearTimeout(wakingWatchdog)
    wakingWatchdog = null
  }
}

/** 是否打印状态变迁（跟随主进程的 --trace-geometry 之类开关）。 */
const TRACE_STATE = new URLSearchParams(location.search).has('trace-state')

/** 现在是否处于"真正的闲置"：宿主不忙、没有动作在播、没有在拖拽。 */
function isTrulyIdle() {
  return currentWorkStatus === 'idle' && currentActionId === null && !dragging
}

/**
 * 现在是否**允许触发随机动作**。
 *
 * 比 `isTrulyIdle()` 更严：睡眠/惊醒期间一律不允许（用户要求
 * "睡觉状态期间不再触发随机动作"）。睡眠时 `currentActionId` 本来就是
 * 'sleep'，所以这条其实是双保险，但语义更清楚。
 */
function canTriggerRandomAction() {
  return isTrulyIdle() && petState === 'idle'
}

/**
 * 重置闲置计时并重排调度。
 *
 * 调用时机：进入闲置、拖拽结束、宿主状态变化。
 * 语义是"闲置时间从这一刻重新起算"。
 *
 * @param {boolean} [resetIdleMode] 是否**同时退出闲置模式**（把"下次可触发时刻"
 *        推后 3 分钟）。随机动作播完后传 true —— 这是用户要求的
 *        "播完一个随机动作后退出闲置模式，再过三分钟进入闲置模式才能继续触发"。
 */
function resetIdleTimer(resetIdleMode = false) {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  idleSinceMs = isTrulyIdle() ? idleNow() : null
  if (resetIdleMode) {
    // 退出闲置模式：必须再连续闲置 idleTriggerAfterMs 才有资格触发。
    idleReadyAtMs = idleNow() + idleTriggerAfterMs
  } else if (!isTrulyIdle()) {
    idleReadyAtMs = null
  }
  scheduleIdleTick()
}

/** 安排下一次掷骰子。 */
function scheduleIdleTick() {
  if (idleTimer) return
  // 测试模式下会把间隔压得很短；这里不再有 3 秒下限，
  // 否则 __petTestSetIdleInterval(600) 会被悄悄抬回 3000，让测试等得莫名其妙。
  const delay = Math.max(200, idleFireIntervalMs)
  idleTimer = setTimeout(() => {
    idleTimer = null
    try {
      onIdleTick()
    } catch (err) {
      // 定时器回调里抛异常会中断后续调度，必须兜住。
      console.warn('闲置调度出错：', err)
    }
    scheduleIdleTick()
  }, delay)
}

/**
 * 判断这一次"到点"是否应该触发动作（纯判定，不产生副作用）。
 *
 * 抽成独立函数有两个好处：
 *  · 概率与门槛的判定可以**单独验证**，不必真的等 3 分钟、也不必让动作播起来；
 *  · `onIdleTick()` 只负责"判定通过就播"，职责单一。
 *
 * @param {number} now 当前时间戳
 * @returns {boolean}
 */
function shouldFireIdleAction(now) {
  // 睡眠/惊醒期间不触发随机动作（用户要求）。
  if (!canTriggerRandomAction()) {
    // 不闲置了就把"闲置模式"的门槛清掉，等下次真正闲置时重新起算。
    idleReadyAtMs = null
    return false
  }

  /*
   * 「闲置模式」门槛（用户要求）：
   *
   *   必须**连续闲置满 3 分钟**才进入可触发的闲置模式；
   *   触发并播完一个随机动作后**退出闲置模式**，
   *   之后要再连续闲置 3 分钟才能继续触发。
   *
   * 实现上就是一个时间戳 `idleReadyAtMs`：第一次进入闲置时设为 now + 3 分钟，
   * 之后不动它；随机动作播完时把它**重新推后 3 分钟**（见 resetIdleTimer 的
   * resetIdleMode 参数）。
   *
   * ⚠️ 为什么不用 `idleSinceMs` 直接判 3 分钟：动作播完后会调用
   * `resetIdleTimer()` 把 idleSinceMs 重置为"现在"，若再叠一个"立刻退出闲置模式"
   * 的标记，逻辑会绕。用"下一次允许触发的时刻"表达，语义最直白、也最好断言。
   */
  if (idleReadyAtMs === null) idleReadyAtMs = now + idleTriggerAfterMs
  // 硬门槛：还没到"下次允许触发"的时刻，连骰子都不掷。
  if (now < idleReadyAtMs) return false

  if (oneShotActions().length === 0) return false
  return Math.random() < idleFireProbability
}

/**
 * 到点：按概率决定是否触发一个随机动作。
 *
 * ⚠️ 这里**不再有"闲置满 10 分钟必定入睡"那条规则**（已移除）。
 * 原因：睡眠现在是"循环 20~40 轮后自动醒来"的**有始有终**动作，
 * 若再叠一条"闲置满 10 分钟必然入睡"，桌宠会陷入
 * "睡 40~80 秒 → 醒 → 立刻又到门槛 → 再睡"的循环打盹。
 *
 * 睡眠现在只有一条触发路径：**随机池抽中**（它已在 RANDOM_ACTIONS 里）。
 */
function onIdleTick() {
  if (!shouldFireIdleAction(idleNow())) return
  triggerRandomAction()
}

/** 随机触发一个动作（避免与上一次重复）。 */
function triggerRandomAction() {
  const pool = oneShotActions()
  if (pool.length === 0) return
  const candidates = pool.length > 1 ? pool.filter((action) => action.id !== lastRandomActionId) : pool
  const chosen = candidates[Math.floor(Math.random() * candidates.length)]
  if (!chosen) return

  /*
   * 闲置随机动作**回复心情**（用户指定 10~30）。
   *
   * ⚠️ 只有"随机抽中"才给：菜单手动触发（`pet:trigger-action`）与点击互动都不走
   * 这里，所以不会误发。加多少由主进程从区间里随机取（心情归它管），
   * 这里只负责"通知一声"。
   */
  lastRandomActionId = chosen.id
  try {
    window.pet.rewardAction(chosen.id)
  } catch (err) {
    console.warn('闲置动作心情奖励通知失败：', err)
  }
  console.info(
    `[idle] 触发随机动作 ${chosen.id}，回复心情 ${String(actionMoodGainRange.min)}~${String(actionMoodGainRange.max)}`,
  )

  /*
   * 抽到"睡觉"时**走睡眠状态机**，而不是当普通一次性动作播一遍。
   *
   * 判据是定义里的 `routToSleepState`（由主进程下发），不是 `id === 'sleep'` ——
   * 标志写在数据里，将来若还有别的动作要进入某种持续状态，也能复用同一机制。
   *
   * 若不这样路由，"睡觉"这个随机动作只会播一遍进入动画就回站立：
   * 观感上等于"躺一下又爬起来"，而不是真的睡着。
   */
  if (chosen.routToSleepState) {
    void enterSleep()
    return
  }

  void playAction(chosen.id, { fromMenu: false })
}

// ---------------------------------------------------------------- 睡眠状态机
/*
 * 需求（用户指定）：
 *
 *  闲置**持续 10 分钟** → 进入睡眠（不是随机，是必然）
 *  睡眠中              → 播完进入动画后**循环最后两帧**
 *  睡眠中              → **一切语音与动作触发全部禁用**（只保留"点击叫醒"）
 *  用户点击 / 宿主开始工作 → 结束睡眠、播放惊醒动画
 *  惊醒动画播完         → 回到闲置状态（闲置计时重新起算）
 *
 * 三条退出路径的行为差异是刻意的：
 *  · 用户点击      → wakeFromSleep()，**播惊醒动画**
 *  · 宿主开始工作   → wakeFromSleep()，**播惊醒动画**
 *  · 用户开始拖拽   → interruptSleep()，**不播惊醒**（会和悬空动画抢画面）
 */

/**
 * 进入睡眠状态。
 *
 * 与普通一次性动作的区别：**不排定时器**。普通动作播完会自动回站立，
 * 而睡眠要一直维持到被叫醒，因此这里只负责起播，退场交给 `wakeFromSleep`。
 */
async function enterSleep() {
  if (petState !== 'idle') return
  /*
   * ⚠️ 拖拽期间不允许进入睡眠。
   *
   * `playAction` 里已经有一道"拖拽期间禁止触发其他动画"的守卫，但那只挡住了
   * 走 playAction 的入口。`enterSleep` / `wakeFromSleep` 还会被**测试钩子**与
   * 其它内部路径直接调用，所以守卫必须在这里也有一份 —— 否则能造出
   * "拖拽动画在播，同时进入睡眠"的矛盾状态（实测出现过，随后点击行为全乱）。
   */
  if (dragging) {
    console.warn('拖拽进行中，忽略进入睡眠')
    return
  }

  const entry = findCatalogAction(SLEEP_ACTION_ID)
  if (!entry) {
    console.warn(`动作清单里没有 ${SLEEP_ACTION_ID}，无法进入睡眠`)
    return
  }

  // 素材先确认可用，再改状态 —— 否则素材缺失会把 petState 卡在 'sleeping'。
  const loaded = await loadAnimation(SLEEP_ACTION_ID)
  if (!loaded) {
    console.warn(`睡觉动画素材缺失，取消进入睡眠`)
    return
  }

  /*
   * 状态先置为 'sleeping'，再弹"我要睡了"那句。
   *
   * ⚠️ 顺序不能反。`showBubble()` 里有一条"睡眠期间禁用一切语音"的守卫，
   * 它检查 petState。若先弹台词再置状态，守卫还没生效，台词能显示；
   * 而我们要的恰恰是**能显示**这一句（它是入睡预告，不是睡梦中的呓语），
   * 所以必须让 `showBubble` 调用发生在状态置位**之前**。
   * 换句话说：下面的 showBubble 之所以不被守卫拦掉，正是因为这个顺序。
   */
  setPetState('sleeping', '闲置满 10 分钟 / 菜单手动触发')
  // 睡眠期间不再掷骰子（这里把调度也停掉，省得空转）。
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }

  endAction()
  /*
   * 收起入睡前残留的气泡（例如刚播完的"去挖矿了"）。
   *
   * 这一步不能省：`showBubble` 的睡眠守卫只是"不再显示新气泡"，
   * 并不会清掉屏幕上已有的那一句 —— 实测入睡后那句动作台词会一直挂着不消失，
   * 观感就是"都睡着了还在说去挖矿了"。
   */
  hideBubble()
  currentActionId = SLEEP_ACTION_ID
  lastPlayedActionId = SLEEP_ACTION_ID
  activeAnimationId = SLEEP_ACTION_ID
  showFrame(0)
  buildHitMasks()
  // 进入动画播完后会自动接上"循环最后两帧"（见 startPlanPlayback）。
  startPlanPlayback(SLEEP_ACTION_ID)
  if (entry.lines && entry.lines[0]) showBubble(entry.lines[0], 'say', 4000)
}

/**
 * 从睡眠中被叫醒：立刻切到惊醒动画。
 *
 * 叫醒**不说话、不加心情**（用户要求）—— 点击在睡眠期间的语义是"叫醒"，
 * 不是普通互动，所以部位台词与心情 +10 都跳过。
 */
async function wakeFromSleep() {
  // 惊醒动画播放中不重入，避免定时器叠加、把动画打断成半截。
  if (petState === 'waking') return
  // 从睡眠中被叫醒是正常路径；从闲置态被菜单手动触发也允许
  // （就是单纯播一遍惊醒动画，播完仍回闲置）。
  if (petState !== 'sleeping' && petState !== 'idle') return
  // 拖拽期间不允许插播惊醒动画（与 enterSleep 同理，见那里的说明）。
  if (dragging) {
    console.warn('拖拽进行中，忽略惊醒动画')
    return
  }

  setPetState('waking', '被叫醒（点击或宿主开始工作）')
  // 起兜底看门狗：万一收尾定时器被清掉，6 秒后强制回到闲置（见 armWakingWatchdog）。
  armWakingWatchdog()
  endAction()
  currentActionId = WAKE_ACTION_ID
  lastPlayedActionId = WAKE_ACTION_ID

  const loaded = await loadAnimation(WAKE_ACTION_ID)
  if (!loaded) {
    console.warn(`惊醒动画素材缺失，直接回到闲置`)
    finishWake()
    return
  }

  activeAnimationId = WAKE_ACTION_ID
  showFrame(0)
  buildHitMasks()
  startPlanPlayback(WAKE_ACTION_ID)

  // 惊醒是普通一次性动作：播完自己退回站立并回到闲置。
  const entry = findCatalogAction(WAKE_ACTION_ID)
  if (entry && entry.lines && entry.lines[0]) showBubble(entry.lines[0], 'say', 4000)

  const frames = Math.max(1, planLengthOf(loaded))
  const fps = loaded.fps > 0 ? loaded.fps : 6
  const holdMs = Math.max(1200, Math.round((frames / fps) * 1000) + 150)
  actionStopTimer = setTimeout(() => {
    actionStopTimer = null
    finishWake()
  }, holdMs)
}

/** 惊醒结束：回到闲置状态，并把闲置计时重新起算。 */
function finishWake() {
  clearWakingWatchdog()
  finishWakeInfo = {
    at: Date.now(),
    before: petState,
    currentActionId,
    activeAnimationId,
  }
  endAction()
  setPetState('idle', '惊醒播完')
  /*
   * 传 true：睡眠也算"播过了一个随机动作"，醒来后同样要**退出闲置模式**，
   * 再连续闲置 3 分钟才能继续触发。
   *
   * 睡眠走的是状态机（没有 actionStopTimer），所以这个重置不能只靠
   * playAction 的收尾定时器 —— 必须在这里补一次。
   */
  resetIdleTimer(true)
}

/**
 * 最近一次惊醒收尾的上下文（诊断用）。
 *
 * 为什么需要：曾出现"petState 卡在 waking 再也不回 idle"，随后所有睡眠用例全废。
 * 只有把这个函数真的跑过的证据（时间、进入前后的状态）留下来，
 * 才能区分"收尾定时器没触发"与"触发了但状态又被改回去"。
 */
let finishWakeInfo = null

/** waking 期间发生的 endAction 记录（诊断"卡在 waking"用）。 */
const wakingEndInfo = []

/**
 * 强行打断睡眠状态（**不播惊醒动画**）。
 *
 * 只有**拖拽**走这条路：用户把睡着的桌宠拎起来时，惊醒动画会和
 * "被拎起来"的悬空动画抢同一块画面，观感很乱，所以拖拽直接结束睡眠。
 *
 * "用户点击"与"宿主开始工作"走的是 `wakeFromSleep()`（会播惊醒），
 * 这三条路径的区别是刻意的，不要合并。
 */
function interruptSleep(reason) {
  if (petState === 'idle') return
  console.warn(`睡眠状态被强行中断（${reason}）`)
  setPetState('idle', `强行中断：${reason}`)
  endAction()
  resetIdleTimer()
}

// ---------------------------------------------------------------- 心情与属性面板
/*
 * 心情的**数值与衰减归主进程管**（它要持久化到文件），渲染进程只负责：
 *  · 把值画成进度条；
 *  · 在被点击时通知主进程加心情；
 *  · 光标悬停在角色上时显示面板。
 *
 * 悬停判定复用逐像素命中测试的结果（updateHitTest），因此"光标在透明区域"
 * 不会误触发面板 —— 与鼠标穿透行为完全一致，不会出现"面板亮着但点不到"的矛盾。
 */

/** 最近一次收到的心情快照。 */
let moodState = { value: 100, tier: 'happy' }

/**
 * 最近一次收到的好感快照。
 *
 * 默认值只是**首屏兜底**（主进程的 `pet:get-initial` 会立刻覆盖它）：
 * 0 颗心、阶段 0、第一段阈值 100。
 */
let affectionState = {
  value: 0,
  hearts: 0,
  threshold: 100,
  maxHearts: 5,
  heartsText: '♡♡♡♡♡',
  heartsLabel: '陌生',
  progress: 0,
  stages: [],
}

/** 属性面板当前是否显示。 */
let statsVisible = false

/** 心情档位 → 展示文案（与 shared-core/mood.js 的 MOOD_TIER_LABELS 对应）。 */
const MOOD_TIER_TEXT = {
  happy: '心情很好',
  normal: '还不错',
  low: '有点低落',
  sad: '不开心',
}

/**
 * 最近一次收到的余额快照（宿主下发）。
 *
 * 默认值是"还没拿到"：面板显示 `--`，而不是显示 `¥0.00` ——
 * 后者会被误读成"余额真的空了"。这个区分很重要。
 */
let balanceState = null

/** 余额低于多少算"告急"（着色用）。由宿主通过启动参数下发。 */
let lowBalanceThreshold = 10

/** 当前是否处于"宿主离线"状态（离线时余额面板标灰）。 */
let hostOffline = false

/** 把余额画到常驻面板上。 */
function renderBalance() {
  if (!balanceValueEl) return
  const body = balancePanel ? balancePanel.querySelector('.balance-body') : null
  const setClass = (name, on) => {
    if (body) body.classList.toggle(name, on)
  }

  const snap = balanceState
  // 还没有任何数据（宿主没推过 / 宿主离线）。
  if (!snap) {
    balanceValueEl.textContent = '--'
    if (balanceNoteEl) balanceNoteEl.textContent = hostOffline ? '宿主离线' : ''
    setClass('is-low', false)
    setClass('is-error', true)
    return
  }

  const currency = String(snap.currency ?? 'CNY')
  const symbol = currency === 'USD' ? '$' : '¥'
  const total = String(snap.total ?? '0.00')
  const numeric = Number(total)

  // 取数失败时**保留上一次的数字**（快照里带 error），只把配色改成灰/告急。
  // 这样一次网络抖动不会让面板变成"--"，用户看到的数还是最近一次真实的。
  balanceValueEl.textContent = `${symbol}${total}`

  const hasError = typeof snap.error === 'string' && snap.error.length > 0
  const low = Number.isFinite(numeric) && numeric < lowBalanceThreshold
  setClass('is-low', low && !hasError)
  setClass('is-error', hasError || hostOffline || snap.stale === true)

  if (balanceNoteEl) {
    if (hostOffline) balanceNoteEl.textContent = '宿主离线'
    else if (hasError) balanceNoteEl.textContent = '取数失败'
    else if (snap.stale === true) balanceNoteEl.textContent = '已过期'
    else if (low) balanceNoteEl.textContent = '余额告急'
    else balanceNoteEl.textContent = ''
  }
}

/** 把心情画到属性面板上。 */function renderMood() {
  const value = Number.isFinite(moodState.value) ? moodState.value : 100
  if (moodFill) {
    moodFill.style.width = `${String(Math.max(0, Math.min(100, value)))}%`
    moodFill.classList.remove('tier-normal', 'tier-low', 'tier-sad')
    if (moodState.tier === 'normal') moodFill.classList.add('tier-normal')
    else if (moodState.tier === 'low') moodFill.classList.add('tier-low')
    else if (moodState.tier === 'sad') moodFill.classList.add('tier-sad')
  }
  if (moodValueEl) moodValueEl.textContent = String(Math.round(value))
  if (moodTierEl) moodTierEl.textContent = MOOD_TIER_TEXT[moodState.tier] ?? ''
}

/**
 * 把好感画到属性面板上（显示在心情**上方**）。
 *
 * 三个元素各自对应一项信息：
 *  · 进度条 —— 当前阶段的进度（阶段值 ÷ 本段阈值）；
 *  · 数值   —— `阶段值/阈值`（如 `37/100`），比纯百分比更明确"还差多少晋心"；
 *  · 爱心串 —— 爱心数（实心 = 已达到，空心 = 还没到），一开始是 0 颗心。
 *
 * ⚠️ 爱心数（长期）与进度条（本段）**不是**同一件事：爱心是攒满了几段，
 * 进度条是这一段里攒了多少。满级 5 心后进度条还能继续涨到 3000/3000。
 */
function renderAffection() {
  const s = affectionState
  const threshold = Number.isFinite(s.threshold) && s.threshold > 0 ? s.threshold : 100
  const value = Number.isFinite(s.value) ? s.value : 0
  const ratio = Number.isFinite(s.progress) ? s.progress : Math.min(1, value / threshold)

  if (affectionFill) affectionFill.style.width = `${String(Math.max(0, Math.min(100, ratio * 100)))}%`
  if (affectionValueEl) affectionValueEl.textContent = `${String(Math.round(value))}/${String(threshold)}`
  if (affectionHeartsEl) {
    // 爱心串由主进程（共享核心）生成；拿不到时按爱心数现算，避免显示空白。
    const hearts =
      typeof s.heartsText === 'string' && s.heartsText
        ? s.heartsText
        : '♥'.repeat(Math.max(0, Math.min(s.maxHearts || 5, s.hearts || 0))).padEnd(s.maxHearts || 5, '♡')
    affectionHeartsEl.textContent = hearts
  }
}

/** 显示/隐藏属性面板。 */
function setStatsVisible(visible) {
  if (visible === statsVisible) return
  statsVisible = visible
  if (!statsPanel) return
  statsPanel.hidden = !visible
  if (visible) renderMood()
}

/**
 * 判断点击落在哪个部位。
 *
 * 输入是**视口坐标**（clientX/clientY），内部换算成素材画布的归一化坐标
 * （0~1）再与部位矩形比较 —— 因此与窗口尺寸、DPI 完全无关。
 *
 * 用帧元素（`frameEl`）的矩形做换算基准，因为它的位置与尺寸就是角色在屏幕上的
 * 实际落点；`getBoundingClientRect` 已经把 translateY 微调算进去了。
 *
 * @param {number} clientX
 * @param {number} clientY
 * @returns {{ part: object, u: number, v: number } | null} 命中的部位与归一化坐标
 */
function resolveClickPart(clientX, clientY) {
  if (!Array.isArray(clickParts) || clickParts.length === 0) return null
  const rect = frameEl.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return null
  const u = (clientX - rect.left) / rect.width
  const v = (clientY - rect.top) / rect.height
  if (u < 0 || u > 1 || v < 0 || v > 1) return null

  for (const part of clickParts) {
    const boxes = Array.isArray(part.box) ? part.box : [part.box]
    for (const box of boxes) {
      if (!box) continue
      if (u < box.x0 || u > box.x1 || v < box.y0 || v > box.y1) continue
      /*
       * 梯形支持（可选）：`taper: { x0, x1 }` 给出**底边**的左右边界。
       *
       * 为什么需要：围裙是上窄下宽的梯形，躯干在胸腹段随高度变化——
       * 用一个矩形要么上端越界（把两侧头发圈进来）、要么下端太窄。
       * 梯形能贴合这种"随高度变宽"的躯干，比矩形精确得多。
       * 不写 taper 时退化为矩形（头、腿就是这样）。
       */
      if (box.taper) {
        const t = (v - box.y0) / Math.max(1e-6, box.y1 - box.y0)
        const lo = box.x0 + (box.taper.x0 - box.x0) * t
        const hi = box.x1 + (box.taper.x1 - box.x1) * t
        if (u < lo || u > hi) continue
      }
      return { part, u, v }
    }
  }
  return null
}

/**
 * 随机取一句部位台词（避免连续重复同一句）。
 * @param {string[]} lines
 * @returns {string}
 */
function pickPartLine(lines) {
  if (!Array.isArray(lines) || lines.length === 0) return ''
  if (lines.length === 1) return lines[0]
  const last = lastPartLine[lines[0]]
  let index = Math.floor(Math.random() * lines.length)
  for (let attempt = 0; attempt < 6 && index === last; attempt += 1) {
    index = Math.floor(Math.random() * lines.length)
  }
  lastPartLine[lines[0]] = index
  return lines[index] ?? ''
}

/** 每个部位上一次说过的台词下标，避免连续重复（以该部位首句为键）。 */
const lastPartLine = {}

// ---------------------------------------------------------------- 主进程推送
window.pet.on('pet:mood', (payload) => {
  try {
    if (!payload) return
    moodState = { value: Number(payload.value), tier: String(payload.tier ?? 'happy') }
    if (statsVisible) renderMood()
  } catch {
    // 忽略：心情渲染失败不该影响其它功能。
  }
})

window.pet.on('pet:affection', (payload) => {
  try {
    if (!payload) return
    affectionState = { ...affectionState, ...payload }
    if (statsVisible) renderAffection()
  } catch {
    // 忽略：好感渲染失败不该影响其它功能。
  }
})

window.pet.on('pet:play-action', (payload) => {
  try {
    if (!payload || typeof payload.id !== 'string') return
    void playAction(payload.id, {
      fromMenu: Boolean(payload.fromMenu),
      // 触碰部位时带上 partId，让菜单触发也能说该部位的台词。
      partId: typeof payload.partId === 'string' ? payload.partId : null,
    })
  } catch (err) {
    console.warn('播放动作失败：', err)
  }
})

// ---------------------------------------------------------------- 测试钩子
/*
 * 只在主进程以 --selftest / --test-drag-follow 启动时才会被主进程读取。
 * 这里无条件暴露，是因为渲染进程无法知道启动参数；副作用仅是给 window 挂了
 * 两个只读函数，既不改行为也不外泄数据。
 *
 * 暴露的是**内部状态**而不是让测试去猜 DOM：闲置门控、随机动作、当前动画这些
 * 都是事件驱动的，只有读内部状态才能做出确定性的断言。
 */
window.__petTestState = () => {
  const act = activeAnimation()
  return {
    currentActionId,
    lastPlayedActionId,
    activeAnimationId,
    /** 当前动画的帧序号与总帧数 —— 用于验证"停在最后一帧"。 */
    currentFrame: act ? act.index : null,
    /**
     * **播放序列**的长度，不是素材帧数。
     * 有局部循环时两者不同（吃白饭素材 17 帧、序列 33 帧），
     * 而"停在最后一帧""动作时长"都以序列为准。
     */
    currentFrameCount: act ? planLengthOf(act) : null,
    /** 素材本身的帧数（诊断用）。 */
    currentAssetFrameCount: act ? act.frameCount : null,
    /** 最近一次动作是怎么结束的（诊断"被顶掉"用）。 */
    lastEndAction: lastEndActionInfo,
    /** 最近一次"点击还是拖动"的判定输入（诊断用）。 */
    lastClickDecision,
    /** 渲染进程是否正处于拖拽态（诊断"拖拽态没清掉"用）。 */
    dragging,
    /** 桌宠自己的状态机：'idle' | 'sleeping' | 'waking'。 */
    petState,
    /** 状态变迁日志（最近若干条），用于排查"睡眠自己中断"。 */
    stateLog: stateLog.slice(-12),
    /** 当前有没有在跑的闲置调度定时器（睡眠期间应为 false）。 */
    hasIdleTimer: Boolean(idleTimer),
    /** 当前有没有在跑的"动作收尾"定时器。 */
    hasActionStopTimer: Boolean(actionStopTimer),
    /** 现在是否允许触发随机动作（睡眠/惊醒期间为 false）。 */
    canTriggerRandom: canTriggerRandomAction(),
    /** 「闲置模式」的下次可触发时刻；null = 门槛尚未起算。 */
    readyAt: idleReadyAtMs,
    /** 当前生效的命中概率与门槛（便于断言"参数确实下发了"）。 */
    idleFireProbability,
    idleTriggerAfterMs,
    /** 当前动画是否声明了尾帧循环，以及是否正在循环（诊断用）。 */
    tailLoopFrames: act ? act.tailLoopFrames : null,
    isPlayingCurrent: activeAnimationId ? isPlaying(activeAnimationId) : false,
    statsVisible,
    moodValue: Number.isFinite(moodState.value) ? moodState.value : null,
    moodTier: moodState.tier,
    /** 好感快照（面板显示用；供自测断言）。 */
    affection: {
      value: affectionState.value,
      hearts: affectionState.hearts,
      threshold: affectionState.threshold,
      maxHearts: affectionState.maxHearts,
      heartsText: affectionState.heartsText,
      heartsLabel: affectionState.heartsLabel,
      /** 面板上**实际渲染出来**的爱心串与数值文本 —— 断言读这个才能抓到渲染问题。 */
      heartsTextRendered: affectionHeartsEl ? affectionHeartsEl.textContent : null,
      valueText: affectionValueEl ? affectionValueEl.textContent : null,
      fillWidth: affectionFill ? affectionFill.style.width : null,
    },
    bubbleOwner,
    workStatus: currentWorkStatus,
    actionCatalog: actionCatalog.map((action) => ({ id: action.id, label: action.label, standing: Boolean(action.standing) })),
    /** 点击部位定义（供测试核对区域是否落在角色身上）。 */
    clickParts: clickParts.map((p) => ({
      id: p.id,
      label: p.label,
      box: p.box,
      lines: p.lines,
      /** 该部位配的互动动画 id（null = 只说话）。 */
      actionId: p.actionId ?? null,
    })),
  }
}

/**
 * 诊断用：把归一化画布坐标换算成视口坐标，并报告该点是否在角色身上。
 *
 * 测试用它确认"部位矩形的中心确实落在角色身上" —— 否则"点了那个部位"
 * 其实是点在透明背景上，机制形同虚设。
 *
 * ⚠️ 必须挂在 window 上单独调用，**不能**塞进 __petTestLayoutDiag 的返回值里：
 * 那是个函数，Electron 的 IPC 无法克隆函数（会报 "An object could not be cloned"）。
 */
window.__petTestProbePart = (u, v) => {
  const b = frameEl.getBoundingClientRect()
  const clientX = b.left + u * b.width
  const clientY = b.top + v * b.height
  return { clientX, clientY, opaque: hitTest(clientX, clientY) }
}

/**
 * 诊断用：量出**当前动画某一高度上躯干主体的横向范围**（归一化 u）。
 *
 * 做法：从画布中线向两侧扫描，**遇到第一段透明像素就停** ——
 * 得到的是被两侧头发夹住的那块主体。
 *
 * ⚠️ 这个量法**不严谨**：躯干内部存在透明缝隙（围裙褶皱、手臂与身体之间的空隙），
 * 扫描会被这些缝隙提前截断，同一高度不同帧的结果能差很多
 * （实测 v=0.66 处左界从 0.09 跳到 0.26）。所以它只适合做**粗略参考**，
 * 不能当作严密的几何判据 —— 自测里对它的使用据此做了容差处理。
 *
 * @param {number} v 归一化高度（0~1）
 * @returns {{ left: number, right: number, center: number } | null}
 */
window.__petTestBodyExtent = (v) => {
  const act = activeAnimation()
  if (!act || !act.ready) return null
  const img = act.images[act.index]
  if (!img || !img.naturalWidth) return null

  // 用离屏画布做逐像素读取（与命中掩膜用的是同一份像素数据来源）。
  const c = document.createElement('canvas')
  c.width = img.naturalWidth
  c.height = img.naturalHeight
  const g = c.getContext('2d', { willReadFrequently: true })
  g.drawImage(img, 0, 0)
  const W = c.width
  const H = c.height
  const y = Math.max(0, Math.min(H - 1, Math.round(v * H)))
  const row = g.getImageData(0, y, W, 1).data

  const alphaAt = (x) => row[x * 4 + 3]
  // 找中线附近的不透明像素作为扫描起点。
  let mid = Math.round(W / 2)
  if (alphaAt(mid) <= 8) {
    let found = -1
    for (let d = 1; d < W / 2; d += 1) {
      if (mid - d >= 0 && alphaAt(mid - d) > 8) { found = mid - d; break }
      if (mid + d < W && alphaAt(mid + d) > 8) { found = mid + d; break }
    }
    if (found < 0) return null
    mid = found
  }

  // 从中线向左右扫，遇到透明就停。
  let left = mid
  while (left - 1 >= 0 && alphaAt(left - 1) > 8) left -= 1
  let right = mid
  while (right + 1 < W && alphaAt(right + 1) > 8) right += 1
  return { left: left / W, right: right / W, center: mid / W }
}

/**
 * 诊断用：给**视口坐标**，报告是否命中角色以及帧元素矩形。
 * 与 __petTestProbePart（归一化坐标）互补 —— 排查"移出点是不是真的在角色外面"。
 */
window.__petTestProbeClient = (clientX, clientY) => {
  const b = frameEl.getBoundingClientRect()
  return {
    opaque: hitTest(clientX, clientY),
    rect: { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height },
    statsVisible,
  }
}

/**
 * 开始记录气泡文案与动作变化。
 *
 * 为什么需要"连续记录"而不是让测试轮询：随机动作只播约 1 秒多，
 * 若测试每几百毫秒采样一次，整个动作窗口可能正好落在两次采样之间 ——
 * 会得出"没有触发"的错误结论（我第一版就踩了这个）。
 * 这里用定时采样 + 去重，把**所有**出现过的取值记下来。
 *
 * ⚠️ 返回值必须只含纯数据：它会被 executeJavaScript 送回主进程，
 * 而 Electron 的 IPC 无法克隆函数（带上函数会报 "An object could not be cloned"）。
 * 因此记录器挂在 window 上，读取/清空另用两个纯函数。
 *
 * @param {number} intervalMs 采样间隔
 */
window.__petTestStartRecorder = (intervalMs = 80) => {
  if (window.__petRecorderTimer) clearInterval(window.__petRecorderTimer)
  const seen = []
  let lastKey = ''
  const sample = () => {
    const bubbleHidden = document.getElementById('bubble').hidden
    const text = bubbleHidden ? '' : String(bubbleText.textContent || '')
    const key = `${currentActionId ?? ''}|${activeAnimationId}|${text}`
    if (key === lastKey) return
    lastKey = key
    seen.push({
      at: Date.now(),
      action: currentActionId,
      /** 尝试过的动作：素材缺失时 currentActionId 会被立刻清空，靠这个字段留痕。 */
      lastPlayedActionId,
      animation: activeAnimationId,
      text,
      workStatus: currentWorkStatus,
    })
  }
  sample()
  window.__petRecorderSeen = seen
  window.__petRecorderTimer = setInterval(sample, Math.max(30, intervalMs))
  return seen.length
}

/** 读取记录（返回纯数据数组）。 */
window.__petTestReadRecorder = () => (Array.isArray(window.__petRecorderSeen) ? window.__petRecorderSeen.slice() : [])

/** 清空记录。 */
window.__petTestClearRecorder = () => {
  if (Array.isArray(window.__petRecorderSeen)) window.__petRecorderSeen.length = 0
  return true
}

/** 停止记录。 */
window.__petTestStopRecorder = () => {
  if (window.__petRecorderTimer) {
    clearInterval(window.__petRecorderTimer)
    window.__petRecorderTimer = null
  }
  return true
}

/**
 * 临时改小闲置掷骰子的周期（毫秒）；传 null 恢复原值。
 * 默认 60 秒，测试不可能等那么久，因此需要能压短。
 */
window.__petTestSetIdleInterval = (ms) => {
  if (Number.isFinite(ms) && ms > 0) {
    idleFireIntervalMs = ms
  } else if (ms === null) {
    idleFireIntervalMs = IDLE_FIRE_INTERVAL_MS
  }
  // 立刻按新间隔重排一次，否则要等上一个定时器到期才生效。
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  scheduleIdleTick()
  return idleFireIntervalMs
}

/**
 * 测试用：注入"当前时间"与闲置门槛，从而**跳过 3 分钟等待**而不必真的等。
 *
 * @param {{ now?: number, since?: number, afterMs?: number, probability?: number, sleepMin?: number, sleepMax?: number } | null} opts
 *        now        —— 注入的当前时间戳（null 恢复真实时间）
 *        since      —— 直接把闲置起点设成某个时间戳
 *        afterMs    —— 覆盖"保持闲置多久才允许触发随机动作"
 *        probability—— 覆盖每次掷骰子命中的概率
 *        sleepMin/sleepMax —— 覆盖睡眠尾帧循环的轮数范围
 *        （"闲置满 N 分钟必然入睡"那条规则已移除，所以不再有 toSleepMs）
 * @returns {object} 当前生效的设置，便于测试断言
 */
window.__petTestSetIdleClock = (opts) => {
  if (opts === null) {
    idleNowOverride = null
    idleTriggerAfterMs = IDLE_TRIGGER_AFTER_MS
    idleFireProbability = IDLE_FIRE_PROBABILITY
    sleepTailCyclesMin = SLEEP_TAIL_CYCLES_MIN
    sleepTailCyclesMax = SLEEP_TAIL_CYCLES_MAX
    tailLoopStepOverride = null
  } else {
    if (opts.now === null) idleNowOverride = null
    else if (Number.isFinite(opts.now)) idleNowOverride = opts.now
    if (Number.isFinite(opts.since)) idleSinceMs = opts.since
    if (Number.isFinite(opts.afterMs)) idleTriggerAfterMs = opts.afterMs
    if (Number.isFinite(opts.probability)) idleFireProbability = opts.probability
    if (Number.isFinite(opts.sleepMin)) sleepTailCyclesMin = opts.sleepMin
    if (Number.isFinite(opts.sleepMax)) sleepTailCyclesMax = opts.sleepMax
    if (opts.tailStepMs === null) tailLoopStepOverride = null
    else if (Number.isFinite(opts.tailStepMs)) tailLoopStepOverride = opts.tailStepMs
    // 可直接改写"闲置模式"的下次可触发时刻（null 清除门槛，让它重新起算）。
    if (opts.readyAt === null) idleReadyAtMs = null
    else if (Number.isFinite(opts.readyAt)) idleReadyAtMs = opts.readyAt
  }
  return window.__petTestIdleClockState()
}

/** 测试用：立即执行一次"到点"逻辑，不必等定时器。 */
window.__petTestIdleTickNow = () => {
  onIdleTick()
  return { lastPlayedActionId, activeAnimationId }
}

/**
 * 测试用：**强制结束拖拽态**，不依赖合成 mouseup。
 *
 * 为什么需要：拖拽用例是靠合成 mousedown / mousemove / mouseup 驱动的，
 * 而 `finishDrag()` 只在「mouseup」或「mousemove 且 buttons===0」时才真正退出拖拽态。
 * 后续用例若紧接着发 mousemove，就会**继承残留的拖拽态** ——
 * 实测后果：睡眠用例的"静置 6 秒不被打断"检查里冒出一条
 * `sleeping→idle(强行中断：用户开始拖拽)`，以及
 * "进入睡眠用例前，渲染进程已退出拖拽态"失败。
 *
 * 所以给测试一个**确定的收尾**入口：直接调 finishDrag（不传事件即可，
 * 它内部对 e 做了空值保护），把状态与定时器一次清干净。
 */
window.__petTestForceEndDrag = () => {
  try {
    finishDrag()
  } catch {
    // 忽略：收尾失败不该让自测崩掉。
  }
  return { dragging }
}

/**
 * 测试用：直接注入一份余额快照，验证面板渲染与配色。
 *
 * 为什么需要：余额正常情况下由宿主下发，而自测里"宿主状态"被 `testStateOverride`
 * 整体挡住了（那是为了不让真实状态覆盖注入的状态）。结果余额面板在整个自测里
 * 一直显示 `--`，**从没被真正画过** —— 渲染逻辑等于没测。
 * 这个钩子绕开状态通道，直接喂一份快照给渲染函数。
 *
 * @param {object|null} snap 传 null 清空
 */
window.__petTestSetBalance = (snap) => {
  balanceState = snap ?? null
  if (snap && typeof snap.hostOffline === 'boolean') hostOffline = snap.hostOffline
  renderBalance()
  return {
    text: balanceValueEl ? balanceValueEl.textContent : null,
    note: balanceNoteEl ? balanceNoteEl.textContent : null,
    isLow: balancePanel ? Boolean(balancePanel.querySelector('.balance-body.is-low')) : false,
    isError: balancePanel ? Boolean(balancePanel.querySelector('.balance-body.is-error')) : false,
  }
}

/**
 * 测试用：开关"容忍 buttons === 0"。
 *
 * 见 `tolerateButtonsZero` 的说明 —— 自测是合成拖拽，真实鼠标键没按下，
 * 不关掉这条启发式就会有偶发失败。**只在测试里用**。
 *
 * @param {boolean} value
 */
window.__petTestTolerateButtonsZero = (value) => {
  tolerateButtonsZero = Boolean(value)
  return { tolerateButtonsZero }
}

/**
 * 测试用：只做"是否触发"的判定，**不真的播动作**。
 *
 * 存在的理由：`onIdleTick()` 一旦触发就会让动作播起来，而动作播放期间
 * `isTrulyIdle()` 为假，后续掷骰全被挡掉 —— 于是"连掷 400 次统计命中率"
 * 只能命中 1 次。要独立验证 1/10 这个概率，必须能把判定与播放分开。
 */
window.__petTestIdleShouldFire = () => shouldFireIdleAction(idleNow())

/** 测试用：当前闲置计时的状态，便于断言门槛逻辑。 */
window.__petTestIdleClockState = () => ({
  now: idleNow(),
  since: idleSinceMs,
  afterMs: idleTriggerAfterMs,
  probability: idleFireProbability,
  fireIntervalMs: idleFireIntervalMs,
  sleepTailCyclesMin,
  sleepTailCyclesMax,
  tailStepMs: tailLoopStepOverride,
  /** 「闲置模式」的下次可触发时刻；null = 门槛尚未起算。 */
  readyAt: idleReadyAtMs,
  /** 闲置随机动作回复心情的区间（由动作库下发）。 */
  actionMoodGain: { min: actionMoodGainRange.min, max: actionMoodGainRange.max },
  trulyIdle: isTrulyIdle(),
  canTriggerRandom: canTriggerRandomAction(),
})

/**
 * 测试用：睡眠状态机的接口。
 *
 * `enterSleep` / `wakeFromSleep` 都是 async（要等素材加载），
 * 这里统一 await 之后再返回状态，避免测试读到"还没切过去"的中间态。
 */
window.__petTestSleep = {
  state: () => {
    const st = animations.get(SLEEP_ACTION_ID)
    return {
      petState,
      currentActionId,
      activeAnimationId,
      canTriggerRandom: canTriggerRandomAction(),
      sleepActionId: SLEEP_ACTION_ID,
      wakeActionId: WAKE_ACTION_ID,
      /** 尾帧已循环的轮数（睡眠靠它在 20~40 轮后自动醒来）。 */
      tailCycles: st ? (st.tailCycles ?? 0) : 0,
      /** 最近一次睡眠的轮数目标（醒来后仍保留，便于事后核对）。 */
      lastTailCyclesTarget: lastSleepTailCycles,
      /** 最近一次惊醒收尾的上下文（诊断"卡在 waking"用）。 */
      finishWake: finishWakeInfo,
      /** waking 期间的 endAction 记录。 */
      wakingEnds: wakingEndInfo.slice(-5),
      /** 当前动画是否还有在跑的播放定时器。 */
      playing: activeAnimationId ? isPlaying(activeAnimationId) : false,
    }
  },
  enter: async () => {
    await enterSleep()
    return window.__petTestSleep.state()
  },
  wake: async () => {
    await wakeFromSleep()
    return window.__petTestSleep.state()
  },
}

/**
 * 测试用：把闲置触发规则调成"立即且必然触发"，供"随机动作能播"这类用例使用。
 * 规则本身的门槛与概率由 verifyIdleTriggerRule 单独验证。
 */
window.__petTestSetClockForActions = () => {
  idleNowOverride = null
  idleTriggerAfterMs = 0
  idleFireProbability = 1
  // 让闲置计时立刻有效（否则第一次判定会以"现在"为起点，门槛 0 也能过，但更明确些）。
  resetIdleTimer()
  return window.__petTestIdleClockState()
}

/**
 * 诊断用：强制显示/隐藏属性面板。
 *
 * 为什么需要：面板隐藏时 `display: none`，而 Chromium 对 `display: none` 的元素
 * `getBoundingClientRect()` **一律返回全 0** —— 测不出任何几何。
 * 而拖拽期间光标不会悬停在角色上，面板默认是隐藏的，所以必须能把它按住显示。
 *
 * 这里直接操作 `hidden` 属性并在显示时**同时**把 `display` 显式设为 flex，
 * 避免样式表里的 `[hidden] { display: none }` 继续生效。
 * @returns {{ statsVisible: boolean, hidden: boolean, display: string }}
 */
window.__petTestForceStats = (visible) => {
  setStatsVisible(Boolean(visible))
  const el = document.getElementById('stats-panel')
  if (el) {
    el.hidden = !visible
    el.style.display = visible ? 'flex' : ''
  }
  return {
    statsVisible,
    hidden: el ? el.hidden : null,
    display: el ? getComputedStyle(el).display : null,
  }
}

/**
 * 诊断用：读回布局的"因"与"果"。
 *
 * 只读结果（比如面板高度）无法区分"参数被改了"和"渲染出错"，所以这里把
 * **输入**（目标宽度）、**真实基准**（视口）与**输出几何**一起返回。
 * 排查"拖拽时属性面板越来越长并远离桌宠"这类问题就靠这个对照。
 */
window.__petTestLayoutDiag = () => {
  const panel = document.getElementById('stats-panel')
  const rect = (el) => {
    if (!el) return null
    const b = el.getBoundingClientRect()
    return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, width: b.width, height: b.height }
  }
  return {
    // 输入：目标角色宽度（来自设置档位）
    logicalWidth,
    // 真实基准：窗口实际尺寸与请求值不一致，布局以视口为准
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    outerWidth: window.outerWidth,
    outerHeight: window.outerHeight,
    docClientHeight: document.documentElement.clientHeight,
    bodyClientHeight: document.body.clientHeight,
    bodyScrollHeight: document.body.scrollHeight,
    devicePixelRatio: window.devicePixelRatio,
    // 输出几何
    panelRect: rect(panel),
    panelComputedHeight: panel ? getComputedStyle(panel).height : null,
    panelHidden: panel ? panel.hidden : null,
    bodyRect: rect(document.querySelector('.stats-body')),
    characterRect: rect(character),
    frameRect: rect(frameEl),
    stageRect: rect(stage),
    // 余额面板是**常驻**的，所以它的几何永远可量（不像属性面板会 hidden）。
    // 断言"两面板不遮挡"要拿它和 panelRect 比，缺了它那些断言会读到 undefined。
    balanceRect: rect(document.getElementById('balance-panel')),
    balanceComputedHeight: (function () {
      const el = document.getElementById('balance-panel')
      return el ? getComputedStyle(el).height : null
    })(),
    balanceText: (document.getElementById('balance-value') || {}).textContent || '',
  }
}

// 刻意不在 window 上监听 resize 去重算尺寸：桌宠窗口不可缩放，
// 而窗口每次被拖动都会触发 resize 事件，监听它只会引入无效的尺寸往返。

void boot()
