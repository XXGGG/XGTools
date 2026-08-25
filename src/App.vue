<script setup lang="ts">
import { ref, computed, watch, onMounted, defineAsyncComponent } from 'vue'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { emit, listen } from '@tauri-apps/api/event'
import { LazyStore } from '@tauri-apps/plugin-store'
import { settings, loadSettings, applyVibrancyVars, applyWindowEffect } from './composables/useAppSettings'
import { MENU_ITEMS, reconcile, splitGroups } from './lib/sidebar-prefs'
import { useI18n } from './i18n'

import TitleBar from './components/TitleBar.vue'
import HomeView from './views/Home.vue'
import SettingsView from './views/Settings.vue'
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

const { t } = useI18n()
const currentView = ref('Timer')
// 侧栏显示哪些页、什么顺序,由设置页驱动(清单本体在 lib/sidebar-prefs.ts)
const menuItems = computed(() =>
  reconcile(MENU_ITEMS, { order: settings.sidebarOrder, hidden: settings.sidebarHidden })
)

// body 的不透明底会盖住系统材质,开特效时必须去掉(规则在 style.css 的 body.vibrancy)
watch(() => settings.blurKind, (k) => {
  document.body.classList.toggle('vibrancy', k !== 'none')
}, { immediate: true })

// 材质种类和不透明度都会影响换算(不同材质的可用上限不同),所以两个都要监听。
// immediate 是为了启动时按存档值设一次,否则会停在 CSS 里的默认值。
watch(() => [settings.blurKind, settings.blurOpacity], applyVibrancyVars, { immediate: true })

const tools = computed(() => splitGroups(menuItems.value, settings.sidebarGroups).tools)
const configs = computed(() => splitGroups(menuItems.value, settings.sidebarGroups).configs)

// 当前正看的页被关掉时,自动切到第一个还开着的页,别留白屏
watch(menuItems, (items) => {
  if (currentView.value === 'Home' || currentView.value === 'Settings') return
  if (!items.some((m) => m.id === currentView.value)) currentView.value = items[0].id
})


const isKeyVisualizer = ref(false)
const isDockWindow = ref(false)
const isScreenshotWindow = ref(false)
const isPinWindow = ref(false)

const shortcutWarning = ref('')

// 后端传回来的是快捷键的内部名,这里映射到 i18n 的键再翻译
const shortcutNameMap: Record<string, string> = {
  dock: 'nav.dock',
  screenshot: 'nav.screenshot',
  screenshot_translate: 'nav.screenshot',
}

onMounted(async () => {
  const win = getCurrentWindow()
  if (win.label === 'key_visualizer') { isKeyVisualizer.value = true; return }
  if (win.label === 'dock') { isDockWindow.value = true; return }
  if (win.label === 'screenshot') { isScreenshotWindow.value = true; return }
  if (win.label.startsWith('pin_')) { isPinWindow.value = true; return }

  await loadSettings()
  // 恢复上次的窗口特效(主题已在 loadSettings 里应用,材质跟着主题走)
  if (settings.blurKind !== 'none') {
    const err = await applyWindowEffect()
    if (err) { console.error('恢复窗口特效失败:', err); settings.blurKind = 'none' }
  }

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

  // 监听快捷键注册失败通知
  listen<string[]>('shortcut-register-failed', (e) => {
    const names = e.payload.map(k => (shortcutNameMap[k] ? t(shortcutNameMap[k]) : k)).join('、')
    shortcutWarning.value = t('common.shortcutTaken', { name: names })
    setTimeout(() => { shortcutWarning.value = '' }, 8000)
  })

})
</script>

