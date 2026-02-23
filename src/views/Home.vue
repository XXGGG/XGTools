<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-shell'
import ModeToggle from '@/components/settings/ModeToggle.vue'
import AutostartToggle from '@/components/settings/AutostartToggle.vue'

const version = ref('0.1.0')

onMounted(async () => {
  try {
    const v = await invoke<string>('plugin:app|version')
    if (v) version.value = v
  } catch {}
})
</script>

<template>
  <div class="h-full w-full flex flex-col items-center justify-center animate-in fade-in slide-in-from-bottom-4 duration-500">

    <!-- Logo + Name -->
    <div class="flex flex-col items-center gap-4 mb-8">
      <span class="icon-[lucide--box] w-16 h-16" />
      <h1 class="text-4xl font-bold font-caveat">XGTools</h1>
    </div>

    <!-- Meta -->
    <div class="flex items-center gap-3 text-xs text-muted-foreground">
      <span class="font-mono">v{{ version }}</span>
      <span class="w-px h-3 bg-border" />
      <button
        class="hover:text-foreground transition-colors flex items-center gap-1.5"
        @click="open('https://github.com/XXGGG/XGTools')"
      >
        <span class="icon-[lucide--github] w-3.5 h-3.5" />
        GitHub
      </button>
    </div>

    <!-- Settings -->
    <div class="flex items-center gap-2 mt-6">
      <ModeToggle />
      <AutostartToggle />
    </div>

  </div>
</template>
