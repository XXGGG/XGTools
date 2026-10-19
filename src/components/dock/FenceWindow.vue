<script setup lang="ts">
/**
 * 一个桌面格子（窗口 label: fence_<id>）：半透明圆角框，顶上是名字（无名就只有一条细边，按住拖动），
 * 往里拖文件就收进来，双击打开，右键移出格子。图标按文件取系统图标（缓存在 icons 目录）。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { loadFences, updateFence, type Fence } from '@/lib/fences'

const win = getCurrentWindow()
const id = win.label.replace(/^fence_/, '')
const fence = ref<Fence | null>(null)
const icons = ref<Record<string, string>>({})
const dragOver = ref(false)
const offs: UnlistenFn[] = []

const items = computed(() => (fence.value?.items ?? []).map(p => ({ path: p, name: p.split(/[\\/]/).pop()!.replace(/\.(lnk|url)$/i, '') })))

async function reload() {
  fence.value = (await loadFences()).find(f => f.id === id) ?? null
  for (const p of fence.value?.items ?? []) {
    if (icons.value[p]) continue
    invoke<string>('file_icon', { path: p }).then((src) => { icons.value = { ...icons.value, [p]: src } }).catch(() => {})
  }
}

async function addPaths(paths: string[]) {
  if (!fence.value) return
  const next = [...fence.value.items, ...paths.filter(p => !fence.value!.items.includes(p))]
  await updateFence(id, { items: next })
}

async function removeItem(p: string) {
  if (!fence.value) return
  await updateFence(id, { items: fence.value.items.filter(x => x !== p) })
}

let saveT = 0
function remember() {
  window.clearTimeout(saveT)
  saveT = window.setTimeout(async () => {
    const f = await win.scaleFactor()
    const pos = await win.outerPosition()
    const size = await win.innerSize()
    await updateFence(id, { x: Math.round(pos.x / f), y: Math.round(pos.y / f), w: Math.round(size.width / f), h: Math.round(size.height / f) })
  }, 500)
}

onMounted(async () => {
  document.documentElement.style.background = 'transparent'
  document.body.style.background = 'transparent'
  await reload()
  offs.push(await listen('fences-changed', reload))
  offs.push(await win.onMoved(remember))
  offs.push(await win.onResized(remember))
  offs.push(await getCurrentWebview().onDragDropEvent((e) => {
    if (e.payload.type === 'over' || e.payload.type === 'enter') dragOver.value = true
    else if (e.payload.type === 'leave') dragOver.value = false
    else if (e.payload.type === 'drop') {
      dragOver.value = false
      void addPaths(e.payload.paths)
    }
  }))
})
onBeforeUnmount(() => offs.forEach(f => f()))
</script>

<template>
  <div class="fixed inset-0 p-1">
    <div class="h-full rounded-xl border border-white/15 bg-black/25 backdrop-blur-md flex flex-col overflow-hidden transition-colors"
      :class="{ 'border-primary/70 bg-primary/10': dragOver }">
      <div class="shrink-0 cursor-move select-none flex items-center px-3" :class="fence?.name ? 'h-7' : 'h-3'"
        @mousedown.left="win.startDragging()">
        <span v-if="fence?.name" class="text-xs font-medium text-white/90 drop-shadow truncate">{{ fence.name }}</span>
      </div>
      <div class="flex-1 min-h-0 overflow-auto p-2 grid gap-1 content-start" style="grid-template-columns: repeat(auto-fill, minmax(72px, 1fr))">
        <div v-if="!items.length" class="col-span-full text-center text-xs text-white/60 py-6 select-none">把文件拖进来</div>
        <button v-for="it in items" :key="it.path" class="group flex flex-col items-center gap-1 rounded-lg p-1.5 hover:bg-white/10 focus:bg-white/15 outline-none"
          :title="it.path" @dblclick="invoke('shell_open_path', { path: it.path })" @contextmenu.prevent="removeItem(it.path)">
          <img v-if="icons[it.path]" :src="icons[it.path]" class="w-9 h-9 object-contain" draggable="false">
          <span v-else class="icon-[lucide--file] w-9 h-9 text-white/70" />
          <span class="text-[11px] leading-tight text-white text-center line-clamp-2 break-all drop-shadow">{{ it.name }}</span>
        </button>
      </div>
    </div>
  </div>
</template>
