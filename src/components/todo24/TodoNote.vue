<script setup lang="ts">
/**
 * 桌面上的置顶待办便签（窗口 label: todo_note）：半透明小卡片，按住顶上那条拖着走，右上角关掉。
 */
import { onMounted } from 'vue'
import { getCurrentWindow } from '@tauri-apps/api/window'
import TodoList from '@/components/todo24/TodoList.vue'
import { closeTodoNote, saveNotePos } from '@/lib/todo24'

const win = getCurrentWindow()
let t = 0

onMounted(() => {
  document.documentElement.style.background = 'transparent'
  document.body.style.background = 'transparent'
  void win.onMoved(async ({ payload }) => {
    window.clearTimeout(t)
    const f = await win.scaleFactor()
    t = window.setTimeout(() => void saveNotePos(Math.round(payload.x / f), Math.round(payload.y / f)), 400)
  })
})
</script>

<template>
  <div class="fixed inset-0 p-1.5">
    <div class="h-full rounded-2xl bg-popover/85 backdrop-blur-xl border border-white/10 shadow-xl flex flex-col overflow-hidden">
      <div class="flex items-center gap-2 px-3 h-8 shrink-0 cursor-move select-none" @mousedown.left="win.startDragging()">
        <span class="icon-[lucide--list-checks] w-4 h-4 text-muted-foreground" />
        <span class="text-xs font-medium flex-1">24 小时待办</span>
        <button class="text-muted-foreground hover:text-foreground" title="收起便签" @mousedown.stop @click="closeTodoNote">
          <span class="icon-[lucide--x] w-3.5 h-3.5" />
        </button>
      </div>
      <TodoList compact class="flex-1 min-h-0 px-2.5 pb-2.5" />
    </div>
  </div>
</template>
