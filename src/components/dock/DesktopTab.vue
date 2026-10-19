<script setup lang="ts">
/**
 * 启动台 → 桌面：按时间自动切系统深浅色（lib/autoTheme.ts）、桌面整理（后面接上）。
 */
import { onMounted, ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { Switch } from '@/components/ui/switch'
import { AUTO_THEME_DEFAULTS, loadAutoTheme, saveAutoTheme, type AutoTheme } from '@/lib/autoTheme'

const theme = ref<AutoTheme>({ ...AUTO_THEME_DEFAULTS })
const isDark = ref(false)

async function save() {
  await saveAutoTheme(theme.value)
  isDark.value = await invoke<boolean>('system_theme_is_dark')
}

async function flip() {
  await invoke('system_theme_set', { dark: !isDark.value })
  isDark.value = !isDark.value
}

onMounted(async () => {
  theme.value = await loadAutoTheme()
  isDark.value = await invoke<boolean>('system_theme_is_dark')
})
</script>

<template>
  <div class="flex-1 overflow-y-auto space-y-3 max-w-2xl mx-auto w-full">
    <div class="p-4 border rounded-lg space-y-3">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          <div class="flex items-center justify-center w-9 h-9 rounded-md text-muted-foreground">
            <span class="icon-[lucide--sun-moon] w-5 h-5" />
          </div>
          <div>
            <h3 class="font-medium flex items-center gap-1.5">按时间自动切深色 / 浅色
              <span class="icon-[lucide--info] w-3.5 h-3.5 text-muted-foreground/70"
                title="切的是 Windows 的系统和应用模式（设置 → 个性化 → 颜色）。只在到点那一下切，中间你手动改了不会被改回去。" />
            </h3>
            <p class="text-xs text-muted-foreground">现在是{{ isDark ? '深色' : '浅色' }}
              <button class="ml-1 underline-offset-2 hover:underline hover:text-foreground" @click="flip">马上换成{{ isDark ? '浅色' : '深色' }}</button>
            </p>
          </div>
        </div>
        <Switch :model-value="theme.enabled" @update:model-value="(v: boolean) => { theme.enabled = v; save() }" />
      </div>
      <div class="flex items-center gap-6 pl-12 text-sm" :class="{ 'opacity-40 pointer-events-none': !theme.enabled }">
        <label class="flex items-center gap-2">
          <span class="icon-[lucide--sun] w-4 h-4 text-amber-400" />浅色从
          <input v-model="theme.lightAt" type="time" class="rounded-md bg-background/60 border px-1.5 py-0.5" @change="save">
        </label>
        <label class="flex items-center gap-2">
          <span class="icon-[lucide--moon] w-4 h-4 text-indigo-300" />深色从
          <input v-model="theme.darkAt" type="time" class="rounded-md bg-background/60 border px-1.5 py-0.5" @change="save">
        </label>
      </div>
    </div>
  </div>
</template>
