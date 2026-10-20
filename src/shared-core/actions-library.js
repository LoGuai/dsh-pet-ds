/**
 * 动作库 —— **所有动作定义的唯一集中处**。
 *
 * ## 为什么单独建这个模块
 *
 * 用户要求："所有随机动作放在一个库中，此后添加新的动作都要放入其中，
 * 并且沿用目前关于随机动作的设定。"
 *
 * 所以这里不只是"列一份清单"，而是把**随机动作的设定本身**也定义在这里：
 *
 * ```
 * RANDOM_ACTION_RULES = {
 *   idleThresholdMs: 1 分钟     // 连续闲置满这么久才进入「闲置模式」
 *   fireIntervalMs:  60 秒      // 之后每这么久掷一次骰子
 *   fireProbability: 0.2        // 每次命中概率 1/5
 *   moodGain: { min: 10, max: 30 } // 命中并播放后回复的心情
 * }
 * ```
 *
 * 这三个时间/概率参数此前散在主进程与渲染进程各写一份（镜像常量），
 * 现在**只在库里有定义**，由主进程下发给渲染进程 —— 加新动作时不必再关心它们，
 * 天然"沿用现有设定"。
 *
 * ## 加新动作的步骤
 *
 * 1. 素材放进 `.cache/<动作id>-raw/`，在 `build-action-asset.py` 的 `ACTIONS` 里加一条；
 * 2. 在这个文件里把动作加进 `RANDOM_ACTIONS`（参与闲置随机触发）
 *    或 `MENU_ONLY_ACTIONS`（只从右键菜单触发）；
 * 3. 若要让桌宠"进入某种持续状态"，给它加 `routToSleepState` 之类的标志
 *    （见 `SLEEP_ACTION`），并在渲染进程里处理该标志。
 *
 * **不需要**再设置触发节奏与心情奖励 —— 那些由 `RANDOM_ACTION_RULES` 统一决定。
 *
 * ## 动作分四类
 *
 * | 常量 | 含义 | 触发方式 |
 * |---|---|---|
 * | `STANDING_ACTION_ID` | 待机动画 | 什么都不做时循环播放 |
 * | `RANDOM_ACTIONS` | **随机池** | 闲置满门槛后按概率抽取 |
 * | `MENU_ONLY_ACTIONS` | 仅菜单 | 右键菜单手动触发 |
 * | `PART_ACTIONS` | 点击互动 | 点击对应身体部位触发 |
 *
 * 每个动作对应素材目录 `assets/animations/<id>/`。
 * 素材缺失时会退回站立动画并记日志，而不是留一个空白窗口。
 */

import { actionLines, clickPartLines } from './voice-library.js'

// ---------------------------------------------------------------- 常量

/** 待机动画 id。桌宠不做任何一次性动作时就播它。 */
export const STANDING_ACTION_ID = 'stand'

/** 睡眠动作 id。进入睡眠状态后循环尾帧，直到被叫醒或轮数走满。 */
export const SLEEP_ACTION_ID = 'sleep'

/** 被叫醒时播放的动作 id。 */
export const WAKE_ACTION_ID = 'awake'

/**
 * 坐姿动作的三段素材 id 与"坐着"的持续时长。
 *
 * 坐姿不是一段素材，而是**三段独立素材拼成的一个多阶段动作**：
 *
 * | 阶段 | id | 播放方式 |
 * |---|---|---|
 * | 一、坐下 | `sit` | 播一次（坐下的过程） |
 * | 二、坐着 | `sit-circle` | **循环播放**，同时开始 180 秒计时 |
 * | 三、站起 | `sit-stop` | 播一次（站起的过程），播完回站立闲置 |
 *
 * 用户要求（原文）：
 * 「触发随机动作时，桌宠播放坐下动作，之后循环播放坐着的动作并从 0 开始计时，
 *   计时器达到 180 秒后，播放站起动作，回到站立闲置状态。
 *   其中，在前两个阶段点击桌宠将立即跳转到站立动作阶段并关闭计时。」
 *
 * 三段素材共用同一个缩放倍数（见 `build-action-asset.py` 的 `scale_group`），
 * 否则切换阶段时角色大小会跳一下。
 */
