# DSH 桌宠插件技术方案（全新独立项目）

> 调查对象：本机实际安装的 DeepSeek Harness（Desktop）与其已安装插件。
> 调查时间：2026-10-13
> 工作目录：`D:\dsh\pet`
> 本文件为**阶段零交付物**。按用户要求，本阶段不编写大规模业务代码，完成调查与规划后暂停。

---

## 0. 结论速览（TL;DR）

| 问题 | 结论 | 证据强度 |
|---|---|---|
| DSH 插件是什么 | 一个 npm 包 + `dsh.bundle.patch` 声明的 Cordis 插件层 | 已核实（内核代码） |
| 插件入口形态 | `export function apply(ctx, config)`（或 `.apply` 对象 / 类），可带 `name`/`Config`/`inject` | 已核实 |
| 插件跑在哪 | Electron **utility process** 内的 Node ESM 模块，**能拿到完整 Node 能力**（fs / child_process / net / http） | 已核实 |
| 插件能否直接开桌面窗口 | **不能**（拿不到 `BrowserWindow` / `require('electron')`）；但**可以 spawn 独立进程** | 已核实 |
| 余额从哪来 | 两条路：① `ctx.credentials.resolve()` 拿 Key 自己请求官方余额接口（现成插件用这条）② DSH 原生 `ctx.deepseekAccount.getBalance()`（DeepSeek 账号登录态） | 已核实（两条都在代码里） |
| 深度思考能否识别 | **能**：`agent/assistant-stream` 事件的 `frame.chunk.type === 'reasoning-delta'` | 已核实（内核代码），**未运行时实测** |
| 插件如何被管理 | `dsh plugin --profile <name> add/remove`、Web「插件」页、`plugin_manager` 工具 | 已核实 |
| 本机 DSH 版本 | **0.2.0-rc.2**（desktop 与 CLI 同版本），Node 24.21.0 / pnpm 11.7.0 | 已核实 |
| 推荐架构 | **方案 B 的改良版**：Host 插件（数据+事件+工具） + 独立 Electron 桌宠进程（窗口+动画），中间用**回环 HTTP + 长轮询**通信 | 见 §5 |

**最重要的一条设计约束**：插件运行在 utility process，**没有 Electron 主进程权限**，因此"桌面透明窗口"必须由独立进程承担。用户提示中担心的这一点已被证实，且参考项目正是这样做的。

---

## 1. 调查方法与证据等级

### 1.1 证据来源（全部为真实文件）

| 来源 | 绝对路径 | 用途 |
|---|---|---|
| DSH 安装目录 | `C:\Users\29845\AppData\Local\Programs\DeepSeek Harness\` | Electron 载体、`app.asar` |
| DSH 主运行时（asar 内） | `...\resources\app.asar\dsh\` | 内核 209 个 `@deepseek-ai/*` 包 |
| DSH unpacked | `...\resources\app.asar.unpacked\dsh\node_modules\` | 原生模块（node-pty、sharp、sherpa-onnx、koffi…） |
| DSH Home | `C:\Users\29845\.dsh\`（`DSH_HOME`） | profile、凭据、会话、存储 |
| 已装桌面 profile | `C:\Users\29845\.dsh\profiles\desktop\` | 真实 bundle 列表与开关状态 |
| 参考项目 A（用户指定） | `https://github.com/PC2005-cloud/dsh-pet` → npm `dsh-pet@0.3.6` | 完整三件套项目 |
| 参考项目 B（本机已装） | `C:\Users\29845\.dsh\plugin-sources\dsh-deepseek-pet-0.2.14\` | `@deepseekstudio/dsh-deepseek-pet@0.2.14` |
| 参考项目 B 逐行分析报告 | `D:\dsh\pet\_research\dsh-deepseek-pet-0.2.14-analysis.md` | 对 B 的 C# 侧与宿主侧逐行核对结果（含 21 项缺陷清单） |
| 插件市场 | `C:\Users\29845\.dsh\profiles\desktop\node_modules\dshmarket\` | 安装/更新/兼容性机制 |
| 提取内核源码副本 | `D:\dsh\pet\_research\dsh-extract\` | 本次调查的本地只读副本 |
| asar 读取工具 | `D:\dsh\pet\_research\asarextract.cjs` | 自制，用于读取 `app.asar` |

> `app.asar` 的 header 解析在本机 build 上实测为：`u32@0 = 4`，`u32@4 = headerPickleSize`，JSON 长度 = `u32@8 - 4`，JSON 起始偏移 = 16，数据段起始 = `16 + jsonLength`（本机为 3392064）。工具见 `_research\asarextract.cjs`。

### 1.2 证据等级标记

- **【核实】**：直接读到内核 / 插件的真实代码或真实文件，附路径与行号。
- **【文档】**：官方包内 README（随包发布的权威文档），附路径与行号。
- **【社区】**：第三方站点内容，仅作线索，不作为依据。
- **【未确认】**：本阶段无法证实，明确标注，不臆造。

### 1.3 重要提醒：用户给的两个项目不是同一个

| | 用户指定 | 本机实际已安装 |
|---|---|---|
| 仓库 | `github.com/PC2005-cloud/dsh-pet` | `github.com/Yoshino-JF/dsh-deepseek-pet` |
| npm 包 | `dsh-pet@0.3.6` | `@deepseekstudio/dsh-deepseek-pet@0.2.14` |
| 形态 | **浏览器 overlay + Electron 独立窗（双模式）**，TS/React | **C# WinForms 原生 exe**，纯 Node 宿主桥 |

两者**架构完全不同**，正好构成本方案的两极对照。本报告两个都分析（§3 分析 A，§2.11 与附录分析 B）。

---

## 2. 交付物 A：DSH 插件机制调查报告

### 2.1 本机环境事实

| 项 | 值 | 来源 |
|---|---|---|
| DSH desktop 版本 | `0.2.0-rc.2` | `runtime\primary-runtime\runtime.json` 的 `desktopVersion`；`@deepseek-ai/dsh\package.json` 的 `version` |
| Node | 24.21.0（运行时 `versions.json` 声明 24.18.1） | `runtime.json`、`resources\runtime\versions.json` |
| pnpm | 11.7.0 | 同上 |
| Python | 3.12.14（numpy/pandas/Pillow 等已内置） | `runtime.json` |
| `DSH_HOME` | `C:\Users\29845\.dsh` | 环境变量 |
| `DSH_PROFILE` | `desktop` | 环境变量 |
| Web GUI | `http://127.0.0.1:19387` | `DSH_WEB_URL`，端口由 desktop host 固定传入 |
| Electron 更新通道 | `nightly`，`https://download.deepseek.com/dsh-desk/feeds/win-x64/` | `resources\app-update.yml` |

CLI 启动器（关键，说明 DSH 就是 Electron 以 Node 模式跑）：

```bat
:: C:\Users\29845\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd
@echo off
setlocal DisableDelayedExpansion
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\..\..\..\DeepSeek Harness.exe" --expose-internals "%~dp0..\..\..\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js" %*
exit /b %errorlevel%
```

### 2.2 插件如何被发现与加载【核实】

DSH 的插件系统 = **Cordis 插件框架 + profile 分层 patch 组合**。

**组合顺序**（`@deepseek-ai/dsh\README.md` L41-46，代码实现见 `dsh-app-boot\lib\index.js` 的 `applyEntryPatches` L61-110 与 `composeEntries` L989-994）：

```
空根 ([])
  → 按 dsh.profile.bundles 顺序，逐层叠加每个 bundle 的 patch
  → profile 自己的 cordis.patch.yml
  → home 级 $DSH_HOME/cordis.patch.yml
  → 命令行 --patch 覆盖层
```

**bundle 解析顺序**（`@deepseek-ai/dsh\README.md` L46）：先从 **DSH 安装**里解析（`@deepseek-ai/dsh-base`、`-web-app`、`-headless`、`-sdk-app`、`-sdk-minimal`、`-acp-app`），再从 **profile 自己的 `node_modules`** 解析（pnpm 安装的第三方插件）。

**本机 desktop profile 的真实现状**（`C:\Users\29845\.dsh\profiles\desktop\package.json`）：

```json
{
  "name": "dsh-profile-desktop",
  "private": true,
  "dsh": { "profile": { "bundles": [
    "@deepseek-ai/dsh-base",
    "@deepseek-ai/dsh-web-app",
    "@deepseekstudio/dsh-deepseek-pet",
    "dshmarket",
    "@ggboy123/dsh-paper-reader"
  ] } },
  "dependencies": {
    "@deepseekstudio/dsh-deepseek-pet": "file:C:/Users/29845/.dsh/plugin-sources/dsh-deepseek-pet-0.2.14/deepseekstudio-dsh-deepseek-pet-0.2.14.tgz",
    "@ggboy123/dsh-paper-reader": "1.2.0",
    "dshmarket": "^1.66.11"
  }
}
```

profile 根的 `cordis.yml` 是**空数组**，注释明确说"不要改它，改 `cordis.patch.yml`"：

```yaml
# C:\Users\29845\.dsh\profiles\desktop\cordis.yml
[]
```

### 2.3 manifest 格式：DSH 实际读取的 `package.json` 字段【核实】

**权威判定代码**：`@deepseek-ai/dsh-plugin-manager\lib\index.js` L220-229

```js
function bundleManifest(name, dir, anchor) {
  const manifest = readProfileManifest("dsh", resolveBundleDir("dsh", name, anchor, dir));
  return manifest.dsh?.bundle?.patch === void 0 ? void 0 : manifest;
}
```

即：**`dsh.bundle.patch` 存在 ⇒ 是 bundle**；不存在 ⇒ 只是普通依赖（安装时内核会打印警告：

`dsh: warning: <name> declares no dsh.bundle — installed as a plain dependency, not a profile layer`，见 `operations.js` L59）。

**完整字段清单**：

| 字段 | 位置 | 必需 | 语义 | 依据 |
|---|---|---|---|---|
| `dsh.bundle.patch` | package.json | ≥1 个 bundle 必需 | 单个 patch 文件路径，或**有序数组** | 【核实】`dsh-app-boot\lib\index.js` L495-509 `bundlePatchFiles`/`bundlePatchPaths` |
| `dsh.profile.bundles` | **profile 的** package.json | 是 | 有序 bundle 名列表（层顺序即优先级） | 【核实】`plugin-manager\lib\index.js` L242、L1459 |
| `dsh.client.platform` | package.json | 有浏览器半侧时必需 | 必须为 `'web'`，否则忽略 | 【核实】`dsh-client-modules\lib\index.js` L61-75、L714 |
| `dsh.client.inject` | package.json | 否 | 客户端包依赖名数组（浏览器侧包） | 【核实】同上 L66 |
| `dsh.client.external` | package.json | 否 | 外部化模块名数组 | 【核实】同上 L67 |
| `dsh.client.immediately` | package.json | 否 | boolean | 【核实】同上 L68 |
| `dsh.engines.dsh` | package.json | 否 | 宿主版本范围（与顶层 `engines.dsh` 二选一，顶层优先） | 【核实】`dshmarket\lib\discovery-compatibility.js` L44、L56 |
| `icon` | package.json **顶层** | 否 | 相对路径 SVG/PNG/JPEG/WebP，≤256 KiB，须留在包目录内；会被内联成 data URL | 【核实】`dsh-app-boot\lib\index.js` L1855-1876 `iconOf` |
| `peerDependencies["@deepseek-ai/dsh*"]` | package.json | **实质上必需** | 版本兼容闸门，不匹配则拒绝加载 | 【核实】`dsh-app-boot\lib\index.js` L52（文档）+ 加载逻辑 |
| `main` / `exports["."]` | package.json | 是 | 宿主半侧入口（Node ESM） | 【核实】Loader `import(this.options.name)` |
| `exports["./client"]` | package.json | 有 `dsh.client` 时必需 | 浏览器半侧 bundle，缺失直接抛错 | 【核实】`dsh-client-modules\lib\index.js` L718-719 |
| `dsh.compatibility.dshReleases` | package.json | 否 | **不是内核字段**；生态/商城约定（逐版本 compatible/incompatible/unknown） | 【核实】内核与 dshmarket 均不读取；`dsh-pet` 自行声明 |

> ⚠️ **不要发明内核字段**。`dsh.compatibility` 内核不读；内核只认 `peerDependencies`（对 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*`）加 `engines` 两种声明。

**版本兼容闸门的确切语义**（`dsh-app-boot\README.md` L52）：

> Before a profile imports a plugin, DSH checks its `peerDependencies` on `@deepseek-ai/dsh` and `@deepseek-ai/dsh-*` against the single runtime version returned by `getDshRuntimeVersion()`. Every declared range must match; prereleases participate in range matching. Source-workspace `workspace:^`/`~`/`*` refer to that same runtime. **Missing DSH peers impose no constraint**; invalid ranges are incompatible. **These checks use peer declarations, not `engines.dsh`, and are not a sandbox against malicious package code.**

**跳过而非崩溃**（同 L50）：bundle 解析/清单/patch 加载失败 → 跳过该 bundle、**不改变其选择状态**，记入 `skippedBundles`，启动时打印一次。profile 与 user patch 的错误仍然让启动失败。

### 2.4 插件入口文件如何定义【核实】

**Cordis 插件形状**（`@deepseek-ai/cordis\src\registry.ts` L92-145）：

```ts
export type Plugin<T = any> = Plugin.Function<T> | Plugin.Constructor<T> | Plugin.Object<T>

namespace Plugin {
  interface Object<T> {
    name?: string                              // 诊断/日志名
    Config?: StandardSchemaV1<any, T>          // 配置校验 schema
    inject?: string[] | Record<string, ...>    // 必需服务
    apply(ctx: Context, config: T): any        // 对象式插件
  }
}
```

**导出形状归一化**（`@deepseek-ai/cordis-plugin-loader\lib\index.js` L664-669）：

```js
unwrapExports(exports) {
  if (isNullable(exports)) return exports
  exports = exports.default ?? exports
  if (!exports.__esModule) return exports
  return exports.default ?? exports
}
```

**Loader 如何加载一行**（`cordis-plugin-loader\src\config\entry.ts` L221-235）：

```ts
private async _init() {
  exports = await this.parent.tree.import(this.options.name, this.getOuterStack)
  const plugin = this.loader.unwrapExports(exports)
  this.fiber = this.ctx.registry.plugin(plugin, this.options.config, this.getOuterStack).ctx.fiber
}
```

即：`name` 是**模块说明符**（包名 / 绝对路径 / file URL），import 后在 `this.options.config` 下应用。

**真实入口样例**（`dsh-deepseek-pet\index.js` L15-40，全部为真实代码）：

```js
import http from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-pet'
export const inject = ['tools', 'credentials']

export function apply(ctx, config) { /* ... */ }
```

> 这证明：**插件是普通 ESM 模块，可以直接 `import 'node:http'` / `node:child_process` / `node:fs`。**

### 2.5 cordis.patch.yml 的 entry/patch schema【核实】

**Loader entry 选项**（`cordis-plugin-loader\src\config\entry.ts` L9-23）：

```ts
export interface EntryOptions {
  id: string            // 树内稳定 id
  name: string          // 被 import 的模块说明符
  config?: any          // 传给插件的配置
  group?: boolean|null  // 标记为嵌套 group
  disabled?: boolean|null
  inject?: Inject|null
}
```

**patch 语义**（`dsh-app-boot\lib\index.js` L61-110 的 `applyEntryPatches`，这是**唯一权威实现**，`dsh --dump-config` 与真实启动共用同一份）：

| patch 形状 | 行为 |
|---|---|
| `{ insert: [entry, ...] }` | **无 `id`** → 追加到当前层数组末尾；**有 `id`** → 该 id 必须指向一个 `group` entry，把 insert 推进它的 `config` 数组 |
| `{ id, name?, ...overrides }` | 按 `id` 定位已有 entry；`name` 若给了则作为**断言**（不匹配则警告跳过，`L100-103`）；其余键**整体覆盖**目标 entry 的字段 |
| `{ id, disabled: true }` | 禁用某行（`writePluginEnabled` 就写这个） |

**`!!js` 表达式**：`cordis.patch.yml` 里可以用 `!!js` 标量，在 entry 激活时求值（`dsh-app-boot\lib\index.js` L20-33 定义了 `tag:yaml.org,2002:js`）。`disabled: !!js ...` 也支持。

**真实 patch 文件**（参考项目 A，`dsh-pet\cordis.patch.yml`）：

```yaml
- insert:
    - id: dsh-pet
      name: 'dsh-pet'
