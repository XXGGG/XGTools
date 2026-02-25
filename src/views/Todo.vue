<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useTodoStore } from '@/composables/useTodoStore'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Input } from '@/components/ui/input'
import DailyTaskSection from '@/components/todo/DailyTaskSection.vue'
import HabitSection from '@/components/todo/HabitSection.vue'
import TaskFlowSection from '@/components/todo/TaskFlowSection.vue'
import ReminderSection from '@/components/todo/ReminderSection.vue'
import BacklogSection from '@/components/todo/BacklogSection.vue'
import AddItemDialog from '@/components/todo/AddItemDialog.vue'

const store = useTodoStore()
const addDialogOpen = ref(false)
const activeTab = ref('overview')
const newTaskText = ref('')

function addTask() {
  const text = newTaskText.value.trim()
  if (!text) return
  store.addTaskFlowItem(text)
  newTaskText.value = ''
}

onMounted(() => {
  store.init()
})
</script>

<template>
  <Tabs v-model="activeTab" class="h-full w-full flex flex-col relative">
    <!-- 顶部 Tab 栏 -->
    <div class="shrink-0 max-w-4xl mx-auto w-full px-6 pt-4 pb-2">
      <TabsList class="w-full">
        <TabsTrigger value="overview" class="flex-1 gap-1.5 text-xs">
          <span class="icon-[lucide--layout-grid] w-3.5 h-3.5" />
          总览
        </TabsTrigger>
        <TabsTrigger value="habits" class="flex-1 gap-1.5 text-xs">
          <span class="icon-[lucide--flame] w-3.5 h-3.5" />
          习惯打卡
        </TabsTrigger>
        <TabsTrigger value="tasks" class="flex-1 gap-1.5 text-xs">
          <span class="icon-[lucide--list-ordered] w-3.5 h-3.5" />
          待办事务
        </TabsTrigger>
        <TabsTrigger value="reminders" class="flex-1 gap-1.5 text-xs">
          <span class="icon-[lucide--bell] w-3.5 h-3.5" />
          定期提醒
          <span v-if="store.notifyingReminders.value.length > 0"
            class="w-1.5 h-1.5 rounded-full bg-destructive" />
        </TabsTrigger>
      </TabsList>
    </div>

    <!-- 内容区 -->
    <TabsContent value="overview" class="flex-1 overflow-hidden mt-0 data-[state=inactive]:hidden">
      <ScrollArea class="h-full">
        <div class="flex flex-col gap-6 p-6 pb-16 max-w-4xl mx-auto w-full">
          <!-- 空状态 -->
          <div v-if="store.activeDailyTasks.value.length === 0
            && store.activeHabits.value.length === 0
            && store.activeTaskFlow.value.length === 0
            && store.activeBacklog.value.length === 0
            && store.notifyingReminders.value.length === 0"
            class="border border-dashed rounded-lg p-12 flex flex-col items-center justify-center space-y-4 text-muted-foreground/60">
            <span class="icon-[lucide--circle-check-big] w-12 h-12" />
            <div class="text-center space-y-1">
              <h3 class="font-medium text-base">开始你的一天</h3>
              <p class="text-sm">点击右下角按钮添加习惯、任务或提醒</p>
            </div>
          </div>

          <!-- 上半：左右双栏（每日任务+习惯 | 任务流+待办池） -->
          <div class="flex gap-6">
            <div class="w-1/2 space-y-6">
              <DailyTaskSection />
              <HabitSection />
            </div>
            <div class="w-1/2 space-y-6">
              <TaskFlowSection />
              <BacklogSection />
            </div>
          </div>

          <!-- 到期提醒卡片 -->
          <div v-if="store.notifyingReminders.value.length > 0" class="space-y-2">
            <h3 class="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-2">
              <span class="icon-[lucide--bell-ring] w-3.5 h-3.5 text-destructive" />
              到期提醒
            </h3>
            <div class="space-y-1.5">
              <div
                v-for="reminder in store.notifyingReminders.value" :key="reminder.id"
                class="flex items-center gap-3 p-2.5 rounded-lg border border-destructive/30 bg-destructive/5 cursor-pointer transition-colors hover:bg-destructive/10"
                @click="store.completeReminder(reminder)"
              >
                <span class="icon-[lucide--bell-ring] w-4 h-4 text-destructive shrink-0" />
                <div class="flex-1 min-w-0">
                  <span class="text-sm truncate block">{{ reminder.text }}</span>
                  <span class="text-[10px] text-muted-foreground/50">
                    {{ store.formatFrequency(reminder.frequency) }} · {{ store.getNextReminderDate(reminder) }}
                  </span>
                </div>
                <span class="icon-[lucide--circle-check] w-4 h-4 text-muted-foreground/30 shrink-0" />
              </div>
            </div>
          </div>
        </div>
      </ScrollArea>
    </TabsContent>

    <TabsContent value="habits" class="flex-1 overflow-hidden mt-0 data-[state=inactive]:hidden">
      <div class="h-full p-6">
        <ScrollArea class="h-full">
          <div class="max-w-2xl mx-auto space-y-6 pr-3 pb-16">
            <HabitSection editable />
            <div v-if="store.activeHabits.value.length === 0"
              class="border border-dashed rounded-lg p-12 flex flex-col items-center justify-center space-y-4 text-muted-foreground/60">
              <span class="icon-[lucide--flame] w-12 h-12" />
              <div class="text-center space-y-1">
                <h3 class="font-medium text-base">还没有习惯</h3>
                <p class="text-sm">点击右下角按钮添加你的第一个习惯</p>
              </div>
            </div>
          </div>
        </ScrollArea>
      </div>
    </TabsContent>

    <TabsContent value="tasks" class="flex-1 overflow-hidden mt-0 data-[state=inactive]:hidden">
      <div class="h-full p-6">
        <ScrollArea class="h-full">
          <div class="max-w-2xl mx-auto space-y-6 pr-3 pb-16">
            <TaskFlowSection />
            <BacklogSection />
          </div>
        </ScrollArea>
      </div>
    </TabsContent>

    <TabsContent value="reminders" class="flex-1 overflow-hidden mt-0 data-[state=inactive]:hidden">
      <div class="h-full p-6">
        <ScrollArea class="h-full">
          <div class="max-w-2xl mx-auto space-y-6 pr-3 pb-16">
            <ReminderSection />
            <div v-if="store.reminders.value.length === 0"
              class="border border-dashed rounded-lg p-12 flex flex-col items-center justify-center space-y-4 text-muted-foreground/60">
              <span class="icon-[lucide--bell] w-12 h-12" />
              <div class="text-center space-y-1">
                <h3 class="font-medium text-base">还没有提醒</h3>
                <p class="text-sm">点击右下角按钮添加定期提醒</p>
              </div>
            </div>
          </div>
        </ScrollArea>
      </div>
    </TabsContent>

    <!-- 浮空任务输入框（仅总览和待办事务 tab） -->
    <div v-if="activeTab === 'overview' || activeTab === 'tasks'"
      class="absolute bottom-4 left-0 right-0 flex justify-center px-6 pointer-events-none">
      <div class="flex items-center bg-background/95 backdrop-blur border rounded-lg px-1 py-1 w-60 pointer-events-auto">
        <Input v-model="newTaskText" placeholder="添加到任务流..." class="h-8 text-sm border-none shadow-none focus-visible:ring-0"
          @keydown.enter="addTask" />
        <button v-if="newTaskText.trim()"
          class="shrink-0 p-1 rounded-md hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
          @click="addTask">
          <span class="icon-[lucide--plus] w-4 h-4" />
        </button>
      </div>
    </div>

    <!-- 浮动添加按钮 -->
    <button
      class="absolute bottom-4 right-6 w-11 h-11 rounded-full bg-primary text-primary-foreground flex items-center justify-center shadow-lg hover:opacity-80 transition-opacity"
      @click="addDialogOpen = true"
      title="添加事项"
    >
      <span class="icon-[lucide--plus] w-5 h-5" />
    </button>

    <!-- 添加弹窗 -->
    <AddItemDialog v-model:open="addDialogOpen" />
  </Tabs>
</template>
