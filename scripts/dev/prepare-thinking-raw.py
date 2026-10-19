# -*- coding: utf-8 -*-
"""把 thinking 素材加工成与现有素材一致的形式（并写出预览供目视）。

## 两批素材的差异

· `thinking_pre`（1~6）：RGBA、透明底，**与现有素材同规格**，只需要重排（进入用 1→6，
  退出用 6→1）。
· `thinking`（1~4）：RGB、**纯黑底**、而且顶部有一个"深度求索中…"的气泡。
  直接当素材用会出现一个黑方块把桌宠框住 —— 必须先抠成透明。

## 黑底怎么抠

素材是"黑底上画的角色"，背景亮度 ≤ 3。做法：
  1. 从四边洪水填充**亮度 ≤ 阈值**的连通区域 → 这才是"背景"；
     不能只按亮度一刀切，否则角色内部的深色（深蓝头发、描边）会被吃掉。
  2. 边界留一段软过渡：把贴近背景的一圈像素按亮度做 alpha 斜坡，避免硬锯齿。

## 气泡怎么去掉

气泡是白色圆角矩形 + 深色文字。**不能按矩形整块删** —— 实测它的包围盒里
混着头发与白色蕾丝头饰（框内 43% 是头发），矩形会把头饰削掉。

改成：
  1. 只在**顶部窗口**（y < 205，够不到头发卷）里找白色；
  2. 形态学闭运算（先膨胀后腐蚀）把"文字"并进白色块 —— 文字在气泡内部，
     闭合后气泡变成一个实心块；
  3. 从气泡中心洪水填充取最大连通域（排除头饰那种零散白点）；
  4. 再轻微膨胀覆盖气泡的描边与阴影，该区域 alpha 置 0。
"""

import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

RAW = r"D:\dsh\pet\.cache\thinking-raw"
OUT_PREVIEW = r"D:\dsh\pet\.cache\thinking-preview"
ENTER_RAW = r"D:\dsh\pet\.cache\think-enter-raw"
LOOP_RAW = r"D:\dsh\pet\.cache\think-loop-raw"
EXIT_RAW = r"D:\dsh\pet\.cache\think-exit-raw"

BG_LUM = 16          # 背景判定：最大通道 ≤ 16
SOFT_LO, SOFT_HI = 6, 26   # 边界 alpha 斜坡（亮度）
BUBBLE_MAX_Y = 205   # 气泡窗口下界（原图坐标，够不到头发卷）
BUBBLE_CLOSE = 7     # 闭运算核（奇数）
BUBBLE_GROW = 3      # 最后再膨胀几像素（覆盖描边/阴影）
# 气泡下面还有一层**灰色投影**：不是纯黑（没被背景键吃掉），也不是白（不在白块里），
# 单独按"低饱和 + 中低亮度"清掉。头发是饱和蓝（max-min 很大），不会被误伤；
# 白色蕾丝很亮（>150），也不受影响。
SHADOW_MAX_LUM = 110
SHADOW_MAX_SAT = 30


def luminance(rgb):
    return rgb.max(axis=2).astype(np.int16)


def key_black(img):
    """黑底 → 透明，返回 (RGBA, 背景掩码)。

    ⚠️ 踩坑：Pillow 12 的 `ImageDraw.floodfill` 在 **"L" 单通道图上是静默无效的**
    —— 不报错、一个像素都不填（实测：20×20 测试图里期望 300 像素，实际 0）。
    转成 RGB 后再填就正常（同样测试图 300/300）。所以这里用 RGB 做掩码：
    背景 (0,0,0)、主体 (255,255,255)、填充值 (128,128,128)。
    """
    rgb = np.asarray(img.convert("RGB")).astype(np.uint8)
    lum = luminance(rgb)
    h, w = lum.shape

    # 1) 从四边洪水填充背景
    bin_img = Image.fromarray(
        np.where(lum <= BG_LUM, 0, 255).astype(np.uint8), "L"
    ).convert("RGB")
    for seed in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)):
        if bin_img.getpixel(seed) == (0, 0, 0):
            ImageDraw.floodfill(bin_img, seed, (128, 128, 128), thresh=BG_LUM)
    filled = np.asarray(bin_img)
    bg = np.all(filled == 128, axis=2)

    # 2) alpha：背景 0；背景边缘一圈按亮度做软过渡；其余 255
    alpha = np.full((h, w), 255, dtype=np.uint8)
    alpha[bg] = 0

    near = np.asarray(bin_img.convert("L").filter(ImageFilter.MaxFilter(3))) == 128
    band = near & ~bg
    ramp = np.clip((lum - SOFT_LO) / max(1, SOFT_HI - SOFT_LO), 0.0, 1.0)
    alpha[band] = (ramp[band] * 255).astype(np.uint8)

    out = np.dstack([rgb, alpha])
    return Image.fromarray(out, "RGBA"), bg


