/**
 * 校验 `install.cmd` 是**纯 ASCII 且无 BOM**，必要时就地修掉。
 *
 * ## 为什么需要这个检查
 *
 * `cmd.exe` 按**系统 ANSI 代码页**读 `.cmd` 文件 —— 它**不看 BOM，也不管
 * 文件里的 `chcp`**。中文 Windows 上是 GBK，所以一个 UTF-8 存的中文注释
 * 会变成乱码，进而把引号、括号全搞乱，脚本直接碎掉。实测报了一堆：
 *
 *     'ho' is not recognized as an internal or external command
 *
 * 我在开发中就因为这个删掉过一版 `.cmd`。而我的编辑器/编辑工具**会反复**
 * 把文件改回 UTF-8，所以不能只靠"当初写的时候是 ASCII"——
 * 得有一步自动校验兜住。
 *
 * `install.cmd` 因此刻意**全英文**（注释与输出都是）。中文输出全部由
 * `install-pet.ps1` 负责 —— 那个文件是 UTF-8 with BOM，由 PowerShell 读，
 * 没有这个问题。
 *
 * ## 修法
 *
 * 非 ASCII 只可能出现在**注释**里（代码本身必须 ASCII 才能工作），
 * 所以直接剥掉所有非 ASCII 字节是安全的。但为了不静默改变语义，
 * 这里**先报告再修**，并把修掉的内容打印出来。
 *
 * 用法：node scripts/dev/check-cmd-ascii.mjs [--fix]
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const TARGET = join(ROOT, 'install.cmd')

const fix = process.argv.includes('--fix')

const log = (m) => console.log(m)

const buf = readFileSync(TARGET)

/* ---- BOM 检查 ---- */
const hasBom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf

/* ---- 非 ASCII 字节检查 ---- */
const bad = []
for (let i = 0; i < buf.length; i++) {
  if (buf[i] > 0x7e) bad.push(i)
}

log(`检查 ${TARGET}`)
log(`  大小    : ${buf.length} 字节`)
log(`  BOM     : ${hasBom ? '有（应无）' : '无 ✓'}`)
log(`  非 ASCII: ${bad.length} 个字节${bad.length ? '（应为 0）' : ' ✓'}`)

if (!hasBom && bad.length === 0) {
  log('')
  log('  ✓ install.cmd 是纯 ASCII 且无 BOM —— cmd.exe 在任何语言环境下都能正确读取。')
  process.exit(0)
}

/* 只报告不修，让人先看到问题 */
if (!fix) {
  log('')
  log('  ✗ 不合格。加 --fix 自动修（会剥掉非 ASCII 字节，并打印被剥掉的行）。')
  process.exit(1)
}

/* ---- 修 ---- */
log('')
log('  修复中…')

/* 去掉 BOM */
let bytes = hasBom ? buf.subarray(3) : buf

/*
 * 逐行处理：非 ASCII 只可能来自注释（代码必须 ASCII 才跑得起来），
 * 所以按行剥离，并把被改动过的行打出来，避免"静默改语义"。
 */
const text = bytes.toString('latin1') /* 逐字节保留，先不做编码解释 */
const lines = text.split(/\r?\n/)
const changed = []
const fixed = lines.map((line, idx) => {
  if (!/[\x80-\xff]/.test(line)) return line
  changed.push({ n: idx + 1, before: line })
  /* 整行剥掉非 ASCII；保留 ASCII 部分（注释标记 rem 通常还在） */
  const cleaned = line.replace(/[\x80-\xff]/g, '')
  changed[changed.length - 1].after = cleaned
  return cleaned
})

writeFileSync(TARGET, fixed.join('\r\n'), 'ascii')

log(`  去掉了 BOM` + (hasBom ? '' : '（本来就没有）'))
log(`  改动了 ${changed.length} 行：`)
for (const c of changed) {
  log(`    行 ${c.n}:`)
  log(`      原: ${c.before.trim().slice(0, 100)}`)
  log(`      新: ${c.after.trim().slice(0, 100) || '(空行)'}`)
}

/* ---- 复验 ---- */
const after = readFileSync(TARGET)
const stillBad = [...after].filter((b) => b > 0x7e).length
log('')
log(`  复验：非 ASCII ${stillBad} 个，BOM ${after[0] === 0xef ? '有' : '无'}`)
log(stillBad === 0 && after[0] !== 0xef ? '  ✓ 已修好' : '  ✗ 仍有问题')
process.exitCode = stillBad === 0 && after[0] !== 0xef ? 0 : 1
