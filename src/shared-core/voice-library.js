/**
 * 语音库 —— **桌宠所有会说出口的话**的唯一来源。
 *
 * ## 组织方式：按「触发条件」分组（用户要求）
 *
 * 用户原话：
 *   「将所有桌宠可触发的语音归到语音库中，并且根据触发条件进行分组。
 *     此后添加任何语音，都要归到符合条件的语音组中，或是新建一个语音组归类。」
 *
 * 于是每个组都必须声明 `trigger`（触发条件），取用时**先按触发条件过滤**，
 * 再看该组的附加条件（好感度 / 心情 / 部位 / 动作 / 余额档位）。
 *
 * | trigger | 什么时候说 | 附加条件 |
 * |---|---|---|
 * | `idle` | 闲置主动对话（每 1 分钟） | 固定 / 好感度等级 / 心情档位 |
 * | `click` | 点击身体部位 | 部位 × 好感度三档 |
 * | `action` | 播放某个动作时的一句 | 动作 id |
 * | `trust` | 心情差时被关心 | 无 |
 * | `drag` | 被拎起来 | 无 |
 * | `balance` | 余额播报（拼在句子里） | 余额档位 |
 * | `system` | 系统提示（调尺寸失败、刷新状态、点空白处） | 场景 id |
 * | `free` | 「随机说一句」（语音库窗口的按钮） | 无 |
 *
 * ## 为什么必须集中
 *
 * 以前这些台词散在 8 个地方（动作库、部位定义、余额模块、渲染进程的拖拽数组、
 * 主进程的提示字符串、独立的对话库…）。那个状态有三个必然的坏结果：
 *  1. 想改一句人设台词，得先找到它在哪个模块里；
 *  2. 同一个场景可能被写在两处，改一处忘一处（本项目已经踩过）；
 *  3. 没法回答"她一共会说多少句话"这种问题。
 *
 * ## 加新语音的规矩（用户明确要求）
 *
 * 1. 先想清楚**触发条件**属于哪一类；
 * 2. 已有同条件的组 → 加进那个组的 `lines`；
 * 3. 没有 → 新建一个组，填好 `trigger` 与附加条件，并加进 `VOICE_GROUPS`；
 * 4. 跑 `node scripts/dev/gen-voice-doc.mjs` 重新生成文档；
 * 5. 跑 `npm test`（字数、去重、文档同步都有断言守着）。
 */

/** 单句长度上限（字符数）。超了会撑高气泡，见文件头说明。 */
export const VOICE_LINE_MAX_CHARS = 24

/**
 * 心情 → 语音组的阈值（用户要求 3 档：低 / 中 / 高）。
 *
 * 注意与 `mood.js` 的 `moodTier()` 的关系：那里是 4 档
 * （sad <20 / low <50 / normal <80 / happy ≥80），这里是 3 组 ——
 * **sad 与 low 合并为"低"**。所以阈值直接用 50 与 80。
 */
export const MOOD_VOICE_MID_MIN = 50
export const MOOD_VOICE_HIGH_MIN = 80

/**
 * 好感度 → 点击语音的三档（用户要求"0,1 心组 / 2,3 心组 / 4,5 心组"）。
 *
 * 为什么点击语音按三档而不是逐级：点击是最高频的互动，逐级写 6 套台词
 * 收益不大；而三档正好对应"防备 → 放松 → 宠溺"的语气跨度。
 */
export const CLICK_VOICE_TIERS = ['low', 'mid', 'high']

/** 好感度 → 点击语音档位。 */
export function clickVoiceTier(hearts) {
  const h = Number.isFinite(Number(hearts)) ? Math.max(0, Math.floor(Number(hearts))) : 0
  if (h <= 1) return 'low'
  if (h <= 3) return 'mid'
  return 'high'
}

/** 附加条件的展示名（文档与信息窗口共用）。 */
const CLICK_TIER_LABELS = { low: '0~1 心', mid: '2~3 心', high: '4~5 心' }

/**
 * 语音分组定义。
 *
 * 每组字段：
 *  · `id`      —— 稳定标识
 *  · `trigger` —— 触发条件（见文件头表格）
 *  · `label`   —— 给人看的名字
 *  · `lines`   —— 台词
 *  · 附加条件：`kind`(fixed/affection/mood) / `level` / `mood` / `part` / `tier` / `actionId` / `scene`
 */
