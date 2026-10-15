"""
把动作素材处理成与站立素材同一套画布约定。

处理的每一步都与站立素材保持一致，这样切动作时角色位置不会跳：
 1. 裁掉内容四周的透明留白（按内容包围盒）；
 2. 必要时缩放到能完整装进画布；
 3. 水平居中、**脚底对齐到与站立相同的基准线**。

用法:
    python scripts/dev/build-action-asset.py eat
    python scripts/dev/build-action-asset.py hang
    python scripts/dev/build-action-asset.py all

每个动作的配置见下面的 ACTIONS。新增动作时在 ACTIONS 里加一条即可。
"""

import json
import os
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
STAND_DIR = os.path.join(ROOT, "assets", "animations", "stand")

ALPHA_THRESHOLD = 8
# 脚底对齐容差。浮点缩放会带来 1~2px 的抗锯齿边缘差异，
# 这属于正常误差而非错误 —— 真正的错误（算错基准线）会偏几十像素。
EPS = 2

# 输出画布（与站立素材一致）
CANVAS_W, CANVAS_H = 864, 1157

# 素材帧率默认值。
#
# 用户约定：**所有动画素材一律按每秒 6 帧输入**，除非特别说明。
# 因此各动作不必重复写 fps；要例外就在该动作配置里显式写一个 `fps` 覆盖它。
DEFAULT_FPS = 6

# 各动作的默认值。动作配置里没写的键从这里取。
ACTION_DEFAULTS = {
    "fps": DEFAULT_FPS,
    "loop": False,
    "scale": "auto",
}

