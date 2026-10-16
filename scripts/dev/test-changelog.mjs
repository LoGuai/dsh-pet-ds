/**
 * 检查 `CHANGELOG.md` 是否覆盖了当前版本。
 *
 * ## 为什么需要自动检查
 *
 * 用户明确要求：「此后每次保存新版本都要更新日志」。
 * 但"要记得更新"这种约定**一定会忘** —— 尤其版本号是在 `package.json`
 * 里改的，而日志在另一个文件，两者没有任何机械联系。
 *
 * 所以把约定变成一条可执行的断言：**版本号变了，`CHANGELOG.md` 里就必须
 * 有对应的条目**。它接在 `npm test` 里，忘了就会红。
 *
 * ## 检查什么
 *
 *   1. `CHANGELOG.md` 存在，且是 Keep a Changelog 的形状（有标题 + 版本段）
 *   2. 含形如 `## [<当前版本>]` 的条目
 *   3. 该条目**不是空壳**（下面至少有几行内容，防止写个空标题糊过去）
 *   4. 「未发布」段落是空的（有未归档改动时提醒归档）
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
      '      至少写清「新增 / 变更 / 修复」里适用的一两类。',
  )
})

test('「未发布」段落是空的（本版改动都已归档）', () => {
  const sec = findVersionSection('未发布')
  if (!sec) return
  const rest = meaningfulLines(sec.body)
  assert.equal(
    rest.length,
    0,
    `「未发布」里还有 ${String(rest.length)} 行未归档：\n      ` +
      rest.slice(0, 3).join('\n      ') +
      '\n      发布时应把它们移进对应的版本段。',
  )
})

console.log(`\n结果：${String(passed)}/${String(passed + failed)} 通过`)
if (failed > 0) process.exit(1)
