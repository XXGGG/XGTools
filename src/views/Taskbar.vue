<script setup lang="ts">
/**
 * 任务栏透明（TranslucentTB 的功能收进 XGTools）。
 *
 * 真正改任务栏的是 TranslucentTB（Windows 11 的任务栏要往 Explorer 里注入钩子才改得动，见 taskbar_commands.rs），
 * 这页是它的设置面板：改完直接写它的 settings.json，它自己盯着文件，马上生效。没装就带去商店装。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { Switch } from '@/components/ui/switch'
import { Slider } from '@/components/ui/slider'

type Accent = 'normal' | 'opaque' | 'clear' | 'blur' | 'acrylic'
type Look = { enabled?: boolean; accent: Accent; color: string; show_peek: boolean; show_line: boolean; blur_radius: number }
type Settings = Record<string, unknown> & Record<StateKey, Look>
type StateKey = 'desktop_appearance' | 'visible_window_appearance' | 'maximized_window_appearance' | 'start_opened_appearance' | 'search_opened_appearance' | 'task_view_opened_appearance'

const STATES: { key: StateKey; title: string; icon: string }[] = [
  { key: 'desktop_appearance', title: '平时（桌面）', icon: 'icon-[lucide--monitor]' },
  { key: 'visible_window_appearance', title: '有窗口开着时', icon: 'icon-[lucide--app-window]' },
  { key: 'maximized_window_appearance', title: '有窗口最大化时', icon: 'icon-[lucide--maximize-2]' },
  { key: 'start_opened_appearance', title: '打开开始菜单时', icon: 'icon-[lucide--layout-grid]' },
  { key: 'search_opened_appearance', title: '打开搜索时', icon: 'icon-[lucide--search]' },
  { key: 'task_view_opened_appearance', title: '打开任务视图时', icon: 'icon-[lucide--layers]' },
]
const ACCENTS: { id: Accent; label: string }[] = [
  { id: 'clear', label: '全透明' },
  { id: 'blur', label: '模糊' },
  { id: 'acrylic', label: '亚克力' },
  { id: 'opaque', label: '不透明' },
  { id: 'normal', label: '系统默认' },
]

const status = ref<{ installed: boolean; running: boolean } | null>(null)
const cfg = ref<Settings | null>(null)
const error = ref('')
const open = ref<StateKey | null>('desktop_appearance')

/** 它的设置文件第一行是注释（JSONC），解析前去掉，写回时再加上 */
const HEADER = '// See https://TranslucentTB.github.io/config for more information'

async function refresh() {
  status.value = await invoke('ttb_status')
  if (!status.value?.installed) return
  try {
    const raw = (await invoke<string>('ttb_read')).replace(/^﻿/, '').replace(/^\s*\/\/.*$/gm, '')
    cfg.value = JSON.parse(raw)
    error.value = ''
  }
  catch (e) {
    error.value = `读不懂 TranslucentTB 的设置：${e}`
  }
}

let saveTimer = 0
function save() {
  window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(async () => {
    if (!cfg.value) return
    try {
      await invoke('ttb_write', { content: `${HEADER}\n${JSON.stringify(cfg.value, null, 2)}\n` })
    }
    catch (e) {
      error.value = String(e)
    }
  }, 250)
}

/** 颜色拆成「RGB + 不透明度」两个控件；它的格式是 #RRGGBBAA */
function rgbOf(c: string) {
  return (c.length >= 7 ? c.slice(0, 7) : '#000000').toLowerCase()
}
function alphaOf(c: string) {
  return c.length >= 9 ? Number.parseInt(c.slice(7, 9), 16) : 255
}
function setColor(look: Look, rgb: string, a: number) {
  look.color = `${rgb}${Math.round(a).toString(16).padStart(2, '0')}`
  save()
}

const looks = computed(() => STATES.map(s => ({ ...s, look: cfg.value?.[s.key] })).filter(s => s.look))

async function start() {
  await invoke('ttb_start')
  window.setTimeout(refresh, 2500)
}

let poll = 0
onMounted(async () => {
  await refresh()
  poll = window.setInterval(async () => { status.value = await invoke('ttb_status') }, 5000)
})
onBeforeUnmount(() => window.clearInterval(poll))
</script>

