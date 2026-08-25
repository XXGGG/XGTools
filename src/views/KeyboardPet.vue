<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { emit } from '@tauri-apps/api/event'
import { LazyStore } from '@tauri-apps/plugin-store'
import { LogicalSize } from '@tauri-apps/api/window'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { useI18n } from '@/i18n'

const { t } = useI18n()
const isKeyVisOpen = ref(false)
const isEditMode = ref(false)
const isAvoidMouse = ref(false)
const isAutoClear = ref(false)
const autoClearSec = ref(3)          // 自动清除延时(秒),2~20
const store = new LazyStore('settings.json')

const toggleEditMode = async () => {
  isEditMode.value = !isEditMode.value
  await emit('toggle-key-visualizer-edit', isEditMode.value)
}

const resetWindowPosition = async () => {
  try {
    const win = await WebviewWindow.getByLabel('key_visualizer')
    if (win) {
      if (await win.isMinimized()) await win.unminimize()
      if (!(await win.isVisible())) await win.show()
      await win.setSize(new LogicalSize(270, 300))
      await emit('reset-key-visualizer-position')
    }
  } catch (error) {
    console.error('Failed to reset position:', error)
  }
}

const toggleAvoidMouse = async () => {
  isAvoidMouse.value = !isAvoidMouse.value
  await emit('toggle-avoid-mouse', isAvoidMouse.value)
  await store.set('avoid_mouse', isAvoidMouse.value)
  await store.save()
}

const checkWindowState = async () => {
  await store.init()
  const savedState = await store.get<boolean>('key_visualizer_enabled')
  const win = await WebviewWindow.getByLabel('key_visualizer')
  if (win) isKeyVisOpen.value = await win.isVisible()
  if (savedState && !isKeyVisOpen.value) await toggleKeyVis()
  isAvoidMouse.value = await store.get<boolean>('avoid_mouse') || false
  isAutoClear.value = await store.get<boolean>('auto_clear_enabled') || false
  autoClearSec.value = await store.get<number>('auto_clear_delay') ?? 3
}

onMounted(() => checkWindowState())

const toggleAutoClear = async () => {
  isAutoClear.value = !isAutoClear.value
  await emit('toggle-auto-clear', isAutoClear.value)
  await store.set('auto_clear_enabled', isAutoClear.value)
  await store.save()
}

// 延时改动要实时推给按键显示窗口(它是独立 webview,读不到这边的状态)
const setAutoClearSec = async (v?: number[]) => {
  const n = v?.[0]
  if (typeof n !== 'number') return
  autoClearSec.value = n
  await emit('set-auto-clear-delay', n)
  await store.set('auto_clear_delay', n)
  await store.save()
}

const toggleKeyVis = async () => {
  try {
    let win = await WebviewWindow.getByLabel('key_visualizer')

    if (!win) {
      win = new WebviewWindow('key_visualizer', {
        url: 'index.html', title: 'key_visualizer',
        width: 270, height: 300,
        decorations: false, shadow: false, transparent: true,
        alwaysOnTop: true, skipTaskbar: true, resizable: false, visible: true,
      })
      win.once('tauri://error', (e) => console.error('Failed to create window:', e))
      isEditMode.value = false
      await emit('toggle-key-visualizer-edit', false)
      isKeyVisOpen.value = true
      await store.set('key_visualizer_enabled', true)
      await store.save()
      return
    }

    if (isKeyVisOpen.value) {
      await win.hide()
      isKeyVisOpen.value = false
      isEditMode.value = false
      await emit('toggle-key-visualizer-edit', false)
      await store.set('key_visualizer_enabled', false)
      await store.save()
    } else {
      await win.show()
      isKeyVisOpen.value = true
      isEditMode.value = false
      await emit('toggle-key-visualizer-edit', false)
      await store.set('key_visualizer_enabled', true)
      await store.save()
    }
  } catch (error) {
    console.error('Toggle error:', error)
  }
}

onUnmounted(() => emit('toggle-key-visualizer-edit', false))
</script>

