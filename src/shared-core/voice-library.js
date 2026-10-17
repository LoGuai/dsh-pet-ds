/**
 * 语音库 —— 「主动对话」与其它"说话"场景的台词来源。
 *
 * ## 与 `dialogue.js` 的区别
 *
 * `dialogue.js` 是**右键菜单「对话」**的台词：用户点一下、随机听一句，
 * 没有条件，也不需要知道自己现在几颗心、心情如何。
 *
 * 这里是**分组语音库**：台词按「固定 / 好感度等级 / 心情档位」分组，
 * 取用时**只从当前可用的组里抽**。随着好感度上升、心情变化，
 * 她说的话会跟着变 —— 这是"陪伴感"的主要来源。
 *
 * ## 分组（用户指定）
 *
 * ```
 * fixed          固定语音            永远可用
 * affection-1..5 好感度专属语音 ×5   对应 1~5 颗心
 * mood-low/mid/high 心情语音 ×3      对应 低 / 中 / 高
 * ```
 *
 * 共 **9 组**，每组 3 条 → 27 条。
 *
 * ## 可用性规则（改这里就等于改规则，别在渲染进程里另写一套）
 *
 * 1. `fixed` **永远可用**；
 * 2. `affection-N` 仅在 **爱心数恰好等于 N** 时可用。
 *    为什么是"恰好"而不是"大于等于"：用户的要求是"5 个好感度等级**分别**的
 *    专属语音" —— 各自专属。若做成累加，升到 5 心时会同时听到 1~5 心共 15 条，
 *    等级感就没了。想改成累加只需改 `availableVoiceGroups()` 里的一行判断。
 *    **0 心（陌生）时没有任何专属语音** —— 那时她还懒得给你专属台词，
 *    只有固定语音 + 心情语音。
 * 3. `mood-*` 按**心情值**分档，规则见 `moodVoiceGroup()`：
 *    心情模块本身有 4 档（sad / low / normal / happy），这里按用户要求
 *    合并成 **3 组**：sad+low → 低，normal → 中，happy → 高。
 *
 * ## 写法约定
 *
 * · 每句 **不超过 24 字**（`VOICE_LINE_MAX_CHARS`）：气泡宽度与桌宠等比缩放，
 *   太长会换行、把气泡区撑高，位置也会跟着抖。有测试钉住这条。
 * · 人设：**傲娇 + 贪吃（尤其白饭）+ 鲸鱼娘 + 助手**。
 *   傲娇靠"嘴硬心软"的句式，贪吃靠白饭梗，鲸鱼是点缀不是主题，
 *   助手的专业性保证她不只是耍脾气。
 * · **同一句不得跨组重复**：重复会让"分组"失去意义，也有测试钉住。
 */

/** 单句长度上限（字符数）。超了会撑高气泡，见文件头说明。 */
export const VOICE_LINE_MAX_CHARS = 24

/**
 * 心情 → 语音组的阈值（用户要求 3 档：低 / 中 / 高）。
 *
 * 注意与 `mood.js` 的 `moodTier()` 的关系：那里是 4 档
 * （sad <20 / low <50 / normal <80 / happy ≥80），这里是 3 组 ——
 * **sad 与 low 合并为"低"**。所以阈值直接用 50 与 80，
 * 而不是复用 tier 名（tier 有 4 个值，映射过来要写 if/else，容易写漏 sad）。
 */
export const MOOD_VOICE_MID_MIN = 50
export const MOOD_VOICE_HIGH_MIN = 80

/**
 * 语音分组定义。
 *
 * 每组字段：
 *  · `id`     —— 稳定标识（日志、状态上报、测试都用它）
 *  · `kind`   —— `'fixed' | 'affection' | 'mood'`，决定可用性规则
 *  · `level`  —— kind=affection 时表示需要几颗心
 *  · `mood`   —— kind=mood 时表示心情档位（`'low' | 'mid' | 'high'`）
 *  · `label`  —— 给文档/调试看的名字
 *  · `lines`  —— 台词
 */
