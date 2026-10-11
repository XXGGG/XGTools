/**
 * 文件夹图标:把「文件夹 + 一个图标」画成 SVG,再渲染成 .ico。
 *
 * # 为什么用 SVG 而不是直接画 canvas
 *
 * 磨砂玻璃的做法是「把玻璃后面的东西复制一份、模糊、再盖一层半透明的白」,
 * 这在 SVG 里是 <use> + feGaussianBlur,几行就够;canvas 要自己叠两张离屏图。
 * 而且预览和导出走同一份 SVG,眼睛看到的就是写进 ico 的。
 *
 * # 坐标
 *
 * 一律在 256×256 的画布里算,图标的位置 / 大小用「中心点 + 边长」。
 * 导出 16~256 各尺寸时是**重新用 SVG 渲染**,不是把大图缩小,小尺寸才不糊。
 */

export type Placement = 'top' | 'tuck' | 'bottom'

export interface FolderIconParams {
  /** 文件夹主色 */
  color: string
  /** 渐变的第二种颜色,null 表示单色 */
  color2: string | null
  /** 底面板(文件夹的后板)磨砂半透明 */
  glassBack: boolean
  /** 顶面板(前面板)磨砂半透明;两块都关掉就是不透明的扁平款 */
  glassFront: boolean
  /** 文件夹里露出的白纸 */
  paper: boolean
  /** 两块面板各自有多通透 0~1:0 = 几乎不透,1 = 最透(只在对应的磨砂开关打开时有用) */
  seeBack: number
  seeFront: number
  /** 前面板顶边那一条反光的强度 0~1,0 = 没有 */
  shine: number
  /** 面板四周那圈细轮廓高光的强度 0~1,0 = 没有 */
  rim: number
  /** 沿着文件夹轮廓的一圈细亮边 */
  neon: boolean
  edgeColor: string
  /**
   * 图标在文件夹的哪一层:
   * top = 顶层,盖在前面板上;
   * tuck = 夹层,夹在白纸和前面板之间,下半截隔着玻璃;
   * bottom = 底层,藏在整个文件夹后面,只露出伸到轮廓外的部分
   */
  placement: Placement
  /** 图标:中心点 (x, y)、边长 size、旋转角度 rot,都在 256 画布里 */
  icon: { x: number; y: number; size: number; rot: number }
  /** 像素风图标用,放大不插值,边缘保持锐利 */
  sharp: boolean
}

export interface Swatch { name: string; hex: string }

/** 文件夹颜色:前三个是深色系,后面是马卡龙 */
export const FOLDER_COLORS: Swatch[] = [
  { name: '深空灰', hex: '#6C7078' },
  { name: '高级黑', hex: '#2A2C32' },
  { name: '白', hex: '#F2F3F6' },
  { name: '薄荷', hex: '#8FE3C0' },
  { name: '天空', hex: '#9CCBFF' },
  { name: '粉', hex: '#FFAFC8' },
  { name: '薰衣草', hex: '#C4B1FF' },
  { name: '蜜桃', hex: '#FFC09A' },
  { name: '奶油黄', hex: '#FFE08A' },
  { name: '淡紫', hex: '#E3B5F5' },
  { name: '水蓝', hex: '#8FE0E8' },
]

/** 亮边的颜色 */
export const EDGE_COLORS: Swatch[] = [
  { name: '蓝', hex: '#5B8CFF' },
  { name: '粉', hex: '#FF6FA8' },
  { name: '青', hex: '#27D6C0' },
  { name: '紫', hex: '#9B6BFF' },
  { name: '橙', hex: '#FFA94D' },
  { name: '绿', hex: '#3EDC9A' },
]

export const DEFAULT_PARAMS: FolderIconParams = {
  color: '#6C7078', color2: null, glassBack: false, glassFront: true, paper: true,
  seeBack: 0.42, seeFront: 0.5, shine: 0.5, rim: 0.5, neon: false, edgeColor: '#5B8CFF',
  placement: 'top', icon: { x: 128, y: 162, size: 88, rot: 0 }, sharp: true,
}

/** 文件夹轮廓的正中心(后板顶 48 ~ 底 214),「居中」按钮把图标放到这里 */
export const FOLDER_CENTER = { x: 128, y: 131 } as const

/** 换一层时给个合适的高度:顶层落在前面板里,夹层露上半截,底层只露头 */
export const LAYER_Y: Record<Placement, number> = { top: 162, tuck: 100, bottom: 62 }

export function cloneParams(p: FolderIconParams): FolderIconParams {
  return { ...p, icon: { ...p.icon } }
}

// ------------------------------------------------------------ 颜色小工具

function hex2rgb(c: string): [number, number, number] {
  const s = c.replace('#', '')
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)]
}

/** a → b 混合 t(0~1) */
function mix(a: string, b: string, t: number): string {
  const A = hex2rgb(a), B = hex2rgb(b)
  const v = A.map((x, i) => Math.round(x + (B[i] - x) * t))
  return '#' + v.map(n => n.toString(16).padStart(2, '0')).join('').toUpperCase()
}

