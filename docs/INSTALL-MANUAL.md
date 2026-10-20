# 手动安装指引

**不用安装器、不用官方命令**，纯手工把桌宠插件装进 DeepSeek Harness。

> 大多数情况下你**不需要**手动做 —— 用
> `plugin_manager install_bundle` 或 `node install.mjs` 一条命令就够。
> 这份文档给的是"每一下都自己来"的完整过程，用于：
> **排查安装失败**、**理解 DSH 到底怎么加载插件**、或者**环境受限**（没有 pnpm 命令、要装到多个 profile）。

---

## 一、手动安装到底改了什么

只有**两处**改动，加上**一条命令**：

| # | 改哪里 | 改成什么 |
|---|---|---|
| 1 | profile 的 `package.json` → `dsh.profile.bundles` | 加一个元素 `"dsh-pet-ds"` |
| 2 | profile 的 `package.json` → `dependencies` | 加一条 `"dsh-pet-ds": "<插件来源>"` |
| 3 | 在 **profile 目录**跑 `pnpm install` | 让 DSH 能解析到这个包 |

> `bundles` 才是 **DSH 认插件的唯一依据**。只加 `dependencies`（或只跑 `pnpm add`）
> 是不够的 —— 表现是"装完了但 DSH 里没有这个插件"。

**为什么需要第 3 步**：`bundles` 里写的是**包名**，DSH 要用 Node 的模块解析
在 profile 的 `node_modules` 里找到它。`dependencies` 只是"声明依赖"，
真正把它落到 `node_modules` 的是 `pnpm install`。

---

## 二、开始之前

### 1. 确认 DSH 装过、且至少打开过一次

```powershell
echo $env:DSH_HOME       # 一般是 C:\Users\<你>\.dsh
echo $env:DSH_PROFILE    # 当前 profile 名，一般是 desktop
dir "$env:USERPROFILE\.dsh\profiles"
```

profile 目录 = `$DSH_HOME\profiles\<profile 名>\`，里面应该已有 `package.json`。

> ⚠️ 有多个 profile 时**别猜**。装到哪个 profile，就只有那个 DSH 看得到插件。

### 2. 拿到插件本体（三种形态，任选）

| 你手里 | 目录长什么样 | 下面第 2 步里 `dependencies` 写什么 |
|---|---|---|
| 源码仓库 / 解包后的目录 | 有 `package.json`、`cordis.patch.yml` | `file:<那个目录的绝对路径>` |
| `.tgz` 安装包（**不解包**） | 单个文件 | `file:<.tgz 的绝对路径>` |
| 源码 zip（Release 的 Source code） | 解出来是 `dsh-pet-ds-<版本>\` | `file:<解出来那层目录>` |

三种都可以，不用解包 `.tgz` 也行 —— pnpm 会自己解。

### 3. 准备 pnpm

本文命令用 `pnpm`。如果没有，用 **DSH 自带的那份**：

```powershell
# 找它
dir "$env:USERPROFILE\.dsh\dsh-runtimes\*\dependencies\pnpm\bin\pnpm.mjs"

# 之后把下面的 pnpm 换成这两个（用同目录的 node 执行）
#   & "<...>\dependencies\node\bin\node.exe" "<...>\dependencies\pnpm\bin\pnpm.mjs" install
```

### 4. Electron 运行时（桌宠的窗口进程要用）

```bash
node scripts/dev/install-electron.mjs --version 38.2.0
```

> ⚠️ 它必须装在**工作区之外**。本机实测：工作区内的 `electron.exe` 启动即崩
> （`EXCEPTION_BREAKPOINT @ IsLoadBrowserProcessSpecificV8SnapshotEnabled`）。
> 所以**不要** `npm install electron`。装好后落在 `$DSH_HOME\electron\`。

### 5. 动画素材

`.tgz` 与源码归档**都已自带** `assets/animations/`（10 个动作，116 个文件）。
如果你是单独拷源码、没带素材：

```
assets/animations/
  stand/  hang/  eat/  sleep/  awake/  head/  chest/  stomach/  leg/  game-begin/  game-loop/  game-stop/
  每个目录：manifest.json + frame_*.png