```

同一文件里的作者注释还给出两条**生态约定**（不是内核规则，但值得遵守）：
- `id` 必须全局唯一，且**与包名一致**（DSH STORE 上架契约按它比对 entryIds，裸名如 `pet` 会与其他插件冲突）
- `id: 值` 那一行**不能写行尾注释**，商城预检用正则抓该行

### 2.6 生命周期【核实】

**Fiber 生命周期**：`ctx.plugin()` 返回 `Fiber`；服务、事件监听、effect 在**拥有它的 fiber 被 dispose 时自动清理**（`@deepseek-ai/cordis\README.md` L61-67）。

**卸载清理的正确写法**（真实代码，`dsh-deepseek-pet\index.js` L222、L414、L431）：

```js
ctx.effect(() => () => { try { server.close() } catch {} })       // 关 HTTP server
ctx.effect(() => () => clearInterval(timer))                       // 清定时器
ctx.effect(() => () => clearTimeout(boot))                         // 清启动延时
```

`ctx.effect(callback)` 的约定：callback 返回一个 disposer，fiber 销毁时调用。

**失败的后果分档**（`dsh-app-boot\README.md` L94-107，非常关键，直接影响我们的容错设计）：

| 失败形态 | 可选 entry | 必需 entry | 配置热重载 |
|---|---|---|---|
| 模块 import 失败 / 求值抛错 | 警告，继续 | **停启动** | 报错，保留成功兄弟 |
| 插件 config schema 校验失败 | 警告，继续 | 停启动 | **新 entry 不激活**；已有 entry 保留旧实例与旧 config |
| `!!js` 求值抛错 | 警告，继续 | 停启动 | 报错 |
| **同步 `apply()` 抛错** | 警告，继续 | 停启动 | 报错 |
| **异步 `apply()` 抛错** | settle 后警告，继续 | settle 后停启动 | 报错 |
| 注入的服务不可用 | 警告，**entry 等待依赖** | 停启动 | 保持等待；补上 provider 可激活 |
| HTTP 端口占用 | 警告，**该 endpoint 缺失**，继续 | 停启动 | 保持进程运行 |
| **`apply()` 返回 Promise 之外的后台异步产生 unhandled rejection** | **致命：销毁应用并 exit != 0** | 致命 | **致命，与 entry id 无关** |
| **同步回调（stream `'data'` 监听、timer）抛未捕获异常** | **致命** | 致命 | **致命** |

> 🚨 **这是本方案最重要的工程约束之一**。参考项目 `index.js` L416-425 的注释记录了他们踩过这个坑：
> ```
> // 自动启动必须整体包在 try/catch 里：这个回调跑在宿主启动的定时器上，
> // 任何未捕获异常都会冒泡成 uncaughtException，直接把整个宿主进程打死（0.2.6 的真实故障）。
> ```
> 我们的行为决策器必然有大量 timer 与异步回调，**每一个都必须自带 try/catch，并且绝不能产生游离的 unhandled rejection**。

### 2.7 事件注册与注销【核实】

- 注册：`ctx.on(eventName, payload => {})`；注销随 fiber dispose 自动完成。
- **agent 作用域事件**由 `agentEvents()` 构造的 dispatch 发出，**通过 `ctx.events.dispatch` 打到全局 ctx**（`dsh-agent\lib\types\dispatch.js` L31-73），并且**框架自身对异常做了隔离**：

```js
// dispatch.js L44-62
emit(name, payload) {
  const args = [carrier, name, fused(payload)]      // fused = { ...payload, agent }
  const callbacks = ctx.events.dispatch('emit', args)
  for (const callback of callbacks) {
    try { const returned = callback(...args); void Promise.resolve(returned).catch(...) }
    catch (error) { ctx.logger.warn(`agent event "${name}" listener threw: ...`) }
  }
}
```

注意：**`agent/*` 事件监听器抛错会被框架吞掉并记 warn**，不会波及宿主。但**我们自己起的 timer / stream 回调不受此保护**（见 §2.6）。

**已核实的真实事件名**：

| 事件名 | payload | 出处 |
|---|---|---|
| `agent/status` | `{ agent, status: 'running' \| 'idle' }` | 发出：`dsh-agent-loop\lib\index.js` L790-799；订阅：`dsh-deepseek-pet\index.js` L232 |
| `agent/inbox/inserted` | `{ agent, message }` | 发出：`dsh-agent-loop\lib\index.js` L206；订阅：`pet\index.js` L228 |
| `agent/inbox/claimed` | `{ agent, ... }` | 发出：`agent-loop\lib\index.js` L106 |
| `agent/inbox/discarded` | `{ agent, message }` | 发出：`agent-loop\lib\index.js` L205 |
| **`agent/assistant-stream`** | `{ agent, frame }` | 发出：`agent-loop\lib\index.js` L1067-1068 |
| `agent/error` | `{ agent, ... }` | 发出：`agent-loop\lib\index.js` L880 |
| `deepseek-account/signed-out` | — | `dsh-deepseek-account-platform\lib\types\index.js` L301 |
| `deepseek-account/session-expired` | — | 同上 L299；`dsh-deepseek-account\lib\invariant.js` |
| `credentials/reference-updated` | `ref` | `dsh-credentials\lib\invariant.js` L20 |
| `credentials/record-updated` | `key` | `dsh-credentials\lib\index.js` L132 |
| `loader/entry-init` / `loader/partial-dispose` | — | `cordis-plugin-loader` |
| `app-boot/config-reload` | — | `dsh-app-boot\README.md` L90 |
| `webserver/index-inject` | `table` | `dsh-client-modules\lib\index.js` L553 |
| `tools/pre-execute` / `tools/execute` / `tools/post-execute` / `tools/result` | — | `dsh-tools\README.md` L85 |
| `agent/pre-step` / `agent/request` / `agent/request-error` / `agent/turn-stopping` | waterfall/serial | `agent-loop\lib\index.js` L911/L1179/L1124/L999 |
| `workspace/session-activity` | `{ sessionId }` → 数组 | `dsh-desktop-host\lib\index.js` L170 |

> 另外 `dsh-deepseek-pet` 在 L193-201 注册了一个**仅供开发验收**的 `/dev/event` 回环端点来手工触发事件——这是很好的测试手段，我们可以借鉴。

### 2.8 插件如何读取配置【核实】

`cordis.patch.yml` 的 `config:` 块**原样**作为 `apply(ctx, config)` 的第二参数传入。

真实样例（参考项目 A 的 patch 与其 `DEFAULTS` 合并）：

```yaml
# dsh-pet\cordis.patch.yml（参考项目 A）
- insert:
    - id: dsh-pet
      name: 'dsh-pet'
      config:
        port: 47831
        credential: DEEPSEEK_API_KEY
        apiBase: 'https://api.deepseek.com'
        refreshSeconds: 60
        lowBalance: 10
        autoStart: true
        startDelayMs: 3000
```

```js
// dsh-deepseek-pet\index.js L25-41
const DEFAULTS = Object.freeze({ port: 47831, /* ... */ stopOnUnload: false })
export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config || {}) }
```

**热更新语义**（重要）：
- 用 **`volatile()`** 标记的 schema 字段可以**不重挂载**地热更新到运行中的实例（`cordis-plugin-loader\src\config\entry.ts` L143-148、`_commitVolatile` L162-195）。
- 普通字段变化会走 entry 的 update 生命周期（`fiber.update`）。
- 手改 `cordis.patch.yml` 时：**`dsh-hmr` 启用才有热生效**；否则需要重启（`plugin-manager\README.md` L14）。本机 desktop profile 是否启用 HMR 需实测（`cordis.patch.yml` 未列 HMR 行）→ 见 §9 风险 R7。
- 配置来源注释（不是我们配置文件能决定的）：**profile patch 先应用，home 级 `$DSH_HOME/cordis.patch.yml` 后应用、优先级更高**（`app-boot\README.md` L61）。

### 2.9 插件如何保存持久化数据【核实 + 部分未确认】

三条可用路径：

**路径 1：DSH 存储子系统（正统、类型化）**

- 服务名 `ctx.storageDomain`，注册表 `ctx.storage`（`dsh-storage\README.md` L12、L28、L51）。
- 组成：`@deepseek-ai/dsh-storage` + 一个后端（如 `@deepseek-ai/dsh-storage-json`，配 `root`）+ `@deepseek-ai/dsh-storage-domain`。
- 后端契约：`src/backend.ts`，唯一 facet 是 `kv`；unit 名须匹配 `UNIT_NAME_RE`；记录 key 是任意字符串；**unit 不序列化并发写，顺序由调用方负责**；版本不匹配直接 `version-mismatch` 拒绝（无迁移）（`dsh-storage\README.md` L79）。
- 失败码：`backend-not-found` / `form-not-mounted` / `duplicate-backend` / `duplicate-mount`，都是 **fail loud**（L54-58）。
- 本机 `C:\Users\29845\.dsh\storages\` 存在。

> ⚠️ **【未确认】**：本机 desktop profile **是否挂载了 storage / storage-domain 行**，以及 `ctx.storageDomain` 在 desktop 组合下是否可直接使用。需要在开发阶段用 `dsh --dump-config`（注意：CLI 对 `desktop` 这个名字拒绝 dump，见 §2.13）或运行时探测确认。

**路径 2：自己写文件（立即可用、最可控）**

插件有完整 `node:fs`。参考项目 A 就是这么做的：
- 用户配置 `$DSH_HOME/dsh-pet/main-config.jsonc`
- 对话记忆 `$DSH_HOME/dsh-pet/memory.json`
- pet pack 扫描 `$DSH_HOME/dsh-pet/pet/<种类>-config.json` + `<种类>-animation/`

**路径 3：`ctx.credentials.readRecord/writeRecord`**

只能存凭据形态的记录（`kind: apiKey | grant`），**不适合放心情值**（`dsh-credentials-local\lib\index.js` L196-266 对文档 schema 是严格白名单）。

**本方案建议**：心情/状态用**路径 2**（`$DSH_HOME\<plugin-id>\state.json`，原子写），把 storage 作为后续可选升级。

### 2.10 插件如何访问 DSH 当前工作状态【核实】

三层可用信息，粒度递增：

| 粒度 | 手段 | 能知道什么 | 依据 |
|---|---|---|---|
| 粗 | `agent/status` | `running` / `idle`；是否**用户主动发起**需自己用 `agent/inbox/inserted` + 时间窗判断 | `agent-loop\lib\index.js` L798；`pet\index.js` L224-244 |
| 中 | `agent/assistant-stream` 的 frame | 流式：`start` / `chunk` / `end`，chunk 里有 `text-delta` / `reasoning-delta` / `tool-call-delta` / `usage` / `finish` | `agent-loop\lib\index.js` L355-472 |
| 细 | 工具调用（`tools/execute`、`tools/result`） | 正在跑哪个工具 | `dsh-tools\README.md` L85 |

**`agent/assistant-stream` 的 frame 精确结构**（`agent-loop\lib\index.js` L386-447）：

```js
// start
{ type: 'start', attemptId, revision, turn, step }
// 每个 chunk
{ type: 'chunk', attemptId, revision, index, time, chunk }
//   chunk 是 dsh-llm 的 StreamChunk（见 dsh-llm\lib\typert.host.js L505）：
//   { type:'block-start', index, blockType }
//   { type:'text-delta', index, text }
//   { type:'reasoning-delta', index, text }      ← 深度思考
//   { type:'tool-call-delta', index, id, name?, argumentsDelta }
//   { type:'block-end', index, block }
//   { type:'usage', usage }
//   { type:'finish', reason, replayState? }
// end
{ type: 'end', attemptId, revision, index, outcome: { kind:'committed', eventType, seq } | { kind:'abandoned' } }
```

于是"工作档位"可以直接、精确地映射：

| 桌宠状态 | 触发条件（真实字段） |
|---|---|
| 深度思考 | `frame.type === 'chunk' && frame.chunk.type === 'reasoning-delta'` |
| 工作（写正文） | `frame.chunk.type === 'text-delta'` |
| 整理/调用工具 | `frame.chunk.type === 'tool-call-delta'` 或 `block-start` 的 `blockType === 'tool-call'` |
| 等待 | `agent/status === 'idle'` 且 inbox 有排队 |
| 成功 | 回合结束且无 `agent/error`（`finish.reason` 可细分） |
| 失败 | `agent/error` 事件 |
| 空闲 | 无活动超过 N 秒 |

**注意**：`agent/status` 的 `running` 覆盖"生成中 + 跑工具 + 等审批"，所以**"等待"不能只靠 status**，最终判定应结合 `assistant-stream` 的静默时长。

### 2.11 插件能不能创建独立桌面窗口【核实：不能直接创建，但能 spawn】

**进程模型（决定性证据）**：DSH Desktop 的 host 是一个 **Electron utility process** 的脚本入口。

`dsh-desktop-host\lib\index.js` L216-245（`main()`）与 L248-344：

```js
async function main() {
  const runtimeDir = process.argv[2]
  const projectDir = process.argv[3]
  const application = runProfile({ /* ... */ args: ['--no-open', '--port', '19387'] })
  // ...
  const send = (message) => new Promise((resolve, reject) => {
    if (!process.connected || process.send === undefined) { resolve(); return }
    process.send(message, (error) => { ... })
  })
  process.on('message', (message) => { /* shutdown / quit-inspection / update-tasks */ })
  process.once('disconnect', () => { stop() })
  const { ctx } = await application
  const url = ctx.connection.authenticatedUrl(`http://127.0.0.1:${String(ctx.webServer.port)}`)
  if (process.connected) process.send?.({ type: 'ready', url, injections: ctx.webServer.collectIndexInjections() })
}
```

判读：
1. 用 `process.send` / `process.on('message')` / `process.connected` / `process.once('disconnect')` → 这是 **Node 子进程/utility process 的 IPC 通道**，不是 Electron 主进程。
2. `Electron 主进程`持有窗口、欢迎页、更新对话框（`app.asar\lib\main.js` 490 KB、多个 `preload-*.cjs`），通过 `process.send` 把 `ready` 消息与 boot injections 交给主进程渲染页面。
3. 我们的插件是 **这个 utility process 里的普通 Node ESM 模块** → **没有 `BrowserWindow`、没有 `require('electron').app`、没有原生窗口能力**。
4. **但**：`dsh-deepseek-pet\index.js` L15-16、L273-278 证明插件可以 `import { spawn } from 'node:child_process'` 并 **detached + unref** 地拉起独立进程：

```js
const child = spawn(exe, ['--url', `http://127.0.0.1:${port}/state`], {
  detached: true, stdio: 'ignore', windowsHide: true,
})
child.unref()
```

**结论**：桌面透明窗口**必须由插件 spawn 出来的独立进程承担**。这不是"退而求其次"，而是该架构下**唯一**且被两个参考项目验证过的做法。

### 2.12 插件的权限、安全边界与运行限制【核实】

| 维度 | 事实 | 依据 |
|---|---|---|
| 文件沙箱 | **插件 Host 代码在工作区沙箱之外、在进程内执行** | `plugin-manager\README.md` L31：*"installed Host code executes in-process outside the workspace sandbox"* |
| 权限 | 插件代码**以宿主用户权限**运行，有完整 `node:fs` / `node:child_process` / `node:net` / `fetch` | `dsh-deepseek-pet\index.js` L15-17；`plugin-manager\README.md` L58（build 脚本"permits commands with the host user's permissions"） |
| 恶意代码 | peer 检查**不是**恶意包的沙箱 | `app-boot\README.md` L52：*"not a sandbox against malicious package code"* |
| 安装需授权 | `plugin_manager` 工具的每个动作需要 `danger-full-access` 或逐次审批；低沙箱模式下 `ask` 审批，`never`/拒绝/无审批通道则**不执行** | `plugin-manager\README.md` L31 |
| 依赖构建脚本 | pnpm 11 会拦截依赖的 build script，需显式批准（`pendingBuilds` / `approvedBuilds`），批准**按包名持久化**且以宿主用户权限执行 | `plugin-manager\README.md` L58 |
| 子进程环境 | 服务侧操作用**清洗过的环境**、捕获输出；CLI 侧继承认证变量与终端 | `plugin-manager\README.md` L94 |
| 客户端侧 | 浏览器半侧通过 `dsh.client` 注入到 Web 页面，与 Host 之间走 DSH 自己的连接层（**不是**直接共享进程） | `dsh-client-modules\lib\index.js` L103-124 |
| Renderer 隔离 | 凭据/token 明确**不下发** renderer（`resolveToken` 只给 Host） | `dsh-account-controller` / `dsh-deepseek-account\README.md` L39 |

> 实践含义：**装一个插件 = 给它你的整个用户权限。** 我们的插件应当把这当成设计责任：不写工作区之外的路径（除 `$DSH_HOME` 下自己的目录）、不联网除 DeepSeek API 之外的目标、不在日志里打印凭据。

### 2.13 插件如何安装、调试、打包、分发【核实】

**安装（三条路，全部核实）**：

```sh
# 1) CLI —— 注意 desktop profile 必须用 Desktop 安装自带的 dsh 命令
dsh plugin --profile <name> add <pkg | file:<dir> | github:user/repo>
dsh plugin --profile <name> remove <pkg>
dsh plugin --profile <name> <pnpm args...>          # 直接透传 pnpm

