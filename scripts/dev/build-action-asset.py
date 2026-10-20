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

# ---------------------------------------------------------------- 输出格式
#
# 成品帧输出成 **WebP（有损 q92，alpha 无损）**，不再用 PNG。
#
# 实测（864×1157 RGBA，131 帧）：PNG 共 143 MB → WebP q92 约 30 MB。
# 按桌宠的实际显示尺寸（角色宽 180~400 px，素材 864 宽）目视无差；
# alpha 完全无损，所以轮廓/阴影边缘不会出现调色板那种硬边。
# 详见 scripts/dev/compress-assets.py 的对比表。
#
# ⚠️ 换格式时这三处必须同步：本文件的输出、渲染进程的 FRAME_EXT、
# 以及测试里的文件头校验。漏一处就是"桌宠整个不显示"。
FRAME_EXT = "webp"
OUTPUT_WEBP_QUALITY = 92


def _is_frame_file(name):
    """是不是一帧成品（PNG 或 WebP 都认，便于新旧素材共存时迁移）。"""
    return name.startswith("frame_") and (name.endswith(".png") or name.endswith(".webp"))
# 脚底对齐容差。浮点缩放会带来 1~2px 的抗锯齿边缘差异，
# 这属于正常误差而非错误 —— 真正的错误（算错基准线）会偏几十像素。
EPS = 2

# 输出画布（与站立素材一致）
CANVAS_W, CANVAS_H = 864, 1157