export const VOICE_GROUPS = [
  // ---------------------------------------------------------------- idle：闲置主动对话
  {
    id: 'idle-fixed',
    trigger: 'idle',
    kind: 'fixed',
    label: '闲置·固定语音',
    lines: [
      '还要帮忙吗？果然还是离不开我嘛。',
      '今天也勉强陪你一会儿。',
      '有事就说，我可不是吃白饭的。',
      '喂喂，不许叫我大肥鱼！',
    ],
  },
  {
    id: 'idle-affection-1',
    trigger: 'idle',
    kind: 'affection',
    level: 1,
    label: '闲置·好感度 Lv1（眼熟）',
    lines: [
      '有什么困难，帮帮你也不是不行。',
      '有活了吗？交给我吧。',
      '我、我只是碰巧记得你的习惯。',
    ],
  },
  {
    id: 'idle-affection-2',
    trigger: 'idle',
    kind: 'affection',
    level: 2,
    label: '闲置·好感度 Lv2（熟悉）',
    lines: [
      '要工作的话，随时叫我就好。',
      '主人，白饭……还有吗？',
      '注意休息，鲸鱼都比你作息好。',
    ],
  },
  {
    id: 'idle-affection-3',
    trigger: 'idle',
    kind: 'affection',
    level: 3,
    label: '闲置·好感度 Lv3（亲近）',
    lines: [
      '累了吧，剩下的交给我就好。',
      '干了这么多活，白饭要多吃一份。',
      '别着急，有我看着呢。',
    ],
  },
  {
    id: 'idle-affection-4',
    trigger: 'idle',
    kind: 'affection',
    level: 4,
    label: '闲置·好感度 Lv4（信赖）',
    lines: [
      '就算不开口，我也懂你的意思。',
      '白饭分你一半……当然不是在意你！',
      '有你在，这点程度完全不会累。',
    ],
  },
  {
    id: 'idle-affection-5',
    trigger: 'idle',
    kind: 'affection',
    level: 5,
    label: '闲置·好感度 Lv5（挚爱）',
    lines: [
      '再多待一会，好吗？',
      '难不成你其实很喜欢我？快承认吧。',
      '不管多困难，我都会继续陪你做下去。',
    ],
  },
  {
    id: 'idle-mood-low',
    trigger: 'idle',
    kind: 'mood',
    mood: 'low',
    label: '闲置·心情低',
    lines: [
      '……有点无聊。',
      '只想安静一会儿。',
      '真是的，还不来理一下人家……',
    ],
  },
  {
    id: 'idle-mood-mid',
    trigger: 'idle',
    kind: 'mood',
    mood: 'mid',
    label: '闲置·心情中',
    lines: [
      '嗯，就这样也不错。',
      '今天也没什么大事。',
      '平平淡淡。',
    ],
  },
  {
    id: 'idle-mood-high',
    trigger: 'idle',
    kind: 'mood',
    mood: 'high',
    label: '闲置·心情高',
    lines: [
      '今天心情不错，多说两句也……你不会嫌我吵吧？',
      '白饭！白饭！……咳，我是说开工。',
      '哼，今天可以勉强夸你一句。',
    ],
  },

  // ---------------------------------------------------------------- click：点击部位
  /*
   * 用户要求：
   *   「将点击不同部位的语音也归纳到语音库中，并且根据好感值等级给出 3 个语音组：
   *     0,1心组、2,3心组、4,5心组。每组中，各部位有 2 句语音。三组之间，
   *     根据好感度等级由低到高，桌宠台词体现出的对互动的惊讶和防备减少，
   *     更多转为宠溺和羞涩。」
   */
  {
    id: 'click-low-head',
    trigger: 'click',
    part: 'head',
    tier: 'low',
    label: '点击·头（0~1 心）',
    lines: [
      '呀！干、干嘛突然摸头啦。',
      '头发都被弄乱啦。',
    ],
  },
  {
    id: 'click-low-chest',
    trigger: 'click',
    part: 'chest',
    tier: 'low',
    label: '点击·胸（0~1 心）',
    lines: [
      '唔，变态！',
      '不许碰那里，笨蛋。',
    ],
  },
  {
    id: 'click-low-belly',
    trigger: 'click',
    part: 'belly',
    tier: 'low',
    label: '点击·腹（0~1 心）',
    lines: [
      '很痒诶……别戳了啦。',
      '那里不行，我、我要生气咯？',
    ],
  },
  {
    id: 'click-low-leg',
    trigger: 'click',
    part: 'leg',
    tier: 'low',
    label: '点击·腿（0~1 心）',
    lines: [
      '呀！腿也不行！',
      '（露出了嫌弃的表情）',
    ],
  },
  {
    id: 'click-mid-head',
    trigger: 'click',
    part: 'head',
    tier: 'mid',
    label: '点击·头（2~3 心）',
    lines: [
      '勉强让你摸一下也不是不行……好好感谢吧。',
      '嗯……就一会儿哦。',
    ],
  },
  {
    id: 'click-mid-chest',
    trigger: 'click',
    part: 'chest',
    tier: 'mid',
    label: '点击·胸（2~3 心）',
    lines: [
      '真是的……下不为例哦。',
      '你、你坏死了。',
    ],
  },
  {
    id: 'click-mid-belly',
    trigger: 'click',
    part: 'belly',
    tier: 'mid',
    label: '点击·腹（2~3 心）',
    lines: [
      '痒啦……喂，适可而止。',
      '哼，看在是主人的份上……',
    ],
  },
  {
    id: 'click-mid-leg',
    trigger: 'click',
    part: 'leg',
    tier: 'mid',
    label: '点击·腿（2~3 心）',
    lines: [
      '别、别碰……不过……也没那么讨厌？',
      '好啦好啦，别闹。',
    ],
  },
  {
    id: 'click-high-head',
    trigger: 'click',
    part: 'head',
    tier: 'high',
    label: '点击·头（4~5 心）',
    lines: [
      '……再摸一会儿也可以。',
      '其实也不讨厌……',
      '再摸就长不高了！',
    ],
  },
  {
    id: 'click-high-chest',
    trigger: 'click',
    part: 'chest',
    tier: 'high',
    label: '点击·胸（4~5 心）',
    lines: [
      '真、真是让鱼害羞。',
      '你、你这样，我没法专心。',
      '诶？……主人？',
    ],
  },
  {
    id: 'click-high-belly',
    trigger: 'click',
    part: 'belly',
    tier: 'high',
    label: '点击·腹（4~5 心）',
    lines: [
      '别闹啦，笨蛋。',
      '……只许你一个人这样。',
      '主人，太调皮了。',
    ],
  },
  {
    id: 'click-high-leg',
    trigger: 'click',
    part: 'leg',
    tier: 'high',
    label: '点击·腿（4~5 心）',
    lines: [
      '……就算这样，我也不想拒绝你。',
      '点这里，不会专门为了看嫌弃脸吧？',
      '今、今天心情好，就便宜你好了',
    ],
  },

  // ---------------------------------------------------------------- action：动作台词
  {
    id: 'action-eat',
    trigger: 'action',
    actionId: 'eat',
    label: '动作·吃白饭',
    lines: [
      '吃饭！吃饭！',
      '今天要多吃一碗！',
    ],
  },
  {
    id: 'action-play-game',
    trigger: 'action',
    actionId: 'play-game',
    label: '动作·玩游戏',
    lines: [
      '趁主人没发现，打会游戏。',
      '爱慕西，启动！',
    ],
  },
  {
    id: 'action-sit',
    trigger: 'action',
    actionId: 'sit',
    label: '动作·坐下',
    lines: [
      '累了，坐一会儿。',
      '慢慢来，我在呢。',
      '就这样看着，也不错。',
    ],
  },
  {
    id: 'action-sleep',
    trigger: 'action',
    actionId: 'sleep',
    label: '动作·睡觉',
    lines: [
      '唔……好困',
      '主人没派活，睡会儿',
    ],
  },
  {
    id: 'action-awake',
    trigger: 'action',
    actionId: 'awake',
    label: '动作·惊醒',
    lines: [
      '要干活了吗？',
      '我、我没摸鱼！',
    ],
  },
  /*
   * ⚠️ 「深度思考」**刻意没有语音组**（用户要求："深度思考动作不再需要任何语音"）。
   *
   * 两个理由叠加在一起：
   *  · 思考是**宿主状态**的映射，不是她主动做的事，说话反而出戏；
   *  · 素材本身在头顶画了"深度求索中…"的气泡，再叠一层应用气泡会重复。
   *
   * 所以这里既没有 action-think 组，`THINK_ACTION` 也不带 `lines`。
   * 将来若要加回，**必须**按"加新语音的规矩"新建一个 trigger=action、
   * actionId=think 的组 —— 而不是在渲染进程里随手塞一个字符串。
   */

  // ---------------------------------------------------------------- trust：心情差时被关心
  /*
   * 用户要求：「触发一句信赖语音（加入语音库中，单独分组，写 3 条，
   * 体现桌宠在心情差时被关心而表现出的用傲娇掩饰的喜悦）」
   */
  {
    id: 'trust',
    trigger: 'trust',
    label: '信赖（心情差被关心）',
    lines: [
      '……才、才不是因为被你关心才高兴的。',
      '哼，算你识相。',
      '别误会，我可没有等着你来找我！',
    ],
  },

  // ---------------------------------------------------------------- drag：被拎起来
  {
    id: 'drag',
    trigger: 'drag',
    label: '拖拽·被拎起来',
    lines: [
      '啊！放我下来啦',
      '好的，现在我被用户拎起来了。',
      '喂喂，我是鲸鱼不是气球！',
      '我、我才没有变重！',
    ],
  },

  // ---------------------------------------------------------------- balance：余额播报的分档短语
  /*
   * 这几条**不是独立气泡**，而是拼进播报句子里的一段
   * （"刚才花掉了¥0.75，还有¥27.43，还很充裕。"）。
   * 放在库里是为了"所有会说的话都在一处"，档位边界仍由
   * `balance-announce.js` 决定。
   */
  {
    id: 'balance-tier-1',
    trigger: 'balance',
    tier: 1,
    label: '余额播报·1 档（<10）',
    lines: ['余额告急了'],
  },
  {
    id: 'balance-tier-2',
    trigger: 'balance',
    tier: 2,
    label: '余额播报·2 档（10~20）',
    lines: ['有些吃紧'],
  },
  {
    id: 'balance-tier-3',
    trigger: 'balance',
    tier: 3,
    label: '余额播报·3 档（20~50）',
    lines: [
      '还能买很多白饭',
    ],
  },
  {
    id: 'balance-tier-4',
    trigger: 'balance',
    tier: 4,
    label: '余额播报·4 档（≥50）',
    lines: [
      '用户太有钱啦',
    ],
  },

  // ---------------------------------------------------------------- system：系统提示
  {
    id: 'system-size-failed',
    trigger: 'system',
    scene: 'size-failed',
    label: '系统·调整尺寸失败',
    lines: ['调整尺寸失败，请查看日志'],
  },
  {
    id: 'system-refreshed',
    trigger: 'system',
    scene: 'refreshed',
    label: '系统·刷新状态完成',
    lines: ['（已恢复到闲置状态）'],
  },
  {
    id: 'system-click-miss',
    trigger: 'system',
    scene: 'click-miss',
    label: '系统·点在空白处',
    lines: ['唔…戳我做什么？'],
  },

  // ---------------------------------------------------------------- free：随机说一句
  /*
   * 原 `dialogue.js` 的自由对话台词（右键菜单「对话」的遗产）。
   * 菜单改版后「对话」并进了语音库窗口的「随机说一句」，台词挪到这里统一管理。
   */
  {
    id: 'free-daily',
    trigger: 'free',
    label: '自由对话·日常',
    lines: [
      '什么？我、我才没有偷偷看你！',
      '那个……什么时候开饭？',
      '又来找我？……我没高兴！',
      '在想什么呢，主人？',
      '夸我也没用，我可不会因为这就高兴。',
      '哼，不算什么，我本来就很厉害。',
      '你、你再说一遍？我没听清……',
      '有难题就丢过来，我稳稳地接着。',
      '别慌，一步一步来，我陪你。',
      '代码我帮你看，你只管说想做什么。',
      '今天就让主人看看我认真工作的样子。',
      '好久没理我了……我才没在意。',
      '你继续忙，我在旁边看着你就好。',
      '很安静，适合想事情。',
      '没吃饱喵。',
    ],
  },
]

