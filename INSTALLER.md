# 安装方法

本仓库提供**两种**安装方式。**推荐用第一种。**

| 方式 | 产物 | 安全提醒 | 建议 |
|---|---|---|---|
| **PowerShell 脚本（推荐）** | `install-pet.ps1` + `register-profile.mjs` + `.tgz` | **无** | 默认用这个 |
| 图形安装程序（可选） | `dist/setup.exe`（114 MB） | **会弹 SmartScreen** | 只在需要"单文件、不依赖本地环境"时用 |

> **为什么脚本是首选**：`setup.exe` 未签名，Windows Defender SmartScreen 会拦它
> （"Windows 已保护你的电脑"），而**签名也解决不了** —— 见下面「权限与安全提醒」。
> PowerShell 脚本不经过 SmartScreen，双击/右键运行即可，没有这个摩擦。

---

## 方式一：PowerShell 脚本（推荐）

需要三个文件放在**同一个目录**里：

```
install-pet.ps1          一键安装脚本
register-profile.mjs     登记 profile 配置（脚本会调用它）
dsh-pet-ds-<版本>.tgz     插件包体
```

然后任选一种运行：

```powershell
# 1) 右键 install-pet.ps1 → "使用 PowerShell 运行"
# 2) 在 PowerShell 里：
powershell -ExecutionPolicy Bypass -File .\install-pet.ps1
# 3) 指定包体或配置目录：
.\install-pet.ps1 -Tgz D:\path\to\dsh-pet-ds-0.1.3-fix.tgz
.\install-pet.ps1 -DshHome C:\Users\me\.dsh -Profile desktop
# 4) 只检查、不改任何东西：
.\install-pet.ps1 -WhatIf
```

它会做 4 步并在屏幕上逐条报告：

```
[1/4] 插件包体          找 .tgz（脚本旁边，或 -Tgz 指定）
[2/4] DSH 配置目录      找 $DSH_HOME / ~/.dsh 与目标 profile
[3/4] Node 与 pnpm      用 DSH 自带的运行时
[4/4] 安装              用 pnpm 装进 profile，再登记进 bundles / dependencies
```

装完**重启 DSH** 即可。

### 它改了什么

只改 profile 的 `package.json` **两处**，且**改前自动备份**为
`package.json.bak-before-dsh-pet-ds`：

```jsonc
{
  "dsh": { "profile": { "bundles": [ ..., "dsh-pet-ds" ] } },
  "dependencies": { "dsh-pet-ds": "file:D:/path/to/dsh-pet-ds-0.1.3-fix.tgz" }
}
```

### 为什么用 `.ps1` 而不是 `.cmd` 或 `.exe`

- **不用 `.exe`**：SmartScreen 会拦，签名也救不了（见下）。
- **不用 `.cmd`**：`cmd.exe` 按**系统 ANSI 代码页**读 `.cmd`（中文 Windows 上是
  GBK），UTF-8 存的中文会乱码并把语法搞碎；写 `chcp 65001` 也没用。
  我按这条路实现过一版，实测碎成一堆 `'ho' is not recognized as an internal command`，
  而且它在内部 `set "DSH_HOME="` 清空了传入的变量、导致沙箱测试**改到了真实 profile**
  —— 一个会误伤用户配置的载体不值得留。PowerShell 读 UTF-8 BOM 没有这些问题。

### 三个必需的 pnpm 开关

```powershell
pnpm add <tgz> --ignore-workspace --config.confirmModulesPurge=false --config.auto-install-peers=false
```

| 开关 | 不写会怎样 |
|---|---|
| `--ignore-workspace` | pnpm 向上找 `pnpm-workspace.yaml` 工作区根，把安装归到工作区去做，profile 里什么都没有 |
| `--config.confirmModulesPurge=false` | 非交互环境里 pnpm 问"要不要清空 node_modules"并放弃：`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` |
| `--config.auto-install-peers=false` | pnpm 会去 npm 源抓 `@deepseek-ai/dsh-tools`（它是**运行时注入**的 peer），而源上没有匹配版本 → `ERR_PNPM_NO_MATCHING_VERSION`，整次安装失败 |

---

## 方式二：图形安装程序 setup.exe（可选）

| 产物 | 大小 |
|---|---|
| `dist/setup.exe` | 约 114 MB |

