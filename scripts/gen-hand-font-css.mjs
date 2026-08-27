/**
 * 从 @excalidraw/excalidraw 里扒出手写字体的分片信息，生成 public/fonts/handwriting.css。
 *
 * # 为什么要这么绕
 *
 * 笔记页那几档手写体（手绘风 / 漫画体 / 圆体）用的就是画布里那几款 ——
 * 两边同一套字，一张图里的字和正文里的字才像出自同一支笔。
 *
 * 小赖是中文字体，完整版 22MB。Excalidraw 已经把它切成 209 个按 Unicode 区间
 * 分片的 woff2，浏览器只会下载真正用到的那几片（Google Fonts 给中文字体也是这么干的）。
 * 直接引完整版等于为几个汉字下载 22MB。
 *
 * 分片文件名带内容哈希，升级 excalidraw 之后会全变 —— 所以这份 CSS 不能手写，
 * 必须能一键重新生成。
 *
 * # 怎么用
 *
 *     node scripts/gen-hand-font-css.mjs
 *
 * `pnpm dev` 和 `pnpm build` 前面都会自动跑一次，平时不用管。
 *
 * 顺带把字体文件从 node_modules 拷进 public/excalidraw/。
 * **那 14MB 不进仓库** —— 它是 node_modules 的副本，提交进去等于给 .git
 * 永久加 14MB，而且升级 excalidraw 之后还得记得手动重拷。生成出来的最保险。
 *
 * # 授权
 *
 * Excalifont：SIL OFL 1.1（Excalidraw 官方）
 * Comic Shanns：MIT
 * Nunito：SIL OFL 1.1（Google Fonts）
 * 小赖字体 Xiaolai：SIL OFL 1.1（基于濑户字体）
 * 四款都允许随软件打包分发，OFL 那几款只要不单独把字体拿去卖就行。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DIST = 'node_modules/@excalidraw/excalidraw/dist/prod'
const WANT = ['Excalifont', 'ComicShanns', 'Nunito', 'Xiaolai']

/** 找到那个塞着字体描述的 chunk。文件名带哈希，只能按内容认 */
function findChunk() {
  for (const f of readdirSync(DIST)) {
    if (!f.endsWith('.js')) continue
    const text = readFileSync(join(DIST, f), 'utf8')
    if (text.includes('./fonts/Excalifont/')) return text
  }
  throw new Error('没找到带字体描述的 chunk —— excalidraw 的打包结构可能变了')
}

const src = findChunk()

/*
  压缩后的代码长这样：

      var ec="./fonts/Excalifont/Excalifont-Regular-a88b….woff2";
      var sc=[{uri:ec,descriptors:{unicodeRange:"U+20-7e,…"}}, …];

  先把「变量名 → 文件路径」收起来，再去 uri/unicodeRange 的配对里查。
*/
const paths = new Map()
for (const m of src.matchAll(/var (\w+)\s*=\s*"(\.\/fonts\/[^"]+\.woff2)"/g)) {
  paths.set(m[1], m[2])
}

/*
  区间有两种写法：拉丁系的字体引用一张共用表（`tn.LATIN` 这种），
  中文那种一片一个区间的则直接写字面量。两种都得认。
*/
const named = new Map()
const table = /\w+=\{LATIN:"/.exec(src)
if (!table) throw new Error('没找到那张共用的 unicode 区间表')
for (const m of src.slice(table.index, table.index + 2000).matchAll(/(\w+):"(U\+[^"]+)"/g)) {
  named.set(m[1], m[2])
}

const faces = new Map(WANT.map((f) => [f, []]))
for (const m of src.matchAll(/\{uri:(\w+),descriptors:\{unicodeRange:(?:"([^"]+)"|\w+\.(\w+))(,weight:"(\d+)")?\}\}/g)) {
  const path = paths.get(m[1])
  if (!path) continue
  const family = WANT.find((f) => path.includes(`/fonts/${f}/`))
  if (!family) continue
  const range = m[2] ?? named.get(m[3])
  if (!range) throw new Error(`区间 ${m[3]} 查不到`)
  /*
    一律挂成 400。

    Nunito 在 excalidraw 里是按 500 声明的,而正文用的是常规字重 ——
    照抄 500 的话浏览器找不到 400,会自己合成一个假的细体,笔画会发虚。
  */
  faces.get(family).push({ path: path.replace('./fonts/', ''), range })
}

for (const [family, list] of faces) {
  if (!list.length) throw new Error(`${family} 一个分片都没解析出来 —— 结构变了，别生成半份 CSS`)
}

const rules = []
for (const [family, list] of faces) {
  for (const { path, range } of list) {
    rules.push(
      `@font-face {\n`
      + `  font-family: '${family}';\n`
      + `  src: url('/excalidraw/fonts/${path}') format('woff2');\n`
      + `  font-weight: 400;\n`
      + `  font-display: swap;\n`
      + `  unicode-range: ${range};\n`
      + `}`,
    )
  }
}

/*
  字体文件本体也拷一份到 public/。

  vite 只发布 public/ 底下的东西,node_modules 里的进不了打包产物;
  而这是个离线应用,不能像网页那样去 CDN 拉。
  已经拷过就跳过 —— 14MB 每次启动都拷一遍太慢。
*/
const FONT_DEST = 'public/excalidraw/fonts'
if (!existsSync(FONT_DEST) || !readdirSync(FONT_DEST).length) {
  mkdirSync('public/excalidraw', { recursive: true })
  cpSync(join(DIST, 'fonts'), FONT_DEST, { recursive: true })
  console.log('字体已拷到 ' + FONT_DEST)
}

const out = `/*
 * 自动生成，别手改 —— 跑 \`node scripts/gen-hand-font-css.mjs\` 重新生成。
 *
 * 笔记页那几档手写体用的字体，和画布是同一套：
 *   Excalifont（英文，SIL OFL 1.1，Excalidraw 官方）
 *   Comic Shanns（英文，MIT）
 *   Nunito（英文，SIL OFL 1.1，Google Fonts）
 *   小赖字体 Xiaolai（中文，SIL OFL 1.1，基于濑户字体）
 *
 * 按 Unicode 区间切成 ${rules.length} 片，浏览器只下载真正用到的那几片。
 * 字体文件本体在 public/excalidraw/fonts/，和画布共用一份，不重复占地方。
 */

${rules.join('\n\n')}
`

writeFileSync('public/fonts/handwriting.css', out, 'utf8')
console.log(`写好了 public/fonts/handwriting.css —— ${rules.length} 条 @font-face`)
for (const [family, list] of faces) console.log(`  ${family}: ${list.length} 片`)
