# DSH 桌宠插件 · 一键安装
#
# 用法（任选一种）：
#   1) 右键本文件 → "使用 PowerShell 运行"
#   2) 在 PowerShell 里：  powershell -ExecutionPolicy Bypass -File .\install-pet.ps1
#   3) 传参指定包体：      .\install-pet.ps1 -Tgz D:\path\to\dsh-pet-ds-0.1.3-fix.tgz
#
# 它做什么（5 步）：
#   [1/5] 找插件包体（.tgz）—— 用本脚本旁边的，或 -Tgz 指定的
#   [2/5] 找 DSH 配置目录与目标 profile
#   [3/5] 找 DSH 自带的 node 与 pnpm
#   [4/5] 用 pnpm 把包装进 profile，然后登记进 bundles / dependencies
#   [5/5] 装 Electron 运行时（桌宠的窗口进程要用它；缺了就是"插件在、桌宠不出现"）
#
# 为什么用 .ps1 而不是 .exe：
#   Windows Defender SmartScreen 会拦未签名的 .exe（"Windows 已保护你的电脑"），
#   而且**签名解决不了** —— 微软文档明确写着自签名与不签名行为完全相同，
#   连 EV 证书也早就不再豁免。所以换掉 exe 这个载体。
#
# 为什么不用 .cmd：
#   cmd.exe 按**系统 ANSI 代码页**读 .cmd（中文 Windows 上是 GBK），
#   用 UTF-8 存的中文会乱码、把语法搞碎；而 PowerShell 读 UTF-8 BOM 没有这个问题。
#
# 本脚本**只做**这三件既有的事，不重复实现任何 DSH 逻辑：
#   · pnpm 安装：调用 DSH 自带的 pnpm（与插件页"添加插件"同一条路）
#   · 登记配置：调用同目录的 register-profile.mjs（与 installer/Setup.cs 改的是同样两处）
#
# 编码要求：本文件必须是 **UTF-8 with BOM**，否则中文在 Windows PowerShell 5.1 下会乱码。
#   仓库里由 scripts/dev/build-cmd.mjs 顺手校验 / 或手工用编辑器保存为"UTF-8 带 BOM"。

[CmdletBinding()]
param(
    # 插件包体（.tgz）。省略时自动在脚本目录与 dist\ 下找 dsh-pet-ds-*.tgz
    [string]$Tgz,

    # 目标 profile 名。省略时用 DSH_PROFILE，再退到 desktop，最后取唯一的一个
    [string]$Profile,

    # DSH 配置目录。省略时用环境变量 DSH_HOME，再退到 %USERPROFILE%\.dsh
    [string]$DshHome,

    # 只做检查、不改任何东西
    [switch]$WhatIf,

    # 跳过 Electron 运行时安装（自己另有安排时才用；跳过会让桌宠窗口起不来）
    [switch]$SkipElectron,

    # 要安装的 Electron 版本。
    #
    # ⚠️ 刻意**钉住一个版本**，而不是"取最新稳定版"：
    # 桌宠的窗口尺寸/透明/置顶行为是在 38.2.0 上验过的，
    # 一键安装的目标是"装完就能用"，不该在装机时顺带升级运行时。
    # 想换版本：-ElectronVersion 44.9.0
    [string]$ElectronVersion = '38.2.0',

    # Electron 下载镜像（默认用脚本内置的镜像顺序）。国内网络常需要它。
    [string]$ElectronMirror
)

$ErrorActionPreference = 'Stop'

$PluginName = 'dsh-pet-ds'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

function Write-Step([string]$Text) { Write-Host "  $Text" }
function Write-Ok([string]$Text) { Write-Host "  [OK] $Text" -ForegroundColor Green }
function Write-Warn2([string]$Text) { Write-Host "  [!] $Text" -ForegroundColor Yellow }
function Write-Err([string]$Text) { Write-Host "  [X] $Text" -ForegroundColor Red }

Write-Host ''
Write-Host '  ============================================'
Write-Host '   DSH 桌宠插件 - 一键安装'
Write-Host '  ============================================'
Write-Host ''
if ($WhatIf) { Write-Warn2 '-WhatIf：只检查，不做任何修改' ; Write-Host '' }