export const VOICE_GROUPS = [
  {
    id: 'fixed',
    kind: 'fixed',
    label: '固定语音',
    lines: [
      '又浮上来了？我只是……换口气。',
      '哼，今天也勉强陪你一会儿。',
      '有事就说，鲸鱼也是要干活的。',
    ],
  },
  {
    id: 'affection-1',
    kind: 'affection',
    level: 1,
    label: '好感度 Lv1（眼熟）',
    lines: [
      '以为熟了就能随便使唤我？……也行。',
      '你的活我记下了，别催我。',
      '我、我只是碰巧记得你的习惯。',
    ],
  },
  {
    id: 'affection-2',
    kind: 'affection',
    level: 2,
    label: '好感度 Lv2（熟悉）',
    lines: [
      '今天的活，我提前看过了。',
      '白饭……多煮一碗，我顺便吃。',
      '别老熬夜，鲸鱼都比你作息好。',
    ],
  },
  {
    id: 'affection-3',
    kind: 'affection',
    level: 3,
    label: '好感度 Lv3（亲近）',
    lines: [
      '累了吧，剩下的给我，我扛得动。',
      '今天的白饭，我要加个蛋，就一个。',
      '你走很久的话，我会数着时间。',
    ],
  },
  {
    id: 'affection-4',
    kind: 'affection',
    level: 4,
    label: '好感度 Lv4（信赖）',
    lines: [
      '不用说了，我已经知道你要什么。',
      '白饭分你一半，别当作我很在意。',
      '有你在，深海好像也没那么冷。',
    ],
  },
  {
    id: 'affection-5',
    kind: 'affection',
    level: 5,
    label: '好感度 Lv5（挚爱）',
    lines: [
      '哪儿都别去……我是说任务。',
      '白饭的第一口，永远给你。',
      '就算你什么都做不好，我也不换人。',
    ],
  },
  {
    id: 'mood-low',
    kind: 'mood',
    mood: 'low',
    label: '心情·低',
    lines: [
      '……浮上来也没什么意思。',
      '今天不想吵，安静一会儿。',
      '白饭都不香了，随便吧。',
    ],
  },
  {
    id: 'mood-mid',
    kind: 'mood',
    mood: 'mid',
    label: '心情·中',
    lines: [
      '嗯，就这样，不咸不淡的。',
      '今天没什么大事，摸摸也成。',
      '白饭照常，一碗不太够。',
    ],
  },
  {
    id: 'mood-high',
    kind: 'mood',
    mood: 'high',
    label: '心情·高',
    lines: [
      '今天心情不错，多说两句也成。',
      '白饭！白饭！……咳，我是说开工。',
      '哼，今天可以夸你一句。',
    ],
  },
]

/** 按 id 取分组（找不到返回 null，调用方自行处理）。 */
export function findVoiceGroup(id) {
  return VOICE_GROUPS.find((group) => group.id === id) ?? null
}

/**
 * 爱心数 → 该用哪个好感度语音组的**等级**（1~5）；0 心返回 `null`。
 *
 * @param {number} hearts 0~5
 * @returns {number | null}
 */
export function affectionVoiceLevel(hearts) {
  const h = Number(hearts)
  if (!Number.isFinite(h)) return null
  const n = Math.floor(h)
  if (n < 1) return null // 0 心（陌生）没有专属语音
  if (n > 5) return 5 // 容错：越界按满级算
  return n
}

/**
 * 心情值 → 语音档位（`'low' | 'mid' | 'high'`）。
 *
 * 与 `mood.js` 的 4 档 (`moodTier`) 不同：这里**sad 与 low 合并为低**。
 * 心情值缺失/非法时按"中"处理 —— 宁可说点平淡的，也不要空着不出声。
 *
 * @param {number} value 0~100
 * @returns {'low' | 'mid' | 'high'}
 */
export function moodVoiceGroup(value) {
  const v = Number(value)
  if (!Number.isFinite(v)) return 'mid'
  if (v >= MOOD_VOICE_HIGH_MIN) return 'high'
  if (v >= MOOD_VOICE_MID_MIN) return 'mid'
  return 'low'
}

