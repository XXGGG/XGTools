<script setup lang="ts">
/**
 * 粒子化的 Logo + 字标：粒子拼出图形与文字，鼠标靠近被推散，移开后弹回原位。
 *
 * 为什么不直接采样页面上那个 `icon-[lucide--box]`：
 * 它是 iconify 用 CSS mask 画的，既拿不到位图也读不到路径。所以这里内联同一个 lucide 图标的
 * 路径数据，先离屏描一遍、读像素、再把有墨迹的位置采成粒子。文字同理，用 canvas 描一遍再采样。
 *
 * 字体栈刻意和页面保持一致（'Caveat', cursive）：项目里那个 @font-face 指向的文件其实不存在，
 * 页面上看到的手写体是系统 cursive 兜底。这里用同一个栈，粒子字才和页面其他地方长得一样。
 *
 * 性能上和常见实现的三点差别（参考实现卡顿基本都出在这些地方）：
 *   ① 位置/速度用定长 Float32Array，整个动画循环零分配、不产生 GC 抖动；
 *   ② 每帧只有一次 beginPath + 一次 fill —— 不是每颗粒子一次 fillRect / 一个 Path2D；
 *   ③ **静止就停 rAF**。粒子归位且指针不在附近时直接退出循环，等下一次 pointermove 再唤醒，
 *      所以待机时这个组件是 0 开销的，而不是永远空转。
 */
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'

const props = withDefaults(defineProps<{
  /** 图标边长（CSS 像素） */
  iconSize?: number
  /** 字标文字；留空则只画图标 */
  text?: string
  /** 字标字号（CSS 像素） */
  fontSize?: number
  /** 图标与字标之间的间距 */
  gap?: number
  /**
   * 画布四周的留白。粒子被推开后会跑到图形之外，留白不够就会被画布边缘裁掉
   * （表现为肉眼可见的方框切边）。至少要留到 radius 这个量级。
   */
  pad?: number
  /** 采样步长：越小粒子越多越细腻，代价是数量平方级增长。 */
  step?: number
  /** 鼠标影响半径（CSS 像素） */
  radius?: number
  /**
   * 要采样的图标路径。默认是 lucide 的 box（和侧栏 Logo 同一个）。
   * 换图标时 viewBox 和描边宽度也要跟着换 —— 不同图标集的视框尺寸不一样
   * （lucide 是 24，arcticons 是 48），只换 path 会得到一个巨大或极小的图形。
   */
  iconPaths?: string[]
  /** 上面那些 path 用的视框边长 */
  iconViewBox?: number
  /** 描边宽度，按 viewBox 的单位算 */
  iconStrokeWidth?: number
}>(), {
  iconSize: 104, text: 'XGTools', fontSize: 46, gap: 2,
  pad: 90, step: 1.5, radius: 100,
  iconViewBox: 24, iconStrokeWidth: 2,
})

const canvas = ref<HTMLCanvasElement | null>(null)

// lucide "box"，24×24 视口。与侧栏 Logo 同一个图标。
const ICON_PATHS = [
  'M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z',
  'm3.3 7l8.7 5l8.7-5M12 22V12',
]
const FONT_STACK = "'Caveat', cursive"

let raf = 0
let running = false
let themeObs: MutationObserver | null = null

// 画布在页面里的位置。pointermove 每秒上百次，不能每次都 getBoundingClientRect ——
// 那是强制同步布局。这里缓存下来，只在窗口变化时刷新。
let rectL = 0, rectT = 0

// 定长缓冲：hx/hy 是归位目标，px/py 当前位置，vx/vy 速度
let hx!: Float32Array, hy!: Float32Array
let px!: Float32Array, py!: Float32Array
let vx!: Float32Array, vy!: Float32Array
let count = 0

// 指针位置（画布局部坐标，设备像素）。-1e9 表示不在影响范围内。
let mx = -1e9, my = -1e9

// 画布 CSS 尺寸：由内容量出来，不是外部传的
const cssW = ref(0), cssH = ref(0)

let color = '#000'
function readColor() {
  const el = canvas.value
  if (!el) return
  color = getComputedStyle(el).color || '#000'
}