# 2) 应用内插件管理页（Web 侧栏「插件」）
# 3) Agent 的 plugin_manager 工具（action: list_plugins / list_bundles / set_plugin /
#    set_bundle / install_bundle / remove_bundle / list_version_exemptions / set_version_exemption）
```

**关键限制（必须记住）**：`desktop` 这个名字是 **Electron 专属 profile**，**CLI 拒绝为它做 boot 与 config-dump**，npm 版 CLI 也拒绝它的插件管理请求；只有 **Desktop 安装自带的命令**能用该安装的 runtime 管理它。

> 依据：`@deepseek-ai/dsh\README.md` L20：
> *"The `desktop` name is reserved for the Electron-owned profile, so the CLI rejects boot and config-dump requests for it. The npm CLI also rejects its plugin-management requests; the Desktop-installed command can manage the initialized Desktop profile using that installation's runtime."*

于是本机的正确命令是：

```powershell
& 'C:\Users\29845\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add <spec>
```

（我们这套工具里的 `pet_control` 已证明 desktop profile 的插件确实在跑。）

**调试**：
- `--dump-config` / `--dump-default-config`：打印组合后的 entry 树，带来源文件注释（对 `desktop` 不可用，需另建一个 profile 观察）。
- `--dump-config-schema`：导入组合树里各插件声明的 schema，打印 JSON Schema（**会执行插件代码，勿对不可信插件使用**）。
- 日志：插件可直接 `console.log`（`dsh-deepseek-pet` 用 `say()` 包了一层），宿主把它并入自己的日志。
- 安装诊断日志：`<profile>\.plugin-manager\logs\operation-*\pnpm.log`（本机已存在多个）。
- 自建回环端点 + mock server 做端到端调试（参考项目 A 用 `dev-mock-server.mjs`；参考项目 B 用 `/dev/event`、`/health`）。

**打包 / 分发**：
- 包结构 = 一个 npm 包，`files` 白名单收敛产物；`dsh.bundle.patch` 声明 patch 文件。
- 发布前建议 `pnpm pack --dry-run` / `npm pack` 检查内容物。
- 参考项目 A 的 `prepack` 链很值得抄：`build → typecheck → lint → format:check → prepack-check → check:openapi`。
- **不要用 `prepare` 钩子做构建**：参考项目 A 的 `_comment` 记录了 npm 11 会把 `prepare` 判为未批准的安装脚本，而构建脚本不随包发布（`files` 白名单），用户一旦批准就必然 ENOENT 失败。用 `prepack`。

**版本兼容与豁免**：
- 启动与安装都会用 `peerDependencies` 对同一 runtime 版本做校验，不匹配则拒绝（`dsh\README.md` L39）。
- 紧急豁免：profile 自己的 `compatibility.json` 里写 `"<pkg>@<version>": ["<dsh-version>", ...]`；**精确版本对精确版本**，插件升级或 DSH 升级都不继承（`app-boot\README.md` L56）。
- CLI：`dsh plugin --profile <p> version-exemptions | allow-version <pkg@ver> --dsh-version <v> --accept-risk | revoke-version ...`。
- 工具：`plugin_manager` 的 `list_version_exemptions` / `set_version_exemption`（授予需 `acceptRisk: true`）。

### 2.14 余额能力：DSH 到底给不给【核实：给，两条路】

> 用户要求"不要把余额查询能力视为 DSH 必然提供的功能"。调查结果是：**DSH 确实内置了一条余额通道，但它的成立有前提**；同时又**必须**有自己查的退路。

**路 A：DSH 原生账号余额（推荐优先尝试）**

- 服务：`ctx.deepseekAccount`（`dsh-deepseek-account\lib\types\index.js` L5-8 `class DeepSeekAccount extends Service { constructor(ctx){ super(ctx,'deepseekAccount') } }`）
- 方法（`dsh-deepseek-account-platform\lib\types\index.js` L161-163、L256-276）：

```js
getBalance(client) { return this.getDetail('balance', this.detailHeaders(client)) }
// client = { version, locale, timezoneOffsetSeconds }（platformClientHeaders，见 types\index.js L43-52）
```

- 返回形状（`dsh-deepseek-account-platform\lib\types\details.js` L12-15、L39-44）：

```js
{ status: 'ready', value: [ { currency: 'CNY'|'USD', balance: '<decimal string>' } ],   // normal_wallets 充值钱包
  bonusWallets: [ { currency, balance } ] }                                            // 赠送钱包
| { status: 'failed' }        // 查询失败不提供金额（绝不变成 0）
| null                        // 未登录
```

- 数据来源与前提：Platform 登录态 grant，请求 `GET /api/v0/users/get_user_summary`，token 走 `x-dsh-auth-token`；**用户必须已登录 DeepSeek 账号**（`dsh-deepseek-account-platform\README.md` L37）。
- 其他相关：`watch(signal)` 异步流（账号变化通知）、`getProfile(client)`、`getUnnotifiedBonuses`。桌面 host **已经在用** `account.watch` → `getPlatformSession`（`dsh-desktop-host\lib\index.js` L187-212）。
- 也有 Remote 侧同名操作（`dsh-api-account-controller\README.md` L23：`getState, getProfile / getBalance, ...`），但那是给 UI 的 RPC。

**路 B：自己拿凭据查官方 API（参考项目 B 的做法，最稳）**

```js
// dsh-deepseek-pet\index.js L86-103（真实代码）
const cred = await ctx.credentials.resolve(cfg.credential)     // 'DEEPSEEK_API_KEY'
const res = await fetch(`${norm(cfg.apiBase)}/user/balance`, {
  headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
  signal: AbortSignal.timeout(15000),
})
const info = data.balance_infos[0]
state.balance = { isAvailable: data.is_available === true, currency: info.currency,
                  total: info.total_balance, granted: info.granted_balance, toppedUp: info.topped_up_balance }
```

- 凭据服务：`ctx.credentials`，`inject: ['tools','credentials']`，`resolve(ref)` 返回 `{ source, value }` 或 `undefined`；文档落盘在 `$DSH_HOME\.credentials.yaml`（version 1，`refs`/`records`），并有继承环境变量优先的层级（`dsh-credentials-local\lib\index.js` L473-508）。
- **已在本机实测可用**：本次调查调用 `pet_balance` 返回 `¥50.30（赠金 ¥0.00 / 充值 ¥50.30）`，`pet_control status` 显示桌宠进程 pid 86280 在跑、状态接口 `http://127.0.0.1:47831/state`。

**设计结论**：**先试 A（无需自己管 Key、与官方 App 余额一致），A 不可用（未登录 / 服务缺失）则回落 B（用 API Key 直查），两者都不可用时显示"余额未知"而不是 0。** 这条降级链要在 Scheme 里实现。

### 2.15 深度思考状态：可行性【核实：可以识别，机制已确认】

**DSH 内部的推理能力**（全部真实代码）：

- LLM 层有独立的内容块类型：`ReasoningBlock = { type: 'reasoning', text: string }`（`dsh-llm\lib\typert.host.js` L449）。
- 流式 chunk 有 `{ type: 'reasoning-delta', index, text }`（同 L505）。
- DeepSeek provider 把它们映射到原生 `thinking` 字段：`thinking: { type: effort === 'off' ? 'disabled' : 'enabled' }, output_config: { effort }`，并把 `delta.thinking_delta` → `reasoning-delta`，`content.type === 'thinking'` → `{ type:'reasoning', text }`（`dsh-llm-deepseek\lib\index.js` L1694-1708、L1834-1885）。
- 模型能力元数据：`LlmModelReasoningInfo { efforts: [{id,name,description?}], defaultEffort? }`，DeepSeek 侧的档位为 `off/low/high/max`（`dsh-llm-deepseek\lib\index.js` L517-522）。
- 用量里有 `reasoningTokens`（`dsh-llm\lib\typert.host.js` L529）。

**插件可观测的入口**：`agent/assistant-stream` 事件（见 §2.10）。因此：

> ✅ **"深度思考模式"可以被可靠识别**，判据是 `frame.type === 'chunk' && frame.chunk.type === 'reasoning-delta'`，配合 `frame.type === 'start' | 'end'` 界定一次推理段的起止。

**但必须诚实标注两点**：
1. **【未确认】** 本阶段**没有做运行时实测**（没有真的起一个插件去抓事件）。因此方案里必须包含一个 "Phase 1 探针" 来实测，并保留降级：若事件拿不到，改用 `agent/status` + 静默时长 + 工具调用事件的粗略推断。
2. 语义边界：`reasoning-delta` 表示"模型正在产出推理文本"，**不等于** UI 上的"深度思考档位"。若需要区分档位，可结合模型/`reasoningEffort` 元数据，但那属于"模型配置"而非"实时状态"，且 `dsh-agent-default-model` 的 `reasoningEffort` 是 `volatile()` 字段（`dsh-agent-default-model\lib\index.js` L24）。

### 2.16 客户端半侧（浏览器插件）机制【核实：存在，但第一版不用】

- 触发条件：包 `package.json` 里声明 `dsh.client`，**且 `dsh.client.platform === 'web'`**（`dsh-client-modules\lib\index.js` L712-717）。
- 必须提供 `exports["./client"]`，否则抛错：`client-modules: <pkg> declares dsh.client but exports no "./client" bundle`（L718-719）。
- 宿主把该 bundle 作为 **`window.__DSH_BOOT__` 模块图**的一部分注入页面，并暴露 `/plugins/<pkg>/client.js`（L103-124、`dsh-deepseek-pet` 的 cordis.patch 注释同款说法）。
- 依赖声明在 `dsh.client.inject`，例如参考项目 A：`["@deepseek-ai/dsh-client-connection"]`，且 peer 里要列出 `@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、`react`、`react-dom`。
- 宿主侧服务：`ctx.clientModules`（注册/通知面）、`webserver/index-inject` 事件（L553）。
- Web renderer 的 JS 入口：`app.asar\dsh\node_modules\@deepseek-ai\dsh-web-frontend\`（本机已提取列表可见）。

> 第一版**不需要**客户端半侧（我们要的是桌面独立窗）。但它是**方案 A 的基础**，也是"桌面进程不可用时"的降级形态。

### 2.17 未确认清单（明确列出，不臆造）

| # | 未确认项 | 如何确认 |
|---|---|---|
| U1 | `agent/assistant-stream` 在真实运行中是否稳定可用、`reasoning-delta` 是否真会出现 | Phase 1 探针插件，实测并落日志 |
| U2 | desktop profile 是否挂载 `dsh-storage` / `dsh-storage-domain`，`ctx.storageDomain` 是否可用 | 运行时 `ctx.get('storageDomain')` 探测 |
| U3 | desktop profile 是否启用 `dsh-hmr`（改 patch 是否热生效） | 改一行 patch 观察是否重组合 / 查 boot 日志 |
| U4 | `ctx.deepseekAccount` 在 desktop 组合下是否始终存在（取决于是否装了 platform provider 且已登录） | 运行时 `ctx.get('deepseekAccount')` 探测 |
| U5 | 直接 `import('electron')` 在 utility process 内的确切行为 | 探针实测（预期失败或得到 node-only 子集） |
| U6 | `webserver` 上挂自定义 HTTP 路由的**稳定公开 API**（参考项目 A 声称挂 `/dsh-pet-7340`） | 读 `dsh-host-webserver` 代码 / 实测；本方案默认**不依赖它** |
| U7 | 插件在 DSH 自身退出时能否收到可靠通知（`stopOnUnload` 类钩子） | 观察 `process.on('disconnect')` 是否对插件可见；默认按"可能收不到"设计 |
| U8 | 多显示器 / DPI 变化下 Electron 透明窗的坐标语义 | Phase 4 实测 |

---

## 3. 交付物 B：参考桌宠插件的实现分析

### 3.1 项目 A：`PC2005-cloud/dsh-pet`（用户指定）

**身份**：npm `dsh-pet@0.3.6`，MIT（代码），1278 stars，语言 TypeScript，声明在 `dsh 0.2.0-rc.2` 下开发测试。

**准确定位**：它不是"一个插件"，而是**三件套项目**：

```
① 提示词（配方：绿幕规范 + 按秒分解）→ ② 素材生成链（Python/ffmpeg：水印→抠像→归一化→转码）→ ③ 插件（成品）
```

**包清单关键字段**（`dsh-pet/package.json`，已核实原文）：

```jsonc
"main": "lib/index.js",                    // 宿主半侧入口
"icon": "assets/logo.png",
"bin": { "dsh-pet-standalone": "lib/standalone.js" },   // 不打开 DSH 也能跑
"exports": {
  ".":          { "default": "./lib/index.js" },
  "./client":   { "default": "./lib/client.js" },       // 浏览器半侧
  "./cordis.patch.yml": "./cordis.patch.yml"
},
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "compatibility": { "dshReleases": { "0.1.7-rc.2": "incompatible",
                                      "0.2.0-rc.1": "compatible",
                                      "0.2.0-rc.2": "compatible" } },
  "client": { "inject": ["@deepseek-ai/dsh-client-connection"], "platform": "web" }
},
"peerDependencies": {
  "@deepseek-ai/cordis": "^4.0.4",
  "@deepseek-ai/dsh-agent-default-model": "^0.2.0-rc.1",
  "@deepseek-ai/dsh-client-connection": "^0.2.0-rc.1",
  "@deepseek-ai/dsh-client-ui-primitives": "^0.2.0-rc.1",
  "@deepseek-ai/dsh-client-ui-slots": "^0.2.0-rc.1",
  "@deepseek-ai/dsh-commands": "^0.2.0-rc.1",
  "@deepseek-ai/dsh-credentials": "^0.2.0-rc.1",
  "@deepseek-ai/dsh-home-paths": "^0.2.0-rc.1",
  "@deepseek-ai/dsh-host-webserver": "^0.2.0-rc.1",
  "@deepseek-ai/dsh-llm": "^0.2.0-rc.1",
  "react": "^18.2.0", "react-dom": "^18.2.0"
}
```

**架构：双形态 + 纯逻辑共享**

| 形态 | 实现 | 说明 |
|---|---|---|
| 浏览器 overlay（默认） | `dsh.client` → `lib/client.js`，React 渲染在 DSH Web 页面里 | 走宿主 HTTP 路由 |
| 桌面模式（可选） | 独立 Electron 透明置顶小窗，`runtime/electron-helper/` | **每只宠物一个局部小窗**（跟随移动，不铺满屏）；数据走**独立进程管道**，不依赖 DSH 的 HTTP 路由 |
| 独立模式 | `lib/standalone.js`，把宿主半侧跑在**伪 ctx** 上，由本机 HTTP 服务接管路由 | 完全不打开 DSH |

**关键设计点（对我们极有参考价值）**：

1. **纯逻辑双端共享**：`src/shared/physics.ts` 等纯函数被浏览器端与桌面端同时引用——"严格同行为"是靠共享纯逻辑实现的，而不是靠网络同步。**这是本方案要直接借鉴的第一条。**
2. **动画链（chain）而非状态机**：每个动画（含待机）播完即**按权重**选下一个（`config.jsonc` 里 `animationWeights: { idle: 10, turn: 5, move: 5 }`）。
3. **档位支持候选数组**：任意档位可写 `string | string[]`——数组 = 档内随机抽 1 + 循环自动轮换，避免连播同一段。**这正是"避免动画冲突/重复"的一种轻量解法。**
4. **六档工作状态**：`animations.events.workStatus` 数组，索引即档位（思考/工作/整理/等待/成功/出错），**并明确要求"勿在中间插入新档，只可追加末尾"**（因为索引即语义）。多轮任务只在**真正收尾轮**庆祝成功。
5. **呼吸 + 双缓冲交叉淡入**：切换无空白帧；脚底线统一；所有动画可镜像。
6. **物理感交互**：拖拽用阻尼弹簧跟手、甩出抛物线 + 屏幕边缘反弹 + 落地摩擦停稳 + Q 弹挤压；多屏按各屏工作区为界。**两端同一套纯函数物理与挤压曲线。**
7. **余额分档**：DeepSeek 官方按"¥20 满额折算已用百分比"分 **6 档**（钱袋满溢→金袋叮当→钱袋如常→数金皱眉→袋空如洗→分文不剩），头顶泡泡 10 秒消失。**未登记余额接口的服务商改为弹文字说明，不静默。**
8. **配置分层**：包内默认 `assets/config.jsonc` < 用户层 `$DSH_HOME/dsh-pet/main-config.jsonc`；语义是**字段级整体替换**（写了 `animations` 就用整份，没写的回落默认）；**校验在插件加载时执行，格式错误显式报错，不静默跑残缺配置**。
9. **pet pack 扩展点**：`$DSH_HOME/dsh-pet/pet/<种类>-config.json` + `<种类>-animation/`，扫描自动发现；**种类之间严格隔离、绝不回落全局素材**；非法即显式报错并跳过，不影响其他宠物。
10. **对外 HTTP API**：挂在 DSH Web 服务上，前缀 `/dsh-pet-7340`，**只监听本机、无鉴权**；动作类只回 `{ok}`，数据统一从 `GET /state` 读。文档三件套：`API.md` / `openapi.yaml`（OpenAPI 3.1）/ `tools/api-tester.html`。
11. **通知**：窗口失焦时弹系统 toast（对话完成 / 生成失败 / 输出截断 / 权限申请 / 用户选择）。
12. **AI 生成台词**：碎碎念与对话可**各自指定模型**，与 DSH 对话框模型选择器同源；调用失败自动回落到当前对话模型重试一次；对话记忆持久化 `$DSH_HOME/dsh-pet/memory.json`。
13. **无障碍**：支持 `prefers-reduced-motion`（减少动效时跳过 Q 弹挤压与淡入切换）。
14. **素材链工程化**：`step01~04` 中间产物不入库，只发布**唯一格式 VP9-alpha webm**（640×360）；Safari 不认 webm alpha → 单独走 GitHub Release 发布 HEVC-with-Alpha `.mov`，并把集中常量 `ANIMATION_EXT` 从 `.webm` 改为 `.mov`。
15. **Electron 自动探测/下载**：首次启动探测或下载 Electron 到 `~/.dsh/electron/`（`@electron/get` + `@electron-internal/extract-zip`），缺失时仅日志告警、不影响浏览器形态；Linux 无 `DISPLAY`/`WAYLAND_DISPLAY` 时判定无显示并跳过桌面窗口。
16. **`dsh://open` 协议**：宠物宿主是 DSH 桌面应用时，右键"打开网站"自动变成"打开 DeepSeek Harness"（已运行则前置，未运行则拉起）。

