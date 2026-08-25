<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { listen } from '@tauri-apps/api/event'
import { useI18n } from '@/i18n'
import { useDockStore } from './dockStore'
import AppGrid from './AppGrid.vue'
import PageIndicator from './PageIndicator.vue'

const { t } = useI18n()
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

  /*
    开关启动台。

    **窗口的显示/隐藏由这里负责,Rust 那边只负责喊一声。**
    以前是 Rust 先无条件 win.show() 再 eval 这个函数,于是出现过一个
    死锁状态:一个应用都没配的时候,下面这段原来被 `if (apps.length > 0)`
    挡着直接跳过,store.isVisible 保持 false —— 可窗口已经被 Rust 显示出来了,
    一张全屏透明层盖在屏幕上。再按快捷键还是走"显示"分支、还是什么都不做,
    于是**永远关不掉**。所有权分散在两处就会这样。

    没有应用也照常打开,只是显示一句空状态。静默什么都不做是最难查的那种坏法。
  */
  ;(window as any).__toggleDock = async () => {
    if (store.isVisible) {
      hideWindow()
      return
    }
    await store.loadSettings()
    await store.loadApps()
    store.updateWindowSize()
    isHiding = false
    isOpen.value = false
    animateKey.value++
    store.isVisible = true
    try {
      await appWindow.show()
      await appWindow.setFocus()
    } catch { /* 窗口没了就算了 */ }
    requestAnimationFrame(() => {
      isOpen.value = true
    })
  }

  ;(window as any).__showDock = (window as any).__toggleDock

  // 监听来自 Rust emit 的 toggle-dock 事件
  listen('toggle-dock', () => {
    ;(window as any).__toggleDock?.()
  })

  // 托盘的「强制关闭所有浮层」:窗口那边已经 hide 了,这里只需把状态归位,
  // 否则下次按快捷键会以为还开着,变成"要按两下才出来"。
  listen('force-close-dock', () => {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null }
    isHiding = false
    isOpen.value = false
    store.isVisible = false
    store.currentPage = 0
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
        <!-- 一个应用都没配时:如实说,并指出去哪儿加。不能空着 —— 空着的话
             用户看到的是一张什么都没有的全屏黑layer,只会以为程序卡了。 -->
        <div v-if="!store.apps.length" class="flex-1 w-full flex items-center justify-center">
          <div class="text-center select-none">
            <span class="icon-[lucide--layout-grid] w-10 h-10 mx-auto block text-white/40" />
            <p class="mt-4 text-sm text-white/70">{{ t('dock.emptyTitle') }}</p>
            <p class="mt-1 text-xs text-white/45">{{ t('dock.emptyHint') }}</p>
          </div>
        </div>
        <div v-else class="flex-1 w-full">
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
