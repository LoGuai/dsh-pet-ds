/**
 * 对话台词库的单元测试。
 *
 * 为什么值得单测：这批文案是**按人设手写的真台词**（不是占位符），
 * 一旦有人加了空串、重复句、或长得会撑爆气泡的一句，
 * 表现是"点了「对话」没反应/蹦出同一句/气泡换行顶到角色"——
 * 从现象很难反推到具体哪一句，所以在数据层就钉住。
 *
 * 运行：node scripts/dev/test-dialogue.mjs
 */

import assert from 'node:assert/strict'

import {
  DIALOGUE_LINES,
  dialogueLineCount,
  pickDialogueLine,
} from '../../src/shared-core/dialogue.js'

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

/** 一律按**字符数**（码点）算，避免把中文按 UTF-16 长度算错。 */
const charLen = (s) => [...s].length

// ---------------------------------------------------------------- 数据本身

test('台词库有足够多句（至少 8 句，否则很快就听腻）', () => {
  assert.ok(dialogueLineCount() >= 8, `只有 ${String(dialogueLineCount())} 句`)
})

test('没有空串或纯空白句', () => {
  for (const line of DIALOGUE_LINES) {
    assert.equal(typeof line, 'string')
    assert.ok(line.trim().length > 0, `存在空台词：${JSON.stringify(line)}`)
    assert.equal(line, line.trim(), `台词首尾不该有空白：${JSON.stringify(line)}`)
  }
})

test('没有重复句（重复会让"随机"看起来像卡住）', () => {
  const seen = new Set()
  for (const line of DIALOGUE_LINES) {
    assert.ok(!seen.has(line), `重复台词：${JSON.stringify(line)}`)
    seen.add(line)
  }
})

test('每句都不超过 20 字（气泡会随桌宠缩放，太长会换行撑高）', () => {
  /*
   * 气泡宽度与桌宠等比缩放，长句会折行、把气泡区顶高。
   * 20 字是实测在最小档（140 宽）下仍能单行显示的上限附近，留点余量取 20。
   */
  for (const line of DIALOGUE_LINES) {
    assert.ok(charLen(line) <= 20, `过长（${String(charLen(line))} 字）：${line}`)
  }
})

test('没有遗留的占位符标记', () => {
  // 其它台词的占位符写法是 `（占位·xx）…`；对话库是真台词，不该混进去。
  for (const line of DIALOGUE_LINES) {
    assert.ok(!line.includes('占位'), `对话库里混进了占位符：${line}`)
  }
})

// ---------------------------------------------------------------- 取用逻辑

test('pickDialogueLine 从库里取，不凭空造句子', () => {
  for (let i = 0; i < 200; i += 1) {
    const line = pickDialogueLine()
    assert.ok(DIALOGUE_LINES.includes(line), `取到了库外的句子：${JSON.stringify(line)}`)
  }
})

test('pickDialogueLine 会避开上一句', () => {
  /*
   * 连点两次「对话」蹦出同一句，看起来像没生效 —— 所以要避重。
   * 用注入的随机源逐句验证：对库里每一句都试一次，结果都不该等于它。
   */
  for (const avoid of DIALOGUE_LINES) {
    for (let i = 0; i < 20; i += 1) {
      const line = pickDialogueLine(Math.random, avoid)
      assert.notEqual(line, avoid, `避重失效：仍然取到了 ${JSON.stringify(avoid)}`)
    }
  }
})

test('避重是确定性的：注入相同随机源应稳定避开', () => {
  const avoid = DIALOGUE_LINES[0]
  const a = pickDialogueLine(() => 0, avoid)
  const b = pickDialogueLine(() => 0, avoid)
  assert.equal(a, b, '同一随机源应取到同一句')
  assert.notEqual(a, avoid)
})

test('avoidLine 不在库里时等价于不避重', () => {
  const line = pickDialogueLine(() => 0, '这句不在库里')
  assert.ok(DIALOGUE_LINES.includes(line))
})

test('多次取用能覆盖到多句（不是永远同一句）', () => {
  const seen = new Set()
  let last = null
  for (let i = 0; i < 300; i += 1) {
    last = pickDialogueLine(Math.random, last)
    seen.add(last)
  }
  // 300 次足够覆盖全部 15 句；给个宽松下限防止偶发。
  assert.ok(seen.size >= DIALOGUE_LINES.length - 2, `只覆盖了 ${String(seen.size)} 句`)
})

test('dialogueLineCount 与实际条数一致', () => {
  assert.equal(dialogueLineCount(), DIALOGUE_LINES.length)
})

console.log(`\n结果：${String(passed)}/${String(passed + failed)} 通过`)
if (failed > 0) process.exit(1)
