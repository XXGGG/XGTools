/**
 * 键盘桌宠的舞台：一块倾斜的圆角厚底盘，上面按键盘字母排挤着 26 只小动物，前面一排四个有厚度的键帽。
 *
 * 2026-10-12 第二版（照用户画的底盘草图）：
 * - 底盘是斜着放的厚板：顶面是平行四边形（越往后越往右），前面和右边露出厚度，角都是圆的
 * - 小动物和字母一一对应：后排 QWERTYUIOP（10 只）、中排 ASDFGHJKL（9 只）、前排 ZXCVBNM（7 只），
 *   按哪个字母就是哪一只跳；别的键不让动物跳
 * - 前面只有 Ctrl / Shift / 空格 / 回车 四个键（没有 Alt），键帽有厚度，按下去大约沉一半
 * - 全部手绘（canvas），不用 SVG
 *
 * 不依赖 Vue：纯 DOM + Web Animations，桌宠窗口和独立预览页都能直接用。
 */
import { ANIMALS, ROW_KEYS, animalCanvas } from './animals'

export type StageOptions = { sign?: boolean }

/** 舞台尺寸（窗口按它乘缩放算大小） */
export const STAGE_W = 440
export const STAGE_H = 300
const W = STAGE_W
const H = STAGE_H
const OL = '#3d2b22'

/** 底盘顶面四个角 + 斜率：越往后（y 越小）越往右 */
const TOP = { back: 112, front: 232, xl: 56, xr: 372 }
const SLANT = 0.433 // 每往后 1px，往右挪多少
const THICK = 24 // 底盘厚度
const xl = (y: number) => TOP.xl + (TOP.front - y) * SLANT
const xr = (y: number) => TOP.xr + (TOP.front - y) * SLANT
const SKEW_DEG = (Math.atan(SLANT) * 180) / Math.PI

/** 三排：y 是这一排小动物的中心；后排小、前排大 */
const ROWS = [
  { keys: ROW_KEYS[0], y: 124, scale: 0.74, pad: 20, z: 10 },
  { keys: ROW_KEYS[1], y: 151, scale: 0.86, pad: 26, z: 20 },
  { keys: ROW_KEYS[2], y: 180, scale: 1.0, pad: 36, z: 30 },
]
const PET = 80

const KEY_TOP = 198
const CAP = 22 // 键帽顶面高
const DEPTH = 11 // 键帽露出的厚度
const KEYS = [
  { k: 'ctrl', label: 'Ctrl', x: 70, w: 48, kd: '0s' },
  { k: 'shift', label: 'Shift', x: 124, w: 56, kd: '-.8s' },
  { k: 'space', label: '', x: 186, w: 124, kd: '-1.6s' },
  { k: 'enter', label: '', x: 316, w: 60, kd: '-2.4s' },
]
const KEY_OF: Record<string, string> = {
  ControlLeft: 'ctrl', ControlRight: 'ctrl', ShiftLeft: 'shift', ShiftRight: 'shift',
  Space: 'space', Return: 'enter', KpReturn: 'enter',
}

type Pet = { el: HTMLElement; jump: HTMLElement; trail: HTMLElement; flying: boolean; y: number; scale: number; z: number }

