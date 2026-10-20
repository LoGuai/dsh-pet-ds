/**
 * 把用户修订过的 VOICE-OVERVIEW.md 应用回语音库。
 *
 * 输入：用户回传的总览文件（默认桌面上的那一份）
 * 做法：
 *  1. 按 `#### N. 标题　\`分组 id\`` 切组，组内 `1. 台词` 依次收集；
 *  2. **不信任文件里的小标题计数**（用户加行后那些数字会过期），
 *     一律按实际台词行重算；
 *  3. 校验：id 必须存在、不能空组、单句不超上限、全局不重复；
 *  4. 按组 id 重写 `voice-library.js` 里该组的 `lines: [...]`，其它内容一字不动。
 *
 * 用法：node scripts/dev/apply-voice-overview.mjs <总览.md>
 */
import { readFileSync, writeFileSync } from 'node:fs'

import { VOICE_GROUPS, VOICE_LINE_MAX_CHARS } from '../../src/shared-core/voice-library.js'

const ROOT = 'D:/dsh/pet'
const SRC = `${ROOT}/src/shared-core/voice-library.js`
const input = process.argv[2] ?? 'D:/dsh/pet/docs/VOICE-OVERVIEW.md'

/* ---------- 1) 解析 ---------- */
const text = readFileSync(input, 'utf8')
const lines = text.split('\n')
const parsed = new Map()
let current = null
for (const raw of lines) {
  const head = /^####\s+\d+\.\s+(.*?)\s+`([a-z0-9-]+)`/.exec(raw)
  if (head) {
    current = { id: head[2], label: head[1], lines: [] }
    parsed.set(current.id, current)
    continue
  }
  if (/^#{1,4}\s/.test(raw)) {
    // 换到其它小节（静音动作 / 统计 / 审查结论）就停止收集
    if (!/^####/.test(raw)) current = null
    continue
  }
  if (!current) continue
  const item = /^\s+\d+\.\s+(.+?)\s*$/.exec(raw)
  if (item) current.lines.push(item[1])
}

/* ---------- 2) 校验 ---------- */
const problems = []
const known = new Set(VOICE_GROUPS.map((g) => g.id))
for (const [id, g] of parsed) {
  if (!known.has(id)) problems.push(`未知分组 id：${id}`)
  if (g.lines.length === 0) problems.push(`${id} 没有任何台词`)
  for (const line of g.lines) {
    if (line !== line.trim()) problems.push(`${id} 有首尾空白：${JSON.stringify(line)}`)
    if ([...line].length > VOICE_LINE_MAX_CHARS) {
      problems.push(`${id} 台词 ${String([...line].length)} 字超上限 ${String(VOICE_LINE_MAX_CHARS)}：${line}`)
    }
  }
}
const all = [...parsed.values()].flatMap((g) => g.lines)
const dupes = all.filter((l, i) => all.indexOf(l) !== i)
if (dupes.length) problems.push(`台词重复：${[...new Set(dupes)].join(' / ')}`)
const missing = [...known].filter((id) => !parsed.has(id))
if (missing.length) problems.push(`总览里缺少这些分组：${missing.join(', ')}`)

if (problems.length) {
  console.error(`  ✗ 有 ${String(problems.length)} 处问题，未改动源码：`)
  for (const p of problems) console.error(`    · ${p}`)
  process.exit(1)
}

/* ---------- 3) 重写源码里的 lines ---------- */
let src = readFileSync(SRC, 'utf8')
let changed = 0
for (const [id, g] of parsed) {
  const old = VOICE_GROUPS.find((x) => x.id === id)
  const before = JSON.stringify(old.lines)
  const after = JSON.stringify(g.lines)
  if (before === after) continue

  // 定位该组对象：`id: 'xxx',` 之后、下一个 `lines: [` … `]` 之间的内容
  const idAt = src.indexOf(`id: '${id}',`)
  if (idAt < 0) {
    console.error(`  ✗ 源码里找不到分组 ${id}`)
    process.exit(1)
  }
  const linesAt = src.indexOf('lines: [', idAt)
  const endAt = src.indexOf(']', linesAt)
  if (linesAt < 0 || endAt < 0) {
    console.error(`  ✗ 分组 ${id} 找不到 lines 数组`)
    process.exit(1)
  }
  const body = g.lines.map((line) => `      '${line.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}',`).join('\n')
  const replacement = `lines: [\n${body}\n    ]`
  src = src.slice(0, linesAt) + replacement + src.slice(endAt + 1)
  changed += 1
  console.log(`  ✓ ${id}：${String(old.lines.length)} 条 → ${String(g.lines.length)} 条`)
}

writeFileSync(SRC, src, 'utf8')
const total = [...parsed.values()].reduce((n, g) => n + g.lines.length, 0)
console.log(`\n  共 ${String(parsed.size)} 组 / ${String(total)} 条；实际改动 ${String(changed)} 组`)
