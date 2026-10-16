# 安装指引

把 **DSH 桌宠**（`dsh-pet-ds`）装进 DeepSeek Harness。

安装分**两条路**，任选一条：

| 方式 | 适合谁 | 耗时 |
|---|---|---|
| [A. 用安装器（推荐）](#a-用安装器推荐) | 大部分人 | 1 条命令 |
| [B. 完全手动](#b-完全手动) | 想自己掌控每一步 / 排查问题 | 3 步 |

两条路**做的事完全一样**（改两个字段 + 装依赖），安装器只是替你做了并顺手检查环境。

---

## 装之前：三件事

### 1. DSH 已经装好、并且至少打开过一次

安装器要往 **DSH 的 profile** 里写东西，所以 DSH 得先存在。

```
$DSH_HOME/profiles/<profile 名>/
```

`$DSH_HOME` 默认是 `~/.dsh`（Windows：`C:\Users\<你>\.dsh`）。
**打开一次 DSH 就会自动建好这个 profile 目录。**

### 2. Electron 运行时（桌宠的窗口进程要用）

桌宠是一个**独立的 Electron 窗口进程**，所以需要 Electron 运行时。

> ⚠️ **它必须装在工作区之外。** 本机实测：工作区目录内的 `electron.exe`
> 启动即崩（`EXCEPTION_BREAKPOINT @ IsLoadBrowserProcessSpecificV8SnapshotEnabled`）。
> 所以**不要** `npm install electron`。

```bash
node scripts/dev/install-electron.mjs --version 38.2.0
```

它会装到 `$DSH_HOME/electron/electron-38.2.0-win32-x64/`，插件的自动探测就能找到。

> 不想用这个版本也行：插件会按 `$DSH_HOME/electron/electron-*` 探测，
> 也可以用环境变量 `DSH_PET_EXE` 显式指定，或在插件配置里写 `electronPath`。

### 3. 动画素材

⚠️ **动画素材不在仓库里**（体积 112 MB，且授权只限作者本人）。

请把它们放到 `assets/animations/` 下，每个动作一个子目录：

```
assets/animations/
  stand/      manifest.json + frame_*.png
  hang/       ...
  eat/        ...
  sleep/      ...
  awake/      ...
  head/  chest/  stomach/  leg/
  play-mc/
```

没有素材时**插件能装、能加载，但桌宠起不来会报错**。安装器会在第 1 步就检查并告诉你。

---

## A. 用安装器（推荐）

在**插件仓库根目录**执行：

```bash
# 先看看它会改什么（不写任何文件）
node scripts/install.mjs --dry-run

# 确认无误后正式安装
node scripts/install.mjs
```

### 它做了什么

```
[1/5] 检查插件本体      —— 入口、素材、cordis.patch.yml 是否齐
[2/5] 定位 DSH 与 profile
[3/5] 把插件登记进 profile   ← 改两个字段，首次改动前自动备份
[4/5] 把依赖装进 node_modules  ← 跑 pnpm install
[5/5] 验证 DSH 能解析到插件
```

第 3 步**只改** profile 的 `package.json` 里两个字段：

```jsonc
{
  "dsh": { "profile": { "bundles": [ ..., "dsh-pet-ds" ] } },
  "dependencies": { "dsh-pet-ds": "file:D:/dsh/pet" }
}
```

改之前会备份成：

```
package.json.bak-before-dsh-pet-ds
```

> 备份**只在第一次**时创建，重复运行不会把好备份覆盖成坏的。

### 装完：重启 DSH

**插件是在 DSH 启动时加载的，必须重启才会生效。**

重启后桌宠会在几秒内自动出现（配置项 `autoStart: true`）。

### 安装器的全部选项

```bash
node scripts/install.mjs --help
```

| 选项 | 作用 |
|---|---|
| `--profile <名字\|绝对路径>` | 指定装进哪个 profile（默认取 `DSH_PROFILE`，再退回"唯一的那个"） |
| `--link` | 装完把包换成指向本仓库的**目录联接**，让**改源码立即生效** |
| `--no-pnpm` | 跳过 `pnpm install`，自己手动装 |
| `--dry-run` | 只显示要改什么，不落盘 |
| `--uninstall` | 从 profile 移除本插件 |
| `--help`, `-h` | 显示帮助 |

---

## B. 完全手动

不想用安装器就照下面做。**三步**。

### 第 1 步：找到要装进哪个 profile

```powershell
# Windows PowerShell
echo $env:DSH_HOME      # 一般是 C:\Users\<你>\.dsh
echo $env:DSH_PROFILE   # 当前 profile 名，一般是 desktop
```

profile 目录就是：

```
$DSH_HOME\profiles\<profile 名>\
```

如果环境变量是空的，就列一下：

```powershell
dir "$env:USERPROFILE\.dsh\profiles"
```

> 有多个 profile 时**别猜** —— 装错的那个 DSH 里看不到插件。

### 第 2 步：编辑 profile 的 `package.json`

打开 `$DSH_HOME\profiles\<profile 名>\package.json`，加两处：

```jsonc
{
  "name": "dsh-profile-desktop",
  "private": true,

  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-pet-ds"                    // ← 加这一行
      ]
    }
  },

  "dependencies": {
    "dsh-pet-ds": "file:D:/dsh/pet"     // ← 加这一行，换成你的仓库绝对路径
  }
}
```

#### ⚠️ 两个必须注意的地方

**一、路径必须是绝对路径、且用正斜杠。**

```
✅ "file:D:/dsh/pet"
❌ "file:../../dsh/pet"          ← 相对路径跨盘会解析失败
❌ "file:D:\\dsh\\pet"           ← 反斜杠在依赖说明符里是转义字符
```

为什么不能用相对路径：profile 在 `~/.dsh/profiles/<名>/`，而插件仓库常常
**在另一个盘**（例如 `D:\`）。相对路径跨盘算出来是个不存在的路径 —— 本机实测踩过。

**二、编辑时别引入 BOM。**

用 PowerShell 的 `Set-Content -Encoding utf8` 写出来的文件**带 UTF-8 BOM**
（`EF BB BF`），而**带 BOM 的 JSON 是非法 JSON** —— DSH 会读不了这个 profile。

BOM 是**不可见**的，所以这个问题很难自己发现。两个办法：

- 用编辑器存成 **"UTF-8 无 BOM"**（VS Code 右下角可切）；
- 或者干脆用安装器（它会主动剥掉 BOM，已经带 BOM 的文件也能正常处理）。

检查是否带 BOM：

```powershell
$bytes = [System.IO.File]::ReadAllBytes("$env:USERPROFILE\.dsh\profiles\desktop\package.json")
if ($bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) { "带 BOM（要清掉）" } else { "没有 BOM ✅" }
```

### 第 3 步：装依赖

在 **profile 目录**里跑 `pnpm install`：

```powershell
cd "$env:USERPROFILE\.dsh\profiles\desktop"
pnpm install
```

> DSH 自带一个 pnpm。不想用系统的那个就指定它：
> `$DSH_HOME\dsh-runtimes\<运行时>\dependencies\pnpm\bin\pnpm.mjs`
> （用同目录下的 `node\bin\node.exe` 执行）。

装完检查一下能不能解析到：

```powershell
node -e "const{createRequire}=require('module');const r=createRequire('$env:USERPROFILE/.dsh/profiles/desktop/package.json');console.log(r.resolve('dsh-pet-ds'))"
```

应该打印出 `<仓库路径>\src\host\index.js`。

然后**重启 DSH**。

---

## 装完怎么验证

重启 DSH 后，按顺序看这四件事：

| # | 期望看到 | 看不到说明 |
|---|---|---|
| 1 | 桌面上出现透明小窗（蓝发鲸鱼娘） | 插件没加载，或 Electron / 素材有问题 |
| 2 | 右键它有「对话 / 动作 / 尺寸 / 置顶 / 退出」菜单 | 插件加载了但桌宠没起来 |
| 3 | 窗口下方常驻面板显示你的 API 余额 | 凭据没配（其它功能正常） |
| 4 | 在 DSH 里关掉它，桌宠跟着消失 | 见下面「退出 DSH 时关桌宠」 |

### 在 DSH 里找插件的证据

如果桌宠没出现，先在 DSH 里确认插件**加载了没有**。本插件的工具会在
DSH 的模型工具列表里出现：

- `DSHpet_status` —— 看桌宠进程状态
- `DSHpet_balance` —— 查账户余额
- `DSHpet_control` —— 起停桌宠、让它说话

**能看到这三个工具 = 插件加载成功**，问题在桌宠进程那一侧（Electron / 素材）。

---

## 排障

### 桌宠没出现

按顺序排除：

```powershell
# 1) 插件解析得到吗
node -e "const{createRequire}=require('module');const r=createRequire('$env:USERPROFILE/.dsh/profiles/desktop/package.json');console.log(r.resolve('dsh-pet-ds'))"

# 2) Electron 在吗
dir "$env:USERPROFILE\.dsh\electron"

# 3) 素材在吗（应列出 10 个目录）
dir "D:\dsh\pet\assets\animations"

# 4) 桌宠进程在吗
Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
  Where-Object { $_.CommandLine -like '*pet-app*' } |
  Select-Object ProcessId, CommandLine
```

### 插件加载了，但 `DSHpet_status` 说找不到 Electron

装运行时：

```bash
node scripts/dev/install-electron.mjs --version 38.2.0
```

或显式告诉插件路径（在 profile 的 `cordis.patch.yml` 里，或插件配置里）：

```yaml
electronPath: 'C:\path\to\electron.exe'
```

### 余额面板显示 `未配置` / `--`

余额需要凭据。本插件**自己读**凭据文件（不依赖 DSH 转发）：

```
$DSH_HOME\.credentials.yaml
```

里面要有 `refs.DEEPSEEK_API_KEY`。检查：

```powershell
Get-Content "$env:USERPROFILE\.dsh\.credentials.yaml"
```

> 该文件里密钥是**明文**的（这是 DSH 的存储方式）。
> 本插件只用它查询余额，并且**只在桌宠的主进程里读** —— 不会传进渲染进程。

### 退出 DSH 时桌宠没关

这条依赖 DSH **优雅退出**（走 `fiber.dispose()`）。

**若 DSH 被强杀**（任务管理器结束进程、崩溃），清理器不会跑，桌宠会留下。
这是有意的取舍 —— 因为"桌宠在 DSH 没开时也能显示余额"是明确要求过的
（余额由桌宠自取），两者不可兼得。

### 想改源码立即生效

`pnpm install` 会把包做成**硬链接拷贝**，改源码不一定生效。装的时候加 `--link`：

```bash
node scripts/install.mjs --link
```

它会把 `node_modules\dsh-pet-ds` 换成指向本仓库的**目录联接**
（Windows 上用 `mklink /J`，**不需要管理员权限**）。

之后：

| 改了什么 | 怎么生效 |
|---|---|
| `pet-app/**`（窗口、动画、面板、菜单） | **只重启桌宠** |
| `src/shared-core/**`（共用逻辑） | **只重启桌宠** |
| `src/host/**`（工具、桥接、监管） | **重启 DSH** |

> 如果哪天重跑了 `pnpm install`，联接会被换成拷贝，再执行一次 `--link` 即可。

---

## 卸载

```bash
node scripts/install.mjs --uninstall
```

它会把 `dsh-pet-ds` 从 `bundles` 和 `dependencies` 里移除（**不会**动别的插件）。

然后重启 DSH。残留的 `node_modules\dsh-pet-ds` 可以自己删，或跑一次
`pnpm install` 让 pnpm 清理。

---

## 附：这插件到底被 DSH 怎么加载

理解这个有助于排障：

1. DSH 读 profile 的 `package.json`，看 `dsh.profile.bundles` 列表；
2. 对每个 bundle，用 Node 的模块解析找它的包（走 profile 的 `node_modules`）；
3. 读该包 `package.json` 里的 `dsh.bundle.patch`（本插件是 `./cordis.patch.yml`）；
4. 把那一层 patch 叠进配置树 —— 本插件的 patch 是往树里 `insert` 一行：

   ```yaml
   - insert:
       - id: dsh-pet-ds
         name: 'dsh-pet-ds'      # 解析到这个包
         config: { port: 47845, size: 260, autoStart: true, ... }
   ```

5. 于是 DSH 加载 `main`（本插件是 `src/host/index.js`），调用它的 `apply()`。

所以**任何一个环节断了都表现为"DSH 里没有插件"**：bundles 没写、
依赖没装、`dsh.bundle.patch` 字段缺、patch 文件缺失、`main` 解析不到。
安装器的五步检查就是照着这条链设计的。
