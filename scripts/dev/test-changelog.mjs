/**
 * 检查 `CHANGELOG.md` 是否覆盖了当前版本。
 *
 * ## 约定（用户指定，2026-10-16 修订）
 *
 *   1. **每次改动都要记到「未发布」段里** —— 实时记录，不攒到最后。
 *   2. **版本号只在用户明确要求时才改**。
 *   3. 不主动输出安装包。
 *
 * 所以本检查只做一件事：**一旦版本号变了，就必须有对应的版本段**。
 * 它不要求「未发布」为空 —— 恰恰相反，改动就该待在那里直到发布。
 *
 * （我第一版写成了"未发布必须为空"，那是按 Keep a Changelog 的发布流程
 *   想当然写的，与用户的实际工作方式相反。改掉。）
 *
 * 刻意**不**检查内容质量（那没法机械化），只检查"有没有"。
 * 质量靠人来保证，机械检查负责把人叫回来。
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const CHANGELOG = join(ROOT, 'CHANGELOG.md')

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`PASS  ${name}`)
  } catch (err) {
    failed += 1
    console.log(`FAIL  ${name}`)
    console.log(`      ${err instanceof Error ? err.message : String(err)}`)
  }
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const version = pkg.version

const exists = existsSync(CHANGELOG)
const text = exists ? readFileSync(CHANGELOG, 'utf8') : ''
const lines = text.split(/\r?\n/)

/**
 * 找一个版本段。同时接受：
 *   `## [0.1.4] - 2026-10-16`
 *   `## [0.1.4]`              （没写日期也认，不值得为格式红）
 *   `## [0.1.3-fix] - ...`    （带连字符）
 *
 * @returns {{idx: number, head: string, body: string} | null}
 */
function findVersionSection(v) {
  const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`^##\\s*\\[${escaped}\\]`, 'i')
  const idx = lines.findIndex((l) => re.test(l))
  if (idx < 0) return null
  const body = []
  for (let i = idx + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break
    body.push(lines[i])
  }
  return { idx, head: lines[idx], body: body.join('\n') }
}

/** 段正文里"算内容"的行（剔除版式：空行、分隔线、HTML 注释、占位）。 */
function meaningfulLines(body) {
  return body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => {
      if (!l) return false
      if (l === '---') return false
      if (l.startsWith('<!--')) return false
      if (/^[（(]?\s*暂无\s*[)）]?$/.test(l)) return false
      return true
    })
}

// ---------------------------------------------------------------- 断言

test('CHANGELOG.md 存在', () => {
  assert.ok(exists, '缺 CHANGELOG.md —— 每个版本都要在它里面留条目')
})

test('CHANGELOG.md 有 Keep a Changelog 的标题', () => {
  assert.match(lines[0] ?? '', /^#\s+更新日志/, '第一行应是 `# 更新日志`')
})

test('CHANGELOG.md 有「未发布」段落（用来先记未归档的改动）', () => {
  assert.ok(
    lines.some((l) => /^##\s*\[未发布\]/.test(l)),
    '应有 `## [未发布]` 段落',
  )
})

test(`CHANGELOG.md 含当前版本的条目（${version}）`, () => {
  const sec = findVersionSection(version)
  assert.ok(
    sec,
    `找不到 \`## [${version}]\` 段落。\n` +
      '      改了 package.json 的版本号，就必须在 CHANGELOG.md 里加一段说明。\n' +
      '      参考同目录的 RELEASE-NOTES-v<版本>.md 写要点。',
  )
})

test(`当前版本条目（${version}）不是空壳`, () => {
  const sec = findVersionSection(version)
  if (!sec) return /* 上一条已报过，这里不重复报错 */
  const n = meaningfulLines(sec.body).length
  assert.ok(
    n >= 3,
    `\`${sec.head}\` 下面只有 ${String(n)} 行有效内容，太少了。\n` +
      '      至少写清「新增 / 修复」里适用的一两类。',
  )
})

/*
 * 行文风格（用户指定：「写简洁一点，就分条列举…每条用一句话表述」，
 * 并要求「以后的更新日志都要这么写」）。
 *
 * 只检查**当前版本段**与「未发布」段，不检查历史版本 ——
 * 老版本段是既成事实，改成新风格只会篡改历史。
 *
 * 三条规则：
 *  1. 小节只允许 `### 新增` / `### 修复`（不要 `变更`/`备注`/`####` 细分）；
 *  2. 每个要点一行、不超过 MAX_BULLET 字；
 *  3. 至少各有一条 —— 空小节说明没按两类组织。
 *
 * 为什么上限取 150 字：一句话讲清"加了什么"通常 40~80 字；
 * 超过 150 基本就是在写推理过程或贴日志，那属于 RELEASE-NOTES。
 */
const MAX_BULLET = 150

test(`当前版本条目（${version}）符合约定行文：只分「新增/修复」、一条一句话`, () => {
  const sec = findVersionSection(version)
  if (!sec) return

  /* 注意：`findVersionSection` 里的 body 是**字符串**，这里按行拆开用。 */
  const bodyLines = sec.body.split(/\r?\n/)

  const heads = bodyLines
    .filter((l) => /^### /.test(l))
    .map((l) => l.trim())
  const badHeads = heads.filter((h) => h !== '### 新增' && h !== '### 修复')
  assert.deepEqual(
    badHeads,
    [],
    `\`${sec.head}\` 里出现了不该有的小节：${badHeads.join('、')}。\n` +
      '      约定只写 `### 新增` 与 `### 修复` 两节（细节放 RELEASE-NOTES）。',
  )
  assert.ok(heads.includes('### 新增'), `\`${sec.head}\` 缺少 \`### 新增\` 小节`)
  assert.ok(heads.includes('### 修复'), `\`${sec.head}\` 缺少 \`### 修复\` 小节`)

  const deep = bodyLines.filter((l) => /^####/.test(l))
  assert.deepEqual(deep, [], '不要用 `####` 再细分 —— 一条一句话列在 `###` 小节下即可')

  const bullets = bodyLines.filter((l) => /^- /.test(l))
  assert.ok(bullets.length >= 2, `\`${sec.head}\` 的要点太少（${String(bullets.length)} 条）`)

  const tooLong = bullets.filter((l) => l.length > MAX_BULLET)
  assert.deepEqual(
    tooLong.map((l) => `${l.slice(0, 40)}…（${String(l.length)} 字）`),
    [],
    `每条要点请控制在一句话内（≤ ${String(MAX_BULLET)} 字）；`
      + '把推理过程/日志/对比表挪到 RELEASE-NOTES-v<版本>.md。',
  )
})

/*
 * 刻意**没有**"「未发布」必须为空"这条断言。
 *
 * 我第一版写了它（照 Keep a Changelog 的发布流程想当然），但与用户的实际
 * 工作方式相反：用户要求**每次改动就实时记进「未发布」**，发布时才归档。
 * 一个有内容的「未发布」段是**正常工作状态**，不是错误。
 *
 * 因此这里只提醒、不判失败 —— 把段落情况打印出来，便于人扫一眼。
 */
{
  const sec = findVersionSection('未发布')
  const n = sec ? meaningfulLines(sec.body).length : 0
  console.log(
    n === 0
      ? 'INFO   「未发布」段是空的（没有未归档的改动）'
      : `INFO   「未发布」段有 ${String(n)} 行待发布内容（正常：发布时才归档成版本段）`,
  )
  passed += 1 /* 计入通过，避免结果行看起来像少了什么 */
}

console.log(`\n结果：${String(passed)}/${String(passed + failed)} 通过`)
if (failed > 0) process.exit(1)
