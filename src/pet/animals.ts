/**
 * 键盘桌宠的小动物：全部用 SVG 手画，贴纸风（粗深色描边 + 糖果色平涂 + 腮红）。
 *
 * 每只是一个 100×100 的 viewBox：大头（中心 50,54，半径 ~30）+ 露出一点的小身子，
 * 挤在键盘上时身子基本被前排挡住，所以重点全在头上。
 *
 * 画法约定（改样子只改这里）：
 * - 先画「头后面的东西」（耳朵、鬃毛、刺），再画头，再画脸，最后画头顶上的东西（青蛙眼、呆毛）
 * - 眼睛统一包在 <g class="pet-eyes"> 里，桌宠窗口用它做眨眼动画（transform-origin 在眼睛那一行）
 * - 颜色都写在这里，桌宠窗口拿 color 给起跳的拖尾上色
 */

const OL = '#3b2a24' // 描边
const SW = 3.6 // 描边粗细
const BLUSH = '#ff9fb0'

type Animal = { id: string; color: string; svg: string }

const s = (fill: string, extra = '') => `fill="${fill}" stroke="${OL}" stroke-width="${SW}" stroke-linejoin="round" stroke-linecap="round" ${extra}`

/** 小身子：从头底下露出来的一截 */
const body = (fill: string) => `<ellipse cx="50" cy="90" rx="22" ry="12" ${s(fill)} />`

/** 圆头 */
const head = (fill: string, rx = 30, ry = 27) => `<ellipse cx="50" cy="56" rx="${rx}" ry="${ry}" ${s(fill)} />`

/** 眼睛：黑豆眼 + 一点高光；dark=true 用在深色脸上（白眼圈） */
function eyes(opts: { y?: number; gap?: number; dark?: boolean; big?: boolean } = {}) {
  const y = opts.y ?? 55
  const g = opts.gap ?? 10
  const r = opts.big ? 4.4 : 3.4
  const ring = opts.dark ? `<circle cx="${50 - g}" cy="${y}" r="${r + 2.6}" fill="#fff" /><circle cx="${50 + g}" cy="${y}" r="${r + 2.6}" fill="#fff" />` : ''
  return `<g class="pet-eyes" style="transform-origin: 50px ${y}px">${ring}
    <ellipse cx="${50 - g}" cy="${y}" rx="${r * 0.85}" ry="${r}" fill="${OL}" />
    <ellipse cx="${50 + g}" cy="${y}" rx="${r * 0.85}" ry="${r}" fill="${OL}" />
    <circle cx="${50 - g + 1}" cy="${y - 1.4}" r="1.1" fill="#fff" />
    <circle cx="${50 + g + 1}" cy="${y - 1.4}" r="1.1" fill="#fff" /></g>`
}
const blush = (y = 63, gap = 18, c = BLUSH) =>
  `<ellipse cx="${50 - gap}" cy="${y}" rx="5" ry="3" fill="${c}" opacity=".85" /><ellipse cx="${50 + gap}" cy="${y}" rx="5" ry="3" fill="${c}" opacity=".85" />`
/** ω 嘴 */
const mouthW = (y = 62) => `<path d="M44.5 ${y} q2.7 3.4 5.5 0 q2.8 3.4 5.5 0" fill="none" stroke="${OL}" stroke-width="2.2" stroke-linecap="round" />`
/** 张开的小嘴 */
const mouthO = (y = 63, fill = '#ff7a7a') => `<path d="M46 ${y} q4 6 8 0 z" fill="${fill}" stroke="${OL}" stroke-width="2" stroke-linejoin="round" />`
const nose = (y = 60, fill = OL, w = 3.2) => `<ellipse cx="50" cy="${y}" rx="${w}" ry="${w * 0.7}" fill="${fill}" />`