<template>
  <div class="h-full w-full p-8 flex flex-col space-y-4">
    <div class="w-full max-w-2xl mx-auto border rounded-lg p-4 flex items-center justify-between hover:bg-accent/50 transition-colors">
      <div class="flex items-center gap-3">
        <div class="flex items-center justify-center w-9 h-9 rounded-md text-muted-foreground">
          <span class="icon-[lucide--keyboard] w-5 h-5" />
        </div>
        <span class="font-medium">{{ t('keyboard.keyDisplay') }}</span>
      </div>

      <div class="flex items-center gap-2">
        <Button v-if="isKeyVisOpen" variant="ghost" size="icon" @click="toggleAutoClear"
          :class="isAutoClear ? 'bg-blue-500 text-white hover:bg-blue-600 hover:text-white' : 'text-muted-foreground hover:text-foreground'"
          :title="t('keyboard.autoClear')">
          <span class="icon-[lucide--eraser] w-5 h-5" />
        </Button>

        <Button v-if="isKeyVisOpen" variant="ghost" size="icon" @click="toggleAvoidMouse"
          :class="isAvoidMouse ? 'bg-green-500 text-white hover:bg-green-600 hover:text-white' : 'text-muted-foreground hover:text-foreground'"
          :title="t('keyboard.avoidMouse')">
          <span class="icon-[lucide--square-dashed-mouse-pointer] w-5 h-5" />
        </Button>

        <Button v-if="isKeyVisOpen" variant="ghost" size="icon" @click="resetWindowPosition"
          class="text-muted-foreground hover:text-foreground" :title="t('keyboard.resetPosition')">
          <span class="icon-[lucide--rotate-ccw] w-5 h-5" />
        </Button>

        <Button v-if="isKeyVisOpen" variant="ghost" size="icon" @click="toggleEditMode"
          :class="isEditMode ? 'bg-yellow-500 text-white hover:bg-yellow-600 hover:text-white' : 'text-muted-foreground hover:text-foreground'"
          :title="t('keyboard.adjustPosition')">
          <span class="icon-[lucide--move] w-5 h-5" />
        </Button>

        <Button variant="ghost" size="icon" @click="toggleKeyVis"
          :class="isKeyVisOpen ? 'text-primary hover:bg-primary/10' : 'text-muted-foreground hover:text-foreground'"
          :title="isKeyVisOpen ? t('keyboard.close') : t('keyboard.open')">
          <span :class="isKeyVisOpen ? 'icon-[lucide--eye]' : 'icon-[lucide--eye-off]'" class="w-5 h-5" />
        </Button>
      </div>
    </div>

    <!-- 自动清除开启后才出现:同样的外框,调延时 -->
    <div v-if="isKeyVisOpen && isAutoClear"
      class="w-full max-w-2xl mx-auto border rounded-lg p-4 flex items-center gap-4 hover:bg-accent/50 transition-colors">
      <div class="flex items-center gap-3 shrink-0">
        <div class="flex items-center justify-center w-9 h-9 rounded-md text-muted-foreground">
          <span class="icon-[lucide--timer] w-5 h-5" />
        </div>
        <span class="font-medium">{{ t('keyboard.autoClearDelay') }}</span>
      </div>
      <Slider class="flex-1" :model-value="[autoClearSec]" :min="2" :max="20" :step="1"
        @update:model-value="setAutoClearSec" />
      <span class="shrink-0 w-12 text-right text-sm font-mono text-muted-foreground">{{ autoClearSec }}s</span>
    </div>

    <div class="w-full max-w-2xl mx-auto flex-1 border border-dashed rounded-lg p-8 flex flex-col items-center justify-center space-y-4 text-muted-foreground/60">
      <span class="icon-[lucide--cat] w-12 h-12" />
      <div class="text-center space-y-1">
        <h3 class="font-medium text-base">{{ t('keyboard.petTitle') }}</h3>
        <p class="text-sm">{{ t('keyboard.petSoon') }}</p>
      </div>
    </div>
  </div>
</template>