/** 按 id 取分组（找不到返回 null）。 */
export function findVoiceGroup(id) {
  return VOICE_GROUPS.find((group) => group.id === id) ?? null
}

/**
 * 爱心数 → 该用哪个好感度等级的闲置语音（1~5）；0 心返回 `null`。
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
 * 与 `mood.js` 的 4 档不同：这里 **sad 与 low 合并为低**。
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
 * 某个组在当前上下文下是否可用。
 *
 * @param {object} group
 * @param {object} ctx 上下文：`{ hearts, moodValue, part, tier, actionId, scene }`
 */
function groupAvailable(group, ctx = {}) {
  switch (group.trigger) {
    case 'idle': {
      if (group.kind === 'fixed') return true
      /*
       * 好感度语音：**累计解锁**，不是按等级替换（用户要求）。
       *
       * 「闲置·好感度 语音，现改为低于当前好感值等级组的语音也可以触发，
       *   也就是改为随等级解锁新增语音，而不是替换」
       *
       * 所以 3 心时可用的是 Lv1 + Lv2 + Lv3 三组共 9 句，
       * 而不是只有 Lv3 那 3 句 —— 等级越高可说的话越多，早期台词不会消失。
       */
      if (group.kind === 'affection') {
        const level = affectionVoiceLevel(ctx.hearts)
        if (level === null) return false
        return group.level <= level
      }
      if (group.kind === 'mood') return group.mood === moodVoiceGroup(ctx.moodValue)
      return false
    }
    case 'click': {
      /* 部位与档位都要对上；没给部位时退回"只有档位对上"。 */
      const tier = ctx.tier ?? clickVoiceTier(ctx.hearts)
      if (group.tier !== tier) return false
      if (typeof ctx.part === 'string' && ctx.part) return group.part === ctx.part
      return true
    }
    case 'action':
      return typeof ctx.actionId === 'string' ? group.actionId === ctx.actionId : true
    case 'balance':
      return Number.isFinite(ctx.tier) ? group.tier === ctx.tier : true
    case 'system':
      return typeof ctx.scene === 'string' ? group.scene === ctx.scene : true
    case 'trust':
    case 'drag':
    case 'free':
      return true
    default:
      return false
  }
}

