/**
 * 生成「语音库总览」—— 给用户审查、修改，改完再拿回来更新语音库。
 *
 * 与 `VOICE-LIBRARY.md` 的区别：
 *  · 那个是**只读文档**（由库生成，测试要求逐字一致），给人查阅；
 *  · 这个总览是**工作清单**：每条台词一行、带稳定编号与触发条件，
 *    用户直接在行上改，改完回传，我再据此更新 `voice-library.js`。
 *
 * 输出到仓库根目录（不放 dist：dist 会被 build-package 整个清掉）：
 *  · VOICE-OVERVIEW.md（可编辑）
 *  · VOICE-OVERVIEW.txt（记事本可看）
 *  · VOICE-OVERVIEW.docx（Word，便于批注）
 *
 * 用法：node scripts/dev/build-voice-overview.mjs
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { VOICE_GROUPS, voiceLineCountFor } from '../../src/shared-core/voice-library.js'
import {
  PART_ACTIONS,
  RANDOM_ACTIONS,
  MENU_ONLY_ACTIONS,
} from '../../src/shared-core/actions-library.js'

const ROOT = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

/** 触发条件 → 说明（顺序即文件顺序）。 */
const TRIGGER_DOC = [
  ['idle', '闲置主动对话', '闲置满 1 分钟后按概率触发，每 60 秒最多一次；也可由右键「对话」触发'],
  ['click', '点击身体部位', '鼠标点击角色，按部位 + 好感档位选一句'],
  ['action', '播放动作', '右键菜单「动作」选中某个动作，或闲置时随机抽到；动作播出的同时说一句'],
  ['trust', '心情差时被关心', '心情 < 50 时点击，替代"点击部位"的那一句'],
  ['drag', '被拎起来', '按住角色拖动时触发（松手前一直显示）'],
  ['balance', '余额播报', '余额跨越档位时，每 300 秒检查一次'],
  ['system', '系统提示', '调整尺寸失败 / 刷新状态 / 点在空白处'],
  ['free', '随机说一句', '「随机说一句」按钮与主动对话共用池子'],
]

/** 组里额外的"何时触发"补充（按组 id 前缀）。 */
const EXTRA = {
  'click-low': '好感 0~1 心',
  'click-mid': '好感 2~3 心',
  'click-high': '好感 4~5 心',
  'idle-fixed': '不依赖好感/心情',
  'idle-affection': '累计解锁：当前等级及以下的组全部参与抽取（等级越高可选越多，早期台词不消失）',
  'idle-mood': '按心情值分低/中/高三档',
  'balance-tier': '按余额区间分 4 档（见每组标题）',
  'system-size-failed': '尺寸写进配置失败时',
  'system-refreshed': '右键「刷新状态」之后',
  'system-click-miss': '点在了透明区域（没点到她身上）',
}

const labelOfAction = (id) => {
  const all = [...RANDOM_ACTIONS, ...MENU_ONLY_ACTIONS, ...PART_ACTIONS]
  return all.find((a) => a.id === id)?.label ?? id
}

/** 静音动作：有意不配台词的动作，列出来让用户决定要不要加。 */
const SILENT = [
  ['stand', '站立（默认姿态）'],
  ['hang', '拖拽悬挂（说话由"被拎起来"负责）'],
  ['head', '摸头互动动画（说话由"点击·头"负责）'],
  ['chest', '摸胸互动动画（说话由"点击·胸"负责）'],
  ['stomach', '戳腹互动动画（说话由"点击·腹"负责）'],
  ['leg', '摸腿互动动画（说话由"点击·腿"负责）'],
  ['sit-circle', '坐姿循环段（说话由"动作·坐下"负责）'],
  ['sit-stop', '站起过渡段（说话由"动作·坐下"负责）'],
  ['think-enter', '深度思考·进入段（用户要求不发声）'],
  ['think-loop', '深度思考·循环段（用户要求不发声）'],
  ['think-exit', '深度思考·退出段（用户要求不发声）'],
]

const L = []
L.push('# 语音库总览（供审查与修改）')
L.push('')
L.push(`> 生成时间：${new Date().toLocaleString('zh-CN', { hour12: false })}　·　`)
L.push(`> 共 **${String(VOICE_GROUPS.length)}** 组 / **${String(VOICE_GROUPS.reduce((n, g) => n + g.lines.length, 0))}** 条台词`)
L.push('')
L.push('## 怎么改（改完直接把这份文件发给我）')
L.push('')
L.push('1. **改台词**：直接改 `1.` `2.` 行后面的文字，**保留行号**；')
L.push('2. **加台词**：在那一组末尾加一行，行号接着往下写（如 `3. 新的一句`）；')
L.push('3. **删台词**：把那一行整行删掉（我可以按缺号识别）；')
L.push('4. **换顺序**：调整行号顺序即可，我会按你写的顺序重排；')
L.push('5. **不要改**：`## 分组标题` 与 `- 触发` 这两行 —— 我用它们定位到库里的哪一组；')
L.push('6. **想给静音动作加台词**：在文末「静音动作」一节里告诉我（例如"坐下循环段也说一句"），我加新组。')
L.push('')
L.push('## 一、分组与台词')
L.push('')