def bubble_mask(lum, existing_bg):
    """返回气泡区域掩码（True = 要清成透明）。"""
    h, w = lum.shape
    # 只在顶部窗口内工作
    win = np.zeros((h, w), dtype=bool)
    win[: min(h, BUBBLE_MAX_Y), :] = True

    rgb_white = lum >= 150  # 亮度够高（白/浅灰）
    cand = rgb_white & win & ~existing_bg

    m = Image.fromarray((cand * 255).astype(np.uint8), "L")
    # 闭运算：把文字并进白块
    m = m.filter(ImageFilter.MaxFilter(BUBBLE_CLOSE)).filter(ImageFilter.MinFilter(BUBBLE_CLOSE))

    arr = np.asarray(m) > 128
    if not arr.any():
        return np.zeros((h, w), dtype=bool)

    # 从白色像素的重心洪水填充，取最大连通域
    # （同样必须用 RGB —— 见 key_black 里关于 Pillow 12 floodfill 的说明）
    ys, xs = np.where(arr)
    seed = (int(xs.mean()), int(ys.mean()))
    if not arr[seed[1], seed[0]]:
        seed = (int(xs[len(xs) // 2]), int(ys[len(ys) // 2]))
    flood = Image.fromarray((arr * 255).astype(np.uint8), "L").convert("RGB")
    ImageDraw.floodfill(flood, seed, (200, 200, 200), thresh=1)
    comp = np.all(np.asarray(flood) == 200, axis=2)
    if comp.sum() < 5000:  # 太小说明没抓到气泡
        return np.zeros((h, w), dtype=bool)

    cm = Image.fromarray((comp * 255).astype(np.uint8), "L")
    if BUBBLE_GROW > 0:
        cm = cm.filter(ImageFilter.MaxFilter(BUBBLE_GROW * 2 + 1))
    return np.asarray(cm) > 128


def process_loop(src, dst, preview_name=None):
    img = Image.open(src).convert("RGB")
    rgba, bg = key_black(img)
    a = np.asarray(rgba).astype(np.uint8)
    rgb = np.asarray(img.convert("RGB")).astype(np.int16)
    lum = luminance(rgb)
    sat = rgb.max(axis=2) - rgb.min(axis=2)

    # 1) 气泡本体（白块 + 文字）
    bub = bubble_mask(lum, bg)
    a[bub, 3] = 0

    # 2) 气泡投影：顶部窗口里"低饱和 + 中低亮度"的像素一并清掉
    win = np.zeros(lum.shape, dtype=bool)
    win[: min(lum.shape[0], BUBBLE_MAX_Y), :] = True
    shadow = win & (lum <= SHADOW_MAX_LUM) & (sat <= SHADOW_MAX_SAT)
    a[shadow, 3] = 0

    out = Image.fromarray(a, "RGBA")
    out.save(dst)

    if preview_name:
        small = out.resize((400, round(out.height * 400 / out.width)), Image.LANCZOS)
        bgc = Image.new("RGB", small.size, (210, 210, 210))
        for yy in range(0, small.height, 16):
            for xx in range(0, small.width, 16):
                if (xx // 16 + yy // 16) % 2:
                    ImageDraw.Draw(bgc).rectangle(
                        [xx, yy, xx + 15, yy + 15], fill=(185, 185, 185))
        bgc.paste(small, (0, 0), small)
        bgc.save(os.path.join(OUT_PREVIEW, preview_name))
    return out


def main():
    for d in (ENTER_RAW, LOOP_RAW, EXIT_RAW):
        os.makedirs(d, exist_ok=True)
        for f in os.listdir(d):
            if f.endswith(".png"):
                os.remove(os.path.join(d, f))

    # 进入：pre 1→6
    for i in range(1, 7):
        src = os.path.join(RAW, "pre", f"{i}.png")
        Image.open(src).convert("RGBA").save(os.path.join(ENTER_RAW, f"{i}.png"))
    print(f"  enter：{6} 帧（pre 1→6）")

    # 退出：pre 6→1
    for i in range(1, 7):
        src = os.path.join(RAW, "pre", f"{7 - i}.png")
        Image.open(src).convert("RGBA").save(os.path.join(EXIT_RAW, f"{i}.png"))
    print(f"  exit ：{6} 帧（pre 6→1）")

    # 循环：黑底 → 透明 + 去气泡
    n = 0
    for i in range(1, 5):
        src = os.path.join(RAW, "loop", f"{i}.png")
        if not os.path.isfile(src):
            continue
        preview = f"keys-loop{i}.png" if i in (1, 2) else None
        process_loop(src, os.path.join(LOOP_RAW, f"{i}.png"), preview)
        n += 1
    print(f"  loop ：{n} 帧（黑底已抠，气泡已去）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