**优点**：功能与工程化程度都远超一般插件；纯逻辑共享 + 双形态是最优解；素材链可复现；配置/扩展点设计成熟；无障碍与多屏都考虑到了。

**缺点 / 风险**：
- **复杂度高**：294 个文件、`unpackedSize` 65.4 MB、一次性下载 Electron；npm 包体积大。
- 依赖 `@electron/get` 联网下载 → 首次体验受网络影响，且有供应链面。
- 桌面窗口"每宠物一窗"在多开时窗口数量线性增长；`%APPDATA%\dsh-pet-electron-helper` 缓存与独立模式会**互相踩缓存**（项目自己承认，仅告警）。
- 浏览器形态**不支持 Safari**（webm alpha），需用户手动换 mov 素材 + 改常量 → 对普通用户不友好。
- `dsh.client` 依赖 React 18，与 DSH 前端版本演进强耦合（peer 范围 `^0.2.0-rc.1`）。
- 素材是**大体积视频**，包体与内存占用都高。

**许可（重要，逐条照抄）**：
- 代码：**MIT**
- 素材（动画/提示词/源视频）：**允许开源使用，禁止商用**
- 二次创作约定：衍生/改版/换皮作品，**在任何介绍、展示、分发该作品的地方**须附原作者地址 `https://github.com/PC2005-cloud/dsh-pet`

> ⚠️ 因此：**可以借鉴其架构与工程做法（MIT），但不得复用其动画素材（禁商用 + 二创署名要求）。** 我们的 DeepSeek 娘形象与动画必须自行产出或取得明确授权。

### 3.2 项目 B：`Yoshino-JF/dsh-deepseek-pet@0.2.14`（本机已装，即 `pet_*` 工具来源）

**身份**：npm `@deepseekstudio/dsh-deepseek-pet`，MIT（代码），`LICENSE-ART.md` 另管美术。
仓库里**没有任何 `PC2005` 字样**（全树 grep 零命中）→ 与本报告 §3.1 的项目 A 是两个独立项目。

> 本节及以下结论来自逐行核对，完整版（每条含引文与行号）见 `_research\dsh-deepseek-pet-0.2.14-analysis.md`。
> ⚠️ **技术栈修正**：宠物不是 WinForms，而是 **WPF / .NET Framework 4.x**。

**架构：插件桥 + C# WPF 原生宠物**

```
DSH utility process                         独立原生进程
┌──────────────────────────────┐           ┌────────────────────────────┐
│ index.js (438 行, ESM)       │  HTTP     │ pet/DeepSeekPet.exe        │
│  · ctx.tools.register × 2    │ 回环      │  pet-src/src/Pet.cs (240KB)│
│  · ctx.on('agent/status')    │ 127.0.0.1 │  McHud.cs / McScreen.cs    │
│  · ctx.on('agent/inbox/...') │ :47831    │  McSide.cs / McVn.cs       │
│  · http.createServer 长轮询   │ ◄──────── │  assets/*.png (每张 ~1MB)   │
│  · ctx.credentials.resolve   │ /state    │                            │
│  · spawn(exe, detached)      │ ?pid&wait │                            │
└──────────────────────────────┘           └────────────────────────────┘
```

**职责边界（作者在文件头写死，L4-9）**：
- **余额与凭据只留在宿主端**——桌宠进程**永远拿不到 API Key**，只拿到余额数字。
- 桌宠是独立原生窗口程序，每分钟来 `/state` 取一次状态；插件只监听回环地址、不对外暴露、**不注册到 Web UI 路由表**。
- 宿主卸载/重启**不影响**已起来的桌宠（detached 进程）。

**回环协议（完整，可直接作为我们协议的起点）**：

| 端点 | 方法 | 语义 | 位置 |
|---|---|---|---|
| `/health` | GET | `{ ok, plugin, version }` | L166-169 |
| `/state?pid=<n>&wait=<sec>` | GET | 主状态；带 `pid` 用于判活；`wait>0` 时**长轮询**挂起直到有事件或超时（≤60s） | L170-192 |
| `/dev/event?kind=` | GET | **开发验收用**：手工触发宿主事件 | L193-201 |
| `/say?text=` | GET | 让桌宠说一句 | L202-208 |
| `/refresh` | GET | 强制刷新余额并通知 | L209-213 |

`/state` 返回体（L118-139）：

```js
{ ok, plugin:'dsh-pet', version, updatedAt, stale,
  balance: { isAvailable, currency, total, granted, toppedUp } | null,
  lowBalance, message, command, event, busy, activityLabel, error }
```

**判活机制（值得直接借鉴的巧思）**：桌宠每次取状态都**自报 pid**；`ALIVE_WINDOW_MS = 30_000`，超过 30 秒没取状态就认为它关了。`petRunning()` = 自己 spawn 的进程还活着 **或** 最近在轮询；`livePid()` 兼容"不是自己起的"情况（L249-262）。作者还专门注释了一个真实 bug：`petRunning()` 为真但 `pet.proc` 为 null 时直接读 `pet.proc.pid` 会 TypeError（L264-267）。

**"用户主动发起"的判定**（L224-244，很聪明）：

```js
let userMsgAt = 0
ctx.on('agent/inbox/inserted', (p) => { if (!p?.message?.role || p.message.role === 'user') userMsgAt = Date.now() })
ctx.on('agent/status', (p) => {
  const running = !!p && p.status === 'running'
  const byUser = running && Date.now() - userMsgAt < 10_000      // 10 秒窗口
  if (byUser && !state.busy) { state.busy = true; notify('work-start') }
  else if (!running && state.busy) { state.busy = false; notify('work-end') }
})
```

即：**只有"用户消息进 inbox 后 10 秒内 agent 变 running"才算用户主动发起**；自动续跑 / 子代理 / 定时任务没有这条用户消息，所以不会误触发。

**工具**：`pet_balance`（余额，60s 缓存 + `fresh` 强刷）、`pet_control`（`start/stop/status/refresh/say/hide/show`）。本次调查已实测两者均可用。

**配置**：`port / petPath / credential / apiBase / refreshSeconds / lowBalance / autoStart / startDelayMs / stopOnUnload`；`petPath` 默认包内 exe，可用环境变量 `DSH_PET_EXE` 覆盖。

**优点**：
- **职责边界最干净**：凭据不出宿主端；桌宠是"哑终端"，只画不查 → 供应链/泄露面最小。已核实 Key 只在 `index.js` L86-90 出现，从不进入 payload。
- 回环 + 长轮询：**反应 <100ms**，实现简单，不依赖 DSH 内部 API（除 tools/credentials/events 三个）。
- 判活、软退出（`quitRequested` → 桌宠自己关）、"非自己启动的也能 stop"都考虑到了。
- **反推修正（值得学）**："用户主动发起"判定的 10 秒窗口（L224-244）与 `ctx.effect` 全覆盖清理（L222/414/431/433）做得比我们初稿设想更细致。
- C# 侧能力完整（透明置顶窗、伪 Minecraft HUD、横版小游戏、视觉小说模式），且**全部游戏 UI 都是代码生成的像素画**（省体积、规避素材授权）。

**缺点 / 风险（逐条已核实，括号内为文件与行号）**：
- **技术栈不可复用**：纯 **WPF / .NET Framework 4.x**（`Pet.cs:1-25`、`Pet.cs:917-927`），**全文件零 P/Invoke**（无 `WS_EX_LAYERED/TRANSPARENT`、无 `UpdateLayeredWindow`）→ 透明与点击穿透完全交给 WPF 默认行为，Win32 层面语义**未证实**。
- **没有构建脚本**：包内无 `csproj/sln/cmd/bat`；`build.cmd` 被 `Pet.cs:4`、用户可见报错文案（`index.js:404`、`:437`）引用，**却没随包发布**。CI 也从不编译 C#，exe 是开发机产物、**无版本资源、未签名、32 位**。
- **`Pet.cs` 单文件 4031 行 / 240 KB**，`McHud` 与 `McScreen` 之间重复实现了 `Fill/Put/Sprite/Lerp/Blend`。
- **15.54 MB 字节级完全重复的素材树**：`pet\assets\assets\**` 是 `pet\assets\**` 的逐文件副本（SHA-256 全同），**从不被读取**（`ResolveAssetsDir` 只探 `exeDir\assets` 等三处，`Pet.cs:897-912`），但**明知故犯地发布了**（`DEVLOG.md:270 ⑤`，且其自报的 4.8 MB 是错的）。整个插件目录 60.28 MB，tgz 31.3 MB。
- **~1 MB 近未压缩 PNG**（720×1090，1.5 B/px），全尺寸解码；空闲工作集 133–136 MB，而开发者自定目标是 <80 MB（`DEVLOG.md:339`、`:170`）。
- **`Save()` 静默丢设置**：`Save()`（`Pet.cs:121-140`）从不写 `game` / `gameFixed` / `bubbles` / `gameIdleSeconds`，而 `Load()`（`:105-108`）会读它们 → 重启后 `gameFixed` 与气泡开关丢失。
- **`payload()` 有副作用**：`index.js:121-122` 在读 payload 时把 `quitRequested` 清成 false，而两个工具都调 `payload(false)`（`:325/:367/:386`）→ **一次 `pet_balance`/`status` 就能取消掉刚发出的软退出指令**。
- **桌宠忽略 `ok` / `stale` / `error`**：只要回环 GET 成功就置 `s.ok = true`（`Pet.cs:3710`）→ **API 失败时仍显示绿色徽章 + "余额 --"**，而不是离线态（`:3793`）。
- **端口冲突只记日志**（`index.js:216-221`）：`try/catch` 抓不到异步 `EADDRINUSE`，无备用端口，且 `pet_control status` 仍报"接口健康"。
- **无鉴权的有副作用 GET**：`/say`、`/refresh`、甚至**随包发布的 `/dev/event`** 都没有 token / Origin 检查 / CORS 头，本机任意进程（乃至浏览器地址栏 GET）都能触发。
- **单槽位长轮询事件**：只有一个 `pendingEvent`（`index.js:64`），**第二个事件会覆盖尚未被取走的第一个**；且只有一个挂起的客户端能拿到事件。
- **消息通道不能重复同一句**：`state.message` 从不清空（`:132`），桌宠按字符串去重（`Pet.cs:3851`）→ 同一句话无法连说两次，且桌宠重启后会重播旧消息。
- **游戏速度随 FPS 预设漂移**：`AnimStep` 硬编码 0.016（`Pet.cs:1112`）而定时器间隔随预设变化（`:1888`）→ "30 帧"下游戏世界约半速、"120 帧"下约 2 倍速，与代码注释和 DEVLOG 的说法矛盾。
- **`petPath` 用 `new URL(...).pathname`**（`index.js:27`）而**不经过 `fileURLToPath`** → 安装路径含空格（`%20`）或非 ASCII 时 `existsSync`/`spawn` 失败，只表现为"找不到桌宠程序"。
- **`pet.log` 无上限、无轮转**（`Pet.cs:160`）。
- **peer 依赖无界**：`{"@deepseek-ai/dsh-tools":"*"}`（`package.json:11`），且宿主契约有 5 处无保护假设（`defineTool` 选项形状、`credentials.resolve` 返回形状、服务名、两个事件 payload、`ctx.effect` 语义）。
- **文档系统性漂移**：`README.md:39` 说打包的是 pet 0.2.12（实际 0.2.14）；`DEVLOG.md:3` 说 v0.2.2；`README.md:11` 说 5 秒轮询（实际 25 秒长轮询）；`INSTALL.md:66` 漏列写的文件；`INSTALL.md:3,:51` 声称支持鼠标穿透而 `pet-src\README.md:270` 把它列为**未完成**。
- **度量与错误码细节**：`pet_control` 的 `seconds` 参数**从未被读取**（死参数）；`activityLabel` 被 C# 解析进结构体后**从未使用**（死字段）。

### 3.2.1 我们从 B 的缺陷清单直接得出的设计红线

| B 的缺陷 | 我们的硬性要求 |
|---|---|
| 静默丢设置 | `Save()` 与 `Load()` 必须由**同一个字段清单**生成（单一 schema），并加 round-trip 单测 |
| `payload()` 副作用取消退出 | **读状态必须是纯函数**；命令队列与状态快照分离 |
| 忽略 `ok/stale/error` | 协议里 `health` 与 `data` 分离；桌宠必须展示"离线/数据过期"态 |
| 端口冲突只记日志 | 端口占用 → **自动顺延 + 写回状态 + 上报工具** |
| 无鉴权 + 有副作用 GET | 有副作用端点用 **POST + 每会话随机 token**；`/dev/*` 端点仅在开发构建中存在 |
| 单槽位事件覆盖 | 事件队列（有界，如 32 条）而非单槽位；允许一个事件被多个消费者读取 |
| 消息不能重复 / 重播旧消息 | 消息带 `seq`/`id`，桌宠按 id 去重而非按文本；每条消息带 `expiresAt` |
| 重复素材树 / ~1 MB PNG | `prepack-check` 加**重复文件哈希检测**与体积预算门禁 |
| `pathname` 未解码 | 一律用 `fileURLToPath()` |
| 日志无轮转 | 桌宠日志按大小轮转（如 2 MB × 3） |
| 构建脚本未随包发布 | 用户侧**不需要任何构建步骤**（第一阶段仅 Windows 时提供预编译产物，并写清校验方式） |

