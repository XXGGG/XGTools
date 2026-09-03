<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { LazyStore } from '@tauri-apps/plugin-store'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { Switch } from '@/components/ui/switch'
import { Slider } from '@/components/ui/slider'
import { Button } from '@/components/ui/button'
import { Tabs, TabsTrigger } from '@/components/ui/tabs'
import TitleBarTabs from '@/components/TitleBarTabs.vue'
import { useI18n } from '@/i18n'
/*
  快捷键统一走 lib/shortcuts。

  这一页原来自己攒了一份「读三个键 → update_all_shortcuts」——
  少传的那几个键（命令面板、翻译面板、录屏）在后端会被当成 null 全部注销掉：
  在截图页动一下开关，命令面板的键就没了，而且没有任何报错。
*/
import { syncAllShortcuts } from '@/lib/shortcuts'

const { t } = useI18n()

const store = new LazyStore('settings.json')
const settingsLoaded = ref(false)

/*
  「重启截图」。

  截图窗口是常驻的隐藏窗口,快捷键按下去只是把它叫出来。它偶尔会卡死
  (webview 自己崩了、或者被系统挂起之后没醒过来),现象是**键还在、按了没反应** ——
  从外面看和「键被别的程序占了」一模一样,而那条路怎么修都修不好。
  重载这一个窗口就行,不用退出整个程序。

  设置页的快捷键总览里也有这一颗。放两处不是重复:出了这个毛病的人第一反应
  是来截图这一页找,不会想到去翻快捷键总览。
*/
const restarting = ref(false)
const restartMsg = ref('')
async function restartScreenshot() {
  restarting.value = true
  restartMsg.value = ''
  try {
    await invoke('reload_screenshot_window')
    restartMsg.value = t('settings.keysRestartShotDone')
  } catch (e) {
    restartMsg.value = String(e)
  } finally {
    restarting.value = false
  }
}

// --- State ---
const screenshotEnabled = ref(true)
const screenshotShortcut = ref('Ctrl+Alt+A')
const autoBgShadow = ref(false)
const bgColor = ref('transparent')
const bgPadding = ref(32)
const shadowBlur = ref(30)
const cornerRadius = ref(8)

// 截图翻译
const screenshotTranslateEnabled = ref(false)
const screenshotTranslateShortcut = ref('Ctrl+Alt+D')
const isRecordingTranslateShortcut = ref(false)


// 录屏
const recordEnabled = ref(true)
const recordShortcut = ref('Ctrl+Alt+R')
const recordFps = ref(30)
const recordDir = ref('')
const recordAudio = ref(true)
const recordMaxMin = ref(30)
const isRecordingRecShortcut = ref(false)

/** 空 = 用默认的「桌面\Recordings」。显示成人话，别把空串直接摆出来 */
const recordDirLabel = computed(() => recordDir.value || t('screenshot.recDirDefault'))

async function pickRecordDir() {
  const picked = await openDialog({ directory: true, multiple: false })
  if (typeof picked === 'string') {
    recordDir.value = picked
    await saveSettings()
  }
}

function clearRecordDir() {
  recordDir.value = ''
  saveSettings()
}

// 快捷键录制
const isRecordingShortcut = ref(false)
const recordingKeys = ref('')

// Tabs
const activeTab = ref<'screenshot' | 'record' | 'translate'>('screenshot')

