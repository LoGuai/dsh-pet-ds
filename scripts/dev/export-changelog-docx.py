# -*- coding: utf-8 -*-
"""把一份"更新日志 markdown"导出成 Word（.docx）。

输入是 `dist/V<版本>-更新日志.md`（由 build-oneclick-zip.mjs 生成），
只认它用到的几种结构：

    # 标题          → 文档标题
    > 引用          → 小号灰色说明
    ## 小标题       → Heading 1
    - 列表项        → 项目符号（行内 `code` 用等宽字体）

## 为什么用 python-docx 而不是手写 OOXML

Word 文档的样式、编号、字体（尤其东亚字体需要 `w:eastAsia`）细节很多，
手写 XML 容易出"打开是乱码/字体不对"的问题。python-docx 已在运行时里。

用法：
    python scripts/dev/export-changelog-docx.py <输入.md> <输出.docx>
"""

import re
import sys

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.ns import qn
from docx.shared import Pt, RGBColor

# 中文正文与标题字体。Word 里汉字字体必须同时设 eastAsia，否则会回落到宋体。
FONT_CJK = "微软雅黑"
FONT_MONO = "Consolas"


def set_font(run, name=FONT_CJK, size=None, bold=None, color=None, mono=False):
    """设字体（含东亚字体）。"""
    font = run.font
    font.name = FONT_MONO if mono else name
    if size is not None:
        font.size = Pt(size)
    if bold is not None:
        font.bold = bold
    if color is not None:
        font.color.rgb = RGBColor(*color)
    # 东亚字体：只设 font.name 在中文 Word 里不生效
    rpr = run._element.get_or_add_rPr()
    rfonts = rpr.find(qn("w:rFonts"))
    if rfonts is None:
        rfonts = rpr.makeelement(qn("w:rFonts"), {})
        rpr.append(rfonts)
    target = FONT_MONO if mono else name
    rfonts.set(qn("w:eastAsia"), FONT_CJK if not mono else target)
    rfonts.set(qn("w:ascii"), target)
    rfonts.set(qn("w:hAnsi"), target)


def _tokenize_inline(text):
    """把一行拆成 [(文字, 是否粗体, 是否代码)]。

    为什么用状态机而不是正则 split：
      · 正则 `\\*\\*[^*]+\\*\\*` 只能处理"同一行内成对"的粗体；
        而本文件的段落是**手工折行**的，一个粗体常常跨行 ——
        正则匹配不到，星号就漏成字面量（实测在 0.1.5 段里到处都是）；
      · 粗体里还嵌行内代码（`**离线机器应改用 `setup.exe`**`），
        单层 split 会把反引号一起当普通文字。
    状态机同时跟踪两个开关，嵌套与"未闭合"都能安全退化（只影响样式，不漏字符）。
    """
    out = []
    buf = ""
    bold = False
    code = False
    i = 0
    while i < len(text):
        if text.startswith("`", i):
            if buf:
                out.append((buf, bold, code))
                buf = ""
            code = not code
            i += 1
        elif text.startswith("**", i):
            if buf:
                out.append((buf, bold, code))
                buf = ""
            bold = not bold
            i += 2
        else:
            buf += text[i]
            i += 1
    if buf:
        out.append((buf, bold, code))
    return out


def add_rich_text(paragraph, text, size=11, bold=False, color=None):
    """渲染一行行内 markdown。

    支持：`**粗体**`、`` `代码` ``、`[文字](网址)`（只保留文字）。
    逐个 run 设置字体 —— 中文必须带 `w:eastAsia`，见 set_font。
    """
    # 链接降级为纯文字：日志里的链接都是"参考规范"类外链，保留网址反而碍眼
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)

    for chunk, is_bold, is_code in _tokenize_inline(text):
        if chunk == "":
            continue
        run = paragraph.add_run(chunk)
        set_font(
            run,
            size=size - 0.5 if is_code else size,
            bold=bold or is_bold,
            color=color,
            mono=is_code,
        )


def main():
    if len(sys.argv) < 3:
        print("  用法：export-changelog-docx.py <输入.md> <输出.docx>")
        return 1
    src, dst = sys.argv[1], sys.argv[2]

    with open(src, "r", encoding="utf-8") as fh:
        lines = fh.read().splitlines()

    doc = Document()

    # 页边距收一点，日志偏短、正文多，留白太多显空
    for section in doc.sections:
        section.top_margin = Pt(56)
        section.bottom_margin = Pt(56)
        section.left_margin = Pt(64)
        section.right_margin = Pt(64)

    # 正文默认字体
    normal = doc.styles["Normal"]
    normal.font.name = FONT_CJK
    normal.font.size = Pt(11)
    normal.element.rPr.rFonts.set(qn("w:eastAsia"), FONT_CJK)

    for raw in lines:
        line = raw.rstrip()
        if not line.strip():
            continue

        if line.startswith("# "):
            p = doc.add_paragraph()
            p.alignment = WD_ALIGN_PARAGRAPH.LEFT
            run = p.add_run(line[2:].strip())
            set_font(run, size=20, bold=True, color=(0x1F, 0x3B, 0x63))
            p.paragraph_format.space_after = Pt(6)

        elif line.startswith("## "):
            p = doc.add_paragraph(style="Heading 1")
            head = line[3:].strip()
            # `[0.2.0] - 2026-10-18` → `0.2.0 · 2026-10-18`
            # 方括号是 Keep a Changelog 的写法，在 Word 里读起来像代码，去掉更顺眼。
            m = re.match(r"^\[(.+?)\]\s*(?:-\s*(.+))?$", head)
            if m:
                head = m.group(1) if not m.group(2) else f"{m.group(1)} · {m.group(2)}"
            run = p.add_run(head)
            set_font(run, size=14, bold=True, color=(0x1F, 0x3B, 0x63))
            p.paragraph_format.space_before = Pt(14)
            p.paragraph_format.space_after = Pt(6)

        elif line.startswith("### "):
            p = doc.add_paragraph(style="Heading 2")
            run = p.add_run(line[4:].strip())
            set_font(run, size=12, bold=True, color=(0x2A, 0x4C, 0x7A))
            p.paragraph_format.space_before = Pt(10)
            p.paragraph_format.space_after = Pt(4)

        elif line.startswith("#### "):
            p = doc.add_paragraph(style="Heading 3")
            run = p.add_run(line[5:].strip())
            set_font(run, size=11, bold=True, color=(0x33, 0x33, 0x33))
            p.paragraph_format.space_before = Pt(8)
            p.paragraph_format.space_after = Pt(3)

        elif line.startswith("> "):
            p = doc.add_paragraph()
            add_rich_text(p, line[2:].strip(), size=9.5, color=(0x77, 0x7F, 0x8A))
            p.paragraph_format.space_after = Pt(10)

        elif line.startswith("- "):
            p = doc.add_paragraph(style="List Bullet")
            add_rich_text(p, line[2:].strip(), size=11)
            p.paragraph_format.space_after = Pt(4)

        else:
            p = doc.add_paragraph()
            add_rich_text(p, line.strip(), size=11)

    doc.save(dst)
    # ⚠️ 只用 ASCII 打印：中文 Windows 的控制台是 GBK，
    # 打印 "✓" 之类会抛 UnicodeEncodeError，看起来像"生成失败"（实际文件已写好）。
    print(f"  OK {dst}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
