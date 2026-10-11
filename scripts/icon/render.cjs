// 百宝袋图标（2026-10-11 定稿：半透明磨砂 D 款，黑白一对 + 开发版 DEV 黄带）。
// 先 node scripts/icon/gen-glass.mjs 生成 SVG（输出在同目录 glass/），再 node scripts/icon/render.cjs 渲 PNG（输出 final/），
// 然后把 final/taskbar-*.png 拷进 src-tauri/icons，app-icon-1024.png 交给 pnpm run tauri icon。
// 渲染用的是 resvg-js（这里借 XGBlog 装好的那份，路径不在就 pnpm add -D @resvg/resvg-js 再改这一行）。
// 把选定的 D 款 SVG 渲成 PNG：任务栏/托盘用的 64px（黑白、正式/开发）+ 应用图标源图 1024px（白款）+ 预览
const fs = require('fs')
const path = require('path')
const { Resvg } = require('C:/XGCode/XGBlog/node_modules/.pnpm/@resvg+resvg-js@2.6.2/node_modules/@resvg/resvg-js')
const dir = __dirname
const out = path.join(dir, 'final')
fs.mkdirSync(out, { recursive: true })
const render = (svgFile, size, dest) => {
  // 正式图标让口袋撑大到约 82% 宽（预览页里的尺寸偏小，托盘上会显得小），DEV 黄条跟着挪
  const svg = fs.readFileSync(path.join(dir, 'glass', svgFile), 'utf8')
    .split('translate(12.4 16) scale(2.15)').join('translate(-24.8 -25.9) scale(3.7)')
    .replace('translate(86 42) rotate(45)', 'translate(94 30) rotate(45)')
  const r = new Resvg(svg, { fitTo: { mode: 'width', value: size }, font: { loadSystemFonts: true, defaultFontFamily: 'Segoe UI' }, background: 'rgba(0,0,0,0)' })
  fs.writeFileSync(path.join(out, dest), r.render().asPng())
}
render('D-white.svg', 64, 'taskbar-white.png')
render('D-black.svg', 64, 'taskbar-black.png')
render('D-white-dev.svg', 64, 'taskbar-white-dev.png')
render('D-black-dev.svg', 64, 'taskbar-black-dev.png')
render('D-white.svg', 1024, 'app-icon-1024.png')
render('D-black.svg', 256, 'preview-black-256.png')
render('D-white-dev.svg', 256, 'preview-white-dev-256.png')
render('D-black-dev.svg', 256, 'preview-black-dev-256.png')
console.log('ok', fs.readdirSync(out))
