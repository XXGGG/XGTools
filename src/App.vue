<script setup lang="ts">
import { ref, onMounted, defineAsyncComponent } from 'vue'
import { useDark } from '@vueuse/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { emit } from '@tauri-apps/api/event'
import { LazyStore } from '@tauri-apps/plugin-store'

import TitleBar from './components/TitleBar.vue'
import HomeView from './views/Home.vue'
import TodoView from './views/Todo.vue'
import TimerView from './views/Timer.vue'
import DockView from './views/Dock.vue'
import KeyboardPetView from './views/KeyboardPet.vue'
import ScreenshotView from './views/Screenshot.vue'
import TranslateView from './views/Translate.vue'
const ConvertView = defineAsyncComponent(() => import('./views/Convert.vue'))
import KeyVisualizerWindow from './KeyVisualizerWindow.vue'
import DockWindow from './dock/DockWindow.vue'
import ScreenshotWindow from './screenshot/ScreenshotWindow.vue'
import PinWindow from './screenshot/PinWindow.vue'

const currentView = ref('Todo')
const collapsed = ref(false)
const menuItems = [
  { id: 'Todo', label: '待办', icon: 'icon-[lucide--circle-check-big]' },
  { id: 'Timer', label: '计时器', icon: 'icon-[lucide--timer]' },
  { id: 'Dock', label: '启动台', icon: 'icon-[lucide--layout-grid]' },
  { id: 'KeyboardPet', label: '键盘桌宠', icon: 'icon-[lucide--keyboard]' },
  { id: 'Screenshot', label: '截图', icon: 'icon-[lucide--focus]' },
  { id: 'Translate', label: '翻译', icon: 'icon-[lucide--languages]' },
  { id: 'Convert', label: '格式转换', icon: 'icon-[lucide--refresh-ccw]' },
]

useDark()

const isKeyVisualizer = ref(false)
const isDockWindow = ref(false)
const isScreenshotWindow = ref(false)
const isPinWindow = ref(false)

onMounted(async () => {
  const win = getCurrentWindow()
  if (win.label === 'key_visualizer') { isKeyVisualizer.value = true; return }
  if (win.label === 'dock') { isDockWindow.value = true; return }
  if (win.label === 'screenshot') { isScreenshotWindow.value = true; return }
  if (win.label.startsWith('pin_')) { isPinWindow.value = true; return }

  // 恢复按键显示窗口状态
  const store = new LazyStore('settings.json')
  await store.init()
  try {
    const savedKeyVisState = await store.get<boolean>('key_visualizer_enabled')
    let keyVisWin = await WebviewWindow.getByLabel('key_visualizer')
    const isOpen = keyVisWin ? await keyVisWin.isVisible() : false

    if (savedKeyVisState && !isOpen) {
      if (!keyVisWin) {
        keyVisWin = new WebviewWindow('key_visualizer', {
          url: 'index.html', title: '',
          width: 270, height: 300,
          decorations: false, shadow: false, transparent: true,
          alwaysOnTop: true, skipTaskbar: true, resizable: false, visible: true,
        })
      } else {
        await keyVisWin.show()
        await keyVisWin.setFocus()
      }
      await emit('toggle-key-visualizer-edit', false)
    }
  } catch (err) {
    console.error('Failed to restore Key Visualizer state:', err)
  }
})
</script>

<template>
  <KeyVisualizerWindow v-if="isKeyVisualizer" />
  <DockWindow v-else-if="isDockWindow" />
  <ScreenshotWindow v-else-if="isScreenshotWindow" />
  <PinWindow v-else-if="isPinWindow" />

  <div v-else class="h-screen w-screen overflow-hidden bg-background text-foreground flex flex-col">
    <TitleBar />

    <div class="flex-1 flex overflow-hidden">
      <aside :class="[collapsed ? 'w-14' : 'w-50', 'shrink-0 flex flex-col transition-all duration-200']">
        <nav class="flex-1 pt-4 flex flex-col gap-1 px-2">
          <button v-for="item in menuItems" :key="item.id" @click="currentView = item.id" :title="item.label" :class="[
            'flex items-center rounded-lg transition-all duration-200 text-sm font-medium overflow-hidden',
            collapsed ? 'size-10 justify-center mx-auto' : 'gap-3 w-full px-4 py-3',
            currentView === item.id
              ? 'bg-primary text-primary-foreground shadow-md'
              : 'hover:bg-muted text-muted-foreground hover:text-foreground'
          ]">
            <span :class="item.icon" class="w-5 h-5 shrink-0" />
            <span v-if="!collapsed" class="whitespace-nowrap">{{ item.label }}</span>
          </button>
        </nav>

        <div class="pb-4 flex flex-col gap-1 px-2">
          <button @click="currentView = 'Home'" title="主页" :class="[
            'flex items-center rounded-lg transition-all duration-200 text-muted-foreground hover:text-foreground hover:bg-muted overflow-hidden',
            collapsed ? 'size-10 justify-center mx-auto' : 'gap-3 w-full px-4 py-2.5'
          ]">
            <span class="icon-[lucide--box] w-5 h-5 shrink-0" />
            <span v-if="!collapsed" class="text-sm font-caveat font-bold whitespace-nowrap">XGTools</span>
          </button>
          <button @click="collapsed = !collapsed" :title="collapsed ? '展开侧栏' : '收起侧栏'" :class="[
            'flex items-center rounded-lg transition-all duration-200 text-muted-foreground hover:text-foreground hover:bg-muted overflow-hidden',
            collapsed ? 'size-10 justify-center mx-auto' : 'gap-3 w-full px-4 py-2.5'
          ]">
            <span :class="collapsed ? 'icon-[lucide--panel-left-open]' : 'icon-[lucide--panel-left-close]'" class="w-5 h-5 shrink-0" />
            <span v-if="!collapsed" class="text-sm font-medium whitespace-nowrap">收起</span>
          </button>
        </div>
      </aside>

      <main class="flex-1 overflow-auto bg-background/50 relative">
        <Transition enter-active-class="transition-all duration-300 ease-out" enter-from-class="opacity-0 translate-y-4"
          enter-to-class="opacity-100 translate-y-0"
          leave-active-class="transition-all duration-200 ease-in absolute top-0 w-full" leave-from-class="opacity-100"
          leave-to-class="opacity-0 -translate-y-4">
          <div :key="currentView" class="h-full w-full">
            <HomeView v-if="currentView === 'Home'" />
            <TodoView v-else-if="currentView === 'Todo'" />
            <TimerView v-else-if="currentView === 'Timer'" />
            <DockView v-else-if="currentView === 'Dock'" />
            <KeyboardPetView v-else-if="currentView === 'KeyboardPet'" />
            <ScreenshotView v-else-if="currentView === 'Screenshot'" />
            <TranslateView v-else-if="currentView === 'Translate'" />
            <ConvertView v-else-if="currentView === 'Convert'" />
          </div>
        </Transition>
      </main>
    </div>
  </div>
</template>
