/**
 * 发布 GitHub Release（按 package.json 的版本号）。
 *
 * 为什么要这个脚本：创建 Release 需要 GitHub token，而本机 git 的 HTTPS 凭据
 * 可能不可用（git credential fill 走不通时），所以把它做成"你自己给 token 跑一次"。
 *
 * 用法（PowerShell）：
 *   $env:GITHUB_TOKEN = 'ghp_xxx'      # 需要 repo 权限（Fine-grained: Contents: Read and write）
 *   node scripts/dev/publish-release.mjs
 *
 * 会做的事：
 *   1. 读 package.json 的 version → 标签 v<version>
 *   2. 校验 dist/release/dsh-pet-ds.tgz 与 dist/dsh-pet-ds-<version>.tgz
 *   3. 创建/复用 Release，上传两个附件（固定名 + 版本化名）
 *   4. 打印 releases/latest/download 链接，可直接交给 install_bundle
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const VERSION = pkg.version
const TAG = `v${VERSION}`

/* 仓库地址从 package.json 的 repository 字段推出来，避免写死。 */
const repoField = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url ?? ''
const m = /github\.com[/:]([^/]+)\/([^/.]+)/.exec(repoField)
if (!m) {
  console.error('✗ package.json 里没有可解析的 GitHub 仓库地址')
  process.exit(1)
}
const [, OWNER, REPO] = m

const token = (process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '').trim()
if (!token) {
  console.error('✗ 没给 token。先设环境变量：')
  console.error("    $env:GITHUB_TOKEN = 'ghp_...'")
  process.exit(1)
}

const ASSETS = [
  { path: join(ROOT, 'dist', 'release', 'dsh-pet-ds.tgz'), name: 'dsh-pet-ds.tgz' },
  { path: join(ROOT, 'dist', `dsh-pet-ds-${VERSION}.tgz`), name: `dsh-pet-ds-${VERSION}.tgz` },
]

for (const a of ASSETS) {
  if (!existsSync(a.path)) {
    console.error(`✗ 缺产物：${a.path}（先跑 node scripts/dev/build-package.mjs）`)
    process.exit(1)
  }
}

/* 发布说明：RELEASE-NOTES-v<ver>.md 存在就用它 */
const notesPath = join(ROOT, 'docs', `RELEASE-NOTES-${TAG}.md`)
const notes = existsSync(notesPath) ? readFileSync(notesPath, 'utf8') : `## ${TAG}\n\n见 CHANGELOG.md`
const body = `## 安装（复制其中一条交给 \`install_bundle\`）

\`\`\`
https://github.com/${OWNER}/${REPO}/releases/latest/download/dsh-pet-ds.tgz
\`\`\`

> 永远指向最新一版；单个 tarball（约 33 MB），**不会克隆仓库**。
> 想锁死版本：\`https://github.com/${OWNER}/${REPO}/archive/refs/tags/${TAG}.tar.gz\`

---

${notes}`

const api = (path, init = {}) =>
  fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'dsh-pet-release',
      ...(init.headers ?? {}),
    },
  })

console.log(`  仓库 ${OWNER}/${REPO}　标签 ${TAG}`)

let release = null
const existing = await api(`/repos/${OWNER}/${REPO}/releases/tags/${TAG}`)
if (existing.status === 200) {
  release = await existing.json()
  console.log(`  release ${TAG} 已存在（id=${String(release.id)}），复用`)
} else {
  const res = await api(`/repos/${OWNER}/${REPO}/releases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag_name: TAG, name: TAG, body, draft: false, prerelease: false }),
  })
  if (!res.ok) {
    console.error(`✗ 创建失败：HTTP ${String(res.status)}\n${(await res.text()).slice(0, 400)}`)
    process.exit(1)
  }
  release = await res.json()
  console.log(`  ✓ 已创建 release ${TAG}（id=${String(release.id)}）`)
}

for (const a of ASSETS) {
  for (const old of release.assets ?? []) {
    if (old.name === a.name) {
      const del = await api(`/repos/${OWNER}/${REPO}/releases/assets/${String(old.id)}`, { method: 'DELETE' })
      console.log(`  删除旧附件 ${old.name}：HTTP ${String(del.status)}`)
    }
  }
  console.log(`  上传 ${a.name}（${(statSync(a.path).size / 1024 / 1024).toFixed(1)} MB）…`)
  const up = await fetch(
    `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${String(release.id)}/assets?name=${encodeURIComponent(a.name)}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
        'User-Agent': 'dsh-pet-release',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: readFileSync(a.path),
    },
  )
  if (!up.ok) {
    console.error(`✗ 上传失败：HTTP ${String(up.status)}\n${(await up.text()).slice(0, 300)}`)
    process.exit(1)
  }
  const done = await up.json()
  console.log(`  ✓ ${done.name}  ${(done.size / 1024 / 1024).toFixed(1)} MB`)
}

console.log('')
console.log(`  完成。最新版安装地址：`)
console.log(`    https://github.com/${OWNER}/${REPO}/releases/latest/download/dsh-pet-ds.tgz`)
