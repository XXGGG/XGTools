<script setup lang="ts">
/**
 * 助手页右下角那颗小球：通透的玻璃球（没有底色、没有镜面高光，只有很淡的漫反射和一圈柔边），
 * 中间一束彩色细丝 —— 十几根丝像拧在一起的绳子，绕着横轴不停地螺旋，两头收拢到球的左右边缘并虚化掉。
 * 用 canvas 逐帧画，丝的相位一直往前走，看起来就是在转，不会翻面。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'

const props = withDefaults(defineProps<{ size?: number; active?: boolean }>(), { size: 48, active: false })
const cv = ref<HTMLCanvasElement | null>(null)
let raf = 0

const STRANDS = 14
// 每根丝自己的振幅、相位、粗细，打开时随机一次
const lines = Array.from({ length: STRANDS }, (_, i) => ({
  amp: 0.16 + Math.random() * 0.2,
  phase: (i / STRANDS) * Math.PI * 2 + Math.random() * 0.4,
  width: 0.6 + Math.random() * 0.9,
  twist: 1.1 + Math.random() * 0.5,
}))

function draw(now: number) {
  const c = cv.value
  if (!c) return
  const dpr = Math.min(devicePixelRatio, 2)
  const S = props.size * dpr
  if (c.width !== S) { c.width = S; c.height = S }
  const g = c.getContext('2d')!
  const R = S / 2 - 1 * dpr
  const cx = S / 2, cy = S / 2
  g.clearRect(0, 0, S, S)

  // 玻璃：几乎透明的体，下半边稍微亮一点（漫反射），边缘一圈柔光
  g.save()
  g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.clip()
  const body = g.createRadialGradient(cx, cy + R * 0.35, 0, cx, cy, R)
  body.addColorStop(0, 'rgba(200,210,235,0.10)')
  body.addColorStop(0.7, 'rgba(160,170,200,0.04)')
  body.addColorStop(1, 'rgba(210,220,245,0.20)')
  g.fillStyle = body
  g.fillRect(0, 0, S, S)

  // 丝：x 从左边缘到右边缘，振幅往两头收成 0（拧到一起），透明度也往两头淡掉
  const t = now / 1000 * (props.active ? 1.6 : 0.9)
  g.globalCompositeOperation = 'lighter'
  const grad = g.createLinearGradient(cx - R, 0, cx + R, 0)
  grad.addColorStop(0, 'rgba(120,170,255,0)')
  grad.addColorStop(0.22, 'rgba(120,170,255,0.9)')
  grad.addColorStop(0.5, 'rgba(235,238,255,1)')
  grad.addColorStop(0.78, 'rgba(255,170,110,0.9)')
  grad.addColorStop(1, 'rgba(255,170,110,0)')
  for (const pass of [0, 1]) {
    for (const l of lines) {
      g.beginPath()
      for (let k = 0; k <= 48; k++) {
        const u = k / 48 * 2 - 1                       // -1 ~ 1
        const pinch = Math.pow(1 - u * u, 0.8)          // 两头收拢
        const y = Math.sin(u * Math.PI * l.twist + t + l.phase) * l.amp * pinch
        const px = cx + u * R * 0.98
        const py = cy + y * R
        k ? g.lineTo(px, py) : g.moveTo(px, py)
      }
      g.strokeStyle = grad
      // 第一遍粗而淡当光晕，第二遍细而亮
      g.globalAlpha = pass ? 0.38 : 0.035
      g.lineWidth = (pass ? l.width * 0.7 : l.width * 3) * dpr
      g.stroke()
    }
  }
  g.restore()

  // 外圈柔边（不是白亮的硬边）
  g.globalCompositeOperation = 'source-over'
  g.globalAlpha = 1
  const rim = g.createRadialGradient(cx, cy, R * 0.82, cx, cy, R)
  rim.addColorStop(0, 'rgba(210,220,245,0)')
  rim.addColorStop(1, 'rgba(210,220,245,0.32)')
  g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2)
  g.fillStyle = rim
  g.fill()

  raf = requestAnimationFrame(draw)
}

onMounted(() => { raf = requestAnimationFrame(draw) })
onBeforeUnmount(() => cancelAnimationFrame(raf))
</script>

<template>
  <canvas ref="cv" :style="{ width: `${size}px`, height: `${size}px` }" class="block rounded-full" />
</template>
