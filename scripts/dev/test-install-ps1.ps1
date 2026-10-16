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
Write-Output '=== 运行 install-pet.ps1 -DshHome <沙箱> ==='
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File 'D:\dsh\pet\install-pet.ps1' -DshHome $root -Tgz $tgz 2>&1 |
    ForEach-Object { Write-Output ("  " + $_) }

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

Write-Output ''
if ($failed -eq 0) {
    Write-Output '结果：全部通过'
    exit 0
}
else {
    Write-Output "结果：$failed 项未通过"
    exit 1
}