双击后选安装目录（默认 `%LOCALAPPDATA%\DSH-Pet`）→ 点「开始安装」。
插件落在所选目录下的 `dsh-pet-ds\` 子目录。

**特点**：包体整个内嵌在 exe 里，所以目标机**不需要联网、也不需要预装 pnpm**。

**代价**：未签名 → **每次运行都会被 SmartScreen 拦一次**（见下）。

也支持命令行：

```powershell
setup.exe --silent   D:\DSH-Pet     # 无界面安装
setup.exe --selftest D:\some\dir    # 只解压并逐项自检（不动 DSH 配置）
```

---

## 权限与安全提醒

会遇到两个**完全不同**的提示，很容易混为一谈，分开讲。

### 一、UAC「你要允许此应用对你的设备进行更改吗？」

**只在使用 `setup.exe` 时出现，点「是」即可。**

它的清单里写了 `requireAdministrator`（见 `installer/setup.manifest`），
所以 Windows 在**加载它之前**就弹一次 UAC。这样"权限不足"会在**一开始**
就说清，而不是解压到一半才失败。

> 用 **`install-pet.ps1`（方式一）不会有这个提示** —— 它只写你自己的用户目录，
> 不需要管理员权限。

### 二、SmartScreen「Windows 已保护你的电脑」

**这个跟权限无关** —— 是**发布者信誉**的问题，管理员权限也过不去。
**只有 `setup.exe` 会触发**；PowerShell 脚本不会。

**怎么立刻用上**：点 **「更多信息」** → 会展开出 **「仍要运行」** → 点它。

> 「仍要运行」**必须点开「更多信息」才会出现**。第一眼只看到「不运行」是正常的。

也可以：右键 `setup.exe` → **属性** → 「常规」页底部若有 **「解除锁定」**，勾上并确定。

**为什么签名也救不了**：

微软官方文档 [SmartScreen reputation for Windows app developers](
https://learn.microsoft.com/windows/apps/package-and-deploy/smartscreen-reputation)
写得很明确：

| 证书类型 | 首次下载/运行的行为 |
|---|---|
| 微软商店 | ✅ **无警告**（微软重新签名） |
| 有效证书（OV / **EV**） | ⚠️ **仍会警告**，只是显示已验证的发布者名 |
| **未签名** | ⚠️ 警告「Windows 已保护你的电脑」 |
| **自签名** | ⚠️ **与未签名完全相同** |

两个反直觉但很重要的事实：

- **自签名证书毫无帮助** —— 与不签名行为一模一样。所以本项目刻意**不**往你的
  "受信任的根证书颁发机构"里塞证书：没用，只是污染信任库。
- **EV 证书也不再豁免** —— 文档原话："Years ago, signing files with an Extended
  Validation (EV) code signing certificate would result in positive SmartScreen
  reputation by default, but **this behavior no longer exists**."

真正能免警告的只有两条：**发到微软商店**，或**攒文件哈希信誉**
（文档说需要 "several weeks and hundreds of clean installs from a wide audience"）。

### 签名脚本

```powershell
node scripts/dev/sign-installer.mjs -Check                 # 看当前签名状态
node scripts/dev/sign-installer.mjs -Cert <指纹或主题名>    # 用已有证书签
node scripts/dev/sign-installer.mjs -SelfSigned            # 生成自签名证书并签
```

签名仍值得做（显示发布者名、完整性、企业分发、信誉可继承），
但**目的不是消除 SmartScreen 警告**。

⚠️ 签名会**改写 exe 字节**，必须在 `build-installer.mjs` **之后**跑。

---

## setup.exe 的五步流程

```
[1/5] 检查安装目录          路径必须绝对、可创建
[2/5] 解压插件包体          内嵌载荷（含依赖树，约 115 MB）
[3/5] 定位 DSH              找 $DSH_HOME 与目标 profile
[4/5] 登记进 profile        改 package.json 两处（改前自动备份）
[5/5] 校验 + 刷新依赖       用 DSH 自带的 pnpm 让 DSH 认得插件
```

第 4 步改的就是**两处**（与仓库里 `scripts/install.mjs` 完全一致）：

```jsonc
{
  "dsh": { "profile": { "bundles": [ ..., "dsh-pet-ds" ] } },
  "dependencies": { "dsh-pet-ds": "file:D:/DSH-Pet/dsh-pet-ds" }
}
```

---

## 几个设计决定（都有理由）

### 改配置用**保格式的文本改写**，不重新序列化

`package.json` 是 DSH 的配置，被人手改过是常态。用 JSON 库读→写会把缩进、
换行、键序、注释全冲掉。所以 `ProfileConfig.Apply` 只做保守的文本替换：
**只动那两处**，其余字节不动。

另外目标框架是 .NET Framework 4.0（Windows 自带、无需额外安装），
那个版本**没有** `System.Text.Json`，引入 Newtonsoft 又会让 exe 变成多文件。

### 解压用**自写的 MiniZip**，不用 `ZipFile`

`System.IO.Compression.ZipFile` 是 **.NET 4.5** 才有的。本安装程序用 Windows
自带的 csc（**4.0** 编译器）编译，用它就会要求目标机装 .NET 4.5+ ——
Windows 7 与早期 Windows 8 只有 4.0，那些机器上会直接崩。

而 `DeflateStream` 从 .NET 2.0 就有，覆盖面大得多。所以自己解析 ZIP 的
中央目录。**只支持我们自己打的载荷**，遇到不支持的格式（ZIP64、加密、
其它压缩方法）**明确抛异常**，绝不静默跳过 —— 静默跳过会得到
"看起来装好了、其实缺文件"的安装，那比直接失败难查得多。

### 载荷用 `csc /resource:` 内嵌，不用字节字面量

一开始把载荷生成成 C# 字节字面量（`Payload.g.cs`）以避免"资源名找不到"
的静默失败。结果源码 **409 MB**、1.15 亿个数组元素，csc 编译**几分钟不结束**
（实测转后台仍未完成）→ 放弃。

现在用 `/resource:`,编译**0.3 秒**。代价是资源名写错只会返回 null，
所以构建脚本加了一条断言：**exe 体积必须包含载荷**。
没有它，资源名写错会产出一个"能打开、界面正常、一点安装就报缺载荷"的 exe。

### 载荷里的依赖必须**摊平**（`node-linker=hoisted`）

pnpm 默认把包放进 `.pnpm/` 再在顶层建**联接**。而 `Compress-Archive`
（以及绝大多数 zip 工具）**不保留联接** —— 解压后 `node_modules/@deepseek-ai/`
是**空目录**，插件加载时报 `failed to import`。

`hoisted` 让依赖成为**真实目录**，zip 往返无损。
构建脚本另有一条断言：**载荷里不能有任何链接**。

---

## 从源码构建

```powershell
node scripts/dev/build-package.mjs      # ① 生成 .tgz 与载荷（含依赖树）
node scripts/dev/build-installer.mjs    # ② 编译 setup.exe
```

要求：Windows 自带的 `csc.exe`（`%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\`）。
**不需要** Visual Studio、不需要 .NET SDK、不需要额外的打包工具。

源码只有两个文件：

| 文件 | 作用 |
|---|---|
| `installer/Setup.cs` | 界面 + 安装流程 + 配置改写 + 自检模式 |
| `installer/MiniZip.cs` | 极简 ZIP 解压（只用 `DeflateStream`） |

---

## 验证

```powershell
node scripts/dev/test-setup-extract.mjs   # 解压自检（13 项）
node scripts/dev/test-setup-pnpm.mjs      # pnpm 步骤真的成功了吗（5 项）
node scripts/dev/test-setup-install.mjs   # 完整安装流程（18 项）
```

三个脚本都在**临时 DSH_HOME** 上跑，**不碰你的正式配置**，
跑完自动清理（先摘目录联接再删，避免顺着联接删到真实文件）。

`test-setup-install.mjs` 除了"退出码 0"，还会断言：

- `bundles` / `dependencies` 真的改对了；
- **原有内容与格式没被破坏**（缩进、键序、其它依赖都在）；
- **改前生成了备份**，且备份内容等于改前原文；
- 改后的 JSON 仍合法、**没有引入 BOM**（带 BOM 的 JSON 有解析器会拒）。

---

## 踩过的坑（都写进注释了，这里列个索引）

| 现象 | 真因 | 修法 |
|---|---|---|
| `DirectoryNotFoundException: …assets\animations\ 的一部分` | `Path.GetFullPath` 会去掉结尾分隔符，末段被当文件名而父目录还没建 | 目录条目**先建父目录**再建自己 |
| 解压后 `@deepseek-ai` 是空目录 → `failed to import` | pnpm 的联接经 zip 往返丢失 | 载荷改用 `node-linker=hoisted` |
| `No projects found in "<某目录>"` | 在沙箱放 `pnpm-workspace.yaml` 反而把 profile 排除在外 | 安装器改用 `--ignore-workspace` |
| `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` | pnpm 想清空自带 node_modules，非交互环境里拒绝 | 加 `--config.confirmModulesPurge=false` |
| `pnpm install` 跑去装仓库依赖、超时 180 秒 | pnpm 向上找工作区根 | 同上 `--ignore-workspace` |
| 自检"输出 0 行、退出码为空" | GUI 子系统程序在 PowerShell 里**立即返回** | 用 `setup-runner.mjs`：启动后**轮询进程**，以文件系统为判据 |
| `Start-Process -Wait` 挂住不返回 | 同上（GUI 子系统） | 同上 |
| 自检报告写不出来、看不到失败原因 | `%TEMP%` 在沙箱下不可写 | 报告改写到**目标目录的父目录** |
| csc 编译几分钟不结束 | 载荷写成字节字面量（1.15 亿个元素） | 改用 `csc /resource:` |

---

## 相关文档

| 文档 | 内容 |
|---|---|
| [INSTALL.md](./INSTALL.md) | 安装指引（四种方式：官方命令 / 安装器 / `.tgz` / 手动） |
| [INSTALL-MANUAL.md](./INSTALL-MANUAL.md) | 完全手动安装（不用任何脚本） |
| [INSTALL-AGENT.md](./INSTALL-AGENT.md) | 给 agent 用的一条命令版 |
| [RELEASE.md](./RELEASE.md) | 发布流程 |
