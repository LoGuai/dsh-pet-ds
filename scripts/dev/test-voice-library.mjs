/**
 * 语音库（`src/shared-core/voice-library.js`）的检查。
 *
 * 本版的重点变了：以前只验"9 个闲置信箱"，现在要验
 * **"所有可触发语音都在库里、并且按触发条件分好了组"**（用户要求）。
 *
 * 覆盖：
 *  1. 结构 —— 每个组都有合法 trigger；各触发条件的组数/条数符合约定；
 *  2. 文案 —— 单句 ≤24 字、全局不重复、不做空组；
 *  3. 可用性 —— 好感/心情/部位/动作/余额档位/场景 的过滤是否正确；
 *  4. 一致性 —— 点击三档的边界与渲染进程同口径；文档与库逐字一致。
 */

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import {
  VOICE_GROUPS,
  VOICE_LINE_MAX_CHARS,
  MOOD_VOICE_MID_MIN,
  MOOD_VOICE_HIGH_MIN,
  CLICK_VOICE_TIERS,
  clickVoiceTier,
  clickPartLines,
  clickPartLinesTable,
  affectionVoiceLevel,
  moodVoiceGroup,
  voiceGroupsFor,
  voiceLinesFor,
  voiceLinesFor as linesFor,
  pickVoiceLineFor,
  voiceLineCount,
  voiceLineCountFor,
  voiceLibrarySummary,
  balanceTierLine,
  systemLine,
  dragLines,
  freeLines,
  actionLines,
  findVoiceGroup,
} from '../../src/shared-core/voice-library.js'
import { DIALOGUE_LINES, pickDialogueLine, dialogueLineCount } from '../../src/shared-core/dialogue.js'
import { balanceTierOf } from '../../src/shared-core/balance-announce.js'
import { buildVoiceDoc } from './gen-voice-doc.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')

let passed = 0
let failed = 0
const test = (name, fn) => {
  try {
    fn()
    passed += 1
    console.log(`  PASS  ${name}`)
  } catch (err) {
    failed += 1
    console.log(`  FAIL  ${name} — ${err.message}`)
  }
}

const TRIGGERS = ['idle', 'click', 'action', 'trust', 'drag', 'balance', 'system', 'free']
const allLines = VOICE_GROUPS.flatMap((g) => g.lines)

// ---------------------------------------------------------------- 结构
test('每个组都有合法的 trigger / id / label，且 id 唯一', () => {
  const ids = new Set()
  for (const g of VOICE_GROUPS) {
    assert.ok(TRIGGERS.includes(g.trigger), `组 ${g.id} 的 trigger 非法：${String(g.trigger)}`)
    assert.ok(!ids.has(g.id), `组 id 重复：${g.id}`)
    ids.add(g.id)
    assert.ok(typeof g.label === 'string' && g.label.length > 0, `组 ${g.id} 缺 label`)
    assert.ok(Array.isArray(g.lines) && g.lines.length > 0, `组 ${g.id} 没有任何台词`)
  }
})

test('八类触发条件都有分组（不会漏掉某类）', () => {
  for (const t of TRIGGERS) {
    assert.ok(voiceLineCountFor(t) > 0, `触发条件 ${t} 一条台词都没有`)
  }
})

test('闲置：1 固定 + 5 好感度 + 3 心情，好感/心情组各 3 条', () => {
  const idle = VOICE_GROUPS.filter((g) => g.trigger === 'idle')
  assert.equal(idle.length, 9)
  assert.equal(idle.filter((g) => g.kind === 'fixed').length, 1)
  assert.deepEqual(
    idle.filter((g) => g.kind === 'affection').map((g) => g.level).sort((a, b) => a - b),
    [1, 2, 3, 4, 5],
  )
  assert.deepEqual(
    idle.filter((g) => g.kind === 'mood').map((g) => g.mood).sort(),
    ['high', 'low', 'mid'],
  )
  /*
   * 固定语音允许 ≥3 条（用户修订版给到 4 条）；
   * 好感度与心情组是"分档"用的，必须**每组正好 3 条** —— 否则档位之间句数不均，
   * 抽到某一档的概率就会偏高。
   */
  for (const g of idle) {
    if (g.kind === 'fixed') {
      assert.ok(g.lines.length >= 3, `${g.id} 至少 3 条，实际 ${String(g.lines.length)}`)
    } else {
      assert.equal(g.lines.length, 3, `${g.id} 应 3 条`)
    }
  }
})

