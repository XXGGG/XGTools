/**
 * 键盘桌宠的舞台：一块简化键盘（只有 Ctrl / Alt / 空格 / 回车）上挤着三排小动物。
 *
 * 不依赖 Vue：纯 DOM + Web Animations，桌宠窗口挂上去，独立的预览页也能直接用。
 *
 * 动起来的规则：
 * - 待机：每只各自慢慢晃（上下浮 + 轻轻歪头），节奏和起点都随机，看起来是一群活物而不是齐步走；
 *   隔一会儿有一只原地小蹦一下、有一只眨眼
 * - 按键：按键名固定映射到某一只（同一个键总是同一只），那只蓄力下蹲 → 拖着彩色尾迹蹿上去 →
 *   在上面晃一下 → 落回原位、落地压扁回弹。那只正在天上就换旁边空闲的
 * - Ctrl / Alt / 空格 / 回车 这四个键在键盘上会跟着按下去、松开弹回
 * - 右上角小牌子显示刚按的键
 */
import { ANIMALS } from './animals'

export type StageOptions = { sign?: boolean }

const W = 400
const H = 320

/** 三排的位置：越往后越小、越靠上 */
const ROWS = [
  { y: 112, scale: 0.74, n: 10, x0: 52, x1: 348, z: 1 },
  { y: 140, scale: 0.86, n: 10, x0: 44, x1: 356, z: 2 },
  { y: 170, scale: 1.0, n: 9, x0: 50, x1: 350, z: 3 },
]
const PET = 76 // 一只的基准边长（px）

/** 可重复的伪随机：同一个种子每次排出来一样，桌宠不会每次打开都换位置 */
function rng(seed: number) {
  let s = seed >>> 0
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296)
}

/** 键名 → 一个稳定的数 */
function hash(s: string) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

type Pet = {
  el: HTMLElement
  jump: HTMLElement
  trail: HTMLElement
  color: string
  flying: boolean
  x: number
  y: number
  scale: number
  z: number
}

const STYLE = `
.kp-root { position: relative; width: ${W}px; height: ${H}px; user-select: none; }
.kp-root * { box-sizing: border-box; }
.kp-base { position: absolute; inset: 0; pointer-events: none; }
.kp-pet { position: absolute; width: ${PET}px; height: ${PET}px; margin-left: ${-PET / 2}px; margin-top: ${-PET / 2}px; transform-origin: 50% 90%; }
.kp-bob { position: absolute; inset: 0; transform-origin: 50% 95%; animation: kpBob var(--dur) ease-in-out var(--delay) infinite; }
.kp-jump { position: absolute; inset: 0; transform-origin: 50% 92%; }
.kp-jump svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.kp-trail {
  /* 尾迹从身子中间往下拖（来的方向），越往下越淡 */
  position: absolute; left: 50%; top: 58%; width: 44%; height: 0; margin-left: -22%;
  border-radius: 999px; opacity: 0; pointer-events: none;
  background: linear-gradient(to bottom, var(--c), transparent);
  filter: blur(1.2px);
}
@keyframes kpBob {
  0%, 100% { transform: translateY(0) rotate(calc(var(--tilt) * -1)); }
  50% { transform: translateY(-3px) rotate(var(--tilt)); }
}
.kp-root .pet-eyes { transform-box: view-box; animation: kpBlink var(--blink) step-end var(--delay) infinite; }
@keyframes kpBlink {
  0%, 94%, 100% { transform: scaleY(1); }
  96% { transform: scaleY(0.12); }
}
.kp-keys { position: absolute; left: 0; top: 0; width: ${W}px; height: ${H}px; pointer-events: none; z-index: 20; }
.kp-key {
  position: absolute; height: 36px; border-radius: 11px; border: 3px solid #3b2a24;
  display: grid; place-items: center;
  font: italic 900 15px/1 'Segoe UI', 'Arial Rounded MT Bold', sans-serif; color: #fff;
  -webkit-text-stroke: 3px #3b2a24; paint-order: stroke fill;
  background: linear-gradient(110deg, #ff5fb8, #ffc93c, #4fe08a, #3fb9ff, #a77bff, #ff5fb8);
  background-size: 300% 100%;
  animation: kpFlow 6s linear infinite;
  animation-delay: var(--kd);
  box-shadow: inset 0 -6px 0 rgb(0 0 0 / 0.14), inset 0 3px 0 rgb(255 255 255 / 0.55), 0 3px 0 #3b2a24;
  transition: transform 70ms ease, box-shadow 70ms ease;
}
.kp-key.down { transform: translateY(3px); box-shadow: inset 0 -2px 0 rgb(0 0 0 / 0.14), inset 0 3px 6px rgb(0 0 0 / 0.18), 0 0 0 #3b2a24; }
@keyframes kpFlow { to { background-position: 300% 0; } }
.kp-glow {
  position: absolute; left: 30px; right: 30px; top: 218px; height: 46px; border-radius: 20px; z-index: 19;
  background: linear-gradient(90deg, #ff9ad5, #ffd36b, #8ff0a4, #7fd3ff, #c8a2ff);
  filter: blur(16px); opacity: 0.45; pointer-events: none;
}
.kp-sign {
  position: absolute; right: 18px; top: 10px; width: 74px; height: 62px; z-index: 30; pointer-events: none;
  border: 3px solid #3b2a24; border-radius: 12px; background: #fffaf0;
  box-shadow: 0 3px 0 #3b2a24;
  display: grid; place-items: center; padding-top: 8px;
  font: 900 26px/1 'Segoe UI', 'Arial Rounded MT Bold', sans-serif; color: #3b2a24;
  transform-origin: 50% 0;
}
.kp-sign::before {
  content: ''; position: absolute; left: 6px; right: 6px; top: -1px; height: 12px; border-radius: 8px 8px 0 0;
  background: #ffd36b; border-bottom: 3px solid #3b2a24;
}
.kp-sign::after {
  content: ''; position: absolute; left: 14px; right: 14px; top: -8px; height: 12px;
  background: radial-gradient(circle, #3b2a24 2.6px, transparent 3.2px) 0 0 / 12px 12px repeat-x;
}
.kp-sign span { position: relative; max-width: 66px; overflow: hidden; text-overflow: clip; white-space: nowrap; }
.kp-sign.small span { font-size: 15px; }
`

