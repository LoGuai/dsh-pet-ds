/**
 * 恢复被丢掉的好感存档。
 *
 * ## 发生了什么
 *
 * 旧进程（10-18 09:28 启动）跑的是**没有落盘代码**的版本，好感只活在内存里：
 * 日志显示它一路涨到 **4 心 827/3000**，然后被我重启时杀掉 —— 全丢。
 *
 * 新进程从 0 开始，之后正常赚了 52 点（现存档里就是这 52）。
 *
 * 所以恢复值 = **827（旧进程）+ 52（新进程正常获得）= 879**，等级 4 心。
 * 累计获得量 = 0~3 心满级所需 1800 + 879 = 2679。
 *
 * 用法：node scripts/dev/restore-affection.mjs --hearts 4 --value 879 [--dir <userData>]
 */

import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const { createAffectionStore } = require('../../pet-app/affection-store.js')

const argOf = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const dir = argOf('dir', join(process.cwd(), '.cache', 'dev-pet-userdata'))
const hearts = Number(argOf('hearts', '4'))
const value = Number(argOf('value', '879'))
const lifetime = Number(argOf('lifetime', '2679'))

const store = createAffectionStore({ dir: () => dir })
const file = store.path()

if (existsSync(file)) {
  const before = JSON.parse(readFileSync(file, 'utf8'))
  console.log(`  现有存档：${String(before.hearts)} 心 ${String(before.value)}/${String(before.lifetimeGained)} 累计`)
}

const ok = store.save(
  { hearts, value, updatedAt: Date.now() },
  /*
   * lastClickAt 给成"刚刚"：让 5 分钟点击冷却重新计时，
   * 避免恢复后立刻能再点一次刷好感（保持与真实游玩一致）。
   */
  { lastClickAt: Date.now(), lifetimeGained: lifetime },
)

if (!ok) {
  console.log('  ✗ 写入失败')
  process.exit(1)
}

const reloaded = store.load()
console.log(`  ✓ 已写入 ${file}`)
console.log(
  `  读回：${String(reloaded.state.hearts)} 心 ${String(reloaded.state.value)}/3000，累计 ${String(reloaded.lifetimeGained)}`,
)
