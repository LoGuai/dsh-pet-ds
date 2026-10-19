# 模拟"双击 install.cmd" —— 不传任何参数，从用户的角度跑一遍。
#
# ## 为什么这次测试方式和以前不同
#
# 之前我一直用 `-ExecutionPolicy Bypass -File install-pet.ps1` 测，
# 结果**掩盖了真实使用方式**：这台机器的执行策略是 Restricted，
# 用户直接运行 .ps1 会报 "running scripts is disabled"。
# 这次完全按用户操作来：`cmd /c install.cmd`，不带任何开关。
#
# ## 怎么在不碰真实配置的前提下测
#
# install.cmd 会把 `%*` 原样转给 ps1；双击时它是空的，所以传不了 -DshHome。
# 因此用**环境变量 DSH_HOME**：install-pet.ps1 会优先读它。
# 这样既走了双击那条路，又落在沙箱里。

$ErrorActionPreference = 'Continue'

# ---------------------------------------------------------------- 自组交付目录
#
# 测试**自己去组**这个目录，不依赖 dist 里预先存在的构建产物。
#
# 为什么改：原先写死 `dist\桌宠插件-一键安装`，而 `build-package.mjs` 会清空
# 整个 dist —— 于是"先构建再跑测试"时那个目录不复存在，这条测试就红了，
# 看起来像 install.cmd 坏了，其实只是没组包。
#
# 现在按交付包的真实构成组到沙箱里：
#   install.cmd / install-pet.ps1 / register-profile.mjs / dsh-pet-ds-<版本>.tgz
# 这也更贴近"用户从 zip 解压出来得到什么"（zip 的端到端验证另见
# scripts/dev/verify-release-zip.mjs）。
$repo = 'D:\dsh\pet'
$version = (Get-Content (Join-Path $repo 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
$tgz = Join-Path $repo "dist\dsh-pet-ds-$version.tgz"
if (-not (Test-Path $tgz)) {
    $candidates = Get-ChildItem (Join-Path $repo 'dist') -Filter 'dsh-pet-ds-*.tgz' -ErrorAction SilentlyContinue
    if ($candidates) { $tgz = ($candidates | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName }
}

$flat = Join-Path $repo '.cache\click-flat'
if (Test-Path $flat) { Remove-Item $flat -Recurse -Force -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Path $flat -Force | Out-Null
Copy-Item (Join-Path $repo 'install.cmd') (Join-Path $flat 'install.cmd') -Force
Copy-Item (Join-Path $repo 'install-pet.ps1') (Join-Path $flat 'install-pet.ps1') -Force
Copy-Item (Join-Path $repo 'scripts\register-profile.mjs') (Join-Path $flat 'register-profile.mjs') -Force
if (Test-Path $tgz) { Copy-Item $tgz (Join-Path $flat (Split-Path $tgz -Leaf)) -Force }

$root = 'D:\dsh\pet\.cache\click-test'
$prof = Join-Path $root 'profiles\desktop'
$realProfile = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\package.json'
$realHashBefore = (Get-FileHash $realProfile -Algorithm SHA256).Hash

if (Test-Path $root) {
    Get-ChildItem $root -Recurse -Directory -Force -ErrorAction SilentlyContinue |
        Sort-Object { $_.FullName.Length } -Descending |
        ForEach-Object { cmd /c rmdir "$($_.FullName)" 2>$null | Out-Null }
    Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue
}
New-Item -ItemType Directory -Path $prof -Force | Out-Null

$profileJson = @'
{
  "name": "dsh-profile-desktop",
  "private": true,
  "dsh": { "profile": { "bundles": [ "@deepseek-ai/dsh-base" ] } },
  "dependencies": { "@ggboy123/dsh-paper-reader": "1.2.0" }
}
'@
[System.IO.File]::WriteAllText((Join-Path $prof 'package.json'), $profileJson, (New-Object System.Text.UTF8Encoding($false)))
cmd /c mklink /J "$root\dsh-runtimes" "$env:USERPROFILE\.dsh\dsh-runtimes" | Out-Null

Write-Output "交付目录: $flat"
Write-Output "沙箱    : $root"
Write-Output ''

# 关键：只设环境变量，不加任何命令行开关 —— 与双击等价
$env:DSH_HOME = $root
$env:DSH_PROFILE = 'desktop'

Write-Output '=== 模拟双击 install.cmd（cmd /c，不带任何参数）==='
$out = cmd /c "echo. | `"$flat\install.cmd`"" 2>&1
$out | ForEach-Object { Write-Output ("  " + $_) }

Write-Output ''
Write-Output '=== 断言 ==='
$failed = 0
function Check($name, $ok, $detail) {
    if ($ok) { Write-Output "  [OK] $name" } else { Write-Output "  [X]  $name  $detail"; $script:failed++ }
}

Check '真实 profile 未被改动' ((Get-FileHash $realProfile -Algorithm SHA256).Hash -eq $realHashBefore) ''

$joined = $out -join "`n"
Check '没有执行策略报错' (-not ($joined -match 'running scripts is disabled')) ''
Check '没有乱码迹象' (-not ($joined -match '锟斤拷')) ''

$cfg = ([System.IO.File]::ReadAllText((Join-Path $prof 'package.json'), [System.Text.Encoding]::UTF8)) | ConvertFrom-Json
Check '沙箱 bundles 含 dsh-pet-ds' ($cfg.dsh.profile.bundles -contains 'dsh-pet-ds') ''
Check '沙箱 dependencies 有它' ([bool]$cfg.dependencies.'dsh-pet-ds') ''
Check '原有内容保留' ((($cfg.dsh.profile.bundles -contains '@deepseek-ai/dsh-base')) -and [bool]$cfg.dependencies.'@ggboy123/dsh-paper-reader') ''
Check '生成了备份' (Test-Path ((Join-Path $prof 'package.json') + '.bak-before-dsh-pet-ds')) ''

$entry = Join-Path $prof 'node_modules\dsh-pet-ds\src\host\index.js'
Check '插件已装进 profile' (Test-Path $entry) $entry
if (Test-Path $entry) {
    $node = 'C:\Users\29845\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
    $url = 'file:///' + ($entry -replace '\\', '/')
    $js = "import(process.argv[1]).then(m=>{console.log('OK name='+m.name)}).catch(e=>{console.log('FAIL '+e.message.split('\n')[0]);process.exit(1)})"
    $r = & $node -e $js $url 2>&1
    Write-Output ("  导入: " + ($r -join ' '))
    Check '插件能真导入' (($r -join ' ') -match '^OK') ''
}

Remove-Item Env:DSH_HOME -ErrorAction SilentlyContinue
Remove-Item Env:DSH_PROFILE -ErrorAction SilentlyContinue

Write-Output ''
if ($failed -eq 0) { Write-Output '结果：双击启动器验证全部通过'; exit 0 }
else { Write-Output "结果：$failed 项未通过"; exit 1 }
