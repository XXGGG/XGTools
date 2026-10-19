<script setup lang="ts">
/**
 * 钉在屏幕上的截图（label: pin_*）。
 *
 * 窗口是透明的，比图片大一圈：一圈留给阴影，图片小的时候右上再多留一块放关闭按钮。
 * 鼠标移进来右上角出现关闭按钮 —— 图片够大就在图片里面的右上角，太小（按钮会挡住大半张图）就放到图片外面。
 * 右键还是「关闭」菜单；窗口太小放不下菜单时，临时把窗口撑大，菜单收起再缩回去
 * （以前小图右键，菜单被窗口边裁掉，看不见也点不到 —— 2026-10-19 用户报的）。
 */
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { listen, emit as tauriEmit } from '@tauri-apps/api/event'
import { PhysicalPosition, PhysicalSize } from '@tauri-apps/api/dpi'
import { useI18n, applySavedLocale } from '@/i18n'

const { t } = useI18n()

const imgSrc = ref('')
const appWindow = getCurrentWindow()
let unlisten: (() => void) | null = null

/** 阴影那一圈（CSS px） */
const EDGE = 10
/** 关闭按钮放在图片外面时多留的那块 */
const OUTSIDE = 28
/** 图片比这小，关闭按钮就放外面 */
const SMALL_W = 140
const SMALL_H = 72

const imgW = ref(0) // CSS px
const imgH = ref(0)
const small = computed(() => imgW.value < SMALL_W || imgH.value < SMALL_H)
const pad = computed(() => ({ l: EDGE, t: EDGE + (small.value ? OUTSIDE : 0), r: EDGE + (small.value ? OUTSIDE : 0), b: EDGE }))
const hover = ref(false)

let sf = 1
/** 图片左上角在屏幕上的物理坐标、物理尺寸（窗口位置从它反推） */
let base = { x: 0, y: 0, w: 0, h: 0 }

async function placeWindow(extraW = 0, extraH = 0) {
  const p = pad.value
  const pos = new PhysicalPosition(Math.round(base.x - p.l * sf), Math.round(base.y - p.t * sf))
  const size = new PhysicalSize(Math.round(base.w + (p.l + p.r + extraW) * sf), Math.round(base.h + (p.t + p.b + extraH) * sf))
  // 设两遍：跨屏幕 DPI 时第一遍会被系统按旧缩放换算一次
  for (let i = 0; i < 2; i++) await Promise.all([appWindow.setPosition(pos), appWindow.setSize(size)])
}

// 右键菜单
const showMenu = ref(false)
const menuX = ref(0)
const menuY = ref(0)
const MENU_W = 110
const MENU_H = 40
let grown = false

async function onContextMenu(e: MouseEvent) {
  e.preventDefault()
  e.stopPropagation()
  menuX.value = e.clientX
  menuY.value = e.clientY
  // 放不下就把窗口往右下撑大一点，菜单收起时再缩回
  const needW = Math.max(0, e.clientX + MENU_W - window.innerWidth)
  const needH = Math.max(0, e.clientY + MENU_H - window.innerHeight)
  if (needW || needH) {
    grown = true
    await placeWindow(needW, needH)
  }
  showMenu.value = true
}

async function hideMenu() {
  if (!showMenu.value) return
  showMenu.value = false
  if (grown) {
    grown = false
    await placeWindow()
  }
}

async function closePin() {
  try {
    await appWindow.close()
  }
  catch {
    await appWindow.destroy()
  }
}

// 左键按住图片拖动
let dragPending = false

function onMouseDown(e: MouseEvent) {
  if (e.button === 0) {
    void hideMenu()
    dragPending = true
  }
}

async function onMouseMove(e: MouseEvent) {
  if (!dragPending || e.buttons !== 1) {
    dragPending = false
    return
  }
  dragPending = false
  await appWindow.startDragging()
}

function onMouseUp() {
  dragPending = false
}

