/**
 * 桌宠 · 键盘款（2026-10-12 起是默认款）：一把四排紧凑键盘，按哪个键，哪个键帽就沉进底盘。
 *
 * 画法用 anatomy 的等距绘图核心（iso-kit.ts）：实体 + 四档明暗 + 细勾边，跟用户在网页版里定稿的那张一样。
 * 布局也是网页版定下来的：每排都是 10u、字母一样大；回车是 L 形（第二排最右连到第三排）；
 * Shift 1.75u 比 Ctrl 1.25u 长；最下面一排左右各一对 Ctrl、Alt，中间空格。
 * 镜头摆正（方位 90°）、轻微俯视。
 *
 * 跟动物款（stage.ts）对外长得一样：press / release / setScale / destroy，桌宠窗口按款式挑一个用。
 */
import * as k from './iso-kit'
import { KB_W, KB_H } from './dims'

export type Ink = 'rainbow' | 'white' | 'black'
export type KeyboardOptions = { ink?: Ink }

const ROWS: [string, string, number][][] = [
  [['KeyQ', 'Q', 1], ['KeyW', 'W', 1], ['KeyE', 'E', 1], ['KeyR', 'R', 1], ['KeyT', 'T', 1], ['KeyY', 'Y', 1], ['KeyU', 'U', 1], ['KeyI', 'I', 1], ['KeyO', 'O', 1], ['KeyP', 'P', 1]],
  [['KeyA', 'A', 1], ['KeyS', 'S', 1], ['KeyD', 'D', 1], ['KeyF', 'F', 1], ['KeyG', 'G', 1], ['KeyH', 'H', 1], ['KeyJ', 'J', 1], ['KeyK', 'K', 1], ['KeyL', 'L', 1]],
  [['ShiftLeft', 'Shift', 1.75], ['KeyZ', 'Z', 1], ['KeyX', 'X', 1], ['KeyC', 'C', 1], ['KeyV', 'V', 1], ['KeyB', 'B', 1], ['KeyN', 'N', 1], ['KeyM', 'M', 1]],
  [['ControlLeft', 'Ctrl', 1.25], ['AltLeft', 'Alt', 1.25], ['Space', '', 5], ['AltRight', 'Alt', 1.25], ['ControlRight', 'Ctrl', 1.25]],
]
const U = 19
const SEAM = 1.1
const CAP_H = 7
const SINK = CAP_H / 2 // 按下去沉进底盘一半
const BORDER = 7
const COLS = 10
const X0 = -(COLS * U) / 2
const Y0 = -(ROWS.length * U) / 2
const PLATE = { x: X0 - BORDER, y: Y0 - BORDER, w: COLS * U + BORDER * 2, d: ROWS.length * U + BORDER * 2, r: 10 }
const CASE_H = 12
const FOOT_H = 3

/** rdev 发来的键名 → 键盘上的键位 */
const ALIAS: Record<string, string> = {
  Return: 'Enter', KpReturn: 'Enter', ShiftRight: 'ShiftLeft', Alt: 'AltLeft', AltGr: 'AltRight',
}

// 多边形每个角都倒圆（凹角也行）：角上切掉 r，用二次曲线带过去
function roundPoly(pts: number[][], r: number, steps = 5) {
  const out: [number, number][] = []
  pts.forEach((p, i) => {
    const a = pts[(i + pts.length - 1) % pts.length], b = pts[(i + 1) % pts.length]
    const la = Math.hypot(a[0] - p[0], a[1] - p[1]), lb = Math.hypot(b[0] - p[0], b[1] - p[1])
    const ra = Math.min(r, la / 2), rb = Math.min(r, lb / 2)
    const s0 = [p[0] + ((a[0] - p[0]) * ra) / la, p[1] + ((a[1] - p[1]) * ra) / la]
    const s1 = [p[0] + ((b[0] - p[0]) * rb) / lb, p[1] + ((b[1] - p[1]) * rb) / lb]
    for (let t = 0; t <= steps; t++) {
      const u = t / steps
      out.push([
        (1 - u) * (1 - u) * s0[0] + 2 * u * (1 - u) * p[0] + u * u * s1[0],
        (1 - u) * (1 - u) * s0[1] + 2 * u * (1 - u) * p[1] + u * u * s1[1],
      ])
    }
  })
  return out
}

/** L 形回车：第二排最右 1u，往下连到第三排最右 1.25u；inset 往里收（凹角那个点往外推） */
function enterRing(inset: number) {
  const g = [[9, 1, 1, 1], [10, 1, -1, 1], [10, 3, -1, -1], [8.75, 3, 1, -1], [8.75, 2, 1, 1], [9, 2, 1, 1]]
  return g.map(([gx, gy, sx, sy]) => [X0 + gx * U + sx * inset, Y0 + gy * U + sy * inset])
}

