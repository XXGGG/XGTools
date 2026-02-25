<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick } from 'vue'
import Sortable from 'sortablejs'
import { useTodoStore } from '@/composables/useTodoStore'
import type { HabitItem } from '@/types/todo'
import { Input } from '@/components/ui/input'
import HabitCheckinCalendar from './HabitCheckinCalendar.vue'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger,
} from '@/components/ui/context-menu'
import {
  Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'

const props = defineProps<{
  editable?: boolean
}>()

const store = useTodoStore()
const calendarHabit = ref<HabitItem | null>(null)
const calendarOpen = ref(false)

function openCalendar(habit: HabitItem) {
  if (props.editable) return // editable 模式下右键留给 ContextMenu
  calendarHabit.value = habit
  calendarOpen.value = true
}

// ── 编辑弹窗 ──
const editOpen = ref(false)
const editingHabit = ref<HabitItem | null>(null)
const editText = ref('')
const editIcon = ref('')

const HABIT_ICONS: { value: string; label: string }[] = [
  { value: 'icon-[lucide--flame]', label: '火焰' },
  { value: 'icon-[lucide--pencil]', label: '练字' },
  { value: 'icon-[lucide--book-open]', label: '阅读' },
  { value: 'icon-[lucide--dumbbell]', label: '运动' },
  { value: 'icon-[lucide--droplets]', label: '喝水' },
  { value: 'icon-[lucide--music]', label: '音乐' },
  { value: 'icon-[lucide--code]', label: '编程' },
  { value: 'icon-[lucide--languages]', label: '语言' },
  { value: 'icon-[lucide--heart]', label: '心形' },
  { value: 'icon-[lucide--star]', label: '星星' },
  { value: 'icon-[lucide--circle-check]', label: '默认' },
  { value: 'icon-[lucide--gamepad-2]', label: '游戏' },
]

function openEdit(habit: HabitItem) {
  editingHabit.value = habit
  editText.value = habit.text
  editIcon.value = habit.icon
  editOpen.value = true
}

function saveEdit() {
  if (!editingHabit.value || !editText.value.trim()) return
  store.updateHabit(editingHabit.value.id, {
    text: editText.value.trim(),
    icon: editIcon.value,
  })
  editOpen.value = false
}

// ── 删除确认 ──
const deleteOpen = ref(false)
const deletingHabit = ref<HabitItem | null>(null)

function confirmDelete(habit: HabitItem) {
  deletingHabit.value = habit
  deleteOpen.value = true
}

function doDelete() {
  if (deletingHabit.value) {
    store.removeHabit(deletingHabit.value.id)
  }
  deleteOpen.value = false
}

// ── 拖拽排序（仅 editable 模式） ──
const listEl = ref<HTMLElement | null>(null)
let sortable: Sortable | null = null

function initSortable() {
  if (!props.editable || !listEl.value) return
  sortable?.destroy()
  sortable = new Sortable(listEl.value, {
    animation: 150,
    forceFallback: true,
    delay: 150,
    ghostClass: 'opacity-30',
    onEnd(e) {
      if (e.oldIndex == null || e.newIndex == null || e.oldIndex === e.newIndex) return
      const items = [...store.activeHabits.value]
      const [moved] = items.splice(e.oldIndex, 1)
      items.splice(e.newIndex, 0, moved)
      store.reorderHabits(items)
    },
  })
}

onMounted(() => nextTick(initSortable))
onUnmounted(() => sortable?.destroy())
</script>

<template>
  <div v-if="store.activeHabits.value.length > 0" class="space-y-3">
    <div v-if="!editable" class="flex items-center justify-between">
      <h3 class="text-xs font-medium text-muted-foreground uppercase tracking-wider">习惯打卡</h3>
      <span class="text-xs text-muted-foreground">
        {{ store.todayHabitsDone.value }}/{{ store.activeHabits.value.length }} 完成
      </span>
    </div>

    <div class="flex flex-col gap-1.5">
      <!-- editable 模式：ContextMenu 直接包裹 button + 可拖拽排序 -->
      <div v-if="editable" ref="listEl" class="flex flex-col gap-1.5">
        <ContextMenu v-for="habit in store.activeHabits.value" :key="habit.id">
          <ContextMenuTrigger as-child>
            <button
              :data-id="habit.id"
              class="flex items-center gap-2.5 p-3 rounded-lg border transition-all duration-200 text-left group"
              :class="store.isHabitCheckedToday(habit)
                ? 'bg-primary/10 border-primary/30'
                : 'border-dashed hover:bg-accent/50'"
              @click="store.toggleHabitCheckin(habit)"
            >
              <span :class="habit.icon" class="w-4.5 h-4.5 shrink-0" />
              <span class="text-sm flex-1 min-w-0 truncate">{{ habit.text }}</span>
              <span v-if="store.isHabitCheckedToday(habit)"
                class="icon-[lucide--check] w-4 h-4 text-primary shrink-0" />
              <span v-else
                class="icon-[lucide--circle] w-4 h-4 text-muted-foreground/30 shrink-0" />
            </button>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem @click="() => { calendarHabit = habit; calendarOpen = true }">
              <span class="icon-[lucide--calendar] w-3.5 h-3.5 mr-2" />
              打卡日历
            </ContextMenuItem>
            <ContextMenuItem @click="openEdit(habit)">
              <span class="icon-[lucide--pencil] w-3.5 h-3.5 mr-2" />
              编辑
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem class="text-destructive" @click="confirmDelete(habit)">
              <span class="icon-[lucide--trash-2] w-3.5 h-3.5 mr-2" />
              删除
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </div>

      <!-- 总览模式：右键打开日历 -->
      <template v-else>
        <Popover v-for="habit in store.activeHabits.value" :key="habit.id"
          :open="calendarOpen && calendarHabit?.id === habit.id"
          @update:open="(v: boolean) => { if (!v) calendarOpen = false }"
        >
          <PopoverTrigger as-child>
            <button
              class="flex items-center gap-2.5 p-3 rounded-lg border transition-all duration-200 text-left group"
              :class="store.isHabitCheckedToday(habit)
                ? 'bg-primary/10 border-primary/30'
                : 'border-dashed hover:bg-accent/50'"
              @click="store.toggleHabitCheckin(habit)"
              @contextmenu.prevent="openCalendar(habit)"
            >
              <span :class="habit.icon" class="w-4.5 h-4.5 shrink-0" />
              <span class="text-sm flex-1 min-w-0 truncate">{{ habit.text }}</span>
              <span v-if="store.isHabitCheckedToday(habit)"
                class="icon-[lucide--check] w-4 h-4 text-primary shrink-0" />
              <span v-else
                class="icon-[lucide--circle] w-4 h-4 text-muted-foreground/30 shrink-0" />
            </button>
          </PopoverTrigger>
          <PopoverContent class="w-auto p-0" align="start" side="bottom">
            <HabitCheckinCalendar
              v-if="calendarHabit?.id === habit.id"
              :habit="habit"
              @close="calendarOpen = false"
            />
          </PopoverContent>
        </Popover>
      </template>
    </div>

    <!-- 编辑弹窗 -->
    <Dialog v-model:open="editOpen">
      <DialogContent class="sm:max-w-100">
        <DialogHeader>
          <DialogTitle>编辑习惯</DialogTitle>
        </DialogHeader>
        <div class="flex flex-col gap-4">
          <Input v-model="editText" placeholder="习惯名称" />
          <div class="space-y-2">
            <span class="text-xs text-muted-foreground">选择图标</span>
            <div class="flex flex-wrap gap-1.5">
              <button
                v-for="ico in HABIT_ICONS" :key="ico.value"
                @click="editIcon = ico.value"
                :title="ico.label"
                class="w-8 h-8 rounded-md flex items-center justify-center transition-colors"
                :class="editIcon === ico.value
                  ? 'bg-primary text-primary-foreground'
                  : 'border hover:bg-accent text-muted-foreground'"
              >
                <span :class="ico.value" class="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="editOpen = false">取消</Button>
          <Button :disabled="!editText.trim()" @click="saveEdit">保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- 打卡日历弹窗（editable 模式） -->
    <Dialog v-if="editable" v-model:open="calendarOpen">
      <DialogContent class="sm:max-w-fit p-0">
        <HabitCheckinCalendar
          v-if="calendarHabit"
          :habit="calendarHabit"
          @close="calendarOpen = false"
        />
      </DialogContent>
    </Dialog>

    <!-- 删除确认弹窗 -->
    <AlertDialog v-model:open="deleteOpen">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>确认删除习惯</AlertDialogTitle>
          <AlertDialogDescription>
            删除「{{ deletingHabit?.text }}」将会清除所有打卡记录，此操作不可撤销。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction class="bg-destructive text-destructive-foreground hover:bg-destructive/90" @click="doDelete">
            删除
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>