# 动作配置
#
# 只需写"与默认不同"的部分：
#   raw_dir  —— 原始帧目录（必填）
#   fps      —— 帧率，默认 6（见 DEFAULT_FPS）
#   loop     —— 是否循环，默认 False
#   scale    —— 缩放，默认 "auto"（按整批最大内容自动算）
#   loop_range        —— 可选，中间段重复 N 次
#   tail_loop_frames  —— 可选，播完后循环最后 N 帧
ACTIONS = {
    "hang": {
        # 拖拽动画：原始素材与站立同一模板。
        # scale 由脚本按整批最大内容自动算出（见 compute_scale）——
        # 手调过 0.99/0.93 都因为"逐帧内容高不同"而失败，自动算最稳。
        "raw_dir": os.path.join(ROOT, ".cache", "hang-raw"),
        "note": "拖拽时的被拎起来动画",
    },
    "eat": {
        # 吃白饭：这批素材画得比站立**大**且整体更靠下，因此需要的缩放更多。
        # 同样交给 compute_scale 自动算。
        "raw_dir": os.path.join(ROOT, ".cache", "eat-raw"),
        # 局部循环（用户指定）：第 6~9 帧是"正在吃"的持续段，先循环 4 次再继续收尾。
        # 帧号是 **1 基**（与文件名 frame_06..frame_09 对应）。
        # 语义是**额外**重复 4 次，故该段共出现 5 次（17 帧 → 33 帧，约 5.5s）。
        "loop_range": {"from": 6, "to": 9, "times": 4},
        "note": "吃白饭（闲置动作）",
    },
    "sleep": {
        # 睡觉（进入睡眠状态）。10 帧。
        # `tail_loop_frames: 2` —— 躺下的过程只播一次，之后**一直循环最后 2 帧**
        # （睡熟后的轻微起伏）。这是"睡眠状态"的视觉表现，由渲染进程据此维持。
        # `tail_loop_fps: 1` —— 进入动画照默认 6fps 播，但**尾帧循环用 1fps**
        # （用户指定"睡觉动作开始循环后，使用 1 秒 1 帧动画"）。
        # 起伏本来就该慢，6fps 循环看起来像在抽搐。
        "raw_dir": os.path.join(ROOT, ".cache", "sleep-raw"),
        "tail_loop_frames": 2,
        "tail_loop_fps": 1,
        "note": "睡觉（长时间闲置后进入）",
    },
    "awake": {
        # 惊醒（点击叫醒时播放），播完回站立。
        "raw_dir": os.path.join(ROOT, ".cache", "awake-raw"),
        "note": "惊醒（叫醒时播放）",
    },
    "head": {
        # 点击头部时的互动动画（用户指定：只有动画，不再有 CSS 压扁效果）。
        "raw_dir": os.path.join(ROOT, ".cache", "head-raw"),
        "note": "点击头部互动",
    },
    "chest": {
        # 点击胸部时的互动动画。
        "raw_dir": os.path.join(ROOT, ".cache", "chest-raw"),
        # 复制帧（用户指定）：把第 6 帧换成第 5 帧的**重复帧**。
        # 帧号是 **1 基**（与文件名 frame_06.png 对应）。
        # 做成配置而不是直接改 .cache 里的原始文件，是为了**可复现**：
        # 以后重新生成（甚至换了源 zip）时这个修改不会丢。
        "replace_frames": {6: 5},
        "note": "点击胸部互动",
    },
    "leg": {
        # 点击腿部时的互动动画。
        "raw_dir": os.path.join(ROOT, ".cache", "leg-raw"),
        "note": "点击腿部互动",
    },
    "stomach": {
        # 点击腹部时的互动动画。
        # ⚠️ 目录名用 stomach，而**部位 id 是 belly**（见 CLICK_PARTS）。
        # 两者不一致是刻意的：部位名沿用"腹"的语义，素材名跟随用户给的目录名。
        # 靠 CLICK_PARTS[*].actionId 关联，所以不必强求同名。
        "raw_dir": os.path.join(ROOT, ".cache", "stomach-raw"),
        "note": "点击腹部互动",
    },
    "play-mc": {
        # 玩mc（闲置动作）。10 帧。
        # 用户要求分段换帧率：
        #   第 1~3 帧 6fps → 第 4~5 帧**以 1fps 循环随机 20~40 次** → 第 6~10 帧回到 6fps。
        # `loop_range.fps` 指定循环段自己的帧率；
        # `times_range` 让渲染进程**每次播放随机取**一个轮数（写死 times 就每次一样了）。
        "raw_dir": os.path.join(ROOT, ".cache", "play-mc-raw"),
        "loop_range": {"from": 4, "to": 5, "times": 20, "fps": 1},
        "times_range": (20, 40),
        # ⚠️ 第 4~6 帧左上方有一个"想法气泡"（Minecraft 场景），它属于动画内容、
        # 应当保留，但**不参与缩放计算** —— 否则角色会被缩到 0.87（比其他动画小 13%）。
        # 排除最左侧 15% 的像素来求"角色本体"包围盒：实测角色左边界约在 0.21，
        # 气泡在 0.02 附近，0.15 能排除气泡又包住角色。
        "bubble_exclude_left_ratio": 0.15,
        "note": "玩mc（闲置动作）",
    },
}


def content_bounds(img):
    """非透明像素的边界 (x0, y0, x1, y1)；全透明返回 None。"""
    a = np.array(img)
    alpha = a[:, :, 3] > ALPHA_THRESHOLD
    ys, xs = np.where(alpha)
    if len(xs) == 0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())


def standing_foot_output():
    """站立素材的脚底基准（输出空间）。"""
    files = sorted(f for f in os.listdir(STAND_DIR) if f.startswith("frame_") and f.endswith(".png"))
    if not files:
        raise SystemExit(f"站立素材目录里没有帧：{STAND_DIR}")
    feet = []
    for f in files:
        b = content_bounds(Image.open(os.path.join(STAND_DIR, f)).convert("RGBA"))
        if b:
            feet.append(b[3])
    return min(feet)


