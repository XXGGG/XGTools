<script setup lang="ts">
/**
 * 命令面板的设置页。
 *
 * # 为什么从启动台里搬出来
 *
 * 它原来是「启动台」下面的一个页签。两件事凑在一起只因为**都跟找东西有关** ——
 * 但启动台是一格一格的应用图标，命令面板是一个敲字的输入框，
 * 开的窗口、按的键、要配的东西没有一样是同一个。
 * 摆在别人家的第四个页签里，等于没有。
 *
 * # 快捷键走的是公共那份
 *
 * 原来这一页自己读写 `palette_shortcut` / `palette_translate_shortcut`，
 * 而设置页的「快捷键」总览走的是 `lib/shortcuts`。同一个键两套代码在读，
 * 于是**在这儿改完，设置页那边显示的还是旧值**（要重开一次才看得到）。
 * 现在两边都从 `lib/shortcuts` 走，只有一份数据，也就没有对不上这回事。
 * 顺带这一页也能显示「装上了没 / 被谁占着」，那本来只有总览页有。
 */
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { settings } from '@/composables/useAppSettings'
import {
  readAllShortcuts, writeShortcut, writeEnabled, syncAllShortcuts,
  shortcutStatus, pauseShortcuts, shortcutFromKeydown,
  type ShortcutKey, type ShortcutState,
} from '@/lib/shortcuts'

const { t } = useI18n()

/* ────────── 快捷键 ────────── */

const rows = ref<ShortcutState[]>([])
const live = ref<Record<string, boolean>>({})
const recording = ref<ShortcutKey | null>(null)
const err = ref('')

const row = (k: ShortcutKey) => rows.value.find((r) => r.key === k) ?? null
const paletteOn = computed(() => row('palette')?.enabled ?? true)

/**
 * 这个键此刻在系统层的状态。
 *
 * 「装上了」和「设了」是两回事：键设着、功能开着，却被别的程序抢先注册了，
 * 表现就是按了毫无反应 —— 不显示出来的话，人只会觉得是我们坏了。
 */
type Live = 'on' | 'taken' | 'off' | 'unset'
function liveOf(k: ShortcutKey): Live {
  const r = row(k)
  if (!r?.shortcut) return 'unset'
  if (!r.enabled) return 'off'
  return live.value[k] ? 'on' : 'taken'
}
const LIVE_CLS: Record<Live, string> = {
  on: 'text-emerald-500',
  taken: 'text-red-500',
  off: 'text-muted-foreground',
  unset: 'text-muted-foreground',
}
const LIVE_KEY: Record<Live, string> = {
  on: 'settings.keyOn',
  taken: 'settings.keyTaken',
  off: 'settings.keyOff',
  unset: 'settings.keyUnset',
}

async function refresh() {
  rows.value = await readAllShortcuts()
  const s = await shortcutStatus().catch(() => [])
  live.value = Object.fromEntries(s.map((x) => [x.key, x.registered]))
}

async function startRecord(k: ShortcutKey) {
  if (recording.value === k) { await stopRecord(); return }
  recording.value = k
  err.value = ''
  // 录制期间把自己的键全摘掉,否则想录一个正被自己占着的组合,网页收不到 keydown
  try { await pauseShortcuts() } catch { /* 摘不掉就照常录 */ }
}

async function stopRecord() {
  recording.value = null
  await syncAllShortcuts().catch(() => [])
  await refresh()
}

async function onKeydown(e: KeyboardEvent) {
  const k = recording.value
  if (!k) return
  e.preventDefault()
  e.stopPropagation()
  if (e.key === 'Escape') { await stopRecord(); return }
  const combo = shortcutFromKeydown(e)
  if (!combo) return
  try {
    await writeShortcut(k, combo)
  } catch (e2) {
    err.value = String(e2)
  }
  await stopRecord()
}

async function toggle(k: ShortcutKey, on: boolean) {
  await writeEnabled(k, on)
  await stopRecord()
}

