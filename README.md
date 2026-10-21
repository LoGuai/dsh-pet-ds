# DSH 桌宠 · 深鲸娘

> 一个挂在桌面上的 DeepSeek 娘。会站着发呆、坐下偷懒、睡着被叫醒，也会陪你一起「深度思考」。

<img src="assets/animations/stand/frame_01.webp" width="220" alt="站立">
<img src="assets/animations/think-loop/frame_02.webp" width="240" alt="深度思考">

## 功能

- **常驻桌面**：透明置顶小窗，可拖动、5 档缩放，脚底始终贴地。
- **逐帧动作**：站立、坐下、睡觉、惊醒、吃白饭、玩游戏（三段：开始 / 循环 / 收尾），以及摸头 / 摸胸 / 戳腹 / 摸腿四个互动动画。
- **深度思考**：DSH 开始思考 → 抬头进入 → 低头循环 → 结束退出；思考中点击可立刻收回；另设 **300 秒上限**兜底，防止宿主状态卡住。
- **余额播报**：自动读 DeepSeek 余额，跨档时说话，面板常驻显示。
- **语音库**：36 组 / 96 条台词，按触发条件分类，好感度**累计解锁**；「语音库…」窗口可查。
- **好感度与心情**：点击、对话、动作、运行时长缓慢累积；存档在 userData，升级不丢。

## 安装

当前版本 **0.2.2**。三种方式任选其一，详细步骤见 [INSTALL.md](INSTALL.md)。

**从 GitHub 装（推荐）** —— 下载的是**一个安装包**（约 33 MB），不会克隆仓库：

```
install_bundle  target = https://github.com/liuguanyu9719-source/dsh-pet-ds/releases/latest/download/dsh-pet-ds.tgz
```

这个地址永远指向**最新一版**。想锁死在某一版，用该版本的 tag 快照（当前 0.2.2）：

```
install_bundle  target = https://github.com/liuguanyu9719-source/dsh-pet-ds/archive/refs/tags/v0.2.2.tar.gz
```

> ⚠️ **不要用仓库主页地址**（`…/dsh-pet-ds.git`）：那种形式会走 git 依赖，
> 需要先过一道 5 秒的连接预检、还会克隆整个仓库，国内网络下经常超时。

**一键安装包** —— 解压发布包，双击 `install.cmd`。

**从源码目录**：

```bash
node install.mjs
```

> 由 agent 代装：见 [docs/INSTALL-AGENT.md](docs/INSTALL-AGENT.md)　·　纯手动步骤：见 [docs/INSTALL-MANUAL.md](docs/INSTALL-MANUAL.md)

## 使用

**右键菜单（9 项）**

| 菜单项 | 作用 |
|---|---|
| 对话 | 随机说一句当前可用的闲置台词（不加心情/好感） |
| 语音库… | 打开语音库窗口，查看全部台词 |
| 动作 ▸ | 播指定动作；含「深度思考」与「触碰{部位}」 |
| 尺寸 ▸ | 5 档缩放，radio 显示当前档位 |
| 始终显示在最上层 | 置顶开关 |
| 回到初始位置 | 移回屏幕右下角 |
| 刷新状态 | 无条件收回闲置（防卡死） |
| 关于桌宠… | 版本与更新日志 |
| 退出桌宠 | 结束进程 |

**鼠标交互**

| 操作 | 反应 |
|---|---|
| 左键点击 | 按部位 + 好感档位说一句，播对应互动动画 |
| 拖动 | 跟着光标走，说「被拎起来」的台词 |
| 睡着时点击 | 叫醒（播惊醒动画） |
| 坐着时点击 | 立刻站起 |
| 思考中点击 | 结束深度思考 |

## 配置

配置写在插件设置里（DSH 设置页 → 桌宠），常用几项：

| 键 | 说明 |
|---|---|
| `size` | 初始尺寸档位 |
| `alwaysOnTop` | 是否常驻置顶 |
| `autoStart` | DSH 启动时自动拉起桌宠 |
| `lowBalanceThreshold` | 余额告急阈值（元） |
| `balancePollSeconds` / `refreshSeconds` | 余额刷新与播报节奏 |
| `apiBase` | DeepSeek API 地址（一般不用改） |

## 常见问题

**桌宠没出现？** 先在会话里让 agent 跑 `DSHpet_status` 看进程与端口；仍不行就看 DSH 日志里的 `[pet]` 行。

**动作不播 / 模型是旧的？** 启动日志里有一行「素材自检：N 个动作」。数字对不上就是**进程比素材旧**，重启桌宠即可。

**升级会丢好感吗？** 不会。存档在 `%APPDATA%\DSH Pet\affection.json`，安装器只清程序文件。

## 开发

```bash
npm test                 # 25 组 / 259 条断言
npm run dev              # 假宿主 + 桌宠（开发用，不碰真 DSH）
npm run dev:debug        # 同上，带桌宠 stderr
npm run build:package    # 打 tgz / exe / 一键安装包
```

渲染进程自测（含拖拽、命中测试、思考状态机）：

```bash
electron.exe pet-app --test-drag-follow --no-shot
```

## 目录结构

```
pet-app/       桌宠窗口（渲染进程、主进程、样式、素材加载）
src/host/      DSH 侧桥接：状态接口、进程守护、余额、配置
src/shared-core/  纯逻辑：动作/语音库、好感度、心情、协议
client/        设置页那一栏
assets/        动作素材（WebP 逐帧 + manifest）
scripts/       构建、打包、自测与探针
docs/          安装手册、发布流程、语音总览、技术方案
```

## 许可

代码 [MIT](LICENSE)；**美术素材单独授权**，见 [LICENSE-ART.md](LICENSE-ART.md)。

更新记录见 [CHANGELOG.md](CHANGELOG.md)，语音库清单见 [VOICE-LIBRARY.md](VOICE-LIBRARY.md)，架构细节见 [docs/DSH-桌宠插件技术方案.md](docs/DSH-桌宠插件技术方案.md)。