<template>
  <div class="max-w-2xl mx-auto px-8 py-2 space-y-5">
    <div class="flex items-center gap-2 mr-[130px]">
      <div class="text-lg font-semibold">任务栏</div>
      <span class="icon-[lucide--info] w-3.5 h-3.5 text-muted-foreground/70"
        title="让任务栏变透明、模糊或亚克力，按不同情况分别设。改的是 TranslucentTB 的设置，它负责实际改任务栏，改完马上生效。" />
    </div>

    <!-- 没装 / 没开 -->
    <div v-if="status && !status.installed" class="rounded-xl border p-4 flex items-center gap-4">
      <span class="icon-[lucide--package-open] w-5 h-5 text-muted-foreground" />
      <div class="flex-1 text-sm">要先装 TranslucentTB（免费、开源），装好回来就能在这里设置。</div>
      <button class="rounded-md bg-primary/80 text-primary-foreground px-3 py-1.5 text-sm" @click="invoke('ttb_install')">去商店安装</button>
      <button class="text-xs text-muted-foreground hover:text-foreground" @click="refresh">装好了</button>
    </div>
    <div v-else-if="status && !status.running" class="rounded-xl border p-4 flex items-center gap-4">
      <span class="icon-[lucide--power] w-5 h-5 text-muted-foreground" />
      <div class="flex-1 text-sm">TranslucentTB 没在运行，设置要它开着才生效。</div>
      <button class="rounded-md bg-primary/80 text-primary-foreground px-3 py-1.5 text-sm" @click="start">启动它</button>
    </div>

    <div v-if="error" class="text-xs text-red-400">{{ error }}</div>

    <div v-if="cfg" class="rounded-xl border divide-y">
      <div v-for="s in looks" :key="s.key">
        <div class="flex items-center gap-4 px-4 py-3 cursor-pointer select-none" @click="open = open === s.key ? null : s.key">
          <span :class="s.icon" class="w-5 h-5 shrink-0 text-muted-foreground" />
          <div class="flex-1 text-sm">{{ s.title }}</div>
          <span class="text-xs text-muted-foreground">{{ s.look!.enabled === false ? '不单独设' : ACCENTS.find(a => a.id === s.look!.accent)?.label }}</span>
          <Switch v-if="s.look!.enabled !== undefined" :model-value="s.look!.enabled" @click.stop
            @update:model-value="(v: boolean) => { s.look!.enabled = v; save() }" />
          <span class="icon-[lucide--chevron-down] w-4 h-4 text-muted-foreground transition-transform" :class="{ 'rotate-180': open === s.key }" />
        </div>
        <div v-if="open === s.key && s.look!.enabled !== false" class="px-4 pb-4 pl-13 space-y-3 text-sm">
          <div class="flex gap-1 flex-wrap">
            <button v-for="a in ACCENTS" :key="a.id" class="rounded-md px-2.5 py-1 text-xs"
              :class="s.look!.accent === a.id ? 'bg-primary/25 text-foreground' : 'bg-muted/50 text-muted-foreground hover:text-foreground'"
              @click="s.look!.accent = a.id; save()">{{ a.label }}</button>
          </div>
          <div v-if="s.look!.accent !== 'normal'" class="flex items-center gap-3">
            <span class="w-16 text-muted-foreground text-xs">颜色</span>
            <input type="color" :value="rgbOf(s.look!.color)" class="w-8 h-6 rounded bg-transparent"
              @input="(e) => setColor(s.look!, (e.target as HTMLInputElement).value, alphaOf(s.look!.color))">
            <span class="w-14 text-muted-foreground text-xs">不透明度</span>
            <Slider class="flex-1" :model-value="[alphaOf(s.look!.color)]" :min="0" :max="255" :step="1"
              @update:model-value="(v) => v && setColor(s.look!, rgbOf(s.look!.color), v[0])" />
            <span class="w-10 text-right text-xs text-muted-foreground">{{ Math.round(alphaOf(s.look!.color) / 2.55) }}%</span>
          </div>
          <div v-if="s.look!.accent === 'blur'" class="flex items-center gap-3">
            <span class="w-16 text-muted-foreground text-xs">模糊程度</span>
            <Slider class="flex-1" :model-value="[s.look!.blur_radius]" :min="0" :max="30" :step="0.5"
              @update:model-value="(v) => { if (v) { s.look!.blur_radius = v[0]; save() } }" />
            <span class="w-10 text-right text-xs text-muted-foreground">{{ s.look!.blur_radius }}</span>
          </div>
          <label class="flex items-center gap-3 text-xs text-muted-foreground">
            <Switch :model-value="s.look!.show_line" @update:model-value="(v: boolean) => { s.look!.show_line = v; save() }" />显示任务栏顶上那条细线
          </label>
          <label class="flex items-center gap-3 text-xs text-muted-foreground">
            <Switch :model-value="s.look!.show_peek" @update:model-value="(v: boolean) => { s.look!.show_peek = v; save() }" />显示右下角「显示桌面」按钮
          </label>
        </div>
      </div>
    </div>
  </div>
</template>