const STYLE = `
.kp-root { position: relative; width: ${W}px; height: ${H}px; user-select: none; }
.kp-root * { box-sizing: border-box; }
.kp-base { position: absolute; left: 0; top: 0; width: ${W}px; height: ${H}px; pointer-events: none; }
.kp-pet { position: absolute; width: ${PET}px; height: ${PET}px; margin-left: ${-PET / 2}px; margin-top: ${-PET / 2}px; transform-origin: 50% 90%; }
.kp-bob { position: absolute; inset: 0; transform-origin: 50% 95%; animation: kpBob var(--dur) ease-in-out var(--delay) infinite; }
.kp-jump { position: absolute; inset: 0; transform-origin: 50% 92%; }
.kp-jump canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
.kp-jump canvas.closed { opacity: 0; animation: kpBlinkOn var(--blink) step-end var(--delay) infinite; }
.kp-jump canvas.open { animation: kpBlinkOff var(--blink) step-end var(--delay) infinite; }
@keyframes kpBlinkOn { 0%, 95%, 100% { opacity: 0; } 96% { opacity: 1; } }
@keyframes kpBlinkOff { 0%, 95%, 100% { opacity: 1; } 96% { opacity: 0; } }
.kp-trail {
  position: absolute; left: 50%; top: 58%; width: 44%; height: 0; margin-left: -22%;
  border-radius: 999px; opacity: 0; pointer-events: none;
  background: linear-gradient(to bottom, var(--c), transparent);
  filter: blur(1.2px);
}
@keyframes kpBob {
  0%, 100% { transform: translateY(0) rotate(calc(var(--tilt) * -1)); }
  50% { transform: translateY(-2.5px) rotate(var(--tilt)); }
}
.kp-glow {
  position: absolute; left: 70px; width: 306px; top: ${KEY_TOP + 6}px; height: 34px; z-index: 49; border-radius: 18px;
  background: linear-gradient(90deg, #ff6fbf, #ffcf4a, #5fe39a, #4cbcff, #a983ff);
  filter: blur(14px); opacity: 0.5; pointer-events: none;
  transform: skewX(${-SKEW_DEG}deg); transform-origin: 0 100%;
}
.kp-key {
  position: absolute; top: ${KEY_TOP}px; height: ${CAP + DEPTH}px; z-index: 50; pointer-events: none;
  transform: skewX(${-SKEW_DEG}deg); transform-origin: 0 100%;
}
.kp-side, .kp-cap {
  position: absolute; left: 0; right: 0; border: 2.8px solid ${OL};
  border-radius: 10px 9px 11px 9px / 10px 11px 9px 10px;
  background: linear-gradient(105deg, #ff6fbf, #ffcf4a, #5fe39a, #4cbcff, #a983ff, #ff6fbf);
  background-size: 300% 100%;
  animation: kpFlow 6s linear infinite; animation-delay: var(--kd);
}
.kp-side { top: ${DEPTH - 2}px; height: ${CAP + 2}px; filter: brightness(0.72) saturate(1.1); }
.kp-cap {
  top: 0; height: ${CAP}px; display: grid; place-items: center;
  box-shadow: inset 0 3px 0 rgb(255 255 255 / 0.5), inset 0 -3px 0 rgb(0 0 0 / 0.08);
  font: italic 900 13px/1 'Segoe UI', 'Arial Rounded MT Bold', sans-serif; color: #fff;
  -webkit-text-stroke: 2.6px ${OL}; paint-order: stroke fill;
  transition: transform 60ms ease;
}
.kp-key.down .kp-cap { transform: translateY(${DEPTH / 2}px); }
@keyframes kpFlow { to { background-position: 300% 0; } }
.kp-sign {
  position: absolute; right: 12px; top: 8px; width: 70px; height: 58px; z-index: 90; pointer-events: none;
  border: 2.8px solid ${OL}; border-radius: 12px 10px 13px 11px; background: #fffaf0;
  box-shadow: 0 3px 0 ${OL};
  display: grid; place-items: center; padding-top: 8px;
  font: 900 25px/1 'Segoe UI', 'Arial Rounded MT Bold', sans-serif; color: ${OL};
  transform-origin: 50% 0;
}
.kp-sign::before { content: ''; position: absolute; left: 5px; right: 5px; top: -1px; height: 12px; border-radius: 9px 9px 0 0; background: #ffd36b; border-bottom: 2.8px solid ${OL}; }
.kp-sign::after { content: ''; position: absolute; left: 13px; right: 13px; top: -8px; height: 12px; background: radial-gradient(circle, ${OL} 2.6px, transparent 3.2px) 0 0 / 12px 12px repeat-x; }
.kp-sign span { position: relative; white-space: nowrap; }
.kp-sign.small span { font-size: 15px; }
`

function rng(seed: number) {
  let s = seed >>> 0
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296)
}

