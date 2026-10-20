/**
 * 「模型流帧 → 桌宠档位」的单元测试。
 *
 * 这层原先根本不存在（桥接只发 working / idle），导致真实 DSH 里
 * 深度思考动作永远不会触发。规则抽成纯函数后就该被钉住：
 *  · reasoning-delta → thinking；
 *  · text-delta      → working；
 *  · 一轮里一旦开始写正文，就不再回到 thinking（否则动作反复抽搐）；
 *  · 其它帧（start/end/工具帧）不改变档位。
 *
 * 运行：node scripts/dev/test-work-status.mjs
 */
import assert from 'node:assert/strict'

import {
  LABEL_THINKING,
  LABEL_WORKING,
  STATUS_THINKING,
  STATUS_WORKING,
  createWorkStatusTracker,
  workStatusForChunk,
} from '../../src/shared-core/work-status.js'

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  PASS  ${name}`)
  } catch (err) {
    failed += 1
    console.log(`  FAIL  ${name} — ${err instanceof Error ? err.message : String(err)}`)
  }
}

const chunk = (type) => ({ type })

test('reasoning-delta → thinking（深度求索中）', () => {
  const t = createWorkStatusTracker()
  assert.deepEqual(t.acceptChunk(chunk('reasoning-delta')), {
    status: STATUS_THINKING,
    label: LABEL_THINKING,
  })
})

test('text-delta → working（干活中）', () => {
  const t = createWorkStatusTracker()
  assert.deepEqual(t.acceptChunk(chunk('text-delta')), {
    status: STATUS_WORKING,
    label: LABEL_WORKING,
  })
})

test('开始写正文后，再想也不会回到 thinking（避免动作抽搐）', () => {
  const t = createWorkStatusTracker()
  assert.equal(t.acceptChunk(chunk('reasoning-delta')).status, STATUS_THINKING)
  assert.equal(t.acceptChunk(chunk('text-delta')).status, STATUS_WORKING)
  // 正文写一段、又想了想：仍然算 working
  assert.equal(t.acceptChunk(chunk('reasoning-delta')), null)
  assert.equal(t.acceptChunk(chunk('text-delta')), null)
})

test('thinking 期间重复 reasoning 帧不重复上报（减少无意义刷新）', () => {
  const t = createWorkStatusTracker()
  assert.equal(t.acceptChunk(chunk('reasoning-delta')).status, STATUS_THINKING)
  assert.equal(t.acceptChunk(chunk('reasoning-delta')), null)
})

test('新一轮开始后可以重新进入 thinking', () => {
  const t = createWorkStatusTracker()
  t.acceptChunk(chunk('text-delta'))
  t.beginTurn()
  assert.equal(t.answering, false)
  assert.equal(t.acceptChunk(chunk('reasoning-delta')).status, STATUS_THINKING)
})

test('start / end / 工具帧一律不改变档位', () => {
  const t = createWorkStatusTracker()
  for (const type of ['start', 'end', 'tool-delta', 'tool-call', 'error', '']) {
    assert.equal(t.acceptChunk(chunk(type)), null, `${type} 不该改变档位`)
  }
  assert.equal(t.acceptChunk(null), null)
  assert.equal(t.acceptChunk(undefined), null)
  assert.equal(t.acceptChunk({}), null)
})

test('纯函数入口 workStatusForChunk 与跟踪器一致', () => {
  assert.deepEqual(workStatusForChunk('reasoning-delta', false), {
    status: STATUS_THINKING,
    label: LABEL_THINKING,
  })
  assert.deepEqual(workStatusForChunk('text-delta', false), {
    status: STATUS_WORKING,
    label: LABEL_WORKING,
  })
  assert.equal(workStatusForChunk('reasoning-delta', true), null)
  assert.equal(workStatusForChunk('other', false), null)
})

console.log(`\n  结果：${String(passed)}/${String(passed + failed)} 通过`)
if (failed > 0) process.exit(1)
