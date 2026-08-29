<script setup lang="ts">
/**
 * 启动黑布:主窗口亮相时罩在最上面的一层不透明底(深色主题黑、浅色白),反色粒子从四面八方汇聚成 Logo。
 *
 * 为什么要有它:主窗口是透明窗 + 系统材质(云母),一建出来就显示。设置从磁盘读出来、材质贴上去
 * 之前的几百毫秒,窗口底下是不透明的主题底(index.html 里铺的 boot-base);材质贴上、底摘掉那一下
 * 会闪。布把整个启动过程盖住:底下爱怎么换怎么换,用户看到的只有粒子成形。
 * 等窗口、组件、材质全都就绪,外面调一次 dismiss():粒子向四周散出屏幕外,布淡出,然后卸掉。
 * (窗口不能先藏着再亮相:那样创建的窗口正式版里 DWM 不画云母,见 App.vue 的说明。)
 *
 * 粒子和 ParticleLogo 同源(同一个 lucide box 图标 + 同一款手写字),但这里不要鼠标交互,
 * 多了"散场"这一段,所以单独写,不往那个组件里塞状态机。
 */
import { ref, onMounted, onBeforeUnmount } from 'vue'

const props = withDefaults(defineProps<{
  iconSize?: number
  text?: string
  fontSize?: number
  /** 采样步长(CSS 像素),越小粒子越多 */
  step?: number
}>(), { iconSize: 116, text: 'XGTools', fontSize: 44, step: 2 })

const root = ref<HTMLDivElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)
const fading = ref(false)
/** 深色主题黑布白粒子,浅色主题白布黑粒子。主题在 index.html 里就已经定好(见那段内联脚本) */
const dark = document.documentElement.classList.contains('dark')
const particleColor = dark ? '#fff' : '#111'

// lucide "box",和侧栏 Logo 同一个图标
const ICON_PATHS = [
  'M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z',
  'm3.3 7l8.7 5l8.7-5M12 22V12',
]
const FONT_STACK = "'Excalifont', cursive"

const SPRING = 0.06
const DAMP = 0.86

let raf = 0
let phase: 'converge' | 'scatter' = 'converge'
let hx!: Float32Array, hy!: Float32Array, px!: Float32Array, py!: Float32Array, vx!: Float32Array, vy!: Float32Array
let count = 0
let W = 0, H = 0, dpr = 1

/** 把 Logo 描进离屏画布采样成归位点;出发点撒在屏幕外一圈,从四面八方飞进来 */
function build() {
  const off = document.createElement('canvas')
  off.width = W
  off.height = H
  const c = off.getContext('2d', { willReadFrequently: true })
  if (!c) return

  const iconPx = props.iconSize * dpr
  const gap = 6 * dpr
  c.font = `700 ${props.fontSize * dpr}px ${FONT_STACK}`
  const m = c.measureText(props.text)
  const textH = props.text ? (m.actualBoundingBoxAscent || props.fontSize * dpr * 0.8) + (m.actualBoundingBoxDescent || props.fontSize * dpr * 0.3) : 0
  const totalH = iconPx + (props.text ? gap + textH : 0)
  const top = (H - totalH) / 2

  c.save()
  c.translate((W - iconPx) / 2, top)
  const s = iconPx / 24
  c.scale(s, s)
  c.strokeStyle = '#fff'
  c.lineWidth = 2
  c.lineCap = 'round'
  c.lineJoin = 'round'
  for (const d of ICON_PATHS) c.stroke(new Path2D(d))
  c.restore()

  if (props.text) {
    c.fillStyle = '#fff'
    c.font = `700 ${props.fontSize * dpr}px ${FONT_STACK}`
    c.textAlign = 'center'
    c.textBaseline = 'top'
    c.fillText(props.text, W / 2, top + iconPx + gap)
  }

  const data = c.getImageData(0, 0, W, H).data
  const stride = Math.max(1, Math.round(props.step * dpr))
  const xs: number[] = [], ys: number[] = []
  for (let y = 0; y < H; y += stride) {
    for (let x = 0; x < W; x += stride) {
      if (data[(y * W + x) * 4 + 3] > 90) { xs.push(x); ys.push(y) }
    }
  }
  count = xs.length
  hx = new Float32Array(count); hy = new Float32Array(count)
  px = new Float32Array(count); py = new Float32Array(count)
  vx = new Float32Array(count); vy = new Float32Array(count)
  const margin = 40 * dpr
  for (let i = 0; i < count; i++) {
    hx[i] = xs[i]; hy[i] = ys[i]
    // 出发点:随机挑一条屏幕边,落在边外面一点
    const side = Math.floor(Math.random() * 4)
    if (side === 0) { px[i] = Math.random() * W; py[i] = -margin - Math.random() * H * 0.3 }
    else if (side === 1) { px[i] = W + margin + Math.random() * W * 0.3; py[i] = Math.random() * H }
    else if (side === 2) { px[i] = Math.random() * W; py[i] = H + margin + Math.random() * H * 0.3 }
    else { px[i] = -margin - Math.random() * W * 0.3; py[i] = Math.random() * H }
  }
}

