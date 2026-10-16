/**
 * 读取 PE 文件里**真正生效的**应用程序清单（`RT_MANIFEST` 资源，ID 1）。
 *
 * ## 为什么需要它
 *
 * 验证"`setup.exe` 有没有请求管理员权限"时，我第一版直接把整个 exe 当 UTF-8
 * 文本搜 `requireAdministrator` / `asInvoker`。结果**误判**：
 *
 *   · 真正的清单资源是 **UTF-16** 编码，用 UTF-8 搜根本搜不到它；
 *   · 而 `csc` 会把清单源的 XML 文本也存进 exe，于是**我校验脚本里的注释**
 *     （里面同时写到了 `asInvoker` 和 `requireAdministrator` 这两个词）
 *     被当成了清单内容 —— 两种都命中，断言自然过不去。
 *
 * 所以必须**按 Windows 的方式**去拿清单：走 PE 的 `.rsrc` 段 → 资源目录 →
 * 类型 `RT_MANIFEST(24)` → ID `1` → 数据项，然后把那段字节按 UTF-16LE 解码。
 * 拿到的才是系统真正会读的那份。
 *
 * ## 只做必要的事
 *
 * 不引第三方库（构建脚本应当零依赖），只解析到需要的那几层：
 * DOS 头 → PE 头 → 可选头 → 数据目录[2]（资源表）→ 三层资源目录 → 数据项。
 */

import { readFileSync } from 'node:fs'

/** 在缓冲区里按小端读 16 位。 */
const u16 = (b, o) => b.readUInt16LE(o)
/** 在缓冲区里按小端读 32 位。 */
const u32 = (b, o) => b.readUInt32LE(o)

const RT_MANIFEST = 24

/**
 * 从资源目录里找某个 (类型, 名字) 的数据项，返回其在文件中的偏移与长度。
 *
 * PE 资源目录是三层树：
 *   第 1 层按类型（RT_MANIFEST = 24）
 *   第 2 层按名字/ID（清单固定是 1）
 *   第 3 层是语言，叶子是 `IMAGE_RESOURCE_DATA_ENTRY`
 */
function findResourceEntry(buf, resBase, resSize, type, name) {
  /* IMAGE_RESOURCE_DIRECTORY = 16 字节头（含 2 个计数），后面跟条目数组。 */
  const dirEntries = (dirOffset) => {
    const named = u16(buf, resBase + dirOffset + 12)
    const ided = u16(buf, resBase + dirOffset + 14)
    const first = resBase + dirOffset + 16
    const out = []
    for (let i = 0; i < named + ided; i++) {
      const e = first + i * 8
      out.push({
        name: u32(buf, e), // 高位为 1 表示是个字符串偏移，否则是 ID
        offset: u32(buf, e + 4), // 高位为 1 表示指向子目录，否则指向数据项
      })
    }
    return out
  }

  /* 第 1 层：找类型 */
  for (const t of dirEntries(0)) {
    const tId = t.name & 0x80000000 ? -1 : t.name
    if (tId !== type) continue
    if (!(t.offset & 0x80000000)) continue

    /* 第 2 层：找名字/ID */
    for (const n of dirEntries(t.offset & 0x7fffffff)) {
      const nId = n.name & 0x80000000 ? -1 : n.name
      if (nId !== name) continue
      if (!(n.offset & 0x80000000)) continue

      /* 第 3 层：语言，取第一个即可 */
      for (const l of dirEntries(n.offset & 0x7fffffff)) {
        if (l.offset & 0x80000000) continue
        const dataEntry = resBase + l.offset
        return {
          /* IMAGE_RESOURCE_DATA_ENTRY: OffsetToData(4) Size(4) CodePage(4) Reserved(4) */
          offset: u32(buf, dataEntry),
          size: u32(buf, dataEntry + 4),
        }
      }
    }
  }
  void resSize
  return null
}

/**
 * 读取 exe 里生效的应用清单。
 *
 * @param {string} file exe 路径
 * @returns {string | null} 清单 XML 文本；找不到返回 null
 */
export function readEmbeddedManifest(file) {
  const buf = readFileSync(file)

  /* ---- DOS 头：e_lfanew(0x3C) 指向 PE 签名 ---- */
  if (buf.length < 0x40 || u16(buf, 0) !== 0x5a4d) return null // 'MZ'
  const peOff = u32(buf, 0x3c)
  if (u32(buf, peOff) !== 0x00004550) return null // 'PE\0\0'

  /* ---- COFF 头 20 字节，其后是可选头 ---- */
  const optOff = peOff + 24
  const magic = u16(buf, optOff)
  const is64 = magic === 0x20b
  if (magic !== 0x10b && !is64) return null

  /*
   * 数据目录从可选头偏移 96（PE32）或 112（PE32+）开始，
   * 每项 8 字节（RVA + Size）；资源表是第 3 项（索引 2）。
   */
  const ddOff = optOff + (is64 ? 112 : 96)
  const resRva = u32(buf, ddOff + 2 * 8)
  const resSize = u32(buf, ddOff + 2 * 8 + 4)
  if (resRva === 0) return null

  /* ---- RVA → 文件偏移：遍历节表 ---- */
  const nSections = u16(buf, peOff + 6)
  const sizeOpt = u16(buf, peOff + 20)
  const secOff = optOff + sizeOpt
  const rvaToOff = (rva) => {
    for (let i = 0; i < nSections; i++) {
      const s = secOff + i * 40
      const vAddr = u32(buf, s + 12)
      const vSize = u32(buf, s + 8)
      const rawSize = u32(buf, s + 16)
      const rawPtr = u32(buf, s + 20)
      if (rva >= vAddr && rva < vAddr + Math.max(vSize, rawSize)) return rawPtr + (rva - vAddr)
    }
    return null
  }

  const resBase = rvaToOff(resRva)
  if (resBase == null) return null

  const entry = findResourceEntry(buf, resBase, resSize, RT_MANIFEST, 1)
  if (!entry) return null

  const off = rvaToOff(entry.offset)
  if (off == null) return null

  const bytes = buf.subarray(off, off + entry.size)
  /*
   * 清单资源通常是 UTF-16LE。用 `utf16le` 解码，并剥掉 BOM。
   * 若发现全是 0（说明其实是 ASCII），再退回 utf8。
   */
  let text = bytes.toString('utf16le')
  if (!/<\s*\?xml|<\s*assembly/i.test(text)) text = bytes.toString('utf8')
  return text.replace(/^\uFEFF/, '')
}

/**
 * 解析清单里的 `requestedExecutionLevel` 级别。
 *
 * 用**只匹配元素**的正则，而不是全文件搜索字符串 ——
 * 因为 XML 注释里也可能写到这些词（我正是这么踩坑的）。
 *
 * @returns {'requireAdministrator'|'highestAvailable'|'asInvoker'|null}
 */
export function manifestExecutionLevel(manifestText) {
  if (!manifestText) return null
  /* 先把 XML 注释去掉，避免注释里的词被当成配置。 */
  const noComments = manifestText.replace(/<!--[\s\S]*?-->/g, '')
  const m = /<requestedExecutionLevel\b[^>]*\blevel\s*=\s*"([^"]+)"/i.exec(noComments)
  return m ? m[1] : null
}