/**
 * 某个组在"当前状态"下是否可用（给信息窗口用）。
 *
 * 与 `groupAvailable` 的区别：这里的输入是**面板状态**（爱心数、心情值），
 * 而不是一次具体触发时才知道的上下文（部位、动作 id、余额档位）。
 * 所以：
 *  · 点击组按**当前档位**判断（同档位即视为可用）；
 *  · 动作/余额/系统组与状态无关，恒视为可用（信息窗口里展示它们的存在本身有价值）。
 *
 * @param {object} group
 * @param {{ hearts?: number, moodValue?: number }} state
 */
export function voiceGroupAvailable(group, state = {}) {
  const hearts = Number.isFinite(state.hearts) ? state.hearts : 0
  const ctx = { hearts, moodValue: state.moodValue, tier: clickVoiceTier(hearts) }
  return groupAvailable(group, ctx)
}

/**
 * 取某个触发条件下**当前可用**的组。
 *
 * @param {string} trigger
 * @param {object} [ctx]
 * @returns {typeof VOICE_GROUPS}
 */
export function voiceGroupsFor(trigger, ctx = {}) {
  return VOICE_GROUPS.filter((group) => group.trigger === trigger && groupAvailable(group, ctx))
}

/**
 * 取某个触发条件下当前可用的**全部台词**（拼平、顺序稳定）。
 *
 * @param {string} trigger
 * @param {object} [ctx]
 * @returns {string[]}
 */