**许可（逐条核实，原文引用于 `_research\dsh-deepseek-pet-0.2.14-analysis.md` §6）**：
- `LICENSE`：**MIT**，`Copyright (c) 2026 DeepSeek Pet contributors` → **代码可复用**（保留版权声明即可）。
- `LICENSE-ART.md`（11 行）明确：
  - `pet/assets/` 下的**立绘与像素画素材不适用 MIT 许可证**；
  - **允许**：在**非商业**场景下使用、修改、再分发（须保留说明与作者署名）；
  - **需要额外许可**：任何**商业用途**（含付费分发、以素材为核心的付费产品）；
  - **不建议**：把素材用于训练其他生成模型；
  - 代码部分（`src/`、`tools/`、插件 `index.js` 等）适用仓库根的 MIT。
- 结论：**B 的角色美术不可自由商用**；我们的 DeepSeek 娘形象必须自产或取得明确授权（与 §3.1 的 A 同一结论）。
- **【未确认】**：生成式工具的条款是否允许 B 这样再分发其产物；`LICENSE-ART.md` 未署具体人名/年份，是否与 `package.json` 的 `author: Yoshino-JF` 同一权利人亦未证实。

### 3.2.2 B 的窗口方案技术细节（对 D1 载体决策的直接影响）

| 项 | B 的做法 | 对我们的启示 |
|---|---|---|
| 框架 | **WPF**（`PetWindow : Window`），.NET Framework 4.x，用 `csc` 手工编译 | 若走 .NET 路线，WPF 是**已验证可透明置顶**的最小方案；且**不需要 NuGet**（仅 WPF 程序集） |
| 透明 | `WindowStyle=None` + `AllowsTransparency=!OpaqueMode` + `Background=Transparent` + `Topmost` + `ShowInTaskbar=false` + `ShowActivated=false` + `ResizeMode=NoResize`（`Pet.cs:917-927`） | **关键结论**：在这个组合下 WPF 能做到真透明**且不需要任何 P/Invoke** → 我们不必一开始就上 `WS_EX_LAYERED`/`UpdateLayeredWindow` |
| 命中区 | **无显式命中区**；靠每个装饰元素 `IsHitTestVisible=false`（16 处） | 我们的"点击/摸头/戳脸"需要**显式区域图**，不能照抄这种"全窗可点"的粗粒度 |
| 渲染时钟 | `CompositionTarget.Rendering`（待机）+ `DispatcherTimer`（游戏屏）+ 1.2 s 轮询 | 待机动画用渲染帧回调是对的；但**必须把"时间步长"与"定时器间隔"解耦**（B 在这里有真实 bug） |
| 动画素材 | 整幅 720×1090 PNG 姿态图 + 交叉淡入/穿透淡入；**无精灵表、无 GIF** | 单姿态图 + 淡入最简单，但**体积不可接受**（~1 MB/张）→ 我们用 webm/序列帧 + 体积预算 |
| 姿态元数据 | `poses\handheld.json` 存锚点（`deviceTop/deviceBottom/deviceWidth/deviceCenterX/measuredFrom`） | **姿态锚点文件**这个思路值得抄：气泡定位、手持物对齐都需要 |
| 无水平翻转 | 全项目**没有 ScaleX=-1**；朝向只存在于像素画内部 | 我们要"左右朝向"就必须自己实现镜像（A 就是全动画可镜像） |
| DPI / 多屏 | 仅 system-DPI aware（`app.manifest:7`）；只用 `SystemParameters.WorkArea`，**不查 `Screen.AllScreens`** | 多屏是真需求（A 做得很好）→ 我们不能照抄 B，要按工作区枚举屏幕 |
| 窗口拖拽 | `win.DragMove()` + 松手时重新钉住位置 | 简单可靠；但"甩抛"要自己写物理（B 没有甩抛，A 有） |

> **对 D1 的建议据此收敛**：第一阶段可用 **Electron**（因为 A 已证明、且与 DSH 自身同源、跨平台），**但**记录一条备选：**WPF 单文件 exe 也已被证明可透明置顶且零 P/Invoke**，在"不想让用户下载 Electron"时可作为 Windows-only 的轻量载体。最终取舍放入 D1。

> **作为"全新独立项目"的定位**：本项目**不**复用 A 或 B 的动画素材，**不**把 B 当作依赖，只借鉴两者的**架构模式**（A 的纯逻辑共享/动画链/档位候选数组/配置分层；B 的凭据隔离/回环长轮询/判活/用户主动发起判定）；并**主动规避 B 的 21 项已核实缺陷**（见 §3.2.1 红线表）。

---

## 4. 交付物 C：其他可参考插件清单与比较

### 4.1 桌面 / 宠物相关（**【社区】**来源，未读其源码，仅作线索）

| 插件 | 定位 | 与我们的关系 |
|---|---|---|
| `deepseek-harness-desktop`（anywhere-labs，MIT，★19k） | 为 DSH 打造的现代化桌面端体验 | 可参考"桌面载体"路线 |
| `DeepSeek-Balance-Whale-Widget`（MeteorNOX，★4.5k） | **住在 DSH 界面右下角**的鲸鱼娘，盯余额；拖拽吸附、左吸附翻转、数字滚动动画 | **与我们的余额+鲸鱼娘定位最接近**；是浏览器 overlay 形态 |
| `petdex`（crafter-station，MIT，★4.2k） | 为 Codex / Claude Code 提供**动画宠物公共画廊** | **素材与格式的参考来源**（可关注其动画资产规范） |
| `dsh-deep-whale`（Small-tailqwq，★2.5k） | DSH Web **鲸鱼娘皮肤系列**（深海女仆工坊） | 形象风格参考 |
| `dsh-TUI` / `dsh-cc-tui`（MIT，★4.3k / 1.6k） | Claude Code 风格 TUI，**"思考流式展开"**、实时工作状态行、TPS 仪表 | **证明"推理流可视化"在生态里已有人做**，可参考其状态切分 |
| `DSH-better-sidebar`（MIT，★4.1k） | 侧边栏工作台（文件/终端/Git/子代理），**支持三方注册新 Tab** | 客户端插件扩展点参考 |
| `dsh-web-ui`（Apache-2.0，★5.8k） | 任务板、Git 面板等 UI 合集 | 客户端 UI 参考 |
| `modlens`（MIT，★4.2k） | 视觉插件，粘贴图片返回结构化 JSON 证据 | 与本项目无关，仅说明生态广度 |
| `dsh-context`（Apache-2.0，★2k） | 上下文窗口构成洞察面板 | 数据可视化参考 |
| `dsh-pocket`（GPL-2.0，★1.7k） | 手机扫码同屏访问 | 与本项目无关 |

### 4.2 基础设施类（**这些是"真依赖"，可直接用**）

| 包 | 用途 | 我们的用法 |
|---|---|---|
| `@deepseek-ai/dsh-tools` | `defineTool` / 工具注册表 / 执行管线 | 注册 `pet_*` 工具 |
| `@deepseek-ai/dsh-credentials` | `ctx.credentials.resolve(ref)` | 取 `DEEPSEEK_API_KEY` |
| `@deepseek-ai/dsh-deepseek-account` | `ctx.deepseekAccount.getBalance(client)` | 首选余额来源（路 A） |
| `@deepseek-ai/dsh-agent-default-model` | 取当前对话模型（`reasoningEffort` 为 volatile） | 台词生成用"跟随当前对话" |
| `@deepseek-ai/dsh-llm` | LLM 调用 seam | 台词/对话（如需要） |
| `@deepseek-ai/dsh-commands` | 注册斜杠命令 | `/pet` 类命令 |
| `@deepseek-ai/dsh-home-paths` | `resolveDshHome()` / `dshHomePath()` | 定位 `$DSH_HOME/<id>/` |
| `@deepseek-ai/dsh-settings` | 设置页存储 | 设置项（`dsh-pet` 用它 + client ui-settings） |
| `@deepseek-ai/dsh-storage` + `-json` + `-domain` | 类型化持久化 | **可选**，见 §2.9 U2 |
| `@deepseek-ai/cordis` | `Service` / `ctx.effect` / `ctx.on` | 生命周期 |
| `@deepseek-ai/schemastery` | `Config` schema（`Schema.object`） | 配置校验 |

### 4.3 市场与发现（生态入口）

| 名称 | 地址 | 说明 |
|---|---|---|
| dshmarket | `https://dshmarket.com`，npm `dshmarket`（MIT，本机 v1.66.11） | 应用内可视化插件市场 |
| awesome-dsh-plugin | `https://awesome-dsh-plugin.com/plugins.json` | dshmarket 的 registry 快照源（见其 `package.json` 的 `snapshot` 脚本） |
| dshbase 目录 | `https://dshbase.com/zh/plugins/directory/` | 【社区】7819 个插件索引 + 兼容性验证记录；本机 `.dsh-market\discovery-compatibility-v1.json` 是同类缓存 |
| dsh-plugin-dev-kb | `github.com/Pasumao/dsh-plugin-dev-kb` | 【社区】插件开发知识库（官方文档镜像） |
| dsh-plugin-developer-skill | `github.com/liangdabiao/dsh-plugin-developer-skill` | 【社区】"从 0 到 1 开发插件"的 skill，含一个整包参考案例 |

**dshmarket 的兼容性判定口径**（`dshmarket\lib\discovery-compatibility.js` L36-58）：它只读 **`engines.dsh` / `dsh.engines.dsh`** 与 **`peerDependencies` 里的 `@deepseek-ai/*`**，与内核口径一致。本机缓存形如：

```json
{"schema":"dsh-market/discovery-compatibility-cache/v1",
 "entries":{"dsh-knj-workflow":{"checkedAt":...,"facts":{"version":"2026.9.192","enginesDsh":null,
   "peerDependencies":{"@deepseek-ai/cordis":"^4.0.1",
     "@deepseek-ai/dsh-agent":">=0.1.1-rc.2 <0.1.2-0 || >=0.1.2-rc.1 <0.1.3-0", ...}}}}}
```

### 4.4 生态的"插件清单"最佳实践（提炼，供我们照抄）

1. `dsh.bundle.patch` 指向 `cordis.patch.yml`，patch 里 `insert` 一行。
2. `id` **与包名一致**、全局唯一。
3. `peerDependencies` 用 `^<当前主线 rc>` 精确锁 DSH 运行时包（生态里 `^0.2.0-rc.1` 是当前主流写法）。
4. 顶层 `icon` 相对路径，≤256 KiB。
5. 有浏览器半侧才写 `dsh.client`，且必须导出 `./client`。
6. 用 `files` 白名单收敛发布内容；用 `prepack`（不用 `prepare`）做构建。
7. 装完需**重开桌面应用**（运行中的进程持有旧插件；除非 HMR 生效）。

---

## 5. 交付物 D + E：推荐架构 与 插件/独立进程取舍

### 5.1 方案比较

#### 方案 A：在 DSH 插件运行环境内实现桌宠界面

具体形态：用 `dsh.client` 注入浏览器半侧，在 DSH **Web 页面**里渲染桌宠（DOM/CSS/Canvas/WebM overlay）。

| 维度 | 评价 | 依据 |
|---|---|---|
| 可行性 | **高**，生态主流（参考项目 A 的默认形态、`DeepSeek-Balance-Whale-Widget`、`dsh-deep-whale`） | `dsh-client-modules` L61-75、L714 |
| 实现难度 | **低**（无跨进程、无窗口管理、无 Electron 下载） | — |
| 安全性 | 中（渲染在页面内，与 DSH Web 共享进程；但插件宿主侧仍有全权限） | §2.12 |
| 动画性能 | **中**（受页面占用影响；WebM alpha 可硬件解码，但动画多时与页面抢帧） | — |
| 生命周期 | 简单（随 fiber / 页面） | `ctx.effect` |
| 安装更新 | 简单（刷新页面即可；HMR 生效时免刷新） | — |
| DSH 升级兼容 | **弱**：强依赖 `dsh.client` 注入契约、`dsh-client-ui-*` 与 React 版本 | peer 范围 |
| **是否适合本项目** | ❌ **不满足"桌面透明窗口"** | 用户目标 §二.1 |

**结论：A 作为"降级形态"保留，不作为第一版主形态。** 但 A 的**纯逻辑层必须可被复用**（见 5.3 的共享核心）。

#### 方案 B：插件负责事件与数据桥接，桌宠界面跑在独立桌面进程中

具体形态：Host 插件 = 数据 + 事件 + 工具 + 回环接口；独立进程 = Electron 透明窗口 + 动画引擎。

| 维度 | 评价 | 依据 |
|---|---|---|
| 可行性 | **高，且是该架构下的唯一路线**（插件拿不到 `BrowserWindow`） | §2.11 `dsh-desktop-host\lib\index.js` L248-344 |
| 实现难度 | **中高**（跨进程协议、窗口管理、Electron 获取、进程生命周期、判活） | 参考项目 A 为此写了独立 runtime 与 ensure-electron |
| 安全性 | **最好**：凭据只留宿主端，桌宠进程拿不到 Key（参考项目 B 的职责边界） | `dsh-deepseek-pet\index.js` L4-9 |
| 动画性能 | **最好**（独立进程独立渲染，不受页面影响；可 60fps + 硬件加速） | — |
| 生命周期 | **中**：桌宠可以 detached 常驻（宿主重启不影响），但必须自己做判活与清理 | L249-262 |
| 安装更新 | 中高（要下载/携带 Electron，或使用其它原生载体） | `@electron/get` |
| DSH 升级兼容 | **最好**：只依赖 `tools` / `credentials` / `agent/*` 事件三个稳定面，不碰客户端契约 | 参考项目 B 的 peer 极少 |
| **是否适合本项目** | ✅ **推荐** | 满足"桌面透明窗口"、"第一版只支持桌面端" |

### 5.2 推荐：方案 B 的改良版

```
┌──────────────────────── DSH (Electron utility process) ────────────────────────┐
│  dsh-pet-ds (本插件 Host 半侧, Cordis 插件)                                      │
│   ├─ DSH Adapter      监听 agent/status, agent/inbox/inserted, agent/assistant-stream │
│   ├─ Balance Provider  A: ctx.deepseekAccount.getBalance()  →  B: credentials.fetch   │
│   ├─ Mood System      心情值（持久化）→ 影响动作/台词                              │
│   ├─ Behavior Engine  统一决策器（优先级 + 抢占 + 冷却，消除动画冲突）              │
│   ├─ Bridge Server    http://127.0.0.1:<port>/  (仅回环, 长轮询)                  │
│   ├─ Asset/Settings/Lines 读取 + 校验 + 分层覆盖                                   │
│   ├─ Tools            pet_status / pet_balance / pet_control                      │
│   └─ Supervisor       spawn / 判活 / 软退出 / 崩溃重启                             │
└────────────────────────────────────┬───────────────────────────────────────────┘
                                     │ 回环 HTTP（长轮询 + 命令 + 事件）
                                     │ 桌宠自报 pid；插件侧判定存活
┌────────────────────────────────────▼───────────────────────────────────────────┐
│  dsh-pet-ds-pet  (独立 Electron 进程, 透明置顶窗; 第一版 Windows)               │
│   ├─ Window Manager   无边框 + 透明 + 置顶 + 拖拽 + 点击穿透(区域化)              │
│   ├─ Animation Engine 帧/视频播放, 双缓冲交叉淡入, 镜像, 脚底线统一                │
│   ├─ Character State  当前动作、朝向、位置、气泡                                   │
│   ├─ Interaction      点击 / 摸头 / 戳脸 / 拖拽 / 甩抛 / 右键菜单                  │
│   ├─ Renderer         统一渲染层（第一版与离线预览共用）                          │
│   └─ Shared Core      ★ 与 Host 共享的纯逻辑（决策规则/心情公式/时长表）          │
└────────────────────────────────────────────────────────────────────────────────┘
```

**相对参考项目的三处改良**：

1. **单一权威决策器（解决"第 9 条：统一的行为决策器"）**
   - A 用"加权链 + 档位候选数组"，B 用"事件直接通知 → 桌宠自己演"。两者在**多事件同时到达**时都没有显式仲裁。
   - 我们的做法：**所有输入先变成 `Intent { kind, priority, ttlMs, interruptible, cooldownKey, payload }`**，由 Host 侧（或 Pet 侧的同一份纯逻辑）**单点仲裁**：
     - 高优先级可抢占低优先级（`interruptible` 为真时）
     - 同优先级按"最早未被满足" + 权重
     - `cooldownKey` 抑制重复（台词/动画都不连播同一段）
     - **仲裁结果是唯一的 `activeAction`**，动画引擎只演这一个 → **从结构上不可能冲突**
   - 这套纯逻辑放进 **Shared Core**，两端可单测、可离线回放。

