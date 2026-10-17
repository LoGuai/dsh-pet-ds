/**
 * 从 `src/shared-core/voice-library.js` **生成** `VOICE-LIBRARY.md`。
 *
 * 为什么要生成：全库上百句台词，手写文档必然与代码漂移
 * （改了台词忘了改文档），而"语音文档"正是用户会逐条核对的东西。
 *
 * 生成后用 `test-voice-library.mjs` 断言"仓库里的文档 === 现在生成的内容"，
 * 于是改了库却忘了重新生成就会红。
 *
 * 用法：
 *   node scripts/dev/gen-voice-doc.mjs          写入 VOICE-LIBRARY.md
 *   node scripts/dev/gen-voice-doc.mjs --check   只校验（不一致则退出码 1）
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  VOICE_GROUPS,
  MOOD_VOICE_MID_MIN,
  MOOD_VOICE_HIGH_MIN,
  VOICE_LINE_MAX_CHARS,
  voiceLineCount,
  voiceLineCountFor,
  voiceLibrarySummary,
  CLICK_VOICE_TIERS,
  clickVoiceTier,
} from '../../src/shared-core/voice-library.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const DOC = join(ROOT, 'VOICE-LIBRARY.md')

/** 触发条件 → 文档里的标题与说明（顺序即文档顺序）。 */
const TRIGGERS = [
  {
    id: 'idle',
    title: '闲置主动对话',
    when: '桌宠连续闲置时，**每 1 分钟**说一句（到点被动作/拖拽/睡眠挡住会 5 秒后重试）。',
  },
  {
    id: 'click',
    title: '点击身体部位',
    when:
      '点击命中某个部位时。台词按**好感度三档**分组：0~1 心 / 2~3 心 / 4~5 心 —— '
      + '由低到高，「惊讶与防备」逐渐减少，转为**宠溺与羞涩**。',
  },
  {
    id: 'action',
    title: '播放动作',
    when: '播放某个动作时配的一句话（动作定义里的 `lines` 就取自这里）。',
  },
  {
    id: 'trust',
    title: '心情差时被关心',
    when:
      '心情值 < 50 时点击桌宠：心情立即 +50，并只说这一组里的一句'
      + '（**不播部位动画、不说部位台词**）。',
  },
  { id: 'drag', title: '被拎起来', when: '拖拽开始时随机一句。' },
  {
    id: 'balance',
    title: '余额播报',
    when:
      '余额变动播报时拼进句子的档位短语（例如"刚才花掉了¥0.75，还有¥27.43，**还很充裕**。"）。'
      + '档位边界由 `balance-announce.js` 决定，文字取自本库。',
  },
  { id: 'system', title: '系统提示', when: '调尺寸失败、刷新状态完成、点在空白处等系统场景。' },
  { id: 'free', title: '随机说一句', when: '语音库窗口下方的「随机说一句」按钮。' },
]