export const SIT_ACTION_ID = 'sit'
export const SIT_HOLD_ACTION_ID = 'sit-circle'
export const SIT_STOP_ACTION_ID = 'sit-stop'

/** 「坐着」阶段持续多久后自动站起（用户指定 180 秒）。 */
export const SIT_HOLD_MS = 180 * 1000

// ---------------------------------------------------------------- 随机动作的设定

/**
 * 闲置随机动作的**统一设定**。
 *
 * 这是"随机动作怎么触发、给多少心情"的单一真相源。
 * 主进程把它随 `pet:get-initial` 下发给渲染进程，渲染进程只读不写 ——
 * 所以加新动作时不必在两处各配一遍。
 */
export const RANDOM_ACTION_RULES = {
  /**
   * 连续闲置满这么久才进入「闲置模式」（可掷骰子）。
   *
   * 演变：3 分钟 → **1 分钟**（用户调整）。
   * 3 分钟时，配上"每分钟 20% 概率"，正常使用中平均要连续闲置 8 分钟
   * 才看得到一次动作 —— 用户反馈"好长时间都没看到桌宠触发"。
   * 改成 1 分钟后，交互间隙里就能触发。
   */
  idleThresholdMs: 1 * 60 * 1000,
  /** 进入闲置模式后，每这么久掷一次骰子。 */
  fireIntervalMs: 60 * 1000,
  /** 每次掷骰子的命中概率（用户指定 1/5）。 */
  fireProbability: 0.2,
  /**
   * 命中并播放后回复的心情区间（用户指定 10~30）。
   * 比"点击"给得多，因为闲置随机动作很稀少（期望约 5 分钟一次）。
   */
  moodGain: { min: 10, max: 30 },
}

// ---------------------------------------------------------------- 动作定义

/**
 * 睡眠动作：**同时**在随机池与右键菜单里。
 *
 * `routToSleepState: true` 是关键标志：渲染进程据此把它**路由到睡眠状态机**，
 * 而不是当普通一次性动作"播一遍就回站立" —— 否则"抽到睡觉"等于没睡。
 * 标志写在数据里，而不是靠 `id === 'sleep'` 判断，语义更明确、也好复用。
 */
export const SLEEP_ACTION = {
  id: SLEEP_ACTION_ID,
  label: '睡觉',
  lines: actionLines('sleep'),
  /** 随机抽取的相对权重。 */
  weight: 1,
  /** 触发后进入睡眠状态（而不是播完就回站立）。 */
  routToSleepState: true,
}

/**
 * 坐下：**多阶段**动作，同样在随机池里。
 *
 * `routToSitState: true` 表示"这个动作不是播一遍就完事"，渲染进程据此
 * 把它路由到坐姿状态机（坐下 → 坐着循环 + 180 秒计时 → 站起）。
 *
 * 与 `SLEEP_ACTION` 的区别：睡觉是**进入状态后一直待着**（直到被叫醒），
 * 坐下是**自己会结束**（180 秒后自动站起）。
 */
export const SIT_ACTION = {
  id: SIT_ACTION_ID,
  label: '坐下',
  lines: actionLines('sit'),
  weight: 1,
  routToSitState: true,
}

/**
 * 「深度思考」动作 id。
 *
 * 用户要求：**DSH 开始思考时**，桌宠停下当前动作、播这个动作；
 * 思考结束或桌宠被点击时结束它、回到闲置。
 *
 * ⚠️ **素材还没给**（用户："具体动作素材之后补充，现在先占位"）。
 * 现在触发它只会走"素材加载失败 → 退回站立动画"的兜底路径，
 * 但状态机、门控与菜单入口都是完整的 —— 补素材时不用改一行逻辑。
 *
 * ⚠️ 它**不能进随机池**：思考是宿主状态的映射，随机播出来会莫名其妙。
 * 渲染进程的 `oneShotActions()` 里显式把它排除了。
 */
export const THINK_ACTION_ID = 'think'

