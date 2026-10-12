/**
 * 键盘桌宠的小动物：用 Canvas 一笔一笔「手绘」，不用 SVG（2026-10-12 用户要的手绘粗糙感）。
 *
 * 手绘感从哪来：
 * - 形状不是正圆：每个轮廓先采样一圈点，半径加一点低频抖动，再用 Catmull-Rom 平滑连起来，
 *   像手画的圆 —— 有点歪、不完全闭合的那种
 * - 描边画两遍：一遍粗、一遍细且再抖一点，像铅笔描了两次
 * - 上色和描边故意错开一点点（手涂颜色不会刚好贴着线）
 * - 腮红是一团淡粉加几笔斜线
 *
 * 每只动物画两张：睁眼一张、闭眼一张，桌宠用它们交替做眨眼。随机数按动物 id 播种，
 * 所以每次打开画出来都一样，不会每次换一张脸。
 *
 * 坐标系统一 100×100：头在中间偏下（50, 58），身子在最下面只露一截。
 */

const OL = '#3d2b22' // 描边颜色
const BLUSH = 'rgba(255, 130, 150, 0.55)'

type Pt = [number, number]

/** 可重复的随机数 */
function rng(seed: number) {
  let s = seed >>> 0 || 1
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296)
}
function hashStr(str: string) {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619)
  return h >>> 0
}

class Sketch {
  r: () => number
  constructor(public ctx: CanvasRenderingContext2D, public k: number, seed: number) {
    this.r = rng(seed)
  }
  /** 低频抖动：几个随机相位的正弦叠起来，沿着轮廓慢慢变化，不会一跳一跳 */
  wobbleFn(amp: number) {
    const p1 = this.r() * 6.28, p2 = this.r() * 6.28, f1 = 2 + Math.floor(this.r() * 2), f2 = 3 + Math.floor(this.r() * 3)
    return (t: number) => amp * (Math.sin(t * 6.283 * f1 + p1) * 0.65 + Math.sin(t * 6.283 * f2 + p2) * 0.35)
  }
  private trace(pts: Pt[], closed: boolean, jitter = 0) {
    const c = this.ctx, k = this.k, n = pts.length
    const P = pts.map(([x, y]) => [(x + (this.r() - 0.5) * jitter) * k, (y + (this.r() - 0.5) * jitter) * k] as Pt)
    const at = (i: number) => (closed ? P[(i + n) % n] : P[Math.max(0, Math.min(n - 1, i))])
    c.beginPath()
    c.moveTo(P[0][0], P[0][1])
    const last = closed ? n : n - 1
    for (let i = 0; i < last; i++) {
      const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2)
      c.bezierCurveTo(p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6, p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6, p2[0], p2[1])
    }
    if (closed) c.closePath()
  }
  /** 填色 + 两遍描边 */
  shape(pts: Pt[], fill: string | null, opts: { stroke?: boolean; lw?: number; closed?: boolean; ink?: string } = {}) {
    const c = this.ctx, closed = opts.closed !== false
    if (fill) {
      // 颜色故意错开一点
      c.save()
      c.translate((this.r() - 0.5) * 0.8 * this.k, (this.r() - 0.5) * 0.8 * this.k)
      this.trace(pts, closed)
      c.fillStyle = fill
      c.fill()
      c.restore()
    }
    if (opts.stroke === false) return
    const lw = (opts.lw ?? 3.1) * this.k
    c.strokeStyle = opts.ink ?? OL
    c.lineCap = 'round'
    c.lineJoin = 'round'
    c.lineWidth = lw
    this.trace(pts, closed, 0.5)
    c.stroke()
    c.globalAlpha = 0.55
    c.lineWidth = lw * 0.45
    this.trace(pts, closed, 1.6)
    c.stroke()
    c.globalAlpha = 1
  }
  /** 一圈抖动过的椭圆点 */
  ell(cx: number, cy: number, rx: number, ry: number, wob = 1.1, rot = 0, n = 26): Pt[] {
    const w = this.wobbleFn(wob)
    const out: Pt[] = []
    for (let i = 0; i < n; i++) {
      const t = i / n, a = t * Math.PI * 2
      const rr = 1 + w(t) / Math.max(rx, ry)
      const x = Math.cos(a) * rx * rr, y = Math.sin(a) * ry * rr
      out.push([cx + x * Math.cos(rot) - y * Math.sin(rot), cy + x * Math.sin(rot) + y * Math.cos(rot)])
    }
    return out
  }
  /** 麻薯头：下半边比上半边宽一点，比正圆软 */
  mochi(cx: number, cy: number, rx: number, ry: number, wob = 1.2): Pt[] {
    return this.ell(cx, cy, rx, ry, wob).map(([x, y]) => {
      const dy = (y - cy) / ry
      return [cx + (x - cx) * (1 + 0.07 * dy), y] as Pt
    })
  }
  /** 圆角三角形（耳朵）：每条边取三个点，平滑一连角就圆了 */
  tri(a: Pt, b: Pt, c: Pt): Pt[] {
    const out: Pt[] = []
    for (const [p, q] of [[a, b], [b, c], [c, a]] as [Pt, Pt][]) {
      for (const t of [0.2, 0.5, 0.8]) out.push([p[0] + (q[0] - p[0]) * t + (this.r() - 0.5) * 0.8, p[1] + (q[1] - p[1]) * t + (this.r() - 0.5) * 0.8])
    }
    return out
  }
  line(pts: Pt[], lw = 2.2, ink = OL) {
    this.shape(pts, null, { closed: false, lw, ink })
  }
  dot(cx: number, cy: number, r: number, fill: string) {
    this.shape(this.ell(cx, cy, r, r * 1.1, 0.25, 0, 12), fill, { stroke: false })
  }
}