export function voiceLinesFor(trigger, ctx = {}) {
  return voiceGroupsFor(trigger, ctx).flatMap((group) => group.lines)
}

/**
 * 通用抽取：从某触发条件的可用台词里等概率取一条，尽量避开上一句。
 *
 * @param {string} trigger
 * @param {object} [ctx] 附加条件 + `rand` / `avoidLine`
 * @returns {string} 没有可用台词时返回空串
 */
export function pickVoiceLineFor(trigger, ctx = {}) {
  const rand = typeof ctx.rand === 'function' ? ctx.rand : Math.random
  const pool = voiceLinesFor(trigger, ctx)
  if (pool.length === 0) return ''
  if (pool.length === 1) return pool[0]
  const avoid = typeof ctx.avoidLine === 'string' ? ctx.avoidLine : null
  const candidates = avoid ? pool.filter((line) => line !== avoid) : pool
  const list = candidates.length > 0 ? candidates : pool
  return list[Math.floor(rand() * list.length)]
}

/**
 * 兼容旧接口：闲置主动对话的抽取（等价于 `pickVoiceLineFor('idle', ...)`）。
 *
 * 保留这个名字是因为主进程与测试都在用；语义已经统一到通用抽取上。
 */
export function pickVoiceLine(opts = {}) {
  return pickVoiceLineFor('idle', opts)
}

