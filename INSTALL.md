# 安装指引

把 **DSH 桌宠**（`dsh-pet-ds`）装进 DeepSeek Harness。

## 先看你手里是什么

| 你拿到的 | 怎么装 |
|---|---|
| 用 **DSH 官方的 `plugin_manager install_bundle`** | 见下 **0**（最省事，`.tgz` 直接装） |
| **一个目录**（源码 / 解包后的目录） | 进去跑 `node install.mjs` —— 见下 A |
| **一个 `.tgz` 安装包** | 也可以**先解包**再跑包里的 `install.mjs` —— 见下 A′ |
| 想自己完全手动（不用任何脚本） | 见 **[INSTALL-MANUAL.md](./INSTALL-MANUAL.md)** |

> 本文件讲"用现成工具装"。**纯手工**那套（改哪两个字段、每步怎么验证、
> 故障出在加载链的哪一段）单独写在 [INSTALL-MANUAL.md](./INSTALL-MANUAL.md)。

## 0-a. 从 GitHub 安装（推荐：只下一个包，不克隆仓库）

把下面这条 URL 交给 `install_bundle`：

```
install_bundle  target = https://github.com/liuguanyu9719-source/dsh-pet-ds/releases/latest/download/dsh-pet-ds.tgz
```

- 它下的是**一个 tarball**（约 33 MB），不是 git clone —— 本仓库历史约 300 MB，用 git 地址会全拉下来；
- `releases/latest/download/...` 永远指向**最新一版**：发布时把 `dist/release/dsh-pet-ds.tgz` 以**同名**上传即可；
- 想锁死版本：`https://github.com/liuguanyu9719-source/dsh-pet-ds/archive/refs/tags/v0.2.1.tar.gz`（tag 快照，同样是单包下载）。

### 关于 git 地址（能装，但最慢）

`https://github.com/liuguanyu9719-source/dsh-pet-ds` 这种**仓库地址**会被当 git 依赖安装，
它有两个额外代价：

1. **多一步连通性预检**：DSH 会先跑 `git ls-remote`，默认只等 **5 秒**。
   国内直连 GitHub 常要 20 秒以上，于是报"连接 github 超时"。两条解法：
   `git config --global http.proxy http://127.0.0.1:7897`（换成你的代理端口），
   或把 `githubConnectionTimeoutMs` 调大（profile 的 `cordis.patch.yml`，entry id 是 `plugin-manager`）。
2. **要下载整份仓库**：本仓库历史已瘦身（296 MB → 37 MB），但仍是 tarball 的 5 倍左右。

> 结论：能装（瘦身后实测浅克隆 7.6 秒），但对外分发仍建议用 Release 附件或 tag 快照。

> npm 包名 `dsh-pet-ds` 已预留但**尚未发布**（npm 账号注册被 Cloudflare 挡），
> 发布后这里会多一条：`dsh plugin --profile <profile> add dsh-pet-ds@0.2.1`。

## 0-b. 用 DSH 官方的 `plugin_manager install_bundle`

**直接把这个 `.tgz` 的绝对路径交给它**就行，不用解包：

```
install_bundle  target = D:\dsh\pet\dist\dsh-pet-ds-<版本>.tgz
```

它会自己在 profile 目录里跑 `pnpm add <这个路径>`，然后读本包的
`dsh.bundle` 与 `cordis.patch.yml`、把插件挂进配置树并启用。

### 支持的 spec 形式

`install_bundle` 的 `target` 接受这几种（这是 DSH 内部 `parseInstallSpec`
的判据，`scripts/dev/test-install-bundle-spec.mjs` 直接调它验证过）：

| 你写的 | 判为 | 说明 |
|---|---|---|
| `D:\…\dsh-pet-ds-<版本>.tgz` | tarball | ✅ 本地 `.tgz` 的**绝对路径** |
| `file:D:\…\dsh-pet-ds-<版本>.tgz` | tarball | 等价写法 |
| `D:\…\dsh\pet` | path | 本地**目录**的绝对路径 |
| `dsh-pet-ds` | registry | 发布到 npm 之后的包名 |
| `dsh-pet-ds@<版本>` | registry | 带版本范围 |
| `github:someone/repo` | git | git 简写 / `git+https://…` / `https://host/a/b` |
| `https://…/x.tgz` | tarball | 远端 tarball |