type FaceOpts = { y?: number; gap?: number; mouth?: 'w' | 'o' | 'v' | 'smile' | 'none'; blush?: boolean; light?: boolean; eyeR?: number }

/** 眨眼那部分单独开一支「笔」：睁眼、闭眼画的笔画数不一样，共用一支的话后面的线条随机数会错位，一眨眼整张脸都在抖 */
const sub = (s: Sketch) => new Sketch(s.ctx, s.k, Math.floor(s.r() * 1e9))

function face(parent: Sketch, blink: boolean, o: FaceOpts = {}) {
  const eyeS = sub(parent)
  const s = sub(parent)
  const y = o.y ?? 58, g = o.gap ?? 10, er = o.eyeR ?? 3.3
  const ink = o.light ? '#fff' : OL
  for (const x of [50 - g, 50 + g]) {
    if (blink) eyeS.line([[x - 3.6, y], [x, y + 1.6], [x + 3.6, y]], 2.2, ink)
    else {
      eyeS.dot(x, y, er, ink)
      eyeS.dot(x + 1.1, y - 1.3, 1.05, o.light ? OL : '#fff')
    }
  }
  if (o.blush !== false) {
    for (const x of [50 - g - 8, 50 + g + 8]) {
      s.shape(s.ell(x, y + 6, 5.2, 3.1, 0.3), BLUSH, { stroke: false })
      for (const d of [-2.4, 0, 2.4]) s.shape([[x + d - 1, y + 7.2], [x + d + 1, y + 4.8]], null, { closed: false, lw: 1.1, ink: 'rgba(230, 90, 110, 0.7)' })
    }
  }
  const my = y + 6
  if (o.mouth === 'w' || o.mouth === undefined) s.line([[46, my], [48, my + 2.4], [50, my], [52, my + 2.4], [54, my]], 2)
  else if (o.mouth === 'v') s.line([[47.5, my], [50, my + 2], [52.5, my]], 2)
  else if (o.mouth === 'smile') s.line([[44, my - 0.5], [50, my + 3.5], [56, my - 0.5]], 2.2)
  else if (o.mouth === 'o') s.shape([[46.5, my - 0.5], [50, my - 1], [53.5, my - 0.5], [52.5, my + 3.6], [47.5, my + 3.6]], '#ff8a86', { lw: 1.8 })
}

type Draw = (s: Sketch, blink: boolean) => void
type Animal = { id: string; color: string; draw: Draw }