/**
 * 深度思考的动作定义。
 *
 * 素材已补（2026-10-19）。因为"退出时要倒放进入段"，一个素材目录表达不了，
 * 所以实际素材拆成三段 —— `think-enter` / `think-loop` / `think-exit`，
 * 由渲染进程的状态机串联（见 renderer.js 的 enterThink / exitThink）。
 * 这里的 `id: 'think'` 是**逻辑动作 id**（菜单项与随机池排除都用它）。
 *
 * 只进 `MENU_ONLY_ACTIONS`（便于手动验证），**不进随机池** ——
 * 它会由宿主工作状态自动触发，随机播出来会莫名其妙。
 */
export const THINK_ACTION = {
  id: THINK_ACTION_ID,
  label: '深度思考',
  /*
   * **没有台词**（用户要求："深度思考动作不再需要任何语音"）。
   *
   * 显式写成空数组而不是留空：渲染进程与自测都按 `lines` 取值，
   * 缺字段会走到 `undefined` 分支，排查时容易误以为"漏配了语音"。
   */
  lines: [],
}

/** 深度思考的三段素材 id（菜单/随机池仍只认 {@link THINK_ACTION_ID}）。 */
export const THINK_ASSET_IDS = ['think-enter', 'think-loop', 'think-exit']

/**
 * **随机池** —— 闲置满门槛后按概率从这里抽一个。
 *
 * ⚠️ 往这里加动作即可自动沿用 `RANDOM_ACTION_RULES` 的全部设定
 * （触发节奏、心情奖励、避免连续重复）。
 *
 * 注意：**菜单专用动作与点击互动动作不放这里** —— 它们不该被随机抽中。
 */
export const RANDOM_ACTIONS = [
  {
    id: 'eat',
    label: '吃白饭',
    /** 台词占位符 —— 等文案定稿后替换这里的字符串即可，不需要动逻辑。 */
    lines: actionLines('eat'),
    weight: 1,
  },
  {
    id: 'play-mc',
    label: '玩mc',
    lines: actionLines('play-mc'),
    weight: 1,
  },
  SIT_ACTION,
  SLEEP_ACTION,
]

/**
 * 仅从右键菜单触发的动作（不参与随机抽取）。
 *
 * 睡眠既在随机池里、也在菜单里 —— 手动点它是"立刻睡"（不依赖概率），
 * 行为与随机抽中完全一致。
 */
export const MENU_ONLY_ACTIONS = [
  {
    id: SLEEP_ACTION_ID,
    label: SLEEP_ACTION.label,
    lines: SLEEP_ACTION.lines,
    routToSleepState: true,
  },
  {
    id: WAKE_ACTION_ID,
    label: '惊醒',
    lines: actionLines('awake'),
  },
  /*
   * 深度思考：正常由宿主状态触发，这里放一份只为"右键菜单能手动验证"。
   * 菜单点它 = 走完整套（进入段 → 循环段），再点一下桌宠或「刷新状态」结束。
   */
  THINK_ACTION,
]

/**
 * 点击互动动画：点某个身体部位时播放。
 *
 * 与随机动作的区别：**不参与随机抽取**，只由点击触发；
 * 台词直接用对应部位的台词（见 `CLICK_PARTS`），所以这里不必再写一遍文案
 * —— 否则同一句台词会在两处各写一份，迟早漂移。
 *
 * id 与素材目录名一致（`assets/animations/head` 等）。
 * `partId` 指向 `CLICK_PARTS` 里的部位（**注意不必与 id 同名**：
 * 部位 `belly` 的动画目录叫 `stomach`）。
 */
export const PART_ACTIONS = [
  { id: 'head', partId: 'head', label: '摸头' },
  { id: 'chest', partId: 'chest', label: '戳胸' },
  { id: 'stomach', partId: 'belly', label: '戳腹' },
  { id: 'leg', partId: 'leg', label: '碰腿' },
]

/** 所有动作（查台词/定义用）。 */
const ALL_ACTIONS = [...RANDOM_ACTIONS, ...MENU_ONLY_ACTIONS, ...PART_ACTIONS]

/** 按 id 找动作定义（四类都查）。 */
export function findAction(id) {
  return ALL_ACTIONS.find((action) => action.id === id) ?? null
}

