/**
 * 端到端验证 `setup.exe --silent`：真跑一遍完整安装流程。
 *
 * ## 在**临时 DSH_HOME** 上做
 *
 * 安装程序会真的改 profile 的 package.json、并且跑 pnpm install。
 * 拿正式环境试会把用户装好的配置改掉，所以这里造一个临时 DSH_HOME：
 *
 *   <tmp>/home/
 *     profiles/desktop/package.json   ← 只有 base 的最小 profile
 *     dsh-runtimes/  → 联接指向真实的（这样 pnpm 找得到）
 *
 * 指向真实运行时的用的是**目录联接**，跑完必须先摘掉再删，
 * 否则 `Remove-Item -Recurse` 有顺着联接删到真实文件的风险。
 *
 * ## 断言什么
 *
 * 不只是"退出码 0"—— 还要证明**配置真的改对了**：
 *   · bundles 里出现了插件名；
 *   · dependencies 指向安装目录；
 *   · 改之前生成了备份；
 *   · 原文件格式（缩进/键序）没被冲掉 —— 这是 ProfileConfig 的设计目标。
 *
 * 用法：node scripts/dev/test-setup-install.mjs
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')

/*
 * 用**非提权版**跑自动化测试。
 *
 * 正式版 `setup.exe` 带 `requireAdministrator` 清单，Windows 会在**加载 exe
 * 之前**就弹 UAC —— 自动化测试跑几次就弹几次，不可接受。
 * `setup-noelevate.exe` 的安装逻辑与正式版完全相同，只是不求提权。
 *
 * 生成测试版：`$env:DSH_PET_SETUP_NO_ELEVATE=1; node scripts/dev/build-installer.mjs`
 */
const SETUP = join(ROOT, 'dist', 'setup-noelevate.exe')

const log = (m) => console.log(m)
let failed = 0
const check = (name, ok, detail) => {
  log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed += 1
}

if (!existsSync(SETUP)) {
  log(`✗ 找不到 ${SETUP}`)
  log('  先跑：node scripts/dev/build-installer.mjs')
  process.exit(1)
}

/*
 * ⚠️ 临时环境放在仓库内的 `.cache` 下 —— 这是**被迫**的：
 * 写到仓库外（如 `D:\dsh-pet-test`）会被文件沙箱拒（实测
 * `对路径 ... 的访问被拒绝`），那是沙箱边界，会掩盖真实问题。
 *
 * 放在仓库内会引出**另一个**坑：仓库根有 `pnpm-workspace.yaml`，
 * pnpm 会**向上寻找工作区根**，于是安装器里那步 `pnpm install` 跑去装
 * 仓库自己的依赖（含 112 MB 的 Electron）→ 超时。
 *
 * 那个坑已经由**安装器自己**用 `--ignore-workspace` 修掉了（见 Setup.cs），
 * 所以这里**不需要**再放工作区边界文件。
 *
 * ⚠️ 我一度在这里放过 `pnpm-workspace.yaml`（`packages: []`）想截断查找，
 * 结果更糟：pnpm 报 `No projects found in "<沙箱根>"` —— 那个标记把
 * profile 目录**也排除在工作区之外**了，于是它什么都不装。
 */
const sandbox = process.argv[2] ? resolve(process.argv[2]) : join(ROOT, '.cache', 'setup-e2e')
const home = join(sandbox, 'home')
const profileDir = join(home, 'profiles', 'desktop')
const installBase = join(sandbox, 'install')
const pluginDir = join(installBase, 'dsh-pet-ds')

log(`临时 DSH_HOME：${home}`)
log(`安装目录：${installBase}`)

// ---------------------------------------------------------------- 造临时环境
/*
 * 先摘掉上次可能残留的联接（顺序很重要：先摘再删，
 * 否则递归删除可能顺着联接删到真实目录）。
 */
