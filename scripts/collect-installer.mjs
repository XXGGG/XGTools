/*
  把刚打好的安装包拷到项目根目录的 `安装包/` 下,方便找、方便发给别人。

  Tauri 把产物埋在 `src-tauri/target/release/bundle/nsis/` 里 —— 路径深,
  而且那个目录里堆着历次版本(0.1.0、0.1.2…),每次要翻。这里只做一件事:
  把**当前 package.json 版本**的那个安装包拷出来,顺带按「XGTools_v0.2.0_安装.exe」
  重命名 —— 发给别人时对方一眼知道是什么、哪一版。

  `安装包/` 不进仓库(见 .gitignore):安装包上百 MB,提交进去 .git 会一路胀大而且删不掉。
  发版走 GitHub Releases,这个目录纯粹是本机的取件口。
*/
import { copyFileSync, mkdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const outDir = join(root, '安装包')
const jobs = [
  {
    from: join(root, `src-tauri/target/release/bundle/nsis/XGTools_${version}_x64-setup.exe`),
    to: join(outDir, `XGTools_v${version}_安装.exe`),
  },
  {
    from: join(root, `src-tauri/target/release/bundle/msi/XGTools_${version}_x64_en-US.msi`),
    to: join(outDir, `XGTools_v${version}_安装.msi`),
  },
]

mkdirSync(outDir, { recursive: true })
let found = 0
for (const { from, to } of jobs) {
  if (!existsSync(from)) continue
  copyFileSync(from, to)
  found++
  const mb = (statSync(to).size / 1024 / 1024).toFixed(0)
  console.log(`${to}  (${mb} MB)`)
}
if (!found) {
  console.error(`没找到 v${version} 的安装包 —— 先跑一次 pnpm tauri build`)
  process.exit(1)
}
