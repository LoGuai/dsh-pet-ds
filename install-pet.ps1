# DSH 桌宠插件 · 一键安装
#
# 用法（任选一种）：
#   1) 右键本文件 → "使用 PowerShell 运行"
#   2) 在 PowerShell 里：  powershell -ExecutionPolicy Bypass -File .\install-pet.ps1
#   3) 传参指定包体：      .\install-pet.ps1 -Tgz D:\path\to\dsh-pet-ds-0.1.3-fix.tgz
#
# 它做什么（4 步）：
#   [1/4] 找插件包体（.tgz）—— 用本脚本旁边的，或 -Tgz 指定的
#   [2/4] 找 DSH 配置目录与目标 profile
#   [3/4] 找 DSH 自带的 node 与 pnpm
#   [4/4] 用 pnpm 把包装进 profile，然后登记进 bundles / dependencies
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
    [switch]$WhatIf
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
Write-Step '[1/4] 插件包体'

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
Write-Step '[2/4] DSH 配置目录'

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

# ---------------------------------------------------------------- 3) node / pnpm
Write-Step ''
Write-Step '[3/4] Node 与 pnpm（用 DSH 自带的）'

$node = $null
$pnpm = $null
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
Write-Step '[4/4] 安装'

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
        Write-Warn2 "pnpm 返回码 $pnpmRc —— 继续登记配置；若之后插件加载失败，请按 INSTALL.md 排障。"
    }
    else {
        Write-Ok 'pnpm 完成'
    }
}
else {
    Write-Warn2 '跳过 pnpm 预装（没找到 pnpm）'
}

# ---- 4b) 登记进 profile 配置
Write-Step '- 登记进 profile 配置 ...'
$register = Join-Path $ScriptDir 'register-profile.mjs'
if (-not (Test-Path -LiteralPath $register)) {
    # 在仓库里直接跑时，脚本可能在 scripts\ 下
    $alt = Join-Path $ScriptDir 'scripts\register-profile.mjs'
    if (Test-Path -LiteralPath $alt) { $register = $alt }
}
if (-not (Test-Path -LiteralPath $register)) {
    Write-Err "找不到 register-profile.mjs（应与本脚本同目录）：$register"
    exit 1
}

& $node $register $profileDir $Tgz $PluginName
if ($LASTEXITCODE -ne 0) {
    Write-Err '登记 profile 配置失败（若提示 JSON 不合法，原文件未被改动）'
    exit 1
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