/** 感知亮度 0~1,低于 0.5 的当深色处理(光和高光的力度要跟着变) */
function brightness(c: string): number {
  const [r, g, b] = hex2rgb(c)
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255
}

// ------------------------------------------------------------ 画 SVG

const BACK_D = 'M22 66 Q22 48 40 48 H98 Q108 48 114 56 L122 68 H216 Q234 68 234 86 V196 Q234 214 216 214 H40 Q22 214 22 196 Z'
const FRONT_D = 'M22 126 Q22 110 40 110 H216 Q234 110 234 126 V196 Q234 214 216 214 H40 Q22 214 22 196 Z'

/** 没选图标时占位:一个带加号的圆角方块 */
function placeholderGlyph(x: number, y: number, s: number): string {
  const h = s / 2
  return `<g><rect x="${x - h}" y="${y - h}" width="${s}" height="${s}" rx="${s * 0.2}" fill="#fff" fill-opacity="0.85" stroke="#8A8F9C" stroke-width="3"/>`
    + `<path d="M${x - s * 0.22} ${y}H${x + s * 0.22}M${x} ${y - s * 0.22}V${y + s * 0.22}" stroke="#8A8F9C" stroke-width="${Math.max(3, s * 0.07)}" stroke-linecap="round"/></g>`
}

function iconNode(p: FolderIconParams, href: string | null, shadow: boolean): string {
  const { x, y, size, rot } = p.icon
  const f = shadow ? ' filter="url(#fiish)"' : ''
  const inner = href
    ? `<image href="${href}" x="${x - size / 2}" y="${y - size / 2}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid meet"${p.sharp ? ' style="image-rendering:pixelated"' : ''}/>`
    : placeholderGlyph(x, y, size)
  return `<g transform="rotate(${rot} ${x} ${y})"${f}>${inner}</g>`
}

/**
 * @param href 用户选的图标(data URI),null 时画占位
 */
export function buildFolderSvg(p: FolderIconParams, href: string | null): string {
  const main = p.color
  const dark = brightness(main) < 0.5
  const tuck = p.placement === 'tuck'

  let backTop: string, backBot: string, tintA: string, tintB: string
  if (dark) {
    backTop = mix(main, '#000000', 0.15); backBot = mix(main, '#000000', 0.45)
    tintA = mix(main, '#FFFFFF', 0.10); tintB = mix(main, '#000000', 0.20)
  } else {
    backTop = mix(main, '#FFFFFF', 0.10); backBot = mix(main, '#000000', 0.12)
    tintA = mix(main, '#FFFFFF', 0.55); tintB = mix(main, '#FFFFFF', 0.15)
  }
  if (p.color2) {
    backTop = main; backBot = p.color2
    tintA = mix(main, '#FFFFFF', 0.55); tintB = mix(p.color2, '#FFFFFF', 0.25)
  }

  const ec = p.edgeColor

  const defs = `
<linearGradient id="fib" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${backTop}"/><stop offset="1" stop-color="${backBot}"/></linearGradient>
<linearGradient id="fif" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${tintA}"/><stop offset="1" stop-color="${tintB}"/></linearGradient>
<linearGradient id="fig" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="${dark ? 0.22 : 0.55}"/><stop offset="1" stop-color="#fff" stop-opacity="${dark ? 0.04 : 0.12}"/></linearGradient>
<linearGradient id="fip" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#E9E6EE"/></linearGradient>
<filter id="fibl" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="7"/></filter>
<filter id="fiish" x="-30%" y="-30%" width="160%" height="170%"><feDropShadow dx="0" dy="4" stdDeviation="3.5" flood-color="#000" flood-opacity="0.35"/></filter>
<filter id="fisp" x="-10%" y="-10%" width="120%" height="130%"><feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="#000" flood-opacity="0.25"/></filter>
<clipPath id="fifc"><path d="${FRONT_D}"/></clipPath>
<clipPath id="fibc"><path d="${BACK_D}"/></clipPath>
<clipPath id="fibo"><path clip-rule="evenodd" d="M-60 -60 H316 V316 H-60 Z ${BACK_D}"/></clipPath>`

  // 玻璃后面的东西:(底层的图标)+ 后板 + 白纸 + (夹层的图标)。前面板会把它们模糊一份再盖上
  // 底层的图标最先画 = 最靠后,被后板和白纸挡住
  const bottomIcon = p.placement === 'bottom' ? iconNode(p, href, false) : ''
  let behind = ''
  if (p.glassBack) {
    // 后板也是磨砂的:轮廓外面的图标保持清楚,轮廓里面的那一截隔着后板变模糊
    if (bottomIcon) {
      behind += `<g id="fibi">${bottomIcon}</g>`
      behind += `<g clip-path="url(#fibo)"><use href="#fibi"/></g>`
    }
    behind += `<g clip-path="url(#fibc)">`
      + (bottomIcon ? `<use href="#fibi" filter="url(#fibl)"/>` : '')
      + `<path d="${BACK_D}" fill="url(#fib)" fill-opacity="${(1 - p.seeBack * 0.9).toFixed(3)}"/>`
      + `<path d="${BACK_D}" fill="url(#fig)" fill-opacity="0.7"/></g>`
      + `<path d="${BACK_D}" fill="none" stroke="#fff" stroke-opacity="${(dark ? 0.22 : 0.5) * p.rim}" stroke-width="1.5"/>`
  } else {
    behind += bottomIcon + `<path d="${BACK_D}" fill="url(#fib)"/>`
  }
  if (p.paper) {
    behind += `<g filter="url(#fisp)"><rect x="42" y="80" width="172" height="110" rx="7" fill="url(#fip)" transform="rotate(-1.5 128 135)" opacity="0.96"/></g>`
  }
  if (tuck) behind += iconNode(p, href, false)

  let body = `<g id="fibh">${behind}</g>`
  if (p.glassFront) {
    body += `<g clip-path="url(#fifc)"><use href="#fibh" filter="url(#fibl)"/>`
      + `<path d="${FRONT_D}" fill="url(#fif)" fill-opacity="${(1 - p.seeFront * 0.9).toFixed(3)}"/>`
      + `<path d="${FRONT_D}" fill="url(#fig)"/>`
      + `</g>`
    body += `<path d="M40 110.7 H216 Q233 110.7 233.3 126" fill="none" stroke="#fff" stroke-opacity="${(dark ? 0.45 : 0.85) * p.shine}" stroke-width="${(1 + p.shine).toFixed(2)}"/>`
    body += `<path d="${FRONT_D}" fill="none" stroke="#fff" stroke-opacity="${(dark ? 0.18 : 0.35) * p.rim}" stroke-width="1.5"/>`
  } else {
    body += `<path d="${FRONT_D}" fill="url(#fif)"/>`
    body += `<path d="M40 110.7 H216 Q233 110.7 233.3 126" fill="none" stroke="#fff" stroke-opacity="${0.7 * p.shine}" stroke-width="${(1 + p.shine).toFixed(2)}"/>`
  }
  if (p.neon) {
    body += `<path d="${BACK_D}" fill="none" stroke="${ec}" stroke-opacity="0.55" stroke-width="1.6"/>`
    body += `<path d="${FRONT_D}" fill="none" stroke="${ec}" stroke-opacity="0.7" stroke-width="1.6"/>`
  }
  if (p.placement === 'top') body += iconNode(p, href, true)

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256"><defs>${defs}</defs>${body}</svg>`
}