/** 当前随机池里的动作 id（供自测断言"随机池恰好是哪些"）。 */
export function randomActionIds() {
  return RANDOM_ACTIONS.map((action) => action.id)
}

/**
 * 右键菜单「动作」子菜单里的完整动作列表。
 *
 * 分三段（`group` 字段），菜单渲染时在**组之间插分隔线**，
 * 免得十来项平铺在一起、分不清哪是哪：
 *   · `standing` —— "站立（待机）"，用于中途打断正在播的动作；
 *   · `action`   —— 随机池 + 仅菜单动作；
 *   · `part`     —— 触碰各部位（用户要求从独立的"点击部位"栏挪进来，
 *                   命名为「触碰{部位}」）。
 *
 * ⚠️ 必须**按 id 去重**：睡觉既在随机池里、又在仅菜单项里，
 * 不去重的话菜单里会出现两个"睡觉"。
 *
 * 需求变更说明：这里**曾经刻意不含**点击互动动画（理由是"点菜单看不出
 * 区域是否落在角色身上"）。用户后来要求把它们并进动作栏，
 * 于是加了 `partId` —— 从菜单触发时会走与点击**完全相同**的播放路径
 * （动画 + 该部位的台词），功能上等价，只是入口多了一个。
 */
export function actionMenuEntries() {
  const seen = new Set()
  const entries = [
    { id: STANDING_ACTION_ID, label: '站立（待机）', standing: true, group: 'standing' },
    ...RANDOM_ACTIONS.map((action) => ({
      id: action.id,
      label: action.label,
      standing: false,
      group: 'action',
    })),
    ...MENU_ONLY_ACTIONS.map((action) => ({
      id: action.id,
      label: action.label,
      standing: false,
      group: 'action',
    })),
    ...PART_ACTIONS.map((action) => {
      const part = findClickPart(action.partId)
      return {
        id: action.id,
        // 用户指定的命名："触碰{部位}"。
        label: `触碰${part ? part.label : action.label}`,
        standing: false,
        group: 'part',
        partId: action.partId,
      }
    }),
  ]
  return entries.filter((entry) => {
    if (seen.has(entry.id)) return false
    seen.add(entry.id)
    return true
  })
}

// ---------------------------------------------------------------- 点击部位

/**
 * 点击部位定义。
 *
 * 坐标系是**素材画布的归一化坐标**（0~1）：`x`/`y` 是相对画布宽/高的比例，
 * 因此与窗口尺寸、DPI 完全无关，换档位或换窗口大小都不用改这里。
 *
 * 纵向分界（用户按实际观感逐次校准）：
 *
 * ```
 * 头   v 0.00 ~ 0.48   约 48%
 * 胸   v 0.48 ~ 0.62   约 14%
 * 腹   v 0.62 ~ 0.76   约 14%
 * 腿   v 0.78 ~ 1.00   约 22%
 * ```
 *
 * 起点是 40%/20%/20%/20% 的均分，之后按实机观感调整：
 *  · **胸的上边界从 0.40 降到 0.48** —— 0.40 那条线落在头发/脖颈位置，
 *    点胸口会误判成"头"。头之所以要占到近一半，是因为这批立绘是
 *    Q 版比例 + 长发，头部与头发在画面上确实占据上半部分；
 *  · **胸/腹的横向从 0.14~0.86 收窄到 0.26~0.74** —— 长发垂到画布两侧，
 *    原先点击两侧头发会被判成胸/腹。详见下面各自字段的实测说明；
 *  · **腹的底界收到 0.76**、腿的上界随之调到 0.78（v=0.78 那一行各帧宽度差别大，
 *    框底伸到最宽帧之外时贴边点会落到透明处）。
 *
 * `lines` 全部是**占位符**（与动作台词同一约定），等文案定稿后替换即可。
 */