/**
 * 摘除目录联接。
 *
 * ⚠️ 不用 `dir /AL` 去判断（第一版那样做，输出里刷了一堆 "File Not Found" ——
 * 目录没有链接时那条命令会报错，既吵又脆）。可靠的做法是直接 `rmdir`：
 *   · 对**目录联接**：`rmdir` 只移除链接本身，不动目标内容；
 *   · 对**真实目录**：`rmdir` 会失败（非空），正是我们想要的"跳过"。
 * 这样不需要任何检测，语义也更直白。
 */
function detachJunctions(root) {
  if (!existsSync(root)) return 0
  let n = 0
  const walk = (dir) => {
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
        // 先试摘联接：是联接就成功且只删链接
        execFileSync('cmd', ['/c', 'rmdir', p], { stdio: 'ignore' })
        n += 1
      } catch {
        // 不是联接（真实目录，非空）→ 递归进去
        walk(p)
      }
    }
  }
  walk(root)
  return n
}

rmSync(sandbox, { recursive: true, force: true })
mkdirSync(profileDir, { recursive: true })


/*
 * 最小 profile。刻意保留特定缩进与键序 —— 下面要断言
 * 安装程序**没有**把原格式冲掉。
 */
const minimalProfile = `{
  "name": "dsh-profile-desktop",
  "private": true,
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app"
      ]
    }
  },
  "dependencies": {
    "@ggboy123/dsh-paper-reader": "1.2.0"
  }
}
`
writeFileSync(join(profileDir, 'package.json'), minimalProfile, 'utf8')

/* 用联接指向真实 dsh-runtimes，让安装程序能找 pnpm。 */
const realHome = process.env.USERPROFILE ? join(process.env.USERPROFILE, '.dsh') : null
const realRuntimes = realHome ? join(realHome, 'dsh-runtimes') : null
if (realRuntimes && existsSync(realRuntimes)) {
  execFileSync('cmd', ['/c', 'mklink', '/J', join(home, 'dsh-runtimes'), realRuntimes], { stdio: 'ignore' })
  log('  已联接 dsh-runtimes（让安装程序找得到 pnpm）')
} else {
  log('  ⚠ 找不到真实的 dsh-runtimes；pnpm 步骤会被跳过（其余仍可验证）')
}

// ---------------------------------------------------------------- 跑静默安装
/*
 * ⚠️ 调用方式很要紧（这几轮踩了不少）：
 *
 *   · `& setup.exe ...` 在 PowerShell 里**立即返回**（它是 GUI 子系统程序），
 *     所以不能靠它的返回来判断"跑完了"；
 *   · `Start-Process -Wait` 在本机实测**没能启动它**（进程都不出现）——
 *     原因未查明，可能是 -ArgumentList 的引号处理；
 *   · 可靠的做法：直接 `&` 启动，然后**轮询等它自己消失**，
 *     再以产物（文件系统）为判据，而不是它的退出码。
 */
log('')
log('运行 setup.exe --silent（GUI 子系统：启动后轮询等它结束）…')
const started = Date.now()
const runner = join(sandbox, 'run-install.ps1')
writeFileSync(
  runner,
  [
    `$env:DSH_HOME = '${home}'`,
    `$env:DSH_PROFILE = 'desktop'`,
    `& '${SETUP}' --silent '${installBase}'`,
    `Write-Output ('CHILD_EXIT=' + $LASTEXITCODE)`,
  ].join('\r\n'),
  'utf8',
)

let runOut = ''
try {
  runOut = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', runner], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 600000,
  })
  if (runOut.trim()) log(runOut.trim().split(/\r?\n/).map((l) => '    ' + l).join('\n'))
} catch (err) {
  log('  ⚠ 调用返回非零/超时：' + (err instanceof Error ? err.message.split('\n')[0] : String(err)))
}

/*
 * 等 setup 进程真正消失（它可能被 PowerShell 提前放走了）。
 * 最多等 8 分钟 —— 解压 1.3k 文件 + pnpm install 需要时间。
 */