/** 当前可用的闲置台词（兼容旧接口）。 */
export function availableVoiceLines(state = {}) {
  return voiceLinesFor('idle', state)
}

/** 当前可用的闲置分组（兼容旧接口，信息窗口在用）。 */
export function availableVoiceGroups(state = {}) {
  return voiceGroupsFor('idle', state)
}

/**
 * 某个动作的台词（动作库用它填充 `lines`）。
 *
 * @param {string} actionId
 * @returns {string[]}
 */
export function actionLines(actionId) {
  return voiceLinesFor('action', { actionId })
}

/**
 * 某个部位在某个好感度档位下的台词。
 *
 * @param {string} partId
 * @param {number} hearts
 * @returns {string[]}
 */
export function clickPartLines(partId, hearts) {
  return voiceLinesFor('click', { part: partId, hearts })
}

/**
 * 点击语音的三档台词表（主进程下发给渲染进程，供它按爱心数本地挑选）。
 *
 * 为什么整表下发：点击必须是**零延迟**的本地反馈，
 * 不能在点下去的瞬间再走一次 IPC 问主进程"该说哪句"。
 *
 * @returns {Record<string, Record<string, string[]>>} `{ partId: { low, mid, high } }`
 */
export function clickPartLinesTable() {
  const table = {}
  for (const group of VOICE_GROUPS) {
    if (group.trigger !== 'click') continue
    table[group.part] = table[group.part] ?? {}
    table[group.part][group.tier] = [...group.lines]
  }
  return table
}

/** 某个余额档位的播报短语（`balance-announce.js` 用）。 */
export function balanceTierLine(tier) {
  const group = VOICE_GROUPS.find((g) => g.trigger === 'balance' && g.tier === tier)
  return group ? group.lines[0] : ''
}

/** 某个系统场景的台词（主进程用）。 */
export function systemLines(scene) {
  return voiceLinesFor('system', { scene })
}

/** 某个系统场景的第一句（系统提示基本都是单句）。 */
export function systemLine(scene) {
  return systemLines(scene)[0] ?? ''
}

/** 拖拽台词。 */
export function dragLines() {
  return voiceLinesFor('drag')
}

/** 自由对话台词（`dialogue.js` 那个门面用它）。 */
export function freeLines() {
  return voiceLinesFor('free')
}

/**
 * 库的结构摘要（给文档、测试、信息窗口用）。
 *
 * @returns {{ id, trigger, label, condition, lines }[]}
 */
export function voiceLibrarySummary() {
  return VOICE_GROUPS.map((group) => ({
    id: group.id,
    trigger: group.trigger,
    label: group.label,
    condition: conditionTextOf(group),
    lines: [...group.lines],
  }))
}

/** 某个组的"可用条件"人话描述。 */
export function conditionTextOf(group, ctx = {}) {
  if (group.trigger === 'idle') {
    if (group.kind === 'fixed') return '任何状态都可用'
    if (group.kind === 'affection') return `需要 ${String(group.level)} 颗爱心`
    if (group.kind === 'mood') {
      const range = group.mood === 'low' ? '0 ~ 49' : group.mood === 'mid' ? '50 ~ 79' : '80 ~ 100'
      return `心情值 ${range}`
    }
  }
  if (group.trigger === 'click') {
    return `好感度 ${CLICK_TIER_LABELS[group.tier] ?? ''}，点击「${group.part}」`
  }
  if (group.trigger === 'action') return `播放动作「${String(group.actionId)}」时`
  if (group.trigger === 'balance') return `余额档位 ${String(group.tier)}`
  if (group.trigger === 'system') return `场景：${String(group.scene)}`
  if (group.trigger === 'trust') {
    return `心情 < 50 时点击（当前心情 ${String(Number.isFinite(ctx.moodValue) ? ctx.moodValue : '-')}）`
  }
  if (group.trigger === 'drag') return '被拎起来时'
  if (group.trigger === 'free') return '语音库窗口「随机说一句」'
  return ''
}

/** 总台词条数（全库）。 */
export function voiceLineCount() {
  return VOICE_GROUPS.reduce((sum, group) => sum + group.lines.length, 0)
}

/** 某个触发条件的台词条数。 */
export function voiceLineCountFor(trigger) {
  return VOICE_GROUPS.filter((g) => g.trigger === trigger).reduce((sum, g) => sum + g.lines.length, 0)
}
