/**
 * 由「DSH 的模型流帧」推导桌宠的工作档位。
 *
 * 为什么单独放一个纯函数：
 *  · 判定规则（哪些帧算"思考"、什么时候可以离开"思考"）是本项目最容易改错的一处，
 *    而它本身与 DSH、Electron 都无关 —— 抽出来就能被单元测试钉住；
 *  · 之前这层根本没做：桥接只发 `working` / `idle`，所以真实 DSH 里
 *    **永远不会**触发深度思考动作（用户反馈"我开始思考之后桌宠没同步播放"）。
 *
 * DSH 的 `agent/assistant-stream` 帧里，`frame.chunk.type` 有两个关键值：
 *  · `reasoning-delta` —— 模型在**思考**（对应 GUI 的"深度求索中…"）；
 *  · `text-delta`      —— 模型在**输出正文**（对应"干活中"）。
 * 另有 start / end 等帧，不带这两种 chunk。
 */

/** 思考中。 */
export const STATUS_THINKING = 'thinking'
/** 输出正文中。 */
export const STATUS_WORKING = 'working'
/** 空闲。 */
export const STATUS_IDLE = 'idle'

export const LABEL_THINKING = '深度求索中'
export const LABEL_WORKING = '干活中'

/**
 * 一轮对话里"是否已经开始输出正文"。
 *
 * 为什么需要它（latch）：思考与正文在一轮里会**交替**出现（想一段、写一段），
 * 若按帧直接切换，桌宠会在"进入思考 → 退出思考 → 再进入"之间反复抽搐 ——
 * 每切换一次要播 1 秒的进入/退出段。所以规则定为：
 * **一旦开始输出正文，本轮就不再回到"思考"**，直到下一轮开始。
 */
export function createWorkStatusTracker() {
  let answering = false
  /** 上一次已经上报过的档位；用来把"重复帧"折成 null，少发无意义的刷新。 */
  let lastStatus = null

  return {
    /** 新一轮开始（agent 变为 running）：回到"思考"起点。 */
    beginTurn() {
      answering = false
      lastStatus = null
    },
    /** 这一轮是否已经进入"输出正文"。 */
    get answering() {
      return answering
    },
    /**
     * 吃一个流帧，返回要上报的档位；不需要变化时返回 null。
     *
     * @param {{ type?: string } | null | undefined} chunk
     * @returns {{ status: string, label: string } | null}
     */
    acceptChunk(chunk) {
      const type = chunk && typeof chunk.type === 'string' ? chunk.type : ''
      let next = null
      if (type === 'text-delta') {
        if (!answering) {
          answering = true
          next = { status: STATUS_WORKING, label: LABEL_WORKING }
        }
      } else if (type === 'reasoning-delta') {
        if (!answering) next = { status: STATUS_THINKING, label: LABEL_THINKING }
      }
      /*
       * 同档位不重复上报：思考时每几毫秒就来一帧，全转成 `_touch()`
       * 会让桌宠的长轮询一直被唤醒（纯属白白刷新）。
       */
      if (next === null || next.status === lastStatus) return null
      lastStatus = next.status
      return next
    },
  }
}

/**
 * 便捷入口：给定帧类型与"本轮是否已开始输出正文"，返回应上报的档位。
 *
 * @param {string} chunkType
 * @param {boolean} answering
 * @returns {{ status: string, label: string } | null}
 */
export function workStatusForChunk(chunkType, answering) {
  if (chunkType === 'text-delta') {
    return answering ? null : { status: STATUS_WORKING, label: LABEL_WORKING }
  }
  if (chunkType === 'reasoning-delta') {
    return answering ? null : { status: STATUS_THINKING, label: LABEL_THINKING }
  }
  return null
}