let groupNo = 0
for (const [trigger, title, how] of TRIGGER_DOC) {
  const groups = VOICE_GROUPS.filter((g) => g.trigger === trigger)
  if (groups.length === 0) continue
  L.push(`### ${title}　（${String(groups.length)} 组 / ${String(groups.reduce((n, g) => n + g.lines.length, 0))} 条）`)
  L.push('')
  L.push(`> 统一触发条件：${how}`)
  L.push('')
  for (const g of groups) {
    groupNo += 1
    const extraKey = Object.keys(EXTRA).find((k) => g.id.startsWith(k))
    const extra = extraKey ? EXTRA[extraKey] : ''
    const actionLabel = g.actionId ? `（动作：${labelOfAction(g.actionId)}）` : ''
    L.push(`#### ${String(groupNo)}. ${g.label}　\`${g.id}\`${actionLabel}`)
    L.push(`- 触发：${how}${extra ? `；${extra}` : ''}`)
    L.push('- 台词：')
    g.lines.forEach((line, i) => {
      L.push(`  ${String(i + 1)}. ${line}`)
    })
    L.push('')
  }
}

L.push('## 二、静音动作（有意没有台词）')
L.push('')
L.push('这些动作/段落**不会说话**。如果你想给其中某个加台词，直接告诉我动作名即可。')
L.push('')
L.push('| 动作 id | 说明 |')
L.push('| --- | --- |')
for (const [id, why] of SILENT) L.push(`| \`${id}\` | ${why} |`)
L.push('')

L.push('## 三、统计')
L.push('')
L.push('| 触发条件 | 组数 | 台词数 |')
L.push('| --- | --- | --- |')
for (const [trigger, title] of TRIGGER_DOC) {
  const groups = VOICE_GROUPS.filter((g) => g.trigger === trigger)
  if (groups.length === 0) continue
  L.push(`| ${title} | ${String(groups.length)} | ${String(groups.reduce((n, g) => n + g.lines.length, 0))} |`)
}
L.push('')
L.push(`合计：**${String(VOICE_GROUPS.reduce((n, g) => n + g.lines.length, 0))}** 条（其中信赖语音 ${String(voiceLineCountFor('trust'))} 条）`)
L.push('')

L.push('## 四、本次审查结论（"所有能说话的地方是否都在库里"）')
L.push('')
L.push('查过全部会显示台词的入口，结论如下：')
L.push('')
L.push('| 能说话的地方 | 台词来源 | 在库里？ |')
L.push('| --- | --- | --- |')
L.push('| 右键「动作」选中某个动作 / 闲置随机动作 | `action-*` 组 | ✅ 是 |')
L.push('| 点击身体部位（按好感三档） | `click-*` 组 | ✅ 是 |')
L.push('| 低心情时点击 | `trust` 组 | ✅ 是（见下方说明） |')
L.push('| 拖动角色 | `drag` 组 | ✅ 是 |')
L.push('| 余额跨档播报 | `balance-tier-*` 组 | ✅ 是 |')
L.push('| 调整尺寸失败 / 刷新状态 / 点空白处 | `system-*` 组 | ✅ 是 |')
L.push('| 闲置主动对话 / 右键「对话」/ 随机说一句 | `idle-*` 与 `free-*` 组 | ✅ 是 |')
L.push('| 深度思考三段的动作 | 无台词（用户要求不发声） | ✅ 有意静音 |')
L.push('| 宿主下发的一次性消息 / `say` 指令 | 由宿主提供文本 | ➖ 外部输入，不归库管 |')
L.push('')
L.push('**这次审查发现并修掉的一处例外**：渲染进程里有一句硬编码兜底')
L.push('「（占位·信赖）……哼，我才没有高兴。」—— 主进程没给信赖台词时它会顶上，')
L.push('既不在库里、也改不到。现在改成"没给就不说话"，并加了测试')
L.push('`scripts/dev/test-voice-sources.mjs`：只要有人再往 `showBubble(\'中文…\')` 里写死台词，测试立刻红。')
L.push('')
L.push('> 你问的「吃白饭、玩游戏、坐下、睡觉」四个动作：它们**一直在库里**，')
L.push('> 就是第一节「播放动作」里的 `action-eat` / `action-play-game` / `action-sit` / `action-sleep`，')
L.push('> 只是每组只有 1 句占位台词，所以看起来像"没配"。想加词直接在那组里加行号即可。')
L.push('')

const md = L.join('\n')
mkdirSync(join(ROOT, 'docs'), { recursive: true })
writeFileSync(join(ROOT, 'docs/VOICE-OVERVIEW.md'), md, 'utf8')
writeFileSync(join(ROOT, 'docs/VOICE-OVERVIEW.txt'), md.replace(/^#+\s*/gm, '').replace(/\*\*/g, '').replace(/`/g, ''), 'utf8')
console.log(`  已生成 VOICE-OVERVIEW.md / .txt（${String(VOICE_GROUPS.length)} 组）`)

/* docx：复用更新日志的 md→docx 导出脚本（纯 markdown 到 Word）。 */
try {
  const py = process.env.DSH_PYTHON || 'python'
  execFileSync(py, [
    join(ROOT, 'scripts/dev/export-changelog-docx.py'),
    join(ROOT, 'docs/VOICE-OVERVIEW.md'),
    join(ROOT, 'docs/VOICE-OVERVIEW.docx'),
  ], { stdio: 'ignore' })
  console.log('  已生成 VOICE-OVERVIEW.docx')
} catch (err) {
  console.log(`  （docx 跳过：${err instanceof Error ? err.message : String(err)}）`)
}