```

**没素材时插件能装、能加载，但桌宠起不来**。所以装完若工具可用而桌宠不出现，先查素材。

---

## 三、五步手动安装

设 `$PROFILE_DIR` 为 profile 目录，`$PLUGIN` 为插件来源的**绝对路径**。下文以

```powershell
$PROFILE_DIR = "$env:USERPROFILE\.dsh\profiles\desktop"
$PLUGIN      = "D:\dsh\pet\dist\dsh-pet-ds-<版本>.tgz"     # 换成你的
```

为例。

### 第 1 步：备份 profile 的 `package.json`

```powershell
Copy-Item "$PROFILE_DIR\package.json" "$PROFILE_DIR\package.json.bak-manual" -Force
```

> 这一步别省。改坏了 DSH 会读不了这个 profile，而**症状是 DSH 起不来**，
> 那时你未必想得起是这里改的。

### 第 2 步：改 `package.json` 的两处

用**编辑器**打开 `"$PROFILE_DIR\package.json"`（别用 PowerShell 的
`Set-Content`，理由见第五节的 BOM 问题），加两处：

```jsonc
{
  "name": "dsh-profile-desktop",
  "private": true,

  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-pet-ds"                                  // ← ① 加这一行（就写包名）
      ]
    }
  },

  "dependencies": {
    "dsh-pet-ds": "file:D:/dsh/pet/dist/dsh-pet-ds-<版本>.tgz"   // ← ② 加这一行
  }
}
```

**① 必须是包名**（`dsh-pet-ds`），不是路径 —— `bundles` 里写的是"哪个包"。
**② 必须是绝对路径 + 正斜杠**。

### 第 3 步：跑 `pnpm install`

```powershell
cd $PROFILE_DIR
pnpm install
```

输出里应该能看到：

```
+ dsh-pet-ds <版本>
```

### 第 4 步：验证 DSH 能解析到它

```powershell
node -e "const{createRequire}=require('module');const r=createRequire(process.argv[1]+'/package.json');console.log(r.resolve('dsh-pet-ds'))" $PROFILE_DIR
```

应当打印出插件入口的**绝对路径**（…/dsh-pet-ds/src/host/index.js）。
打印不出来就别往下走 —— 第 5 步必然是坏的。

### 第 5 步：重启 DSH

插件是在 **DSH 启动时**加载的，**必须重启**。

> 例外：如果你用的是官方 `plugin_manager`（`application: applied`），
> 它是热应用的，`live` profile 立即生效。手动改文件走的是启动加载，所以要重启。

---

## 四、装完怎么验证

按顺序看这四件事：

| # | 期望 | 看不到说明 |
|---|---|---|
| 1 | 模型工具里出现 `DSHpet_status` / `DSHpet_balance` / `DSHpet_control` | **插件没加载**（bundles / 解析问题） |
| 2 | 桌面出现透明小窗（蓝发鲸鱼娘） | 插件加载了，但 **Electron / 素材** 有问题 |
| 3 | 窗口下方常驻面板显示 API 余额 | 凭据没配（其它功能正常） |
| 4 | 关掉 DSH，桌宠跟着消失 | `stopOnUnload` 相关，见排障 |

**第 1 条和第 2 条要分开看** —— 这是排障时最省时间的一刀：

```
有工具、没桌宠  →  问题在桌宠进程那侧（Electron、素材）
没工具          →  问题在插件加载那侧（bundles、node_modules、解析）
```

命令行侧也可以直接问桌宠的状态接口：

```powershell
Invoke-WebRequest http://127.0.0.1:47845/state -UseBasicParsing | Select-Object -Expand Content
```

桥接端口由**宿主插件**监听（桌宠没起来它也可能在），所以它能响应只说明**插件加载了**。

---

## 五、五个坑（每个都有确切的报错特征）

### A. 路径必须是绝对路径、且用正斜杠

```
✅ "file:D:/dsh/pet"
❌ "file:../../dsh/pet"     ← 相对路径跨盘会解析失败
❌ "file:D:\\dsh\\pet"      ← 反斜杠在依赖说明符里是转义字符
```

profile 在 `~/.dsh/profiles/<名>/`，而插件常在**另一个盘**，相对路径跨盘算出来
是个不存在的路径 —— 本机实测踩过。

### B. 别引入 BOM

PowerShell 的 `Set-Content -Encoding utf8` 写出的文件**带 UTF-8 BOM**
（`EF BB BF`），而**带 BOM 的 JSON 是非法 JSON** —— DSH 会读不了这个 profile。

BOM 是**不可见**的，所以这个问题很难自己发现。检查：

```powershell
$b = [System.IO.File]::ReadAllBytes("$PROFILE_DIR\package.json")
if ($b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF) { "带 BOM（要清掉）" } else { "没有 BOM ✅" }
```

**最省事的清 BOM 方法**：用安装器改一次（它会主动剥掉 BOM），
或用编辑器另存为 **"UTF-8 无 BOM"**。

### C. 只跑 `pnpm add` 是不够的

```powershell
pnpm add D:\dsh\pet\dist\dsh-pet-ds-<版本>.tgz    # ← 会成功，但装不完整
```

实测它会：把文件装进 `node_modules` ✓、把插件自带依赖也装好 ✓、
从 profile 也能解析到入口 ✓ —— 但**不写 `dsh.profile.bundles`** ✗。
而那是 DSH 认插件的唯一依据，所以 DSH 不会加载它。

`pnpm add` 之后**仍要手工加 `bundles` 那一行**。

### D. 看到 `failed to import` 说明依赖没装到"解析链上"

DSH 插件页会明确报：

```
启用失败：dsh: warning: 1 entry did not activate
         dsh-pet-ds (dsh-pet-ds): failed to import
