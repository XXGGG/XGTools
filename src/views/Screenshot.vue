<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { LazyStore } from '@tauri-apps/plugin-store'
import { Switch } from '@/components/ui/switch'
import { Slider } from '@/components/ui/slider'
import { Button } from '@/components/ui/button'

const store = new LazyStore('settings.json')
const settingsLoaded = ref(false)

// --- State ---
const screenshotEnabled = ref(true)
const screenshotShortcut = ref('Ctrl+Alt+A')
const autoBgShadow = ref(false)
const bgColor = ref('transparent')
const bgPadding = ref(32)
const shadowBlur = ref(30)
const cornerRadius = ref(8)

// 快捷键录制
const isRecordingShortcut = ref(false)
const recordingKeys = ref('')

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
  await store.save()
}

onMounted(loadSettings)

watch(
  [screenshotEnabled, autoBgShadow, bgColor, bgPadding, shadowBlur, cornerRadius],
  () => {
    if (settingsLoaded.value) {
      saveSettings()
      // 开关变化时同步快捷键注册状态
      if (settingsLoaded.value) syncAllShortcuts()
    }
  },
)

// --- 收集所有快捷键并统一更新 ---
async function syncAllShortcuts() {
  try {
    const dockSettings = await invoke<{ shortcut: string }>('get_settings')
    const stEnabled = (await store.get<boolean>('screenshot_translate_enabled')) ?? false
    const stShortcut = (await store.get<string>('screenshot_translate_shortcut')) ?? ''
    await invoke('update_all_shortcuts', {
      shortcuts: {
        dock_shortcut: dockSettings.shortcut,
        screenshot_shortcut: screenshotEnabled.value ? screenshotShortcut.value : null,
        screenshot_translate_shortcut: stEnabled && stShortcut ? stShortcut : null,
      }
    })
  } catch (e) {
    console.error('Failed to sync shortcuts:', e)
  }
}

// --- 快捷键录制 ---
function startRecordingShortcut() {
  isRecordingShortcut.value = true
  recordingKeys.value = ''
}

function handleShortcutKeydown(e: KeyboardEvent) {
  if (!isRecordingShortcut.value) return
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
  recordingKeys.value = shortcutStr
  isRecordingShortcut.value = false
  applyShortcut(shortcutStr)
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
    <div class="flex-1 overflow-y-auto space-y-3 max-w-2xl mx-auto w-full">

      <!-- 开启截图 -->
      <div class="flex items-center justify-between p-4 border rounded-lg hover:bg-accent/50 transition-colors">
        <div class="flex items-center gap-3">
          <div class="flex items-center justify-center w-9 h-9 rounded-md text-muted-foreground">
            <span class="icon-[lucide--focus] w-5 h-5" />
          </div>
          <div>
            <h3 class="font-medium">开启截图</h3>
            <p class="text-xs text-muted-foreground">启用截图功能与全局快捷键</p>
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
              <h3 class="font-medium">截图快捷键</h3>
              <p class="text-xs text-muted-foreground">快速启动截图</p>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            class="min-w-[120px] font-mono"
            @click="isRecordingShortcut ? cancelRecording() : startRecordingShortcut()"
          >
            {{ isRecordingShortcut ? '按下组合键...' : screenshotShortcut }}
          </Button>
        </div>

        <!-- 背景与投影 -->
        <div class="flex items-center justify-between p-4 border rounded-lg hover:bg-accent/50 transition-colors">
          <div class="flex items-center gap-3">
            <div class="flex items-center justify-center w-9 h-9 rounded-md text-muted-foreground">
              <span class="icon-[lucide--image] w-5 h-5" />
            </div>
            <div>
              <h3 class="font-medium">自动添加背景与投影</h3>
              <p class="text-xs text-muted-foreground">截图自动加上背景色、圆角和阴影效果</p>
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
                <h3 class="font-medium">背景颜色</h3>
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
                <h3 class="font-medium">背景内边距</h3>
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
                <h3 class="font-medium">圆角</h3>
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
                <h3 class="font-medium">阴影强度</h3>
                <p class="text-xs text-muted-foreground">{{ shadowBlur }}px</p>
              </div>
            </div>
            <Slider :model-value="[shadowBlur]" @update:model-value="(v) => shadowBlur = v![0]" :min="0" :max="60" :step="2" class="w-32" />
          </div>

        </div>

        <!-- 预览 -->
        <div v-if="autoBgShadow" class="p-4 border rounded-lg">
          <p class="text-xs text-muted-foreground mb-3">预览效果</p>
          <!-- 外层容器：溢出裁剪，模拟真实导出效果 -->
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
              <!-- 内边距层（按 0.5 比例缩放） -->
              <div
                class="flex items-center justify-center transition-all duration-200"
                :style="{ padding: (bgPadding * 0.5) + 'px' }"
              >
                <!-- 截图内容（含阴影 + 圆角） -->
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
                  截图内容
                </div>
              </div>
            </div>
          </div>
          <!-- 提示信息 -->
          <p v-if="bgPadding < shadowBlur * 0.8" class="text-xs text-amber-500 mt-2 flex items-center gap-1.5">
            <span class="icon-[lucide--alert-triangle] w-3.5 h-3.5 shrink-0" />
            内边距较小，部分阴影会被裁切
          </p>
        </div>

      </div>
    </div>
  </div>
</template>
