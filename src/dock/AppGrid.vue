<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { useDockStore } from './dockStore'
import AppIcon from './AppIcon.vue'

const store = useDockStore()

const isFirstRender = ref(true)
const slideClass = ref('')
const isSliding = ref(false)

watch(() => store.isVisible, (val) => {
  if (val) {
    isFirstRender.value = true
    slideClass.value = ''
  }
})

function goPage(dir: 'left' | 'right') {
  if (isSliding.value) return
  if (dir === 'right' && store.currentPage >= store.totalPages - 1) return
  if (dir === 'left' && store.currentPage <= 0) return

  isFirstRender.value = false
  isSliding.value = true
  slideClass.value = dir === 'right' ? 'slide-out-left' : 'slide-out-right'
}

function onAnimationEnd() {
  if (!isSliding.value) return

  if (slideClass.value.startsWith('slide-out')) {
    const wasLeft = slideClass.value === 'slide-out-left'
    if (wasLeft) {
      store.nextPage()
      slideClass.value = 'slide-in-from-right'
    } else {
      store.prevPage()
      slideClass.value = 'slide-in-from-left'
    }
    nextTick(() => {})
  } else {
    slideClass.value = ''
    isSliding.value = false
  }
}

let wheelCooldown = false
function onWheel(e: WheelEvent) {
  if (wheelCooldown || isSliding.value) return
  const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
  if (delta > 30) {
    goPage('right')
    wheelCooldown = true
    setTimeout(() => { wheelCooldown = false }, 500)
  } else if (delta < -30) {
    goPage('left')
    wheelCooldown = true
    setTimeout(() => { wheelCooldown = false }, 500)
  }
}

const gridStyle = computed(() => ({
  gridTemplateColumns: `repeat(${store.columns}, 1fr)`,
  justifyItems: 'center',
  gap: `${store.gridGap}px`,
}))

defineExpose({ goPage })
</script>

<template>
  <div class="w-full h-full" :class="{ 'overflow-hidden': isSliding }" @wheel.prevent="onWheel">
    <div
      class="grid w-full h-full content-start page-grid"
      :class="slideClass"
      :style="gridStyle"
      @animationend="onAnimationEnd"
    >
      <AppIcon
        v-for="app in store.currentPageApps"
        :key="app.id"
        :app="app"
      />
    </div>
  </div>
</template>

<style>
.page-grid.slide-out-left {
  animation: slideOutLeft 0.25s ease-in forwards;
}
.page-grid.slide-out-right {
  animation: slideOutRight 0.25s ease-in forwards;
}
.page-grid.slide-in-from-right {
  animation: slideInFromRight 0.25s ease-out forwards;
}
.page-grid.slide-in-from-left {
  animation: slideInFromLeft 0.25s ease-out forwards;
}

@keyframes slideOutLeft {
  from { transform: translateX(0); opacity: 1; }
  to { transform: translateX(-60px); opacity: 0; }
}
@keyframes slideOutRight {
  from { transform: translateX(0); opacity: 1; }
  to { transform: translateX(60px); opacity: 0; }
}
@keyframes slideInFromRight {
  from { transform: translateX(60px); opacity: 0; }
  to { transform: translateX(0); opacity: 1; }
}
@keyframes slideInFromLeft {
  from { transform: translateX(-60px); opacity: 0; }
  to { transform: translateX(0); opacity: 1; }
}
</style>