export function buildVoiceDoc() {
  const summary = voiceLibrarySummary()
  const total = voiceLineCount()
  const L = []

  L.push('# 语音库 · 分组与条目')
  L.push('')
  L.push('> 本文档由 `scripts/dev/gen-voice-doc.mjs` **从 `src/shared-core/voice-library.js` 生成**，')
  L.push('> 请勿手改。要改台词请改库，然后运行：')
  L.push('>')
  L.push('> ```powershell')
  L.push('> node scripts/dev/gen-voice-doc.mjs')
  L.push('> ```')
  L.push('')
  L.push('## 总览')
  L.push('')
  L.push(`- 触发条件：**${String(TRIGGERS.length)}** 类`)
  L.push(`- 分组：**${String(summary.length)}** 个`)
  L.push(`- 台词总数：**${String(total)}** 条`)
  L.push(`- 单句长度上限：**${String(VOICE_LINE_MAX_CHARS)} 字符**（超了会撑高气泡、让立绘位置抖动）`)
  L.push('')
  L.push('| 触发条件 | 含义 | 分组数 | 台词数 |')
  L.push('|---|---|---|---|')
  for (const t of TRIGGERS) {
    const groups = summary.filter((g) => g.trigger === t.id)
    L.push(`| \`${t.id}\` | ${t.title} | ${String(groups.length)} | ${String(voiceLineCountFor(t.id))} |`)
  }
  L.push('')
  L.push('## 加新语音的规矩（用户要求）')
  L.push('')
  L.push('1. 先确定**触发条件**属于哪一类（见上表）；')
  L.push('2. 已有同条件的组 → 直接加进那个组的 `lines`；')
  L.push('3. 没有合适的组 → 新建一个组，填好 `trigger` 与附加条件，加进 `VOICE_GROUPS`；')
  L.push(`4. 单句不超过 ${String(VOICE_LINE_MAX_CHARS)} 字、**不得与已有台词重复**（跨组也查）；`)
  L.push('5. 跑 `node scripts/dev/gen-voice-doc.mjs` 重新生成本文档，再跑 `npm test`。')
  L.push('')
  L.push('所有台词只有**一处**来源，就是那个文件。渲染进程拿到的部分是主进程下发的副本。')
  L.push('')

  for (const t of TRIGGERS) {
    const groups = summary.filter((g) => g.trigger === t.id)
    L.push(`## ${t.title}　\`${t.id}\``)
    L.push('')
    L.push(t.when)
    L.push('')
    if (groups.length === 0) {
      L.push('（暂无分组）')
      L.push('')
      continue
    }
    for (const g of groups) {
      L.push(`### ${g.label}　\`${g.id}\`　${String(g.lines.length)} 条`)
      L.push('')
      if (g.condition) {
        L.push(`- 可用条件：${g.condition}`)
        L.push('')
      }
      g.lines.forEach((line, i) => {
        L.push(`${String(i + 1)}. ${line}`)
      })
      L.push('')
    }
  }

  L.push('## 好感度与心情的分档口径')
  L.push('')
  L.push('**闲置语音**：固定语音恒可用；好感度专专属组**恰好等于**该等级才启用（0 心无专属组）；')
  L.push(`心情按 **${String(MOOD_VOICE_MID_MIN)} / ${String(MOOD_VOICE_HIGH_MIN)}** 分三档，`)
  L.push('其中心情模块的 sad（<20）与 low（20~49）**合并为"低"**。')
  L.push('')
  L.push('**点击语音**：按爱心数分三档 ——')
  L.push('')
  L.push('| 爱心数 | 档位 |')
  L.push('|---|---|')
  for (const tier of CLICK_VOICE_TIERS) {
    const hearts = [0, 1, 2, 3, 4, 5].filter((h) => clickVoiceTier(h) === tier)
    L.push(`| ${hearts.join('、')} | \`${tier}\` |`)
  }
  L.push('')
  L.push('三档之间的语气递进：低档「惊讶 + 防备」→ 中档「嘴硬但放松」→ 高档「宠溺 + 羞涩」。')
  L.push('')
  L.push('## 人设口径')
  L.push('')
  L.push('**傲娇 + 贪吃（尤其白饭）+ 鲸鱼娘 + 助手**')
  L.push('')
  L.push('| 要素 | 体现方式 |')
  L.push('|---|---|')
  L.push('| 傲娇 | 嘴硬心软、被夸先否认；常用「……才不是」「哼」「别当作我很在意」这类转折 |')
  L.push('| 贪吃 | 白饭梗贯穿各等级与各心情档；"多煮一碗""加个蛋""第一口给你" |')
  L.push('| 鲸鱼娘 | 深海、浮上来换气、冷这类意象；**是点缀不是主题**，不做科普 |')
  L.push('| 助手 | 等级语音里留着"靠得住"的一面：提前看活、扛得动、知道你要什么 |')
  L.push('')

  return `${L.join('\n')}\n`
}

/*
 * 只有"直接运行本文件"时才写盘/校验。
 *
 * ⚠️ 为什么必须区分：`test-voice-library.mjs` 会 `import { buildVoiceDoc }`
 * 来比对文档，若顶层的写盘代码无条件执行，跑一次测试就会**顺手改掉仓库文件**。
 */
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  const content = buildVoiceDoc()
  const args = process.argv.slice(2)
  const checkOnly = args.includes('--check')

  if (checkOnly) {
    if (!existsSync(DOC)) {
      console.log('✗ 找不到 VOICE-LIBRARY.md，请运行 node scripts/dev/gen-voice-doc.mjs')
      process.exit(1)
    }
    const current = readFileSync(DOC, 'utf8')
    if (current !== content) {
      console.log('✗ VOICE-LIBRARY.md 与语音库不一致 —— 请重新运行 node scripts/dev/gen-voice-doc.mjs')
      process.exit(1)
    }
    console.log(
      `✓ VOICE-LIBRARY.md 与库一致（${String(VOICE_GROUPS.length)} 组 / ${String(voiceLineCount())} 条）`,
    )
  } else {
    writeFileSync(DOC, content, 'utf8')
    console.log(`已生成 ${DOC}（${String(VOICE_GROUPS.length)} 组 / ${String(voiceLineCount())} 条）`)
  }
}
