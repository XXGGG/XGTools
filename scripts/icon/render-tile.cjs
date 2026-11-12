// 百宝袋图标 · 圆角深色底板版（2026-11-12 用户定：整个 App 图标换成 README 顶上那张 ——
// 深色圆角矩形里放白色磨砂口袋）。应用图标、任务栏、托盘都用这一张，深浅色任务栏上都看得清，
// 所以任务栏不用再按深浅色换黑白两款（taskbar-white/black 两张现在是同一张图）。
//
// 用法：先 node scripts/icon/gen-glass.mjs（生成 glass/ 里的口袋 SVG），再 node scripts/icon/render-tile.cjs，
// 然后 pnpm tauri icon scripts/icon/final/app-icon-1024.png，最后把 final/taskbar-*.png 拷进 src-tauri/icons。
// 渲染借 XGBlog 装好的 resvg-js（路径不在就 pnpm add -D @resvg/resvg-js 再改这一行）。
const fs = require('fs')
const path = require('path')
const { Resvg } = require('C:/XGCode/XGBlog/node_modules/.pnpm/@resvg+resvg-js@2.6.2/node_modules/@resvg/resvg-js')
const dir = __dirname
const out = path.join(dir, 'final')
fs.mkdirSync(out, { recursive: true })

// 口袋路径外框 x 6.2~41.8、y 8.9~39.1，中心 (24, 24)。scale 2.45 时口袋宽约 87，占 128 画布的 68%，和 README 那张一样
const POCKET_SCALE = 2.45
// 底板：整张画布留 margin 的边，圆角半径约 22%（和 README 那张、macOS 的圆角接近）
const tile = (margin) => {
  const s = 128 - margin * 2
  const r = (s * 0.225).toFixed(2)
  return `<linearGradient id="tileG" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#232327"/><stop offset="1" stop-color="#0d0d0f"/></linearGradient>
  <linearGradient id="tileRim" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".16"/><stop offset=".35" stop-color="#fff" stop-opacity="0"/></linearGradient>
</defs>
<rect x="${margin}" y="${margin}" width="${s}" height="${s}" rx="${r}" fill="url(#tileG)"/>
<rect x="${margin + 0.5}" y="${margin + 0.5}" width="${s - 1}" height="${s - 1}" rx="${r}" fill="none" stroke="url(#tileRim)" stroke-width="1"/>`
}

const render = (svgFile, size, dest, margin) => {
  const tx = (64 - 24 * POCKET_SCALE).toFixed(2)
  const ty = (63 - 24 * POCKET_SCALE).toFixed(2)
  const svg = fs.readFileSync(path.join(dir, 'glass', svgFile), 'utf8')
    .split('translate(12.4 16) scale(2.15)').join(`translate(${tx} ${ty}) scale(${POCKET_SCALE})`)
    .replace('</defs>', tile(margin))
    .replace('translate(86 42) rotate(45)', 'translate(92 34) rotate(45)')
  const r = new Resvg(svg, { fitTo: { mode: 'width', value: size }, font: { loadSystemFonts: true, defaultFontFamily: 'Segoe UI' }, background: 'rgba(0,0,0,0)' })
  fs.writeFileSync(path.join(out, dest), r.render().asPng())
}

// 应用图标源图：四周留一点边（约 3%），桌面和开始菜单上不会显得比别的图标大一圈
render('D-white.svg', 1024, 'app-icon-1024.png', 4)
// 任务栏 / 托盘：64px，几乎铺满，小尺寸下尽量大
for (const tone of ['white', 'black']) {
  render('D-white.svg', 64, `taskbar-${tone}.png`, 1)
  render('D-white-dev.svg', 64, `taskbar-${tone}-dev.png`, 1)
}
render('D-white.svg', 256, 'preview-tile-256.png', 4)
render('D-white-dev.svg', 256, 'preview-tile-dev-256.png', 4)
console.log('ok', fs.readdirSync(out))