function hull(points: number[][]) {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lo: number[][] = [], hi: number[][] = []
  for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p) }
  for (const p of pts.reverse()) { while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], p) <= 0) hi.pop(); hi.push(p) }
  return lo.slice(0, -1).concat(hi.slice(0, -1))
}

let uid = 0

function build() {
  const P = k.fitProjection(
    [...k.boxCorners(PLATE, -CASE_H - FOOT_H, 0), ...k.boxCorners(PLATE, 0, CAP_H + 2)],
    KB_W, KB_H, { pad: 12, azimuth: 90, elevation: 38 },
  )
  const at = (p: number[]) => k.iso(p as k.Point3, P)
  const S = (paths: any, style: any) => k.solidSvg(paths, style)
  const L = (d: string, style: any) => k.lineSvg(d, style)

  // ── 外壳：脚、厚板、上沿一圈槽、四角螺丝、键位井 ──
  const shell: string[] = [`<path class="iso-halo" d="${k.haloOf(PLATE, -CASE_H - FOOT_H, CASE_H, P)}"/>`]
  const feet = k.corners(PLATE, 16).sort((a: number[], b: number[]) => k.depthOf([a[0], a[1], 0], P) - k.depthOf([b[0], b[1], 0], P))
  for (const [x, y] of feet) shell.push(S(k.cylinder(x, y, 6, -CASE_H - FOOT_H, FOOT_H, P, 24), { tone: 'lo' }))
  shell.push(S(k.slabOf(PLATE, -CASE_H, CASE_H, P, 10, 2), { tone: 'mid' }))
  shell.push(L(k.planOutline(k.insetPlan(PLATE, 2.6), 0, P), { tone: 'faint' }))
  shell.push(k.dotsSvg(k.corners(PLATE, 3.6).map(([x, y]: number[]) => at([x, y, 0])), { size: 0.45 }))
  const well = { x: X0 - 0.8, y: Y0 - 0.8, w: COLS * U + 1.6, d: ROWS.length * U + 1.6, r: 3 }
  shell.push(S(k.slabOf(well, -0.6, 0.6, P, 6), { tone: 'lo', flat: true }))

  // ── 键帽：一排一排从后往前、同一排从左往右画（长键按中心算深度会错位） ──
  type Cap = { code: string; label: string; x: number; y: number; w: number; r: number; enter?: boolean }
  const caps: Cap[] = []
  ROWS.forEach((row, r) => {
    let x = X0
    for (const [code, label, w] of row) {
      caps.push({ code, label, x, y: Y0 + r * U, w: w * U, r })
      x += w * U
    }
  })
  caps.push({ code: 'Enter', label: 'Enter', x: X0 + 8.875 * U, y: Y0 + 2 * U, w: U, r: 2, enter: true })
  caps.sort((a, b) => a.r - b.r || a.x - b.x)
  const span = COLS * U
  const keys = caps.map((c) => {
    const hue = Math.round(330 + ((c.x + c.w / 2 + span / 2) / span) * 300 + c.r * 10) % 360
    let body: any, dish: string, text: string
    if (c.enter) {
      body = k.extrude(roundPoly(enterRing(SEAM / 2), 2.4), -SINK, CAP_H + SINK + 0.6, P, { convex: false })
      dish = k.onTop(roundPoly(enterRing(SEAM / 2 + 2.4), 1.6), CAP_H + 0.6, P, true)
      text = k.faceTextSvg(k.topMatrix([X0 + 9.38 * U, Y0 + 2.62 * U], CAP_H + 0.6, P), 'Enter', { size: 4.2, tone: 'mid', anchor: 'middle' })
    } else {
      const plan = { x: c.x + SEAM / 2, y: c.y + SEAM / 2, w: c.w - SEAM, d: U - SEAM, r: 2.4 }
      body = k.slabOf(plan, -SINK, CAP_H + SINK + 0.6, P, 5, 1)
      dish = k.planOutline(k.insetPlan(plan, 2.4), CAP_H + 0.6, P, 4)
      text = c.label
        ? k.faceTextSvg(k.topMatrix([c.x + c.w / 2, c.y + U / 2 + (c.label.length > 1 ? 1.4 : 2)], CAP_H + 0.6, P), c.label, { size: c.label.length > 1 ? 4.2 : 6.4, tone: 'mid', anchor: 'middle' })
        : ''
    }
    return `<g class="kb-key" data-key="${c.code}" style="--h:${hue}">${S(body, { tone: 'mid', crease: 'faint' })}${L(dish, { tone: 'faint' })}${text}</g>`
  })

  // 键帽只露出底盘开口以上的部分：按下去时下半截真的沉进底盘里
  const id = `kb-well-${uid++}`
  const ring = k.ringOf(well, 6)
  const clip = k.pathOf(<k.Flat[]>hull([...ring.map(([x, y]: number[]) => at([x, y, 0])), ...ring.map(([x, y]: number[]) => at([x, y, 60]))]), true)
  const svg = k.figureSvg({
    width: KB_W,
    height: KB_H,
    label: '键盘桌宠',
    body: [...shell, `<clipPath id="${id}"><path d="${clip}"/></clipPath><g clip-path="url(#${id})">${keys.join('')}</g>`],
  })
  return { svg, up: k.axisVector(P, [0, 0, 1]) as [number, number] }
}

