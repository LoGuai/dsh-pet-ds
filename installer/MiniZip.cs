// 极简 ZIP 解压器（只做"解压我们自己打包的载荷"这一件事）。
//
// ============================================================
// 为什么不用 System.IO.Compression.ZipFile
// ============================================================
//
// `ZipFile` 是 **.NET Framework 4.5** 才加入的。而本安装程序用 Windows 自带的
// csc.exe 编译，那是 **4.0** 版本的编译器。若直接用 `ZipFile`：
//
//   · 编译期要靠 `<Reference>` 能找到 4.5 的程序集；
//   · **运行期要求目标机装了 .NET 4.5+**。Windows 8.1 及以后自带，
//     但 Windows 7 / 早期 Windows 8 只带 4.0 —— 那些机器上会直接崩。
//
// 而 `DeflateStream` 从 **.NET 2.0** 就有，覆盖面大得多。
// 所以这里自己解析 ZIP 结构：只读**中央目录**（比顺序读本地头更可靠，
// 也不受可选字段影响），再用 `DeflateStream` 解每个条目。
//
// ============================================================
// 只支持我们自己的载荷
// ============================================================
//
// 不做通用 ZIP 库。刻意**不支持**：
//   · ZIP64（载荷 115 MB，远不到 4 GB 门槛）
//   · 加密
//   · 多卷
//   · 除 deflate(8) 与 stored(0) 之外的压缩方法
//
// 遇到不支持的情况**明确抛异常**，绝不静默跳过 ——
// 静默跳过会得到一个"看起来装好了、其实缺文件"的安装，
// 那比直接失败难查得多。

using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Text;

namespace DshPetSetup
{
    internal sealed class MiniZip
    {
        /** 中央目录结束标记（EOCD）的签名字节。 */
        private static readonly byte[] EocdSignature = { 0x50, 0x4b, 0x05, 0x06 };
        /** 中央目录条目的签名（"PK\1\2"）。 */
        private const uint CentralSignature = 0x02014b50;

        /**
         * 把 zip 的全部条目解到 destinationDir。
         *
         * @param zip zip 的完整字节
         * @param destinationDir 目标根目录（会按需创建）
         * @param onEntry 每解出一个条目回调一次（用于进度显示），可为 null
         * @returns 解出的文件数
         */
        internal int ExtractAll(byte[] zip, string destinationDir, Action<string> onEntry)
        {
            if (zip == null || zip.Length < 22) throw new InvalidDataException("载荷为空或过小。");
            var entries = ReadCentralDirectory(zip);
            if (entries.Count == 0) throw new InvalidDataException("载荷里没有任何文件。");

            Directory.CreateDirectory(destinationDir);
            var rootFull = Path.GetFullPath(destinationDir);
            var count = 0;

            foreach (var e in entries)
            {
                /*
                 * 目录条目：建目录即可。
                 *
                 * ⚠️ 这里有个坑（实测踩到）：`Path.GetFullPath` 会**去掉结尾的
                 * 分隔符**，所以 `assets/animations/` 会变成 `...\assets\animations`
                 * —— 末段被当成文件名，而父目录 `assets` 此时还不存在，
                 * `Directory.CreateDirectory` 就抛
                 * `DirectoryNotFoundException: 未能找到路径"…\assets\animations\"的一部分`。
                 *
                 * 正确做法：**先建父目录**，再建自己。这样无论结尾有没有分隔符都成立。
                 */
                if (e.Name.EndsWith("/", StringComparison.Ordinal) ||
                    e.Name.EndsWith("\\", StringComparison.Ordinal))
                {
                    var dir = SafeCombine(rootFull, e.Name);
                    var dirParent = Path.GetDirectoryName(dir.TrimEnd(Path.DirectorySeparatorChar));
                    if (!string.IsNullOrEmpty(dirParent)) Directory.CreateDirectory(dirParent);
                    Directory.CreateDirectory(dir);
                    continue;
                }

                var target = SafeCombine(rootFull, e.Name);
                var parent = Path.GetDirectoryName(target);
                if (!string.IsNullOrEmpty(parent)) Directory.CreateDirectory(parent);

                using (var output = File.Create(target))
                {
                    WriteEntry(zip, e, output);
                }
                count++;
                if (onEntry != null) onEntry(e.Name);
            }
            return count;
        }

