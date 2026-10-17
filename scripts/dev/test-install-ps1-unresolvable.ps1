# 验证「依赖装不上时」的行为：必须**回滚登记 + 明确报错 + 退出码非 0**。
#
# 这条来自真实用户报错（DSH 插件页显示「异常 / 包不可用」）：
#   cannot resolve profile bundle "dsh-pet-ds" from the dsh installation or
#   C:/Users/xxx/.dsh/profiles/desktop; run 'dsh plugin --profile desktop install'
#     if its dependency is not installed
#
# 成因：旧版脚本在 pnpm 失败后**仍然登记** bundles，于是配置里写了插件、
# 但 profile 的 node_modules 里没有它 —— DSH 就报"包不可用"。
#
# 造法：沙箱 DSH_HOME 里放一个只有 node.exe、**没有 pnpm** 的假 dsh-runtimes，
# 于是"装依赖"这步必然失败。

$ErrorActionPreference = 'Continue'

# ⚠️ $PSScriptRoot 是 scripts\dev，所以要上溯**两**层才到仓库根。
# 用 $MyInvocation.MyCommand.Path 上溯两次只会到 scripts（实测漏了一层，
# 结果"dist 下没有 tgz，跳过测试"——一个会静默跳过的假绿）。
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$root = Join-Path $repo '.cache\ps1-unresolvable'
$prof = Join-Path $root 'profiles\desktop'
$realPkg = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\package.json'
$realHashBefore = if (Test-Path $realPkg) { (Get-FileHash $realPkg -Algorithm SHA256).Hash } else { '' }

if (Test-Path $root) {
    Get-ChildItem $root -Recurse -Directory -Force -ErrorAction SilentlyContinue |
        Sort-Object { $_.FullName.Length } -Descending |
        ForEach-Object { cmd /c rmdir "$($_.FullName)" 2>$null | Out-Null }
    Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue
}
New-Item -ItemType Directory -Path $prof -Force | Out-Null
[System.IO.File]::WriteAllText((Join-Path $prof 'package.json'), @'
{
  "name": "dsh-profile-desktop",
  "private": true,
  "dsh": { "profile": { "bundles": [ "@deepseek-ai/dsh-base" ] } },
  "dependencies": {}
}
'@, (New-Object System.Text.UTF8Encoding($false)))

# 假的 dsh-runtimes：只有 node.exe，没有 pnpm
$nodeBin = Join-Path $root 'dsh-runtimes\fake\dependencies\node\bin'
New-Item -ItemType Directory -Path $nodeBin -Force | Out-Null
$realNode = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
if (-not (Test-Path $realNode)) {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { $realNode = $cmd.Source }
}
if (-not (Test-Path $realNode)) {
    Write-Output '  ⚠ 找不到 node.exe，跳过本测试'
    exit 0
}
Copy-Item $realNode (Join-Path $nodeBin 'node.exe') -Force

$tgz = Get-ChildItem (Join-Path $repo 'dist') -Filter 'dsh-pet-ds-*.tgz' -ErrorAction SilentlyContinue |
       Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $tgz) {
    Write-Output '  ⚠ dist 下没有 tgz，跳过本测试'
    exit 0
}

Write-Output '=== 运行 install-pet.ps1（预期：失败并回滚）==='
$out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repo 'install-pet.ps1') `
    -DshHome $root -Tgz $tgz.FullName -SkipElectron 2>&1
$rc = $LASTEXITCODE

Write-Output ''
Write-Output '=== 断言 ==='
$failed = 0
function Check($name, $ok, $detail) {
    if ($ok) { Write-Output "  [OK] $name" }
    else { Write-Output "  [X]  $name  $detail"; $script:failed++ }
}
$joined = $out -join "`n"

Check '退出码非 0（失败不能被当成成功）' ($rc -ne 0) "退出码 $rc"
Check '明确说了"登记了但解析不到"' ($joined -match '登记了但解析不到') ''
Check '给出了回滚提示' ($joined -match '已回滚') ''
Check '给了修法：dsh plugin --profile' ($joined -match 'dsh plugin --profile') ''
Check '提示了离线应改用 setup.exe' ($joined -match 'setup\.exe') ''

$cfg = $null
try {
    $cfg = ([System.IO.File]::ReadAllText((Join-Path $prof 'package.json'), [System.Text.Encoding]::UTF8)) | ConvertFrom-Json
} catch { $cfg = $null }
$bundles = if ($cfg -and $cfg.dsh -and $cfg.dsh.profile) { @($cfg.dsh.profile.bundles) } else { @() }
$depNames = if ($cfg -and $cfg.dependencies) { @($cfg.dependencies.PSObject.Properties.Name) } else { @() }
Check 'profile 已回滚（bundles 不含 dsh-pet-ds）' (-not ($bundles -contains 'dsh-pet-ds')) ("bundles=" + ($bundles -join ','))
Check 'profile 已回滚（dependencies 不含 dsh-pet-ds）' (-not ($depNames -contains 'dsh-pet-ds')) ("deps=" + ($depNames -join ','))

$realHashAfter = if (Test-Path $realPkg) { (Get-FileHash $realPkg -Algorithm SHA256).Hash } else { '' }
Check '真实 profile 未被改动' ($realHashBefore -eq $realHashAfter) ''

# 清理
if (Test-Path $root) {
    Get-ChildItem $root -Recurse -Directory -Force -ErrorAction SilentlyContinue |
        Sort-Object { $_.FullName.Length } -Descending |
        ForEach-Object { cmd /c rmdir "$($_.FullName)" 2>$null | Out-Null }
    Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Output ''
Write-Output $(if ($failed -eq 0) { '结果：依赖装不上时的行为正确（回滚 + 明确报错）' } else { "结果：$failed 项未通过" })
exit $(if ($failed -eq 0) { 0 } else { 1 })
