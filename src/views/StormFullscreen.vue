<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { getCurrentWindow } from '@tauri-apps/api/window'

// 全屏窗口:把 orb 页(带上本窗口的查询参数)铺满
const orbSrc = 'orb/index.html' + window.location.search

function onMsg(e: MessageEvent) {
  if (e.data && e.data.__storm === 'close') getCurrentWindow().close()
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') getCurrentWindow().close()
}
onMounted(() => {
  window.addEventListener('message', onMsg)
  window.addEventListener('keydown', onKey)
})
onUnmounted(() => {
  window.removeEventListener('message', onMsg)
  window.removeEventListener('keydown', onKey)
})
</script>

<template>
  <div class="fixed inset-0 bg-black">
    <iframe :src="orbSrc" class="w-full h-full border-0" title="Storm Orb" />
    <div class="fixed top-3 left-4 text-white/35 text-xs pointer-events-none select-none">Esc 退出全屏</div>
  </div>
</template>
