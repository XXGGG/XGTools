/**
 * 键盘桌宠的舞台：一块圆角厚底座，上面按键盘字母排挤着 26 只小动物，前面一排四个有厚度的键帽。
 *
 * 2026-10-12 第三版：
 * - 底座和键帽改成 three.js 真 3D（keyboard3d.ts），角度是用户在取景台里亲手调的，不描边、靠光影出立体感
 * - 小动物还是手绘 canvas（animals.ts），站位从 3D 里算：每只的脚踩在底座上一个真实的点，近大远小跟着透视走
 * - 小动物和字母一一对应：后排 QWERTYUIOP（10 只）、中排 ASDFGHJKL（9 只）、前排 ZXCVBNM（7 只），
 *   按哪个字母就是哪一只跳；Ctrl / Shift / 空格 / 回车 按下去键帽沉一半
 *
 * 不依赖 Vue：纯 DOM + Web Animations，桌宠窗口和独立预览页都能直接用。
 */
import { ANIMALS, ROW_KEYS, animalCanvas } from './animals'
import { BASE, KEY_BACK, createKeyboard } from './keyboard3d'
import { STAGE_W as W, STAGE_H as H } from './dims'

export type StageOptions = { sign?: boolean }

const OL = '#3d2b22'

/**
 * 三排站在底座上的哪条线（z 越小越靠后），以及从左往右怎么排：
 * 相邻两排错开半个身位，后排的能从前排两只中间露出来
 */
const ROWS = [
  { keys: ROW_KEYS[0], z: -2.1, from: -4.5, zi: 10 },
  { keys: ROW_KEYS[1], z: -0.9, from: -4, zi: 20 },
  { keys: ROW_KEYS[2], z: 0.3, from: -2.5, zi: 30 },
]
const PITCH = 0.92 // 相邻两只隔多远（世界单位）
const PET = 80 // 小动物画布的 CSS 尺寸，实际大小靠 scale
const PET_UNITS = 2.2 // 画布在世界里有多高（含留白）
const FEET = 0.9 // 脚在画布高度的哪里（transform-origin 也在这）

const KEY_OF: Record<string, string> = {
  ControlLeft: 'ctrl', ControlRight: 'ctrl', ShiftLeft: 'shift', ShiftRight: 'shift',
  Space: 'space', Return: 'enter', KpReturn: 'enter',
}

type Pet = { el: HTMLElement; jump: HTMLElement; shadow: HTMLElement; trail: HTMLElement; flying: boolean; feet: number; scale: number }