def compute_scale(bounds_list, foot_out, canvas_w=CANVAS_W):
    """
    按整批帧的**最大内容尺寸**算出一个统一缩放倍数，保证每一帧都能完整装进画布。

    为什么要按最大内容算、而不是逐帧各算各的：逐帧缩放会让角色在动画中忽大忽小。
    统一倍数才能保证同一套动作里角色大小恒定。

    可用空间：
      · 宽度 = 画布宽（内容水平居中，左右对称）；调用方也可以传更小的
        `canvas_w` 来**刻意留出侧边余量**（见下面的 exclude_left_ratio）；
      · 高度 = 脚底基准线 + 1（从画布顶端到基准线的距离）。
    再留 2px 安全余量，抵消取整误差。

    ⚠️ 我一开始是手调倍数的（0.99、0.93 都试过），两次都被"逐帧内容高不同"打回 ——
    自动算才是一次到位的做法。
    """
    max_w = max(b[2] - b[0] + 1 for b in bounds_list)
    max_h = max(b[3] - b[1] + 1 for b in bounds_list)
    avail_w = canvas_w - 2
    avail_h = foot_out + 1 - 2
    scale = min(avail_w / max_w, avail_h / max_h, 1.0)
    return round(scale, 4), max_w, max_h, avail_w, avail_h


def body_bounds(img, exclude_left_ratio=0.0):
    """
    求"角色本体"的包围盒，可**排除左侧一条区域**。

    为什么需要：玩mc 的第 4~6 帧在角色左上方有一个"想法气泡"（画着 Minecraft 场景）。
    它属于动画内容、应当保留，但**不该参与缩放计算** ——
    否则自动缩放会按"气泡 + 角色"的整体宽度来算，角色被缩小一大截
    （实测从 0.96 掉到 0.87，比其他动画小 13%，切换动作时会明显一跳）。

    做法：把最左侧 `exclude_left_ratio` 比例的像素当作"可能是气泡"排除掉，
    在这个范围内求包围盒。取值要保证**角色本体仍在范围内**：
    实测其他帧的角色左边界约在 x/1090 ≈ 0.21 附近，气泡在 0.02 附近，
    所以取 0.15 能排除气泡、又包住角色。

    @param {Image.Image} img
    @param {float} exclude_left_ratio 0 = 不排除（默认，与其他动画一致）
    """
    a = np.array(img.convert("RGBA"))
    H, W = a.shape[:2]
    cut = int(W * max(0.0, min(0.9, exclude_left_ratio)))
    alpha = a[:, cut:, 3] > ALPHA_THRESHOLD
    ys, xs = np.where(alpha)
    if len(xs) == 0:
        return None
    # xs 是相对 cut 的偏移，加回去变成绝对坐标。
    return int(xs.min()) + cut, int(ys.min()), int(xs.max()) + cut, int(ys.max())