<template>
  <KeyVisualizerWindow v-if="isKeyVisualizer" />
  <DockWindow v-else-if="isDockWindow" />
  <ScreenshotWindow v-else-if="isScreenshotWindow" />
  <PinWindow v-else-if="isPinWindow" />

  <!--
    布局:内容层铺满整窗,顶栏和侧栏作为浮层压在它上面。
    这样页面内容是相对**整个窗口**居中的,而不是相对"减掉侧栏和顶栏之后的那块"——
    后者会让居中的东西偏右下各半个 chrome 宽度。
    10px 的外缩改由两个浮层各自承担(top-2.5 / left-2.5),Logo 与侧栏图标的对齐关系不变。
  -->
  <div v-else class="h-screen w-screen overflow-hidden text-foreground relative"
    :class="settings.blurKind === 'none' ? 'bg-background' : 'bg-transparent'">
    <!-- 内容层。只负责定位上下文和底色,不再自己带 padding(见下面包裹层的说明)。 -->
    <main class="absolute inset-0"
      :class="settings.blurKind === 'none' ? 'bg-background/50' : 'bg-transparent'">
        <!--
          【别把包裹层改回 static】页面切换闪动就是这里踩过的坑。

          Home / Timer 用 absolute inset-0 逃出 padding,它们锚定的是「最近的已定位祖先」。
          如果包裹层平时是 static,过渡时又被加上 translate-y(transform 会让元素成为包含块)、
          离场时再被加 absolute,锚点就会在 main 和包裹层之间来回跳 —— 每跳一次内容闪一下。

          所以包裹层**始终**是 absolute inset-0:锚点恒定,加不加 transform 都不变。
          pt/pl 移到这里给常规页面让出 chrome 的位置;absolute 的子元素对齐 padding box,
          不受这层 padding 影响,所以居中页面照样铺满整窗。
          离场也不用再补 absolute —— 两层本来就 inset-0 完全重叠,天然是交叉淡化。
        -->
        <Transition
          enter-active-class="transition-[opacity,transform] duration-300 ease-out"
          enter-from-class="opacity-0 scale-95" enter-to-class="opacity-100 scale-100"
          leave-active-class="transition-[opacity,transform] duration-200 ease-in"
          leave-from-class="opacity-100 scale-100" leave-to-class="opacity-0 scale-105">
          <div :key="currentView" class="absolute inset-0 overflow-auto pt-[5.75rem] pl-[5.75rem]">
            <HomeView v-if="currentView === 'Home'" />
            <SettingsView v-else-if="currentView === 'Settings'" />
            <TimerView v-else-if="currentView === 'Timer'" />
            <DockView v-else-if="currentView === 'Dock'" />
            <KeyboardPetView v-else-if="currentView === 'KeyboardPet'" />
            <ScreenshotView v-else-if="currentView === 'Screenshot'" />
            <TranslateView v-else-if="currentView === 'Translate'" />
            <ConvertView v-else-if="currentView === 'Convert'" />
          </div>
        </Transition>
    </main>

    <TitleBar class="absolute top-2.5 left-2.5 right-2.5 z-50"
      :active="currentView === 'Home'" @logo="currentView = 'Home'" />

    <!--
      快捷键冲突提示:右下角浮空小卡片,不占布局(以前是插在顶栏下面把内容整体压下去)。
      8 秒自动消失,也可以点 × 手动关。
    -->
    <Transition enter-active-class="transition-all duration-300 ease-out"
      enter-from-class="opacity-0 translate-y-2" leave-active-class="transition-all duration-200 ease-in"
      leave-to-class="opacity-0 translate-y-2">
      <div v-if="shortcutWarning"
        class="float-card fixed bottom-4 right-4 z-[60] max-w-sm rounded-2xl border bg-card
               px-4 py-3 flex items-center gap-3 text-sm">
        <span class="icon-[lucide--triangle-alert] w-4 h-4 text-amber-500 shrink-0" />
        <span class="flex-1 leading-snug">{{ shortcutWarning }}</span>
        <button @click="shortcutWarning = ''" :title="t('window.close')"
          class="shrink-0 -mr-1 size-6 rounded-lg flex items-center justify-center
                 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
          <span class="icon-[lucide--x] w-3.5 h-3.5" />
        </button>
      </div>
    </Transition>

      <!--
        ┌─ 侧栏卡片的四个可调参数(要改就改这四个,别的都是从它们推出来的)──────────
        │  ① 卡片内边距  p-1.5   = 6px  高亮方块到卡片边框的距离,四边相等
        │  ② 高亮/格子   size-11 = 44px 选中态圆角方块的大小,也是每个图标格的大小
        │  ③ 图标间距    gap-1   = 4px  格子与格子之间,不影响 ① 的边距
        │  ④ 图标本身    w-6 h-6 = 24px
        │  → 卡片宽度自动 = 44 + 6×2 + 边框 1×2 = 58px
        └──────────────────────────────────────────────────────────────
        ①③ 必须分开:以前用 py-1 做纵向留白,横向却没有,结果上下 10px、左右 5px 不等。
        现在边距只由 ① 决定(四边同一个值),间距只由 ③ 决定,互不干扰。
        对齐:卡片 mx-auto 居中在 72px 列里,图标中心才和 Logo 同列 —— 改卡片宽度会让 Logo 错位。
      -->
      <!--
        top-[5.75rem] = 10(外缩) + 72(顶栏高) + 10(间距) —— 必须从顶栏下面开始。
        以前写 top-2.5,侧栏第一张卡片会直接压在浮空顶栏的 Logo 上面把它盖住。
        这个 5.75rem 和 main 的 pt- 是同一个值,改一个要改两个。
      -->
      <aside class="absolute left-2.5 top-[5.75rem] bottom-2.5 z-40 w-18 flex flex-col overflow-y-auto">
        <nav v-if="tools.length" class="float-card mx-auto rounded-2xl border bg-card p-1.5 flex flex-col items-center gap-1">
          <button v-for="item in tools" :key="item.id" @click="currentView = item.id" :title="t(item.labelKey)" :class="[
            'size-11 shrink-0 rounded-xl flex items-center justify-center transition-colors',
            currentView === item.id ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
          ]">
            <span :class="item.icon" class="w-6 h-6" />
          </button>
        </nav>

        <!--
          设置常驻,所以这张卡片永远存在;上面那张在工具全关时整张消失(不留空壳)。
          mt-auto 而不是靠父级 justify-between:后者在只剩这一张卡片时会把它顶到最上面去。
        -->
        <div class="float-card mt-auto mx-auto rounded-2xl border bg-card p-1.5 flex flex-col items-center gap-1">
          <button v-for="item in configs" :key="item.id" @click="currentView = item.id" :title="t(item.labelKey)" :class="[
            'size-11 shrink-0 rounded-xl flex items-center justify-center transition-colors',
            currentView === item.id ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
          ]">
            <span :class="item.icon" class="w-6 h-6" />
          </button>
          <div v-if="configs.length" class="w-7 h-px bg-border" />
          <button @click="currentView = 'Settings'" :title="t('nav.settings')" :class="[
            'size-11 shrink-0 rounded-xl flex items-center justify-center transition-colors',
            currentView === 'Settings' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
          ]">
            <span class="icon-[lucide--settings] w-6 h-6" />
          </button>
        </div>
      </aside>

  </div>
</template>
