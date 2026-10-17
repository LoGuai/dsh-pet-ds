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

test('坐姿三段与站立同一视觉大小（按头部宽度对齐）', () => {
  /*
   * 坐姿是**三段素材连续衔接**的一个动作：坐下的过程 → 坐着循环 → 站起的过程。
   *
   * ## 为什么不能靠"共用同一缩放倍数"
   *
   * 曾经的做法是给三段配同一个 `scale_group`，让它们乘同一个系数 ——
   * 那个做法是**错的**，因为三段**原始素材里角色本身就画得不一样大**
   * （实测头宽 stand 530 / sit 580 / sit-circle 627 / sit-stop 643）。
   * 共用系数只是把差异原样保留下来，用户实测反馈"坐下前后桌宠大小不一样"，
   * 坐在那里时比站着大 12%。
   *
   * ## 现在的契约
   *
   * 按**头部宽度**对齐到站立：`build-action-asset.py` 的
   * `match_head_to: "stand"` + `match_head_per_frame: true`。
   * 用头宽而不是整体包围盒，是因为整体包围盒随姿势剧烈变化
   * （裙摆铺开、手臂抬起），拿它对齐会把"姿势不同"错当成"大小不同"。
   *
   * 这里断言清单里记录的 `headWidthOut` 确实是同一个基准值 ——
   * 防止有人改了配置却没重跑，或某段回退成"各自填满画布"。
   */
  const ids = ['sit', 'sit-circle', 'sit-stop']
  const heads = {}
  const refs = {}
  for (const id of ids) {
    const p = join(ANIM_ROOT, id, 'manifest.json')
    assert.ok(existsSync(p), `缺 ${id}/manifest.json`)
    const m = JSON.parse(readFileSync(p, 'utf8'))
    const proc = m._processing
    assert.ok(proc, `${id}/manifest.json 没有 _processing（重新跑 build-action-asset.py ${id}）`)
    assert.ok(
      Number.isFinite(proc.headWidthOut),
      `${id} 没有记录 _processing.headWidthOut —— 说明没走"头宽对齐"，角色大小会与站立不一致`,
    )
    assert.equal(
      proc.footBaseOutput,
      1155,
      `${id} 的脚底基准是 ${String(proc.footBaseOutput)}，应为 1155（与站立多数帧一致）`,
    )
    heads[id] = proc.headWidthOut
    refs[id] = proc.headMatch && proc.headMatch.refHeadWidth
    assert.equal(
      proc.headMatch && proc.headMatch.ref,
      'stand',
      `${id} 的头宽基准不是 stand`,
    )
    assert.equal(
      proc.headMatch && proc.headMatch.perFrame,
      true,
      `${id} 没开逐帧归一化 —— 段内仍有尺寸差（实测 sit-stop 段内跨度 10.5%）`,
    )
    assert.equal(
      Array.isArray(proc.perFrameScale) ? proc.perFrameScale.length : -1,
      m.frameCount,
      `${id} 的 perFrameScale 长度与帧数不一致`,
    )
  }

  /* 三段都对齐到同一个参考头宽，且三段之间一致（容差 2%，取整误差量级）。 */
  const ref = refs.sit
  assert.ok(Number.isFinite(ref), 'sit 没有记录 refHeadWidth')
  for (const id of ids) {
    assert.equal(refs[id], ref, `${id} 的参考头宽 ${String(refs[id])} 与 sit 的 ${String(ref)} 不一致`)
    assert.ok(
      Math.abs(heads[id] - ref) / ref <= 0.02,
      `${id} 的对齐后头宽 ${String(heads[id])} 偏离参考 ${String(ref)} 超过 2%`,
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
