<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick } from 'vue'
import Sortable from 'sortablejs'
import { useTodoStore } from '@/composables/useTodoStore'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle,
} from '@/components/ui/dialog'

const store = useTodoStore()

// ── 编辑弹窗 ──
const editOpen = ref(false)
const editId = ref('')
const editText = ref('')

function openEdit(id: string, text: string) {
  editId.value = id
  editText.value = text
  editOpen.value = true
}

function saveEdit() {
  if (!editText.value.trim()) return
  store.updateBacklogItem(editId.value, editText.value.trim())
  editOpen.value = false
}

// ── 拖拽（直接用 SortableJS） ──
const listEl = ref<HTMLElement | null>(null)
let sortable: Sortable | null = null

function initSortable() {
  if (!listEl.value) return
  sortable?.destroy()
  sortable = new Sortable(listEl.value, {
    animation: 150,
    forceFallback: true,
    handle: '.drag-handle',
    group: { name: 'todo', pull: true, put: true },
    ghostClass: 'opacity-30',
    onEnd(e) {
      const id = e.item?.dataset?.id
      if (!id) return
      if (e.from !== e.to) return
      // 同列表内排序
      const items = [...store.backlog.value]
      const oldIdx = e.oldIndex!
      const newIdx = e.newIndex!
      if (oldIdx === newIdx) return
      const [moved] = items.splice(oldIdx, 1)
      items.splice(newIdx, 0, moved)
      store.backlog.value = items.map((item, i) => ({ ...item, sortOrder: i }))
    },
    onAdd(e) {
      const id = e.item?.dataset?.id
      if (!id) return
      e.item.remove()
      store.moveToBacklog(id)
    },
  })
}

onMounted(() => {
  nextTick(initSortable)
})

onUnmounted(() => {
  sortable?.destroy()
})
</script>

<template>
  <div class="space-y-2">
    <!-- 标题栏 -->
    <div class="flex items-center gap-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
      <span>待办池</span>
      <span class="text-muted-foreground/50">({{ store.backlog.value.length }})</span>
    </div>

    <div ref="listEl" class="space-y-1.5 min-h-6">
      <div
        v-for="item in store.backlog.value"
        :key="item.id"
        :data-id="item.id"
        class="flex items-center gap-3 p-2.5 rounded-lg border hover:bg-accent/50 transition-colors group"
      >
        <span class="drag-handle icon-[lucide--grip-vertical] w-4 h-4 shrink-0 text-muted-foreground/30 cursor-grab active:cursor-grabbing" />
        <span class="text-sm flex-1 min-w-0 truncate">{{ item.text }}</span>
        <button
          class="shrink-0 p-1 rounded-md opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-primary transition-all"
          @click.stop="openEdit(item.id, item.text)"
        >
          <span class="icon-[lucide--pencil] w-3.5 h-3.5" />
        </button>
        <button
          class="shrink-0 p-1 rounded-md opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-all"
          @click.stop="store.removeBacklogItem(item.id)"
        >
          <span class="icon-[lucide--trash-2] w-3.5 h-3.5" />
        </button>
      </div>
    </div>

    <!-- 空状态 -->
    <div v-if="store.backlog.value.length === 0"
      class="text-xs text-muted-foreground/40 py-2 text-center">
      暂无待办
    </div>

    <!-- 编辑弹窗 -->
    <Dialog v-model:open="editOpen">
      <DialogContent class="sm:max-w-100">
        <DialogHeader>
          <DialogTitle>编辑待办</DialogTitle>
        </DialogHeader>
        <Input v-model="editText" placeholder="待办内容" @keydown.enter="saveEdit" />
        <DialogFooter>
          <Button variant="outline" @click="editOpen = false">取消</Button>
          <Button :disabled="!editText.trim()" @click="saveEdit">保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
