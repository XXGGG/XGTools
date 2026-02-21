<script setup lang="ts">
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { useDockStore } from './dockStore'
import type { AppEntry } from '../types'

const props = defineProps<{ app: AppEntry }>()
const store = useDockStore()

async function handleClick() {
  await store.launchApp(props.app.path)
  store.isVisible = false
  store.currentPage = 0
  await getCurrentWebviewWindow().hide()
}

const defaultIcon =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48' fill='none'%3E%3Crect width='48' height='48' rx='10' fill='%23ffffff20'/%3E%3Cpath d='M16 16h16v16H16z' stroke='%23ffffff60' stroke-width='2' fill='none' rx='3'/%3E%3C/svg%3E"
</script>

<template>
  <div
    class="app-cell flex flex-col items-center cursor-pointer group relative"
    :style="{ '--hover-scale': store.hoverScale, '--glow-size': store.iconGlow + 'px' } as any"
    @click.stop="handleClick"
  >
    <div
      class="flex items-center justify-center"
      :style="{ width: store.iconSize + 'px', height: store.iconSize + 'px' }"
    >
      <img
        v-if="app.icon"
        :src="app.icon"
        :alt="app.name"
        class="icon-img w-full h-full object-contain transition-transform duration-200"
        draggable="false"
        @error="($event.target as HTMLImageElement).src = defaultIcon"
      />
      <img
        v-else
        :src="defaultIcon"
        class="icon-img w-full h-full object-contain transition-transform duration-200"
        draggable="false"
      />
    </div>

    <span
      v-if="store.showNames"
      class="mt-1 text-[13px] text-center leading-tight px-1 truncate transition-colors duration-200 text-white/80 group-hover:text-white"
      :style="{ maxWidth: (store.iconSize + 24) + 'px' }"
    >
      {{ app.name }}
    </span>
  </div>
</template>

<style scoped>
.app-cell .icon-img {
  filter: drop-shadow(0 0 0 transparent);
  transition: transform 0.2s ease, filter 0.3s ease;
}
.app-cell:hover .icon-img {
  transform: scale(var(--hover-scale, 1.1));
  filter: drop-shadow(0 0 var(--glow-size, 0px) rgba(255, 255, 255, 0.5));
}
</style>
