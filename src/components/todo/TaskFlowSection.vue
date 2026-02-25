<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch, nextTick } from 'vue'
import Sortable from 'sortablejs'
import { useTodoStore } from '@/composables/useTodoStore'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

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
  store.updateTaskFlowItem(editId.value, editText.value.trim())
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

      // 跨列表：从这里拖走
      if (e.from !== e.to) return

      // 同列表内排序
      const items = [...store.activeTaskFlow.value]
      const oldIdx = e.oldIndex!
      const newIdx = e.newIndex!
      if (oldIdx === newIdx) return
      const [moved] = items.splice(oldIdx, 1)
      items.splice(newIdx, 0, moved)
      store.reorderTaskFlow(items)
    },
    onAdd(e) {
      const id = e.item?.dataset?.id
      if (!id) return
      // SortableJS 已经把 DOM 节点移到这里了，先移除让 Vue 重新渲染
      e.item.remove()
      store.moveToTaskFlow(id)
    },
  })
}

onMounted(() => {
  nextTick(initSortable)
})

// 数据变化后重新初始化（避免 DOM 和 Sortable 不同步）
watch(() => store.activeTaskFlow.value.length, () => {
  nextTick(() => {
    // Sortable 自动跟踪 DOM 变化，不需要重建
  })
})

onUnmounted(() => {
  sortable?.destroy()
})
</script>

<template>
  <div class="space-y-3">
    <div class="flex items-center justify-between">
      <h3 class="text-xs font-medium text-muted-foreground uppercase tracking-wider">任务流</h3>
      <button
        v-if="store.completedTaskFlow.value.length > 0"
        class="text-[10px] text-muted-foreground/50 hover:text-muted-foreground transition-colors"
        @click="store.clearCompletedTaskFlow()"
      >
        清除已完成
      </button>
    </div>

    <!-- 未完成（可拖拽） -->
    <div ref="listEl" class="space-y-1.5 min-h-6">
      <div
        v-for="item in store.activeTaskFlow.value"
        :key="item.id"
        :data-id="item.id"
        class="flex items-center gap-3 p-2.5 rounded-lg border hover:bg-accent/50 transition-colors group"
      >
        <span class="drag-handle icon-[lucide--grip-vertical] w-4 h-4 shrink-0 text-muted-foreground/30 cursor-grab active:cursor-grabbing" />
        <span
          class="icon-[lucide--circle] w-4 h-4 shrink-0 text-muted-foreground/40 cursor-pointer hover:text-primary/60 transition-colors"
          @click.stop="store.toggleTaskFlowItem(item.id)"
        />
        <span class="text-sm flex-1 min-w-0 truncate">{{ item.text }}</span>
        <button
          class="shrink-0 p-1 rounded-md opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-primary transition-all"
          @click.stop="openEdit(item.id, item.text)"
        >
          <span class="icon-[lucide--pencil] w-3.5 h-3.5" />
        </button>
        <button
          class="shrink-0 p-1 rounded-md opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-all"
          @click.stop="store.removeTaskFlowItem(item.id)"
        >
          <span class="icon-[lucide--trash-2] w-3.5 h-3.5" />
        </button>
      </div>
    </div>

    <!-- 空状态 -->
    <div v-if="store.activeTaskFlow.value.length === 0 && store.completedTaskFlow.value.length === 0"
      class="text-xs text-muted-foreground/40 py-2 text-center">
      暂无任务
    </div>

    <!-- 已完成 -->
    <div v-if="store.completedTaskFlow.value.length > 0" class="space-y-1.5">
      <div
        v-for="item in store.completedTaskFlow.value"
        :key="item.id"
        class="flex items-center gap-3 p-2.5 rounded-lg hover:bg-accent/50 transition-colors group cursor-pointer"
        @click="store.toggleTaskFlowItem(item.id)"
      >
        <span class="icon-[lucide--circle-check] w-4 h-4 shrink-0 text-muted-foreground/30" />
        <span class="text-sm flex-1 min-w-0 truncate line-through text-muted-foreground/40">{{ item.text }}</span>
        <button
          class="shrink-0 p-1 rounded-md opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-all"
          @click.stop="store.removeTaskFlowItem(item.id)"
        >
          <span class="icon-[lucide--trash-2] w-3.5 h-3.5" />
        </button>
      </div>
    </div>

    <!-- 编辑弹窗 -->
    <Dialog v-model:open="editOpen">
      <DialogContent class="sm:max-w-100">
        <DialogHeader>
          <DialogTitle>编辑任务</DialogTitle>
        </DialogHeader>
        <Input v-model="editText" placeholder="任务内容" @keydown.enter="saveEdit" />
        <DialogFooter>
          <Button variant="outline" @click="editOpen = false">取消</Button>
          <Button :disabled="!editText.trim()" @click="saveEdit">保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