2. **不携带 Electron，改用"宿主已有 Electron"或"自带轻量原生载体"**（见 5.4 决策点 D1）

3. **素材规格前置约束**：从第一天就定"单一发布格式 + 目标尺寸 + 体积预算"，避免重蹈 A（65 MB 包）与 B（23 张 1 MB PNG + 重复素材树）的覆辙。

### 5.3 关键架构决策（需在 Phase 0/1 定稿）

| # | 决策点 | 选项 | 建议 |
|---|---|---|---|
| D1 | 桌宠进程载体 | (a) `@electron/get` 下载 Electron（A 做法） (b) **WPF 单文件 exe**（B 做法，零 P/Invoke 已证明可透明置顶） (c) Node + 原生 FFI（`koffi` 本机已有）自绘分层窗口 (d) 复用 DSH 自己的 `DeepSeek Harness.exe` 起第二实例 | **(a) 起步**（跨平台、与 A 同源已验证、开发快）；**Windows 体积敏感时切 (b)**（见 §3.2.2）；(c) 工程量最大；(d) 需实测且有风险 |
| D2 | 通信协议 | (a) 回环 HTTP + 长轮询（B 做法） (b) WebSocket (c) stdio 管道（A 的桌面模式做法） | **(a)**：实现最简单、与 DSH 的 HTTP 文化一致、易调试（curl 就能测）、无鉴权风险（只绑 127.0.0.1） |
| D3 | 权威决策位置 | (a) Host 侧 (b) Pet 侧 (c) 共享纯逻辑两端可跑 | **(c)**，**权威 = Host**，Pet 只做渲染与本地即时反馈（点击 Q 弹等不等网络） |
| D4 | 持久化 | (a) `$DSH_HOME/<id>/state.json` 原子写 (b) `ctx.storageDomain` | **(a) 起步**，(b) 待 U2 确认后评估 |
| D5 | 心情值语义 | 单值（0–100）vs 多轴（亲密度/精力/心情） | **第一版单值 + 时间衰减 + 事件加成**，多轴留扩展位 |
| D6 | 素材格式 | (a) VP9-alpha WebM (b) 序列 PNG (c) APNG/GIF | **(a)**（A 已验证）+ 帧序列作为小动作兜底 |
| D7 | 形象来源 | 自绘 / 生成 / 授权 | **必须先解决**（见风险 R1） |
| D8 | 包名与 id | 例 `@<scope>/dsh-pet-ds`，entry id 同名 | 与包名一致（§4.4-2） |

### 5.4 为什么不是"直接把 A 改成我的"（对用户限制的回应）

- 用户要求"不得将已有桌宠项目改造成我的项目"、"不得默认现有插件可直接作为依赖"。
- 事实支持这个要求：A 的 `dsh.client` React 半侧与 B 的 C# 半侧都**不可**作为我们的一部分（前者形态不符，后者技术栈与平台不符）。
- 且 A 的**素材禁商用 + 二创须署名**，B 的美术另有 `LICENSE-ART.md` → **素材必须自产**。
- 因此本项目是**独立实现**：复用其**架构模式**（MIT 允许），不复用其**代码文件**、**动画素材**与**包结构**。

---

## 6. 交付物 D（续）：模块规格

> 用户建议的 12 个模块，逐条给出**职责 / 输入 / 输出 / 依赖 / 失败行为**。未确认的接口在使用前必须先做探针（§2.17）。

### M1 Plugin Entry（插件入口与生命周期）
- 文件：`src/host/index.ts`（构建到 `lib/index.js`）
- 形态：`export const name`、`export const inject = ['tools','credentials']`（账号可选时用 `ctx.inject`）、`export function apply(ctx, config)`
- 职责：读配置 → 建子模块 → 注册工具 → 起 Bridge → 起 Supervisor → 注册 `ctx.effect` 清理
- **硬约束**：`apply` 必须可重入且**幂等**；所有 timer/异步回调**逐个 try/catch**；`apply` 抛错只影响本 entry（可选 entry 会警告继续）
- 失败行为：配置非法 → `Config` schema 直接拒绝加载（明确报错，不静默跑）

### M2 DSH Adapter（DSH 接口适配）
- 文件：`src/host/dsh-adapter.ts`
- 职责：把 DSH 事件翻译成内部 `Intent`；隔离**所有** DSH 版本敏感面（事件名、服务名、payload 形状）**只在这一个文件里**
- 输入：`agent/status`、`agent/inbox/inserted`、`agent/assistant-stream`、`agent/error`
- 输出：`Intent[]`（思考/工作/整理/等待/成功/失败/空闲）
- 关键实现：
  - 用户主动发起判定（照抄 B 的 10 秒窗口法，§3.2）
  - 深度思考判定：`frame.chunk.type === 'reasoning-delta'`（+ 静默时长兜底）
  - 模型能力查询同放此处（`dsh-agent-default-model` / `dsh-llm`）
- 失败行为：任何 DSH 面不可用 → 该能力标记为 `degraded`，其余功能继续；日志一次，不刷屏

### M3 Desktop Pet Window（桌宠窗口）
- 文件：`src/pet/window.ts`
- 职责：无边框 / 透明 / 置顶 / 不进任务栏 / 多显示器定位 / 位置与尺寸持久化 / DPI 变化响应
- 输入：窗口配置（`size`、`corner`、`marginX/marginY`、`display`）
- 输出：窗口句柄 + 拖拽/缩放事件
- 失败行为：窗口创建失败 → 上报 `window-failed`，由 Supervisor 决定重试或降级

### M4 Animation Engine（动画播放）
- 文件：`src/pet/animation/*`
- 职责：加载动画清单、按帧/时长播放、双缓冲交叉淡入、镜像、脚底线对齐、`prefers-reduced-motion` 等价开关
- 输入：`AnimationId` + 播放参数（loop/once/speed）
- 输出：播放完成信号
- 关键：**引擎不自己决定播什么**（决策归 M9）

### M5 Character State Manager（角色状态）
- 文件：`src/pet/character-state.ts`
- 职责：当前动作、朝向、坐标、速度、气泡文本、是否在说话/被拖拽
- 输出：可序列化快照

### M6 Balance Provider（余额数据来源）
- 文件：`src/host/balance.ts`
- 职责：**降级链 A → B → 未知**
  - A：`ctx.get('deepseekAccount')?.getBalance({version, locale, timezoneOffsetSeconds})` → `{normal_wallets, bonusWallets}`
  - B：`ctx.credentials.resolve(ref)` → `GET {apiBase}/user/balance`（`balance_infos[0]`）
  - 未知：显示"余额未知"+ 原因，**绝不显示 0**
- 输出：`{ source: 'account'|'apikey'|'none', isAvailable, currency, total, granted, toppedUp, fetchedAt, stale, error }`
- 缓存：`refreshSeconds` 内复用；`inflight` 去重（照抄 B 的 `state.inflight`）
- 失败行为：失败保留上一次结果并标 `stale`（B 的做法），并通知一次（原因变化才弹，不反复打扰——A 的做法）
- **凭据纪律**：Key 只在本模块出现，绝不进入日志 / 快照 / 下发桌宠进程

### M7 Mood System（心情系统）
- 文件：`src/shared-core/mood.ts`（纯函数，两端可跑）
- 职责：心情值 0–100，**时间衰减** + 事件加成（成功/失败/点击/摸头/戳脸/低余额）+ 台词与动作选择权重
- 输入：`MoodEvent`、`elapsedMs`
- 输出：`{ mood, tier, weights }`
- 持久化：节流写盘（如 30s 或变化 >2）

### M8 Interaction System（鼠标交互与台词）
- 文件：`src/pet/interaction.ts`、`src/shared-core/lines.ts`
- 职责：点击 / 摸头（上下区域滑动）/ 戳脸（头部区域点击）/ 拖拽 / 甩抛 / 右键菜单；命中区域定义与点击穿透配合
- 台词：按 `(mood tier, action, event)` 索引，**带冷却与"不连播同段"**
- 失败行为：台词缺失 → 回落通用池

### M9 Behavior Engine（自主行为决策）★核心
- 文件：`src/shared-core/behavior.ts`（纯函数）
- 职责：**唯一仲裁者**。输入 `Intent[]`，输出单个 `Decision`
- 规则（建议初版）：
  1. 过滤 `expired`（ttlMs）与 `cooldown` 未过的
  2. 取最高 `priority`；同级按权重随机（权重可以来自心情）
  3. 当前动作 `interruptible` 或已播完 → 切换；否则**排队**（队列容量上限，超出丢最低优先级）
  4. 输出同时给出**动作 + 朝向 + 台词 + 气泡时长**
- 可测试性：**纯函数 + 时间可注入** → 可做确定性单测与离线回放（这是本项目可验收性的关键）

### M10 Asset Manager（素材管理）
- 文件：`src/shared-core/assets.ts`（清单与校验纯逻辑）+ `src/host/assets.ts`（定位与读取）
- 职责：清单校验（尺寸/格式/时长/体积预算）、分层覆盖（包内默认 < 用户层）、缺失回落
- **硬约束**：清单校验失败**显式报错并降级到默认**，不静默（A 的做法）

### M11 Settings Manager（用户设置）
- 两层：
  - **插件配置**：`cordis.patch.yml` 的 `config:`（端口、刷新间隔、阈值、开关、素材路径）
  - **桌宠设置**：`$DSH_HOME/<plugin-id>/user-config.jsonc`（宠物列表、尺寸、位置、显示模式、物理参数、台词开关）
- 语义：字段级整体替换；校验在加载时执行
- 写入：原子写（本机 `dsh-atomic-write` 存在，但作为第三方插件我们**自己实现**原子写，避免依赖非 peer 模块）

### M12 Persistence（状态持久化）
- 文件：`$DSH_HOME/<plugin-id>/state.json`（心情、位置、统计、上次余额）
- 要求：原子写（tmp + rename）、损坏可恢复（备份上一份）、节流、上限（不无限增长）
- 失败行为：写失败不致命，只在内存继续 + 记一次日志

### M13（新增）Supervisor（进程监管）
- 职责：spawn 桌宠（`detached` + `unref`）、判活（pid 自报 + 30s 窗口）、软退出（`command: 'quit'`）、崩溃重启（退避）、`stopOnUnload` 策略
- 依据：B 的 L249-310 是完整参考实现

### M14（新增）Bridge Server（回环接口）
- 职责：`/health`、`/state?pid=&wait=`（长轮询）、命令端点
- **只看 127.0.0.1**；无鉴权但**不暴露任何凭据**；端口可配 + 占用自动顺延（A 的 standalone 做法）
- 长轮询实现照抄 B 的 `waiters` Set + `notify()` + `takeEvent()`（L62-76、L177-191）

---

## 7. 交付物 F：推荐项目目录结构

> 遵循生态约定的独立包；`lib/` 为构建产物不入库。

```
dsh-pet-ds/                          # 仓库根（monorepo-lite）
├─ LICENSE                           # MIT（代码）
├─ LICENSE-ART.md                    # 美术素材条款（独立，必须写清）
├─ README.md / README.zh.md
├─ package.json                      # 插件包（见下方清单）
├─ cordis.patch.yml                  # bundle patch：insert 一行
├─ tsconfig.json
├─ tsdown.config.ts                  # 构建：host 入口 + pet 入口 + shared-core
├─ scripts/
│  ├─ prepare.mjs                    # build + 收敛 files（prepack 调用）
│  ├─ prepack-check.mjs              # 素材健康检查（尺寸/格式/体积）
│  └─ dev/
│     ├─ mock-host.mjs               # 假 Host：不开 DSH 即可调桌宠
│     └─ probe-dsh-events.mjs        # Phase 1 探针（U1/U4/U5 实测）
├─ src/
│  ├─ host/                          # ── 宿主半侧（跑在 DSH utility process）
│  │  ├─ index.ts                    #   M1 入口：name/inject/Config/apply
│  │  ├─ dsh-adapter.ts              #   M2 唯一 DSH 版本敏感面
│  │  ├─ balance.ts                  #   M6 余额降级链
│  │  ├─ bridge-server.ts            #   M14 回环接口 + 长轮询
│  │  ├─ supervisor.ts               #   M13 spawn/判活/软退出/重启
│  │  ├─ config.ts                   #   M11a 配置 schema + 默认值
│  │  ├─ persistence.ts              #   M12 $DSH_HOME/<id>/state.json
│  │  ├─ assets.ts                   #   M10 素材定位与校验
│  │  ├─ tools/                      #   模型工具
│  │  │  ├─ status.ts                #     pet_status
│  │  │  ├─ balance.ts               #     pet_balance
│  │  │  └─ control.ts               #     pet_control (start/stop/refresh/say/hide/show/reload)
│  │  └─ lines.ts                    #   台词/文案装载（服务端权威）
│  ├─ pet/                           # ── 桌宠进程（独立 Electron 窗口）
│  │  ├─ main.ts                     #   进程入口：解析 --url，起窗口
│  │  ├─ window.ts                   #   M3 透明置顶窗 / 多屏 / DPI
│  │  ├─ animation/                  #   M4 播放引擎
│  │  │  ├─ engine.ts
│  │  │  ├─ clip.ts                  #     webm / 序列帧
│  │  │  └─ transition.ts            #     双缓冲交叉淡入
│  │  ├─ interaction.ts              #   M8 命中区域 / 拖拽 / 甩抛
│  │  ├─ bubble.ts                   #   气泡
│  │  ├─ menu.ts                     #   右键菜单
│  │  └─ bridge-client.ts            #   /state 长轮询 + 命令执行
│  ├─ shared-core/                   # ── ★ 纯逻辑（两端共用，零 IO，可单测）
│  │  ├─ behavior.ts                 #   M9 统一决策器（Intent→Decision）
│  │  ├─ intent.ts                   #   Intent 类型 + 优先级表
│  │  ├─ mood.ts                     #   M7 心情公式
│  │  ├─ physics.ts                  #   拖拽/甩抛/落地纯函数
│  │  ├─ clip-manifest.ts            #   动画清单类型与校验
│  │  └─ lines-select.ts             #   台词选择（冷却/去重）
│  ├─ protocol/                      # ── 跨进程协议类型（Host 与 Pet 共用）
│  │  └─ messages.ts                 #   StatePayload / Command / Event
│  └─ standalone/                    # ── 可选：不打开 DSH 也能跑（A 的模式）
│     └─ main.ts
├─ assets/
│  ├─ config.default.jsonc           # 默认配置（含注释，带全部高级字段）
│  ├─ animations/                    # 自产素材（webm；见体积预算）
│  │  └─ manifest.json               # 动画清单（id/分类/时长/权重/镜像/循环）
│  ├─ lines/                         # 台词（按 mood tier / 事件 分文件）
│  │  ├─ zh-CN.json
│  │  └─ en-US.json
│  ├─ fonts/                         # 气泡字体（注意字体许可）
│  └─ icon.png                       # 插件图标（≤256 KiB）
├─ runtime/
│  └─ pet-bootstrap/                 # 桌宠进程的运行时外壳（Electron main 或轻量载体）
├─ locale/
│  ├─ zh.json                        # 插件展示元数据（插件管理页）
│  └─ en.json
└─ tests/
   ├─ shared-core/*.test.ts          # 决策器/心情/物理的确定性单测
   ├─ protocol/contract.test.ts      # 协议契约测试（Host 与 Pet 对同一 fixture）
   └─ e2e/smoke.mjs                  # 起 mock-host + 真桌宠 冒烟
```

**插件 `package.json` 骨架**（严格只用已核实字段）：

```jsonc
{
  "name": "@<scope>/dsh-pet-ds",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "icon": "assets/icon.png",
  "exports": {
    ".":                   { "default": "./lib/index.js" },
    "./cordis.patch.yml":  "./cordis.patch.yml",
    "./package.json":      "./package.json"
  },
  "files": ["lib", "assets/animations", "assets/lines", "assets/config.default.jsonc",
            "assets/icon.png", "locale", "runtime", "cordis.patch.yml"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "peerDependencies": {
    "@deepseek-ai/cordis":   "^4.0.4",
    "@deepseek-ai/dsh-tools": "^0.2.0-rc.1",
    "@deepseek-ai/dsh-credentials": "^0.2.0-rc.1",
    "@deepseek-ai/dsh-home-paths":  "^0.2.0-rc.1"
  },
  "engines": { "node": ">=22.12.0" },
  "scripts": {
    "build": "node scripts/prepare.mjs",
    "prepack": "npm run build && npm run typecheck && node scripts/prepack-check.mjs"
  }
}
```