const body = (s: Sketch, c: string) => s.shape(s.ell(50, 93, 21, 11, 0.8), c)
const head = (s: Sketch, c: string, rx = 30, ry = 26) => s.shape(s.mochi(50, 58, rx, ry), c)
const pointyEars = (s: Sketch, c: string, inner?: string, lift = 0) => {
  for (const m of [-1, 1]) {
    const X = (x: number) => 50 + m * (x - 50)
    s.shape(s.tri([X(23), 50], [X(26), 22 - lift], [X(45), 36]), c)
    if (inner) s.shape(s.tri([X(28), 44], [X(29.5), 30 - lift], [X(40), 37.5]), inner, { stroke: false })
  }
}
const roundEars = (s: Sketch, c: string, inner?: string, x = 24, y = 36, r = 9) => {
  for (const m of [-1, 1]) {
    s.shape(s.ell(50 + m * x, y, r, r * 0.95, 0.5), c)
    if (inner) s.shape(s.ell(50 + m * x, y + 0.5, r * 0.5, r * 0.45, 0.3), inner, { stroke: false })
  }
}
const floppyEars = (s: Sketch, c: string, rot = 0.35) => {
  for (const m of [-1, 1]) s.shape(s.ell(50 + m * 28, 56, 8, 15, 0.7, m * rot), c)
}