test('点击：4 个部位 × 3 档 = 12 组，每组 2~3 条，且不缺档', () => {
  const click = VOICE_GROUPS.filter((g) => g.trigger === 'click')
  assert.equal(click.length, 12)
  /*
   * 高好感档位允许 3 条（用户修订版给 4~5 心加了第 3 句）；
   * 低/中档仍是 2 条。这里只卡"2~3 条"的范围，避免以后又漂成 1 条或 6 条。
   */
  for (const g of click) {
    assert.ok(
      g.lines.length >= 2 && g.lines.length <= 3,
      `${g.id} 应 2~3 条，实际 ${String(g.lines.length)}`,
    )
  }
  const parts = [...new Set(click.map((g) => g.part))]
  assert.deepEqual(parts.sort(), ['belly', 'chest', 'head', 'leg'])
  for (const part of parts) {
    const tiers = click.filter((g) => g.part === part).map((g) => g.tier).sort()
    assert.deepEqual(tiers, [...CLICK_VOICE_TIERS].sort(), `部位 ${part} 缺档位`)
  }
})

test('动作：5 个动作各一组，且能按动作 id 取到台词', () => {
  /*
   * ⚠️ 这里刻意**不含 think**：用户要求「深度思考动作不再需要任何语音」。
   * 素材自身带"深度求索中…"气泡，应用层再弹一句就是两个气泡叠着。
   * 见下一条断言 —— 它把"think 必须没有台词"钉住，防止以后又加回来。
   */
  const expect = ['awake', 'eat', 'play-game', 'sit', 'sleep']
  for (const id of expect) {
    const lines = actionLines(id)
    assert.ok(lines.length > 0, `动作 ${id} 没有台词`)
  }
})

test('「深度思考」没有台词（用户要求：这个动作不发声）', () => {
  const groups = VOICE_GROUPS.filter((g) => g.trigger === 'action' && g.actionId === 'think')
  assert.equal(groups.length, 0, `think 不应有语音组，实际有 ${String(groups.length)} 个`)
  assert.equal(actionLines('think').length, 0, 'think 不应取到任何台词')
})

test('信赖 3 条、拖拽 ≥2 条、余额 4 档、系统 ≥3 场景、自由对话 ≥10 条', () => {
  assert.equal(voiceLineCountFor('trust'), 3, '信赖语音应 3 条（用户要求）')
  assert.ok(dragLines().length >= 2, '拖拽台词太少')
  for (let tier = 1; tier <= 4; tier += 1) {
    assert.ok(balanceTierLine(tier).length > 0, `余额 ${String(tier)} 档没有短语`)
  }
  for (const scene of ['size-failed', 'refreshed', 'click-miss']) {
    assert.ok(systemLine(scene).length > 0, `系统场景 ${scene} 没有台词`)
  }
  assert.ok(freeLines().length >= 10, '自由对话台词太少')
})

test(`单句不超过 ${String(VOICE_LINE_MAX_CHARS)} 字且非空、无首尾空白`, () => {
  for (const g of VOICE_GROUPS) {
    for (const line of g.lines) {
      assert.ok(typeof line === 'string' && line.trim().length > 0, `${g.id} 有空台词`)
      assert.equal(line, line.trim(), `${g.id} 台词首尾有空白：${JSON.stringify(line)}`)
      assert.ok(
        [...line].length <= VOICE_LINE_MAX_CHARS,
        `${g.id} 的台词 ${String([...line].length)} 字超限：${line}`,
      )
    }
  }
})