> ### ⚠️ 路径**必须绝对**
>
> 写成相对的会被拒。而且**报错措辞会骗人**（实测）：
>
> | 你写的 | 报错 |
> |---|---|
> | `./dist/x.tgz` | `a local path must be absolute` |
> | `dist/x.tgz` | `not a package name the registry accepts` ← **看不出是路径问题** |
>
> 后一种容易让人以为"包名写错了"，其实只是**少写了盘符/根**。
>
> 原因在 DSH 源码注释里：浏览器的当前工作目录对用户没有意义，
> 而按 profile 解析相对路径会指到 profile 里面去。

### 装完还要做什么

`install_bundle` 会**启用**这个 bundle 并 `reload()`。如果本插件此前
**已经**在 profile 的 `dependencies` 里（例如你之前用安装器装过），
`installBundle` 会返回 **`restart-required`** —— 那就**重启 DSH**。

另外它只负责"让 DSH 认得并加载这个插件"，**插件自己的依赖**要能被解析到，
否则加载时报 `failed to import`。本包的 `.tgz` 里已经带了正确的
`package.json`，pnpm 会把插件自带依赖一并装好（`verify-install-bundle.mjs` 验证过）。

> 想先自证"这个包能被 install_bundle 装"，不必真的装：
> ```bash
> node scripts/dev/verify-install-bundle.mjs
> ```
> 它会在**临时 profile** 上把 `installBundle` 的每一步真跑一遍
> （pnpm add → 取包名 → 查 `dsh.bundle` → 读 patch → 查自带依赖），
> 不动你的正式环境。

---

> ### ⚠️ 单独用 `pnpm add <tgz>` 是**装不完整**的（实测）
>
> `pnpm add dsh-pet-ds-<版本>.tgz` 会**成功**，而且看起来什么都做了：
> 插件文件装进 profile ✓、插件自带依赖装好 ✓、从 profile 能解析到入口 ✓。
>
> 但它**不会**把插件登记进 `dsh.profile.bundles` ——
> **而那是 DSH 认插件的唯一依据**。少了这一步，DSH 根本不会加载它，
> 表现是"装完了，但插件页里没有这个插件"。
>
> 登记 `bundles` 正是 `install.mjs` 第 3 步做的事。所以：**别只用 `pnpm add`**。

---

### 三种形态速查

上面 **0** 适合什么，以及"只有目录"和"只有 `.tgz`"该走哪条：

| 你拿到 | 用哪个 | 关键差别 |
|---|---|---|
| `.tgz` 安装包 | **0**（官方命令） | 一条命令，热生效，不用重启 |
| 一个**目录**（源码 / 解包后） | **A** | 跑目录里的 `install.mjs` |
| 只有 `.tgz`，但不想用官方命令 | **A′** | 先解包，再跑包里那个 `install.mjs` |

> **A′ 为什么要解包**：`install.mjs` 要读目录里的 `cordis.patch.yml` /
> `src/host/index.js` 做验证，没解包就没得读。但它**已经打进 `.tgz` 里**了，
> 所以解包后直接跑包内那份即可，能力与 A 完全一样。

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

**`.tgz` 与源码归档都已自带** `assets/animations/` —— 10 个动作、116 个文件（约 112 MB）。
所以正常安装**不需要**做任何事。

如果你是**单独拷源码**、没带素材，那么需要把它们放到 `assets/animations/` 下，
每个动作一个子目录：

```
assets/animations/
  stand/      manifest.json + frame_*.png
  hang/       ...
  eat/        ...
  sleep/      ...
  awake/      ...
  head/  chest/  stomach/  leg/
  game-begin/  game-loop/  game-stop/
```

没有素材时**插件能装、能加载，但桌宠起不来**。安装器会在第 1 步就检查并告诉你。

> 素材**已经提交进版本库**（这一点是刻意的）：否则从 GitHub 的
> Source code 归档安装时会缺素材 —— 表现为"插件能激活、但桌宠不出现"。
> 参考项目 `Yoshino-JF/dsh-deepseek-pet` 的 v0.2.4 就是栽在这上面。
> 素材的授权单独写在 [LICENSE-ART.md](./LICENSE-ART.md)（代码是 MIT，素材不是）。

---

## A. 用安装器（推荐）

**有目录**（源码仓库、或解包后的目录）时，在**那个目录**（含 `package.json` 的那层）执行：

```bash
node install.mjs            # agent 入口：装 + 验，退出码 0 = 成功
node scripts/install.mjs    # 给人看的详细版：五步 + 解释
```

两个都是同一个安装流程，区别只在输出详略与退出码语义：

