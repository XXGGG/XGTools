<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { emit } from '@tauri-apps/api/event'
import { LazyStore } from '@tauri-apps/plugin-store'
import { LogicalSize } from '@tauri-apps/api/window'
import { Button } from '@/components/ui/button'

const isKeyVisOpen = ref(false)
const isEditMode = ref(false)
const isAvoidMouse = ref(false)
const isAutoClear = ref(false)
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
}

onMounted(() => checkWindowState())

const toggleAutoClear = async () => {
  isAutoClear.value = !isAutoClear.value
  await emit('toggle-auto-clear', isAutoClear.value)
  await store.set('auto_clear_enabled', isAutoClear.value)
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
        <span class="font-medium">按键显示</span>
      </div>

      <div class="flex items-center gap-2">
        <Button v-if="isKeyVisOpen" variant="ghost" size="icon" @click="toggleAutoClear"
          :class="isAutoClear ? 'bg-blue-500 text-white hover:bg-blue-600 hover:text-white' : 'text-muted-foreground hover:text-foreground'"
          title="自动清除">
          <span class="icon-[lucide--eraser] w-5 h-5" />
        </Button>

        <Button v-if="isKeyVisOpen" variant="ghost" size="icon" @click="toggleAvoidMouse"
          :class="isAvoidMouse ? 'bg-green-500 text-white hover:bg-green-600 hover:text-white' : 'text-muted-foreground hover:text-foreground'"
          title="躲避鼠标">
          <span class="icon-[lucide--square-dashed-mouse-pointer] w-5 h-5" />
        </Button>

        <Button v-if="isKeyVisOpen" variant="ghost" size="icon" @click="resetWindowPosition"
          class="text-muted-foreground hover:text-foreground" title="重置位置">
          <span class="icon-[lucide--rotate-ccw] w-5 h-5" />
        </Button>

        <Button v-if="isKeyVisOpen" variant="ghost" size="icon" @click="toggleEditMode"
          :class="isEditMode ? 'bg-yellow-500 text-white hover:bg-yellow-600 hover:text-white' : 'text-muted-foreground hover:text-foreground'"
          title="调整位置">
          <span class="icon-[lucide--move] w-5 h-5" />
        </Button>

        <Button variant="ghost" size="icon" @click="toggleKeyVis"
          :class="isKeyVisOpen ? 'text-primary hover:bg-primary/10' : 'text-muted-foreground hover:text-foreground'"
          :title="isKeyVisOpen ? '关闭显示' : '开启显示'">
          <span :class="isKeyVisOpen ? 'icon-[lucide--eye]' : 'icon-[lucide--eye-off]'" class="w-5 h-5" />
        </Button>
      </div>
    </div>

    <div class="w-full max-w-2xl mx-auto flex-1 border border-dashed rounded-lg p-8 flex flex-col items-center justify-center space-y-4 text-muted-foreground/60">
      <span class="icon-[lucide--cat] w-12 h-12" />
      <div class="text-center space-y-1">
        <h3 class="font-medium text-base">键盘桌宠</h3>
        <p class="text-sm">即将来袭</p>
      </div>
    </div>
  </div>
</template>