test('台词全局无重复（跨组也不能重复）', () => {
  const seen = new Map()
  for (const g of VOICE_GROUPS) {
    for (const line of g.lines) {
      assert.ok(!seen.has(line), `台词重复：${line}（${String(seen.get(line))} 与 ${g.id}）`)
      seen.set(line, g.id)
    }
  }
  assert.equal(seen.size, allLines.length)
})

test('人设：白饭梗出现在至少 3 个组里（贪吃设定）', () => {
  const groupsWithRice = VOICE_GROUPS.filter((g) => g.lines.some((line) => line.includes('白饭')))
  assert.ok(groupsWithRice.length >= 3, `只有 ${String(groupsWithRice.length)} 个组提到白饭`)
})

// ---------------------------------------------------------------- 分档规则
test('affectionVoiceLevel：0 心无专属、1~5 原样、越界按满级', () => {
  assert.equal(affectionVoiceLevel(0), null)
  for (let h = 1; h <= 5; h += 1) assert.equal(affectionVoiceLevel(h), h)
  assert.equal(affectionVoiceLevel(9), 5)
  assert.equal(affectionVoiceLevel(-1), null)
  assert.equal(affectionVoiceLevel(Number.NaN), null)
})

test('moodVoiceGroup：3 档边界与非法值', () => {
  assert.equal(moodVoiceGroup(0), 'low')
  assert.equal(moodVoiceGroup(MOOD_VOICE_MID_MIN - 1), 'low')
  assert.equal(moodVoiceGroup(MOOD_VOICE_MID_MIN), 'mid')
  assert.equal(moodVoiceGroup(MOOD_VOICE_HIGH_MIN - 1), 'mid')
  assert.equal(moodVoiceGroup(MOOD_VOICE_HIGH_MIN), 'high')
  assert.equal(moodVoiceGroup(Number.NaN), 'mid')
})

test('clickVoiceTier：0,1 → low；2,3 → mid；4,5 → high', () => {
  assert.equal(clickVoiceTier(0), 'low')
  assert.equal(clickVoiceTier(1), 'low')
  assert.equal(clickVoiceTier(2), 'mid')
  assert.equal(clickVoiceTier(3), 'mid')
  assert.equal(clickVoiceTier(4), 'high')
  assert.equal(clickVoiceTier(5), 'high')
})

// ---------------------------------------------------------------- 可用性过滤
test('闲置：可用组 = 固定 + 累计解锁的好感度组 + 当前心情组', () => {
  /*
   * 好感度语音是**累计解锁**，不是按等级替换（用户要求：
   * 「低于当前好感值等级组的语音也可以触发，改为随等级解锁新增语音，而不是替换」）。
   * 所以 3 心时 Lv1/Lv2/Lv3 三组都在池里。
   */
  const cases = [
    { hearts: 0, moodValue: 10, expect: ['idle-fixed', 'idle-mood-low'] },
    { hearts: 0, moodValue: 60, expect: ['idle-fixed', 'idle-mood-mid'] },
    { hearts: 1, moodValue: 90, expect: ['idle-fixed', 'idle-affection-1', 'idle-mood-high'] },
    {
      hearts: 3,
      moodValue: 30,
      expect: ['idle-fixed', 'idle-affection-1', 'idle-affection-2', 'idle-affection-3', 'idle-mood-low'],
    },
    {
      hearts: 5,
      moodValue: 100,
      expect: [
        'idle-fixed',
        'idle-affection-1',
        'idle-affection-2',
        'idle-affection-3',
        'idle-affection-4',
        'idle-affection-5',
        'idle-mood-high',
      ],
    },
  ]
  for (const c of cases) {
    const ids = voiceGroupsFor('idle', { hearts: c.hearts, moodValue: c.moodValue }).map((g) => g.id)
    assert.deepEqual(ids, c.expect, `hearts=${String(c.hearts)} mood=${String(c.moodValue)}`)
  }
})

