/**
 * 端到端验证：**安装器里那步 `pnpm install` 真的成功了吗**。
 *
 * ## 为什么单独测这件事
 *
 * `test-setup-install.mjs` 的断言里没有一条直接盯着 pnpm 的成败 ——
 * 它能"整体通过"而 pnpm 那步其实失败了（因为插件**自带依赖树**，
 * 即使 pnpm 没跑，插件自身也能工作）。
 *
 * 但 pnpm 那步**对"DSH 认插件"是必要的**：DSH 从 profile 的 `node_modules`
 * 解析插件。所以这里单独把它抠出来看。
 *
 * ## 踩过的三个坑（都在这里被挡住）
 *
 * 1. **工作区向上查找**：profile 若在某个 pnpm 工作区内部，pnpm 会把安装
 *    归到工作区根去做，`profile/node_modules` 里什么都没有 ——
 *    报 `No projects found in "<某目录>"`。修法：安装器加 `--ignore-workspace`。
 *    我一度想在沙箱里放 `pnpm-workspace.yaml`（`packages: []`）截断查找，
 *    结果更糟：那个标记把 profile 也排除在外了，pnpm 什么都不装。
 * 2. **NO_TTY**：插件自带 node_modules，pnpm 重建前要问"是否清空"，
 *    非交互环境里直接放弃：`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`。
 *    修法：安装器加 `--config.confirmModulesPurge=false`。
 * 3. **GUI 子系统程序的调用方式**：见 setup-runner.mjs。
 *
 * 用法：node scripts/dev/test-setup-pnpm.mjs
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runSetup } from './setup-runner.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')

/*
 * 用**非提权版**：正式版带 `requireAdministrator`，Windows 会在加载 exe
 * 之前就弹 UAC，自动化测试跑几次就弹几次。非提权版安装逻辑完全相同。
 * 生成：`$env:DSH_PET_SETUP_NO_ELEVATE=1; node scripts/dev/build-installer.mjs`
 */
const SETUP = join(ROOT, 'dist', 'setup-noelevate.exe')

/*
 * 沙箱放在仓库内的 `.cache` 下（写到仓库外会被文件沙箱拒）。
 * 工作区向上查找的问题已由安装器的 `--ignore-workspace` 解决，
 * 所以这里**不需要**放工作区边界文件。
 */
const sandbox = join(ROOT, '.cache', 'setup-pnpm-check')
const home = join(sandbox, 'home')
const profileDir = join(home, 'profiles', 'desktop')
const installBase = join(sandbox, 'install')

const log = (m) => console.log(m)
let failed = 0
const check = (name, ok, detail) => {
  log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed += 1
}

// ---------------------------------------------------------------- 造临时环境
rmSync(sandbox, { recursive: true, force: true })
mkdirSync(profileDir, { recursive: true })
writeFileSync(
  join(profileDir, 'package.json'),
  `{\n  "name": "dsh-profile-desktop",\n  "private": true,\n  "dsh": {\n    "profile": {\n      "bundles": [\n        "@deepseek-ai/dsh-base"\n      ]\n    }\n  },\n  "dependencies": {}\n}\n`,
  'utf8',
)

/* 联接真实 dsh-runtimes，让安装器找得到 pnpm。 */
const realRuntimes = join(process.env.USERPROFILE ?? '', '.dsh', 'dsh-runtimes')
if (existsSync(realRuntimes)) {
  execFileSync('cmd', ['/c', 'mklink', '/J', join(home, 'dsh-runtimes'), realRuntimes], { stdio: 'ignore' })
  log('已联接 dsh-runtimes')
} else {
  log('⚠ 找不到真实 dsh-runtimes —— pnpm 那步会跳过，本测试无意义')
}

/*
 * 预置一个"已装好"的 Electron，让安装器的第 6 步直接跳过。
 *
 * 两个理由：
 *  1. 不预置就要**下载约 100 MB**，每次跑测试都下、既慢又依赖网络；
 *  2. 沙箱在仓库内（.cache），而 Electron 放在工作区内启动会直接崩
 *     （EXCEPTION_BREAKPOINT —— 仓库里 install-electron.mjs 有详细记录），
 *     于是校验必然失败，日志里会多出一段与本测试无关的噪音。
 *
 * 本测试要验的是"pnpm 能否把包装进 profile"，Electron 那一步有单独的验证。
 */
