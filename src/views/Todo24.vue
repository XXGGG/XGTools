<script setup lang="ts">
/**
 * 待办页：24 小时清单 + 「置顶便签」开关（把清单变成桌面上一张小便签，见 TodoNote.vue）。
 */
import { onMounted, ref } from 'vue'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import TodoList from '@/components/todo24/TodoList.vue'
import { closeTodoNote, NOTE_LABEL, openTodoNote } from '@/lib/todo24'

const noteOpen = ref(false)

async function toggleNote() {
  if (await WebviewWindow.getByLabel(NOTE_LABEL)) {
    await closeTodoNote()
    noteOpen.value = false
  }
  else {
    await openTodoNote()
    noteOpen.value = true
  }
}

onMounted(async () => {
  noteOpen.value = !!(await WebviewWindow.getByLabel(NOTE_LABEL))
})
</script>

<template>
  <div class="h-full w-full flex flex-col items-center px-8 pb-6 gap-4">
    <div class="w-full max-w-2xl flex items-center justify-between mr-[130px]">
      <div class="flex items-center gap-2">
        <div class="text-lg font-semibold">24 小时待办</div>
        <span class="icon-[lucide--info] w-3.5 h-3.5 text-muted-foreground/70"
          title="只记接下来 24 小时内要做完的事。立下就开始倒计时，默认 24 小时，也可以挑更早的时刻。" />
      </div>
      <button class="flex items-center gap-1.5 text-xs rounded-md px-2.5 py-1.5"
        :class="noteOpen ? 'bg-primary/20 text-foreground' : 'text-muted-foreground hover:text-foreground'" @click="toggleNote">
        <span class="icon-[lucide--sticky-note] w-4 h-4" />{{ noteOpen ? '收起便签' : '置顶便签' }}
      </button>
    </div>
    <TodoList class="w-full max-w-2xl flex-1 min-h-0" />
  </div>
</template>