```

含义是**模块导入阶段就失败**。本插件踩过两次，原因不同：

| 原因 | 现象 | 修法 |
|---|---|---|
| `@deepseek-ai/schemastery` 没声明为依赖 | 导入失败 | 确认 `package.json` 里有它（本包已带） |
| 插件目录**自己没有** `node_modules`，且不在 profile 的解析链上 | 导入失败 | 见下 |

**关于第二条（容易误判）**：ESM 解析裸标识符时，从**引用方文件**所在目录
逐级往上找 `node_modules`。所以：

```
插件在 profile\node_modules\dsh-pet-ds\        → 往上能找到 profile 的 node_modules ✅
插件是"目录联接"指向 D:\dsh\pet\（另一处）      → 往上只有 D:\... 全都没有 ❌
```

**用 `.tgz` / `pnpm add` 装（拷进 profile 的 node_modules）**：不用管这条，
它天然能共用 profile 那份依赖。

**用目录联接装（安装器的 `--link`，为了"改源码立即生效"）**：必须
**在插件仓库里也跑一次 `pnpm install`**：

```powershell
cd D:\dsh\pet
pnpm install
```

### E. 改完文件不重启就以为没生效

宿主侧代码（`src/host/**`）改了要**重启 DSH**；
桌宠侧（`pet-app/**`、`src/shared-core/**`）**只重启桌宠**就够。
手动装完属于前者，所以要重启 DSH。

---

## 六、卸载（手动）

反向做一遍：

1. 从 `dsh.profile.bundles` 里删掉 `"dsh-pet-ds"`；
2. 从 `dependencies` 里删掉 `"dsh-pet-ds"`；
3. 在 profile 目录跑 `pnpm install`（让 pnpm 清理 `node_modules` 与 lock）；
4. **重启 DSH**。

`pnpm install` 会把 `node_modules\dsh-pet-ds` 与 `.pnpm` 里的条目一起清掉。
如果它没清干净，手工删 `node_modules\dsh-pet-ds` 也可以。

桌宠自己的用户数据在 `%APPDATA%\DSH Pet\`（窗口尺寸、置顶）。
要"完全无残留"就把它一起删 —— 但那是**你的偏好设置**，
不是插件文件，删了下次要重调尺寸。

> 更省事的做法是交给官方命令：
> `plugin_manager( action="remove_bundle", target="dsh-pet-ds" )`
> 它会一并关闭桥接端口、收掉桌宠进程、清理 lock 文件。

---

## 七、一张图看懂 DSH 怎么加载这个插件

排障时按这条链逐段查，**任何一段断了都表现为"DSH 里没有插件"**：

```
① profile/package.json
     dsh.profile.bundles 里要有 "dsh-pet-ds"          ← 没写 = 完全看不到
              ↓
② Node 模块解析：在 profile/node_modules 里找到这个包   ← 没 pnpm install = 找不到
              ↓
③ 读该包 package.json 的 dsh.bundle.patch
     = ./cordis.patch.yml                             ← 缺失 = DSH 不认它是 bundle 插件
              ↓
④ 把那一层 patch 叠进配置树（本插件是 insert 一行）
     - insert:
         - id: dsh-pet-ds
           name: 'dsh-pet-ds'
           config: { port: 47845, size: 260, autoStart: true, ... }
              ↓
⑤ DSH 加载这个包的 main（src/host/index.js），调用 apply()
     注册 DSHpet_* 工具、开 47845 桥接、按 autoStart 拉起桌宠
              ↓
⑥ 桌宠进程（独立 Electron 窗口）
     需要：Electron 运行时 + assets/animations/           ← 缺 = 有工具但没桌宠
```

对应到"该查哪一段"：

| 症状 | 断在哪 |
|---|---|
| DSH 插件页里根本列不出 `dsh-pet-ds` | ① 或 ② |
| 插件页报 `failed to import` / `did not activate` | ③ 之后、⑤ 之前（依赖解析、patch 读取） |
| 有 `DSHpet_*` 工具，但桌宠不出现 | ⑥（Electron / 素材） |
| 桌宠出现但余额显示"未配置" | 凭据（`$DSH_HOME\.credentials.yaml`） |

---

## 八、装完的自检清单

```powershell
$PROFILE_DIR = "$env:USERPROFILE\.dsh\profiles\desktop"

# ① bundles 里有吗
Select-String -Path "$PROFILE_DIR\package.json" -Pattern 'dsh-pet-ds'

# ② 解析得到吗（应打印入口绝对路径）
node -e "const{createRequire}=require('module');const r=createRequire(process.argv[1]+'/package.json');console.log(r.resolve('dsh-pet-ds'))" $PROFILE_DIR

# ③ Electron 在吗
dir "$env:USERPROFILE\.dsh\electron"

# ④ 素材在吗（应列出 10 个动作目录）
dir "D:\dsh\pet\assets\animations"

# ⑤ 桥接在监听吗（说明插件加载了）
Test-NetConnection 127.0.0.1 -Port 47845 -InformationLevel Quiet

# ⑥ 桌宠进程在吗
Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
  Where-Object { $_.CommandLine -like '*pet-app*' -and $_.CommandLine -notlike '*--type=*' } |
  Select-Object ProcessId
```

六项全过就该有桌宠了。哪一项不过，按第七节的对应关系查。

---

## 相关文档

| 文档 | 内容 |
|---|---|
| [INSTALL.md](../INSTALL.md) | 完整安装指引（**推荐先看这个**，含官方命令与安装器） |
| [INSTALL-AGENT.md](./INSTALL-AGENT.md) | 给自动化 / agent 用的一条命令版 |
| [README.md](../README.md) | 设计、架构与踩坑记录 |
| [RELEASE.md](./RELEASE.md) | 发布流程 |
