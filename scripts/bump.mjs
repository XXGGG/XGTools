#!/usr/bin/env node
// 版本号一把改 —— 复制到项目的 scripts/bump.mjs
//
//   node scripts/bump.mjs patch     0.1.2 -> 0.1.3
//   node scripts/bump.mjs minor     0.1.2 -> 0.2.0
//   node scripts/bump.mjs major     0.1.2 -> 1.0.0
//   node scripts/bump.mjs 1.0.0     直接指定
//   node scripts/bump.mjs patch --dry   只看会改什么，不落盘
//
// 会同步改（存在才改）：
//   package.json                 version
//   src-tauri/tauri.conf.json    version（Tauri v2 顶层 / v1 的 package.version）
//   src-tauri/Cargo.toml         [package] 下的 version
//   README*.md                   shields.io 的 version-vX.Y.Z 徽章（四语全改）
//   CHANGELOG.md                 在 [Unreleased] 下面开一节新的
//
// 不 commit 也不打 tag，最后把命令打印出来给你自己执行。

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { readdirSync } from 'node:fs'

const arg = process.argv[2]
const dry = process.argv.includes('--dry')

if (!arg) {
  console.error('用法: node scripts/bump.mjs patch|minor|major|<版本号> [--dry]')
  process.exit(1)
}

if (!existsSync('package.json')) {
  console.error('✗ 当前目录没有 package.json，请在项目根目录运行')
  process.exit(1)
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const cur = pkg.version
if (!/^\d+\.\d+\.\d+$/.test(cur ?? '')) {
  console.error(`✗ package.json 里的 version 不是 x.y.z：${cur}`)
  process.exit(1)
}

let next
if (/^\d+\.\d+\.\d+$/.test(arg)) {
  next = arg
}
else {
  const [ma, mi, pa] = cur.split('.').map(Number)
  if (arg === 'patch') next = `${ma}.${mi}.${pa + 1}`
  else if (arg === 'minor') next = `${ma}.${mi + 1}.0`
  else if (arg === 'major') next = `${ma + 1}.0.0`
  else {
    console.error(`✗ 不认识的参数：${arg}`)
    process.exit(1)
  }
}

console.log(`\n  v${cur}  ->  v${next}${dry ? '   (dry run，不写盘)' : ''}\n`)

const changed = []
const write = (file, text) => {
  if (!dry) writeFileSync(file, text)
  changed.push(file)
  console.log(`  ✓ ${file}`)
}

// ---- package.json ----
write('package.json', readFileSync('package.json', 'utf8')
  .replace(/("version"\s*:\s*")\d+\.\d+\.\d+(")/, `$1${next}$2`))

// ---- Tauri ----
const tauriConf = 'src-tauri/tauri.conf.json'
if (existsSync(tauriConf)) {
  const raw = readFileSync(tauriConf, 'utf8')
  // v2 顶层 "version"，v1 在 "package": { "version": ... }
  const out = raw.replace(/("version"\s*:\s*")\d+\.\d+\.\d+(")/, `$1${next}$2`)
  if (out !== raw) write(tauriConf, out)
  else console.log(`  - ${tauriConf}（没找到 version 字段，跳过）`)
}

const cargo = 'src-tauri/Cargo.toml'
if (existsSync(cargo)) {
  const raw = readFileSync(cargo, 'utf8')
  // 只动 [package] 段里的第一个 version，别碰依赖的版本
  const out = raw.replace(
    /(\[package\][\s\S]*?\nversion\s*=\s*")\d+\.\d+\.\d+(")/,
    `$1${next}$2`,
  )
  if (out !== raw) write(cargo, out)
  else console.log(`  - ${cargo}（[package] 下没找到 version，跳过）`)
}

// ---- README 徽章（四语全部）----
for (const f of readdirSync('.')) {
  if (!/^README.*\.md$/i.test(f)) continue
  const raw = readFileSync(f, 'utf8')
  const out = raw.replace(/(version-v)\d+\.\d+\.\d+/g, `$1${next}`)
  if (out !== raw) write(f, out)
}

// ---- CHANGELOG ----
if (existsSync('CHANGELOG.md')) {
  const raw = readFileSync('CHANGELOG.md', 'utf8')
  const today = new Date().toISOString().slice(0, 10)
  if (raw.includes(`## [v${next}]`)) {
    console.log(`  - CHANGELOG.md（已经有 v${next} 这一节，跳过）`)
  }
  else if (raw.includes('## [Unreleased]')) {
    write('CHANGELOG.md', raw.replace(
      '## [Unreleased]',
      `## [Unreleased]\n\n## [v${next}] - ${today}\n\n### Added\n\n### Changed\n\n### Fixed\n`,
    ))
  }
  else {
    console.log('  - CHANGELOG.md（没有 [Unreleased] 小节，自己加一节吧）')
  }
}

if (!changed.length) {
  console.log('  什么都没改，检查一下文件对不对')
  process.exit(1)
}

console.log(`\n改完 ${changed.length} 个文件。CHANGELOG 里的空小节记得填。接下来：\n`)
console.log(`  git add -A`)
console.log(`  git commit -m "🧹 chore: 版本号进到 v${next}"`)
console.log(`  git tag v${next} && git push origin main --tags\n`)
