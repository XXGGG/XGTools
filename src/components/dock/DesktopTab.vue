<script setup lang="ts">
/**
 * 启动台 → 桌面：按时间自动切系统深浅色（lib/autoTheme.ts）、隐藏桌面图标、桌面格子（lib/fences.ts）。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { Switch } from '@/components/ui/switch'
import TimePicker from '@/components/TimePicker.vue'
import { AUTO_THEME_DEFAULTS, loadAutoTheme, saveAutoTheme, type AutoTheme } from '@/lib/autoTheme'
import { addFence, fencesShown, loadFences, removeFence, setFencesShown, updateFence, type Fence } from '@/lib/fences'
import { listen } from '@tauri-apps/api/event'

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

/* ── 桌面整理 ── */
const iconsVisible = ref(true)
const fences = ref<Fence[]>([])
const shown = ref(true)
const newName = ref('')

async function setIcons(v: boolean) {
  await invoke('desktop_icons_set', { visible: v })
  iconsVisible.value = await invoke<boolean>('desktop_icons_visible')
}
async function create() {
  await addFence(newName.value.trim())
  newName.value = ''
  if (!shown.value) await toggleShown(true)
  fences.value = await loadFences()
}
async function toggleShown(v: boolean) {
  shown.value = v
  await setFencesShown(v)
}
async function rename(f: Fence, name: string) {
  await updateFence(f.id, { name: name.trim() })
}
async function drop(f: Fence) {
  await removeFence(f.id)
  fences.value = await loadFences()
}

onMounted(async () => {
  theme.value = await loadAutoTheme()
  isDark.value = await invoke<boolean>('system_theme_is_dark')
  iconsVisible.value = await invoke<boolean>('desktop_icons_visible')
  fences.value = await loadFences()
  shown.value = await fencesShown()
  off = await listen('fences-changed', async () => { fences.value = await loadFences() })
})
let off: (() => void) | null = null
onBeforeUnmount(() => off?.())
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
          <TimePicker v-model="theme.lightAt" @change="save" />
        </label>
        <label class="flex items-center gap-2">
          <span class="icon-[lucide--moon] w-4 h-4 text-indigo-300" />深色从
          <TimePicker v-model="theme.darkAt" @change="save" />
        </label>
      </div>
    </div>

    <div class="p-4 border rounded-lg space-y-3">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          <div class="flex items-center justify-center w-9 h-9 rounded-md text-muted-foreground">
            <span class="icon-[lucide--eye-off] w-5 h-5" />
          </div>
          <div>
            <h3 class="font-medium">显示桌面图标</h3>
            <p class="text-xs text-muted-foreground">关掉后桌面上的图标都藏起来，文件还在</p>
          </div>
        </div>
        <Switch :model-value="iconsVisible" @update:model-value="setIcons" />
      </div>
    </div>

    <div class="p-4 border rounded-lg space-y-3">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          <div class="flex items-center justify-center w-9 h-9 rounded-md text-muted-foreground">
            <span class="icon-[lucide--layout-dashboard] w-5 h-5" />
          </div>
          <div>
            <h3 class="font-medium flex items-center gap-1.5">桌面格子
              <span class="icon-[lucide--info] w-3.5 h-3.5 text-muted-foreground/70"
                title="桌面上的半透明小框。把文件、文件夹、快捷方式拖进去归类，双击打开，右键移出格子（文件本身不动）。拖顶上那条边挪位置，拖角改大小。名字可以不填。" />
            </h3>
            <p class="text-xs text-muted-foreground">{{ fences.length ? `${fences.length} 个格子` : '还没有格子' }}</p>
          </div>
        </div>
        <Switch :model-value="shown" :disabled="!fences.length" @update:model-value="toggleShown" />
      </div>
      <div class="pl-12 space-y-2">
        <div v-for="f in fences" :key="f.id" class="flex items-center gap-2 text-sm">
          <input :value="f.name" placeholder="（无名）" class="flex-1 rounded-md bg-background/60 border px-2 py-1"
            @change="(e) => rename(f, (e.target as HTMLInputElement).value)">
          <span class="text-xs text-muted-foreground w-14 text-right">{{ f.items.length }} 项</span>
          <button class="text-muted-foreground hover:text-red-400" title="删掉这个格子（里面的文件不动）" @click="drop(f)">
            <span class="icon-[lucide--trash-2] w-4 h-4" />
          </button>
        </div>
        <form class="flex items-center gap-2" @submit.prevent="create">
          <input v-model="newName" placeholder="新格子的名字（可以不填）" class="flex-1 rounded-md bg-background/60 border px-2 py-1 text-sm">
          <button type="submit" class="rounded-md bg-primary/80 text-primary-foreground px-3 py-1 text-sm">加一个格子</button>
        </form>
      </div>
    </div>
  </div>
</template>