onMounted(async () => {
  applySavedLocale() // 副窗口独立 WebView，语言要自己从 settings.json 取一次
  document.body.classList.add('screenshot-window')
  document.documentElement.style.background = 'transparent'
  document.body.style.background = 'transparent'

  // 窗口被拖动后，记下图片的新位置（菜单撑大 / 缩回时按它算）
  void appWindow.onMoved(({ payload }) => {
    if (grown) return
    base = { ...base, x: payload.x + pad.value.l * sf, y: payload.y + pad.value.t * sf }
  })

  const myLabel = appWindow.label
  unlisten = await listen<{ dataUrl: string; x: number; y: number; w: number; h: number }>(
    `pin-image-data:${myLabel}`,
    async (event) => {
      const { dataUrl, x, y, w, h } = event.payload
      sf = await appWindow.scaleFactor()
      base = { x, y, w, h }
      imgW.value = w / sf
      imgH.value = h / sf
      imgSrc.value = dataUrl
      await nextTick()
      await placeWindow()
      await appWindow.show()
      await appWindow.setFocus()
    },
  )

  // 通知创建者：listener 已就绪，可以发送数据了
  await tauriEmit('pin-ready', { label: myLabel })
})

onUnmounted(() => {
  unlisten?.()
})
</script>

<template>
  <div class="pin-root" @contextmenu="onContextMenu" @mouseenter="hover = true" @mouseleave="hover = false; hideMenu()">
    <div
      v-if="imgSrc"
      class="pin-frame"
      :style="{ left: pad.l + 'px', top: pad.t + 'px', right: pad.r + 'px', bottom: pad.b + 'px' }"
      @mousedown="onMouseDown"
      @mousemove="onMouseMove"
      @mouseup="onMouseUp"
    >
      <img :src="imgSrc" class="pin-img" draggable="false">
    </div>

    <button
      v-if="imgSrc"
      class="pin-close"
      :class="{ show: hover && !showMenu, outside: small }"
      :style="small ? { left: (pad.l + imgW + 2) + 'px', top: (pad.t - 26) + 'px' } : { right: (pad.r + 6) + 'px', top: (pad.t + 6) + 'px' }"
      :title="t('window.close')"
      @mousedown.stop
      @click="closePin"
    >
      <span class="icon-[lucide--x] w-3.5 h-3.5" />
    </button>

    <!-- 右键菜单 -->
    <div
      v-if="showMenu"
      class="ctx-menu"
      :style="{ left: menuX + 'px', top: menuY + 'px' }"
      @mousedown.stop
    >
      <button class="ctx-item" @click="closePin">{{ t('window.close') }}</button>
    </div>
  </div>
</template>

<style scoped>
.pin-root {
  position: fixed;
  inset: 0;
  overflow: hidden;
  background: transparent;
  user-select: none;
}

.pin-frame {
  position: absolute;
  cursor: move;
  background: #000;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(255, 255, 255, 0.08);
}

.pin-img {
  width: 100%;
  height: 100%;
  object-fit: fill;
  pointer-events: none;
  display: block;
}

.pin-close {
  position: absolute;
  width: 22px;
  height: 22px;
  border-radius: 999px;
  border: none;
  display: grid;
  place-items: center;
  background: rgba(20, 20, 20, 0.78);
  color: #fff;
  cursor: pointer;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.12s, background 0.12s;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);
}
.pin-close.show {
  opacity: 1;
  pointer-events: auto;
}
.pin-close:hover {
  background: #e5484d;
}

.ctx-menu {
  position: fixed;
  background: rgba(30, 30, 30, 0.95);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 6px;
  padding: 4px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
  z-index: 100;
}

.ctx-item {
  display: block;
  width: 100%;
  padding: 6px 24px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: #ddd;
  font-size: 13px;
  cursor: pointer;
  text-align: left;
  white-space: nowrap;
}

.ctx-item:hover {
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
}
</style>