export const CLICK_PARTS = [
  {
    id: 'head',
    label: '头',
    /** 头发与头饰从顶部就开始了，所以整宽都算"头"。 */
    box: { x0: 0.0, y0: 0.0, x1: 1.0, y1: 0.48 },
    linesByTier: {
        low: clickPartLines('head', 0),
        mid: clickPartLines('head', 2),
        high: clickPartLines('head', 5),
      },
    /** 点击这个部位时播放的动作动画 id。 */
    actionId: 'head',
  },
  {
    id: 'chest',
    label: '胸',
    /*
     * ⚠️ 横向 0.26~0.74 —— 实测校准的结果，不是拍的。
     *
     * 原先给的是 0.14~0.86（"手臂一并纳入，避免点了没归属"），但**长发一直垂到
     * 画布两侧**，于是点击两侧头发也被判成"胸"或"腹"（用户反馈）。
     *
     * 实测（把站立帧每一行的不透明像素按"连续段"切分）：
     *   · 在 v=0.52 这种帧里，左侧头发是一段**独立的窄段** [0.094~0.128]，
     *     右侧头发从 0.802 起 —— 取这两个值的余量即 0.26 / 0.74；
     *   · 但在多数帧里头发与躯干**连成一片**（如 v=0.52 frame_02 是
     *     [0.090~0.868] 一整段），程序无法把头发分离出来，
     *     所以只能取"独立窄段"这种最保守的观测来定边界。
     *
     * 代价：落在这条边界之外的两侧头发会退到通用台词。
     * 如果实测觉得"点头发应该算摸头"，那就该改成给头发单独一个部位，
     * 而不是把胸/腹的框放宽（放宽必然把头发再次圈进来）。
     */
    box: { x0: 0.26, y0: 0.48, x1: 0.74, y1: 0.62 },
    linesByTier: {
        low: clickPartLines('chest', 0),
        mid: clickPartLines('chest', 2),
        high: clickPartLines('chest', 5),
      },
    actionId: 'chest',
  },
  {
    id: 'belly',
    label: '腹',
    /**
     * 与胸同宽（同一躯干），但**底界收到 0.76**（腿从 0.78 起）。
     *
     * 为什么不像胸那样到 0.80：实测 v=0.78 那一行躯干右界各帧差别很大
     * （有的帧到 0.88、有的只到 0.70），框底伸到最宽帧之外时贴边点会落到
     * 透明处 —— 表现为"点了没反应"。而 0.78 附近本来就已经进入**腿部**区域。
     */
    box: { x0: 0.26, y0: 0.62, x1: 0.74, y1: 0.76 },
    linesByTier: {
        low: clickPartLines('belly', 0),
        mid: clickPartLines('belly', 2),
        high: clickPartLines('belly', 5),
      },
    /**
     * ⚠️ 这里与部位 id **不同名**：部位叫 `belly`（沿用"腹"的语义），
     * 素材目录叫 `stomach`（跟随用户给的目录名）。靠这个字段关联，
     * 所以两者不必强求同名 —— 这也是加这个字段而不是"用 id 直接当动画 id"的原因。
     */
    actionId: 'stomach',
  },
  /*
   * 曾经有一个「手臂」部位（左右两条竖直带，u 0~0.22 / 0.78~1，v 0.42~0.66）。
   * 实测定位不准 —— 立绘里手臂贴着身体，用竖直条带框不出手臂的形状，
   * 会把头发、裙摆也算进去（用户反馈后移除）。
   * 若将来要恢复，正确做法是按立绘上手臂的实际像素轮廓做**非矩形掩膜**，
   * 而不是靠一个矩形近似。
   */
  {
    id: 'leg',
    label: '腿',
    /**
     * 整宽：这一带里除腿之外还有裙摆与鲸鱼尾巴，按用户要求不再细分。
     * 上界 0.78（腹的底界收到 0.76，中间留一点余量避免边界行不稳定）。
     */
    box: { x0: 0.0, y0: 0.78, x1: 1.0, y1: 1.0 },
    linesByTier: {
        low: clickPartLines('leg', 0),
        mid: clickPartLines('leg', 2),
        high: clickPartLines('leg', 5),
      },
    actionId: 'leg',
  },
]

/** 按 id 找部位定义。 */
export function findClickPart(id) {
  return CLICK_PARTS.find((part) => part.id === id) ?? null
}