test('好感度语音累计解锁：等级越高可选句数只增不减', () => {
  let previous = -1
  for (let h = 0; h <= 5; h += 1) {
    const n = voiceLinesFor('idle', { hearts: h, moodValue: 60 }).length
    assert.ok(n >= previous, `${String(h)} 心的可选句数 ${String(n)} 比上一档 ${String(previous)} 还少`)
    previous = n
  }
  // 5 心时应当包含所有 5 组好感度台词，而不只是 Lv5
  const lv5 = VOICE_GROUPS.filter((g) => g.kind === 'affection')
  const pool = new Set(voiceLinesFor('idle', { hearts: 5, moodValue: 60 }))
  for (const g of lv5) {
    for (const line of g.lines) assert.ok(pool.has(line), `5 心时缺了 ${g.id} 的台词：${line}`)
  }
})

test('点击：按部位 + 好感度档位取台词', () => {
  assert.deepEqual(clickPartLines('head', 0), clickPartLines('head', 1))
  assert.deepEqual(clickPartLines('head', 2), clickPartLines('head', 3))
  assert.deepEqual(clickPartLines('head', 4), clickPartLines('head', 5))
  assert.notDeepEqual(clickPartLines('head', 0), clickPartLines('head', 5), '高低档台词不该相同')
  for (const part of ['head', 'chest', 'belly', 'leg']) {
    for (let h = 0; h <= 5; h += 1) {
      /*
       * 2~3 句：用户修订版给 4~5 心档每个部位加了第 3 句，
       * 低/中档仍是 2 句。这里卡范围而不是写死 2，免得下次加词又要改测试。
       */
      const n = clickPartLines(part, h).length
      assert.ok(n >= 2 && n <= 3, `${part}@${String(h)} 心应有 2~3 句，实际 ${String(n)}`)
    }
  }
})

test('点击三档整表齐全（主进程下发给渲染进程的就是它）', () => {
  const table = clickPartLinesTable()
  for (const part of ['head', 'chest', 'belly', 'leg']) {
    assert.ok(table[part], `表里缺部位 ${part}`)
    for (const tier of CLICK_VOICE_TIERS) {
      // 2~3 句：用户修订版给 4~5 心档加了第 3 句，低/中档仍是 2 句。
      const n = (table[part][tier] ?? []).length
      assert.ok(n >= 2 && n <= 3, `${part}.${tier} 应有 2~3 句，实际 ${String(n)}`)
    }
  }
})

test('动作 / 余额 / 系统 / 拖拽 都能按条件取到且不串台', () => {
  /*
   * 动作台词换成了用户修订版（原先只有一句"（占位）…"）。
   * 这里**不再写死具体句子** —— 那是内容，不是规则；写死会导致
   * 每次用户改词都要改测试。只断言"能取到、且确实来自该组的 lines"。
   */
  for (const id of ['eat', 'play-game', 'sit', 'sleep', 'awake']) {
    const got = actionLines(id)
    assert.ok(got.length >= 1, `动作 ${id} 取不到台词`)
    const group = VOICE_GROUPS.find((g) => g.trigger === 'action' && g.actionId === id)
    assert.deepEqual(got, group.lines, `动作 ${id} 取到的台词与库里不一致`)
  }
  assert.equal(actionLines('不存在的动作').length, 0)
  // 余额档位：与 balance-announce 的分档一致
  assert.equal(balanceTierOf(5).line, balanceTierLine(1))
  assert.equal(balanceTierOf(15).line, balanceTierLine(2))
  assert.equal(balanceTierOf(30).line, balanceTierLine(3))
  assert.equal(balanceTierOf(99).line, balanceTierLine(4))
  // 系统场景互不串台
  assert.notEqual(systemLine('size-failed'), systemLine('refreshed'))
  assert.equal(systemLine('不存在的场景'), '')
})

