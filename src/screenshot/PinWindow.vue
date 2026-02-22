<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick } from 'vue'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { listen } from '@tauri-apps/api/event'
import { PhysicalPosition, PhysicalSize } from '@tauri-apps/api/dpi'

const imgSrc = ref('')
const appWindow = getCurrentWindow()
let unlisten: (() => void) | null = null

// 右键菜单
const showMenu = ref(false)
const menuX = ref(0)
const menuY = ref(0)

function onContextMenu(e: MouseEvent) {
  e.preventDefault()
  e.stopPropagation()
  menuX.value = e.clientX
  menuY.value = e.clientY
  showMenu.value = true
}

function hideMenu() {
  showMenu.value = false
}

async function closePin() {
  try {
    await appWindow.close()
  } catch {
    await appWindow.destroy()
  }
}

// 左键拖拽
let dragPending = false

function onMouseDown(e: MouseEvent) {
  if (e.button === 0) {
    hideMenu()
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
  document.body.classList.add('screenshot-window')

  unlisten = await listen<{ dataUrl: string; x: number; y: number; w: number; h: number }>(
    'pin-image-data',
    async (event) => {
      const { dataUrl, x, y, w, h } = event.payload
      imgSrc.value = dataUrl

      await nextTick()

      const pos = new PhysicalPosition(x, y)
      const size = new PhysicalSize(w, h)
      await Promise.all([
        appWindow.setPosition(pos),
        appWindow.setSize(size),
      ])
      await Promise.all([
        appWindow.setPosition(pos),
        appWindow.setSize(size),
      ])

      await appWindow.show()
      await appWindow.setFocus()
    }
  )
})

onUnmounted(() => {
  unlisten?.()
})
</script>

<template>
  <div
    class="pin-container"
    @contextmenu="onContextMenu"
    @mousedown="onMouseDown"
    @mousemove="onMouseMove"
    @mouseup="onMouseUp"
  >
    <img v-if="imgSrc" :src="imgSrc" class="pin-img" draggable="false" />

    <!-- 右键菜单 -->
    <div
      v-if="showMenu"
      class="ctx-menu"
      :style="{ left: menuX + 'px', top: menuY + 'px' }"
      @mousedown.stop
    >
      <button class="ctx-item" @click="closePin">关闭</button>
    </div>
  </div>
</template>

<style scoped>
.pin-container {
  position: fixed;
  top: 0; left: 0;
  width: 100vw; height: 100vh;
  margin: 0; padding: 0;
  overflow: hidden;
  background: #000;
  user-select: none;
  cursor: move;
}

.pin-img {
  width: 100%;
  height: 100%;
  object-fit: fill;
  pointer-events: none;
  display: block;
}

.ctx-menu {
  position: fixed;
  background: rgba(30, 30, 30, 0.95);
  border: 1px solid rgba(255,255,255,0.12);
  border-radius: 6px;
  padding: 4px;
  box-shadow: 0 4px 16px rgba(0,0,0,0.5);
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
  background: rgba(255,255,255,0.1);
  color: #fff;
}
</style>