# ---------------------------------------------------------------- 1) 包体
Write-Step '[1/5] 插件包体'

if (-not $Tgz) {
    $candidates = @(
        (Join-Path $ScriptDir 'dsh-pet-ds-*.tgz'),
        (Join-Path $ScriptDir 'dist\dsh-pet-ds-*.tgz')
    )
    foreach ($pattern in $candidates) {
        $hit = Get-ChildItem -Path $pattern -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($hit) { $Tgz = $hit.FullName; break }
    }
}

if (-not $Tgz) {
    Write-Err "找不到插件包体（dsh-pet-ds-*.tgz）"
    Write-Host ''
    Write-Host '      请把本脚本和 .tgz 放在同一目录，或用 -Tgz 指定：'
    Write-Host '        .\install-pet.ps1 -Tgz D:\path\to\dsh-pet-ds-0.1.3-fix.tgz'
    Write-Host ''
    exit 1
}
if (-not (Test-Path -LiteralPath $Tgz)) {
    Write-Err "指定的包体不存在：$Tgz"
    exit 1
}
$Tgz = (Resolve-Path -LiteralPath $Tgz).Path
Write-Ok "$Tgz  ($([math]::Round((Get-Item -LiteralPath $Tgz).Length / 1MB, 2)) MB)"

# ---------------------------------------------------------------- 2) DSH
Write-Step ''
Write-Step '[2/5] DSH 配置目录'

$home_ = if ($DshHome) { $DshHome }
         elseif ($env:DSH_HOME) { $env:DSH_HOME }
         else { Join-Path $env:USERPROFILE '.dsh' }

if (-not (Test-Path -LiteralPath (Join-Path $home_ 'profiles'))) {
    Write-Err "这个目录下没有 profiles 子目录：$home_"
    Write-Host ''
    Write-Host '      请先安装并**至少打开一次** DeepSeek Harness，然后重试。'
    Write-Host '      （也可以用 -DshHome 或环境变量 DSH_HOME 指定。）'
    Write-Host ''
    exit 1
}
$dshHome = (Resolve-Path -LiteralPath $home_).Path
Write-Ok $dshHome

# 选 profile
$profilesRoot = Join-Path $dshHome 'profiles'
$profileDir = $null

$wanted = if ($Profile) { $Profile } elseif ($env:DSH_PROFILE) { $env:DSH_PROFILE } else { $null }
if ($wanted) {
    $cand = Join-Path $profilesRoot $wanted
    if (Test-Path -LiteralPath (Join-Path $cand 'package.json')) { $profileDir = $cand }
}
if (-not $profileDir) {
    $cand = Join-Path $profilesRoot 'desktop'
    if (Test-Path -LiteralPath (Join-Path $cand 'package.json')) { $profileDir = $cand }
}
if (-not $profileDir) {
    $all = @(Get-ChildItem -Path $profilesRoot -Directory -ErrorAction SilentlyContinue |
             Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'package.json') })
    if ($all.Count -eq 1) { $profileDir = $all[0].FullName }
    elseif ($all.Count -gt 1) {
        Write-Err "有多个 profile，无法自动选择："
        $all | ForEach-Object { Write-Host "        $($_.Name)" }
        Write-Host ''
        Write-Host '      请用 -Profile 指定，例如：  .\install-pet.ps1 -Profile desktop'
        Write-Host ''
        exit 1
    }
}
if (-not $profileDir) {
    Write-Err "在 $profilesRoot 下没找到可用的 profile"
    Write-Host ''
    Write-Host '      请先打开一次 DSH 让它生成 profile，再重试。'
    Write-Host ''
    exit 1
}
Write-Ok "$profileDir"

# profile 的**目录名**（如 desktop）。`dsh plugin --profile <名字>` 要的是名字不是路径。
$profileName = Split-Path -Leaf $profileDir
Write-Step "  profile 名：$profileName"

# ---------------------------------------------------------------- 3) node / pnpm
Write-Step ''
Write-Step '[3/5] Node 与 pnpm（用 DSH 自带的）'