        /**
         * 把相对路径安全地拼到根目录下，**挡住目录穿越**。
         *
         * 载荷是我们自己打的，理论上不会有 `..\`；但"理论上"不该是
         * 安全边界 —— 万一载荷被替换过，一个 `../../` 就能写到安装目录之外。
         */
        private static string SafeCombine(string rootFull, string relative)
        {
            var cleaned = relative.Replace('/', Path.DirectorySeparatorChar);
            var full = Path.GetFullPath(Path.Combine(rootFull, cleaned));
            var rootWithSep = rootFull.EndsWith(Path.DirectorySeparatorChar.ToString())
                ? rootFull
                : rootFull + Path.DirectorySeparatorChar;
            if (!full.StartsWith(rootWithSep, StringComparison.OrdinalIgnoreCase) &&
                !string.Equals(full, rootFull, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidDataException("载荷里的路径越出了安装目录，已拒绝：" + relative);
            }
            return full;
        }

        // ------------------------------------------------------------ ZIP 结构
        private sealed class Entry
        {
            internal string Name;
            internal ushort Method;
            internal uint CompressedSize;
            internal uint UncompressedSize;
            internal uint LocalHeaderOffset;
        }

        /**
         * 从**末尾**往回找 EOCD，再顺着它读中央目录。
         *
         * 为什么从末尾找：EOCD 之后可以有任意长度的注释（最多 65535 字节），
         * 所以它不一定在最后 22 字节处。
         */
        private static List<Entry> ReadCentralDirectory(byte[] zip)
        {
            var eocd = -1;
            var minPos = Math.Max(0, zip.Length - 22 - 65535);
            for (var i = zip.Length - 22; i >= minPos; i--)
            {
                if (zip[i] == EocdSignature[0] && zip[i + 1] == EocdSignature[1] &&
                    zip[i + 2] == EocdSignature[2] && zip[i + 3] == EocdSignature[3])
                {
                    eocd = i;
                    break;
                }
            }
            if (eocd < 0) throw new InvalidDataException("载荷不是有效的 zip（找不到中央目录结束标记）。");

            var total = ReadUInt16(zip, eocd + 10);
            var cdSize = ReadUInt32(zip, eocd + 12);
            var cdOffset = ReadUInt32(zip, eocd + 16);

            if (total == 0xffff || cdSize == 0xffffffff || cdOffset == 0xffffffff)
                throw new InvalidDataException("载荷是 ZIP64 格式，本安装程序不支持。");

            if (cdOffset + cdSize > (uint)zip.Length)
                throw new InvalidDataException("载荷的中央目录位置越界，文件可能损坏。");

            var list = new List<Entry>(total);
            var p = (int)cdOffset;
            for (var n = 0; n < total; n++)
            {
                if (p + 46 > zip.Length || ReadUInt32(zip, p) != CentralSignature)
                    throw new InvalidDataException("载荷的中央目录损坏（第 " + (n + 1) + " 条）。");

                var method = ReadUInt16(zip, p + 10);
                var compSize = ReadUInt32(zip, p + 20);
                var uncompSize = ReadUInt32(zip, p + 24);
                var nameLen = ReadUInt16(zip, p + 28);
                var extraLen = ReadUInt16(zip, p + 30);
                var commentLen = ReadUInt16(zip, p + 32);
                var localOffset = ReadUInt32(zip, p + 42);
                var name = Encoding.UTF8.GetString(zip, p + 46, nameLen);

                list.Add(new Entry
                {
                    Name = name,
                    Method = method,
                    CompressedSize = compSize,
                    UncompressedSize = uncompSize,
                    LocalHeaderOffset = localOffset,
                });
                p += 46 + nameLen + extraLen + commentLen;
            }
            return list;
        }

        /** 按条目的本地头定位数据并写入输出流。 */
        private static void WriteEntry(byte[] zip, Entry e, Stream output)
        {
            var lh = (int)e.LocalHeaderOffset;
            if (lh + 30 > zip.Length) throw new InvalidDataException("条目越界：" + e.Name);
            // 本地头的 name/extra 长度可能与中央目录不同，必须以**本地头**为准
            var nameLen = ReadUInt16(zip, lh + 26);
            var extraLen = ReadUInt16(zip, lh + 28);
            var dataStart = lh + 30 + nameLen + extraLen;
            var dataEnd = dataStart + (int)e.CompressedSize;
            if (dataEnd > zip.Length) throw new InvalidDataException("条目数据越界：" + e.Name);

            if (e.Method == 0)
            {
                // stored：原样拷贝
                output.Write(zip, dataStart, (int)e.CompressedSize);
                return;
            }
            if (e.Method != 8)
            {
                throw new InvalidDataException(
                    "条目用了不支持的压缩方式（method=" + e.Method + "）：" + e.Name);
            }

            // deflate：DeflateStream 读的是**裸 deflate** 流，而 zip 里正好就是裸的
            // （zlib 的 2 字节头尾不在 zip 条目里），所以能直接接。
            using (var input = new MemoryStream(zip, dataStart, (int)e.CompressedSize, false))
            using (var deflate = new DeflateStream(input, CompressionMode.Decompress))
            {
                var buffer = new byte[64 * 1024];
                int read;
                while ((read = deflate.Read(buffer, 0, buffer.Length)) > 0)
                {
                    output.Write(buffer, 0, read);
                }
            }
        }

        private static ushort ReadUInt16(byte[] b, int offset)
        {
            return (ushort)(b[offset] | (b[offset + 1] << 8));
        }

        private static uint ReadUInt32(byte[] b, int offset)
        {
            return (uint)(b[offset] | (b[offset + 1] << 8) | (b[offset + 2] << 16) | (b[offset + 3] << 24));
        }
    }
}
