<script setup lang="ts">
import { onMounted } from 'vue'
import { useTodoStore } from '@/composables/useTodoStore'
import { ScrollArea } from '@/components/ui/scroll-area'
import HabitTabView from '@/components/todo/habit/HabitTabView.vue'

const store = useTodoStore()

onMounted(() => {
  store.init()
})
</script>

<template>
  <div class="h-full w-full flex flex-col">
    <div class="flex-1 overflow-hidden">
      <ScrollArea class="h-full">
        <div class="max-w-4xl mx-auto p-6 pb-16 space-y-6">
          <HabitTabView />
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
  </div>
</template>