const triEars = (fill: string, inner?: string, spread = 18, h = 22) => `
  <path d="M${50 - spread - 12} 44 L${50 - spread - 4} ${44 - h} L${50 - spread + 10} 36 Z" ${s(fill)} />
  <path d="M${50 + spread + 12} 44 L${50 + spread + 4} ${44 - h} L${50 + spread - 10} 36 Z" ${s(fill)} />
  ${inner ? `<path d="M${50 - spread - 7} 41 L${50 - spread - 3.5} ${44 - h + 7} L${50 - spread + 5} 37.5 Z" fill="${inner}" /><path d="M${50 + spread + 7} 41 L${50 + spread + 3.5} ${44 - h + 7} L${50 + spread - 5} 37.5 Z" fill="${inner}" />` : ''}`
const roundEars = (fill: string, inner?: string, x = 25, y = 33, r = 9) => `
  <circle cx="${50 - x}" cy="${y}" r="${r}" ${s(fill)} /><circle cx="${50 + x}" cy="${y}" r="${r}" ${s(fill)} />
  ${inner ? `<circle cx="${50 - x}" cy="${y}" r="${r * 0.5}" fill="${inner}" /><circle cx="${50 + x}" cy="${y}" r="${r * 0.5}" fill="${inner}" />` : ''}`

const svg = (inner: string) => `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`