/**
 * 当前可用的语音组。
 *
 * @param {{ hearts?: number, moodValue?: number }} [state]
 * @returns {typeof VOICE_GROUPS}
 */
export function availableVoiceGroups(state = {}) {
  const level = affectionVoiceLevel(state.hearts)
  const mood = moodVoiceGroup(state.moodValue)
  return VOICE_GROUPS.filter((group) => {
    if (group.kind === 'fixed') return true
    if (group.kind === 'affection') return group.level === level
    if (group.kind === 'mood') return group.mood === mood
    return false
  })
}

/**
 * 当前可用的全部台词（已按组顺序拼平，去重顺序稳定）。
 *
 * @param {{ hearts?: number, moodValue?: number }} [state]
 * @returns {string[]}
 */
export function availableVoiceLines(state = {}) {
  return availableVoiceGroups(state).flatMap((group) => group.lines)
}

/**
 * 抽一句台词：从**当前可用的所有组**里等概率抽取，并尽量避开上一句。
 *
 * 为什么要避重：主动对话每 60 秒一次，若连着两次同一句，
 * 会让人以为"机制坏了/卡住了"——与 `dialogue.js` 的处理保持一致。
 *
 * @param {object} [opts]
 * @param {number} [opts.hearts] 爱心数（0~5）
 * @param {number} [opts.moodValue] 心情值（0~100）
 * @param {() => number} [opts.rand] 注入随机源，便于测试确定化
 * @param {string | null} [opts.avoidLine] 上一句，尽量避开
 * @returns {string} 台词；可用库为空时返回空串（调用方应视作"这次不说"）
 */
export function pickVoiceLine(opts = {}) {
  const rand = typeof opts.rand === 'function' ? opts.rand : Math.random
  const pool = availableVoiceLines({ hearts: opts.hearts, moodValue: opts.moodValue })
  if (pool.length === 0) return ''
  if (pool.length === 1) return pool[0]

  const avoid = typeof opts.avoidLine === 'string' ? opts.avoidLine : null
  const candidates = avoid ? pool.filter((line) => line !== avoid) : pool
  const list = candidates.length > 0 ? candidates : pool
  return list[Math.floor(rand() * list.length)]
}

/**
 * 库的结构摘要（给文档、测试、日志用）。
 *
 * @returns {{ id: string, kind: string, label: string, level?: number, mood?: string, lines: string[] }[]}
 */
export function voiceLibrarySummary() {
  return VOICE_GROUPS.map((group) => ({
    id: group.id,
    kind: group.kind,
    label: group.label,
    ...(group.kind === 'affection' ? { level: group.level } : {}),
    ...(group.kind === 'mood' ? { mood: group.mood } : {}),
    lines: [...group.lines],
  }))
}

/** 总台词条数（文档与自测引用它，避免两处各写一个数字）。 */
export function voiceLineCount() {
  return VOICE_GROUPS.reduce((sum, group) => sum + group.lines.length, 0)
}

/**
 * 「信赖语音」—— 低心情时被关心后的回应（用户要求：**单独分组、3 条**）。
 *
 * ⚠️ 目前是**占位**：语音库的这批内容（部位语音三档 + 信赖语音细写）
 * 按用户要求"先放着"，等那批一起做。这里先给出可运行的占位，
 * 让"低心情点击 → 信赖语音"这条机制现在就能跑通、能测。
 *
 * 定稿时要：改成正式的 `trust` 分组（并入 `VOICE_GROUPS`，走文档生成与去重检查），
 * 并让 `pickTrustLine()` 从该组里抽。
 */
export const TRUST_LINES = [
  '（占位·信赖）……才、才不是因为你关心我。',
]

/** 抽一句信赖语音（目前只有占位，池为 1 时直接返回它）。 */
export function pickTrustLine(rand = Math.random) {
  if (TRUST_LINES.length === 0) return ''
  if (TRUST_LINES.length === 1) return TRUST_LINES[0]
  return TRUST_LINES[Math.floor(rand() * TRUST_LINES.length)]
}
