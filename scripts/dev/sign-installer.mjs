/**
 * 代码签名脚本。
 *
 * ## 先说清一件事：签名**不能**消除 SmartScreen 警告
 *
 * 这是本脚本存在的主要理由 —— 把这件事写清楚，免得白折腾。
 * 微软官方文档（[SmartScreen reputation](
 * https://learn.microsoft.com/windows/apps/package-and-deploy/smartscreen-reputation)）写得很明确：
 *
 * | 证书类型 | 首次下载/运行的行为 |
 * |---|---|
 * | 微软商店 | ✅ 无警告（微软重新签名） |
 * | 有效证书（OV/EV） | ⚠️ **仍警告**，只是显示已验证的发布者名 |
 * | 未签名 | ⚠️ 警告"Windows 已保护你的电脑" |
 * | **自签名** | ⚠️ **与未签名完全相同** |
 *
 * 而且文档明确说 **EV 证书早就不再豁免 SmartScreen** 了
 * （"Years ago… but this behavior no longer exists"）。
 *
 * 真正能免警告的只有：发到微软商店，或让**文件哈希**攒够下载量
 * （"several weeks and hundreds of clean installs from a wide audience"）。
 *
 * ## 那签名还有什么用
 *
 * · **显示发布者名**（OV/EV）—— 用户看到"某某软件"而不是"未知发布者"；
 * · **完整性**：签名后文件被改动一眼能看出来；
 * · **企业分发**：内网/组策略环境常要求已签名；
 * · **信誉可继承**：同一证书签的后续版本能继承证书信誉
 *   （未签名的每个新版本都要从零攒）。
 *
 * ## 用法
 *
 * ```powershell
 * # 用已有证书（给指纹或主题名）
 * node scripts/dev/sign-installer.mjs -Cert 1A2B3C...
 * node scripts/dev/sign-installer.mjs -Cert "CN=我的发布者"
 *
 * # 生成一张自签名证书并用它签（**仅供本机测试**，不解决 SmartScreen）
 * node scripts/dev/sign-installer.mjs -SelfSigned
 *
 * # 只看看当前签名状态
 * node scripts/dev/sign-installer.mjs -Check
 * ```
 *
 * ⚠️ 签名会**改写 exe 字节**。必须在 `build-installer.mjs` **之后**跑，
 * 而且签完之后不要再重新编译（会覆盖签名）。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')

/** 默认签署交付物；也接受位置参数指定别的文件（便于在副本上验证）。 */
const SETUP = process.argv[2] && !process.argv[2].startsWith('-')
  ? resolve(process.argv[2])
  : join(ROOT, 'dist', 'setup.exe')

const log = (m) => console.log(m)

/** 把参数解析成 `{check, selfSigned, cert}`。 */
function parseArgs(argv) {
  const out = { check: false, selfSigned: false, cert: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-Check' || a === '--check') out.check = true
    else if (a === '-SelfSigned' || a === '--self-signed') out.selfSigned = true
    else if (a === '-Cert' || a === '--cert') out.cert = argv[++i] ?? null
  }
  return out
}

/**
 * 跑一段 PowerShell 脚本（写成临时文件再执行）。
 *
 * 为什么写文件而不是 `-Command` 拼字符串：这些脚本里有单引号、`$` 变量、
 * 中文与正则，内联进 Puppeteer 式的转义地狱必然出错 —— 这个坑我在本会话
 * 已经踩过好几次（PowerShell 会把引号吃掉、把正则改成乱码）。
 */
