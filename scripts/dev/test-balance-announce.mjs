/**
 * 余额变动播报的单元测试。
 *
 * 重点覆盖**分档的每个临界值**与三种差值情形（花掉 / 充值 / 不变）——
 * 这些靠肉眼点界面很难验，而分档错一档就会说错话（把"余额告急了"说成"还很充裕"）。
 *
 * 运行：node scripts/dev/test-balance-announce.mjs
 */

import assert from 'node:assert/strict'

import {
  BALANCE_TIERS,
  balanceTierOf,
  buildBalanceAnnouncement,
  formatMoney,
  shouldAnnounceBalance,
} from '../../src/shared-core/balance-announce.js'

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

// ---------------------------------------------------------------- 分档

test('四档台词与用户给定的一致', () => {
  assert.deepEqual(
    BALANCE_TIERS.map((t) => t.line),
    ['余额告急了', '有些吃紧', '还很充裕', '主人太有钱了'],
  )
})

test('分档边界：10 / 20 / 50 三个临界值归属正确', () => {
  /*
   * 用户原话里 10 与 20 各被两个档位同时提到（"<10 / 10~20"、"10~20 / 20~50"），
   * 所以实现取**左闭右开**：10 → 2 档、20 → 3 档、50 → 4 档。
   * 这条测试把这个选择钉死，避免以后有人"顺手"改成右闭。
   */
  assert.equal(balanceTierOf(10).tier, 2, '10 属 2 档（有些吃紧）')
  assert.equal(balanceTierOf(20).tier, 3, '20 属 3 档（还很充裕）')
  assert.equal(balanceTierOf(50).tier, 4, '50 属 4 档（主人太有钱了）')
})

test('分档边界：每个临界值的左右两侧', () => {
  assert.equal(balanceTierOf(9.99).tier, 1)
  assert.equal(balanceTierOf(19.99).tier, 2)
  assert.equal(balanceTierOf(49.99).tier, 3)
  assert.equal(balanceTierOf(0).tier, 1)
  assert.equal(balanceTierOf(0.01).tier, 1)
  assert.equal(balanceTierOf(1000).tier, 4)
})

test('分档容错：非法输入当作 0（最低档）', () => {
  for (const bad of [Number.NaN, null, undefined, 'abc']) {
    assert.equal(balanceTierOf(bad).tier, 1, `${String(bad)} 应当回落 1 档`)
  }
})

test('无穷大/NaN 统一按 0 处理（都回落最低档）', () => {
  /*
   * 这条是**记录当前行为**，不是"希望它这样"。
   *
   * 实现里第一句就是 `const v = Number.isFinite(remaining) ? remaining : 0`，
   * 所以正负无穷和 NaN 一视同仁地被压成 0 → 都落 1 档。
   *
   * ⚠️ 我连着把这条预期写错两次：
   *   第一次把 Infinity 和 NaN 并列当"非法输入"却断言回落 1 档，
   *   随后又"想当然"地断言 Infinity 会穿过所有上界落到最高档 ——
   *   忘了实现开头那句 isFinite 守卫。两次都是预期错、实现对。
   * 记在这里，免得将来又按直觉改测试。
   */
  assert.equal(balanceTierOf(Number.POSITIVE_INFINITY).tier, 1)
  assert.equal(balanceTierOf(Number.NEGATIVE_INFINITY).tier, 1)
  assert.equal(balanceTierOf(Number.NaN).tier, 1)
})

// ---------------------------------------------------------------- 金额格式化

test('金额格式化去掉多余尾零', () => {
  assert.equal(formatMoney('18.00'), '18')
  assert.equal(formatMoney(5), '5')
  assert.equal(formatMoney(5.5), '5.5')
  assert.equal(formatMoney(5.55), '5.55')
  assert.equal(formatMoney('23.40'), '23.4')
})

test('金额格式化消除浮点尾巴', () => {
  // 0.1 + 0.2 = 0.30000000000000004
  assert.equal(formatMoney(0.1 + 0.2), '0.3')
  /*
   * ⚠️ 这里**不是** "1.005 应该进位成 1.01"。
   *
   * JS 里 `1.005` 实际存的是 `1.00499999999999989...`，乘 100 得 100.4999...，
   * 所以 `Math.round` 得 100 → 结果是 `1`。这是 IEEE754 的正常行为，
   * 不是实现缺陷 —— 我一开始把预期写成 `1.01`，是预期错了。
   *
   * 对余额场景也无影响：接口返回的本来就是两位小数的字符串
   * （`"23.45"`），不存在"需要从三位小数进位"的情况。
   */
  assert.equal(formatMoney(1.005), '1', 'IEEE754：1.005 实际略小于 1.005')
  // 真正需要两位精度的值照常正确。
  assert.equal(formatMoney(23.456), '23.46')
  assert.equal(formatMoney(23.454), '23.45')
})