# 量"头部宽度"时取内容顶部往下这段区间（比例）。
# 5% 跳过头顶最尖的发饰，30% 停在肩膀之前 —— 这一段最宽的一行就是头发/头部。
HEAD_BAND = (0.05, 0.30)

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
        # 拖拽已改为"静态随机帧"：清单里声明 `staticFrames`，渲染进程据此
        # 每次触发随机挑一帧显示（不播）。
        # ⚠️ **必须写在配置里**，否则重跑本脚本会把清单里的 staticFrames
        # 覆盖掉，拖拽会静默退回"多帧动画"（正是这个坑：配置是清单的生成源）。
        "static_frames": [4, 11],
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
    "game-begin": {
        "raw_dir": os.path.join(ROOT, ".cache", "game-raw", "begin"),
        # 画布加高到 1210：最高的收尾帧内容高 1200，1157 放不下（会触发"垂直越界"）。
        # 渲染进程按素材自身比例设帧高，多出来的高度向上溢出到气泡区。
        "canvas_height": 1210,
        "fps": 6,
        "note": "玩游戏（第一段：开始，播一遍）",
    },
    "game-loop": {
        "raw_dir": os.path.join(ROOT, ".cache", "game-raw", "loop"),
        "canvas_height": 1210,
        # ⚠️ 用户指定第二段 **每秒 1 帧**。2 帧 → 每帧停在屏幕上 1 秒，一圈 2 秒。
        "fps": 1,
        "loop": True,
        "note": "玩游戏（第二段：循环，1fps）",
    },
    "game-stop": {
        "raw_dir": os.path.join(ROOT, ".cache", "game-raw", "stop"),
        "canvas_height": 1210,
        "fps": 6,
        "note": "玩游戏（第三段：收尾，播一遍回闲置）",
    },

    "sit": {
        # 坐下（随机动作的**第一阶段**：坐下的过程，只播一次）。
        #
        # 坐姿动作由三段独立素材拼成，阶段逻辑见渲染进程的 enterSit：
        #   sit        —— 坐下过程（本项）
        #   sit-circle —— 坐着循环（第二阶段：无限循环 + 180 秒计时）
        #   sit-stop   —— 站起过程（第三阶段）
        # 三段各有独立目录，而不是像睡觉那样用 tail_loop_frames 把尾帧拼起来 ——
        # 因为"站着循环"与"坐着循环"是两套完全不同的姿势，不是同一素材的尾段。
        "raw_dir": os.path.join(ROOT, ".cache", "sit-raw"),
        # ⚠️ `match_head_to: "stand"` —— 把角色**缩放到与站立同一个视觉大小**。
        #
        # 为什么不是"三段共用同一缩放倍数"（曾经的做法）：共用倍数只保证乘的是
        # 同一个系数，但**三段原始素材里角色本来就画得不一样大**（实测头宽
        # sit 580 / sit-circle 627 / sit-stop 643，而 stand 只有 530），
        # 共用倍数于是把差异原样保留下来 —— 用户看到的就是
        # "坐下后桌宠变大、坐着更大、站起又变小"。
        # 按头宽对齐才是"看起来一样大"的充要条件。
        "match_head_to": "stand",
        # 段内也要一致：实测 sit-stop 段内头宽跨度 10.5%，单一系数修不掉。
        "match_head_per_frame": True,
        "note": "坐下（第一阶段：坐下的过程）",
    },
    "sit-circle": {
        # 坐着（第二阶段）：**循环播放**，持续到 180 秒计时到点、或被点击打断。
        # `loop: True` 是声明性的 —— 渲染进程用 startLoop 起循环，
        # 写在这里是为了让清单自解释"这个动作本意就是循环的"。
        "raw_dir": os.path.join(ROOT, ".cache", "sit-circle-raw"),
        "loop": True,
        # ⚠️ 用**整体高度**对齐，不是头宽。
        # 按头宽对齐后四段头一样大，但坐姿轮廓更矮（成品高度只有站立的 88%），
        # 用户仍反馈"坐着时偏小"。所以改用高度：
        # ("sit","sit") = 恒定等于 sit 的**末帧**高度（与上一段接得上）。
        "height_ramp": ("sit", "sit"),
        "note": "坐着（第二阶段：循环播放）",
    },
    "sit-stop": {
        # 站起（第三阶段：站起的过程，只播一次，播完回站立闲置）。
        "raw_dir": os.path.join(ROOT, ".cache", "sit-stop-raw"),
        # ⚠️ 高度从 **sit 末帧** 线性过渡到 **stand 均值**：
        # 开始处与坐着那一段接得上，结束处与站立动画接得上，
        # 中间不会突然高于下一段（那会变成另一种"跳"）。
        "height_ramp": ("sit", "stand"),
        "note": "站起（第三阶段：站起的过程）",
    },

    # ---------------------------------------------------------------- 深度思考
    #
    # 用户给了两批素材，要求"压缩到与现有素材一致"后导入：
    #   thinking_pre（6 帧）= 准备与结束过程；thinking（4 帧）= 思考中的循环。
    #
    # 拆成**三段动作**而不是一个动作，是因为退出的那 6 帧是**倒放**的：
    # 现有动画模型只有"顺序播放一遍 / 循环尾帧 / 区间循环 N 次"，
    # 表达不了"被打断时倒放进入段"。拆成 think-enter / think-loop / think-exit
    # 之后，渲染进程按状态机串联即可（见 renderer.js 的 enterThink / exitThink）。
    #
    # 三段都用 `match_head_to: stand`：这是站姿的三段，头宽恒定的假设成立，
    # 按头宽对齐能把"同一角色同样大小"表达对。
    # 不用 height_ramp —— 思考时人是**低头含胸**的，整体高度天然比站立矮，
    # 按高度硬拉会把角色放大 4%（这正是坐姿那轮踩过的坑的另一面）。
    "think-enter": {
        "raw_dir": os.path.join(ROOT, ".cache", "think-enter-raw"),
        # 按**整体高度**对齐站立，而不是按头宽 —— 头宽对齐后她的头一样大，
        # 但思考姿势是低头含胸、整个轮廓更矮，用户仍反馈"比站立小一点"。
        # 这和坐姿那轮是同一个判据问题（用户看的是体量，不是头）。
        "height_ramp": ("stand", "stand"),
        "note": "深度思考（进入：抬头→低头沉思）",
    },
    "think-loop": {
        "raw_dir": os.path.join(ROOT, ".cache", "think-loop-raw"),
        # 循环段头顶有"深度求索中…"气泡 —— 它是**素材的一部分，要保留**
        # （用户明确："气泡就是素材本身应该有的"）。
        #
        # ⚠️ 这里有两个互相牵制的约束，解法是**加高画布**：
        #   · 按站立大小画（用户要求"动作全程始终大小和正常站立一致"）时，
        #     内容（角色 + 气泡）高约 1189px，超过 1157 的画布，气泡顶部会被切；
        #   · 想不切气泡，就只能把角色缩到站立的 ~94%（看起来明显小一圈）。
        #
        # 加高到 1210 后：角色按头宽对齐站立（缩放约 0.974），气泡完整保留；
        # 多出来的透明区域都在顶部 —— 渲染进程按素材自身比例设置帧高，
        # 这部分向上溢出到气泡区（那里有 50+px 富余）。
        "canvas_height": 1250,
        # 量尺寸时剔除顶部气泡（占内容高度约 9.5%，取 0.10）。
        # 不剔的话"内容高度"会把气泡算进去 —— 既会把角色算矮，
        # 也会让 fit 上限被气泡顶高而收紧。
        "bubble_ignore_top_ratio": 0.10,
        # ⚠️ 不按站立高度对齐，而是按**第一段（think-enter）的头宽**反推目标高度。
        #
        # 原因：循环段姿势含胸、轮廓更窄，按站立高度对齐会把**头放大 5%**
        # （实测头宽 570，而第一/三段是 555），用户反馈"第二段还略大一些"。
        # 1119 是让头宽落回 555 左右的目标高度（由实测的 头宽/高度 比反算）。
        "height_target": 1119,
        # 声明式：渲染进程用 startLoop 无限循环这一段。
        "loop": True,
        "note": "深度思考（循环：思考中）",
    },
    "think-exit": {
        "raw_dir": os.path.join(ROOT, ".cache", "think-exit-raw"),
        "height_ramp": ("stand", "stand"),
        "note": "深度思考（退出：倒放进入段，回站立）",
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
    """站立素材的脚底基准（输出空间）。

    ⚠️ 取**众数**（出现最多的脚底值），不是最小值。

    原先用 `min(feet)`，而站立 12 帧里 11 帧脚底在 1155、只有 1 帧在 1148
    （那是动画起伏的一帧）。min 于是取到 1148，导致所有动作都对齐到 1148 ——
    而**站立自己**多数帧在 1155，于是切到动作时角色整体上移 7px。
    实测：用户反馈"坐下前后锚点有变化"。

    众数正好落在站立最常处的位置，衔接时不会跳。
    """
    files = sorted(f for f in os.listdir(STAND_DIR) if f.startswith("frame_") and _is_frame_file(f))
    if not files:
        raise SystemExit(f"站立素材目录里没有帧：{STAND_DIR}")
    feet = []
    for f in files:
        b = content_bounds(Image.open(os.path.join(STAND_DIR, f)).convert("RGBA"))
        if b:
            feet.append(b[3])
    if not feet:
        raise SystemExit("站立素材全透明，量不到脚底")
    counts = {}
    for v in feet:
        counts[v] = counts.get(v, 0) + 1
    best = max(counts.values())
    # 并列时取较大值（脚底更低 = 更保守，内容不容易顶到画布上边）
    return max(v for v, c in counts.items() if c == best)


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


def head_width_of(img, band=HEAD_BAND, ignore_top_ratio=0.0):
    """内容顶部往下 band 区间内最宽的一行（≈ 头部/头发宽度）。

    为什么用这个指标判断"角色画多大"：
    Q 版角色里头部占绝对主导，同一人物的头部像素宽度几乎恒定；
    而整体包围盒会随姿势（裙摆铺开、手臂抬起）大幅变化，
    光看它会把"姿势不同"误判成"大小不同"。

    `ignore_top_ratio`：先剔掉顶部那一块（气泡）再算 band，
    否则"内容顶部"变成气泡顶边，band 会落在气泡上，量出来的不是头宽。
    """
    a = np.array(img.convert("RGBA"))
    al = a[:, :, 3] > ALPHA_THRESHOLD
    ys, xs = np.where(al)
    if len(xs) == 0:
        return 0
    y0, y1 = int(ys.min()), int(ys.max())
    if ignore_top_ratio > 0:
        content_h = y1 - y0 + 1
        y0 = y0 + int(content_h * max(0.0, min(0.9, ignore_top_ratio)))
    h = y1 - y0 + 1
    if h <= 0:
        return 0
    best = 0
    for y in range(y0 + int(h * band[0]), y0 + int(h * band[1]) + 1):
        row = np.where(al[y])[0]
        if len(row) > 0:
            best = max(best, int(row.max() - row.min() + 1))
    return best


def output_head_width(action_id):
    """量某个**已处理**动作的头部宽度（输出空间，取所有帧最大值）。"""
    d = os.path.join(ROOT, "assets", "animations", action_id)
    if not os.path.isdir(d):
        raise SystemExit(f"match_head_to 指向的动作还没处理过：{d}")
    files = sorted(f for f in os.listdir(d) if f.startswith("frame_") and _is_frame_file(f))
    if not files:
        raise SystemExit(f"{action_id} 没有任何帧，无法作为头宽基准")
    return max(head_width_of(Image.open(os.path.join(d, f))) for f in files)


def output_frame_heights(action_id):
    """量某个**已处理**动作逐帧的内容高度（输出空间）。

    直接量 PNG 而不是读清单里的 `outH`：**stand 的清单没有 `_processing`**
    （它是最早处理的，只记了 `_processingHistory`），读清单会在 stand 上崩。
    量图对任何动作都适用。
    """
    d = os.path.join(ROOT, "assets", "animations", action_id)
    if not os.path.isdir(d):
        raise SystemExit(f"height_ramp 引用的动作还没处理过：{d}")
    files = sorted(f for f in os.listdir(d) if f.startswith("frame_") and _is_frame_file(f))
    if not files:
        raise SystemExit(f"{action_id} 没有任何帧，无法作为高度基准")
    heights = []
    for f in files:
        b = content_bounds(Image.open(os.path.join(d, f)).convert("RGBA"))
        if b:
            heights.append(b[3] - b[1] + 1)
    if not heights:
        raise SystemExit(f"{action_id} 的帧全透明，量不到高度")
    return heights


def output_last_frame_height(action_id):
    """某动作**末帧**的内容高度（用于"与上一段接得上"）。"""
    return output_frame_heights(action_id)[-1]


def output_mean_height(action_id):
    """某动作逐帧高度的**均值**（用于"与整段观感一致"）。"""
    hs = output_frame_heights(action_id)
    return sum(hs) / len(hs)


def body_bounds(img, exclude_left_ratio=0.0, ignore_top_ratio=0.0):
    """
    求"角色本体"的包围盒，可**排除左侧一条区域**或**顶部一条区域**。

    为什么需要（左侧）：玩mc 的第 4~6 帧在角色左上方有一个"想法气泡"（画着 Minecraft 场景）。
    它属于动画内容、应当保留，但**不该参与缩放计算** ——
    否则自动缩放会按"气泡 + 角色"的整体宽度来算，角色被缩小一大截
    （实测从 0.96 掉到 0.87，比其他动画小 13%，切换动作时会明显一跳）。

    为什么需要（顶部）：深度思考的循环段在**头顶上方**有一个"深度求索中…"气泡
    （用户明确：气泡是素材本身的一部分，要保留）。它同样会把内容高度顶高，
    于是自动缩放按"气泡 + 角色"的高度算，角色被压小 11%（实测头宽 478 vs 530）。
    排除顶部 `ignore_top_ratio` 比例后再量，角色大小就对了；气泡本身照常显示。

    @param {Image.Image} img
    @param {float} exclude_left_ratio 0 = 不排除（默认，与其他动画一致）
    @param {float} ignore_top_ratio   0 = 不排除顶部（默认）
    """
    a = np.array(img.convert("RGBA"))
    H, W = a.shape[:2]
    cut = int(W * max(0.0, min(0.9, exclude_left_ratio)))
    # 顶部的"排除区"按**内容高度**算，而不是画布高度 ——
    # 素材画布上下留白很多，按画布比例切会切不到气泡。
    top = 0
    if ignore_top_ratio > 0:
        full = content_bounds(img)
        if full is not None:
            content_h = full[3] - full[1] + 1
            top = full[1] + int(content_h * max(0.0, min(0.9, ignore_top_ratio)))
    alpha = a[top:, cut:, 3] > ALPHA_THRESHOLD
    ys, xs = np.where(alpha)
    if len(xs) == 0:
        return None
    # xs/ys 是相对 (cut, top) 的偏移，加回去变成绝对坐标。
    return int(xs.min()) + cut, int(ys.min()) + top, int(xs.max()) + cut, int(ys.max()) + top


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

    # 画布高度可以**按动作**加高（默认 1157，与站立同高）。
    #
    # 为什么需要：深度思考的循环段在头顶上方有一个"深度求索中…"气泡（素材自带、必须保留）。
    # 若画布仍是 1157，为了保证气泡不被裁，角色只能缩到站立的 ~90%，看起来很突兀；
    # 而按站立大小画，气泡顶部会超出画布 ~34px 被切掉。
    # 加高画布后两者都满足：**角色大小不变**，多出来的透明区域只放气泡。
    # 渲染进程按素材自身比例设置帧高，多出来的高度会向上溢出到气泡区（那里有富余）。
    canvas_h = int(cfg.get("canvas_height") or CANVAS_H)
    foot_out = canvas_h - (CANVAS_H - standing_foot_output())

    # 先清掉输出目录里**旧的成品帧**。
    #
    # 为什么必须清：帧数可能变少（实测：思考循环从 4 帧换成 3 帧，
    # 结果旧的 frame_04 留了下来，`manifest.frameCount=3` 与磁盘上的 4 个文件
    # 对不上，test-animations 直接红）。写新帧时只覆盖同名的，多出来的不会自己消失。
    # manifest.json 不删 —— 它会被完整重写。
    if os.path.isdir(out_dir):
        for f in os.listdir(out_dir):
            if f.startswith("frame_") and (f.endswith(".png") or f.endswith(".webp")):
                os.remove(os.path.join(out_dir, f))

    names = sorted(
        (f for f in os.listdir(raw_dir) if f.endswith(".png") and f[:-4].isdigit()),
        key=lambda f: int(f[:-4]),
    )
    if not names:
        raise SystemExit(f"原始帧目录为空：{raw_dir}")

    print(f"\n=== {action_id}（{cfg['note']}）===")
    print(
        f"  脚底基准: y={foot_out}   画布 {CANVAS_W}x{canvas_h}   "
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
    ignore_top = cfg.get("bubble_ignore_top_ratio", 0.0)
    raw_bounds = []
    body_bounds_list = []
    for idx in src_index_of:
        img = Image.open(os.path.join(raw_dir, names[idx])).convert("RGBA")
        b = content_bounds(img)
        if b is None:
            raise SystemExit(f"{names[idx]} 全透明")
        raw_bounds.append(b)
        bb = body_bounds(img, exclude_left, ignore_top) if (exclude_left > 0 or ignore_top > 0) else b
        if bb is None:
            raise SystemExit(f"{names[idx]} 排除气泡区域后没有内容（bubble_* 比例设太大了？）")
        body_bounds_list.append(bb)

    if cfg["scale"] == "auto":
        scale, max_w, max_h, avail_w, avail_h = compute_scale(body_bounds_list, foot_out)
        notes = []
        if exclude_left > 0:
            notes.append(f"已排除左侧 {exclude_left:.0%}")
        if ignore_top > 0:
            notes.append(f"已排除顶部 {ignore_top:.0%}")
        body_note = f"（角色本体，{'、'.join(notes)} 的气泡区）" if notes else ""
        print(
            f"  自动缩放: {scale}  （最大内容 {max_w}x{max_h}{body_note}，可用 {avail_w}x{avail_h}）"
            + ("" if scale < 1.0 else "  ← 无需缩放")
        )
    else:
        scale = cfg["scale"]
        print(f"  缩放: {'不缩放' if scale is None else scale}")

    # ---------------------------------------------------------------- 头宽对齐
    #
    # ## 为什么需要
    #
    # `compute_scale` 是"填满画布"式归一化：把每套素材的**最大内容**缩到刚好
    # 装满画布。对单个动作没问题，但对**连续衔接的几段**是错的 ——
    # 因为每段原始素材里角色画得大小可能不同，归一化会把它们各自拉成"一样满"，
    # 于是画面上角色大小不一致。
    #
    # 实测（坐姿，用户反馈"坐下前后桌宠大小不一样"）：成品头宽
    # stand 525 / sit 532 / sit-circle 589 / sit-stop 550 ——
    # 坐着比站着大 12%，坐下与坐起之间还在变。
    #
    # ## 做法
    #
    # 以某个**已处理**动作（`match_head_to`，通常是 stand）的成品头宽为基准，
    # 反算出本段需要的缩放，使"头部像素宽度"对齐。
    # 用头宽而不是整体包围盒：整体包围盒随姿势剧烈变化（裙摆铺开、手臂抬起），
    # 拿它对齐会把"姿势不同"错当成"大小不同"，反而把角色缩坏。
    #
    # 只允许**缩小**（不超过自动适配值），避免内容顶出画布。
    head_match = None
    head_width_out = None
    if cfg.get("match_head_to") and scale:
        ref_id = cfg["match_head_to"]
        ref_head = output_head_width(ref_id)
        if ref_head <= 0:
            raise SystemExit(f"{ref_id} 的头部宽度量不到（为 0），无法作为基准")
        raw_heads = []
        for idx in src_index_of:
            raw_heads.append(head_width_of(Image.open(os.path.join(raw_dir, names[idx])).convert("RGBA"), ignore_top_ratio=ignore_top))
        cur_head = max(raw_heads) if raw_heads else 0
        if cur_head > 0:
            projected = cur_head * scale
            corr = ref_head / projected
            fit_scale = compute_scale(body_bounds_list, foot_out)[0]
            new_scale = round(min(scale * corr, fit_scale), 4)
            new_scale = max(0.05, new_scale)
            print(
                f"  头宽对齐（match_head_to={ref_id}）: 参考成品头宽 {ref_head}px；"
                f"本段原始头宽 {cur_head}px × 缩放 {scale} = {projected:.1f}px"
            )
            print(
                f"    → 纠正系数 {corr:.4f}，缩放 {scale} → {new_scale}"
                f"（对齐后约 {cur_head * new_scale:.1f}px）"
            )
            head_match = {
                "ref": ref_id,
                "refHeadWidth": ref_head,
                "rawHeadWidth": cur_head,
                "correction": round(corr, 4),
            }
            scale = new_scale
            head_width_out = round(cur_head * scale, 1)

    # ---------------------------------------------------------------- 逐帧头宽归一化（可选）
    #
    # 上面的单一系数只能把"整段里最大的那一帧"对到基准，
    # 而实测素材**段内**就不一致（sit-stop 头宽 582~643，跨度 10.5%）。
    # 于是整段播下来角色仍会缓慢变大/变小。
    #
    # 这里改成**逐帧**各算一个缩放，使每一帧的头宽都等于基准 ——
    # 这才是"同一个人、同一大小"的正确表达。
    # 上限受 `compute_scale` 的自动适配值约束（永不放大到超出画布）。
    per_frame_scales = None
    if cfg.get("match_head_to") and cfg.get("match_head_per_frame") and scale:
        ref_id = cfg["match_head_to"]
        ref_head = output_head_width(ref_id)
        fit_scale = compute_scale(body_bounds_list, foot_out)[0]
        per_frame_scales = []
        raw_heads = []
        for idx in src_index_of:
            hw = head_width_of(Image.open(os.path.join(raw_dir, names[idx])).convert("RGBA"), ignore_top_ratio=ignore_top)
            raw_heads.append(hw)
            if hw <= 0:
                per_frame_scales.append(scale)
                continue
            fs = ref_head / hw
            fs = max(0.05, round(min(fs, fit_scale), 4))
            per_frame_scales.append(fs)
        outs = [round(h * s, 1) for h, s in zip(raw_heads, per_frame_scales)]
        print(
            f"  逐帧头宽归一化（ref={ref_id}）: 目标 {ref_head}px；"
            f"原始头宽 {min(raw_heads)}~{max(raw_heads)}px"
        )
        print(
            f"    → 逐帧缩放 {min(per_frame_scales)}~{max(per_frame_scales)}；"
            f"归一后头宽 {min(outs)}~{max(outs)}px（跨度 {round(max(outs) - min(outs), 1)}px）"
        )
        head_match = {
            "ref": ref_id,
            "refHeadWidth": ref_head,
            "perFrame": True,
            "rawHeadWidths": raw_heads,
            "perFrameScale": per_frame_scales,
        }
        head_width_out = round(max(outs), 1)

    # ---------------------------------------------------------------- 按整体高度对齐（可选，优先级更高）
    #
    # ## 为什么"按头宽对齐"不够
    #
    # 用户看完按头宽对齐的版本后仍反馈：「坐着时和起身时桌宠还是偏小」。
    # 实测成品（头宽已全部 100%）：
    #
    #   stand 高度 1149.4（100%）  sit 1093.8（94.6%）
    #   sit-circle 1010.5（88.2%）  sit-stop 1031.5（95.5%）
    #
    # 也就是说：头一样大了，但**整个人还是矮一截** —— 用户的"大小"判据是
    # 整体高度/体量，不是头部。坐姿本身的轮廓更矮，按头对齐就会显得小。
    #
    # ## 做法：逐帧目标高度线性过渡，并要求**接缝连续**
    #
    #   `height_ramp: ("sit", "stand")`
    #     → 首帧目标高度 = start 动作的**末帧**高度（保证与上一段接得上）
    #     → 末帧目标高度 = end 动作的**均值**高度（保证与下一段接得上）
    #     → 中间线性插值
    #
    # 这样既把 circle/stop 放大到与 sit/stand 同量级，又不会在某段末尾
    # 突然比下一段高（那会变成另一种"跳"）。
    # ---------------------------------------------------------------- 按固定高度对齐（可选）
    #
    # 与 height_ramp 的区别：这里直接给一个**数值**目标高度，不从别的动作取。
    #
    # 用途：深度思考循环段。它按"站立高度"对齐后，因为姿势含胸、轮廓更窄，
    # **头会被放大 5%**（头宽 570 vs 第一段 555），用户反馈"第二段还略大一些"。
    # 所以给它一个略低于站立的高度目标，让它与第一段的**头宽**对齐。
    if cfg.get("height_target") and scale:
        target_h = float(cfg["height_target"])
        max_w = max(b[2] - b[0] + 1 for b in body_bounds_list)
        max_h = max(b[3] - b[1] + 1 for b in body_bounds_list)
        fit_scale = min((CANVAS_W - 2) / max_w, (foot_out + 1 - 2) / max_h)
        per_frame_scales = []
        raw_heights = []
        for idx in src_index_of:
            img = Image.open(os.path.join(raw_dir, names[idx])).convert("RGBA")
            b = body_bounds(img, exclude_left, ignore_top) or content_bounds(img)
            rh = (b[3] - b[1] + 1) if b else 1
            raw_heights.append(rh)
            fs = target_h / max(1, rh)
            per_frame_scales.append(max(0.05, round(min(fs, fit_scale), 4)))
        proj = [round(rh * fs, 1) for rh, fs in zip(raw_heights, per_frame_scales)]
        print(f"  高度目标 {target_h}px：逐帧缩放 {min(per_frame_scales)}~{max(per_frame_scales)}；"
              f"成品高度 {min(proj)}~{max(proj)}px")
        head_match = {"mode": "height-target", "targetHeight": target_h,
                      "perFrame": True, "perFrameScale": per_frame_scales}
        head_width_out = None

    if cfg.get("height_ramp") and scale:
        start_id, end_id = cfg["height_ramp"]
        start_h = output_last_frame_height(start_id)
        # 起止是同一个动作时表示"恒定为它的末帧高度"（不要用均值，
        # 否则会在这段内部缓慢变大，反而制造新的跳）。
        end_h = start_h if end_id == start_id else output_mean_height(end_id)
        # ⚠️ 这里**不能用 `compute_scale`**：它内部有 `min(..., 1.0)`，即"只缩不放"。
        # 而按高度对齐时目标高度可能比原始素材更大 —— 深度思考循环段就需要 1.045×
        # （角色原图偏矮），被 1.0 卡住后成品只有 1099px（目标 1149），
        # 用户看到的就是"还是比站立小一点"。
        # 所以这里自己算**允许放大**的适配上限，只受画布宽高约束。
        max_w = max(b[2] - b[0] + 1 for b in body_bounds_list)
        max_h = max(b[3] - b[1] + 1 for b in body_bounds_list)
        avail_w = CANVAS_W - 2
        avail_h = foot_out + 1 - 2
        fit_scale = min(avail_w / max_w, avail_h / max_h)
        n = len(src_index_of)
        raw_heights = []
        per_frame_scales = []
        targets = []
        for i, idx in enumerate(src_index_of):
            img = Image.open(os.path.join(raw_dir, names[idx])).convert("RGBA")
            # 用**角色本体**的高度做目标，而不是整幅内容高度。
            #
            # 为什么：深度思考循环段头顶有气泡（素材自带），`content_bounds` 会把气泡
            # 算进高度 —— 于是"对齐到站立高度"变成"角色 + 气泡 一起对齐"，
            # 角色实际仍偏小；同时 fit 上限也会被气泡顶高而收紧。
            # 这里统一用 body_bounds（尊重 bubble_ignore_top_ratio / bubble_exclude_left_ratio），
            # 于是这三段与坐姿三段用的是同一套"按整体高度对齐"的语义。
            b = body_bounds(img, exclude_left, ignore_top) or content_bounds(img)
            rh = (b[3] - b[1] + 1) if b else 1
            raw_heights.append(rh)
            t = start_h if n <= 1 else start_h + (end_h - start_h) * (i / (n - 1))
            targets.append(round(t, 1))
            fs = t / max(1, rh)
            fs = max(0.05, round(min(fs, fit_scale), 4))
            per_frame_scales.append(fs)
        proj = [round(rh * fs, 1) for rh, fs in zip(raw_heights, per_frame_scales)]
        print(
            f"  高度对齐（{start_id} 末帧 {round(start_h, 1)} → {end_id} 均值 {round(end_h, 1)}）"
        )
        print(
            f"    → 逐帧缩放 {min(per_frame_scales)}~{max(per_frame_scales)}；"
            f"成品高度 {min(proj)}~{max(proj)}px"
        )
        if max(proj) < max(targets) - 2:
            print("    （部分帧受画布宽度上限约束，未能完全达到目标高度）")
        head_match = {
            "mode": "height-ramp",
            "startAction": start_id,
            "endAction": end_id,
            "startHeight": round(start_h, 1),
            "endHeight": round(end_h, 1),
            "perFrame": True,
            "perFrameScale": per_frame_scales,
        }
        head_width_out = None

    os.makedirs(out_dir, exist_ok=True)
    report = []
    for i, name in enumerate(names):
        # 0) 复制帧：第 N 帧用第 M 帧的图（`src_index_of` 已在上面算好）。
        src_index = src_index_of[i]
        src = Image.open(os.path.join(raw_dir, names[src_index])).convert("RGBA")
        sb = raw_bounds[i]

        # 逐帧缩放：默认全段共用一个值；开了 match_head_per_frame 时逐帧不同。
        fs = scale if scale is not None else 1.0
        if per_frame_scales is not None:
            fs = per_frame_scales[i]

        # 1) 按内容框裁掉四周留白
        content = src.crop((sb[0], sb[1], sb[2] + 1, sb[3] + 1))

        # 2) 必要时缩放
        #
        # ⚠️ 条件用 `abs(fs-1) > 1e-9` 而不是 `fs < 1.0`：
        # 逐帧头宽归一化时，头画得偏小的那一帧需要**放大**才能与其它帧一致；
        # 只写 `fs < 1.0` 会静默跳过那些帧，段内的尺寸差就修不掉。
        # 上限已由 `fit_scale` 卡住，不会溢出画布。
        if fs is not None and abs(fs - 1.0) > 1e-9:
            sw = max(1, int(round(content.width * fs)))
            sh = max(1, int(round(content.height * fs)))
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
        px = int(round(CANVAS_W / 2 - content_rel_cx * fs))
        py = foot_out - content.height + 1

        # 垂直越界直接报错 —— 宁可失败也不要偷偷裁掉角色的头或脚。
        # 水平方向允许溢出（气泡），但**角色本体必须完整落在画布内**。
        if py < 0 or py + content.height > canvas_h:
            raise SystemExit(
                f"{name} 垂直方向越界：内容高 {content.height}，落点 y={py}。"
                f"需要更小的 fs（当前 {fs}）。"
            )
        body_px0 = px + int((body[0] - sb[0]) * fs)
        body_px1 = px + int((body[2] - sb[0]) * fs)
        body_py0 = py + int((body[1] - sb[1]) * fs)
        body_py1 = py + int((body[3] - sb[1]) * fs)
        if body_px0 < 0 or body_px1 >= CANVAS_W or body_py0 < 0 or body_py1 >= canvas_h:
            raise SystemExit(
                f"{name} 的角色本体越出画布：x {body_px0}~{body_px1}，y {body_py0}~{body_py1}"
                f"（画布 {CANVAS_W}x{canvas_h}）。需要更小的 fs（当前 {fs}）。"
            )

        canvas = Image.new("RGBA", (CANVAS_W, canvas_h), (0, 0, 0, 0))
        canvas.alpha_composite(content, (px, py))

        ob = content_bounds(canvas)
        out_name = f"frame_{i + 1:02d}.webp"
        canvas.save(os.path.join(out_dir, out_name), "WEBP", quality=OUTPUT_WEBP_QUALITY, alpha_quality=100, method=6)
        report.append(
            {
                "src": name,
                "out": out_name,
                "srcBounds": list(sb),
                "placedAt": [px, py],
                # 该帧实际用的缩放。逐帧头宽归一化时各帧不同，记下来便于复核。
                "scale": round(fs, 4),
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
        "sourceCanvasHeight": canvas_h,
        "drawOffsetY": [0] * len(report),
        "_note": f"由 scripts/dev/build-action-asset.py {action_id} 生成；与站立素材同一画布约定（水平居中 + 脚底基准 y={foot_out}）。",
        "_processing": {
            "canvas": {"w": CANVAS_W, "h": canvas_h},
            "scale": scale,
            "footBaseOutput": foot_out,
            # 成品头宽（输出空间）。做"与站立同大小"的校验时读它 ——
            # 比再解一遍 PNG 省事，也保证校验用的就是生成时的同一个数。
            "headWidthOut": head_width_out,
            "headMatch": head_match,
            # 逐帧缩放（未启用时为 None）。各帧不同，便于复核段内一致性。
            "perFrameScale": per_frame_scales,
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
    # 静态帧池：可选。非空表示这个动画"不播"，每次触发随机挑一帧（拖拽用它）。
    if cfg.get("static_frames"):
        manifest["staticFrames"] = list(cfg["static_frames"])
        print(
            f"  静态帧池：触发时从第 {', '.join(str(v) for v in cfg['static_frames'])} 帧里随机挑一帧"
            "（不播放、不推进）"
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
