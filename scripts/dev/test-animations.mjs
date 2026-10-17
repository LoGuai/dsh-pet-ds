/**
 * 动画素材一致性检查：`manifest.json` 的声明必须与磁盘上的帧文件对得上。
 *
 * ## 为什么需要它
 *
 * 动画素材经常被替换（美术迭代）。而 `manifest.json` 里的 `frameCount`
 * 是**手写/脚本生成的声明值**，与实际的 `frame_NN.png` 数量是两份数据 ——
 * 它们不一致时不会报错，只会**静默少播几帧或多出空帧**：
 *
 *   · `frameCount` 大于实际帧数 → 播放时取不到图，出现空帧或停在旧帧；
 *   · `frameCount` 小于实际帧数 → 末尾几帧永远不播（换素材最容易踩这个）；
 *   · `drawOffsetY` 长度与帧数不符 → 部分帧没有垂直微调，角色会跳一下。
 *
 * 这类问题从画面上很难归因（"看着有点怪"），所以在这里挡住。
 *
 * ## 检查项
 *
 * 1. 每个动作目录都有 `manifest.json`
 * 2. `frameCount` = 实际 `frame_NN.png` 数量，且文件名从 01 连续到 frameCount
 * 3. `drawOffsetY` 长度 = `frameCount`
 * 4. `loopRange`（若有）的 from/to 落在 1..frameCount 内且 from ≤ to
 * 5. `stand` 存在（其它动作的对齐基准是它）
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const ANIM_ROOT = join(ROOT, 'assets', 'animations')

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

/** 目录下的动作名（子目录）。 */
const actions = existsSync(ANIM_ROOT)
  ? readdirSync(ANIM_ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
  : []

/** 某个动作的帧文件（按名字里的数字升序）。 */
function frameFiles(action) {
  const dir = join(ANIM_ROOT, action)
  return readdirSync(dir)
    .filter((f) => /^frame_\d+\.png$/.test(f))
    .sort((a, b) => Number(/\d+/.exec(a)[0]) - Number(/\d+/.exec(b)[0]))
}

test('存在动作目录', () => {
  assert.ok(actions.length > 0, `没找到任何动作目录：${ANIM_ROOT}`)
})

test('stand 是其它动作的对齐基准，必须存在', () => {
  assert.ok(actions.includes('stand'), '缺少 stand 目录')
})

for (const action of actions) {
  test(`${action}：manifest 存在且帧数自洽`, () => {
    const dir = join(ANIM_ROOT, action)
    const manifestPath = join(dir, 'manifest.json')
    assert.ok(existsSync(manifestPath), `缺 manifest.json：${manifestPath}`)

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const files = frameFiles(action)

    assert.ok(files.length > 0, `${action} 没有任何 frame_NN.png`)

    /* frameCount 必须等于磁盘上的帧数 —— 这条是本次检查的核心 */
    assert.equal(
      manifest.frameCount,
      files.length,
      `${action}：manifest.frameCount=${String(manifest.frameCount)}，` +
        `但磁盘上有 ${String(files.length)} 个 frame_NN.png。\n` +
        '      换素材后忘了重新生成 manifest 时就会出现这个。',
    )

    /* 文件名必须从 01 连续到 frameCount（不跳号，否则中间会出现空帧） */
    const expected = Array.from(
      { length: files.length },
      (_, i) => `frame_${String(i + 1).padStart(2, '0')}.png`,
    )
    assert.deepEqual(files, expected, `${action}：帧文件名不连续`)

    /* drawOffsetY 长度必须与帧数一致 */
    if (manifest.drawOffsetY !== undefined) {
      assert.ok(Array.isArray(manifest.drawOffsetY), `${action}：drawOffsetY 不是数组`)
      assert.equal(
        manifest.drawOffsetY.length,
        manifest.frameCount,
        `${action}：drawOffsetY 有 ${String(manifest.drawOffsetY.length)} 项，` +
          `但 frameCount=${String(manifest.frameCount)}`,
      )
    }

    /* fps 必须是正数 */
    assert.ok(
      Number.isFinite(manifest.fps) && manifest.fps > 0,
      `${action}：fps 不是正数（${String(manifest.fps)}）`,
    )

    /* loopRange 的帧号是 1 基，且要落在范围内 */
    if (manifest.loopRange) {
      const { from, to } = manifest.loopRange
      assert.ok(
        Number.isInteger(from) && Number.isInteger(to) && from >= 1 && to <= manifest.frameCount && from <= to,
        `${action}：loopRange ${JSON.stringify(manifest.loopRange)} 超出 1..${String(manifest.frameCount)}`,
      )
    }

    /* staticFrames（若有）的帧号同样是 1 基，且必须落在范围内 */
    if (manifest.staticFrames !== undefined) {
      assert.ok(
        Array.isArray(manifest.staticFrames),
        `${action}：staticFrames 不是数组`,
      )
      for (const v of manifest.staticFrames) {
        assert.ok(
          Number.isInteger(v) && v >= 1 && v <= manifest.frameCount,
          `${action}：staticFrames 里有非法帧号 ${String(v)}（应在 1..${String(manifest.frameCount)}）`,
        )
      }
    }
  })
}

test('拖拽动画（hang）声明了静态帧池 —— 用户要求"随机播放其中一个动作"', () => {
  const manifestPath = join(ANIM_ROOT, 'hang', 'manifest.json')
  assert.ok(existsSync(manifestPath), '缺 hang/manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  /*
   * 拖拽已从"多帧动画"改为"触发时随机挑一帧静态显示"
   * （用户要求：「拖拽动作不再采用多帧动画形式，而是改为静态，
   *   在触发拖拽时随机播放其中一个动作，其他机制不变」）。
   *
   * 所以契约变成：`staticFrames` 必须存在、非空、帧号合法。
   * 帧号是 **1 基**（与 frame_NN.png 对应），便于对着帧图配置。
   *
   * ⚠️ 同时仍要求 `loop: false` —— 静态帧本来就不会推进，但万一将来
   * 有人把 staticFrames 删掉、想退回多帧动画，`loop: false` 能保证
   * 那时仍然是"播完停在最后一帧"（也就是"维持"语义），而不是变成摆动循环。
   */
  const pool = manifest.staticFrames
  assert.ok(
    Array.isArray(pool) && pool.length > 0,
    'hang 必须声明 staticFrames（如 [4, 11]）—— 否则会退回多帧动画',
  )
  for (const v of pool) {
    assert.ok(
      Number.isInteger(v) && v >= 1 && v <= manifest.frameCount,
      `hang 的 staticFrames 里有非法帧号 ${String(v)}（应在 1..${String(manifest.frameCount)}）`,
    )
  }
  assert.equal(
    manifest.loop,
    false,
    'hang 必须 loop: false —— 静态帧不推进；万一退回多帧动画也要"停在最后一帧"',
  )
})

test('坐姿三段的大小互相接得上（按整体高度对齐，接缝处连续）', () => {
  /*
   * 坐姿是**三段素材连续衔接**的一个动作：坐下的过程 → 坐着循环 → 站起的过程。
   *
   * ## 这里踩过两次坑，两次都是"对齐指标选错了"
   *
   * 1. 最早给三段配同一个 `scale_group`（共用缩放倍数）—— 错，因为三段
   *    **原始素材里角色本身就画得不一样大**（头宽 stand 530 / sit 580 /
   *    sit-circle 627 / sit-stop 643），共用系数只是把差异原样留下。
   *
   * 2. 改成按**头部宽度**对齐（四段头宽都 530）—— 头是一样大了，但用户
   *    仍反馈"坐着时和起身时偏小"。实测成品高度：stand 1149.4（100%）、
   *    sit 1093.8（94.6%）、sit-circle 1010.5（88.2%）、sit-stop 1031.5（95.5%）。
   *    也就是说：坐姿轮廓更矮，按头对齐就会显得整个人小一截。
   *    **用户的"大小"判据是整体高度/体量，不是头。**
   *
   * ## 现在的契约
   *
   * `height_ramp`：逐帧目标高度线性过渡，且**接缝必须连续** ——
   *   · sit-circle 恒定 = sit 的**末帧**高度（与上一段接得上）
   *   · sit-stop 从 sit 末帧高度过渡到 stand **均值**高度（首尾都接得上）
   *
   * 断言用的是清单里记录的逐帧 `outH`（生成时写下的真实成品高度），
   * 不需要在 Node 里解 PNG。
   */
  const load = (id) => {
    const p = join(ANIM_ROOT, id, 'manifest.json')
    assert.ok(existsSync(p), `缺 ${id}/manifest.json`)
    const m = JSON.parse(readFileSync(p, 'utf8'))
    assert.ok(m._processing, `${id}/manifest.json 没有 _processing（重新跑 build-action-asset.py ${id}）`)
    return m
  }
  const heightsOf = (m) => {
    const pf = m._processing.perFrame
    assert.ok(Array.isArray(pf) && pf.length > 0, '清单里没有逐帧记录')
    return pf.map((r) => r.outH)
  }

  const sit = load('sit')
  const circle = load('sit-circle')
  const stop = load('sit-stop')

  /* 脚底基准必须与站立一致（否则锚点会跳）。 */
  for (const [id, m] of [['sit', sit], ['sit-circle', circle], ['sit-stop', stop]]) {
    assert.equal(
      m._processing.footBaseOutput,
      1155,
      `${id} 的脚底基准是 ${String(m._processing.footBaseOutput)}，应为 1155`,
    )
    assert.equal(
      Array.isArray(m._processing.perFrameScale) ? m._processing.perFrameScale.length : -1,
      m.frameCount,
      `${id} 的 perFrameScale 长度与帧数不一致`,
    )
  }

  /* circle 与 stop 都必须走"高度对齐"，否则会退回"按头对齐 → 偏小"。 */
  assert.equal(
    circle._processing.headMatch && circle._processing.headMatch.mode,
    'height-ramp',
    'sit-circle 没走高度对齐 —— 会显得比坐下过程小（曾实测 88% vs 95%）',
  )
  assert.equal(
    stop._processing.headMatch && stop._processing.headMatch.mode,
    'height-ramp',
    'sit-stop 没走高度对齐 —— 站直时会比站立小一截',
  )

  /* 坐着是循环，高度必须恒定，否则循环时会"呼吸"。 */
  const ch = heightsOf(circle)
  assert.ok(
    Math.max(...ch) - Math.min(...ch) <= 2,
    `sit-circle 帧间高度不一致（${String(Math.min(...ch))}~${String(Math.max(...ch))}），循环时会大小脉动`,
  )

  /* 接缝连续：上一段末帧 ≈ 下一段首帧（容差 2px，取整误差量级）。 */
  const sitH = heightsOf(sit)
  const stopH = heightsOf(stop)
  assert.ok(
    Math.abs(sitH[sitH.length - 1] - ch[0]) <= 2,
    `sit 末帧高 ${String(sitH[sitH.length - 1])} → circle 首帧 ${String(ch[0])}，接缝处会跳`,
  )
  assert.ok(
    Math.abs(ch[ch.length - 1] - stopH[0]) <= 2,
    `circle 末帧高 ${String(ch[ch.length - 1])} → stop 首帧 ${String(stopH[0])}，接缝处会跳`,
  )

  /* stop 必须真的过渡到"站立那个量级"（宽度上限可能让它差一点，容差 3%）。 */
  const target = stop._processing.headMatch && stop._processing.headMatch.endHeight
  assert.ok(Number.isFinite(target), 'sit-stop 没记录 endHeight')
  const lastStop = stopH[stopH.length - 1]
  assert.ok(
    lastStop >= target * 0.97 && lastStop <= target * 1.02,
    `sit-stop 末帧高 ${String(lastStop)} 偏离目标 ${String(target)} 超过容差 —— 站直瞬间会跳`,
  )

  /* 站起的过程高度应单调上升（不该忽大忽小）。 */
  for (let i = 1; i < stopH.length; i += 1) {
    assert.ok(
      stopH[i] >= stopH[i - 1] - 2,
      `sit-stop 高度在第 ${String(i + 1)} 帧回落（${String(stopH[i - 1])} → ${String(stopH[i])}），站起过程会抖`,
    )
  }
})

test('所有动作的脚底基准一致（切换动作时角色不会上下跳）', () => {
  /*
   * 这条来自一个真实缺陷：`standing_foot_output()` 原先用 `min(脚底)`，
   * 而站立 12 帧里只有 1 帧在 1148、其余 11 帧在 1155 ——
   * 于是基准取到 1148，所有动作都对齐到 1148，而**站立自己**多数帧在 1155，
   * 切换动作时角色整体上移 7px（用户反馈"坐下前后锚点有变化"）。
   *
   * 修法：基准改用**众数**（1155），并把所有动作重新对齐。
   *
   * 断言写成"所有记录的脚底基准必须相同"，而不是写死 1155 ——
   * 那样以后调整画布约定时不必再改测试，而"不一致"永远是真错。
   */
  const feet = {}
  for (const action of actions) {
    const p = join(ANIM_ROOT, action, 'manifest.json')
    if (!existsSync(p)) continue
    const m = JSON.parse(readFileSync(p, 'utf8'))
    const f = m._processing ? m._processing.footBaseOutput : undefined
    if (f !== undefined) feet[action] = f
  }
  const values = [...new Set(Object.values(feet))]
  assert.equal(
    values.length,
    1,
    '各动作的脚底基准不一致（切换动作时角色会跳）：'
      + Object.entries(feet).map(([a, f]) => `${a}=${String(f)}`).join('，'),
  )
  /* 至少要有"绝大多数动作"记录了这个值，避免这条断言因为全空而恒真。 */
  assert.ok(
    Object.keys(feet).length >= 10,
    `只有 ${String(Object.keys(feet).length)} 个动作记录了脚底基准，太少（断言可能形同虚设）`,
  )
})

console.log(`\n结果：${String(passed)}/${String(passed + failed)} 通过`)
if (failed > 0) process.exit(1)
