<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { listen } from '@tauri-apps/api/event'
import { useDockStore } from './dockStore'
import AppGrid from './AppGrid.vue'
import PageIndicator from './PageIndicator.vue'

const store = useDockStore()
const appWindow = getCurrentWebviewWindow()
const appGridRef = ref<InstanceType<typeof AppGrid> | null>(null)
let isHiding = false

const animateKey = ref(0)
const isOpen = ref(false)

// 毛玻璃由窗口级 acrylic 提供，前端只需要透明背景

const contentPadding = computed(() => ({
  paddingTop: `${store.paddingTop}px`,
  paddingBottom: `${store.paddingTop}px`,
  paddingLeft: `${store.paddingHorizontal}px`,
  paddingRight: `${store.paddingHorizontal}px`,
}))

onMounted(async () => {
  // dock 窗口背景透明
  document.body.classList.add('dock-window')

  await store.loadSettings()
  await store.loadApps()
  appWindow.hide()

  ;(window as any).__toggleDock = async () => {
    if (store.isVisible) {
      hideWindow()
    } else {
      await store.loadSettings()
      await store.loadApps()
      store.updateWindowSize()
      if (store.apps.length > 0) {
        isHiding = false
        isOpen.value = false
        animateKey.value++
        store.isVisible = true
        requestAnimationFrame(() => {
          isOpen.value = true
        })
      }
    }
  }

  ;(window as any).__showDock = (window as any).__toggleDock

  // 监听来自 Rust emit 的 toggle-dock 事件
  listen('toggle-dock', () => {
    ;(window as any).__toggleDock?.()
  })
})

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    hideWindow()
  } else if (e.key === 'ArrowLeft') {
    appGridRef.value?.goPage('left')
  } else if (e.key === 'ArrowRight') {
    appGridRef.value?.goPage('right')
  }
}

let hideTimer: ReturnType<typeof setTimeout> | null = null

function doHide() {
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null }
  store.isVisible = false
  store.currentPage = 0
  setTimeout(() => appWindow.hide(), 30)
}

function hideWindow() {
  if (isHiding) return
  isHiding = true
  isOpen.value = false
  hideTimer = setTimeout(doHide, 200)
}

function onTransitionEnd(e: TransitionEvent) {
  if (e.target !== e.currentTarget) return
  if (!isOpen.value && isHiding) {
    doHide()
  }
}

function handleBackdropClick(e: MouseEvent) {
  const target = e.target as HTMLElement
  if (!target.closest('.app-cell')) {
    hideWindow()
  }
}

function onAfterEnter(el: Element) {
  (el as HTMLElement).focus()
}

let unlisten: (() => void) | null = null
onMounted(async () => {
  unlisten = await appWindow.onFocusChanged(async ({ payload: focused }) => {
    if (!focused && store.isVisible && !isHiding) {
      hideWindow()
    }
  })
})

onUnmounted(() => {
  unlisten?.()
})
</script>

<template>
  <Transition name="dock-mount" @after-enter="onAfterEnter">
    <div
      v-if="store.isVisible"
      :key="animateKey"
      id="backdrop"
      class="dock-backdrop fixed inset-0 w-screen h-screen select-none"
      :class="{ 'is-open': isOpen }"
      @click="handleBackdropClick"
      @contextmenu.prevent="hideWindow"
      @keydown="handleKeydown"
      @transitionend="onTransitionEnd"
      tabindex="0"
    >
      <div class="dock-content h-full flex flex-col" :style="contentPadding">
        <div class="flex-1 w-full">
          <AppGrid ref="appGridRef" />
        </div>
        <PageIndicator v-if="store.totalPages > 1" class="flex justify-center pt-6" @click.stop />
      </div>
    </div>
  </Transition>
</template>

<style>
/* 毛玻璃由窗口级 acrylic 提供，前端背景透明 */
.dock-backdrop {
  background-color: transparent;
}

/* 关闭动画 0.2s */
.dock-content {
  opacity: 0;
  transform: scale(0.95);
  transition:
    opacity 0.18s ease-in,
    transform 0.18s ease-in;
}

/* 打开动画 0.3s */
.dock-backdrop.is-open .dock-content {
  opacity: 1;
  transform: scale(1);
  transition:
    opacity 0.3s cubic-bezier(0.16, 1, 0.3, 1),
    transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}

.dock-mount-enter-active {
  transition: none;
}
.dock-mount-enter-from {
  opacity: 1;
}
</style>