test('金额格式化容错：非法输入当 0', () => {
  assert.equal(formatMoney(null), '0')
  assert.equal(formatMoney('abc'), '0')
  assert.equal(formatMoney(Number.NaN), '0')
})

// ---------------------------------------------------------------- 播报内容

test('花掉余额：spent 为正，句子含花掉与剩余', () => {
  const r = buildBalanceAnnouncement({ prevTotal: 28.45, nextTotal: 23.45 })
  assert.equal(r.kind, 'spent')
  assert.equal(r.spent, 5)
  assert.equal(r.remaining, 23.45)
  assert.equal(r.tier, 3)
  assert.equal(r.text, '刚才花掉了¥5，还有¥23.45，还很充裕。')
})

test('充值（余额变多）绝不算作消耗', () => {
  /*
   * 这是最容易写错的一条：差值 = next - prev 为**正**，
   * 若直接取绝对值播报，就会说成"花掉了 ¥50" —— 与事实完全相反。
   * 实现上只统计下降，上涨一律记 0。
   */
  const r = buildBalanceAnnouncement({ prevTotal: 10, nextTotal: 60 })
  assert.equal(r.kind, 'toppedUp')
  assert.equal(r.spent, 0, '充值不是消耗')
  assert.equal(r.remaining, 60)
  assert.equal(r.tier, 4)
  assert.ok(r.text.includes('花掉了¥0'), `句子里的消耗应为 0：${r.text}`)
  assert.ok(r.text.includes('主人太有钱了'))
})

test('余额不变：spent 为 0，档位照常算', () => {
  const r = buildBalanceAnnouncement({ prevTotal: 10, nextTotal: 10 })
  assert.equal(r.kind, 'same')
  assert.equal(r.spent, 0)
  assert.equal(r.tier, 2)
  assert.equal(r.text, '刚才花掉了¥0，还有¥10，有些吃紧。')
})

test('首次取数（没有上一次）：spent 为 0', () => {
  const r = buildBalanceAnnouncement({ prevTotal: null, nextTotal: 8 })
  assert.equal(r.spent, 0)
  assert.equal(r.remaining, 8)
  assert.equal(r.tier, 1)
  assert.equal(r.text, '刚才花掉了¥0，还有¥8，余额告急了。')
})

test('四档各生成一次完整句子', () => {
  const cases = [
    { next: 5, tier: 1, line: '余额告急了' },
    { next: 15, tier: 2, line: '有些吃紧' },
    { next: 30, tier: 3, line: '还很充裕' },
    { next: 80, tier: 4, line: '主人太有钱了' },
  ]
  for (const c of cases) {
    const r = buildBalanceAnnouncement({ prevTotal: c.next + 3, nextTotal: c.next })
    assert.equal(r.tier, c.tier)
    assert.equal(r.line, c.line)
    assert.equal(r.text, `刚才花掉了¥3，还有¥${String(c.next)}，${c.line}。`)
  }
})

test('小数金额的句子读起来正常（不留 .00 尾巴）', () => {
  const r = buildBalanceAnnouncement({ prevTotal: 12.5, nextTotal: 7.25 })
  assert.equal(r.spent, 5.25)
  assert.equal(r.text, '刚才花掉了¥5.25，还有¥7.25，余额告急了。')
})

test('美元账户用 $ 符号', () => {
  const r = buildBalanceAnnouncement({ prevTotal: 10, nextTotal: 5, currency: 'USD' })
  assert.ok(r.text.includes('$5'), r.text)
})

test('消耗为 0 但余额极低时，档位仍如实反映余额', () => {
  const r = buildBalanceAnnouncement({ prevTotal: 3, nextTotal: 3 })
  assert.equal(r.spent, 0)
  assert.equal(r.tier, 1)
  assert.ok(r.text.includes('余额告急了'))
})