export const ANIMALS: Animal[] = [
  { id: 'cat', color: '#ffffff', svg: svg(body('#fff') + triEars('#fff', '#ffc2cf') + head('#fff') + eyes() + blush() + mouthW()) },
  { id: 'blackcat', color: '#4a4140', svg: svg(body('#4a4140') + triEars('#4a4140', '#ff9fb0') + head('#4a4140') + eyes({ dark: true }) + blush(64, 19) + mouthW(63).replace(OL, '#fff')) },
  {
    id: 'tabby', color: '#ffc56b',
    svg: svg(body('#ffc56b') + triEars('#ffc56b', '#ffe2b5') + head('#ffc56b')
      + `<path d="M50 31 v7 M43 32 l1.5 6 M57 32 l-1.5 6" stroke="#e08a2c" stroke-width="3" stroke-linecap="round" />`
      + eyes() + blush() + mouthW()),
  },
  {
    id: 'shiba', color: '#f5a85c',
    svg: svg(body('#f5a85c') + triEars('#f5a85c', '#fff3e4', 17, 20) + head('#f5a85c')
      + `<path d="M24 62 q4 18 26 18 q22 0 26 -18 q-8 6 -14 -2 q-6 -8 -12 0 q-6 -8 -12 0 q-6 8 -14 2z" fill="#fff8ee" />`
      + `<ellipse cx="40" cy="47" rx="3" ry="2" fill="#fff8ee" /><ellipse cx="60" cy="47" rx="3" ry="2" fill="#fff8ee" />`
      + eyes() + nose(61) + mouthW(64) + blush(64, 20)),
  },
  { id: 'bear', color: '#b47a55', svg: svg(body('#b47a55') + roundEars('#b47a55', '#e8c49f') + head('#b47a55') + `<ellipse cx="50" cy="64" rx="11" ry="8" fill="#e8c49f" />` + eyes() + nose(61) + mouthW(65) + blush(62, 21)) },
  {
    id: 'bunny', color: '#ffffff',
    svg: svg(body('#fff')
      + `<path d="M37 40 C30 20 32 6 38 6 C45 6 46 22 44 38 Z" ${s('#fff')} /><path d="M63 40 C70 20 68 6 62 6 C55 6 54 22 56 38 Z" ${s('#fff')} />`
      + `<path d="M38 34 C35 22 36 12 38.5 12 C41 12 41.5 22 41 33 Z" fill="#ffc2cf" /><path d="M62 34 C65 22 64 12 61.5 12 C59 12 58.5 22 59 33 Z" fill="#ffc2cf" />`
      + head('#fff') + eyes() + blush() + mouthW()),
  },
  {
    id: 'panda', color: '#ffffff',
    svg: svg(body('#2f2b2b') + roundEars('#2f2b2b') + head('#fff')
      + `<ellipse cx="39" cy="55" rx="7" ry="8.5" transform="rotate(-20 39 55)" fill="#2f2b2b" /><ellipse cx="61" cy="55" rx="7" ry="8.5" transform="rotate(20 61 55)" fill="#2f2b2b" />`
      + eyes({ gap: 11 }).split(`fill="${OL}"`).join('fill="#fff"').split('r="1.1" fill="#fff"').join(`r="1.1" fill="${OL}"`)
      + nose(63) + mouthW(66) + blush(66, 21)),
  },
  {
    id: 'frog', color: '#8fd16b',
    svg: svg(body('#8fd16b') + `<circle cx="34" cy="34" r="11" ${s('#8fd16b')} /><circle cx="66" cy="34" r="11" ${s('#8fd16b')} />` + head('#8fd16b', 31, 25)
      + `<g class="pet-eyes" style="transform-origin: 50px 33px"><circle cx="34" cy="33" r="5.5" fill="#fff" /><circle cx="66" cy="33" r="5.5" fill="#fff" /><circle cx="35" cy="33.5" r="3" fill="${OL}" /><circle cx="65" cy="33.5" r="3" fill="${OL}" /></g>`
      + `<path d="M36 61 q14 12 28 0" fill="none" stroke="${OL}" stroke-width="2.6" stroke-linecap="round" />` + blush(60, 22)),
  },
  {
    id: 'pig', color: '#ffb3c1',
    svg: svg(body('#ffb3c1') + triEars('#ffb3c1', '#ff8fa6', 16, 14) + head('#ffb3c1')
      + `<ellipse cx="50" cy="63" rx="9" ry="6.5" ${s('#ff9bb0', 'stroke-width="2.6"')} /><ellipse cx="46.5" cy="63" rx="1.6" ry="2.2" fill="${OL}" /><ellipse cx="53.5" cy="63" rx="1.6" ry="2.2" fill="${OL}" />`
      + eyes({ y: 52 }) + blush(60, 20, '#ff7f9c')),
  },
  {
    id: 'chick', color: '#ffe066',
    svg: svg(body('#ffe066') + head('#ffe066')
      + `<path d="M48 30 q-4 -10 2 -12 q-1 6 4 4 q-2 5 -6 8z" ${s('#ffe066', 'stroke-width="2.8"')} />`
      + eyes() + `<path d="M45 61 l5 5 l5 -5 z" ${s('#ff9d3b', 'stroke-width="2.4"')} />` + blush()),
  },
  {
    id: 'penguin', color: '#4a5d75',
    svg: svg(body('#4a5d75') + head('#4a5d75')
      + `<path d="M50 44 C40 34 22 42 24 58 C26 74 40 82 50 82 C60 82 74 74 76 58 C78 42 60 34 50 44 Z" fill="#fff" />`
      + eyes() + `<path d="M45 61 l5 5 l5 -5 z" ${s('#ffa53b', 'stroke-width="2.4"')} />` + blush()),
  },
  {
    id: 'hamster', color: '#f7c690',
    svg: svg(body('#f7c690') + roundEars('#f7c690', '#ffc2cf', 22, 34, 7) + head('#f7c690', 31, 26)
      + `<ellipse cx="50" cy="68" rx="20" ry="12" fill="#fff6ea" />` + eyes() + nose(62, '#ff8fa6', 2.4) + mouthW(65) + blush(64, 22)),
  },
  {
    id: 'sheep', color: '#fffaf2',
    svg: svg(body('#fffaf2')
      + `<g ${s('#fffaf2')}><circle cx="30" cy="40" r="10"/><circle cx="42" cy="31" r="10"/><circle cx="58" cy="31" r="10"/><circle cx="70" cy="40" r="10"/><circle cx="24" cy="56" r="10"/><circle cx="76" cy="56" r="10"/></g>`
      + `<ellipse cx="50" cy="60" rx="20" ry="19" ${s('#f3dccb')} />` + eyes({ y: 58, gap: 8 }) + mouthW(66) + blush(65, 13)),
  },
  {
    id: 'duck', color: '#ffffff',
    svg: svg(body('#fff') + head('#fff') + eyes() + `<ellipse cx="50" cy="64" rx="9" ry="5" ${s('#ffb03b', 'stroke-width="2.6"')} />` + blush(62, 21)),
  },
  {
    id: 'koala', color: '#b9bfc8',
    svg: svg(body('#b9bfc8') + roundEars('#b9bfc8', '#f2f2f4', 26, 38, 13) + head('#b9bfc8', 28, 26)
      + eyes() + `<ellipse cx="50" cy="62" rx="6" ry="7.5" fill="${OL}" />` + blush(64, 18)),
  },
  { id: 'mouse', color: '#cfd3da', svg: svg(body('#cfd3da') + roundEars('#cfd3da', '#ffc2cf', 24, 32, 12) + head('#cfd3da', 28, 26) + eyes() + nose(61, '#ff8fa6', 2.6) + mouthW(64) + blush(63, 19)) },
  {
    id: 'tiger', color: '#ffb54d',
    svg: svg(body('#ffb54d') + roundEars('#ffb54d', '#fff1d6', 23, 33, 8) + head('#ffb54d')
      + `<path d="M50 30 v8 M44 31 l2 6 M56 31 l-2 6 M21 52 h7 M22 60 h6 M79 52 h-7 M78 60 h-6" stroke="${OL}" stroke-width="2.8" stroke-linecap="round" />`
      + `<ellipse cx="50" cy="65" rx="12" ry="8" fill="#fff6e6" />` + eyes() + nose(61) + mouthW(65)),
  },
  {
    id: 'seal', color: '#e3ebf3',
    svg: svg(body('#e3ebf3') + head('#e3ebf3', 31, 27) + eyes({ gap: 11 }) + nose(61, OL, 3)
      + `<path d="M36 63 h-9 M36 66 l-8 3 M64 63 h9 M64 66 l8 3" stroke="${OL}" stroke-width="1.8" stroke-linecap="round" />` + mouthW(64)),
  },
  {
    id: 'capybara', color: '#c08a5b',
    svg: svg(body('#c08a5b') + roundEars('#c08a5b', undefined, 22, 34, 5.5) + `<rect x="21" y="32" width="58" height="50" rx="24" ${s('#c08a5b')} />`
      + `<g class="pet-eyes" style="transform-origin: 50px 50px"><path d="M35 50 h7 M58 50 h7" stroke="${OL}" stroke-width="3" stroke-linecap="round"/></g>`
      + `<ellipse cx="50" cy="66" rx="13" ry="8" fill="#a8744a" /><ellipse cx="45" cy="64" rx="1.8" ry="2.6" fill="${OL}" /><ellipse cx="55" cy="64" rx="1.8" ry="2.6" fill="${OL}" />` + blush(60, 20)),
  },
  {
    id: 'raccoon', color: '#a6a3a8',
    svg: svg(body('#a6a3a8') + triEars('#a6a3a8', '#fff', 16, 16) + head('#a6a3a8')
      + `<path d="M24 54 q12 -9 22 0 q4 3 8 0 q10 -9 22 0 q-4 10 -14 9 q-6 -1 -12 -5 q-6 4 -12 5 q-10 1 -14 -9z" fill="#4b4548" />`
      + `<ellipse cx="50" cy="68" rx="12" ry="8" fill="#fff" />` + eyes({ dark: true }) + nose(64)),
  },
  {
    id: 'maltese', color: '#fffdf8',
    svg: svg(body('#fffdf8') + `<ellipse cx="22" cy="58" rx="9" ry="16" ${s('#fffdf8')} /><ellipse cx="78" cy="58" rx="9" ry="16" ${s('#fffdf8')} />` + head('#fffdf8', 27, 26)
      + `<circle cx="66" cy="34" r="5" ${s('#ff8fb0', 'stroke-width="2.4"')} />` + eyes({ big: true }) + nose(62) + mouthO(65) + blush(64, 18)),
  },
  {
    id: 'lion', color: '#ffd27a',
    svg: svg(body('#ffd27a') + `<circle cx="50" cy="56" r="38" ${s('#e8954a')} />`
      + `<path d="M12 56 l8 -4 M88 56 l-8 -4 M50 18 v8 M23 30 l6 6 M77 30 l-6 6" stroke="${OL}" stroke-width="2.4" stroke-linecap="round" />`
      + head('#ffd27a', 27, 25) + roundEars('#ffd27a', undefined, 21, 36, 6) + eyes() + nose(61) + mouthW(65) + blush(63, 18)),
  },
  {
    id: 'star', color: '#ffd84a',
    svg: svg(`<path d="M50 14 L60 40 L88 41 L66 58 L74 86 L50 70 L26 86 L34 58 L12 41 L40 40 Z" ${s('#ffd84a')} />` + eyes({ y: 52, gap: 8 }) + mouthO(60) + blush(60, 15)),
  },
  {
    id: 'monkey', color: '#a8714d',
    svg: svg(body('#a8714d') + roundEars('#a8714d', '#f3d3b2', 29, 54, 9) + head('#a8714d', 27, 26)
      + `<path d="M50 50 C44 40 30 44 31 58 C32 72 44 78 50 78 C56 78 68 72 69 58 C70 44 56 40 50 50 Z" fill="#f3d3b2" />`
      + eyes({ y: 56, gap: 8 }) + mouthW(67) + blush(66, 15)),
  },
  {
    id: 'axolotl', color: '#ffc1d6',
    svg: svg(body('#ffc1d6')
      + `<g stroke="${OL}" stroke-width="2.6" stroke-linecap="round" fill="#ff8fb5"><path d="M22 48 l-12 -8 M21 56 l-13 0 M22 64 l-12 8 M78 48 l12 -8 M79 56 l13 0 M78 64 l12 8"/></g>`
      + head('#ffc1d6', 30, 25) + eyes({ gap: 13 }) + `<path d="M40 63 q10 7 20 0" fill="none" stroke="${OL}" stroke-width="2.4" stroke-linecap="round" />` + blush(62, 22)),
  },
  {
    id: 'croc', color: '#7cc56a',
    svg: svg(body('#7cc56a') + `<circle cx="38" cy="36" r="8" ${s('#7cc56a')} /><circle cx="62" cy="36" r="8" ${s('#7cc56a')} />` + head('#7cc56a', 31, 26)
      + `<g class="pet-eyes" style="transform-origin: 50px 36px"><circle cx="38" cy="36" r="3.4" fill="${OL}" /><circle cx="62" cy="36" r="3.4" fill="${OL}" /></g>`
      + `<path d="M28 60 q22 12 44 0" fill="#fff" stroke="${OL}" stroke-width="2.6" stroke-linejoin="round" /><path d="M34 62 l3 4 l3 -3 l3 4 l3 -3 l3 4 l3 -3 l3 4 l3 -3 l3 4" fill="none" stroke="${OL}" stroke-width="1.6" />`
      + `<circle cx="45" cy="50" r="1.4" fill="${OL}" /><circle cx="55" cy="50" r="1.4" fill="${OL}" />`),
  },
  {
    id: 'fox', color: '#ff9a4d',
    svg: svg(body('#ff9a4d') + triEars('#ff9a4d', '#4b3a35', 17, 22) + head('#ff9a4d')
      + `<path d="M22 58 q6 16 28 20 q22 -4 28 -20 q-10 6 -16 0 q-6 -6 -12 2 q-6 -8 -12 -2 q-6 6 -16 0z" fill="#fff7ee" />`
      + eyes() + nose(63) + blush(64, 21)),
  },
  {
    id: 'dino', color: '#9dd7f2',
    svg: svg(body('#9dd7f2') + `<path d="M34 34 l6 -10 l6 8 l6 -10 l6 8 l6 -8 l2 12" ${s('#ffd36b', 'stroke-width="2.8"')} />` + head('#9dd7f2')
      + eyes() + mouthO(64) + blush()),
  },
  {
    id: 'whale', color: '#7fb6ff',
    svg: svg(body('#7fb6ff') + `<path d="M50 30 q-6 -10 -12 -6 M50 30 q6 -10 12 -6 M50 30 v-6" fill="none" stroke="#7fb6ff" stroke-width="3" stroke-linecap="round" />` + head('#7fb6ff', 31, 26)
      + `<path d="M24 64 q26 18 52 0 q-2 14 -26 16 q-24 -2 -26 -16z" fill="#e6f1ff" />` + eyes() + mouthW(63) + blush(62, 21)),
  },
]

/** 一只动物的完整 SVG */
export const animalSvg = (id: string) => ANIMALS.find((a) => a.id === id)?.svg ?? ANIMALS[0].svg
