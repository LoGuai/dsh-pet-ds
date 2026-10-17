/**
 * 从 `src/shared-core/voice-library.js` **生成** `VOICE-LIBRARY.md`。
 *
 * 为什么要生成而不是手写：分组、条数、每句台词一共 27 条，
 * 手写文档一定会与代码漂移（改了台词忘了改文档），而"语音文档"恰恰是
 * 用户会拿去逐条核对的东西 —— 文档写错比没有文档更糟。
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
  voiceLibrarySummary,
} from '../../src/shared-core/voice-library.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const DOC = join(ROOT, 'VOICE-LIBRARY.md')

/** 分组类型 → 文档里的中文说明。 */
const KIND_DESC = {
  fixed: '任何状态都可用',
  affection: '仅在**爱心数恰好等于该等级**时可用（0 心时不启用任何专属组）',
  mood: '按**心情值**分档启用，见下方「心情分档」',
}

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
  L.push('## 概览')
  L.push('')
  L.push(`- 分组数：**${String(summary.length)}**`)
  L.push(`- 台词总数：**${String(total)}** 条（每组 3 条）`)
  L.push(`- 单句长度上限：**${String(VOICE_LINE_MAX_CHARS)} 字符**（超了会撑高气泡、让立绘位置抖动）`)
  L.push('')
  L.push('| 分组 id | 名称 | 类型 | 可用条件 | 条数 |')
  L.push('|---|---|---|---|---|')
  for (const g of summary) {
    L.push(`| \`${g.id}\` | ${g.label} | ${g.kind} | ${KIND_DESC[g.kind]} | ${String(g.lines.length)} |`)
  }
  L.push('')
  L.push('## 触发方式')
  L.push('')
  L.push('**闲置主动对话**：桌宠连续闲置时，**每 1 分钟**说一句。')
  L.push('')
  L.push('取哪一句的规则：')
  L.push('')
  L.push('1. 先按当前状态算出**可用的组**（固定语音恒可用 + 当前好感度等级的专属组 + 当前心情档位的组）；')
  L.push('2. 把这些组的台词**拼成一个池**，等概率随机取一条；')
  L.push('3. 尽量**不与上一句重复**（池里只有 1 句时例外）。')
  L.push('')
  L.push('到点时若正在播动作 / 拖拽 / 睡觉，会 **5 秒后重试**而不是跳过这一分钟 ——')
  L.push('否则用户会觉得"怎么有时候一整天不说话"。')
  L.push('')
  L.push('## 好感度分档')
  L.push('')
  L.push('爱心数来自好感度系统（0~5 颗心，见 `src/shared-core/affection.js`）。')
  L.push('')
  L.push('| 爱心数 | 称呼 | 启用的专属组 |')
  L.push('|---|---|---|')
  const labels = ['陌生', '眼熟', '熟悉', '亲近', '信赖', '挚爱']
  for (let h = 0; h <= 5; h += 1) {
    const group = summary.find((g) => g.kind === 'affection' && g.level === h)
    L.push(`| ${String(h)} | ${labels[h]} | ${group ? `\`${group.id}\`` : '（无，只有固定 + 心情语音）'} |`)
  }
  L.push('')
  L.push('> 规则是**恰好等于**该等级，不是"大于等于"。用户的要求是"5 个好感度等级**分别**的专属语音"：')
  L.push('> 若做成累加，升到 5 心时会同时听到 1~5 级共 15 条，等级感就没了。')
  L.push('> 想改成累加，只需改 `availableVoiceGroups()` 里的一行判断。')
  L.push('')
  L.push('## 心情分档')
  L.push('')
  L.push(`心情值 0~100（见 \`src/shared-core/mood.js\`）。用户要求分 **低 / 中 / 高** 三组，`)
  L.push('而心情模块本身是 **4 档**（sad / low / normal / happy），所以这里把 **sad 与 low 合并为「低」**：')
  L.push('')
  L.push('| 心情值 | 心情模块的档位 | 语音组 |')
  L.push('|---|---|---|')
  L.push(`| 0 ~ ${String(MOOD_VOICE_MID_MIN - 1)} | sad（<20）与 low（20~49） | \`mood-low\` |`)
  L.push(`| ${String(MOOD_VOICE_MID_MIN)} ~ ${String(MOOD_VOICE_HIGH_MIN - 1)} | normal | \`mood-mid\` |`)
  L.push(`| ${String(MOOD_VOICE_HIGH_MIN)} ~ 100 | happy | \`mood-high\` |`)
  L.push('')
  L.push('## 各分组明细')
  L.push('')

  for (const g of summary) {
    L.push(`### ${g.label} 　\`${g.id}\` 　${String(g.lines.length)} 条`)
    L.push('')
    if (g.kind === 'affection') {
      L.push(`- 可用条件：爱心数 **恰好 ${String(g.level)}** 颗`)
    } else if (g.kind === 'mood') {
      const range =
        g.mood === 'low'
          ? `0 ~ ${String(MOOD_VOICE_MID_MIN - 1)}`
          : g.mood === 'mid'
            ? `${String(MOOD_VOICE_MID_MIN)} ~ ${String(MOOD_VOICE_HIGH_MIN - 1)}`
            : `${String(MOOD_VOICE_HIGH_MIN)} ~ 100`
      L.push(`- 可用条件：心情值 **${range}**`)
    } else {
      L.push('- 可用条件：**任何状态**')
    }
    L.push('')
    g.lines.forEach((line, i) => {
      L.push(`${String(i + 1)}. ${line}`)
    })
    L.push('')
  }

  L.push('## 人设口径')
  L.push('')
  L.push('**傲娇 + 贪吃（尤其白饭）+ 鲸鱼娘 + 助手**')
  L.push('')
  L.push('| 要素 | 体现方式 |')
  L.push('|---|---|')
  L.push('| 傲娇 | 嘴硬心软、被夸先否认；常用「……才不是」「哼」「别当作我很在意」这类转折 |')
  L.push('| 贪吃 | 白饭梗贯穿各等级与各心情档；"多煮一碗""加个蛋""第一口给你" |')
  L.push('| 鲸鱼娘 | 深海、浮上来换气、冷这类意象；**是点缀不是主题**，不做科普 |')
  L.push('| 助手 | 每条等级语音里都留着"靠得住"的一面：提前看活、扛得动、知道你要什么 |')
  L.push('')
  L.push('## 新增台词的注意事项')
  L.push('')
  L.push(`1. **不超过 ${String(VOICE_LINE_MAX_CHARS)} 字**（有测试钉住）；`)
  L.push('2. **不得与已有台词重复**（跨组也查，有测试钉住）；')
  L.push('3. 每组目前是 3 条，多写几个也行 —— 但不能为 0（组空了就等于那个状态没台词）；')
  L.push('4. 改完必须重新生成文档，否则 `test-voice-library.mjs` 会红。')
  L.push('')
  L.push('## 与「对话」菜单的关系')
  L.push('')
  L.push('右键菜单里的「对话」用的是**另一个库** `src/shared-core/dialogue.js`：')
  L.push('那是"点一下就听一句"的无条件台词，不看好感度、不看心情。')
  L.push('两个库分开，是因为它们的取用条件完全不同 —— 合在一起会让"随机"变得不可推断。')
  L.push('')

  return `${L.join('\n')}\n`
}

/*
 * 只有"直接运行本文件"时才写盘/校验。
 *
 * ⚠️ 为什么必须区分：`test-voice-library.mjs` 会 `import { buildVoiceDoc }`
 * 来比对文档，若顶层的写盘代码无条件执行，跑一次测试就会**顺手改掉仓库文件** ——
 * 测试有了副作用，就不再是"只读地检查"了。实测踩过。
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
    console.log(`✓ VOICE-LIBRARY.md 与库一致（${String(VOICE_GROUPS.length)} 组 / ${String(voiceLineCount())} 条）`)
  } else {
    writeFileSync(DOC, content, 'utf8')
    console.log(`已生成 ${DOC}（${String(VOICE_GROUPS.length)} 组 / ${String(voiceLineCount())} 条）`)
  }
}
