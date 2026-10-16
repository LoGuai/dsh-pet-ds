# -*- coding: utf-8 -*-
"""把一张目录里的 PNG 缩小拼成对比图。

为什么需要：替换拖拽动画时最关键的问题是**末尾帧的姿势对不对**
（"播放完成后维持最后一帧"意味着那一帧会被长期显示）。
光看文件名和尺寸看不出来，必须看图。

用法：
    python scripts/dev/make-contact-sheet.py <输入目录> <输出png> [每行张数]

注意：本文件必须带 `# -*- coding: utf-8 -*-` 声明。Windows 上的 Python
会按系统 ANSI 代码页（中文机器上是 GBK）读源文件，没有声明时中文注释会
变成乱码并触发 SyntaxError（实测踩过）。
"""

import os
import sys

from PIL import Image


def thumb(path, size=220):
    im = Image.open(path).convert("RGBA")
    im.thumbnail((size, size), Image.LANCZOS)
    return im


def main():
    if len(sys.argv) < 3:
        print("用法：make-contact-sheet.py <输入目录> <输出png> [每行张数]")
        return 2

    src, out = sys.argv[1], sys.argv[2]
    cols = int(sys.argv[3]) if len(sys.argv) > 3 else 6

    def sort_key(name):
        digits = "".join(c for c in os.path.splitext(name)[0] if c.isdigit())
        return int(digits) if digits else 0

    files = sorted(
        (f for f in os.listdir(src) if f.lower().endswith(".png")),
        key=sort_key,
    )
    if not files:
        print("目录里没有 PNG：" + src)
        return 1

    thumbs = [thumb(os.path.join(src, f)) for f in files]
    cw = max(t.width for t in thumbs)
    ch = max(t.height for t in thumbs)
    rows = (len(thumbs) + cols - 1) // cols

    # 深色底，便于看透明边缘
    sheet = Image.new("RGBA", (cols * cw, rows * ch), (32, 34, 40, 255))
    for i, t in enumerate(thumbs):
        x = (i % cols) * cw + (cw - t.width) // 2
        y = (i // cols) * ch + (ch - t.height) // 2
        sheet.alpha_composite(t, (x, y))

    sheet.convert("RGB").save(out, "PNG")
    print("已生成 %s（%d 张，%dx%d）" % (out, len(thumbs), sheet.width, sheet.height))
    print("顺序：" + ", ".join(files))
    return 0


if __name__ == "__main__":
    sys.exit(main())