// --- Load / Save ---
async function loadSettings() {
  await store.init()
  screenshotEnabled.value = (await store.get<boolean>('screenshot_enabled')) ?? true
  screenshotShortcut.value = (await store.get<string>('screenshot_shortcut')) ?? 'Ctrl+Alt+A'
  autoBgShadow.value = (await store.get<boolean>('screenshot_auto_bg_shadow')) ?? false
  bgColor.value = (await store.get<string>('screenshot_bg_color')) ?? 'transparent'
  bgPadding.value = (await store.get<number>('screenshot_bg_padding')) ?? 32
  shadowBlur.value = (await store.get<number>('screenshot_shadow_blur')) ?? 30
  cornerRadius.value = (await store.get<number>('screenshot_corner_radius')) ?? 8
  screenshotTranslateEnabled.value = (await store.get<boolean>('screenshot_translate_enabled')) ?? false
  screenshotTranslateShortcut.value = (await store.get<string>('screenshot_translate_shortcut')) ?? 'Ctrl+Alt+D'
  recordEnabled.value = (await store.get<boolean>('record_enabled')) ?? true
  recordShortcut.value = (await store.get<string>('record_shortcut')) ?? 'Ctrl+Alt+R'
  recordFps.value = (await store.get<number>('record_fps')) ?? 30
  recordDir.value = (await store.get<string>('record_dir')) ?? ''
  recordAudio.value = (await store.get<boolean>('record_audio')) ?? true
  recordMaxMin.value = (await store.get<number>('record_max_min')) ?? 30
  settingsLoaded.value = true
}

async function saveSettings() {
  await store.set('screenshot_enabled', screenshotEnabled.value)
  await store.set('screenshot_shortcut', screenshotShortcut.value)
  await store.set('screenshot_auto_bg_shadow', autoBgShadow.value)
  await store.set('screenshot_bg_color', bgColor.value)
  await store.set('screenshot_bg_padding', bgPadding.value)
  await store.set('screenshot_shadow_blur', shadowBlur.value)
  await store.set('screenshot_corner_radius', cornerRadius.value)
  await store.set('screenshot_translate_enabled', screenshotTranslateEnabled.value)
  await store.set('screenshot_translate_shortcut', screenshotTranslateShortcut.value)
  await store.set('record_enabled', recordEnabled.value)
  await store.set('record_shortcut', recordShortcut.value)
  await store.set('record_fps', recordFps.value)
  await store.set('record_dir', recordDir.value)
  await store.set('record_audio', recordAudio.value)
  await store.set('record_max_min', recordMaxMin.value)
  await store.save()
}

onMounted(loadSettings)

watch(
  [screenshotEnabled, screenshotTranslateEnabled, recordEnabled, recordFps, recordAudio, recordMaxMin, autoBgShadow, bgColor, bgPadding, shadowBlur, cornerRadius],
  () => {
    if (settingsLoaded.value) {
      saveSettings()
      if (settingsLoaded.value) syncAllShortcuts()
    }
  },
)

// --- 快捷键录制 ---
function startRecordingShortcut() {
  isRecordingShortcut.value = true
  recordingKeys.value = ''
}