`cordis.patch.yml`：

```yaml
# 本插件这一层的挂载声明
- insert:
    - id: dsh-pet-ds
      name: '@<scope>/dsh-pet-ds'
      config:
        port: 47845
        refreshSeconds: 60
        lowBalanceThreshold: 10
        autoStart: true
        startDelayMs: 3000
```

> 注意 §2.5 的生态约定：`id` 与包名一致；`id:` 那一行不要写行尾注释。

---

## 8. 交付物 G：分阶段开发计划与验收标准

> 原则：**每阶段独立可验收**、**每阶段结束必须能停下来**、**失败有明确降级**。
> 阶段 0 是本次交付（已完成）。

### 阶段 0（本次）：调查与方案
- **目标**：确认 DSH 插件机制与可行架构，产出 A–H。
- **产出**：本文件 + `_research/` 证据副本。
- **验收**：所有关键结论都有路径+行号或代码块；未确认项列在 §2.17。
- **状态**：✅ 已完成，**暂停等待用户确认**。

---

### 阶段 1：探针（Feasibility Probe）——**最高优先，先证明再动工**

- **目标**：用最小代码实测 4 个未确认项，把"设计假设"变成"已核实事实"。
- **要创建的文件**：
  - `probe/package.json`（`dsh.bundle.patch` → `cordis.patch.yml`）
  - `probe/cordis.patch.yml`
  - `probe/index.js`（约 100 行，只做探测 + 日志）
  - `probe/README.md`（结论记录）
- **前置条件**：能用 Desktop 自带 CLI 装插件（§2.13）；建议装到一个**新建的 profile**（如 `--profile probe`）以隔离。
- **实现内容**：
  1. 启动时打印：`ctx.get('storageDomain')`、`ctx.get('deepseekAccount')`、`ctx.get('webServer')`、`ctx.get('clientModules')` 是否存在（U2/U4/U6）。
  2. `ctx.on('agent/assistant-stream', ({frame}) => log(frame.type, frame.chunk?.type))` → 发一轮带推理的对话，检查是否出现 `reasoning-delta`（U1）。
  3. `try { await import('electron') } catch(e) { log(e.code) }`（U5）。
  4. 开一个回环 HTTP server，`spawn` 一个 detached 的记事本/自身副本，验证 detached + pid 判活（U7）。
  5. 改一次 `cordis.patch.yml` 的 `config`，观察是否热生效（U3）。
- **测试方法**：`dsh --profile probe`（或 desktop）启动 → 对话 → 读宿主日志。
- **验收标准**：
  - U1/U2/U3/U4/U5 每项都有**明确的"是/否 + 日志证据"**写入 `probe/README.md`。
  - **若 U1 为否**：立即启用降级方案（见下）。
  - 探针插件能干净卸载（`dsh plugin remove`）且不留残留进程/文件。
- **可能遇到的问题**：desktop profile 不允许 CLI 管理 → 改用 Desktop 自带 `dsh.cmd`；装插件需重启应用；HMR 未启用导致看不到热生效。
- **降级方案**：
  - U1 失败 → 深度思考动画降级为"用 `agent/status` + assistant-stream 静默时长 + 工具调用事件"推断出的**"专注/思考"通用档**，并在文档里明确标注"未使用推理流"。**绝不声称能识别深度思考。**
  - U4 失败 → 余额只走路 B（API Key）。
  - U6 失败 → 完全不依赖 `webServer` 路由，回环接口独立监听（本来就是本方案默认）。

---

### 阶段 2：共享核心（Shared Core）与协议——**无 IO，纯逻辑，先立骨架**

- **目标**：把最易出错、最需要被验证的部分（决策器/心情/物理/协议）以**纯函数**形式立起来，并配单测。此阶段结束后，"行为"已经可离线验证，不再依赖 GUI。
- **要创建的文件**：
  - `src/shared-core/{intent,behavior,mood,physics,lines-select,clip-manifest}.ts`
  - `src/protocol/messages.ts`
  - `tests/shared-core/*.test.ts`、`tests/protocol/contract.test.ts`
  - `tsconfig.json`、`tsdown.config.ts`
- **前置条件**：阶段 1 结论（尤其 U1）确定 Intent 的可用来源。
- **实现内容**：
  - `Intent`/`Decision` 类型与优先级表
  - 行为仲裁器：优先级 + 抢占 + ttl + 冷却 + 队列
  - 心情公式：时间衰减 + 事件加成 → 权重
  - 物理：拖拽弹簧、甩抛抛物线、边缘反弹、落地摩擦（纯函数，输入 dt）
  - 协议消息类型 + 版本字段
- **测试方法**：`node --test`（Node 内置 test runner，无需额外依赖）；**时间与随机数全部注入**，断言确定性。
- **验收标准**：
  - 决策器对"N 个 Intent 同时到达"的用例全部给出**唯一** Decision，且断言"高优先级抢占低优先级（可被打断时）"、"不可打断时排队而非覆盖"、"同 cooldownKey 不连播"。
  - 心情公式的衰减/加成有边界用例（0 与 100 夹取、超长时间衰减）。
  - 物理：对同一 dt 序列输出可复现；甩抛在屏幕边界内不越界。
  - 协议契约测试：同一 fixture 在 Host 与 Pet 两侧解析结果一致。
  - **测试覆盖率不作为目标，行为断言必须齐**。
- **可能遇到的问题**：优先级表设计不当导致"永远在排队"或"永远抢占"；物理手感靠猜。
- **降级方案**：优先级表先只做 3 档（环境/动作/事件），物理先只做"拖拽跟手 + 落地停稳"，甩抛延到阶段 5。

---

### 阶段 3：Host 半侧（Bridge + Supervisor + Tools + 余额）

- **目标**：桌宠还没画出来，但"数据与生命周期"已经完整可用、可测。
- **要创建的文件**：`src/host/{index,dsh-adapter,balance,bridge-server,supervisor,config,persistence,lines,assets,tools/*}.ts`、`probe` 里验证过的回环协议实现、`scripts/dev/mock-host.mjs`
- **前置条件**：阶段 1 结论；能写 `$DSH_HOME`。
- **实现内容**：
  - Bridge Server：`/health`、`/state?pid=&wait=`（长轮询）、`/say`、`/refresh`、命令下发
  - Supervisor：spawn/detached/unref、pid 自报判活（30s 窗口）、软退出、退避重启
  - Balance Provider：A→B→未知 降级链 + 缓存 + inflight 去重 + stale
  - DSH Adapter：事件 → Intent（含"用户主动发起"10 秒判定）
  - Persistence：`$DSH_HOME/<id>/state.json` 原子写 + 损坏恢复
  - Tools：`pet_status`、`pet_balance`、`pet_control`
  - 所有 timer/回调 try/catch（防宿主致命，§2.6）
- **测试方法**：
  - `mock-host.mjs` 假宿主 + `curl`/`Invoke-RestMethod` 打 `/state`，验证长轮询在有事件时立即返回、无事件时按 timeout 返回。
  - 用 `pet_status` 观察判活：手工杀进程 → 30s 内应变为"未运行"。
  - 断开网络 / 删掉凭据 → 余额应显示"未知 + 原因"，**不得显示 0**。
  - 故意让一个回调抛错 → **宿主不得退出**（这是阶段 3 最重要的验收）。
- **验收标准**：
  - `/state` 在无桌宠进程时也能正常响应（不能 500）。
  - 余额降级链三档都能通过开关强制触发并给出正确 `source`。
  - kill 桌宠进程后，插件在 30s 内正确判定死亡且不误报。
  - **注入式故障测试：定时器内抛错 10 次，宿主存活。**
  - 卸载插件后：无残留进程、无残留端口占用、`state.json` 保留（用户数据不丢）。
- **可能遇到的问题**：端口占用；`ctx.credentials.resolve` 返回 undefined；事件 payload 形状与预期不符；detached 进程在插件卸载后变孤儿。
- **降级方案**：端口占用 → 自动顺延并写回状态；凭据缺失 → 明确提示"请在凭据中配置 DEEPSEEK_API_KEY"；事件缺失 → Adapter 进 `degraded` 模式（只保留空闲行为 + 手动触发）。

---

### 阶段 4：桌宠进程与窗口（最小可见版本）

- **目标**：屏幕上出现一只**能呼吸、能拖动、能点击**的 DeepSeek 娘（用占位素材也可）。
- **要创建的文件**：`src/pet/{main,window,bridge-client,animation/*,interaction,bubble,menu}.ts`、`runtime/pet-bootstrap/*`、最小素材集（`assets/animations/`）
- **前置条件**：阶段 2 的 Shared Core；阶段 3 的 Bridge 可用；**D1（载体）已定稿**；阶段 0 的素材方案（R1）已落地。
- **实现内容**：
  - 透明 / 无边框 / 置顶 / 不进任务栏；位置尺寸持久化；多屏与 DPI 基础支持
  - 帧/WebM 播放 + 双缓冲交叉淡入 + 镜像 + 脚底线
  - 点击 / 触摸区 / 拖拽 / 甩抛（调 Shared Core 物理）
  - 长轮询 Bridge client
  - **点击等即时反馈走本地，不等网络**（决策 D3）
- **测试方法**：手工交互 + 录屏；`mock-host` 注入 Intent 验证动作切换；Win+方向键/多屏切换验证位置。
- **验收标准**：
  - 窗口真实透明（无黑底/白底），鼠标可穿透到桌面（在非宠物区域）。
  - 30 分钟连续运行：内存无持续增长（稳定在 ±10% 内）、CPU 空闲时 <2%（可放宽）。
  - 拖动流畅无撕裂；甩抛后能停稳、不越出屏幕。
  - 断开 Host（kill 插件进程）：桌宠不崩、显示"离线"状态并继续待机；Host 恢复后自动重连。
- **可能遇到的问题**：Windows 透明窗 + 硬件加速出现黑底（经典坑）；DPI 缩放导致坐标错位；点击穿透与交互区域冲突。
- **降级方案**：透明异常 → 关闭窗口级硬件加速或用 `UpdateLayeredWindow` 等价路径（B 已证明可行）；坐标错位 → 只支持主屏 + 单一 DPI 并明确限制；穿透冲突 → 只保留"整窗可点 + 拖动"最低交互。

---

### 阶段 5：完整行为与状态（本阶段才是"产品功能"）

- **目标**：把用户列的 9 条功能全部落地。
- **要创建的文件**：`assets/lines/*.json`、`assets/animations/manifest.json`（完整）、`src/shared-core/behavior.ts` 完善、`src/host/lines.ts`、右键菜单与设置同步
- **实现内容**：
  1. 余额等级 → 动作 + 台词（分档表 + 头顶气泡）
  2. 闲置自主行为（加权链 + 分类权重 + 不连播）
  3. 工作状态六档（思考/工作/整理/等待/成功/失败）
  4. **深度思考独立动画**（若 U1 成立）或降级通用档（U1 失败）
  5. 点击 / 摸头 / 戳脸 / 拖拽 / 甩抛 + 台词
  6. 心情值持久化 + 影响动作与台词
  7. 统一决策器消除冲突（阶段 2 已立，这里接入全部 Intent 源）
  8. 台词/素材/配置分层与校验
- **测试方法**：
  - `mock-host` 扫过所有 Intent 组合与优先级冲突场景，把 Decision 序列与期望比对（自动化）。
  - 真实 DSH 里跑：普通问答 / 带推理问答 / 工具密集任务 / 长任务 / 报错任务 / 低余额。
  - 心情：连续点击 100 次看是否封顶且台词不重复连播。
- **验收标准**：
  - **动画冲突归零**：任何事件组合下，同一时刻只有一个 `activeAction`（用日志断言）。
  - **深度思考**：若已确认，只有在真正出现 `reasoning-delta` 时才播该动画；否则它**不被播放**，且文档明确说明。
  - 六档工作状态在真实任务中**逐档被观察到**（给出每档至少一次的日志证据）。
  - 余额分档边界（阈值上下各一次）正确。
  - 心情值跨重启保持（重启后从 `state.json` 恢复，误差在允许范围）。
  - 台词**不连播同一句**（同一 cooldownKey 内）。
- **可能遇到的问题**：事件抖动导致档位频闪（需要防抖/滞回）；台词量不足以支撑长时间运行；心情值设计导致长期停在极端档。
- **降级方案**：档位频闪 → 加滞回窗口（如变化需持续 ≥1.5s 才切）；台词不足 → 用模板组合 + 通用池；心情极端 → 加回归均值项。

---

### 阶段 6：设置、交互打磨与无障碍

- **目标**：用户可自助配置；交互手感与可访问性达标。
- **要创建的文件**：`assets/config.default.jsonc`、设置读写、右键菜单项、`src/host/assets.ts` 校验、reduced-motion 开关
- **实现内容**：
  - 设置页/配置文件双入口（若接 `dsh-settings` 需先确认其客户端契约 → 否则第一版**只做配置文件 + 右键"重载配置"**）
  - 多开（多宠物实例）与每种实例独立尺寸位置
  - 右键菜单：动作点播 / 说话 / 回原位 / 查看余额 / 重载配置 / 开关显示
  - `prefers-reduced-motion` 等价开关（跳过 Q 弹与淡入）
- **测试方法**：手工 + 配置文件错误注入。
- **验收标准**：
  - 配置文件**故意写错**（非法枚举/缺字段/坏 JSONC）→ 加载时**显式报错 + 回落默认**，宠物仍可用。
  - 右键"重载配置"后**无需重启**即生效。
  - 多开 3 只宠物，各自位置尺寸独立，删掉一只不影响其他。
  - 开启减少动效后，无挤压/淡入。
- **可能遇到的问题**：JSONC 解析（需去注释）；设置改动与运行中状态的合并语义。
- **降级方案**：JSONC → 用容忍注释的解析器或改为纯 JSON + 单独注释文档；设置合并歧义 → 明确"字段级整体替换"语义并写进文档。

---

### 阶段 7：打包、安装、升级与分发

- **目标**：像生态里任何插件一样可安装、可卸载、可升级、可回滚。
- **要创建的文件**：`scripts/prepare.mjs`、`scripts/prepack-check.mjs`、`README.md`/`INSTALL.md`、`LICENSE`/`LICENSE-ART.md`、`locale/*.json`、发布 workflow
- **实现内容**：
  - `prepack` 链：build → typecheck → lint → format:check → 素材健康检查
  - `files` 白名单收敛；`pnpm pack --dry-run` 检查内容物
  - 安装文档（含"必须重开桌面应用"、Desktop 自带 `dsh.cmd` 的用法）
  - 版本兼容声明：`peerDependencies` 锁 `^0.2.0-rc.1` 一线（按实测调整）
  - 卸载清理验证（进程、端口、注册项）
- **测试方法**：在**干净 profile** 里 `dsh plugin add file:<dir>` → 启动 → 功能验证 → `remove` → 验证无残留。再用 `github:` / tarball 各测一次。
- **验收标准**：
  - 干净 profile 一次安装成功，无需手工干预（除配置凭据）。
  - 包内**无** 开发产物（源码可留）、无重复素材树、无 `node_modules`。**发布包体积达到预算（建议 ≤ 25 MB）**。
  - `remove` 后 `$DSH_HOME/<id>/` 保留用户数据，进程与端口全部释放。
  - 升级（`add` 新版本）后配置与心情值不丢。
  - 在**未登录账号**的机器上，余额路 A 失败但路 B 可用 → 功能不残。
- **可能遇到的问题**：pnpm build script 拦截（若引入原生依赖）；peer 版本范围过窄导致小幅升级即被判不兼容；`prepack` 脚本不随包发布（**不要用 `prepare`**，§2.13）。
- **降级方案**：原生依赖被拦 → 改为不引入原生依赖（纯 JS + 外部可执行）；版本被判不兼容 → 用 `compatibility.json` 精确豁免（**需用户明确接受风险**），或放宽 peer 范围并实测。

---

### 阶段 8（可选）：客户端半侧与跨平台