function frame() {
  const el = canvas.value
  const ctx = el?.getContext('2d')
  if (!el || !ctx) return
  let alive = 0
  if (phase === 'converge') {
    for (let i = 0; i < count; i++) {
      vx[i] = (vx[i] + (hx[i] - px[i]) * SPRING) * DAMP
      vy[i] = (vy[i] + (hy[i] - py[i]) * SPRING) * DAMP
      px[i] += vx[i]
      py[i] += vy[i]
    }
    alive = count
  } else {
    // 散场:沿着离开中心的方向越飞越快,飞出画布就不管了
    for (let i = 0; i < count; i++) {
      if (px[i] < -8 || px[i] > W + 8 || py[i] < -8 || py[i] > H + 8) continue
      vx[i] *= 1.08
      vy[i] *= 1.08
      px[i] += vx[i]
      py[i] += vy[i]
      alive++
    }
  }
  ctx.clearRect(0, 0, W, H)
  ctx.fillStyle = particleColor
  ctx.beginPath()
  const sz = Math.max(1, Math.round(dpr))
  for (let i = 0; i < count; i++) ctx.rect(px[i], py[i], sz, sz)
  ctx.fill()
  if (phase === 'scatter' && alive === 0) return
  raf = requestAnimationFrame(frame)
}

/** 散场:粒子飞出屏幕、黑布淡出。resolve 之后外面就可以把组件卸掉 */
function dismiss(): Promise<void> {
  if (phase === 'scatter') return Promise.resolve()
  phase = 'scatter'
  const cx = W / 2, cy = H / 2
  for (let i = 0; i < count; i++) {
    const dx = px[i] - cx, dy = py[i] - cy
    const d = Math.hypot(dx, dy) || 1
    const speed = (3 + Math.random() * 4) * dpr
    vx[i] = (dx / d) * speed + (Math.random() - 0.5) * dpr
    vy[i] = (dy / d) * speed + (Math.random() - 0.5) * dpr
  }
  fading.value = true
  return new Promise((r) => window.setTimeout(r, 650))
}

defineExpose({ dismiss })

onMounted(async () => {
  const el = canvas.value
  if (!el) return
  dpr = Math.min(window.devicePixelRatio || 1, 2)
  W = Math.round(window.innerWidth * dpr)
  H = Math.round(window.innerHeight * dpr)
  el.width = W
  el.height = H
  try {
    await document.fonts.load(`700 ${props.fontSize}px ${FONT_STACK}`)
  } catch { /* 用兜底字体继续 */ }
  build()
  raf = requestAnimationFrame(frame)
})

onBeforeUnmount(() => cancelAnimationFrame(raf))
</script>

<template>
  <div ref="root" class="fixed inset-0 z-[9999] transition-opacity duration-500 ease-out"
    :class="[dark ? 'bg-black' : 'bg-white', fading ? 'opacity-0 pointer-events-none' : 'opacity-100']">
    <canvas ref="canvas" class="absolute inset-0 w-full h-full" />
  </div>
</template>