function handleShortcutKeydown(e: KeyboardEvent) {
  if (!isRecordingShortcut.value && !isRecordingTranslateShortcut.value && !isRecordingRecShortcut.value) return
  e.preventDefault()
  e.stopPropagation()
  if (e.key === 'Escape') { cancelRecording(); return }
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return

  const parts: string[] = []
  if (e.ctrlKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  if (e.metaKey) parts.push('Super')
  if (parts.length === 0) return

  let key = e.key.toUpperCase()
  if (e.code.startsWith('Key')) key = e.code.slice(3)
  else if (e.code.startsWith('Digit')) key = e.code.slice(5)
  else if (e.code.startsWith('F') && /^F\d+$/.test(e.code)) key = e.code
  else {
    const keyMap: Record<string, string> = {
      ' ': 'Space', 'ENTER': 'Enter', 'TAB': 'Tab',
      'BACKSPACE': 'Backspace', 'DELETE': 'Delete',
      'ARROWUP': 'Up', 'ARROWDOWN': 'Down',
      'ARROWLEFT': 'Left', 'ARROWRIGHT': 'Right',
    }
    key = keyMap[key] || key
  }

  parts.push(key)
  const shortcutStr = parts.join('+')

  if (isRecordingRecShortcut.value) {
    isRecordingRecShortcut.value = false
    recordShortcut.value = shortcutStr
    saveSettings().then(() => syncAllShortcuts())
  } else if (isRecordingTranslateShortcut.value) {
    isRecordingTranslateShortcut.value = false
    screenshotTranslateShortcut.value = shortcutStr
    saveSettings().then(() => syncAllShortcuts())
  } else {
    recordingKeys.value = shortcutStr
    isRecordingShortcut.value = false
    applyShortcut(shortcutStr)
  }
}

async function applyShortcut(shortcutStr: string) {
  const oldShortcut = screenshotShortcut.value
  try {
    screenshotShortcut.value = shortcutStr
    await saveSettings()
    await syncAllShortcuts()
  } catch (e) {
    console.error('Failed to update shortcut:', e)
    screenshotShortcut.value = oldShortcut
    recordingKeys.value = ''
    await saveSettings()
    await syncAllShortcuts()
  }
}

function cancelRecording() {
  isRecordingShortcut.value = false
  isRecordingTranslateShortcut.value = false
  recordingKeys.value = ''
}

onMounted(() => {
  window.addEventListener('keydown', handleShortcutKeydown)
})
onUnmounted(() => {
  window.removeEventListener('keydown', handleShortcutKeydown)
})

// 背景颜色选项
const bgColorPresets = [
  { value: 'transparent', label: '透明' },
  { value: '#ffffff', label: '' },
  { value: '#f0f0f0', label: '' },
  { value: '#1a1a2e', label: '' },
  { value: '#0d1117', label: '' },
  { value: '#000000', label: '' },
]
</script>

<template>
  <div class="h-full w-full flex flex-col p-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
    <div class="flex-1 overflow-y-auto max-w-2xl mx-auto w-full space-y-4">

      <!-- 页签搬到标题栏,和设置页同一套;原来那两个标签是硬编码中文,顺手接进 i18n -->
      <Tabs v-model="activeTab">
        <TitleBarTabs>
          <TabsTrigger value="screenshot" class="h-11 px-4 rounded-xl">{{ t('shot.tabShot') }}</TabsTrigger>
          <TabsTrigger value="record" class="h-11 px-4 rounded-xl">{{ t('shot.tabRecord') }}</TabsTrigger>
          <TabsTrigger value="translate" class="h-11 px-4 rounded-xl">{{ t('shot.tabTranslate') }}</TabsTrigger>
        </TitleBarTabs>
      </Tabs>

      <!-- ======== 截图 Tab ======== -->
      <div v-if="activeTab === 'screenshot'" class="space-y-3">

        <!-- 开启截图 -->
        <div class="flex items-center justify-between p-4 border rounded-lg hover:bg-accent/50 transition-colors">
          <div class="flex items-center gap-3">
            <div class="flex items-center justify-center w-9 h-9 rounded-md text-muted-foreground">
              <span class="icon-[lucide--focus] w-5 h-5" />
            </div>
            <div>
              <h3 class="font-medium">{{ t('screenshot.enable') }}</h3>
              <p class="text-xs text-muted-foreground">{{ t('screenshot.enableHint') }}</p>
            </div>
          </div>
          <Switch :model-value="screenshotEnabled" @update:model-value="screenshotEnabled = $event" />
        </div>

        <!-- 以下设置仅在开启时可用 -->
        <div :class="{ 'opacity-40 pointer-events-none select-none': !screenshotEnabled }" class="space-y-3 transition-opacity duration-300">

          <!-- 截图快捷键 -->
          <div class="flex items-center justify-between p-4 border rounded-lg hover:bg-accent/50 transition-colors">
            <div class="flex items-center gap-3">
              <div class="flex items-center justify-center w-9 h-9 rounded-md text-muted-foreground">
                <span class="icon-[lucide--keyboard] w-5 h-5" />
              </div>
              <div>
                <h3 class="font-medium">{{ t('screenshot.hotkey') }}</h3>
                <p class="text-xs text-muted-foreground">{{ t('screenshot.hotkeyHint') }}</p>
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              class="min-w-30 font-mono"
              @click="isRecordingShortcut ? cancelRecording() : startRecordingShortcut()"
            >
              {{ isRecordingShortcut ? t('screenshot.pressKeys') : screenshotShortcut }}
            </Button>
          </div>

          <!-- 键在、按了没反应时的那一手。紧挨着快捷键那一行,因为出毛病的就是它 -->
          <div class="flex items-center justify-between p-4 border rounded-lg hover:bg-accent/50 transition-colors">
            <div class="flex items-center gap-3 min-w-0">
              <div class="flex items-center justify-center w-9 h-9 rounded-md text-muted-foreground">
                <span class="icon-[lucide--rotate-cw] w-5 h-5" />
              </div>
              <div class="min-w-0">
                <h3 class="font-medium">{{ t('settings.keysRestartShot') }}</h3>
                <p class="text-xs text-muted-foreground">
                  {{ restartMsg || t('settings.keysRestartShotHint') }}
                </p>
              </div>
            </div>
            <Button variant="outline" size="sm" :disabled="restarting" @click="restartScreenshot">
              <span class="icon-[lucide--rotate-cw] w-3.5 h-3.5" :class="restarting ? 'animate-spin' : ''" />
              {{ t('settings.keysRestartShot') }}
            </Button>
          </div>

          <!-- 背景与投影 -->
          <div class="flex items-center justify-between p-4 border rounded-lg hover:bg-accent/50 transition-colors">
            <div class="flex items-center gap-3">
              <div class="flex items-center justify-center w-9 h-9 rounded-md text-muted-foreground">
                <span class="icon-[lucide--image] w-5 h-5" />
              </div>
              <div>
                <h3 class="font-medium">{{ t('screenshot.backdrop') }}</h3>
                <p class="text-xs text-muted-foreground">{{ t('screenshot.backdropHint') }}</p>
              </div>
            </div>
            <Switch :model-value="autoBgShadow" @update:model-value="autoBgShadow = $event" />
          </div>

          <!-- 背景投影的子设置 -->
          <div :class="{ 'opacity-40 pointer-events-none select-none': !autoBgShadow }" class="space-y-3 transition-opacity duration-300 pl-4">

            <!-- 背景颜色 -->
            <div class="p-4 border rounded-lg hover:bg-accent/50 transition-colors">
              <div class="flex items-center gap-3 mb-3">
                <div class="flex items-center justify-center w-9 h-9 rounded-md text-muted-foreground">
                  <span class="icon-[lucide--palette] w-5 h-5" />
                </div>
                <div>
                  <h3 class="font-medium">{{ t('screenshot.bgColor') }}</h3>
                  <p class="text-xs text-muted-foreground">{{ bgColor === 'transparent' ? '透明' : bgColor }}</p>
                </div>
              </div>
              <div class="flex items-center gap-2 ml-10">
                <button
                  v-for="preset in bgColorPresets" :key="preset.value"
                  @click="bgColor = preset.value"
                  class="w-7 h-7 rounded-lg border-2 transition-all duration-150 flex items-center justify-center"
                  :class="bgColor === preset.value ? 'border-primary scale-110' : 'border-border hover:border-muted-foreground'"
                  :style="preset.value === 'transparent'
                    ? { background: 'repeating-conic-gradient(#d0d0d0 0% 25%, transparent 0% 50%) 50%/10px 10px' }
                    : { backgroundColor: preset.value }"
                />
                <label class="relative cursor-pointer ml-1">
                  <div class="w-7 h-7 rounded-lg border-2 border-dashed border-border hover:border-muted-foreground flex items-center justify-center text-muted-foreground transition-colors">
                    <span class="icon-[lucide--plus] w-3.5 h-3.5" />
                  </div>
                  <input type="color" :value="bgColor === 'transparent' ? '#f0f0f0' : bgColor" @input="bgColor = ($event.target as HTMLInputElement).value" class="absolute inset-0 w-full h-full opacity-0 cursor-pointer" />
                </label>
              </div>
            </div>

            <!-- 背景内边距 -->
            <div class="flex items-center justify-between p-4 border rounded-lg hover:bg-accent/50 transition-colors">
              <div class="flex items-center gap-3">
                <div class="flex items-center justify-center w-9 h-9 rounded-md text-muted-foreground">
                  <span class="icon-[lucide--move] w-5 h-5" />
                </div>
                <div>
                  <h3 class="font-medium">{{ t('screenshot.padding') }}</h3>
                  <p class="text-xs text-muted-foreground">{{ bgPadding }}px</p>
                </div>
              </div>
              <Slider :model-value="[bgPadding]" @update:model-value="(v) => bgPadding = v![0]" :min="8" :max="80" :step="4" class="w-32" />
            </div>

            <!-- 圆角 -->
            <div class="flex items-center justify-between p-4 border rounded-lg hover:bg-accent/50 transition-colors">
              <div class="flex items-center gap-3">
                <div class="flex items-center justify-center w-9 h-9 rounded-md text-muted-foreground">
                  <span class="icon-[lucide--square] w-5 h-5" />
                </div>
                <div>
                  <h3 class="font-medium">{{ t('screenshot.radius') }}</h3>
                  <p class="text-xs text-muted-foreground">{{ cornerRadius }}px</p>
                </div>
              </div>
              <Slider :model-value="[cornerRadius]" @update:model-value="(v) => cornerRadius = v![0]" :min="0" :max="24" :step="2" class="w-32" />
            </div>

            <!-- 阴影强度 -->
            <div class="flex items-center justify-between p-4 border rounded-lg hover:bg-accent/50 transition-colors">
              <div class="flex items-center gap-3">
                <div class="flex items-center justify-center w-9 h-9 rounded-md text-muted-foreground">
                  <span class="icon-[lucide--cloud] w-5 h-5" />
                </div>
                <div>
                  <h3 class="font-medium">{{ t('screenshot.shadow') }}</h3>
                  <p class="text-xs text-muted-foreground">{{ shadowBlur }}px</p>
                </div>
              </div>
              <Slider :model-value="[shadowBlur]" @update:model-value="(v) => shadowBlur = v![0]" :min="0" :max="60" :step="2" class="w-32" />
            </div>

          </div>

          <!-- 预览 -->
          <div v-if="autoBgShadow" class="p-4 border rounded-lg">
            <p class="text-xs text-muted-foreground mb-3">{{ t('screenshot.preview') }}</p>
            <div class="flex items-center justify-center p-4">
              <div
                class="rounded-lg overflow-hidden inline-block transition-all duration-200"
                :style="{
                  background: bgColor === 'transparent'
                    ? 'repeating-conic-gradient(#d0d0d0 0% 25%, #f8f8f8 0% 50%) 50%/14px 14px'
                    : bgColor,
                  outline: '1px dashed rgba(128,128,128,0.4)',
                  outlineOffset: '3px',
                }"
              >
                <div
                  class="flex items-center justify-center transition-all duration-200"
                  :style="{ padding: (bgPadding * 0.5) + 'px' }"
                >
                  <div
                    :style="{
                      width: '260px',
                      height: '150px',
                      borderRadius: (cornerRadius * 0.5) + 'px',
                      boxShadow: shadowBlur > 0
                        ? [
                            `0 ${shadowBlur * 0.08}px ${shadowBlur * 0.2}px rgba(0,0,0,0.14)`,
                            `0 ${shadowBlur * 0.25}px ${shadowBlur * 0.5}px rgba(0,0,0,0.10)`,
                            `0 ${shadowBlur * 0.5}px ${shadowBlur}px rgba(0,0,0,0.08)`,
                          ].join(', ')
                        : 'none',
                      background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                    }"
                    class="flex items-center justify-center text-white/80 text-sm select-none"
                  >
                    {{ t('screenshot.content') }}
                  </div>
                </div>
              </div>
            </div>
            <p v-if="bgPadding < shadowBlur * 0.8" class="text-xs text-amber-500 mt-2 flex items-center gap-1.5">
              <span class="icon-[lucide--alert-triangle] w-3.5 h-3.5 shrink-0" />
              {{ t('screenshot.paddingWarn') }}
            </p>
          </div>

        </div>
      </div>

      <!-- ======== 录屏 Tab ======== -->
      <div v-else-if="activeTab === 'record'" class="space-y-3">

        <div class="flex items-center justify-between p-4 border rounded-lg hover:bg-accent/50 transition-colors">
          <div class="flex items-center gap-3">
            <div class="flex items-center justify-center w-9 h-9 rounded-md text-muted-foreground">
              <span class="icon-[lucide--video] w-5 h-5" />
            </div>
            <div>
              <h3 class="font-medium">{{ t('screenshot.recEnable') }}</h3>
              <p class="text-xs text-muted-foreground">{{ t('screenshot.recEnableHint') }}</p>
            </div>
          </div>
          <Switch :model-value="recordEnabled" @update:model-value="recordEnabled = $event" />
        </div>

        <div :class="{ 'opacity-40 pointer-events-none select-none': !recordEnabled }" class="space-y-3 transition-opacity duration-300">

          <!-- 快捷键 -->
          <div class="flex items-center justify-between p-4 border rounded-lg hover:bg-accent/50 transition-colors">
            <div class="flex items-center gap-3">
              <div class="flex items-center justify-center w-9 h-9 rounded-md text-muted-foreground">
                <span class="icon-[lucide--keyboard] w-5 h-5" />
              </div>
              <div>
                <h3 class="font-medium">{{ t('screenshot.recHotkey') }}</h3>
                <p class="text-xs text-muted-foreground">{{ t('screenshot.recHotkeyHint') }}</p>
              </div>
            </div>
            <Button
              variant="outline" size="sm" class="min-w-30 font-mono"
              @click="isRecordingRecShortcut ? cancelRecording() : (isRecordingRecShortcut = true)"
            >
              {{ isRecordingRecShortcut ? t('screenshot.pressKeys') : recordShortcut }}
            </Button>
          </div>

          <!-- 保存位置 -->
          <div class="flex items-center justify-between p-4 border rounded-lg hover:bg-accent/50 transition-colors gap-3">
            <div class="flex items-center gap-3 min-w-0">
              <div class="flex items-center justify-center w-9 h-9 rounded-md text-muted-foreground shrink-0">
                <span class="icon-[lucide--folder] w-5 h-5" />
              </div>
              <div class="min-w-0">
                <h3 class="font-medium">{{ t('screenshot.recDir') }}</h3>
                <p class="text-xs text-muted-foreground truncate" :title="recordDirLabel">{{ recordDirLabel }}</p>
              </div>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              <Button v-if="recordDir" variant="ghost" size="sm" @click="clearRecordDir">
                {{ t('screenshot.recDirReset') }}
              </Button>
              <Button variant="outline" size="sm" @click="pickRecordDir">
                {{ t('screenshot.recDirPick') }}
              </Button>
            </div>
          </div>


          <!-- 录声音 -->
          <div class="flex items-center justify-between p-4 border rounded-lg hover:bg-accent/50 transition-colors">
            <div class="flex items-center gap-3">
              <div class="flex items-center justify-center w-9 h-9 rounded-md text-muted-foreground">
                <span class="icon-[lucide--volume-2] w-5 h-5" />
              </div>
              <div>
                <h3 class="font-medium">{{ t('screenshot.recAudio') }}</h3>
                <p class="text-xs text-muted-foreground">{{ t('screenshot.recAudioHint') }}</p>
              </div>
            </div>
            <Switch :model-value="recordAudio" @update:model-value="recordAudio = $event" />
          </div>


          <!-- 时长上限 -->
          <div class="flex items-center justify-between p-4 border rounded-lg hover:bg-accent/50 transition-colors gap-3">
            <div class="flex items-center gap-3 min-w-0">
              <div class="flex items-center justify-center w-9 h-9 rounded-md text-muted-foreground shrink-0">
                <span class="icon-[lucide--alarm-clock] w-5 h-5" />
              </div>
              <div class="min-w-0">
                <h3 class="font-medium">{{ t('screenshot.recMax') }}</h3>
                <p class="text-xs text-muted-foreground">{{ t('screenshot.recMaxHint') }}</p>
              </div>
            </div>
            <div class="flex items-center gap-1 shrink-0">
              <Button
                v-for="m in [10, 30, 60, 0]" :key="m"
                :variant="recordMaxMin === m ? 'default' : 'outline'" size="sm"
                class="min-w-14"
                @click="recordMaxMin = m"
              >{{ m === 0 ? t('screenshot.recMaxOff') : m + ' min' }}</Button>
            </div>
          </div>

          <!-- 帧率 -->
          <div class="p-4 border rounded-lg">
            <div class="flex items-center justify-between mb-3">
              <div class="flex items-center gap-3">
                <div class="flex items-center justify-center w-9 h-9 rounded-md text-muted-foreground">
                  <span class="icon-[lucide--gauge] w-5 h-5" />
                </div>
                <div>
                  <h3 class="font-medium">{{ t('screenshot.recFps') }}</h3>
                  <p class="text-xs text-muted-foreground">{{ t('screenshot.recFpsHint') }}</p>
                </div>
              </div>
              <span class="text-sm font-mono text-muted-foreground">{{ recordFps }}</span>
            </div>
            <Slider
              :model-value="[recordFps]" :min="10" :max="60" :step="5"
              @update:model-value="(v) => { if (v) recordFps = v[0] }"
            />
          </div>

        </div>
      </div>

      <!-- ======== 截图翻译 Tab ======== -->
      <div v-else-if="activeTab === 'translate'" class="space-y-3">

        <!-- 开启截图翻译 -->
        <div class="flex items-center justify-between p-4 border rounded-lg hover:bg-accent/50 transition-colors">
          <div class="flex items-center gap-3">
            <div class="flex items-center justify-center w-9 h-9 rounded-md text-muted-foreground">
              <span class="icon-[lucide--languages] w-5 h-5" />
            </div>
            <div>
              <h3 class="font-medium">{{ t('screenshot.enableTranslate') }}</h3>
              <p class="text-xs text-muted-foreground">{{ t('screenshot.enableTranslateHint') }}</p>
            </div>
          </div>
          <Switch :model-value="screenshotTranslateEnabled" @update:model-value="screenshotTranslateEnabled = $event" />
        </div>

        <!-- 以下设置仅在开启时可用 -->
        <div :class="{ 'opacity-40 pointer-events-none select-none': !screenshotTranslateEnabled }" class="space-y-3 transition-opacity duration-300">

          <!-- 截图翻译快捷键 -->
          <div class="flex items-center justify-between p-4 border rounded-lg hover:bg-accent/50 transition-colors">
            <div class="flex items-center gap-3">
              <div class="flex items-center justify-center w-9 h-9 rounded-md text-muted-foreground">
                <span class="icon-[lucide--keyboard] w-5 h-5" />
              </div>
              <div>
                <h3 class="font-medium">{{ t('screenshot.translateHotkey') }}</h3>
                <p class="text-xs text-muted-foreground">{{ t('screenshot.translateHotkeyHint') }}</p>
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              class="min-w-30 font-mono"
              @click="isRecordingTranslateShortcut ? cancelRecording() : (isRecordingTranslateShortcut = true)"
            >
              {{ isRecordingTranslateShortcut ? t('screenshot.pressKeys') : screenshotTranslateShortcut }}
            </Button>
          </div>

        </div>
      </div>

    </div>
  </div>
</template>