- **目标**：桌面进程不可用时的浏览器降级形态（方案 A），以及 macOS/Linux。
- **前置条件**：前 7 阶段稳定。
- **验收标准**：`dsh.client` 注入生效、`/plugins/<pkg>/client.js` 可加载、与桌面形态**行为一致**（靠 Shared Core 保证）；Safari/HEVC 兼容有明确方案或明确不支持声明。
- **降级方案**：不做。第一版只支持桌面端（用户原话）。

---

## 9. 交付物 H：关键风险与解决办法

| # | 风险 | 影响 | 可能性 | 解决办法 | 依据 |
|---|---|---|---|---|---|
| **R1** | **DeepSeek 娘形象与动画素材来源/授权** | 阻塞（无素材无法交付） | 高 | 三条路并行：① 自绘/委托 ② 用生成式管线（参考项目 A 的绿幕提示词配方 + ffmpeg 抠像链，**配方思路可借鉴，素材必须自产**）③ 明确取得授权。**必须同步产出 `LICENSE-ART.md` 写清我们自己的素材条款** | A 的素材"禁止商用 + 二创须署名"；B 的 `LICENSE-ART.md` |
| **R2** | 插件拿不到 Electron / 无法开窗 | 架构不成立 | 已证实为真（需外部进程） | 方案 B：spawn 独立进程；D1 载体决策（先 Windows + 自带精简载体） | §2.11 |
| **R3** | 插件内未捕获异常**打死整个宿主** | 灾难级 | 中 | **所有** timer/stream/异步回调逐个 try/catch；不产生游离 promise；用注入式故障测试验收（阶段 3） | §2.6，B 的 0.2.6 真实故障 |
| **R4** | `reasoning-delta` 事件拿不到 | 深度思考功能缺失 | 中 | 阶段 1 探针先证；失败则降级为通用"专注/思考"档，**并在文档明确标注未识别深度思考**（用户明确禁止无依据声称） | §2.15 U1 |
| **R5** | 余额能力不成立（未登录 / 服务缺失 / 接口变更） | 核心功能之一缺失 | 中 | 三档降级链 A→B→未知；**绝不显示 0**；失败保留上次值 + 标 stale | §2.14 |
| **R6** | DSH 版本快速迭代（本机 0.2.0-rc.2，生态在 0.1.x 与 0.2.x 之间摆动） | 升级即失效 | 高 | ① **DSH 敏感面全部收进 `dsh-adapter.ts`** ② `peerDependencies` 精确声明并按实测随时更新 ③ 每次 DSH 升级跑回归清单 ④ 避免依赖 `dsh.client` / `dsh-client-ui-*`（版本面最不稳定） | §2.3、§4.4-3 |
| **R7** | HMR 未启用 → 改配置/改代码必须重启 | 开发体验差 | 中 | 阶段 1 确认（U3）；开发期用独立 `probe`/`dev` profile；文档明确"装完重开应用" | `plugin-manager\README.md` L14 |
| **R8** | `desktop` profile 不允许 CLI 管理 | 装不上/调不动 | 已证实（有限制） | 一律用 Desktop 自带 `dsh.cmd`；文档给完整绝对路径命令 | `dsh\README.md` L20 |
| **R9** | 透明窗在 Windows 上黑底/闪烁 | 观感崩坏 | 中 | 关硬件加速 / 用分层窗口路径；阶段 4 专门验收"真实透明"；准备 B 的 C# 分层窗口作为最后手段（**仅作技术验证，不复用其代码**） | 经典 Electron 坑 |
| **R10** | 多屏 / 异构 DPI / 任务栏条带导致定位错误 | 体验差 | 中 | 阶段 4 限制为"主屏 + 单 DPI"，阶段 6 再扩展；所有坐标以"工作区"为界（A 的做法） | A 的 README |
| **R11** | 发布包体积失控 | 安装慢、被诟病 | 高（两个参考项目都中招） | 单一 webm 格式 + 尺寸预算 + `prepack-check` 体积门禁 + 素材不放两份；**体积预算作为阶段 7 硬性验收** | A 65.4 MB / B 31 MB + 重复树 |
| **R12** | 桌宠进程变孤儿 / 端口泄漏 | 用户困扰 | 中 | pid 自报判活 + 软退出 + 自动顺延端口 + 卸载清理验证（阶段 3/7 验收） | B 的 L249-310 |
| **R13** | 心情值设计导致行为单调（长期卡在极端档） | 趣味性差 | 中 | 回归均值项 + 事件权重可配；阶段 5 做长时间（≥2 小时）观察 | — |
| **R14** | 台词量不足导致重复 | 观感差 | 高 | 模板组合 + 通用池 + 冷却去重；把"不连播同段"做成决策器硬约束 | A 的候选数组做法 |
| **R15** | 依赖 `dsh-settings` 做设置页会引入客户端契约耦合 | 升级即断 | 中 | 第一版**只做配置文件 + 右键重载**；设置页留到阶段 8 且需先确认契约 | §2.16 |
| **R16** | 供应链：插件以用户权限运行，且我们可能引入外部可执行 | 安全 | 中 | 不引入第三方原生依赖；不联网除 DeepSeek API；凭据不落日志/不下发；发布前自审 `execute` 路径 | §2.12 |
| **R17** | 参考项目许可边界被越过 | 法律 | 中 | 只借鉴**模式**（MIT），不复用代码文件；**不复用任何动画素材**；二创若涉及必须在所有展示处分发署名 | §3.1 许可 |
| **R18** | 事件抖动导致工作状态频闪 | 观感差 | 高 | 决策器加滞回（持续 ≥1.5s 才切换）+ 最小展示时长 | §8 阶段 5 |
| **R19** | **读状态带副作用**（B 的真实缺陷：`payload()` 清掉待发的软退出） | 行为不可预测、难排查 | 中 | **读路径必须纯函数**；命令走独立队列；加"读状态不改状态"的单测断言 | §3.2.1 |
| **R20** | **桌宠忽略 `ok/stale/error`**（B 的真实缺陷：API 挂了还显示绿徽章） | 误导用户 | 中 | 协议把 `health` 与 `data` 分开；桌宠必须能显示"离线 / 数据过期"；阶段 3 用"断网"用例验收 | §3.2.1 |
| **R21** | **端口冲突无兜底**（B 的真实缺陷：只记日志，仍报"接口健康"） | 桌宠静默不工作 | 中 | 端口占用 → 自动顺延 + 写回状态 + 工具如实上报 `endpoint` 与 `listening` 两个字段 | §3.2.1 |
| **R22** | **回环接口无鉴权且有副作用端点**（B 的真实缺陷，还随包发布了 `/dev/event`） | 本机任意进程可驱动桌宠 | 中 | 有副作用端点改 **POST + 每会话随机 token**；`/dev/*` 只在开发构建编译进产物 | §3.2.1 |
| **R23** | **消息/事件通道容量不足**（B 的真实缺陷：单槽位事件互相覆盖；同一句台词不能说两次） | 行为丢失 | 中 | 事件用**有界队列**；消息带 `id` + `expiresAt`，按 id 去重而非按文本；有 round-trip 单测 | §3.2.1 |
| **R24** | **持久化字段load/save 不对称**（B 的真实缺陷：`Save()` 漏写 4 个字段） | 用户设置静默丢失 | 中 | load/save 由**同一份 schema 生成**；加 round-trip 单测（写入→读回→逐字段比对） | §3.2.1 |
| **R25** | **用户侧被迫构建 / 构建脚本未随包发布**（B 的真实缺陷：`build.cmd` 被报错文案引用却不在包里） | 用户直接卡死 | 中 | 用户侧**零构建**（预编译产物 + 校验和）；若必须构建，脚本随包发布并在 CI 里跑通 | §3.2.1 |
| **R26** | **发布产物内含重复/超大素材**（B 的真实缺陷：15.54 MB 重复树 + ~1 MB/张 PNG） | 体积与内存浪费 | 高 | `prepack-check` 加**重复文件哈希检测** + 单文件/总包体积门禁 + 单帧解码尺寸预算 | §3.2.1 |
| **R27** | 路径处理错误导致"找不到程序"（B 的真实缺陷：`new URL().pathname` 未解码） | 安装即失败，且发生在含空格/中文的用户名上 | 中 | **一律 `fileURLToPath()`**；CI 加"路径含空格与中文"的安装冒烟测试 | §3.2.1 |

---

## 10. 本阶段刻意**没有**做的事（合规声明）

按用户的严格限制逐条对照：

1. ✅ **未修改参考项目**：`C:\Users\29845\.dsh\plugin-sources\dsh-deepseek-pet-0.2.14\` 与 profile 均只读；未运行任何安装/卸载/改动命令。
2. ✅ **未把参考项目复制为新项目**：本阶段只创建了调查用临时文件（`_research/`）。
3. ✅ **未编写大规模业务代码**：`_research/` 下仅有一个 asar 读取工具（`asarextract.cjs`，约 75 行）与探测脚本，均为调查工具，非产品代码。产品代码**一行未写**。
4. ✅ **未虚构 DSH API / 事件名 / 配置字段 / 清单格式**：所有 API 与事件名都附了代码路径与行号；无法确认的已在 §2.17 明确标注。
5. ✅ **未在确认规范前决定最终工程结构**：§7 的结构是**建议**，且已标明其取决于阶段 1 的探针结论（尤其 D1 载体决策）。
6. ✅ **未把余额查询视为 DSH 必然提供**：§2.14 给出两条路 + 三档降级，并明确"两条都不可用则显示未知"。
7. ✅ **未把示例代码/模拟数据冒充真实接口**：所有代码块均标注来源文件与行号；`dshbase` 等社区站点内容单独标注为【社区】。
8. ✅ **未无依据声称可读深度思考**：§2.15 给出可识别机制（代码级证据）**同时**明确标注"未运行时实测"并设计了降级与探针。
9. ✅ **已检查许可**：§3.1 逐条列出 A 的代码 MIT / 素材禁商用 / 二创须署名；§3.2 说明 B 的代码 MIT + `LICENSE-ART.md` 另管美术（**该文件原文未逐条读取，标为待确认**）。

### 本阶段对用户环境的唯一改动（需知悉）

调查开始时，工作区 `D:\dsh\pet` 的 Windows 文件权限不完整（缺少当前用户的有效完全控制项），导致 DSH 沙箱无法把会话工作目录授权进去，连只读命令都被拒绝。已用 DSH 内置的权限诊断脚本修复，**只添加了当前用户的完全控制项，未修改任何文件内容、未改动所有者**。

- 备份与回滚脚本（**请保留，勿删**）：
  - `D:\dsh\pet\acl-backup-778dca06e1ae433bb1f52e38525b371c.json`
  - `D:\dsh\pet\acl-backup-778dca06e1ae433bb1f52e38525b371c.json.ps1`
  - 报告：`D:\dsh\pet\acl-report-05bdfe4d79c04edf8f4410bc83abc588.jsonl`
- 回滚命令：

```powershell
pwsh -NoProfile -File 'D:\dsh\pet\acl-backup-778dca06e1ae433bb1f52e38525b371c.json.ps1' -Path 'D:\dsh\pet' -AllowRoot 'D:\dsh\pet' -Restore 'D:\dsh\pet\acl-backup-778dca06e1ae433bb1f52e38525b371c.json'
```

---

## 11. 下一步需要用户决策的事项

**在开始阶段 1 之前，请确认：**

1. **D1 桌宠进程载体**（§5.3）：接受"第一版只做 Windows + 自带精简载体"吗？还是必须先上跨平台（会显著增加阶段 4 与 7 的成本）？
2. **R1 形象与素材**：DeepSeek 娘的形象由谁产出？是否有已授权的素材？这决定阶段 4 能否开始（可用占位素材先做窗口与动画引擎）。
3. **工具命名**：新插件是否沿用 `pet_status` / `pet_balance` / `pet_control` 这套名字？**注意**：本机已装的 `dsh-deepseek-pet` 已注册了 `pet_balance` 与 `pet_control`，**同名会冲突** → 建议用带前缀的名字（如 `petds_*`）或先卸载旧插件。
4. **是否保留旧插件**：本机 desktop profile 当前同时装了 `@deepseekstudio/dsh-deepseek-pet`（提供现在这个桌宠）与 `dshmarket`、`@ggboy123/dsh-paper-reader`。两个桌宠并存会互相抢注意力/端口，建议明确二选一时序。
5. **是否接受先建一个隔离 profile 做探针**（推荐 `--profile probe`），以免影响正在使用的 desktop profile。
6. **设置页形态**：第一版接受"只做配置文件 + 右键重载"（不接 `dsh-settings`），还是要一并做设置页（会引入 `dsh.client` 客户端契约耦合，风险见 R15/R6）？
7. **桌宠进程载体（D1 复核）**：Deep 分析已证明 **WPF 单文件 exe 能零 P/Invoke 实现透明置顶窗**（§3.2.2）。因此现在有两个都可行的方向：**(a) Electron**（跨平台、与参考项目 A 同源、开发快，但包体大且首次可能要下载 ~100 MB）或 **(b) WPF exe**（Windows-only、体积极小、无需下载，但需要 .NET Framework 4.x 且我们得自己写 Windows 侧）。**建议 (a) 起步**；若你更在意安装体积与"不下载 Electron"，选 (b)。

---

## 附录 A：参考项目 B（本机已装 C# 桌宠）深度索引

| 关注点 | 位置 |
|---|---|
| 插件入口与职责边界声明 | `dsh-deepseek-pet\index.js` L1-23 |
| 默认配置 | 同上 L25-36 |
| 余额查询（含凭据获取） | 同上 L81-116 |
| `/state` payload 形状 | 同上 L118-139 |
| 余额格式化与阈值 | 同上 L141-146 |
| 回环 HTTP server（全部端点） | 同上 L149-221 |
| 长轮询（waiters/notify/takeEvent） | 同上 L61-76、L177-191 |
| `ctx.effect` 清理 | 同上 L222、L414、L431、L433-435 |
| "用户主动发起"判定（10 秒窗口） | 同上 L224-244 |
| 判活（pid 自报 + 30s 窗口） | 同上 L249-262 |
| spawn（detached + unref） | 同上 L264-287 |
| stop（硬杀 vs 软退出） | 同上 L289-310 |
| `pet_balance` 工具 | 同上 L313-338 |
| `pet_control` 工具 | 同上 L340-410 |
| 定时刷新与自启动（含 try/catch 教训） | 同上 L412-437 |
| C# 侧：主宠物逻辑 240 KB | `pet-src\src\Pet.cs` |
| C# 侧：HUD / 小游戏屏 / 侧栏 / 视觉小说 | `pet-src\src\{McHud,McScreen,McSide,McVn}.cs` |
| C# 侧：工具 | `pet-src\src\tools\PetTools.cs` |
| 开发日志（175 KB，含大量踩坑记录） | `pet-src\DEVLOG.md` |
| 素材 | `pet\assets\*.png`、`pet\assets\poses\`（23 张，多数 ~1 MB） |
| 打包产物 | `deepseekstudio-dsh-deepseek-pet-0.2.14.tgz`（31.3 MB） |
| 许可 | `LICENSE`（MIT）、`LICENSE-ART.md`（美术，**本次未逐条读取**） |

## 附录 B：关键路径速查

```
DSH 安装              C:\Users\29845\AppData\Local\Programs\DeepSeek Harness\
DSH 主运行时(asar)    ...\resources\app.asar\dsh\node_modules\@deepseek-ai\
DSH 的 CLI 启动器     ...\resources\runtime\cli\bin\dsh.cmd
DSH Home              C:\Users\29845\.dsh\
desktop profile       C:\Users\29845\.dsh\profiles\desktop\
插件管理操作日志       ...\profiles\desktop\.plugin-manager\logs\operation-*\pnpm.log
市场状态与兼容缓存     ...\profiles\desktop\.dsh-market\{state.json,discovery-compatibility-v1.json}
凭据                  C:\Users\29845\.dsh\.credentials.yaml
存储根                C:\Users\29845\.dsh\storages\
参考项目 B(已装)      C:\Users\29845\.dsh\plugin-sources\dsh-deepseek-pet-0.2.14\
参考项目 A(npm)       https://www.npmjs.com/package/dsh-pet  (0.3.6) / github.com/PC2005-cloud/dsh-pet
本次调查副本          D:\dsh\pet\_research\
asar 读取工具         D:\dsh\pet\_research\asarextract.cjs
```

---

*本报告为阶段零交付物。已按用户要求暂停，等待 §11 的决策确认后再进入阶段 1（探针）。*