/* ────────── 文件搜索后端 ────────── */

/*
  文件那一路是交给系统索引做的（Windows Search / Spotlight / plocate），
  我们不自己扫盘 —— 所以这里只报「能不能用」和「不能用是为什么」，没有开关。
*/
type FsStatus = { backend: string; ready: boolean; detail: string }
const fs = ref<FsStatus | null>(null)
const fsBackendKey = computed(() =>
  fs.value?.backend === 'windows-search' ? 'palettePage.fsBackendWindows'
  : fs.value?.backend === 'spotlight' ? 'palettePage.fsBackendSpotlight'
  : 'palettePage.fsBackendPlocate')

onMounted(async () => {
  window.addEventListener('keydown', onKeydown, true)
  await refresh()
  try { fs.value = await invoke<FsStatus>('file_search_status') } catch { fs.value = null }
})
onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown, true)
  if (recording.value) void stopRecord()
})
</script>

<template>
  <div class="h-full w-full flex flex-col p-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
    <div class="flex-1 overflow-y-auto space-y-3 max-w-2xl mx-auto w-full">

      <!-- 开启 -->
      <div class="flex items-center justify-between p-4 border rounded-lg hover:bg-accent/50 transition-colors">
        <div class="flex items-center gap-3">
          <div class="flex items-center justify-center w-9 h-9 rounded-md text-muted-foreground">
            <span class="icon-[lucide--search] w-5 h-5" />
          </div>
          <div>
            <h3 class="font-medium">{{ t('palettePage.enable') }}</h3>
            <p class="text-xs text-muted-foreground">{{ t('palettePage.enableHint') }}</p>
          </div>
        </div>
        <Switch :model-value="paletteOn" @update:model-value="toggle('palette', $event)" />
      </div>

      <div :class="{ 'opacity-40 pointer-events-none select-none': !paletteOn }"
        class="space-y-3 transition-opacity duration-300">

        <!-- 呼出快捷键 -->
        <div class="flex items-center justify-between p-4 border rounded-lg hover:bg-accent/50 transition-colors">
          <div class="flex items-center gap-3 min-w-0">
            <div class="flex items-center justify-center w-9 h-9 rounded-md text-muted-foreground">
              <span class="icon-[lucide--keyboard] w-5 h-5" />
            </div>
            <div class="min-w-0">
              <h3 class="font-medium">{{ t('palettePage.hotkey') }}</h3>
              <p class="text-xs text-muted-foreground">{{ t('palettePage.hotkeyHint') }}</p>
            </div>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <span class="text-xs" :class="LIVE_CLS[liveOf('palette')]">{{ t(LIVE_KEY[liveOf('palette')]) }}</span>
            <Button variant="outline" size="sm" class="min-w-30 font-mono"
              @click="recording === 'palette' ? stopRecord() : startRecord('palette')">
              {{ recording === 'palette' ? t('dock.pressKeys') : (row('palette')?.shortcut || '—') }}
            </Button>
          </div>
        </div>

        <!-- 翻译面板快捷键。和上面同一份数据,设置页的总览改哪边都一样 -->
        <div class="flex items-center justify-between p-4 border rounded-lg hover:bg-accent/50 transition-colors">
          <div class="flex items-center gap-3 min-w-0">
            <div class="flex items-center justify-center w-9 h-9 rounded-md text-muted-foreground">
              <span class="icon-[lucide--languages] w-5 h-5" />
            </div>
            <div class="min-w-0">
              <h3 class="font-medium">{{ t('palettePage.transHotkey') }}</h3>
              <p class="text-xs text-muted-foreground">{{ t('palettePage.transHotkeyHint') }}</p>
            </div>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <span class="text-xs" :class="LIVE_CLS[liveOf('palette_translate')]">
              {{ t(LIVE_KEY[liveOf('palette_translate')]) }}
            </span>
            <Button variant="outline" size="sm" class="min-w-30 font-mono"
              @click="recording === 'palette_translate' ? stopRecord() : startRecord('palette_translate')">
              {{ recording === 'palette_translate' ? t('dock.pressKeys') : (row('palette_translate')?.shortcut || '—') }}
            </Button>
            <Switch :model-value="row('palette_translate')?.enabled ?? false"
              @update:model-value="toggle('palette_translate', $event)" />
          </div>
        </div>

        <!-- 回车默认翻译。面板里那颗小徽章是同一个值 -->
        <div class="flex items-center justify-between p-4 border rounded-lg hover:bg-accent/50 transition-colors">
          <div class="flex items-center gap-3 min-w-0">
            <div class="flex items-center justify-center w-9 h-9 rounded-md text-muted-foreground">
              <span class="icon-[lucide--corner-down-left] w-5 h-5" />
            </div>
            <div class="min-w-0">
              <h3 class="font-medium">{{ t('palettePage.enterFirst') }}</h3>
              <p class="text-xs text-muted-foreground">{{ t('palettePage.enterFirstHint') }}</p>
            </div>
          </div>
          <Switch :model-value="settings.paletteTranslateFirst"
            @update:model-value="settings.paletteTranslateFirst = $event" />
        </div>

        <p v-if="err" class="text-xs text-red-500 wrap-break-word px-1">{{ err }}</p>

        <!--
          说明合成一整块。

          原来这些是三四个和上面长得一模一样的「设置行」,但它们**一个开关都没有** ——
          长得像设置却点不动，人第一反应是「这里坏了」。
          既然都是「这东西是什么、怎么用」，就该是一段说明，不该假装成设置。
        -->
        <div class="p-5 border rounded-lg bg-muted/20 space-y-4">
          <div class="flex items-center gap-2">
            <span class="icon-[lucide--command] w-4 h-4 text-muted-foreground" />
            <h3 class="font-medium">{{ t('palettePage.aboutTitle') }}</h3>
          </div>

          <p class="text-[13px] text-muted-foreground leading-relaxed">{{ t('palettePage.about') }}</p>

          <!-- 搜索范围:四类,外加文件那一路的后端状态 -->
          <div>
            <p class="text-xs text-muted-foreground uppercase tracking-wider font-medium mb-2">
              {{ t('palettePage.sources') }}
            </p>
            <div class="flex flex-wrap gap-1.5">
              <span v-for="s in ['pages', 'apps', 'notes', 'sessions']" :key="s"
                class="h-6 px-2 rounded-md border border-border text-[11.5px] flex items-center gap-1 text-muted-foreground">
                {{ t(`palettePage.src_${s}`) }}
              </span>
              <span v-if="fs" class="h-6 px-2 rounded-md border text-[11.5px] flex items-center gap-1"
                :class="fs.ready ? 'border-emerald-600/40 text-emerald-600' : 'border-border text-muted-foreground'">
                <span :class="fs.ready ? 'icon-[lucide--file-search]' : 'icon-[lucide--file-question]'"
                  class="w-3 h-3" />
                {{ t('palettePage.src_files') }}
              </span>
            </div>
            <p v-if="fs" class="mt-1.5 text-[11.5px] text-muted-foreground/80 leading-relaxed">
              {{ fs.ready ? t('palettePage.fsReady') + ' · ' + t(fsBackendKey) : fs.detail }}
            </p>
          </div>

          <!-- 用法。三条,都是「不说就不会有人发现」的那种 -->
          <div>
            <p class="text-xs text-muted-foreground uppercase tracking-wider font-medium mb-2">
              {{ t('palettePage.howTitle') }}
            </p>
            <ul class="space-y-1.5">
              <li v-for="h in ['how1', 'how2', 'how3']" :key="h"
                class="flex gap-2 text-[13px] text-muted-foreground leading-relaxed">
                <span class="icon-[lucide--dot] w-4 h-4 shrink-0 mt-0.5" />
                <span>{{ t(`palettePage.${h}`) }}</span>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