test('非法 nextTotal 不产生 NaN 句子', () => {
  const r = buildBalanceAnnouncement({ prevTotal: 10, nextTotal: Number.NaN })
  assert.ok(!r.text.includes('NaN'), `句子里不该出现 NaN：${r.text}`)
  assert.equal(r.remaining, 0)
  assert.equal(r.tier, 1)
})

// ---------------------------------------------------------------- 播不播（用户要求）

/*
 * 用户要求："如果 5 分钟内没有余额变化，则不播放提示。"
 *
 * 这组用例守住"桌宠不会变成复读机" —— 5 分钟的刷新周期里，
 * 小额使用时余额经常一动不动，每次都播"花掉了¥0"纯属干扰。
 */
test('余额没变 → 不播报（reason=unchanged）', () => {
  const v = shouldAnnounceBalance({ prevTotal: 68.49, nextTotal: 68.49 })
  assert.equal(v.announce, false)
  assert.equal(v.reason, 'unchanged')
})

test('余额变少 → 播报（reason=spent）', () => {
  const v = shouldAnnounceBalance({ prevTotal: 68.49, nextTotal: 67.82 })
  assert.equal(v.announce, true)
  assert.equal(v.reason, 'spent')
})

test('余额变多（充值）→ 也要播报（reason=toppedUp）', () => {
  /*
   * ⚠️ 这条容易写错：充值时 `spent` 是 0，若判据写成 `spent > 0` 就会被静默跳过 ——
   * 于是"钱怎么突然多了"完全没有提示。判据必须按**余额是否变化**（delta ≠ 0），
   * 而不是"是否花了钱"。
   */
  const v = shouldAnnounceBalance({ prevTotal: 10, nextTotal: 60 })
  assert.equal(v.announce, true)
  assert.equal(v.reason, 'toppedUp')
})

test('首次取数 → 不播报（reason=first）', () => {
  // 没有"上一次"可比，说"花掉了¥0"是无意义噪音。
  for (const prev of [null, undefined, Number.NaN]) {
    const v = shouldAnnounceBalance({ prevTotal: prev, nextTotal: 68.49 })
    assert.equal(v.announce, false, `prevTotal=${String(prev)} 不该播报`)
    assert.equal(v.reason, 'first')
  }
})

test('极小变化也算"变了"（哪怕只有 0.01）', () => {
  const v = shouldAnnounceBalance({ prevTotal: 68.49, nextTotal: 68.48 })
  assert.equal(v.announce, true)
  assert.equal(v.reason, 'spent')
})

test('余额归零也算变化', () => {
  const v = shouldAnnounceBalance({ prevTotal: 5, nextTotal: 0 })
  assert.equal(v.announce, true)
  assert.equal(v.reason, 'spent')
})

test('shouldAnnounceBalance 与 buildBalanceAnnouncement 的 kind 保持一致', () => {
  /*
   * 两者不能各判一套：宿主用前者决定"播不播"、用后者生成"播什么"。
   * 若判断口径不一致，就会出现"决定播、但句子说没花"这种自相矛盾。
   *
   * 对应关系：first/unchanged → kind 为 'same'；spent → 'spent'；toppedUp → 'toppedUp'。
   */
  const cases = [
    { prev: null, next: 10, expectAnnounce: false, expectKind: 'same' },
    { prev: 10, next: 10, expectAnnounce: false, expectKind: 'same' },
    { prev: 10, next: 5, expectAnnounce: true, expectKind: 'spent' },
    { prev: 10, next: 30, expectAnnounce: true, expectKind: 'toppedUp' },
  ]
  for (const c of cases) {
    const v = shouldAnnounceBalance({ prevTotal: c.prev, nextTotal: c.next })
    const ann = buildBalanceAnnouncement({ prevTotal: c.prev, nextTotal: c.next })
    assert.equal(v.announce, c.expectAnnounce, `announce 不一致：${JSON.stringify(c)}`)
    assert.equal(ann.kind, c.expectKind, `kind 不一致：${JSON.stringify(c)}`)
    // 核心不变式：决定播报 ⇔ kind 不是 'same'。
    assert.equal(v.announce, ann.kind !== 'same', `口径不一致：${JSON.stringify(c)}`)
  }
})

console.log(`\n结果：${String(passed)}/${String(passed + failed)} 通过`)
if (failed > 0) process.exit(1)