/** 手绘一个有圆角的多边形（角上用二次曲线圆过去，边上加一点点抖动） */
function roughPoly(c: CanvasRenderingContext2D, pts: [number, number][], r: number, fill: string, rand: () => number) {
  const n = pts.length
  const draw = (j: number) => {
    const P = pts.map(([x, y]) => [x + (rand() - 0.5) * j, y + (rand() - 0.5) * j])
    c.beginPath()
    for (let i = 0; i < n; i++) {
      const p0 = P[(i - 1 + n) % n], p1 = P[i], p2 = P[(i + 1) % n]
      const d1 = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]), d2 = Math.hypot(p2[0] - p1[0], p2[1] - p1[1])
      const a = [p1[0] + ((p0[0] - p1[0]) * Math.min(r, d1 / 2)) / d1, p1[1] + ((p0[1] - p1[1]) * Math.min(r, d1 / 2)) / d1]
      const b = [p1[0] + ((p2[0] - p1[0]) * Math.min(r, d2 / 2)) / d2, p1[1] + ((p2[1] - p1[1]) * Math.min(r, d2 / 2)) / d2]
      if (i === 0) c.moveTo(a[0], a[1])
      else c.lineTo(a[0], a[1])
      c.quadraticCurveTo(p1[0], p1[1], b[0], b[1])
    }
    c.closePath()
  }
  draw(0.6)
  c.fillStyle = fill
  c.fill()
  c.strokeStyle = OL
  c.lineJoin = 'round'
  c.lineWidth = 3.6
  draw(0.8)
  c.stroke()
  c.globalAlpha = 0.5
  c.lineWidth = 1.6
  draw(2)
  c.stroke()
  c.globalAlpha = 1
}

/** 底盘：整块（含厚度）→ 正面那条 → 顶面，手绘、圆角 */
function baseCanvas() {
  const S = 2
  const cv = document.createElement('canvas')
  cv.width = W * S
  cv.height = H * S
  cv.className = 'kp-base'
  const c = cv.getContext('2d')!
  c.scale(S, S)
  const rand = rng(7)
  const bl: [number, number] = [xl(TOP.back), TOP.back], br: [number, number] = [xr(TOP.back), TOP.back]
  const fl: [number, number] = [TOP.xl, TOP.front], fr: [number, number] = [TOP.xr, TOP.front]
  roughPoly(c, [bl, br, [br[0], br[1] + THICK], [fr[0], fr[1] + THICK], [fl[0], fl[1] + THICK], fl], 16, '#e3cfb6', rand)
  roughPoly(c, [fl, fr, [fr[0], fr[1] + THICK], [fl[0], fl[1] + THICK]], 10, '#efdfca', rand)
  roughPoly(c, [bl, br, fr, fl], 18, '#fffaf1', rand)
  // 顶面上一圈淡淡的内描线，像板子边缘的倒角
  c.globalAlpha = 0.25
  roughPoly(c, [[bl[0] + 8, bl[1] + 7], [br[0] - 9, br[1] + 7], [fr[0] - 9, fr[1] - 7], [fl[0] + 9, fl[1] - 7]], 14, 'transparent', rand)
  c.globalAlpha = 1
  return cv
}

