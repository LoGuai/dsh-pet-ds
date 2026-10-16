# 安装程序（setup.exe）

一个**单文件、双击即用**的图形安装程序：把桌宠插件装到你指定的任意目录，
并自动配置 DSH。

| 产物 | 大小 | 说明 |
|---|---|---|
| `dist/setup.exe` | 约 114 MB | 自带插件包体**与依赖树**，拷到哪都能跑 |

> **为什么不依赖网络**：包体（含 `node_modules`）整个内嵌在 exe 里。
> 所以目标机不需要联网、也不需要预装 pnpm —— 装完插件就能用。

---

## 怎么用

双击 `setup.exe`，界面里：

1. 选**安装目录**（默认 `%LOCALAPPDATA%\DSH-Pet`，可改成任意目录）；
2. 点「开始安装」；
3. 装完重启 DSH。

插件本体落在你所选目录下的 **`dsh-pet-ds\`** 子目录里
（例如选 `D:\DSH-Pet` → 插件在 `D:\DSH-Pet\dsh-pet-ds`）。

### 命令行（给自动化用）

```powershell
setup.exe --silent   D:\DSH-Pet     # 无界面安装
setup.exe --selftest D:\some\dir    # 只解压并逐项自检（不动 DSH 配置）
```

两种模式都有退出码：`0` = 成功。

> ⚠️ 这两种模式是**给自动化与排障用的**，界面模式下不需要它们。

---

## 它做了哪五步

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
