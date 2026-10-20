# 安装（agent 版）

> 这份是**给自动化 / agent 读**的：只要一条命令 + 退出码，不需要理解 DSH 内部概念。
> 给人看的详细版见 [INSTALL.md](../INSTALL.md)。

## 先看手里是什么

| 拿到的东西 | 怎么做 |
|---|---|
| 一个目录（含 `package.json`） | `node install.mjs` |
| 一个 `.tgz` 安装包 | `tar -xzf <包>` 然后 `node package/install.mjs` |

> ⚠️ **不要用 `pnpm add <tgz>` 代替安装。** 实测它会成功，也会把文件和依赖
> 都装好（插件自带依赖也装、从 profile 也解析得到入口），但它**不登记
> `dsh.profile.bundles`** —— 而那是 DSH 认插件的唯一依据。少了它 DSH 不会
> 加载插件，表现是"装完了但插件页里没有"。

## 一条命令

```bash
node install.mjs
```

**退出码 0 = 安装完成且验证通过**；非 0 = 失败（stderr 有原因）。

它会自动完成四件事：

1. 把插件登记进 DSH profile（`dsh.profile.bundles` + `dependencies`）；
2. 跑 `pnpm install`（**profile 与插件目录各一次** —— 两个都需要，见下）；
3. 验证插件能被导入（跑 `scripts/dev/probe-import-resolution.mjs`）；
4. 打印结论与摘要。

**它不会重启 DSH** —— 那会关掉正在跟用户对话的会话窗口。交给调用方决定。

## 参数

| 参数 | 说明 |
|---|---|
| `--profile <名字\|绝对路径>` | 指定装进哪个 profile。默认取 `DSH_PROFILE`，再退回"唯一的那个" |
| `--dry-run` | 只显示会改什么，不写任何文件 |
| `--json` | 只输出**一行 JSON**，便于程序解析 |

`--json` 的形状：

```json
{
  "ok": true,
  "pluginRoot": "D:\\dsh\\pet",
  "profile": null,
  "dryRun": false,
  "steps": [{ "name": "插件清单存在", "ok": true, "detail": "dsh-pet-ds v0.1.2" }],
  "restartRequired": true,
  "error": null
}
```

判断成功**只看 `ok`**（或进程退出码），不要靠解析文本输出。

## 前置条件（命令会检查）

| 条件 | 缺失时的表现 | 怎么补 |
|---|---|---|
| `$DSH_HOME/profiles/<名>/` 存在 | 报"找不到 profiles 目录" | 先启动过一次 DSH |
| **Electron 运行时** | 插件能加载，但桌宠窗口起不来 | `node scripts/dev/install-electron.mjs --version 38.2.0` |
| `$DSH_HOME/.credentials.yaml` | 余额面板显示"未配置"，其它正常 | 在 DSH 里配 `DEEPSEEK_API_KEY` |
| 动画素材 | 桌宠能起来但没画面 | ⚠️ **素材不在安装包里以外的地方**；本包已自带全部素材 |

前两条是**非致命**的：插件能加载，只是桌宠窗口起不来或余额不显示。
命令会把它们列成"还差这几样"，不影响退出码。

## 安装后验证（不需要 DSH 工具）

命令已经跑过验证。如需复核，这两步就够了：

```bash
# 1) 从插件真实路径出发，裸标识符是否都能解析（能否 import 的关键）
node scripts/dev/probe-import-resolution.mjs

# 2) 列出 DSH 认到的插件（这是 DSH 自己的说法）
node -e "const{createRequire}=require('module');const r=createRequire(process.env.DSH_PROFILE_DIR+'/package.json');console.log(r.resolve('dsh-pet-ds'))"
```

第 1 条要求三项全 ✓、且"真导入插件入口"成功。

真正的端到端确认需要**重启 DSH**，然后看：

- 桌宠窗口出现在桌面上（`autoStart` 默认为 true，延迟 3 秒）；
- 模型工具 `DSHpet_status` / `DSHpet_control` / `DSHpet_balance` 可用；
- DSH 设置页里出现「桌宠」一栏。

## ⚠️ 两个必须知道的坑（本包已经处理，但改动时别破坏）

### 1. 依赖要装在**两个**地方

```
<profile>/node_modules          ← 让 DSH 认得这个插件
<插件目录>/node_modules         ← 让插件的裸标识符能被 ESM 解析到
```

**为什么插件目录也要装**：ESM 解析裸标识符时，从**引用方文件**所在目录
往上找 `node_modules`。插件在 profile 里可能是个**目录联接**，真实锚点在
插件目录，所以 profile 的那份**不在解析链上**。

漏了这一步的表现（很难查，因为"依赖明明装好了"）：

```
插件页提示：启用失败：dsh: warning: 1 entry did not activate
           dsh-pet-ds (dsh-pet-ds): failed to import
模型工具消失、桥接端口不监听、插件自己一行日志都没有
```

`install.mjs` 已经两个都装。

### 2. `@deepseek-ai/schemastery` 必须在 `dependencies` 里

DSH 会给自己的一部分包**注入**模块解析（`dsh-tools`、`cordis` 等），
但**不是全部** —— `schemastery` 不在其中，必须自己声明。
声明了却装不到插件目录，就是上面那个 `failed to import`。

`scripts/dev/test-manifest-deps.mjs` 会拦住这两类问题（扫源码里所有裸标识符
import，要求逐个在清单里声明；宿主提供的那类必须放 `peerDependencies`）。

## 卸载

```bash
node scripts/install.mjs --uninstall
```

然后重启 DSH。残留的 `node_modules/dsh-pet-ds` 可自行删除，或跑一次
`pnpm install` 让 pnpm 清理。

## 这个包里有什么

```
package/
  install.mjs                     ← 本文件说的那一条命令
  INSTALL-AGENT.md                ← 你正在读的
  INSTALL.md                      ← 给人看的详细指引（含完全手动做法、排障）
  README.md                       ← 设计与踩坑记录
  package.json                    ← 插件清单（dsh.bundle.patch + dsh.client）
  cordis.patch.yml                ← DSH 靠它把插件挂进配置树
  src/                            ← 宿主半侧（工具 / 桥接 / 监管 / 配置 schema）
  client/client.js                ← 设置页的浏览器半侧
  pet-app/                        ← 桌宠窗口进程（Electron）
  assets/animations/              ← 10 个动作的动画素材（包的主体，约 112MB）
  scripts/install.mjs             ← 安装器本体（本脚本调它）
  scripts/dev/probe-import-resolution.mjs  ← 解析链验证（本脚本调它）
```

## 本包的版本

见 `package.json` 的 `version`。版本号在三处保持一致
（`package.json` / `pet-app/package.json` / `src/host/index.js` 的 `VERSION`），
`test-manifest-deps.mjs` 会断言这一点。