$node = $null
$pnpm = $null
# 先置 1：万一 pnpm 完全没跑（没找到它），后面的"兜底 dsh 命令"分支也要能进。
# PowerShell 里 `$null -ne 0` 为真，所以显式初始化更清楚。
$pnpmRc = 1
$runtimes = Join-Path $dshHome 'dsh-runtimes'
if (Test-Path -LiteralPath $runtimes) {
    foreach ($rt in Get-ChildItem -Path $runtimes -Directory -ErrorAction SilentlyContinue) {
        if (-not $node) {
            $cand = Join-Path $rt.FullName 'dependencies\node\bin\node.exe'
            if (Test-Path -LiteralPath $cand) { $node = $cand }
        }
        if (-not $pnpm) {
            $cand = Join-Path $rt.FullName 'dependencies\pnpm\bin\pnpm.mjs'
            if (Test-Path -LiteralPath $cand) { $pnpm = $cand }
        }
    }
}
if (-not $node) {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { $node = $cmd.Source }
}

if (-not $node) {
    Write-Err '找不到 node.exe（DSH 运行时里没有，PATH 上也没有）'
    exit 1
}
Write-Ok "node : $node"
if ($pnpm) { Write-Ok "pnpm : $pnpm" } else { Write-Warn2 'pnpm : 没找到（会跳过预装依赖这一步）' }

# ---------------------------------------------------------------- 4) 安装
Write-Step ''
Write-Step '[4/5] 安装'

if ($WhatIf) {
    Write-Host ''
    Write-Warn2 '检查完毕（-WhatIf，未做任何修改）。去掉 -WhatIf 即开始安装。'
    Write-Host ''
    exit 0
}