test('抽取永远落在当前可用的池里（多状态各抽 200 次）', () => {
  for (const hearts of [0, 2, 5]) {
    for (const moodValue of [10, 60, 95]) {
      const pool = new Set(voiceLinesFor('idle', { hearts, moodValue }))
      for (let i = 0; i < 200; i += 1) {
        const line = pickVoiceLineFor('idle', { hearts, moodValue })
        assert.ok(pool.has(line), `抽到池外台词：${line}`)
      }
    }
  }
  const clickPool = new Set(clickPartLines('head', 0))
  for (let i = 0; i < 100; i += 1) {
    const line = pickVoiceLineFor('click', { part: 'head', hearts: 0 })
    assert.ok(clickPool.has(line), `点击抽到池外台词：${line}`)
  }
})

test('避重：池里还有别的句子时，不会连着抽到同一句', () => {
  const avoid = clickPartLines('head', 5)[0]
  for (let i = 0; i < 100; i += 1) {
    const line = pickVoiceLineFor('click', { part: 'head', hearts: 5, avoidLine: avoid })
    assert.notEqual(line, avoid)
  }
})

test('voiceLibrarySummary 与 VOICE_GROUPS 一致，且带 trigger 与可用条件', () => {
  const summary = voiceLibrarySummary()
  assert.equal(summary.length, VOICE_GROUPS.length)
  for (let i = 0; i < summary.length; i += 1) {
    assert.equal(summary[i].id, VOICE_GROUPS[i].id)
    assert.equal(summary[i].trigger, VOICE_GROUPS[i].trigger)
    assert.deepEqual(summary[i].lines, VOICE_GROUPS[i].lines)
    assert.ok(typeof summary[i].condition === 'string')
  }
  assert.ok(findVoiceGroup('trust'), '按 id 找得到 trust 组')
  assert.equal(findVoiceGroup('不存在的组'), null)
})

// ---------------------------------------------------------------- 与旧模块的一致性
test('dialogue.js 已成为语音库的门面（台词来自 free 组）', () => {
  assert.deepEqual([...DIALOGUE_LINES].sort(), [...freeLines()].sort(), '对话库应与 free 组一致')
  assert.equal(dialogueLineCount(), freeLines().length)
  const picked = pickDialogueLine(() => 0, null)
  assert.ok(freeLines().includes(picked), '抽到的句子应来自 free 组')
})

test('台词总数与分项之和一致', () => {
  const sum = TRIGGERS.reduce((acc, t) => acc + voiceLineCountFor(t), 0)
  assert.equal(sum, voiceLineCount())
})

// ---------------------------------------------------------------- 文档同步
test('VOICE-LIBRARY.md 与库逐字一致（文档是生成的）', () => {
  const doc = join(ROOT, 'VOICE-LIBRARY.md')
  assert.ok(existsSync(doc), '缺 VOICE-LIBRARY.md —— 运行 node scripts/dev/gen-voice-doc.mjs')
  assert.equal(
    readFileSync(doc, 'utf8') === buildVoiceDoc(),
    true,
    'VOICE-LIBRARY.md 与语音库不一致 —— 运行 node scripts/dev/gen-voice-doc.mjs',
  )
})

test('文档里列出了每一句台词与每个触发条件', () => {
  const doc = readFileSync(join(ROOT, 'VOICE-LIBRARY.md'), 'utf8')
  for (const t of TRIGGERS) assert.ok(doc.includes(`\`${t}\``), `文档缺触发条件 ${t}`)
  for (const g of VOICE_GROUPS) {
    for (const line of g.lines) assert.ok(doc.includes(line), `文档缺这句：${line}（${g.id}）`)
  }
})

console.log(`\n结果：${String(passed)}/${String(passed + failed)} 通过`)
if (failed > 0) process.exit(1)
