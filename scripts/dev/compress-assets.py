# -*- coding: utf-8 -*-
"""把 `assets/animations/*/frame_*.png` 转成 WebP，减小包体。

## 为什么是 WebP 有损 q92

实测（stand/sit-circle/eat/hang 四帧，864×1157 RGBA）：

| 方案 | 体积 | 可见像素 PSNR（RGB） | alpha |
|---|---|---|---|
| PNG 无损优化 | 96~100% | 无限（无损） | 无损 |
| WebP 无损 | **69~71%** | 无限（无损） | 无损 |
| WebP q92 | **19~23%** | ~34.5 dB | **无损**（99 dB） |
| WebP q90 | 18~21% | ~34.2 dB | 无损 |
| 缩到 720 + PNG | 72~76% | ~24 dB（缩放导致边缘软化） | 46 dB |

关键结论：
  · PNG 无损优化几乎没用（<5%）；
  · **WebP 有损 q92 体积只有 20%，而 alpha 完全无损** —— 桌宠的轮廓/阴影边缘
    不会出现 PNG 调色板那种硬边；
  · 目视验收（缩到实际显示尺寸 240/400 px）与原图**无法区分**，
    1:1 才有极轻微差异。

所以选 WebP q92：`quality=92, alpha_quality=100, method=6`。

## 幂等

已经有 `.webp` 的帧会跳过；`.png` 转完即删。可以反复运行。

## 清单同步

`manifest.json` 的 `_processing.perFrame[].out` 里写着 `frame_01.png`，
必须改成 `.webp`，否则清单与磁盘对不上（诊断时会被误导）。

用法：
  python scripts/dev/compress-assets.py            # 转换（默认 q92）
  python scripts/dev/compress-assets.py --quality 90
  python scripts/dev/compress-assets.py --dry-run  # 只报告，不写盘
"""

import argparse
import io
import json
import os
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ANIM_ROOT = os.path.join(ROOT, "assets", "animations")


def convert_frame(png_path, quality, dry_run):
    """转一帧；返回 (原始字节, 新字节, 是否改动)。"""
    img = Image.open(png_path).convert("RGBA")
    buf = io.BytesIO()
    img.save(buf, format="WEBP", quality=quality, alpha_quality=100, method=6)
    data = buf.getvalue()
    orig = os.path.getsize(png_path)
    if dry_run:
        return orig, len(data), False

    webp_path = png_path[:-4] + ".webp"
    with open(webp_path, "wb") as fh:
        fh.write(data)
    # 先写新文件、再删旧文件：中途失败也不会丢素材
    os.remove(png_path)
    return orig, len(data), True


def sync_manifest(action_dir, dry_run):
    """把清单里的帧文件名改成 .webp。"""
    path = os.path.join(action_dir, "manifest.json")
    if not os.path.isfile(path):
        return 0
    with open(path, "r", encoding="utf-8") as fh:
        raw = fh.read()
    data = json.loads(raw)
    changed = 0
    for item in data.get("_processing", {}).get("perFrame", []):
        out = item.get("out")
        if isinstance(out, str) and out.endswith(".png"):
            item["out"] = out[:-4] + ".webp"
            changed += 1
    if changed and not dry_run:
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
    return changed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--quality", type=int, default=92)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    total_orig = 0
    total_new = 0
    frames = 0
    skipped = 0

    print("  压缩素材 → WebP q%d%s" % (args.quality, "（dry-run）" if args.dry_run else ""))
    print("  %-14s %5s %10s %10s %8s" % ("动作", "帧", "原 KB", "新 KB", "压缩率"))
    print("  " + "-" * 54)

    for action in sorted(os.listdir(ANIM_ROOT)):
        action_dir = os.path.join(ANIM_ROOT, action)
        if not os.path.isdir(action_dir):
            continue
        names = sorted(
            f for f in os.listdir(action_dir)
            if f.startswith("frame_") and f.endswith(".png")
        )
        if not names:
            continue
        a_orig = 0
        a_new = 0
        for name in names:
            p = os.path.join(action_dir, name)
            o, n, _ = convert_frame(p, args.quality, args.dry_run)
            a_orig += o
            a_new += n
            frames += 1
        total_orig += a_orig
        total_new += a_new
        print("  %-14s %5d %10.0f %10.0f %7.1f%%"
              % (action, len(names), a_orig / 1024, a_new / 1024, a_new / a_orig * 100))
        sync_manifest(action_dir, args.dry_run)

    # 统计已是 webp 的
    for action in sorted(os.listdir(ANIM_ROOT)):
        action_dir = os.path.join(ANIM_ROOT, action)
        if os.path.isdir(action_dir):
            skipped += sum(1 for f in os.listdir(action_dir) if f.endswith(".webp"))

    print("  " + "-" * 54)
    print("  本次转换 %d 帧；已存在 .webp %d 帧" % (frames, skipped))
    if total_orig:
        print("  合计 %.2f MB → %.2f MB（%.1f%%）"
              % (total_orig / 1024 / 1024, total_new / 1024 / 1024, total_new / total_orig * 100))


if __name__ == "__main__":
    main()
