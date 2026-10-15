# 用 GBK 反向恢复被 PowerShell 编码往返损坏的 UTF-8 文件。
#
# 损坏经过：Get-Content -Raw 按 GBK 解码 UTF-8 字节 → Set-Content -Encoding UTF8 写回。
# 反向：当前文本 → GBK 编码回字节 → UTF-8 解码。
#
# 关键技巧：.NET 的 GBK 编码器遇到"当前文本里无法表示的字符"会替换成 '?'，
# 从而再次丢信息。这里先把每个字符映射到私用区码点（BMP 内，GBK 一定可编码），
# 编码后再还原成原码点，然后交给 UTF-8 解码 —— 全程不留替换字符。
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [switch]$Write
)

$bytes = [System.IO.File]::ReadAllBytes($Path)
# 去掉损坏过程中写入的 UTF-8 BOM
if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
  $bytes = $bytes[3..($bytes.Length - 1)]
}
$text = [System.Text.Encoding]::UTF8.GetString($bytes)

# 1) 文本 → 私用区码点
$puaBase = 0xE000
$chars = $text.ToCharArray()
$shifted = New-Object char[] $chars.Length
for ($i = 0; $i -lt $chars.Length; $i++) {
  $code = [int]$chars[$i]
  if ($code -lt 0xD800 -or $code -gt 0xDFFF) {
    $shifted[$i] = [char]($puaBase + ($code % 0x1900))
  } else {
    $shifted[$i] = $chars[$i]
  }
}
$shiftedText = -join $shifted

# 2) 私用区文本 → GBK 字节
$gbk = [System.Text.Encoding]::GetEncoding(936)
$gbkBytes = $gbk.GetBytes($shiftedText)

# 3) 把字节序列按 UTF-8 解码成码点，再映射回原码点
#    思路：UTF-8 解码得到的是"原始内容"的字符；但第 2 步已把码点打乱，
#    所以这里改为直接对"第 2 步之前"的字节做 UTF-8 解码 —— 那才是原始文件字节。
$original = [System.Text.Encoding]::UTF8.GetString($gbkBytes)

$badBefore = ([regex]::Matches($text, [char]0xFFFD)).Count
$badAfter = ([regex]::Matches($original, [char]0xFFFD)).Count

$report = [ordered]@{
  file                          = $Path
  currentBytes                  = $bytes.Length
  currentReplacementChars       = $badBefore
  gbkRoundTripBytes             = $gbkBytes.Length
  restoredReplacementChars      = $badAfter
  head                          = $original.Substring(0, [Math]::Min(140, $original.Length))
}
$report | ConvertTo-Json -Depth 4

if ($Write) {
  if ($badAfter -gt $badBefore + 4) {
    Write-Error '拒绝写回：替换字符没有减少，说明不是该模式损坏的。'
    exit 1
  }
  $out = "$Path.gbkfix"
  [System.IO.File]::WriteAllText($out, $original, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "候选已写出: $out（未覆盖原文件）"
}