/** 量出容纳「图标 + 字标 + 四周留白」所需的画布尺寸 */
function measureContent() {
  const probe = document.createElement('canvas').getContext('2d')
  let textW = 0, textH = 0
  if (probe && props.text) {
    probe.font = `700 ${props.fontSize}px ${FONT_STACK}`
    const m = probe.measureText(props.text)
    textW = m.width
    // 手写体上下伸出明显，用实际包围盒而不是字号
    textH = (m.actualBoundingBoxAscent || props.fontSize * 0.8)
          + (m.actualBoundingBoxDescent || props.fontSize * 0.3)
  }
  cssW.value = Math.ceil(props.pad * 2 + Math.max(props.iconSize, textW))
  cssH.value = Math.ceil(props.pad * 2 + props.iconSize + (props.text ? props.gap + textH : 0))
}

/** 把图标和文字描进离屏画布，按 step 网格采样成粒子的归位坐标 */
function buildParticles(dpr: number) {
  const off = document.createElement('canvas')
  off.width = Math.round(cssW.value * dpr)
  off.height = Math.round(cssH.value * dpr)
  const c = off.getContext('2d', { willReadFrequently: true })
  if (!c) return

  const pad = props.pad * dpr
  const iconPx = props.iconSize * dpr

  // 图标：把视框缩放到 iconPx，水平居中放在上方留白之下
  c.save()
  c.translate((off.width - iconPx) / 2, pad)
  const scale = iconPx / props.iconViewBox
  c.scale(scale, scale)
  c.strokeStyle = '#fff'
  c.lineWidth = props.iconStrokeWidth
  c.lineCap = 'round'
  c.lineJoin = 'round'
  for (const d of (props.iconPaths ?? ICON_PATHS)) c.stroke(new Path2D(d))
  c.restore()

  // 字标
  if (props.text) {
    c.fillStyle = '#fff'
    c.font = `700 ${props.fontSize * dpr}px ${FONT_STACK}`
    c.textAlign = 'center'
    c.textBaseline = 'top'
    c.fillText(props.text, off.width / 2, pad + iconPx + props.gap * dpr)
  }

  const data = c.getImageData(0, 0, off.width, off.height).data
  // 步长跟着 dpr 一起放大 → 粒子数与屏幕缩放无关，2x 屏不会变成 4 倍的模拟量
  const stride = Math.max(1, Math.round(props.step * dpr))

  const xs: number[] = [], ys: number[] = []
  for (let y = 0; y < off.height; y += stride) {
    for (let x = 0; x < off.width; x += stride) {
      if (data[(y * off.width + x) * 4 + 3] > 90) { xs.push(x); ys.push(y) }
    }
  }

  count = xs.length
  hx = new Float32Array(count); hy = new Float32Array(count)
  px = new Float32Array(count); py = new Float32Array(count)
  vx = new Float32Array(count); vy = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    hx[i] = xs[i]; hy[i] = ys[i]
    // 入场：从随机方向飞入归位，不是凭空出现
    const a = Math.random() * Math.PI * 2
    const r = (0.3 + Math.random() * 0.8) * off.width * 0.5
    px[i] = xs[i] + Math.cos(a) * r
    py[i] = ys[i] + Math.sin(a) * r
  }
}

function measure() {
  const el = canvas.value
  if (!el) return
  const r = el.getBoundingClientRect()
  rectL = r.left; rectT = r.top
}

async function setup() {
  const el = canvas.value
  if (!el) return
  // 字体没加载完就描字，量出来的宽度和形状都是兜底字体的，会和最终显示对不上。
  // 加载失败无所谓（本来就走系统兜底），catch 掉继续。
  try {
    await document.fonts.load(`700 ${props.fontSize}px ${FONT_STACK}`)
    await document.fonts.ready
  } catch { /* 用兜底字体继续 */ }
  if (!canvas.value) return

  measureContent()
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  el.width = Math.round(cssW.value * dpr)
  el.height = Math.round(cssH.value * dpr)
  el.style.width = `${cssW.value}px`
  el.style.height = `${cssH.value}px`
  readColor()
  measure()
  buildParticles(dpr)
  wake()
}

