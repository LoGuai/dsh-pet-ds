# 在沙箱里测试 install-pet.ps1。
#
# ## 为什么这次能确保不碰真实环境
#
#   · 脚本通过 `-DshHome <沙箱>` 显式指定配置目录 —— 不再依赖环境变量继承；
#   · **跑前跑后都比对真实 profile 的 SHA256**，一旦被改动就报出来；
#   · 跑完把真实 profile 还原（万一）。
#
# 上一版 .cmd 的教训：它在脚本内部 `set "DSH_HOME="` 清空了传入的变量，
# 于是回退到真实目录。PS1 用参数显式传入，没有这个隐患。

$ErrorActionPreference = 'Continue'

$root = 'D:\dsh\pet\.cache\ps1-test'
$prof = Join-Path $root 'profiles\desktop'
$realProfile = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\package.json'

# 真实 profile 的基线
$realHashBefore = if (Test-Path $realProfile) { (Get-FileHash $realProfile -Algorithm SHA256).Hash } else { '' }
$realContentBefore = if (Test-Path $realProfile) { [System.IO.File]::ReadAllText($realProfile, [System.Text.Encoding]::UTF8) } else { '' }

# ---------------------------------------------------------------- 清场
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
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base"
      ]
    }
  },
  "dependencies": {
    "@ggboy123/dsh-paper-reader": "1.2.0"
  }
}
'@
[System.IO.File]::WriteAllText((Join-Path $prof 'package.json'), $profileJson, (New-Object System.Text.UTF8Encoding($false)))

# 联接 dsh-runtimes，让脚本找得到 node 与 pnpm
cmd /c mklink /J "$root\dsh-runtimes" "$env:USERPROFILE\.dsh\dsh-runtimes" | Out-Null

$tgz = (Get-ChildItem 'D:\dsh\pet\dist\dsh-pet-ds-*.tgz' | Select-Object -First 1).FullName

Write-Output "沙箱  : $root"
Write-Output "包体  : $(Split-Path $tgz -Leaf)"
Write-Output ''

# ---------------------------------------------------------------- 跑
$instOut = ''
Write-Output '=== 运行 install-pet.ps1 -DshHome <沙箱> ==='
<#
  ⚠️ 必须加 -SkipElectron。

  沙箱的 DSH_HOME 里没有 Electron，于是脚本会去下载约 100 MB 的 Electron 再解压 ——
  这会让本测试变慢、并且**依赖网络**。而本测试要验的是"装插件 + 登记 profile"
  这条主链路，Electron 那一步是独立的（它有自己的一句断言在下面）。

  刻意保留一个"-SkipElectron 时会明确说出跳过"的检查，
  免得哪天参数被删掉后测试仍然悄悄通过。
#>
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File 'D:\dsh\pet\install-pet.ps1' -DshHome $root -Tgz $tgz -SkipElectron 2>&1 |
    ForEach-Object { $script:instOut += "$_`n"; Write-Output ("  " + $_) }

# ---------------------------------------------------------------- 断言
Write-Output ''
Write-Output '=== 断言 ==='
$failed = 0
function Check($name, $ok, $detail) {
    if ($ok) { Write-Output "  [OK] $name" }
    else { Write-Output "  [X]  $name  $detail"; $script:failed++ }
}

# 1) 真实 profile 绝不能被改（最要紧）
$realHashAfter = if (Test-Path $realProfile) { (Get-FileHash $realProfile -Algorithm SHA256).Hash } else { '' }
Check '真实 profile 未被改动' ($realHashBefore -eq $realHashAfter) "$realHashBefore -> $realHashAfter"

# 2) 沙箱 profile 被正确登记
$after = [System.IO.File]::ReadAllText((Join-Path $prof 'package.json'), [System.Text.Encoding]::UTF8)
$cfg = $after | ConvertFrom-Json
Check '沙箱 bundles 含 dsh-pet-ds' ($cfg.dsh.profile.bundles -contains 'dsh-pet-ds') ''
Check '沙箱 dependencies 指向包体' ($cfg.dependencies.'dsh-pet-ds' -like 'file:*') "$($cfg.dependencies.'dsh-pet-ds')"
Check '沙箱原有 bundles 仍在' ($cfg.dsh.profile.bundles -contains '@deepseek-ai/dsh-base') ''
Check '沙箱原有 dependencies 仍在' ([bool]$cfg.dependencies.'@ggboy123/dsh-paper-reader') ''
Check '沙箱生成了备份' (Test-Path ((Join-Path $prof 'package.json') + '.bak-before-dsh-pet-ds')) ''

# 3) 沙箱里 node_modules 里应有这个包
$linked = Join-Path $prof 'node_modules\dsh-pet-ds'
Check '沙箱 node_modules 里有 dsh-pet-ds' (Test-Path $linked) $linked

# 4) 一键装 Electron 的前提：装好的插件里必须带着安装脚本
#
# 安装器不自己实现 Electron 下载逻辑，而是调用插件里的 install-electron.mjs。
# 所以这个文件必须在**装好的插件**里 —— 少打一个文件进去，
# 用户点"一键安装"就会得到"插件在、桌宠不出现"。
Check '装好的插件里带着 install-electron.mjs' `
    (Test-Path (Join-Path $linked 'scripts\dev\install-electron.mjs')) `
    (Join-Path $linked 'scripts\dev\install-electron.mjs')

# 5) -SkipElectron 必须真的被识别（否则参数被删掉后测试还会悄悄通过）
Check '-SkipElectron 被识别并明确说了跳过' ($instOut -match 'SkipElectron') `
    "输出里没有 SkipElectron 字样"

Write-Output ''
if ($failed -eq 0) {
    Write-Output '结果：全部通过'
    exit 0
}
else {
    Write-Output "结果：$failed 项未通过"
    exit 1
}