| 脚本 | 输出 | 适合 |
|---|---|---|
| `install.mjs` | 简洁 + 一行 JSON（`--json`） | 自动化 / agent |
| `scripts/install.mjs` | 五步、彩色、解释、失败给手动命令 | 人看 |

### A′. 只有 `.tgz`、又不想用官方命令

先解包，再跑**包内**那份 `install.mjs` —— 它已经打进包里了：

```bash
# 1) 解包（解出 package/ 目录；package/ 就是 npm tarball 规范的前缀）
tar -xzf dsh-pet-ds-<版本>.tgz

# 2) 跑包内的 agent 入口
node package/install.mjs
```

> **为什么必须解包**：`install.mjs` 要读目录里的 `cordis.patch.yml` /
> `src/host/index.js` 做验证，没解包没得读。
> 解包后跑的那份与 A 里的是**同一个脚本**，能力完全一样。
> 想先看它会改什么：`node package/install.mjs --dry-run`

### 它做了什么

```
[1/5] 检查插件本体      —— 入口、素材、cordis.patch.yml 是否齐
[2/5] 定位 DSH 与 profile
[3/5] 把插件登记进 profile   ← 改两个字段，首次改动前自动备份
[4/5] 把依赖装进 node_modules  ← 跑 pnpm install（profile 与插件目录各一次）
[5/5] 验证 DSH 能解析到插件，并检查插件自己的裸标识符依赖
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

**不想用任何脚本、每一步都自己来** —— 完整过程在单独的手动安装文档里：

→ **[INSTALL-MANUAL.md](./INSTALL-MANUAL.md)**

手动安装本质上只有**两处改动 + 一条命令**：

1. profile 的 `package.json` → `dsh.profile.bundles` 里加 `dsh-pet-ds`；
2. 同一文件的 `dependencies` 里加 `"dsh-pet-ds": "file:<插件绝对路径>"`；
3. 在 profile 目录跑 `pnpm install`，然后重启 DSH。

那份文档把每一步写成可复制的命令、**每步后面附验证命令**，并额外给出：

- DSH 的完整加载链路图（用来判断故障出在**哪一段**）；
- 五个常见坑的**确切报错特征**（含 `failed to import` 的两种成因）；
- 一份六项自检清单。

> 本文下面不再重复这套步骤 —— 两份都写会各自漂移，很快就对不上。

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

这条靠配置项 **`stopOnUnload`（默认 `true`）**：DSH 卸载插件时会把桌宠一起收掉。

它依赖 DSH **优雅退出**（走 `fiber.dispose()`）。**若 DSH 被强杀**
（任务管理器结束进程、崩溃），清理器不会跑，桌宠会留下。

这是有意的取舍 —— 因为"桌宠在 DSH 没开时也能显示余额"是明确要求过的
（余额由桌宠自取），两者不可兼得。残留的桌宠可以右键退出，或杀掉
`electron.exe`。

> `stopOnUnload` 可以在 DSH 的**设置页 → 桌宠 → 启动**里改，不用手改 YAML。

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

### 推荐：用官方命令

```
plugin_manager( action="remove_bundle", target="dsh-pet-ds" )
```

实测它一步全清（这是我们验过的）：

| 它做的事 | 结果 |
|---|---|
| 从 `bundles` 与 `dependencies` 移除 | ✓ |
| 清 `node_modules` 与 `.pnpm` 条目 | 0 残留 |
| 清 `pnpm-lock.yaml` 里的引用 | ✓ |
| 关闭桥接端口 | ✓ |
| **收掉桌宠进程**（走 `stopOnUnload`） | ✓ |
| 生效 | `application: applied`，**不用重启** |

### 或者用安装器

```bash
node scripts/install.mjs --uninstall
```

它会把 `dsh-pet-ds` 从 `bundles` 和 `dependencies` 里移除（**不会**动别的插件）。
但它**不**清 `node_modules` 与 lock 文件 —— 之后自己跑一次
`pnpm install`（在 profile 目录）让 pnpm 清理，然后**重启 DSH**。

### 想完全无残留

桌宠自己的用户数据在 `%APPDATA%\DSH Pet\`（窗口尺寸、置顶）。
那是**你的偏好设置**、不是插件文件；要清就手动删，删了下次要重调尺寸。
（注：它会在下次启动桌宠时重建。）

> 手动装的怎么卸？反向做一遍即可 —— 见
> [INSTALL-MANUAL.md 第六节](./INSTALL-MANUAL.md)。

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
