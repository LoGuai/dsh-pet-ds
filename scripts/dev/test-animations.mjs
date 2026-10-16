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
  })
}

test('拖拽动画（hang）不循环 —— 用户要求"播完维持最后一帧"', () => {
  const manifestPath = join(ANIM_ROOT, 'hang', 'manifest.json')
  assert.ok(existsSync(manifestPath), '缺 hang/manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  /*
   * 拖拽动画必须 loop: false。
   *
   * 这不是审美偏好，而是行为契约：拖拽期间动画要在**最后一帧停住**
   * （"播放完成后维持最后一帧"），松手才切回闲置。
   * 一旦改成循环，拎着的时候会一直摆动、看不出"已拎起"的静止态。
   */
  assert.equal(
    manifest.loop,
    false,
    'hang 必须 loop: false —— 否则拖拽时不会停在最后一帧',
  )
})

console.log(`\n结果：${String(passed)}/${String(passed + failed)} 通过`)
if (failed > 0) process.exit(1)
