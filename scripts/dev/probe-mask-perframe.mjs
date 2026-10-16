/**
 * 直接测：**站立动画的逐帧掩膜之间，有多少像素的"命中与否"会变**。
 *
 * ## 为什么这样测
 *
 * 假设是「`hitTest()` 用当前帧的掩膜，而不同帧的角色轮廓不完全一样，
 * 于是靠近边界的像素会随动画帧在命中/不命中之间来回切」——
 * 若成立，属性面板与鼠标穿透就会跟着动画一起抖。
 *
 * 用 CDP 驱动活窗口试了两轮都没抓到（合成事件不走真实路径、连上时
 * 渲染进程还没初始化完），所以改成**离线直接算**：
 * 用 Electron 的 `nativeImage` 解码 PNG（不需要任何额外依赖），
 * 按 `renderer.js` 里完全相同的规则生成掩膜，再逐像素统计。
 *
 * ## 判定标准
 *
 * 对每个像素，统计它在 N 帧里"命中"的次数 k：
 *   · k = 0 或 k = N  → **稳定**（与帧无关）
 *   · 0 < k < N       → **会抖**（同一坐标可能命中也可能不命中）
 *
 * 若"会抖"的像素数量可观（尤其集中在轮廓边界），假设成立。
 *
 * 运行（**必须用 Electron**，因为要用 nativeImage 解码 PNG）：
 *   $env:ELECTRON_RUN_AS_NODE=1
 *   & electron.exe scripts/dev/probe-mask-perframe.mjs [动作名]
 */

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')

/** 与 renderer.js 保持一致的两个常量。 */
const HIT_MASK_WIDTH = 32 // renderer.js 里的掩膜宽度
const HIT_ALPHA_THRESHOLD = 40

const action = process.argv[2] ?? 'stand'
const dir = join(ROOT, 'assets', 'animations', action)

console.log(`分析动作：${action}`)
console.log(`目录：${dir}`)

// ---------------------------------------------------------------- 必需 nativeImage
let nativeImage
try {
  ;({ nativeImage } = await import('electron'))
} catch {
  console.log('✗ 拿不到 electron 的 nativeImage —— 请用 Electron 以 Node 模式运行：')
  console.log('   $env:ELECTRON_RUN_AS_NODE=1; & electron.exe scripts/dev/probe-mask-perframe.mjs')
  process.exit(1)
}
if (!nativeImage) {
  console.log('✗ nativeImage 不可用（ELECTRON_RUN_AS_NODE 下应为可用）')
  process.exit(1)
}

// ---------------------------------------------------------------- 读帧
const files = readdirSync(dir)
  .filter((f) => /^frame_.*\.png$/i.test(f))
  .sort()
if (files.length === 0) {
  console.log(`✗ ${dir} 下没有 frame_*.png`)
  process.exit(1)
}
console.log(`帧数：${files.length}\n`)

/**
 * 把一帧解码成"逐像素是否命中"的布尔数组（按掩膜尺寸采样）。
 *
 * 与 renderer.js 的做法一致：把图片 drawImage 缩放到 HIT_MASK_WIDTH 宽，
 * 再取 alpha > 阈值。这里用 nativeImage.resize + toBitmap 近似
 * （resize 默认是高质量插值，和 canvas drawImage 接近，足以判定"边界抖动"）。
 */
function maskOf(file) {
  const img = nativeImage.createFromPath(join(dir, file))
  if (img.isEmpty()) return null
  const size = img.getSize()
  if (size.width === 0) return null
  const maskH = Math.max(1, Math.round((HIT_MASK_WIDTH * size.height) / size.width))
  const small = img.resize({ width: HIT_MASK_WIDTH, height: maskH, quality: 'good' })
  const bmp = small.toBitmap() // BGRA
  const out = new Uint8Array(HIT_MASK_WIDTH * maskH)
  for (let i = 0; i < out.length; i++) {
    const alpha = bmp[i * 4 + 3] ?? 0
    out[i] = alpha > HIT_ALPHA_THRESHOLD ? 1 : 0
  }
  return { w: HIT_MASK_WIDTH, h: maskH, bits: out, srcW: size.width, srcH: size.height }
}