const SPRING = 0.055      // 归位弹簧
const DAMP = 0.86         // 阻尼；和 SPRING 一起决定回弹的"弹性"
const PUSH = 2.6          // 指针推力

function frame() {
  const el = canvas.value
  if (!el || !cssW.value) { running = false; return }
  const ctx = el.getContext('2d')
  if (!ctx) { running = false; return }

  const dpr = el.width / cssW.value
  const R = props.radius * dpr
  const R2 = R * R
  let moving = 0

  for (let i = 0; i < count; i++) {
    let ax = (hx[i] - px[i]) * SPRING
    let ay = (hy[i] - py[i]) * SPRING

    if (mx > -1e8) {
      const dx = px[i] - mx, dy = py[i] - my
      const d2 = dx * dx + dy * dy
      if (d2 < R2 && d2 > 0.0001) {
        // 越近推力越强（线性衰减到边缘为 0），方向沿指针 → 粒子
        const d = Math.sqrt(d2)
        const f = (1 - d / R) * PUSH
        ax += (dx / d) * f
        ay += (dy / d) * f
      }
    }

    vx[i] = (vx[i] + ax) * DAMP
    vy[i] = (vy[i] + ay) * DAMP
    px[i] += vx[i]
    py[i] += vy[i]

    // 速度和离位距离一起判静止：只看速度会在"被推到远处但恰好速度为 0"那帧误判
    const ox = px[i] - hx[i], oy = py[i] - hy[i]
    if (vx[i] * vx[i] + vy[i] * vy[i] > 0.0004 || ox * ox + oy * oy > 0.05) moving++
  }

  ctx.clearRect(0, 0, el.width, el.height)
  ctx.fillStyle = color
  // 一次 beginPath + 一次 fill：整帧只有一个绘制调用
  ctx.beginPath()
  const s = Math.max(1, Math.round(dpr))
  for (let i = 0; i < count; i++) ctx.rect(px[i], py[i], s, s)
  ctx.fill()

  // 全部归位且指针不在附近 → 直接停掉，等 pointermove 再唤醒（待机零开销）
  if (moving === 0 && mx <= -1e8) { running = false; return }
  raf = requestAnimationFrame(frame)
}

function wake() {
  if (running) return
  running = true
  raf = requestAnimationFrame(frame)
}

function onPointerMove(e: PointerEvent) {
  const el = canvas.value
  if (!el || !cssW.value) return
  const dpr = el.width / cssW.value
  const x = (e.clientX - rectL) * dpr
  const y = (e.clientY - rectT) * dpr

  // 指针离画布够远时当作"不存在"。
  // 这一步是 rAF 能停下来的前提：光标只要还在屏幕上，pointerleave 基本不会触发，
  // 若不在这里把它归零，循环就永远等不到静止条件。顺带也省掉远处那些无用的逐粒子计算。
  const R = props.radius * dpr
  if (x < -R || y < -R || x > el.width + R || y > el.height + R) {
    if (mx > -1e8) { mx = my = -1e9; wake() }
    return
  }
  mx = x; my = y
  wake()
}

onMounted(() => {
  setup()
  // 监听整个窗口：粒子在鼠标"接近"时就该有反应，而不是等指针真的进到画布里
  window.addEventListener('pointermove', onPointerMove, { passive: true })
  // 画布尺寸由内容算死，不用 ResizeObserver（观察一个自己会改尺寸的元素容易自触发）；
  // 只需要在窗口变化时重新量一次它的位置。
  window.addEventListener('resize', measure, { passive: true })

  // 深浅色切换后前景色变了。每帧 getComputedStyle 太贵，改成监听 <html> 的 class 变化。
  themeObs = new MutationObserver(() => { readColor(); wake() })
  themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  running = false
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('resize', measure)
  themeObs?.disconnect()
})

watch(() => [props.iconSize, props.text, props.fontSize, props.step], setup)
</script>

<template>
  <canvas ref="canvas" class="text-foreground pointer-events-none select-none" />
</template>