def build_one(action_id):
    raw = ACTIONS.get(action_id)
    if raw is None:
        raise SystemExit(f"未知动作：{action_id}（可选：{', '.join(ACTIONS)}）")
    # 把默认值补齐：各动作只需写"与默认不同"的键。
    cfg = {**ACTION_DEFAULTS, **raw}
    if not raw.get("note"):
        cfg["note"] = action_id

    raw_dir = cfg["raw_dir"]
    if not os.path.isdir(raw_dir):
        raise SystemExit(f"原始帧目录不存在：{raw_dir}")

    out_dir = os.path.join(ROOT, "assets", "animations", action_id)
    foot_out = standing_foot_output()

    names = sorted(
        (f for f in os.listdir(raw_dir) if f.endswith(".png") and f[:-4].isdigit()),
        key=lambda f: int(f[:-4]),
    )
    if not names:
        raise SystemExit(f"原始帧目录为空：{raw_dir}")

    print(f"\n=== {action_id}（{cfg['note']}）===")
    print(
        f"  脚底基准（与站立一致）: y={foot_out}   画布 {CANVAS_W}x{CANVAS_H}   "
        f"帧率 {cfg['fps']} fps{'（默认）' if cfg['fps'] == DEFAULT_FPS else '（显式指定）'}"
    )

    # 先算好"每一帧实际用哪张原始图"（复制帧会改变这一点），
    # 再据此读内容边界 —— 必须按**换完之后**的内容算缩放，
    # 否则缩放会按旧内容算，贴到画布时可能越界。
    src_index_of = []
    replaced = []
    for i, _name in enumerate(names):
        repl = (cfg.get("replace_frames") or {}).get(i + 1)
        if repl is None:
            src_index_of.append(i)
            continue
        idx = repl - 1
        if not (0 <= idx < len(names)):
            raise SystemExit(f"{action_id} 的 replace_frames 里 {i + 1}→{repl} 越界（共 {len(names)} 帧）")
        src_index_of.append(idx)
        replaced.append((i + 1, repl))

    # 读一遍所有帧的边界。
    #  · `raw_bounds`（完整内容，含想法气泡之类）—— 用于**裁剪与居中**；
    #  · `body_bounds_list`（角色本体，排除左侧气泡区）—— 用于**算缩放**。
    #
    # 两者分开的理由见 body_bounds 的说明：玩mc 第 4~6 帧左侧有想法气泡，
    # 若按含气泡的宽度算缩放，角色会比其他动画小 13%，切换动作时明显一跳。
    exclude_left = cfg.get("bubble_exclude_left_ratio", 0.0)
    raw_bounds = []
    body_bounds_list = []
    for idx in src_index_of:
        img = Image.open(os.path.join(raw_dir, names[idx])).convert("RGBA")
        b = content_bounds(img)
        if b is None:
            raise SystemExit(f"{names[idx]} 全透明")
        raw_bounds.append(b)
        bb = body_bounds(img, exclude_left) if exclude_left > 0 else b
        if bb is None:
            raise SystemExit(f"{names[idx]} 排除左侧区域后没有内容（bubble_exclude_left_ratio 设太大了？）")
        body_bounds_list.append(bb)

    if cfg["scale"] == "auto":
        scale, max_w, max_h, avail_w, avail_h = compute_scale(body_bounds_list, foot_out)
        body_note = f"（角色本体宽度，已排除左侧 {exclude_left:.0%} 的气泡区）" if exclude_left > 0 else ""
        print(
            f"  自动缩放: {scale}  （最大内容 {max_w}x{max_h}{body_note}，可用 {avail_w}x{avail_h}）"
            + ("" if scale < 1.0 else "  ← 无需缩放")
        )
    else:
        scale = cfg["scale"]
        print(f"  缩放: {'不缩放' if scale is None else scale}")

    os.makedirs(out_dir, exist_ok=True)
    report = []
    for i, name in enumerate(names):
        # 0) 复制帧：第 N 帧用第 M 帧的图（`src_index_of` 已在上面算好）。
        src_index = src_index_of[i]
        src = Image.open(os.path.join(raw_dir, names[src_index])).convert("RGBA")
        sb = raw_bounds[i]

        # 1) 按内容框裁掉四周留白
        content = src.crop((sb[0], sb[1], sb[2] + 1, sb[3] + 1))

        # 2) 必要时缩放
        if scale is not None and scale < 1.0:
            sw = max(1, int(round(content.width * scale)))
            sh = max(1, int(round(content.height * scale)))
            content = content.resize((sw, sh), Image.LANCZOS)

        # 3) 定位：脚底对齐基准线；水平方向**按角色本体居中**。
        #
        # ⚠️ 水平居中不能用"完整内容居中"，而要用**角色本体**居中。
        #
        # 玩mc 第 4~6 帧左侧有个想法气泡（Minecraft 场景）。若按完整内容居中，
        # 气泡会把整幅图往右推、角色随之右移；而缩放是按角色本体算的
        # （见上面 body_bounds），于是"缩放宽 945 > 画布 864"直接越界。
        #
        # 正确做法：所有帧都以**角色本体**为锚点对齐，气泡自然向左溢出。
        # 气泡本来就是"飘在角色旁边"的元素，超出画布左缘会被裁掉一部分 ——
        # 相比"把所有帧的角色都缩小 13%"，这个取舍更划算，而且角色与其他动画
        # 尺寸一致（切换动作时不会一跳）。
        body = body_bounds(src, exclude_left) if exclude_left > 0 else sb
        body_cx = (body[0] + body[2]) / 2  # 角色本体在原始帧里的中心 x
        content_rel_cx = body_cx - sb[0]   # 换算到裁剪后的坐标系
        px = int(round(CANVAS_W / 2 - content_rel_cx * scale))
        py = foot_out - content.height + 1

        # 垂直越界直接报错 —— 宁可失败也不要偷偷裁掉角色的头或脚。
        # 水平方向允许溢出（气泡），但**角色本体必须完整落在画布内**。
        if py < 0 or py + content.height > CANVAS_H:
            raise SystemExit(
                f"{name} 垂直方向越界：内容高 {content.height}，落点 y={py}。"
                f"需要更小的 scale（当前 {scale}）。"
            )
        body_px0 = px + int((body[0] - sb[0]) * scale)
        body_px1 = px + int((body[2] - sb[0]) * scale)
        body_py0 = py + int((body[1] - sb[1]) * scale)
        body_py1 = py + int((body[3] - sb[1]) * scale)
        if body_px0 < 0 or body_px1 >= CANVAS_W or body_py0 < 0 or body_py1 >= CANVAS_H:
            raise SystemExit(
                f"{name} 的角色本体越出画布：x {body_px0}~{body_px1}，y {body_py0}~{body_py1}"
                f"（画布 {CANVAS_W}x{CANVAS_H}）。需要更小的 scale（当前 {scale}）。"
            )

        canvas = Image.new("RGBA", (CANVAS_W, CANVAS_H), (0, 0, 0, 0))
        canvas.alpha_composite(content, (px, py))

        ob = content_bounds(canvas)
        out_name = f"frame_{i + 1:02d}.png"
        canvas.save(os.path.join(out_dir, out_name))
        report.append(
            {
                "src": name,
                "out": out_name,
                "srcBounds": list(sb),
                "placedAt": [px, py],
                "outTop": ob[1],
                "outFoot": ob[3],
                "outW": ob[2] - ob[0] + 1,
                "outH": ob[3] - ob[1] + 1,
            }
        )

    print(f"  帧数 {len(report)}，逐帧脚底：{', '.join(str(r['outFoot']) for r in report)}")
    if replaced:
        print(
            "  复制帧：" + "，".join(f"第 {dst} 帧 ← 第 {src} 帧" for dst, src in replaced)
            + "（帧号为 1 基）"
        )
    print(
        f"  头顶范围 {min(r['outTop'] for r in report)}~{max(r['outTop'] for r in report)}；"
        f"内容高 {min(r['outH'] for r in report)}~{max(r['outH'] for r in report)}"
    )

    bad = [r for r in report if abs(r["outFoot"] - foot_out) > EPS]
    if bad:
        print("  对齐校验失败（偏差 > 2px）：" + ", ".join(f"{r['out']}(脚底 {r['outFoot']})" for r in bad))
    else:
        devs = [r["outFoot"] - foot_out for r in report]
        span = f"{min(devs)}~{max(devs)}" if len(set(devs)) > 1 else str(devs[0])
        print(f"  对齐校验：全部 {len(report)} 帧脚底 = {foot_out}（偏差 {span} px）OK")

    manifest = {
        "frameCount": len(report),
        "fps": cfg["fps"],
        "loop": cfg["loop"],
        "sourceCanvasHeight": CANVAS_H,
        "drawOffsetY": [0] * len(report),
        "_note": f"由 scripts/dev/build-action-asset.py {action_id} 生成；与站立素材同一画布约定（水平居中 + 脚底基准 y={foot_out}）。",
        "_processing": {
            "canvas": {"w": CANVAS_W, "h": CANVAS_H},
            "scale": scale,
            "footBaseOutput": foot_out,
            "perFrame": report,
        },
    }
    # 局部循环：可选。渲染进程会把它"烘焙"成一条确定的播放序列。
    if cfg.get("loop_range"):
        lr = dict(cfg["loop_range"])
        # 轮数范围（可选）：`times_range` → 运行时**每次随机取**一个轮数。
        # 玩mc 需要"随机 20~40 次"，所以这里把范围也写进清单，
        # 由渲染进程在每次播放时挑一个值（写死 times 就每次一样了）。
        if cfg.get("times_range"):
            lo, hi = cfg["times_range"]
            manifest["loopRangeCyclesRange"] = {"min": lo, "max": hi}
            lr["times"] = lo
        manifest["loopRange"] = lr
        loop_fps = lr.get("fps") or cfg["fps"]
        if cfg.get("times_range"):
            lo, hi = cfg["times_range"]
            print(
                f"  局部循环：第 {lr['from']}~{lr['to']} 帧以 {loop_fps}fps 循环"
                f" **随机 {lo}~{hi} 次**（运行时取），其余按 {cfg['fps']}fps"
            )
        else:
            total = len(report) + (lr["to"] - lr["from"] + 1) * (lr["times"] - 1)
            print(
                f"  局部循环：第 {lr['from']}~{lr['to']} 帧重复 {lr['times']} 次"
                + (f"、且用 {loop_fps}fps" if loop_fps != cfg["fps"] else "")
                + f" → 播放 {total} 帧"
            )
    # 尾帧循环：可选。进入动画播完后循环最后 N 帧（睡觉用它维持起伏）。
    if cfg.get("tail_loop_frames"):
        manifest["tailLoopFrames"] = cfg["tail_loop_frames"]
        if cfg.get("tail_loop_fps"):
            manifest["tailLoopFps"] = cfg["tail_loop_fps"]
        print(
            f"  尾帧循环：播完后循环最后 {cfg['tail_loop_frames']} 帧"
            + (f"，帧率 {cfg['tail_loop_fps']} fps" if cfg.get("tail_loop_fps") else "")
        )
    with open(os.path.join(out_dir, "manifest.json"), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    print(f"  已写出 {len(report)} 帧 + manifest.json 到 {out_dir}")

    return len(bad) == 0


def print_config():
    """打印各动作的最终配置（含默认值），便于确认帧率等设定。"""
    print(f"默认帧率 {DEFAULT_FPS} fps（用户约定：一律 6fps，除非特别说明）\n")
    for aid, raw in ACTIONS.items():
        cfg = {**ACTION_DEFAULTS, **raw}
        extras = []
        if cfg.get("loop_range"):
            lr = cfg["loop_range"]
            extras.append(f"中间段循环 {lr['from']}~{lr['to']} ×{lr['times']}")
        if cfg.get("tail_loop_frames"):
            extras.append(f"尾帧循环 {cfg['tail_loop_frames']} 帧 @{cfg.get('tail_loop_fps') or cfg['fps']}fps")
        fps_mark = "" if raw.get("fps") is None else "（显式覆盖）"
        print(f"  {aid:<8} fps={cfg['fps']}{fps_mark}  loop={cfg['loop']}  scale={cfg['scale']}  {'; '.join(extras)}")


def main():
    args = sys.argv[1:]
    if not args:
        print_config()
        raise SystemExit("用法: python scripts/dev/build-action-asset.py <动作id|all|--list>")
    if args[0] in ("--list", "-l"):
        print_config()
        return
    targets = list(ACTIONS) if args[0] == "all" else args
    all_ok = True
    for t in targets:
        all_ok = build_one(t) and all_ok
    if not all_ok:
        sys.exit(1)


if __name__ == "__main__":
    main()
