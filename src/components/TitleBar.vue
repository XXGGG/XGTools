<script setup lang="ts">
import { Window } from '@tauri-apps/api/window'
import { ref, onMounted } from 'vue'

const appWindow = Window.getCurrent()
const isMaximized = ref(false)

const minimize = () => appWindow.minimize()
const toggleMaximize = async () => {
  await appWindow.toggleMaximize()
  isMaximized.value = await appWindow.isMaximized()
}
const close = () => appWindow.close()

onMounted(async () => {
  isMaximized.value = await appWindow.isMaximized()
})
</script>

<template>
  <div data-tauri-drag-region
    class="h-10 shrink-0 flex items-center justify-between bg-background select-none z-50">
    <div></div>
    <div class="flex h-full">
      <button @click="minimize"
        class="w-12 h-full flex items-center justify-center hover:bg-muted transition-colors text-foreground">
        <span class="icon-[lucide--minus]" />
      </button>
      <button @click="toggleMaximize"
        class="w-12 h-full flex items-center justify-center hover:bg-muted transition-colors text-foreground">
        <span class="icon-[lucide--square]" />
      </button>
      <button @click="close"
        class="w-12 h-full flex items-center justify-center hover:bg-red-500 hover:text-white transition-colors text-foreground">
        <span class="icon-[lucide--x]" />
      </button>
    </div>
  </div>
</template>