const CSS = `
${k.ISO_CSS}
.kb-root{width:${KB_W}px;height:${KB_H}px;background:transparent;user-select:none}
.kb-root .iso-svg{width:${KB_W}px;height:${KB_H}px}
.kb-root[data-ink="rainbow"] .kb-key{--anatomy-mid:hsl(var(--h) 25% 52%);--anatomy-top:hsl(var(--h) 90% 87%);
  --anatomy-shade-0:hsl(var(--h) 42% 58%);--anatomy-shade-1:hsl(var(--h) 48% 65%);--anatomy-shade-2:hsl(var(--h) 55% 72%);
  --anatomy-shade-3:hsl(var(--h) 62% 79%);--anatomy-faint:hsl(var(--h) 40% 74%)}
.kb-root[data-ink="rainbow"] .kb-key text{fill:hsl(var(--h) 30% 38%)}
.kb-root[data-ink="white"] .kb-key{--anatomy-top:#fbfaf7;--anatomy-shade-0:#c9c6bf;--anatomy-shade-1:#d8d5ce;--anatomy-shade-2:#e5e2dc;--anatomy-shade-3:#efece6;--anatomy-faint:#dcd9d2;--anatomy-mid:#a8a49c}
.kb-root[data-ink="white"] .kb-key text{fill:#6d6a64}
.kb-root[data-ink="black"] .kb-key{--anatomy-top:#34343a;--anatomy-shade-0:#141417;--anatomy-shade-1:#1b1b1f;--anatomy-shade-2:#222227;--anatomy-shade-3:#2a2a30;--anatomy-faint:#46464d;--anatomy-mid:#5c5c64}
.kb-root[data-ink="black"] .kb-key text{fill:#c9c9d0}
.kb-root[data-ink="black"] .iso-solid:not(.kb-key .iso-solid){--anatomy-top:#2b2b30;--anatomy-shade-0:#121214;--anatomy-shade-1:#17171a;--anatomy-shade-2:#1d1d21;--anatomy-shade-3:#232327;--anatomy-mid:#4a4a52;--anatomy-faint:#3a3a40}
`

export function createKeyboardPet(root: HTMLElement, opts: KeyboardOptions = {}) {
  const style = document.createElement('style')
  style.textContent = CSS
  root.appendChild(style)
  const { svg, up } = build()
  const el = document.createElement('div')
  el.className = 'iso kb-root'
  el.dataset.theme = 'light'
  el.dataset.ink = opts.ink ?? 'rainbow'
  el.innerHTML = svg
  root.appendChild(el)

  const keyEls: Record<string, SVGGElement> = {}
  el.querySelectorAll<SVGGElement>('[data-key]').forEach((g) => (keyEls[g.dataset.key!] = g))
  const pos: Record<string, number> = {}
  const down = new Set<string>()
  const still = matchMedia('(prefers-reduced-motion: reduce)')

  // 只在有键在动的时候跑动画帧
  let frame = 0, prev = 0
  function tick(now: number) {
    const dt = prev ? Math.min((now - prev) / 1000, 1 / 30) : 1 / 60
    prev = now
    let moving = false
    for (const code in keyEls) {
      const want = down.has(code) ? SINK : 0
      const cur = pos[code] ?? 0
      if (cur === want) continue
      let next = still.matches ? want : cur + (want - cur) * (1 - Math.exp(-dt / (want ? 0.018 : 0.06)))
      if (Math.abs(want - next) < 0.02) next = want
      pos[code] = next
      keyEls[code].setAttribute('transform', `translate(${(-up[0] * next).toFixed(2)} ${(-up[1] * next).toFixed(2)})`)
      if (next !== want) moving = true
    }
    frame = moving ? requestAnimationFrame(tick) : 0
  }
  const run = () => {
    if (!frame) {
      prev = 0
      frame = requestAnimationFrame(tick)
    }
  }
  const codeOf = (key: string) => {
    const c = ALIAS[key] ?? key
    return keyEls[c] ? c : null
  }

  return {
    press(key: string) {
      const c = codeOf(key)
      if (!c) return
      down.add(c)
      run()
    },
    release(key: string) {
      const c = codeOf(key)
      if (!c) return
      down.delete(c)
      run()
    },
    setInk(ink: Ink) {
      el.dataset.ink = ink
    },
    // SVG 本身就是矢量，放大不会糊，这里没事可做；留着跟动物款对齐
    setScale(_s: number) {},
    setSign(_on: boolean) {},
    destroy() {
      cancelAnimationFrame(frame)
      el.remove()
      style.remove()
    },
    size: { w: KB_W, h: KB_H },
  }
}
