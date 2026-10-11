// 10 号继续：半透明磨砂（真透明度，背后的颜色会透出来）、去掉袋口虚线；黑白一对（浅色任务栏用黑、深色任务栏用白）；外加开发版 DEV 黄带
import fs from 'node:fs'
const dir = new URL('.', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')
const POCKET = 'M13.3 9.74 A34.09 34.09 0 0 0 34.7 9.74 Q36.76 8.93 38.22 10.56 A17.8 17.8 0 1 1 9.78 10.56 Q11.24 8.93 13.3 9.74 Z'

// 透明度两头：左上（亮、更透）→ 右下（深、实一点）
const OPTS = [
  { k: 'A', name: '较透', a: .55, b: .82 },
  { k: 'B', name: '中等', a: .68, b: .9 },
  { k: 'C', name: '较实', a: .8, b: .96 },
  { k: 'D', name: '中等 + 袋口一道柔光', a: .68, b: .9, mouthGlow: true },
]
const TONE = {
  black: { a: '#5a5e66', b: '#0b0c0e', rim: '#ffffff', rimA: .45, inner: '#ffffff', innerA: .14 },
  white: { a: '#ffffff', b: '#c4c8cf', rim: '#ffffff', rimA: .9, inner: '#ffffff', innerA: .35 },
}
const svg = (o, tone, id, size = 128, dev = false) => {
  const t = TONE[tone]
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="${size}" height="${size}">
<defs>
  <linearGradient id="g${id}" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="${t.a}" stop-opacity="${o.a}"/><stop offset="1" stop-color="${t.b}" stop-opacity="${o.b}"/>
  </linearGradient>
  <linearGradient id="r${id}" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="${t.rim}" stop-opacity="${t.rimA}"/><stop offset=".5" stop-color="${t.rim}" stop-opacity=".05"/><stop offset="1" stop-color="${t.rim}" stop-opacity="${t.rimA * .4}"/>
  </linearGradient>
  <radialGradient id="h${id}" cx=".3" cy=".25" r=".55"><stop offset="0" stop-color="${t.inner}" stop-opacity="${t.innerA}"/><stop offset="1" stop-color="${t.inner}" stop-opacity="0"/></radialGradient>
  <filter id="s${id}" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="2.4" stdDeviation="3" flood-color="#000" flood-opacity=".28"/></filter>
  <filter id="n${id}"><feTurbulence type="fractalNoise" baseFrequency="1.4" numOctaves="2" seed="5"/><feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 .1 0"/><feComposite in2="SourceGraphic" operator="in"/></filter>
  <clipPath id="c${id}"><g transform="translate(12.4 16) scale(2.15)"><path d="${POCKET}"/></g></clipPath>
  <linearGradient id="m${id}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
</defs>
<g transform="translate(12.4 16) scale(2.15)">
  <path d="${POCKET}" fill="url(#g${id})" filter="url(#s${id})"/>
  <path d="${POCKET}" fill="url(#h${id})"/>
  <path d="${POCKET}" fill="none" stroke="url(#r${id})" stroke-width=".8"/>
  ${o.mouthGlow ? `<path d="M13 13.6 Q24 18.2 35 13.6" fill="none" stroke="url(#m${id})" stroke-width="1.2" stroke-linecap="round"/>` : ''}
</g>
<rect width="128" height="128" clip-path="url(#c${id})" filter="url(#n${id})"/>
${dev ? devBadge(id) : ''}
</svg>`
}
// 开发版：右上角一块斜 45° 的圆角小黄条，写 DEV
const devBadge = id => `<g transform="translate(86 42) rotate(45)">
  <rect x="-34" y="-12" width="68" height="24" rx="7" fill="#facc15" filter="url(#s${id})"/>
  <rect x="-31" y="-9" width="62" height="18" rx="5" fill="none" stroke="#fff" stroke-width="1.6" stroke-dasharray="3.2 2.4" opacity=".95"/>
  <text x="0" y="5.6" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-weight="800" font-size="14.5" letter-spacing="1.5" fill="#111">DEV</text>
</g>`

fs.mkdirSync(dir + 'glass', { recursive: true })
for (const o of OPTS) for (const tone of ['black', 'white']) {
  fs.writeFileSync(`${dir}glass/${o.k}-${tone}.svg`, svg(o, tone, `${o.k}${tone}f`))
  fs.writeFileSync(`${dir}glass/${o.k}-${tone}-dev.svg`, svg(o, tone, `${o.k}${tone}d`, 128, true))
}

// 预览：每个选项一行，三种底（浅色任务栏 / 深色任务栏 / 花哨壁纸，用来看透明度），每格放正式版 + 开发版，各三种尺寸
const BGS = [
  { name: '浅色任务栏', css: '#eef0f3', tone: 'black' },
  { name: '深色任务栏', css: '#1b1c1f', tone: 'white' },
  { name: '彩色壁纸上（看透明）', css: 'linear-gradient(135deg,#ff7a7a 0%,#ffcf5c 30%,#5ce1a8 60%,#5c9dff 100%)', tone: 'black' },
  { name: '彩色壁纸上（白款）', css: 'linear-gradient(135deg,#ff7a7a 0%,#ffcf5c 30%,#5ce1a8 60%,#5c9dff 100%)', tone: 'white' },
]
let n = 0
const cell = (o, b) => {
  const id = () => `p${n++}`
  return `<div class="cell" style="background:${b.css}"><div class="lbl" style="color:${b.css === '#1b1c1f' ? '#bbb' : '#333'}">${b.name}</div>
  <div class="pair">${svg(o, b.tone, id(), 112)}${svg(o, b.tone, id(), 112, true)}</div>
  <div class="smalls">${svg(o, b.tone, id(), 32)}${svg(o, b.tone, id(), 16)}<span class="gap"></span>${svg(o, b.tone, id(), 32, true)}${svg(o, b.tone, id(), 16, true)}</div></div>`
}
fs.writeFileSync(dir + 'glass.html', `<!doctype html><meta charset="utf-8"><title>XGTools 图标 · 半透明磨砂</title>
<style>body{margin:0;font-family:system-ui,"Microsoft YaHei",sans-serif;background:#111;color:#ddd}h2{font-size:16px;margin:18px 20px 8px}
.row{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;padding:0 20px}.cell{border-radius:12px;padding:12px;display:flex;flex-direction:column;align-items:center;gap:8px}
.lbl{font-size:12px;align-self:flex-start}.pair{display:flex;gap:14px}.smalls{display:flex;gap:10px;align-items:center}.gap{width:14px}</style>
<p style="margin:16px 20px 0;color:#999;font-size:13px">每格左边是正式版、右边是开发版（DEV 黄带）；下面一排是任务栏 32 和托盘 16 的大小。浅色任务栏用黑款，深色任务栏用白款，应用会自动切换。</p>
${OPTS.map(o => `<h2>${o.k} · ${o.name}</h2><div class="row">${BGS.map(b => cell(o, b)).join('')}</div>`).join('')}`)
console.log('ok')