export function createStage(root: HTMLElement, opts: StageOptions = {}) {
  const style = document.createElement('style')
  style.textContent = STYLE
  root.appendChild(style)

  const stage = document.createElement('div')
  stage.className = 'kp-root'
  stage.appendChild(baseCanvas())
  root.appendChild(stage)

  // ── 小动物：按键盘字母排三排，后排先放 ──
  const rand = rng(20261012)
  const byLetter = new Map<string, Pet>()
  const pets: Pet[] = []
  let idx = 0
  for (const row of ROWS) {
    const n = row.keys.length
    const x0 = xl(row.y) + row.pad, x1 = xr(row.y) - row.pad
    for (let i = 0; i < n; i++) {
      const a = ANIMALS[idx++]
      const x = x0 + ((x1 - x0) * i) / (n - 1) + (rand() - 0.5) * 4
      const y = row.y + (rand() - 0.5) * 5
      const el = document.createElement('div')
      el.className = 'kp-pet'
      el.style.left = `${x}px`
      el.style.top = `${y}px`
      el.style.zIndex = String(row.z + Math.round(rand() * 4))
      el.style.transform = `scale(${row.scale})`
      el.style.setProperty('--dur', `${(1.8 + rand() * 1.6).toFixed(2)}s`)
      el.style.setProperty('--delay', `${(-rand() * 4).toFixed(2)}s`)
      el.style.setProperty('--tilt', `${(1.5 + rand() * 2.5).toFixed(1)}deg`)
      el.style.setProperty('--blink', `${(3 + rand() * 4).toFixed(2)}s`)
      const light = ['#ffffff', '#fffaf2', '#f7f9fc'].includes(a.color)
      el.innerHTML = `<div class="kp-bob"><div class="kp-jump"><div class="kp-trail" style="--c:${light ? '#ffd2a0' : a.color}"></div></div></div>`
      const jumpEl = el.querySelector('.kp-jump') as HTMLElement
      const open = animalCanvas(a.id, false)
      open.className = 'open'
      const closed = animalCanvas(a.id, true)
      closed.className = 'closed'
      jumpEl.append(open, closed)
      stage.appendChild(el)
      const pet: Pet = { el, jump: jumpEl, trail: el.querySelector('.kp-trail') as HTMLElement, flying: false, y, scale: row.scale, z: row.z }
      pets.push(pet)
      byLetter.set(row.keys[i], pet)
    }
  }

  // ── 前排四个键帽：有厚度，斜着跟底盘走 ──
  const glow = document.createElement('div')
  glow.className = 'kp-glow'
  stage.appendChild(glow)
  const icon = (d: string, w: number, h: number) =>
    `<svg width="${w}" height="${h}" viewBox="-2 -2 ${w} ${h}" style="overflow:visible"><path d="${d}" fill="none" stroke="${OL}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/><path d="${d}" fill="none" stroke="#fff" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`
  const keyEls = new Map<string, HTMLElement>()
  for (const k of KEYS) {
    const el = document.createElement('div')
    el.className = 'kp-key'
    el.style.left = `${k.x}px`
    el.style.width = `${k.w}px`
    el.style.setProperty('--kd', k.kd)
    const label = k.k === 'space' ? icon('M3 2v5h26V2', 34, 12) : k.k === 'enter' ? icon('M20 2v6H5m0 0 4-4M5 8l4 4', 26, 16) : k.label
    el.innerHTML = `<div class="kp-side"></div><div class="kp-cap">${label}</div>`
    stage.appendChild(el)
    keyEls.set(k.k, el)
  }

  // ── 右上角的按键小牌 ──
  const sign = document.createElement('div')
  sign.className = 'kp-sign'
  sign.innerHTML = '<span>⌨</span>'
  if (opts.sign === false) sign.style.display = 'none'
  stage.appendChild(sign)

  // ── 动作 ──
  function jump(p: Pet, big = true) {
    p.flying = true
    // 跳到窗口顶上留几 px 的地方，别冲出窗口被裁掉
    const lift = big ? Math.max(44, p.y - (6 + (PET / 2) * p.scale)) / p.scale : 14 / p.scale
    const tilt = (Math.random() < 0.5 ? -1 : 1) * (4 + Math.random() * 6)
    const dur = big ? 950 + Math.random() * 200 : 420
    // 层级不动：后排的从前排身后冒上去、前排的挡在后排前面，跟真的一样；
    // 以前起跳就提到最上层，后排的会突然窜到前排前面、甚至跑到键帽前面（2026-10-12 用户报的）
    const anim = p.jump.animate(
      big
        ? [
            { transform: 'translateY(0) scale(1, 1)', easing: 'ease-out' },
            { transform: 'translateY(5px) scale(1.14, 0.84)', offset: 0.1, easing: 'cubic-bezier(.2,.9,.3,1)' },
            { transform: `translateY(${-lift}px) scale(0.88, 1.16) rotate(0deg)`, offset: 0.34, easing: 'ease-out' },
            { transform: `translateY(${-lift - 8}px) scale(1.04, 0.97) rotate(${tilt}deg)`, offset: 0.46, easing: 'ease-in-out' },
            { transform: `translateY(${-lift - 4}px) scale(1, 1) rotate(${-tilt * 0.7}deg)`, offset: 0.6, easing: 'cubic-bezier(.55,0,.8,.4)' },
            { transform: 'translateY(0) scale(0.92, 1.1) rotate(0deg)', offset: 0.84, easing: 'ease-out' },
            { transform: 'translateY(2px) scale(1.16, 0.84)', offset: 0.91, easing: 'ease-out' },
            { transform: 'translateY(0) scale(1, 1)' },
          ]
        : [
            { transform: 'translateY(0) scale(1, 1)' },
            { transform: 'translateY(2px) scale(1.08, 0.9)', offset: 0.18 },
            { transform: `translateY(${-lift}px) scale(0.96, 1.05)`, offset: 0.5 },
            { transform: 'translateY(1px) scale(1.06, 0.94)', offset: 0.85 },
            { transform: 'translateY(0) scale(1, 1)' },
          ],
      { duration: dur },
    )
    if (big) {
      // 尾迹：起跳时从身子往下拉长，人在天上时慢慢收掉
      p.trail.animate(
        [
          { height: '0px', opacity: 0 },
          { height: '0px', opacity: 0, offset: 0.1 },
          { height: `${lift * 0.75}px`, opacity: 0.9, offset: 0.34 },
          { height: `${lift * 0.45}px`, opacity: 0.45, offset: 0.55 },
          { height: '0px', opacity: 0, offset: 0.75 },
          { height: '0px', opacity: 0 },
        ],
        { duration: dur },
      )
    }
    anim.onfinish = () => {
      p.flying = false
    }
  }

  function label(key: string) {
    if (/^Key[A-Z]$/.test(key)) return key.slice(3)
    if (/^Num\d$/.test(key)) return key.slice(3)
    const map: Record<string, string> = {
      Space: '␣', Return: '↵', KpReturn: '↵', Backspace: '⌫', Tab: '⇥', Escape: 'Esc', ShiftLeft: 'Shift', ShiftRight: 'Shift',
      ControlLeft: 'Ctrl', ControlRight: 'Ctrl', Alt: 'Alt', AltGr: 'Alt', MetaLeft: 'Win', MetaRight: 'Win', CapsLock: 'Caps',
      UpArrow: '↑', DownArrow: '↓', LeftArrow: '←', RightArrow: '→', Comma: ',', Dot: '.', Slash: '/', SemiColon: ';',
      Quote: "'", LeftBracket: '[', RightBracket: ']', BackSlash: '\\', Minus: '-', Equal: '=', BackQuote: '`', Delete: 'Del',
    }
    return map[key] ?? key.replace(/^Key/, '')
  }

  let lastSign = 0
  function showSign(key: string) {
    if (opts.sign === false) return
    const t = label(key)
    sign.querySelector('span')!.textContent = t
    sign.classList.toggle('small', t.length > 2)
    const now = performance.now()
    if (now - lastSign > 60) {
      sign.animate(
        [{ transform: 'rotate(0) scale(1)' }, { transform: 'rotate(-6deg) scale(1.12)', offset: 0.35 }, { transform: 'rotate(3deg) scale(0.98)', offset: 0.7 }, { transform: 'rotate(0) scale(1)' }],
        { duration: 320, easing: 'ease-out' },
      )
    }
    lastSign = now
  }

  const held = new Set<string>()
  function press(key: string) {
    const repeat = held.has(key)
    held.add(key)
    const k = KEY_OF[key]
    if (k) keyEls.get(k)?.classList.add('down')
    if (repeat) return // 按住不放时系统会连发，别让小动物一直蹦
    // 只有字母键对应小动物；同一只还在天上就重新起跳
    const m = /^Key([A-Z])$/.exec(key)
    const p = m && byLetter.get(m[1])
    if (p) jump(p)
    showSign(key)
  }
  function release(key: string) {
    held.delete(key)
    const k = KEY_OF[key]
    if (k) keyEls.get(k)?.classList.remove('down')
  }

  // 待机时偶尔有一只原地小蹦一下
  let idleTimer = 0
  const idle = () => {
    const free = pets.filter((p) => !p.flying)
    if (free.length) jump(free[Math.floor(Math.random() * free.length)], false)
    idleTimer = window.setTimeout(idle, 1800 + Math.random() * 3200)
  }
  idleTimer = window.setTimeout(idle, 1500)

  return {
    press,
    release,
    setSign(on: boolean) {
      opts.sign = on
      sign.style.display = on ? '' : 'none'
    },
    destroy() {
      window.clearTimeout(idleTimer)
      stage.remove()
      style.remove()
    },
    size: { w: W, h: H },
  }
}