function runPs(script) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sign-'))
  const file = join(dir, 'run.ps1')
  /* 用 UTF-8 BOM 写：PowerShell 5.1 读无 BOM 的 UTF-8 会按 ANSI 解，中文会乱。 */
  writeFileSync(file, '\uFEFF' + script, 'utf8')
  try {
    return execFileSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------- 检查
function checkSignature(path) {
  const out = runPs(`
$s = Get-AuthenticodeSignature -LiteralPath '${path.replace(/'/g, "''")}'
Write-Output ('STATUS=' + $s.Status)
if ($s.SignerCertificate) {
  Write-Output ('SUBJECT=' + $s.SignerCertificate.Subject)
  Write-Output ('THUMB=' + $s.SignerCertificate.Thumbprint)
  Write-Output ('NOTAFTER=' + $s.SignerCertificate.NotAfter)
} else {
  Write-Output 'SUBJECT=(未签名)'
}
if ($s.TimeStamperCertificate) { Write-Output ('TSA=' + $s.TimeStamperCertificate.Subject) }
`)
  const get = (k) => {
    const m = new RegExp(`^${k}=(.*)$`, 'm').exec(out)
    return m ? m[1].trim() : ''
  }
  return {
    status: get('STATUS'),
    subject: get('SUBJECT'),
    thumbprint: get('THUMB'),
    notAfter: get('NOTAFTER'),
    tsa: get('TSA'),
  }
}

// ---------------------------------------------------------------- 主流程
const args = parseArgs(process.argv.slice(2))

if (!existsSync(SETUP)) {
  log(`✗ 找不到 ${SETUP}`)
  log('  先跑：node scripts/dev/build-installer.mjs')
  process.exit(1)
}

log(`目标：${SETUP}（${(statSync(SETUP).size / 1024 / 1024).toFixed(2)} MB）`)

if (args.check) {
  const s = checkSignature(SETUP)
  log('')
  log('当前签名状态：')
  log(`  状态    ：${s.status}`)
  log(`  发布者  ：${s.subject}`)
  if (s.thumbprint) log(`  指纹    ：${s.thumbprint}`)
  if (s.notAfter) log(`  有效期至：${s.notAfter}`)
  if (s.tsa) log(`  时间戳  ：${s.tsa}`)
  log('')
  if (s.status === 'NotSigned') {
    log('未签名 → 用户首次运行会看到 SmartScreen 警告（"未知发布者"）。')
    log('注意：**自签名证书同样会触发该警告**，见本文件顶部说明。')
  }
  process.exit(0)
}

if (!args.selfSigned && !args.cert) {
  log('')
  log('用法：')
  log('  node scripts/dev/sign-installer.mjs -Check                 只看签名状态')
  log('  node scripts/dev/sign-installer.mjs -Cert <指纹或主题名>   用已有证书签')
  log('  node scripts/dev/sign-installer.mjs -SelfSigned            生成自签名证书并签')
  log('')
  log('⚠️ 无论用哪种证书，**SmartScreen 警告都不会消失**（见本文件顶部）。')
  process.exit(0)
}

let thumbprint = args.cert

if (args.selfSigned) {
  log('')
  log('生成自签名代码签名证书（当前用户，不装进受信任根）…')

  const created = runPs(`
$cert = New-SelfSignedCertificate \`
  -Subject 'CN=DSH Pet (self-signed, local test)' \`
  -Type CodeSigningCert \`
  -CertStoreLocation 'Cert:\\CurrentUser\\My' \`
  -KeyUsage DigitalSignature \`
  -KeyAlgorithm RSA -KeyLength 2048 \`
  -NotAfter (Get-Date).AddYears(3)
Write-Output ('THUMB=' + $cert.Thumbprint)
`)
  const m = /^THUMB=(.*)$/m.exec(created)
  if (!m) {
    log('✗ 创建证书失败：')
    log(created.trim())
    process.exit(1)
  }
  thumbprint = m[1].trim()
  log(`  ✓ 已创建，指纹 ${thumbprint}`)
  log('  （只放在「当前用户 → 个人」里；没有装进「受信任的根证书颁发机构」）')
}

if (!thumbprint) {
  log('✗ 没拿到证书指纹。')
  process.exit(1)
}

log('')
log(`用证书 ${thumbprint} 签名…`)

/*
 * `signtool` 一般在 Windows SDK 里。找不到就退回 PowerShell 的
 * `Set-AuthenticodeSignature` —— 它不做时间戳，但能签。
 */
const signed = runPs(`
$thumb = '${thumbprint.replace(/'/g, "''")}'
$cert = $null
foreach ($store in 'Cert:\\CurrentUser\\My','Cert:\\LocalMachine\\My') {
  $cert = Get-ChildItem $store -ErrorAction SilentlyContinue |
          Where-Object { $_.Thumbprint -eq $thumb -or $_.Subject -eq $thumb } |
          Select-Object -First 1
  if ($cert) { break }
}
if (-not $cert) { Write-Output 'ERROR=找不到证书'; exit 1 }
Write-Output ('USING=' + $cert.Subject + ' | ' + $cert.Thumbprint)
$r = Set-AuthenticodeSignature -LiteralPath '${SETUP.replace(/'/g, "''")}' -Certificate $cert
Write-Output ('SIGN_STATUS=' + $r.Status)
if ($r.Status -ne 'Valid') {
  Write-Output ('SIGN_MESSAGE=' + $r.StatusMessage)
}
`)

log(signed.trim().split(/\r?\n/).map((l) => '    ' + l).join('\n'))

const s = checkSignature(SETUP)
log('')
log('签名后状态：')
log(`  状态  ：${s.status}`)
log(`  发布者：${s.subject}`)
if (s.thumbprint) log(`  指纹  ：${s.thumbprint}`)

log('')
if (s.status === 'Valid') {
  log('✓ 签名有效。')
} else {
  log(`✗ 签名状态是 "${s.status}"，不是 Valid。`)
  log('  自签名证书未装进「受信任的根证书颁发机构」时，状态会是 UnknownError ——')
  log('  那是**预期的**：我们刻意不往你的信任根里塞证书（反正 SmartScreen 也照样拦）。')
}
log('')
log('提醒：SmartScreen 警告**不会**因为签名而消失（除非发到微软商店或攒够信誉）。')
log('      用户仍需点「更多信息 → 仍要运行」。')
process.exitCode = s.status === 'Valid' || s.status === 'UnknownError' ? 0 : 1
