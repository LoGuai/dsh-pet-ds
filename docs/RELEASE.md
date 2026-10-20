# 发布流程

本仓库的发布格式**对照可用的第三方 DSH 插件**（[Yoshino-JF/dsh-deepseek-pet](https://github.com/Yoshino-JF/dsh-deepseek-pet)）：
它的每个 release **不挂任何附件**（`assets: []`），发布的就是 GitHub 自动生成的
**Source code 归档**（`Source code (zip)` / `(tar.gz)`）。

所以"发布"在本仓库的含义是：**打一个 tag，并保证源码归档自足**。

> 这一点很要紧。参考项目的 v0.2.4 发布说明里记着一条教训：
> 桌宠本体曾被 `.gitignore` 排除，于是 `github:` 安装缺了它 ——
> 插件能激活、健康检查回 200，但**桌宠不会出现**。
> **仓库里必须包含运行所需的一切。**

## 一、发布前检查

```bash
npm test                       # 17 组单测 / 183 条断言（含更新日志检查）
node scripts/dev/build-package.mjs   # 安装包 + 内容校验
```

再确认这几个**容易被 .gitignore 吃掉**的东西在版本库里：

| 项 | 为什么必须进仓库 |
|---|---|
| `assets/animations/**` | 桌宠的画面。缺了仓库 → 装了也没画面（112 MB，是本仓库的主体） |
| `pet-app/**` | 桌宠窗口进程。缺了 → 插件能加载但窗口起不来 |
| `client/client.js` | 设置页那一栏。缺了 → 那一栏静默不出现 |
| `cordis.patch.yml` | DSH 靠它把插件挂进配置树。缺了 → 装了 DSH 也不认 |
| `package.json` 的 `dependencies` | 尤其 `@deepseek-ai/schemastery`，缺了插件**完全不加载** |

```bash
git ls-files assets/animations | wc -l    # 应为 116
git status --porcelain --untracked-files=all   # 应为空
```

## 二、改版本号（三处必须一致）

| 文件 | 字段 |
|---|---|
| `package.json` | `version` |
| `pet-app/package.json` | `version` |
| `src/host/index.js` | `const VERSION = '...'` |

`scripts/dev/test-manifest-deps.mjs` 会断言三者一致 ——
漂移了会出现"界面显示 0.1.0、包却是 0.1.2"这种对不上号的怪事。

## 三、更新 `CHANGELOG.md`（**每次改动都要做**）

> **用户指定（2026-10-16）：**
>
> 1. **每次改动就实时记进「[未发布]」段** —— 不攒到最后。
> 2. **版本号只在用户明确要求时才改** —— 不擅自升版本号。
> 3. **不主动输出安装包** —— 只在用户要求时才构建/打包。

也就是说：**平时只记日志，不改版本号、不出包。**
「[未发布]」段有内容**是正常状态**，不是"忘了归档"。

用户说"保存新版本"时，才做这几件事：

1. 三处版本号一起改（见下一节）；
2. 把「[未发布]」的内容移进 `## [x.y.z] - 日期` 段；
3. 写 `RELEASE-NOTES-v<版本>.md`；
4. 打标签、构建产物。

`CHANGELOG.md` 的格式参照
[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，分「新增 / 变更 / 修复」。

### 自动检查

```bash
npm run test:changelog         # 单独跑
npm test                       # 已包含它（放在最前）
```

它只断言一件事：**版本号变了就必须有对应的版本段**。

刻意**没有**"「未发布」必须为空"这条 —— 我第一版写了它（照 Keep a Changelog
的发布流程想当然），与上面的约定正好相反，已改掉。现在它只把「未发布」的
行数作为 INFO 打印出来，便于扫一眼。

检查本身带**金丝雀**（`test-changelog-canary.mjs`）：故意把版本号改成日志里
没有的值、再故意把版本段清空，断言检查**确实失败** ——
否则一个"永远通过"的检查比没有检查更糟。

### 与 `RELEASE-NOTES` 的分工

| 文件 | 作用 | 何时写 |
|---|---|---|
| `CHANGELOG.md` | 更新日志：一次看遍所有改动 | **每次改动**（记进「未发布」） |
| `RELEASE-NOTES-v<版本>.md` | 该版本的设计取舍、验证过程、踩过的坑 | **发布时** |

## 四、写发布说明

参照参考项目的做法：每个版本一份 `RELEASE-NOTES-v<版本>.md`
（仓库里能看到 `RELEASE-NOTES-v0.2.12/13/14.md`），内容包含：
新增 / 变更 / 修复 / 安装方式 / 验证。

这份内容同时贴进 GitHub Release 的正文。

## 五、提交、打标签、推送

```bash
git add -A
git commit -m "v<版本>：<一句话>"
git tag -a v<版本> -m "v<版本> <一句话>"
git push origin main
git push origin v<版本>
```

> **本仓库目前没有配置远程**，所以 `git push` 那两行是留给将来的。
> 本地是唯一副本 —— 重要节点应当另存一份 `git bundle` 备份。

## 六、生成可直接上传的源码归档（可选）

GitHub 会在打 tag 后**自动**给出 `Source code (zip)`，正常情况下不需要自己传。
但如果你想先本地核对归档内容（或需要在没有 GitHub 的环境里分发），
`build-package.mjs` 会顺手生成一份**格式一致**的：

```bash
node scripts/dev/build-package.mjs
```

产物：`dist/dsh-pet-ds-<版本>-source.zip`（两个产物总是一起生成）

它是用 `git archive` 从 tag 导出的，所以：

- **只含版本库里的文件** —— 与 GitHub 的 `Source code` 归档逐项相同；
- **不含**未跟踪/被忽略的东西（`node_modules`、`.cache`、`dist`、`_research`）；
- 顶层是一个同名目录，解压出来就是一个可安装的包目录。

### 为什么这个 zip 是"自足"的

它不含 `node_modules`，但**含运行所需的一切源码与素材**，
且 `install.mjs` 会自己把依赖装到两个位置（profile + 插件目录）。
所以从它出发执行：

```bash
cd dsh-pet-ds-<版本>
node install.mjs
```

就能装好。**这正是参考项目"源码归档必须自足"那条教训的含义。**

## 七、GitHub Release 怎么填

| 字段 | 填什么 |
|---|---|
| Tag | `v<版本>`（已推上去的那个） |
| Release title | `v<版本> — <一句话>` |
| 正文 | `RELEASE-NOTES-v<版本>.md` 的内容 |
| 附件 | **不需要**（与参考项目一致，用自动生成的 Source code 归档） |

## 附：两种产物别混用

| 产物 | 生成方式 | 用途 | 大小 |
|---|---|---|---|
| `dist/dsh-pet-ds-<版本>.tgz` | `pnpm pack`（按 `files` 字段） | 解包后跑 `install.mjs`（**不能只用 `pnpm add`**，见下） | 约 112 MB |
| `dist/dsh-pet-ds-<版本>-source.zip` | `git archive`（按版本库） | 上传为 Source code / 手动安装 | 约 112 MB |

两者内容大体相同，但**选取规则不同**：
`.tgz` 按 `package.json` 的 `files` 白名单，`.zip` 按 git 版本库。
改 `files` 字段时记得两边都验一遍。

### ⚠️ `.tgz` 的安装方式（实测）

`pnpm add <tgz>` 会**成功**，而且看起来什么都做了：文件装进 profile、
插件自带依赖装好、从 profile 能解析到入口。

**但它不登记 `dsh.profile.bundles`** —— 而那是 DSH 认插件的唯一依据。
少了这一步，DSH 不加载插件（表现："装完了但插件页里没有"）。

正确用法是把 `install.mjs` 打进包（`files` 里有 `install.mjs`），
使用者解包后跑它：

```bash
tar -xzf dsh-pet-ds-<版本>.tgz
node package/install.mjs
```

所以 `files` 里**必须**保留 `install.mjs` 与 `scripts/install.mjs` ——
`build-package.mjs` 有断言守着这两条。

