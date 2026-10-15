/**
 * 一次性恢复脚本：把被 GBK 往返损坏的 UTF-8 文件还原。
 *
 * 损坏经过（PowerShell 5.1 的默认行为）：
 *   $c = Get-Content -Raw f      → 按 ANSI(GBK) 解码 UTF-8 字节 —— 错
 *   Set-Content -Encoding UTF8   → 把上面得到的字符串按 UTF-8 编码写回
 *
 * 因此当前文件 = 原始 UTF-8 字节 经 GBK 解码后的**已替换**字符串，再用 UTF-8 编码。
 * 反向：读取当前文件 → 去掉 BOM → 按 GBK 编码回字节 → 按 UTF-8 解码。
 *
 * 注意：GBK 解码时若遇到无法映射的字节会插入 U+FFFD，那部分信息已经丢失，
 * 需要事后人工修正。所以本脚本只做**试算与统计**，不写回，除非显式加 --write。
 */

import fs from 'node:fs'

const target = process.argv[2]
const shouldWrite = process.argv.includes('--write')
if (!target) {
  console.error('用法: node recover-gbk.mjs <文件> [--write]')
  process.exit(2)
}

const buf = fs.readFileSync(target)

// 去掉 UTF-8 BOM（损坏过程中被写入的）
let raw = buf
if (raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
  raw = raw.subarray(3)
}

// 当前文件文本（UTF-8）
const text = raw.toString('utf8')

// 反向：文本 → GBK 字节
const gbkBytes = Buffer.from(text, 'gbk')

// 再用 UTF-8 解码，得到"原始内容"的候选
const restored = gbkBytes.toString('utf8')

const badBefore = (text.match(/\uFFFD/g) || []).length
const badAfter = (restored.match(/\uFFFD/g) || []).length

console.log(JSON.stringify({
  file: target,
  currentBytes: buf.length,
  currentChars: text.length,
  currentReplacementChars: badBefore,
  gbkBytes: gbkBytes.length,
  restoredChars: restored.length,
  restoredReplacementChars: badAfter,
  head: restored.slice(0, 160),
}, null, 2))

if (shouldWrite) {
  if (badAfter > badBefore + 4) {
    console.error('拒绝写回：替换字符没有减少，说明这个文件不是该模式损坏的。')
    process.exit(1)
  }
  fs.writeFileSync(`${target}.gbkfix`, restored, 'utf8')
  console.log(`已写出候选到 ${target}.gbkfix（未覆盖原文件，请先人工核对）`)
}