# ---- 4a) 用 DSH 自带 pnpm 把包体装进 profile
if ($pnpm) {
    Write-Step '- 用 pnpm 把包体装进 profile ...'
    <#
      用 `&` 直接调用并把输出转发到控制台，**不重定向**：
      重定向会丢掉 pnpm 的进度条与颜色，出问题时也看不到原因。

      两个开关都必需（与 installer/Setup.cs 一致）：
        --ignore-workspace                 : 别向上找 pnpm 工作区根，
                                             否则安装会归到工作区去做、profile 里什么都没有
        --config.confirmModulesPurge=false : 非交互环境里别因
                                             "要不要清空 node_modules" 而放弃
    #>
    Push-Location $profileDir
    try {
        <#
          --config.auto-install-peers=false 是**关键**开关。
          插件把 @deepseek-ai/cordis 与 @deepseek-ai/dsh-tools 声明为
          peerDependencies，而这两个包是 **DSH 在运行时注入**的
          （打包在 DSH 的 app.asar 里；profile 的 node_modules 里并没有，
            实测 createRequire 对它们都报 MODULE_NOT_FOUND）。
          pnpm 默认会自动去装 peer，于是想从 npm 源抓
          @deepseek-ai/dsh-tools@>=0.2.0 —— 而源上只有 0.2.0-rc.2(next)
          与 0.2.1-alpha.5(alpha)，没有稳定版，于是整次安装以
          ERR_PNPM_NO_MATCHING_VERSION 失败（实测）。
          关掉自动装 peer 即可：插件在 DSH 里本来就不缺它们。
        #>
        & $node $pnpm add $Tgz `
            --ignore-workspace `
            --config.confirmModulesPurge=false `
            --config.auto-install-peers=false
        $pnpmRc = $LASTEXITCODE
    }
    finally {
        Pop-Location
    }
    if ($pnpmRc -ne 0) {
        Write-Warn2 "pnpm 返回码 $pnpmRc —— 依赖可能没装全，下面会校验"
    }
    else {
        Write-Ok 'pnpm 完成'
    }
}
else {
    Write-Warn2 '跳过 pnpm 预装（没找到 pnpm）'
}

<#
  ---- 4a-2) 兜底：用 DSH 自己的 CLI 装依赖

  为什么要这一步（这是从用户机器上的真实报错反推出来的）：

  DSH 的报错原文是
    「cannot resolve profile bundle "dsh-pet-ds" ... run 'dsh plugin --profile desktop install'
      if its dependency is not installed」

  也就是说**DSH 自己就有装依赖的命令**。当我们找不到 pnpm、或 pnpm 因为网络/注册表
  问题失败时，用这条官方命令比我们去猜 pnpm 路径更靠谱 —— 它用的正是 DSH 加载插件时
  那套解析规则。
#>
if (-not $pnpm -or $pnpmRc -ne 0) {
    $dshCli = Get-Command dsh -ErrorAction SilentlyContinue
    if ($dshCli) {
        Write-Step "- 尝试用 DSH 自带命令装依赖：dsh plugin --profile $profileName install"
        Push-Location $profileDir
        try {
            & $dshCli.Source plugin --profile $profileName install
            $dshRc = $LASTEXITCODE
        }
        catch {
            $dshRc = 1
            Write-Warn2 "dsh 命令执行出错：$($_.Exception.Message)"
        }
        finally {
            Pop-Location
        }
        if ($dshRc -eq 0) { Write-Ok 'dsh plugin install 完成' }
        else { Write-Warn2 "dsh plugin install 返回码 $dshRc（下面会校验解析结果）" }
    }
    else {
        Write-Warn2 '也没找到 dsh 命令，跳过兜底安装（下面会校验解析结果）'
    }
}

# ---- 4b) 登记进 profile 配置
Write-Step '- 登记进 profile 配置 ...'

<#
  找 register-profile.mjs —— **依次试多种布局**，而不是假定一种。

  为什么：本脚本会以好几种形态到达用户手里，各自的文件位置不同：

    平铺（zip 解压后常见的形态）
        install-pet.ps1
        register-profile.mjs
        dsh-pet-ds-<版本>.tgz

    嵌套（npm 包 / .tgz 解开的形态 —— npm 的 files 没法把子目录文件摊到根）
        install-pet.ps1
        scripts\register-profile.mjs
        dsh-pet-ds-<版本>.tgz

    两者都在上一层（用户在子目录里直接跑）
        <父目录>\install-pet.ps1 与 <父目录>\scripts\register-profile.mjs

  写死一种布局就会在另一种上失败，而这种失败既难懂又容易归错因。所以逐个试。
#>
$registerCandidates = @(
    (Join-Path $ScriptDir 'register-profile.mjs'),
    (Join-Path $ScriptDir 'scripts\register-profile.mjs'),
    (Join-Path (Split-Path -Parent $ScriptDir) 'register-profile.mjs'),
    (Join-Path (Split-Path -Parent $ScriptDir) 'scripts\register-profile.mjs')
)
$register = $null
foreach ($cand in $registerCandidates) {
    if ($cand -and (Test-Path -LiteralPath $cand)) { $register = (Resolve-Path -LiteralPath $cand).Path; break }
}
if (-not $register) {
    Write-Err '找不到 register-profile.mjs'
    Write-Host ''
    Write-Host '      它应当与 install-pet.ps1 放在一起（或位于其 scripts\ 子目录里）。'
    Write-Host '      已找过这些位置：'
    foreach ($cand in $registerCandidates) { Write-Host "        $cand" }
    Write-Host ''
    exit 1
}
Write-Step "  使用 $register"

& $node $register $profileDir $Tgz $PluginName
if ($LASTEXITCODE -ne 0) {
    Write-Err '登记 profile 配置失败（若提示 JSON 不合法，原文件未被改动）'
    exit 1
}

# ---- 4c) 关键校验：插件到底能不能从 profile 解析到
#
# 为什么必须有这一步（这是从真实用户报错反推出来的）：
#
#   DSH 的插件页会显示「异常 / 包不可用」，原文是
#     cannot resolve profile bundle "dsh-pet-ds" ... run 'dsh plugin --profile desktop install'
#       if its dependency is not installed
#
# 含义就是：**bundles 里登记了，但 node_modules 里解析不到** ——
# 成了"登记了却装不上"的半吊子状态。它最常见的成因是 pnpm 那一步失败
# （没找到 pnpm、没有网络、注册表不通），而**旧版脚本在 pnpm 失败后仍然继续登记**。
#
# 所以现在：登记完必须**真的解析一次**；解析不到就回滚登记并明确报错，
# 绝不把一个"异常"状态的插件留在用户配置里。
Write-Step '- 校验：插件能否从 profile 解析到 ...'
$resolvable = $false
if ($node) {
    $probe = "const{createRequire}=require('module');const r=createRequire(process.argv[1]+'/package.json');r.resolve(process.argv[2]+'/package.json');"
    <#
      ⚠️ 这里必须**临时**把 ErrorActionPreference 调回 Continue，并用 try/catch 兜住。

      为什么：解析失败时 node 会把 MODULE_NOT_FOUND 写到 stderr，而 PowerShell 5.1 在
      `ErrorActionPreference = 'Stop'` 下会把**原生命令的 stderr** 当成终止性错误抛出 ——
      于是脚本在这一行就崩了，根本走不到"判断退出码 → 回滚"那段。
      实测踩过：进程直接退出，profile 里留下"登记了但解析不到"的坏插件 ——
      正好是我要修的那种状态。
    #>
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $node -e $probe $profileDir $PluginName > $null 2>&1
        $resolvable = ($LASTEXITCODE -eq 0)
    }
    catch {
        $resolvable = $false
    }
    finally {
        $ErrorActionPreference = $prevEap
    }
}
if ($resolvable) {
    Write-Ok '能从 profile 解析到插件（DSH 加载不会再报"包不可用"）'
}
else {
    Write-Err '插件**登记了但解析不到** —— DSH 会显示「异常 / 包不可用」'
    Write-Host ''
    Write-Host '      也就是说：配置里写了它，但 profile 的 node_modules 里没有它。'
    Write-Host '      通常是依赖那一步没成功（没找到 pnpm / 没有网络 / 注册表不通）。'
    Write-Host ''

    # 回滚登记，避免留下"异常"状态的插件条目
    $bak = Join-Path $profileDir ("package.json.bak-before-" + $PluginName)
    if (Test-Path -LiteralPath $bak) {
        Copy-Item -LiteralPath $bak -Destination (Join-Path $profileDir 'package.json') -Force
        Write-Warn2 '已回滚 profile 登记（不会给 DSH 留一个坏插件）'
    }
    else {
        Write-Warn2 "没找到备份 $bak，profile 登记未回滚 —— 请在 DSH 插件页点「卸载」"
    }

    Write-Host ''
    Write-Host '      三种修法（任选其一）：'
    Write-Host ''
    Write-Host '      1) 用 DSH 自己的插件页装（最稳，走它自己的安装流程）：'
    Write-Host '         插件 → 添加插件 → 填这个 tgz 的**绝对路径**：'
    Write-Host "           $Tgz"
    Write-Host ''
    Write-Host '      2) 命令行让 DSH 自己装依赖：'
    Write-Host "           dsh plugin --profile $profileName install"
    Write-Host ''
    Write-Host '      3) 手动在 profile 目录里装（需要联网）：'
    Write-Host '           cd "' + $profileDir + '"'
    Write-Host "           pnpm add `"$Tgz`" --ignore-workspace --config.auto-install-peers=false"
    Write-Host ''
    Write-Host '      提示：如果这台机器**不能联网**，请改用 setup.exe 版安装程序 ——'
    Write-Host '            它把依赖树一起内嵌了，不需要联网装依赖。'
    Write-Host ''
    exit 1
}

# ---------------------------------------------------------------- 5) Electron 运行时
Write-Step ''
Write-Step '[5/5] Electron 运行时'

<#
  为什么这一步是"一键可用"的必要条件：

  桌宠的窗口进程是**独立 Electron**，不是 DSH 自带的那份 ——
  DSH 的 `DeepSeek Harness.exe` 是改造过的载体，把应用目录当参数传给它会直接退出。
  所以缺了 Electron，插件能装好、能被 DSH 加载，但**桌宠窗口不会出现**，
  现象就是"装了却什么都没有"，极难自行归因。

  安装脚本就在**刚装好的插件**里（上一步已完成），所以从插件目录取它，
  不必在安装包里再放一份。
#>
if ($SkipElectron) {
    Write-Warn2 '-SkipElectron：跳过 Electron 安装'
}
else {
    $electronRoot = Join-Path $dshHome 'electron'
    $existingElectron = $null
    if (Test-Path -LiteralPath $electronRoot) {
        $hit = Get-ChildItem -Path (Join-Path $electronRoot 'electron-v*-win32-x64') -Directory -ErrorAction SilentlyContinue |
               Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'electron.exe') } |
               Select-Object -First 1
        if ($hit) { $existingElectron = Join-Path $hit.FullName 'electron.exe' }
    }

    if ($existingElectron) {
        Write-Ok "已有：$existingElectron"
    }
    else {
        $pluginDir = Join-Path $profileDir "node_modules\$PluginName"
        $electronInstaller = Join-Path $pluginDir 'scripts\dev\install-electron.mjs'
        if (-not (Test-Path -LiteralPath $electronInstaller)) {
            $alt = Join-Path $ScriptDir 'scripts\dev\install-electron.mjs'
            if (Test-Path -LiteralPath $alt) { $electronInstaller = (Resolve-Path -LiteralPath $alt).Path }
        }

        if (-not (Test-Path -LiteralPath $electronInstaller)) {
            Write-Warn2 '找不到 install-electron.mjs，跳过 Electron 安装'
            Write-Host '      桌宠窗口需要独立 Electron；请手动执行：'
            Write-Host "        node `"$pluginDir\scripts\dev\install-electron.mjs`""
        }
        else {
            Write-Step '- 下载并安装 Electron（约 100 MB，需要联网）...'
            <#
              ⚠️ 必须把 DSH_HOME 传给子进程。
              install-electron.mjs 自己按 `DSH_HOME ?? %USERPROFILE%\.dsh` 决定装到哪，
              而本脚本可能用 -DshHome 指定了别的目录 —— 不传就会装到用户默认目录，
              与这里认定的 $dshHome 不一致，之后桌宠照样找不到它。
            #>
            $prevDshHome = $env:DSH_HOME
            $env:DSH_HOME = $dshHome
            $eRc = 1
            Push-Location $pluginDir
            try {
                $eArgs = @($electronInstaller)
                if ($ElectronVersion) { $eArgs += "--version=$ElectronVersion" }
                if ($ElectronMirror) { $eArgs += "--mirror=$ElectronMirror" }
                & $node @eArgs
                $eRc = $LASTEXITCODE
            }
            catch {
                Write-Warn2 "Electron 安装出错：$($_.Exception.Message)"
            }
            finally {
                Pop-Location
                if ($null -eq $prevDshHome) { Remove-Item Env:DSH_HOME -ErrorAction SilentlyContinue }
                else { $env:DSH_HOME = $prevDshHome }
            }

            if ($eRc -eq 0) {
                Write-Ok 'Electron 安装完成'
            }
            else {
                Write-Warn2 "Electron 安装失败（返回码 $eRc）—— 插件已经装好，但桌宠窗口起不来"
                Write-Host ''
                Write-Host '      常见原因与对策：'
                Write-Host '        * 没有联网  -> 联网后重跑本脚本，或手动执行下面那条'
                Write-Host '        * 下载被墙  -> 换镜像，例如：'
                Write-Host '            .\install-pet.ps1 -ElectronMirror https://npmmirror.com/mirrors/electron/'
                Write-Host '      手动安装命令：'
                Write-Host "        node `"$electronInstaller`""
                Write-Host ''
            }
        }
    }
}

Write-Host ''
Write-Host '  ============================================'
Write-Host '   安装完成'
Write-Host '  ============================================'
Write-Host ''
Write-Host '   接下来：**重启 DSH**（插件在启动时加载）'
Write-Host ''
Write-Host '   重启后应看到：'
Write-Host '     * 桌宠自动出现'
Write-Host '     * 模型工具 DSHpet_status / DSHpet_balance / DSHpet_control'
Write-Host '     * 设置页里出现「桌宠」一栏'
Write-Host ''
Write-Host '   如果桌宠没出现：先看 DSH 插件页有没有报 failed to import，'
Write-Host '   再按插件目录里的 INSTALL.md「排障」一节逐项核对。'
Write-Host ''
exit 0
