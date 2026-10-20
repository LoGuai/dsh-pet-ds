/**
 * 守卫：**所有能显示的台词都必须来自语音库**。
 *
 * 用户提的问题（原话）：
 *   「吃白饭、玩mc、坐下、睡觉的语音是不是没有归类到语音库中？
 *     检查一下所有可触发语音源是否都在语音库中，如果不是则转移到库中。」
 *
 * 这四个动作原本就在库里（`action-eat` / `action-play-game` / `action-sit` / `action-sleep`），
 * 但那次检查确实发现**一处**例外：渲染进程里有一句硬编码的信赖兜底台词。
 * 光靠人工过一遍不够 —— 以后随手写一句 `showBubble('……')` 又能破坏这条约定，
 * 所以把它做成测试。
 *
 * 检查两件事：
 *  1. `pet-app/**` 里 `showBubble(...)` 的**实参**不能是中文字符串字面量；
 *  2. 动作清单里的每个动作，**要么**在语音库里有对应组，**要么**在下面的静音清单里
 *     （静音必须写理由，避免"忘了配"被当成"故意静音"）。
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { VOICE_GROUPS } from '../../src/shared-core/voice-library.js'
import {
  PART_ACTIONS,
  RANDOM_ACTIONS,
  MENU_ONLY_ACTIONS,
  STANDING_ACTION_ID,
  SLEEP_ACTION_ID,
  WAKE_ACTION_ID,
  SIT_ACTION_ID,
  SIT_HOLD_ACTION_ID,
  SIT_STOP_ACTION_ID,
} from '../../src/shared-core/actions-library.js'

const ROOT = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const PET_APP = join(ROOT, 'pet-app')

/**
 * 允许"没有语音组"的动作，以及理由。
 *
 * 这些动作本身不配台词：要么是纯姿态（站立/拖拽悬挂），
 * 要么台词由**别的组**负责（点击部位走 click 组，思考按用户要求不发声）。
 */
const SILENT_ACTIONS = {
  stand: '站立是所有动作的默认姿态，不说话',
  hang: '拖拽悬挂时说的是 drag 组，动作本身静音',
  head: '互动动画，台词由 click 组的"点击·头"负责',
  chest: '互动动画，台词由 click 组的"点击·胸"负责',
  stomach: '互动动画，台词由 click 组的"点击·腹"负责',
  leg: '互动动画，台词由 click 组的"点击·腿"负责',
  'sit-circle': '坐姿循环段，说话由 action-sit 负责',
  'sit-stop': '站起过渡段，说话由 action-sit 负责',
  'think-enter': '深度思考进入段，用户要求不发声',
  'think-loop': '深度思考循环段，用户要求不发声',
  'think-exit': '深度思考退出段，用户要求不发声',
  think: '深度思考逻辑 id，用户要求不发声',
}

const walk = (dir) => {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (name.endsWith('.js')) out.push(p)
  }
  return out
}

test('showBubble 的实参里没有硬编码中文台词（台词必须来自语音库）', () => {
  const offenders = []
  for (const file of walk(PET_APP)) {
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (/^\s*(\*|\/\/)/.test(line)) return // 注释里出现示例不算
      // `showBubble('中文…'` / `showBubble("中文…"`
      const m = /showBubble\(\s*(['"`])([^'"`\n]*[\u4e00-\u9fa5][^'"`\n]*)\1/.exec(line)
      if (m) offenders.push(`${file.replace(ROOT, '')}:${String(i + 1)}  ${m[2]}`)
    })
  }
  assert.deepEqual(offenders, [], `这些 showBubble 直接写了中文台词，应改为从语音库取：\n${offenders.join('\n')}`)
})

test('动作清单里的每个动作，要么有语音组，要么在静音清单里写了理由', () => {
  /*
   * 从**真正的动作清单**取 id，不用正则扫源码 ——
   * 前者才是"用户能触发到的动作"，扫源码会把部位 id（belly 等）混进来。
   */
  const ids = [
    STANDING_ACTION_ID,
    SLEEP_ACTION_ID,
    WAKE_ACTION_ID,
    SIT_ACTION_ID,
    SIT_HOLD_ACTION_ID,
    SIT_STOP_ACTION_ID,
    ...RANDOM_ACTIONS.map((a) => a.id),
    ...MENU_ONLY_ACTIONS.map((a) => a.id),
    ...PART_ACTIONS.map((a) => a.id),
  ]
  const withVoice = new Set(
    VOICE_GROUPS.filter((g) => g.trigger === 'action' && g.actionId).map((g) => g.actionId),
  )
  const missing = []
  for (const id of new Set(ids)) {
    if (withVoice.has(id)) continue
    if (SILENT_ACTIONS[id]) continue
    missing.push(id)
  }
  assert.deepEqual(missing, [], `这些动作既没有语音组、也没登记为静音：${missing.join(', ')}`)
})

test('静音清单里的每一条都写了理由（避免"忘了配"被当成"故意静音"）', () => {
  const empty = Object.entries(SILENT_ACTIONS).filter(([, why]) => !why || why.length < 6)
  assert.deepEqual(empty.map(([id]) => id), [], '静音动作必须写清理由')
})