/** 键盘底座：一块有厚度的圆角板，彩虹光晕垫在键帽下面 */
function baseSvg() {
  return `<svg class="kp-base" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
    <defs>
      <linearGradient id="kpTop" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#fffdf8" /><stop offset="1" stroke-opacity="1" stop-color="#f6efe4" />
      </linearGradient>
    </defs>
    <!-- 厚度（右边和下边露出来的那一截） -->
    <path d="M30 150 Q30 136 44 136 H360 Q376 136 378 150 L386 262 Q388 286 364 286 H46 Q22 286 24 262 Z" fill="#e9dccb" stroke="#3b2a24" stroke-width="4" stroke-linejoin="round" />
    <!-- 顶面 -->
    <path d="M30 146 Q30 132 44 132 H358 Q372 132 373 146 L378 252 Q379 270 360 270 H44 Q24 270 25 252 Z" fill="url(#kpTop)" stroke="#3b2a24" stroke-width="4" stroke-linejoin="round" />
  </svg>`
}

export function createStage(root: HTMLElement, opts: StageOptions = {}) {
  const style = document.createElement('style')
  style.textContent = STYLE
  root.appendChild(style)

  const stage = document.createElement('div')
  stage.className = 'kp-root'
  stage.innerHTML = baseSvg()
  root.appendChild(stage)

  // ── 小动物：三排，后排先放 ──
  const rand = rng(20261012)
  const order = [...ANIMALS.keys()].sort(() => rand() - 0.5)
  const pets: Pet[] = []
  let k = 0
  for (const row of ROWS) {
    for (let i = 0; i < row.n; i++) {
      const a = ANIMALS[order[k++ % order.length]]
      const t = row.n === 1 ? 0.5 : i / (row.n - 1)
      const x = row.x0 + (row.x1 - row.x0) * t + (rand() - 0.5) * 10
      const y = row.y + (rand() - 0.5) * 8
      const el = document.createElement('div')
      el.className = 'kp-pet'
      el.style.left = `${x}px`
      el.style.top = `${y}px`
      el.style.zIndex = String(row.z * 10 + Math.round(rand() * 5))
      el.style.transform = `scale(${row.scale})`
      el.style.setProperty('--dur', `${(1.8 + rand() * 1.6).toFixed(2)}s`)
      el.style.setProperty('--delay', `${(-rand() * 3).toFixed(2)}s`)
      el.style.setProperty('--tilt', `${(1.5 + rand() * 3).toFixed(1)}deg`)
      el.style.setProperty('--blink', `${(3 + rand() * 4).toFixed(2)}s`)
      el.innerHTML = `<div class="kp-bob"><div class="kp-jump"><div class="kp-trail" style="--c:${a.color === '#ffffff' || a.color === '#fffaf2' || a.color === '#fffdf8' ? '#ffd9a8' : a.color}"></div>${a.svg}</div></div>`
      stage.appendChild(el)
      pets.push({
        el,
        jump: el.querySelector('.kp-jump') as HTMLElement,
        trail: el.querySelector('.kp-trail') as HTMLElement,
        color: a.color,
        flying: false,
        x, y, scale: row.scale, z: row.z,
      })
    }
  }

  // ── 前排键帽（压在小动物上面，挡住它们的身子） ──
  const keys = document.createElement('div')
  keys.className = 'kp-keys'
  keys.innerHTML = `<div class="kp-glow"></div>
    <div class="kp-key" data-k="ctrl" style="left:40px;top:222px;width:62px;--kd:-0s">Ctrl</div>
    <div class="kp-key" data-k="alt" style="left:108px;top:222px;width:54px;--kd:-.8s">Alt</div>
    <div class="kp-key" data-k="space" style="left:168px;top:222px;width:128px;--kd:-1.6s"><svg width="38" height="16" viewBox="-2 -2 38 16"><path d="M3 2v6h28V2" fill="none" stroke="#3b2a24" stroke-width="6.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 2v6h28V2" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
    <div class="kp-key" data-k="enter" style="left:302px;top:222px;width:64px;--kd:-2.4s"><svg width="30" height="22" viewBox="-2 -2 30 22"><path d="M22 2v7H5m0 0 5-5M5 9l5 5" fill="none" stroke="#3b2a24" stroke-width="6.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M22 2v7H5m0 0 5-5M5 9l5 5" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg></div>`
  stage.appendChild(keys)
  const keyEl = (k: string) => keys.querySelector<HTMLElement>(`.kp-key[data-k="${k}"]`)

  // ── 右上角的按键小牌 ──
  const sign = document.createElement('div')
  sign.className = 'kp-sign'
  sign.innerHTML = '<span>⌨</span>'
  if (opts.sign === false) sign.style.display = 'none'
  stage.appendChild(sign)

  // ── 动作 ──
  function jump(p: Pet, big = true) {
    p.flying = true
    // 跳到窗口顶上留 4px 的地方，别冲出窗口被裁掉
    const lift = big ? Math.max(48, p.y - (6 + (PET / 2) * p.scale)) / p.scale : 16 / p.scale
    const tilt = (Math.random() < 0.5 ? -1 : 1) * (4 + Math.random() * 6)
    const dur = big ? 950 + Math.random() * 200 : 420
    p.el.style.zIndex = big ? '60' : p.el.style.zIndex
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
      // 尾迹：起跳时从脚下拉长，人在天上时慢慢收掉
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
      p.el.style.zIndex = String(p.z * 10)
    }
  }

  /** 按键名（rdev 的 KeyA / Space / Return / ControlLeft …）映射到一只 */
  function petFor(key: string) {
    let i = hash(key) % pets.length
    for (let n = 0; n < pets.length && pets[i].flying; n++) i = (i + 7) % pets.length
    return pets[i]
  }

  const KEY_OF: Record<string, string> = {
    ControlLeft: 'ctrl', ControlRight: 'ctrl', Alt: 'alt', AltGr: 'alt', Space: 'space', Return: 'enter', KpReturn: 'enter',
  }

  function label(key: string) {
    if (/^Key[A-Z]$/.test(key)) return key.slice(3)
    if (/^Num\d$/.test(key)) return key.slice(3)
    if (/^Kp\d$/.test(key)) return key.slice(2)
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
    const span = sign.querySelector('span')!
    span.textContent = t
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
    const k = KEY_OF[key]
    if (k) {
      keyEl(k)?.classList.add('down')
      if (held.has(key)) return // 按住不放时系统会连发，键帽不重复弹，小动物也别一直蹦
      held.add(key)
    }
    jump(petFor(key))
    showSign(key)
  }
  function release(key: string) {
    held.delete(key)
    const k = KEY_OF[key]
    if (k) keyEl(k)?.classList.remove('down')
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