const STYLE = `
.kp-root { position: relative; width: ${W}px; height: ${H}px; user-select: none; }
.kp-root * { box-sizing: border-box; }
.kp-root > canvas { position: absolute; left: 0; top: 0; width: ${W}px; height: ${H}px; pointer-events: none; }
.kp-pet { position: absolute; width: ${PET}px; height: ${PET}px; margin-left: ${-PET / 2}px; transform-origin: 50% ${FEET * 100}%; }
.kp-shadow {
  position: absolute; left: 22%; width: 56%; top: ${FEET * 100 - 7}%; height: 14%; border-radius: 50%;
  background: radial-gradient(closest-side, rgb(74 52 38 / 0.34), rgb(74 52 38 / 0.12) 60%, transparent);
  transform: translateX(7%);
}
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

export function createStage(root: HTMLElement, opts: StageOptions = {}) {
  const style = document.createElement('style')
  style.textContent = STYLE
  root.appendChild(style)

  const stage = document.createElement('div')
  stage.className = 'kp-root'
  const kb = createKeyboard(W, H)
  stage.appendChild(kb.canvas)
  root.appendChild(stage)

  // 前排的脚要高过键帽后沿，不然看着像踩在键帽前面
  const keyLine = kb.project(0, KEY_BACK.y, KEY_BACK.z).y

  // ── 小动物：按键盘字母排三排，后排先放 ──
  const rand = rng(20261012)
  const byLetter = new Map<string, Pet>()
  const pets: Pet[] = []
  let idx = 0
  for (const row of ROWS) {
    for (let i = 0; i < row.keys.length; i++) {
      const a = ANIMALS[idx++]
      const wx = (row.from + i) * PITCH + (rand() - 0.5) * 0.12
      const wz = row.z + (rand() - 0.5) * 0.12
      const p = kb.project(wx, BASE.h, wz)
      const feet = Math.min(p.y, keyLine - 2)
      const scale = (PET_UNITS * kb.unitPx(wx, BASE.h, wz)) / PET
      const el = document.createElement('div')
      el.className = 'kp-pet'
      el.style.left = `${p.x}px`
      el.style.top = `${feet - FEET * PET}px`
      el.style.zIndex = String(row.zi + Math.round(rand() * 4))
      el.style.transform = `scale(${scale})`
      el.style.setProperty('--dur', `${(1.8 + rand() * 1.6).toFixed(2)}s`)
      el.style.setProperty('--delay', `${(-rand() * 4).toFixed(2)}s`)
      el.style.setProperty('--tilt', `${(1.5 + rand() * 2.5).toFixed(1)}deg`)
      el.style.setProperty('--blink', `${(3 + rand() * 4).toFixed(2)}s`)
      const light = ['#ffffff', '#fffaf2', '#f7f9fc'].includes(a.color)
      el.innerHTML = `<div class="kp-shadow"></div><div class="kp-bob"><div class="kp-jump"><div class="kp-trail" style="--c:${light ? '#ffd2a0' : a.color}"></div></div></div>`
      const jumpEl = el.querySelector('.kp-jump') as HTMLElement
      const open = animalCanvas(a.id, false)
      open.className = 'open'
      const closed = animalCanvas(a.id, true)
      closed.className = 'closed'
      jumpEl.append(open, closed)
      stage.appendChild(el)
      const pet: Pet = {
        el, jump: jumpEl, shadow: el.querySelector('.kp-shadow') as HTMLElement,
        trail: el.querySelector('.kp-trail') as HTMLElement, flying: false, feet, scale,
      }
      pets.push(pet)
      byLetter.set(row.keys[i], pet)
    }
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
    const top = p.feet - FEET * PET * p.scale
    const lift = big ? Math.max(44, top - 6) / p.scale : 14 / p.scale
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
    // 影子留在原地：人一离地就变小变淡，落地再回来
    p.shadow.animate(
      big
        ? [
            { transform: 'translateX(7%) scale(1)', opacity: 1 },
            { transform: 'translateX(7%) scale(1.1)', opacity: 1, offset: 0.1 },
            { transform: 'translateX(7%) scale(0.55)', opacity: 0.35, offset: 0.34 },
            { transform: 'translateX(7%) scale(0.5)', opacity: 0.3, offset: 0.5 },
            { transform: 'translateX(7%) scale(0.6)', opacity: 0.4, offset: 0.62 },
            { transform: 'translateX(7%) scale(1)', opacity: 1, offset: 0.84 },
            { transform: 'translateX(7%) scale(1.12)', opacity: 1, offset: 0.91 },
            { transform: 'translateX(7%) scale(1)', opacity: 1 },
          ]
        : [
            { transform: 'translateX(7%) scale(1)', opacity: 1 },
            { transform: 'translateX(7%) scale(0.85)', opacity: 0.75, offset: 0.5 },
            { transform: 'translateX(7%) scale(1)', opacity: 1 },
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
    if (k) kb.press(k)
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
    if (k) kb.release(k)
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
    /** 窗口整体缩放了多少：键盘按实际像素重画，放大了也不糊 */
    setScale(s: number) {
      kb.setPixelRatio((window.devicePixelRatio || 1) * s)
    },
    destroy() {
      window.clearTimeout(idleTimer)
      kb.dispose()
      stage.remove()
      style.remove()
    },
    size: { w: W, h: H },
  }
}
