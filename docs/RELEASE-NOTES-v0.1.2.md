# v0.1.2 — DSH 设置页里的「桌宠」一栏，以及可自行安装的安装包

这一版的主要工作是把插件从"能用"推到"能交付"：**设置页**让它可配置，
**安装包**让它可分发，并且**由 agent 自行安装**。

## 新增

**DSH 设置页里的「桌宠」一栏。** 不用再手改 YAML，直接在设置页调：

```
设置 ▸ 桌宠
  启动      自动启动桌宠 / 启动延迟（毫秒） / 退出 DSH 时关闭桌宠
  窗口      桌宠宽度（像素） / 始终显示在最上层
  余额监控  余额告急阈值（元） / 余额刷新周期（秒）
```

保存后由 DSH 自己写进 profile 的 `cordis.patch.yml` 并热应用 ——
本插件不碰任何文件。只有标了 `.volatile()` 的字段会出现在页面上，
所以改这些参数**不会**重挂插件。

**安装包 + 两条安装路径。** `node install.mjs` 一条命令装好并自验，
用**退出码**表达结论（`--json` 可拿一行机器可读摘要）。给人看的详细指引见
[INSTALL.md](../INSTALL.md)，给 agent 看的见 [INSTALL-AGENT.md](./INSTALL-AGENT.md)。

**右键菜单重构。** 「说句话」改为「对话」，并新建**专门的对话台词库**
（`src/shared-core/dialogue.js`，15 句，傲娇鲸鱼娘人设）。原来那栏没用的
「点击部位」清单删掉，点击互动并进「动作」栏、命名为「触碰{部位}」——
菜单按语义分三段并插分隔线，十来项不再平铺成一坨。

**余额无变化时不播报。** 5 分钟刷新周期里余额经常一动不动，
每次都念"刚才花掉了¥0"纯属干扰。

## 变更

**余额取数搬到桌宠侧。** 桌宠自己读凭据、自己直连接口、自己播报 ——
好处是**改取数/播报逻辑只需重启桌宠，不必重启 DSH**，而且 DSH 没开时
桌宠照样显示余额。取数算法只有一份（`src/shared-core/balance.js`），
宿主与桌宠共用。

**退出 DSH 时关闭桌宠。** `stopOnUnload` 默认从 `false` 改为 `true`。

**版本号统一到 0.1.2。** `package.json` / `pet-app/package.json` /
`src/host/index.js` 三处一致，并有断言防止漂移。

## 修复

三个都是"插件完全不加载"级别的故障，症状极其相似、都**没有日志**，
所以逐个记下真因。

**一、再导出导致静默不加载。** 我把 `DEFAULTS` 挪进 `defaults.js` 时写成
`export { DEFAULTS } from './defaults.js'` —— 再导出**不创建本地绑定**，
而 `normalizeConfig()` 里要用它，于是 `apply()` 抛 ReferenceError。
`node --check` 只验语法，抓不到未定义标识符。

**二、`@deepseek-ai/schemastery` 未声明为依赖。** DSH 会给自己的一部分包
注入模块解析，但**不是全部** —— `schemastery` 不在其中。（对照可用的
第三方插件，它明确写进了 `dependencies`。）

**三、插件目录缺 `node_modules`。** ESM 解析裸标识符时从**引用方文件**
所在目录往上找 `node_modules`。插件在 profile 里是**目录联接**，
真实锚点在插件目录，所以 profile 那份**不在解析链上**。
表现是插件页提示 `failed to import`。

**其它修复：** `stop` 之后无法 `start`（判活把已退出的进程当活着）；
`Supervisor.stop()` 不等桌宠真的退出，导致宿主退出后留下孤儿进程；
余额面板 UI（文案、字号、白字）。

## 安装 / 升级

```bash
# 从源码归档
node install.mjs          # 装 + 验，退出码 0 = 成功，然后重启 DSH

# 或用官方 CLI
dsh plugin --profile desktop add <本目录绝对路径>
```

升级前建议先停掉桌宠。**装完必须重启 DSH** —— 插件在启动时加载。

需要 Electron 运行时（桌宠是独立的 Electron 窗口进程）：

```bash
node scripts/dev/install-electron.mjs --version 38.2.0
```

## 验证

自测 10 组 **157 条断言**全过；语法 50 个文件；安装包内容校验 21 项。

改动史与踩坑记录见 [README.md](../README.md)（搜索 `failed to import`、
`schemastery`、`再导出`）。