export const ANIMALS: Animal[] = [
  // ── 后排 QWERTYUIOP ──
  { id: 'bunny', color: '#ffffff', draw: (s, b) => {
    body(s, '#fff')
    for (const m of [-1, 1]) {
      s.shape(s.ell(50 + m * 11, 22, 6.5, 17, 0.6, m * 0.12), '#fff')
      s.shape(s.ell(50 + m * 11, 24, 3, 11, 0.3, m * 0.12), '#ffc4d0', { stroke: false })
    }
    head(s, '#fff'); face(s, b)
  } },
  { id: 'shiba', color: '#f2a65a', draw: (s, b) => {
    body(s, '#f2a65a'); pointyEars(s, '#f2a65a', '#fff2e0'); head(s, '#f2a65a')
    s.shape(s.ell(50, 70, 21, 12, 0.8), '#fff7ec', { stroke: false })
    s.shape(s.ell(40, 49, 3, 2, 0.2), '#fff7ec', { stroke: false }); s.shape(s.ell(60, 49, 3, 2, 0.2), '#fff7ec', { stroke: false })
    face(s, b); s.dot(50, 62.5, 2.4, OL)
  } },
  { id: 'panda', color: '#ffffff', draw: (s, b) => {
    body(s, '#3a3434'); roundEars(s, '#3a3434'); head(s, '#fff')
    s.shape(s.ell(39, 58, 6.5, 8, 0.5, -0.4), '#3a3434', { stroke: false }); s.shape(s.ell(61, 58, 6.5, 8, 0.5, 0.4), '#3a3434', { stroke: false })
    face(s, b, { gap: 11, light: true, mouth: 'v' }); s.dot(50, 63, 2.2, OL)
  } },
  { id: 'frog', color: '#93d26e', draw: (s, b) => {
    body(s, '#93d26e'); s.shape(s.ell(35, 38, 10, 9.5, 0.6), '#93d26e'); s.shape(s.ell(65, 38, 10, 9.5, 0.6), '#93d26e')
    head(s, '#93d26e', 31, 24)
    const e = sub(s)
    for (const x of [35, 65]) {
      if (b) e.line([[x - 4, 38], [x, 39.5], [x + 4, 38]], 2.2)
      else { e.dot(x, 38, 5, '#fff'); e.dot(x + 0.5, 38.5, 2.8, OL) }
    }
    s.line([[38, 64], [44, 68], [50, 69], [56, 68], [62, 64]], 2.4)
    for (const x of [30, 70]) s.shape(s.ell(x, 62, 5, 3, 0.3), BLUSH, { stroke: false })
  } },
  { id: 'cat', color: '#ffffff', draw: (s, b) => { body(s, '#fff'); pointyEars(s, '#fff', '#ffc4d0'); head(s, '#fff'); face(s, b) } },
  { id: 'bear', color: '#b07a52', draw: (s, b) => {
    body(s, '#b07a52'); roundEars(s, '#b07a52', '#e6c29c'); head(s, '#b07a52')
    s.shape(s.ell(50, 66, 10, 7.5, 0.5), '#e6c29c'); face(s, b, { mouth: 'none', gap: 11 }); s.dot(50, 63.5, 2.5, OL)
    s.line([[47.5, 67], [50, 69], [52.5, 67]], 1.8)
  } },
  { id: 'hamster', color: '#f6c48c', draw: (s, b) => {
    body(s, '#f6c48c'); roundEars(s, '#f6c48c', '#ffc4d0', 21, 37, 7); head(s, '#f6c48c', 31, 25)
    s.shape(s.ell(50, 71, 19, 10, 0.6), '#fff6ea', { stroke: false }); face(s, b, { mouth: 'v' })
  } },
  { id: 'pig', color: '#ffb6c4', draw: (s, b) => {
    body(s, '#ffb6c4'); pointyEars(s, '#ffb6c4', '#ff92a8', -8); head(s, '#ffb6c4')
    face(s, b, { y: 55, mouth: 'none' })
    s.shape(s.ell(50, 66, 8.5, 6, 0.4), '#ff9cb2', { lw: 2.4 }); s.dot(47, 66, 1.4, OL); s.dot(53, 66, 1.4, OL)
  } },
  { id: 'koala', color: '#b8bec8', draw: (s, b) => {
    body(s, '#b8bec8'); roundEars(s, '#b8bec8', '#f1f1f3', 26, 40, 12.5); head(s, '#b8bec8', 28, 25)
    face(s, b, { mouth: 'none' }); s.shape(s.ell(50, 65, 5.5, 7, 0.4), OL, { stroke: false })
  } },
  { id: 'fox', color: '#ff9a4a', draw: (s, b) => {
    body(s, '#ff9a4a'); pointyEars(s, '#ff9a4a', '#5a463d', 3); head(s, '#ff9a4a')
    s.shape([[24, 62], [36, 64], [50, 74], [64, 64], [76, 62], [70, 78], [50, 84], [30, 78]], '#fff7ee', { stroke: false })
    face(s, b, { mouth: 'v' }); s.dot(50, 63, 2.2, OL)
  } },
  // ── 中排 ASDFGHJKL ──
  { id: 'blackcat', color: '#4a4141', draw: (s, b) => { body(s, '#4a4141'); pointyEars(s, '#4a4141', '#ff9fb2'); head(s, '#4a4141'); face(s, b, { light: true }) } },
  { id: 'mouse', color: '#cdd1d8', draw: (s, b) => {
    body(s, '#cdd1d8'); roundEars(s, '#cdd1d8', '#ffc4d0', 24, 34, 12); head(s, '#cdd1d8', 28, 25); face(s, b, { mouth: 'none' }); s.dot(50, 64, 2.2, '#ff8fa8')
    for (const m of [-1, 1]) { s.line([[50 + m * 9, 65], [50 + m * 18, 63]], 1.4); s.line([[50 + m * 9, 67], [50 + m * 18, 68]], 1.4) }
  } },
  { id: 'chick', color: '#ffe066', draw: (s, b) => {
    body(s, '#ffe066'); head(s, '#ffe066')
    s.shape([[47, 34], [45, 26], [49, 29], [51, 24], [53, 30], [55, 27], [53, 34]], '#ffe066', { lw: 2.4 })
    face(s, b, { mouth: 'none' }); s.shape(s.tri([45, 63], [55, 63], [50, 68]), '#ffa443', { lw: 2.2 })
  } },
  { id: 'tabby', color: '#ffc46a', draw: (s, b) => {
    body(s, '#ffc46a'); pointyEars(s, '#ffc46a', '#ffe2b8'); head(s, '#ffc46a')
    for (const x of [44, 50, 56]) s.line([[x, 36], [x + (50 - x) * 0.1, 42]], 2.6, '#d98a35')
    face(s, b)
  } },
  { id: 'puppy', color: '#fffaf2', draw: (s, b) => {
    body(s, '#fffaf2'); floppyEars(s, '#f4dfc6'); head(s, '#fffaf2', 27, 25)
    s.shape(s.ell(64, 36, 4.5, 4.5, 0.3), '#ff8fb0', { lw: 2 })
    face(s, b, { mouth: 'o', eyeR: 3.6 })
  } },
  { id: 'penguin', color: '#4b5d76', draw: (s, b) => {
    body(s, '#4b5d76'); head(s, '#4b5d76')
    s.shape([[50, 46], [40, 40], [28, 48], [26, 62], [36, 78], [50, 82], [64, 78], [74, 62], [72, 48], [60, 40]], '#fff', { stroke: false })
    face(s, b, { mouth: 'none' }); s.shape(s.tri([45.5, 63], [54.5, 63], [50, 67.5]), '#ffa443', { lw: 2.2 })
  } },
  { id: 'sheep', color: '#fffaf2', draw: (s, b) => {
    body(s, '#fffaf2')
    for (const [x, y] of [[30, 42], [41, 33], [53, 31], [65, 35], [73, 46], [26, 56], [75, 58]] as Pt[]) s.shape(s.ell(x, y, 10, 9.5, 0.6), '#fffaf2')
    for (const m of [-1, 1]) s.shape(s.ell(50 + m * 23, 55, 7, 4, 0.4, m * 0.3), '#e9cdb6')
    s.shape(s.mochi(50, 60, 19, 18), '#f2dccb'); face(s, b, { y: 58, gap: 7.5 })
  } },
  { id: 'tiger', color: '#ffb44a', draw: (s, b) => {
    body(s, '#ffb44a'); roundEars(s, '#ffb44a', '#fff0d4', 23, 36, 8); head(s, '#ffb44a')
    for (const x of [45, 50, 55]) s.line([[x, 34], [x, 40]], 2.4)
    for (const m of [-1, 1]) { s.line([[50 + m * 29, 54], [50 + m * 22, 55]], 2.2); s.line([[50 + m * 28, 61], [50 + m * 22, 60]], 2.2) }
    s.shape(s.ell(50, 68, 11, 7.5, 0.5), '#fff6e6', { stroke: false }); face(s, b, { mouth: 'w' }); s.dot(50, 63, 2.2, OL)
  } },
  { id: 'raccoon', color: '#a7a3a8', draw: (s, b) => {
    body(s, '#a7a3a8'); pointyEars(s, '#a7a3a8', '#fff', -4); head(s, '#a7a3a8')
    s.shape([[24, 56], [34, 51], [45, 55], [50, 58], [55, 55], [66, 51], [76, 56], [70, 63], [58, 61], [50, 59], [42, 61], [30, 63]], '#4e474b', { stroke: false })
    s.shape(s.ell(50, 70, 11, 7, 0.5), '#fff', { stroke: false }); face(s, b, { light: true, mouth: 'none' }); s.dot(50, 66, 2.4, OL)
  } },
  // ── 前排 ZXCVBNM ──
  { id: 'capybara', color: '#c08a5b', draw: (s, b) => {
    body(s, '#c08a5b'); roundEars(s, '#c08a5b', undefined, 22, 34, 5)
    s.shape([[22, 46], [26, 36], [40, 32], [60, 32], [74, 36], [78, 46], [78, 70], [70, 82], [50, 84], [30, 82], [22, 70]], '#c08a5b')
    const e = sub(s)
    if (b) { e.line([[35, 52], [42, 52]], 2.6); e.line([[58, 52], [65, 52]], 2.6) } else { e.line([[35, 51], [42, 53]], 2.6); e.line([[58, 53], [65, 51]], 2.6) }
    s.shape(s.ell(50, 68, 12, 8, 0.5), '#a8744a', { stroke: false }); s.dot(46, 66, 1.7, OL); s.dot(54, 66, 1.7, OL)
    for (const x of [30, 70]) s.shape(s.ell(x, 62, 5, 3, 0.3), BLUSH, { stroke: false })
  } },
  { id: 'duck', color: '#ffffff', draw: (s, b) => {
    body(s, '#fff'); head(s, '#fff')
    s.shape([[44, 36], [48, 29], [52, 33], [54, 28]], null, { closed: false, lw: 2.4 })
    face(s, b, { mouth: 'none' }); s.shape(s.ell(50, 65, 8.5, 4.5, 0.4), '#ffad3d', { lw: 2.2 })
  } },
  { id: 'star', color: '#ffd84a', draw: (s, b) => {
    // 五角星，但角都是圆的：外角和内角交替取点，平滑后角自然变圆
    const pts: Pt[] = []
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5, r = i % 2 ? 19 : 38
      pts.push([50 + Math.cos(a) * r, 56 + Math.sin(a) * r * 0.95])
    }
    s.shape(pts, '#ffd84a'); face(s, b, { y: 55, gap: 7, mouth: 'o' })
  } },
  { id: 'corgi', color: '#f0a256', draw: (s, b) => {
    body(s, '#f0a256'); pointyEars(s, '#f0a256', '#ffe6cc', 4); head(s, '#f0a256')
    s.shape([[50, 40], [44, 50], [36, 62], [38, 76], [50, 82], [62, 76], [64, 62], [56, 50]], '#fff8ee', { stroke: false })
    face(s, b, { mouth: 'smile', gap: 11 }); s.dot(50, 62, 2.4, OL)
  } },
  { id: 'monkey', color: '#a8714d', draw: (s, b) => {
    body(s, '#a8714d'); roundEars(s, '#a8714d', '#f3d3b2', 29, 56, 8.5); head(s, '#a8714d', 27, 26)
    s.shape([[50, 50], [42, 44], [32, 50], [32, 64], [42, 78], [50, 80], [58, 78], [68, 64], [68, 50], [58, 44]], '#f3d3b2', { stroke: false })
    face(s, b, { y: 58, gap: 8 })
  } },
  { id: 'lion', color: '#ffd27a', draw: (s, b) => {
    body(s, '#ffd27a')
    const mane: Pt[] = []
    for (let i = 0; i < 14; i++) { const a = (i / 14) * Math.PI * 2, r = i % 2 ? 33 : 38; mane.push([50 + Math.cos(a) * r, 57 + Math.sin(a) * r]) }
    s.shape(mane, '#e8964c'); roundEars(s, '#ffd27a', undefined, 21, 38, 6); head(s, '#ffd27a', 27, 24)
    face(s, b, { mouth: 'w' }); s.dot(50, 62, 2.3, OL)
  } },
  { id: 'polar', color: '#f7f9fc', draw: (s, b) => {
    body(s, '#f7f9fc'); roundEars(s, '#f7f9fc', '#e4e9f1'); head(s, '#f7f9fc')
    s.shape(s.ell(50, 66, 9.5, 7, 0.5), '#eef2f8'); face(s, b, { mouth: 'none' }); s.dot(50, 63.5, 2.5, OL)
    s.line([[47.5, 67], [50, 69], [52.5, 67]], 1.8)
  } },
]

/** 按 26 个字母排好的动物：后排 QWERTYUIOP、中排 ASDFGHJKL、前排 ZXCVBNM */
export const ROW_KEYS = ['QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM']

const cache = new Map<string, HTMLCanvasElement>()
/** 画一只（px = 画布边长）。同一只同一状态只画一次 */
export function animalCanvas(id: string, blink: boolean, px = 192) {
  const key = `${id}:${blink ? 1 : 0}:${px}`
  const hit = cache.get(key)
  if (hit) return copy(hit)
  const a = ANIMALS.find((x) => x.id === id) ?? ANIMALS[0]
  const cv = document.createElement('canvas')
  cv.width = cv.height = px
  const ctx = cv.getContext('2d')!
  // 同一只动物睁眼闭眼用同一个种子：除了眼睛，别的线条要一模一样，不然一眨眼整张脸在抖
  a.draw(new Sketch(ctx, px / 100, hashStr(a.id)), blink)
  cache.set(key, cv)
  return copy(cv)
}
function copy(src: HTMLCanvasElement) {
  const c = document.createElement('canvas')
  c.width = src.width
  c.height = src.height
  c.getContext('2d')!.drawImage(src, 0, 0)
  return c
}