// ------------------------------------------------------------ 渲染成 ico

/** SVG 字符串 → 指定边长的 PNG 字节 */
export async function renderPng(svg: string, px: number): Promise<Uint8Array> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  try {
    const img = new Image()
    img.width = px; img.height = px
    await new Promise<void>((ok, bad) => {
      img.onload = () => ok()
      img.onerror = () => bad(new Error('SVG 渲染失败'))
      img.src = url
    })
    const cv = document.createElement('canvas')
    cv.width = px; cv.height = px
    const ctx = cv.getContext('2d')!
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(img, 0, 0, px, px)
    const blob: Blob = await new Promise((ok, bad) =>
      cv.toBlob(b => (b ? ok(b) : bad(new Error('PNG 编码失败'))), 'image/png'))
    return new Uint8Array(await blob.arrayBuffer())
  } finally {
    URL.revokeObjectURL(url)
  }
}

export const ICO_SIZES = [256, 128, 64, 48, 32, 24, 16]

/** 把几张 PNG 打包成 .ico(Vista 以后的 ico 里可以直接放 PNG) */
export function packIco(images: { size: number; data: Uint8Array }[]): Uint8Array {
  const n = images.length
  const head = 6 + 16 * n
  const total = head + images.reduce((a, b) => a + b.data.length, 0)
  const out = new Uint8Array(total)
  const dv = new DataView(out.buffer)
  dv.setUint16(0, 0, true)
  dv.setUint16(2, 1, true)
  dv.setUint16(4, n, true)
  let off = head
  images.forEach((im, i) => {
    const e = 6 + 16 * i
    out[e] = im.size >= 256 ? 0 : im.size
    out[e + 1] = im.size >= 256 ? 0 : im.size
    out[e + 2] = 0
    out[e + 3] = 0
    dv.setUint16(e + 4, 1, true)
    dv.setUint16(e + 6, 32, true)
    dv.setUint32(e + 8, im.data.length, true)
    dv.setUint32(e + 12, off, true)
    out.set(im.data, off)
    off += im.data.length
  })
  return out
}

export async function buildIco(p: FolderIconParams, href: string | null): Promise<Uint8Array> {
  const svg = buildFolderSvg(p, href)
  const images = await Promise.all(ICO_SIZES.map(async size => ({ size, data: await renderPng(svg, size) })))
  return packIco(images)
}

// ------------------------------------------------------------ 读用户选的图标

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  gif: 'image/gif', svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp',
}

export const ICON_EXTS = Object.keys(MIME)

export function bytesToDataUri(bytes: Uint8Array, path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? 'png'
  let bin = ''
  const CH = 0x8000
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CH))
  }
  return `data:${MIME[ext] ?? 'image/png'};base64,${btoa(bin)}`
}
