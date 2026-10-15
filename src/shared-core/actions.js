/**
 * 动作与点击部位的**对外入口**。
 *
 * 真正的定义全部搬到了 `actions-library.js`（用户要求"所有随机动作放在一个库中"）。
 * 这个文件只做两件事：
 *  1. 把库里的定义**转发**出去，保持既有 import 路径不变（避免改动一堆调用点）；
 *  2. 放几个**派生工具函数**（按权重抽动作等）—— 它们是用库的方式，不是定义本身。
 *
 * ⚠️ 不要在这里再写动作定义。定义只放 `actions-library.js` 一处，
 * 否则又会出现"两份清单各写一套"的漂移问题。
 */

export {
  STANDING_ACTION_ID,
  SLEEP_ACTION_ID,
  WAKE_ACTION_ID,
  RANDOM_ACTION_RULES,
  SLEEP_ACTION,
  RANDOM_ACTIONS,
  MENU_ONLY_ACTIONS,
  PART_ACTIONS,
  CLICK_PARTS,
  findAction,
  findClickPart,
  actionMenuEntries,
  randomActionIds,
} from './actions-library.js'

import { RANDOM_ACTIONS } from './actions-library.js'

/**
 * 按权重随机抽一个一次性动作。
 *
 * ⚠️ 现在**实际播放走的是渲染进程自己那份等概率抽取**（`triggerRandomAction`），
 * 渲染进程没有模块加载能力，读不到这里。这个函数目前只被自测与将来的
 * 服务端逻辑使用 —— 如果哪天要让权重真正生效，应当把 `weight` 一并下发给
 * 渲染进程，在那里按累积权重抽，而不是让这个函数成为死代码。
 *
 * @param {() => number} [rand] 注入随机源，便于测试时确定性验证
 * @param {string | null} [avoidId] 尽量避开这个 id（避免连续两次抽到同一个动作）
 * @returns {{ id: string, label: string, lines: string[], weight: number }}
 */
export function pickRandomAction(rand = Math.random, avoidId = null) {
  const pool = RANDOM_ACTIONS
  if (pool.length === 0) throw new Error('RANDOM_ACTIONS 为空')

  const total = pool.reduce((sum, action) => sum + action.weight, 0)
  // 最多试 8 次避免落到 avoidId；试不到就接受（只有一个动作时必然会这样）。
  for (let attempt = 0; attempt < 8; attempt += 1) {
    let roll = rand() * total
    for (const action of pool) {
      roll -= action.weight
      if (roll <= 0) {
        if (action.id === avoidId && pool.length > 1) break
        return action
      }
    }
  }
  return pool[pool.length - 1]
}