const masks = []
for (const f of files) {
  const m = maskOf(f)
  if (m) masks.push({ file: f, ...m })
}
if (masks.length === 0) {
  console.log('✗ 没有解出任何帧')
  process.exit(1)
}

const W = masks[0].w
const H = masks[0].h
console.log(`掩膜尺寸：${W} × ${H}（源图 ${masks[0].srcW} × ${masks[0].srcH}）`)
console.log(`用于统计的帧：${masks.length}\n`)

// ---------------------------------------------------------------- 逐像素统计
const N = masks.length
/** k = 命中帧数。 */
const hitCount = new Uint8Array(W * H)
for (const m of masks) {
  if (m.w !== W || m.h !== H) {
    console.log(`⚠ ${m.file} 掩膜尺寸与首帧不一致，跳过`)
    continue
  }
  for (let i = 0; i < hitCount.length; i++) hitCount[i] += m.bits[i]
}

let stableMiss = 0 // k=0
let stableHit = 0 // k=N
let flickery = 0 // 0<k<N
/** 抖动像素按"命中比例"分桶，看是否集中在边界。 */
const buckets = new Map()

for (let i = 0; i < hitCount.length; i++) {
  const k = hitCount[i]
  if (k === 0) stableMiss += 1
  else if (k === N) stableHit += 1
  else {
    flickery += 1
    const key = k
    buckets.set(key, (buckets.get(key) ?? 0) + 1)
  }
}

const total = W * H
const pct = (n) => `${((n / total) * 100).toFixed(2)}%`

console.log('逐像素统计（同一坐标在 N 帧里的命中情况）：')
console.log(`  始终不命中 (k=0)   : ${String(stableMiss).padStart(6)}  ${pct(stableMiss)}`)
console.log(`  始终命中   (k=N)   : ${String(stableHit).padStart(6)}  ${pct(stableHit)}`)
console.log(`  **会抖** (0<k<N)   : ${String(flickery).padStart(6)}  ${pct(flickery)}   ← 光标停在这里就会闪`)

if (flickery > 0) {
  console.log('\n抖动像素按命中帧数分布（k = 命中了几帧）：')
  for (const k of [...buckets.keys()].sort((a, b) => a - b)) {
    console.log(`  k=${String(k).padStart(2)}/${String(N)}  ${String(buckets.get(k)).padStart(6)} 个`)
  }

  /*
   * 关键补充：这些抖动像素是否**在空间上连成边界带**？
   * 把它们画成 ASCII 图 —— 若呈轮廓状，说明就是"动画让轮廓在动"。
   */
  console.log('\n抖动像素的空间分布（# = 会抖，. = 稳定命中，空格 = 稳定不命中）：')
  for (let y = 0; y < H; y++) {
    let line = ''
    for (let x = 0; x < W; x++) {
      const k = hitCount[y * W + x]
      line += k === 0 ? ' ' : k === N ? '.' : '#'
    }
    console.log(`  ${String(y).padStart(2)} |${line}|`)
  }
}

// ---------------------------------------------------------------- 结论
console.log('')
if (flickery === 0) {
  console.log('结论：掩膜在各帧之间**完全一致** —— 假设不成立，'
    + '闪烁不是逐帧掩膜造成的，要另找原因。')
} else {
  const ratio = ((flickery / total) * 100).toFixed(2)
  console.log(`结论：有 ${String(flickery)} 个像素（${ratio}%）的命中结果**随动画帧变化**。`)
  console.log('      光标停在这些位置时，`setStatsVisible(hit)` 会跟着动画帧抖 ——')
  console.log('      这足以解释"属性面板闪烁"。')
  console.log('      → 修法方向：给命中判定加**滞回/去抖**，不要逐帧直接切换。')
}