const seededElectron = join(home, 'electron', 'electron-v38.2.0-win32-x64')
mkdirSync(seededElectron, { recursive: true })
writeFileSync(join(seededElectron, 'electron.exe'), 'stub', 'utf8')

// ---------------------------------------------------------------- 跑安装
log('')
log('运行 setup.exe --silent …')
const { output: out, waitedMs } = await runSetup({
  setup: SETUP,
  /*
   * `--elevated` 必须加，且要放在**最后**。
   *
   * 安装器在没提权的进程里会走 TryElevate：用 runas 重新拉起自己然后退出，
   * 于是本次调用立刻返回、什么都没装 —— 表现为"输出为空、断言全红"。
   * 那个重启会把 `--elevated` 追加在参数末尾，所以这里手工加在末尾即可绕过，
   * 让非提权版 exe 直接在本进程里跑完（安装逻辑完全相同）。
   */
  args: ['--silent', installBase, '--elevated'],
  env: { DSH_HOME: home, DSH_PROFILE: 'desktop' },
  workDir: sandbox,
  timeoutMs: 600000,
})
log(`  等待 ${(waitedMs / 1000).toFixed(1)} 秒`)

/*
 * 把安装器输出打出来。
 *
 * 加这一步是因为第一版**漏看了关键信息**：那时只看几条断言，
 * 结果"pnpm 那步没跑"和"跑了但失败"长得一模一样 ——
 * `No projects found` 这种明确线索就这样被漏掉了。
 */
log('')
log('安装器输出：')
for (const line of String(out).split(/\r?\n/)) {
  if (line.trim()) log('    ' + line.trimEnd())
}

// ---------------------------------------------------------------- 断言
log('')
log('核对 pnpm 那一步的结果：')

/* 最硬的判据：profile 的 node_modules 里真的出现了这个包。 */
const linked = join(profileDir, 'node_modules', 'dsh-pet-ds')
check('profile/node_modules 里有 dsh-pet-ds', existsSync(linked), linked)

/* 再确认它能被解析 —— 这才是 DSH 加载时会做的事。 */
let resolved = ''
try {
  resolved = execFileSync(
    process.execPath,
    [
      '-e',
      "const{createRequire}=require('module');const r=createRequire(process.argv[1]+'/package.json');process.stdout.write(r.resolve('dsh-pet-ds'))",
      profileDir,
    ],
    { encoding: 'utf8' },
  ).trim()
} catch (err) {
  resolved = '解析失败：' + (err instanceof Error ? err.message.split('\n')[0] : String(err))
}
check('从 profile 能解析到插件', /index\.js$/.test(resolved), resolved)

/* 两个已修的 pnpm 报错不该再出现。 */
check('没有 NO_TTY / ABORTED_REMOVE 错误', !/NO_TTY|ABORTED_REMOVE/.test(out))
check('没有 "No projects found"（工作区向上查找已挡住）', !/No projects found/i.test(out))

/* 确认 pnpm 确实跑过（而不是"跳过也算成功"）。 */
check('输出里有 pnpm 的痕迹', /Progress:|Done in|Lockfile|Already up to date/.test(out))

log('')
log(`结果：${failed === 0 ? 'pnpm 步骤成功 —— DSH 会认得这个插件' : `${String(failed)} 项未通过`}`)

// ---------------------------------------------------------------- 清理
/* 先摘联接再删：递归删除可能顺着联接删到真实文件。 */
const detach = (dir) => {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const p = join(dir, e.name)
    try {
      // 联接：rmdir 只删链接本身；真实目录（非空）会失败 → 递归进去
      execFileSync('cmd', ['/c', 'rmdir', p], { stdio: 'ignore' })
    } catch {
      detach(p)
    }
  }
}
detach(sandbox)
rmSync(sandbox, { recursive: true, force: true })
log(`（临时环境已清理：${String(!existsSync(sandbox))}）`)

process.exitCode = failed === 0 ? 0 : 1
