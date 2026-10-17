/**
 * 自由对话台词 —— **门面**，内容已并入语音库。
 *
 * ## 历史
 *
 * 这里原本是 `DIALOGUE_LINES` 的唯一来源（右键菜单「对话」用）。
 * 用户要求「把所有桌宠可触发的语音归到语音库中」之后，台词挪到了
 * `voice-library.js` 的 `free` 触发条件组，本文件只保留取用函数。
 *
 * ## 为什么还留这个文件
 *
 * 调用方（主进程的「随机说一句」、以及 `test-dialogue.mjs`）用的是
 * `pickDialogueLine` / `dialogueLineCount` 这套名字。改成门面之后：
 *  · 台词只有**一处**真相源（库里），不会再出现"改了一处忘另一处"；
 *  · 调用方一行都不用改。
 *
 * 新加台词请加到 `voice-library.js` 的 `free` 组里，**不要**写回本文件。
 */

import { freeLines } from './voice-library.js'

/**
 * 自由对话台词（只读快照，内容来自语音库）。
 *
 * 为什么可以做成快照：语音库是**静态数据**（模块加载时就定型），
 * 不存在运行时变更，所以快照与实时取用等价；而 `pickDialogueLine()`
 * 仍然实时取，避免以后真的支持热改台词时不一致。
 */
export const DIALOGUE_LINES = freeLines()

/**
 * 随机取一句对话，**尽量不与上一句重复**。
 *
 * @param {() => number} [rand] 注入随机源，便于测试确定化
 * @param {string | null} [avoidLine] 上一句，尽量避开
 * @returns {string}
 */
export function pickDialogueLine(rand = Math.random, avoidLine = null) {
  const pool = freeLines()
  if (pool.length === 0) return ''
  if (pool.length === 1) return pool[0]
  const candidates = pool.filter((line) => line !== avoidLine)
  const list = candidates.length > 0 ? candidates : pool
  return list[Math.floor(rand() * list.length)]
}

/** 台词条数（供自测与文档引用，避免两处各写一个数字）。 */
export function dialogueLineCount() {
  return freeLines().length
}