log('  等待 setup.exe 结束…')
let waited = 0
while (waited < 480000) {
  let running = 0
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-Command', '(Get-Process -Name setup -ErrorAction SilentlyContinue | Measure-Object).Count'],
      { encoding: 'utf8' },
    )
    running = Number(String(out).trim()) || 0
  } catch {
    running = 0
  }
  if (running === 0) break
  await new Promise((r) => setTimeout(r, 2000))
  waited += 2000
}
log(`  结束（等待 ${(waited / 1000).toFixed(0)} 秒，总耗时 ${((Date.now() - started) / 1000).toFixed(1)} 秒）`)

// ---------------------------------------------------------------- 断言
log('')
log('核对安装结果：')

/* 1) 插件本体解到位 */
check('插件目录已创建', existsSync(pluginDir), pluginDir)
check('插件入口存在', existsSync(join(pluginDir, 'src', 'host', 'index.js')))
check('自带依赖树存在', existsSync(join(pluginDir, 'node_modules')))
check(
  'schemastery 在 node_modules 顶层（zip 往返未丢链接）',
  existsSync(join(pluginDir, 'node_modules', '@deepseek-ai', 'schemastery', 'package.json')),
)

/* 2) profile 配置改对了 */
const profileJson = join(profileDir, 'package.json')
const after = readFileSync(profileJson, 'utf8')

check('bundles 里加入了插件', /"dsh-pet-ds"/.test(after))
check('dependencies 指向安装目录', after.includes(`file:${installBase.replace(/\\/g, '/')}/dsh-pet-ds`))

/* 3) 原有内容与格式没被破坏 —— ProfileConfig 的设计目标 */
check('原有依赖仍在', after.includes('@ggboy123/dsh-paper-reader'))
check('原有 bundles 仍在', after.includes('@deepseek-ai/dsh-base') && after.includes('@deepseek-ai/dsh-web-app'))
check('缩进风格保持 2 空格（没被重新序列化）', /^  "name":/m.test(after))
check('键序保持（name 在最前）', after.trimStart().startsWith('{') && after.indexOf('"name"') < after.indexOf('"dsh"'))

/* 4) 备份生成了 */
const backup = profileJson + '.bak-before-dsh-pet-ds'
check('改前生成了备份', existsSync(backup))
if (existsSync(backup)) {
  check('备份内容 = 改前的原文', readFileSync(backup, 'utf8') === minimalProfile)
}

/* 5) JSON 仍然合法（能解析） */
try {
  const parsed = JSON.parse(after)
  check('改后的 JSON 仍合法', true)
  check('解析出的 bundles 含插件', (parsed.dsh?.profile?.bundles ?? []).includes('dsh-pet-ds'))
  check(
    '解析出的依赖指向安装目录',
    String(parsed.dependencies?.['dsh-pet-ds'] ?? '').startsWith('file:'),
    String(parsed.dependencies?.['dsh-pet-ds'] ?? '（无）'),
  )
} catch (err) {
  check('改后的 JSON 仍合法', false, err instanceof Error ? err.message : String(err))
}

/* 6) 无 BOM —— 带 BOM 的 JSON 在某些解析器下会出问题 */
{
  const buf = readFileSync(profileJson)
  const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
  check('写回时没有引入 BOM', !hasBom)
}

// ---------------------------------------------------------------- 收尾
log('')
log('清理临时环境（先摘联接再删，避免顺着联接删到真实文件）…')
const detached = detachJunctions(sandbox)
log(`  摘除联接 ${String(detached)} 个`)
rmSync(sandbox, { recursive: true, force: true })
check('临时环境已清理', !existsSync(sandbox))

/* 确认真实环境没被碰到 */
if (realHome) {
  check('真实 DSH_HOME 仍在（未被误删）', existsSync(realHome), realHome)
}

log('')
log(`结果：${failed === 0 ? 'setup.exe 端到端安装验证通过' : `${String(failed)} 项未通过`}`)
process.exitCode = failed === 0 ? 0 : 1
