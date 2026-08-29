<script setup lang="ts">
import { ref, computed, watch, onMounted, defineAsyncComponent, nextTick } from 'vue'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { emit, listen } from '@tauri-apps/api/event'
import { LazyStore } from '@tauri-apps/plugin-store'
import { settings, loadSettings, applyVibrancyVars, applyWindowEffect } from './composables/useAppSettings'
import { MENU_ITEMS, reconcile, splitGroups } from './lib/sidebar-prefs'
import { useI18n } from './i18n'
import { autoStartDsh } from './composables/useDsh'

/**
 * 顶部那一行拖窗口。
 *
 * 不用 `data-tauri-drag-region`:那个属性是"整片区域只能拖不能点",
 * 而我们顶上那一行恰恰摆着 Logo、Tabs、笔记页的工具卡和标签卡。
 * 以前的折中是只留两小段固定宽度的拖拽带,结果就是**大部分地方拖不动**。
 *
 * 换个判据:**光标形状**。按下去的那个元素如果声明了任何非默认光标
 * (手型 = 能点、文字 = 能选、col-resize = 能拉),就是它自己的地盘,不抢;
 * 只有 default/auto 才是"这里没东西",才拖窗口。cursor 是继承属性,
 * 所以按钮里的那个 <span> 图标也会拿到 pointer,不会误判。
 */
const TOP_BAND = 78   // 10 外缩 + 58 卡片 + 10 间距,和页面 pt-/pl- 同一个数

function isBlankSpot(e: MouseEvent) {
  if (e.button !== 0 || e.clientY > TOP_BAND) return false
  const el = e.target as HTMLElement | null
  if (!el) return false
  const c = getComputedStyle(el).cursor
  return c === 'default' || c === 'auto'
}

function onTopPointerDown(e: MouseEvent) {
  if (!isBlankSpot(e)) return
  e.preventDefault()          // 不然会拖出一片文字选区
  getCurrentWindow().startDragging()
}

// 原生标题栏双击最大化,这里得自己补上
function onTopDoubleClick(e: MouseEvent) {
  if (!isBlankSpot(e)) return
  getCurrentWindow().toggleMaximize()
}

import TitleBar from './components/TitleBar.vue'
import BootCloth from './components/BootCloth.vue'
import { zen } from './composables/useZen'
import { bindBrowserKeys } from './composables/useBrowserKeys'
import HomeView from './views/Home.vue'
import AgentView from './views/Agent.vue'
const VaultView = defineAsyncComponent(() => import('./views/Vault.vue'))
import SettingsView from './views/Settings.vue'
import TimerView from './views/Timer.vue'
import DockView from './views/Dock.vue'
import KeyboardPetView from './views/KeyboardPet.vue'
import ScreenshotView from './views/Screenshot.vue'
import TranslateView from './views/Translate.vue'
const ConvertView = defineAsyncComponent(() => import('./views/Convert.vue'))
import KeyVisualizerWindow from './KeyVisualizerWindow.vue'
import DockWindow from './dock/DockWindow.vue'
import PaletteWindow from './palette/PaletteWindow.vue'
import TrayMenu from './views/TrayMenu.vue'
import ScreenshotWindow from './screenshot/ScreenshotWindow.vue'
import PinWindow from './screenshot/PinWindow.vue'

const { t } = useI18n()
/*
  空串开局,等设置读完再定(见 onMounted 里的 startPage)。

  以前这里直接写死 'Agent' —— 而 Agent 是可以在设置里关掉的,
  关掉之后启动照样停在它上面,侧栏没有对应的图标,看着像卡在一个不存在的页。
*/
const currentView = ref('')
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

/**
 * 启动停在哪一页。
 *
 * 设置里选的那一页如果后来被隐藏了(或者干脆不存在了),就退回上排第一个
 * 还开着的 —— 存的是 id,而「隐藏某一页」是随时会发生的事,不能假设它还在。
 */
function resolveStartPage() {
  const items = menuItems.value
  const want = settings.startPage
  if (want && items.some((m) => m.id === want)) return want
  return items[0]?.id ?? 'Home'
}


const isKeyVisualizer = ref(false)
const isDockWindow = ref(false)
const isPaletteWindow = ref(false)
const isTrayMenu = ref(false)
const isScreenshotWindow = ref(false)
const isPinWindow = ref(false)

const shortcutWarning = ref('')

/**
 * 启动黑布(见 BootCloth.vue):窗口一出来就盖在最上面的粒子 Logo,
 * 设置读完、材质贴好、首页画完之后散场。无论中间出什么岔子,6 秒后也一定撤掉。
 */
const booting = ref(true)
const bootCloth = ref<InstanceType<typeof BootCloth> | null>(null)

// 后端传回来的是快捷键的内部名,这里映射到 i18n 的键再翻译
const shortcutNameMap: Record<string, string> = {
  dock: 'nav.dock',
  screenshot: 'nav.screenshot',
  screenshot_translate: 'nav.screenshot',
  palette: 'dock.tabPalette',
  palette_translate: 'dock.paletteTranslateHotkey',
}

// 把浏览器自带的快捷键收掉(Ctrl+P/R/F5/缩放…),见 useBrowserKeys
bindBrowserKeys()

onMounted(async () => {
  const win = getCurrentWindow()
  if (win.label === 'key_visualizer') { isKeyVisualizer.value = true; return }
  if (win.label === 'dock') { isDockWindow.value = true; return }
  if (win.label === 'palette') { isPaletteWindow.value = true; return }
  if (win.label === 'tray-menu') { isTrayMenu.value = true; return }
  if (win.label === 'screenshot') { isScreenshotWindow.value = true; return }
  if (win.label.startsWith('pin_')) { isPinWindow.value = true; return }

  /*
    主窗口一建出来就显示(tauri.conf.json 里没有 visible:false)。

    曾经试过先藏着、读完设置贴好材质再亮相 —— 结果正式版里 DWM 对「创建时不可见、之后才 show」
    的窗口不肯画云母,底下一片白,只有最小化再还原才救得回来,而那一下用户看得见。那条路作废。
    回到一建出来就显示,启动那几百毫秒用一块黑布盖住(BootCloth):粒子汇聚成 Logo,
    设置读完、材质贴好、首页画完之后散场淡出。
  */
  const clothShownAt = performance.now()
  window.setTimeout(() => { booting.value = false }, 6000)   // 无论中间出什么岔子,黑屏不能超过 6 秒

  await loadSettings()
  currentView.value = resolveStartPage()

  // 「打开 XGTools 就是打开智能体」—— 边车在这里就拉起来,不等用户切到那一页。
  // 不 await:装了 DSH 的话它要几秒才 ready,挂在这儿会把整个界面的首屏卡住。
  // 环境不齐时它什么都不做,由智能体页去引导。
  void autoStartDsh()

  // 恢复上次的窗口特效(主题已在 loadSettings 里应用,材质跟着主题走)
  if (settings.blurKind !== 'none') {
    const err = await applyWindowEffect()
    if (err) { console.error('恢复窗口特效失败:', err); settings.blurKind = 'none' }
  }

  // 首页画出来、材质贴好之后撤黑布;粒子至少要飞完成形(约 1.6s)
  await nextTick()
  const clothWait = Math.max(1600 - (performance.now() - clothShownAt), 400)
  window.setTimeout(async () => {
    await bootCloth.value?.dismiss()
    booting.value = false
  }, clothWait)

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

  /*
    命令面板的回车动作。面板是独立窗口,只能靠事件把结果送回主窗口。
    三种都要先把视图切过去,再去打开具体那一条。
  */
  listen<{ view: string }>('palette-go', e => { currentView.value = e.payload.view })

  listen<{ path: string }>('palette-open-note', async e => {
    currentView.value = 'Vault'
    // 笔记页是懒加载的,这一整个会话里可能还没挂载过 —— 那样工作区根目录是空的,
    // openFile 会打不开。所以先补一次恢复,已经恢复过的话它自己会跳过。
    const { restoreVault, openFile, vault } = await import('./composables/useVault')
    if (!vault.root) await restoreVault()
    await openFile(e.payload.path)
  })

  listen<{ sessionId: string }>('palette-open-session', async e => {
    currentView.value = 'Agent'
    const { openSession } = await import('./composables/useDshChat')
    await openSession(e.payload.sessionId)
  })

  // 监听快捷键注册失败通知
  listen<string[]>('shortcut-register-failed', (e) => {
    const names = e.payload.map(k => (shortcutNameMap[k] ? t(shortcutNameMap[k]) : k)).join('、')
    shortcutWarning.value = t('common.shortcutTaken', { name: names })
    setTimeout(() => { shortcutWarning.value = '' }, 8000)
  })
  // 后台重试把键抢回来了(见 lib.rs),提示就没必要再挂着
  listen('shortcut-register-recovered', () => { shortcutWarning.value = '' })

})
</script>

<template>
  <KeyVisualizerWindow v-if="isKeyVisualizer" />
  <DockWindow v-else-if="isDockWindow" />
  <PaletteWindow v-else-if="isPaletteWindow" />
  <TrayMenu v-else-if="isTrayMenu" />
  <ScreenshotWindow v-else-if="isScreenshotWindow" />
  <PinWindow v-else-if="isPinWindow" />

  <!--
    布局:内容层铺满整窗,顶栏和侧栏作为浮层压在它上面。
    这样页面内容是相对**整个窗口**居中的,而不是相对"减掉侧栏和顶栏之后的那块"——
    后者会让居中的东西偏右下各半个 chrome 宽度。
    10px 的外缩改由两个浮层各自承担(top-2.5 / left-2.5),Logo 与侧栏图标的对齐关系不变。
  -->
  <div v-else class="h-screen w-screen overflow-hidden text-foreground relative"
    :class="settings.blurKind === 'none' ? 'bg-background' : 'bg-transparent'"
    @mousedown="onTopPointerDown" @dblclick="onTopDoubleClick">
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
        <!--
          切页动画:**只有入场,没有离场**。
            入场 95% → 100% 淡入(新页面从小长出来)
            离场 直接消失

          为什么砍掉离场:两张整页同时做缩放 + 淡出,合成器要把两棵完整的 DOM 树
          各画一遍再叠起来。现在任一时刻只有一页在动,开销减半。

          ⚠️ **transition 属性里必须写 scale,不能只写 transform。**
          Tailwind v4 把 scale-95 编译成独立的 `scale` CSS 属性(v3 才是 transform: scale()),
          `transition-property: transform` 根本盖不到它 —— 现象是**透明度在渐变、
          大小却一帧跳到位**,看着就是"卡了一下"。查了很久才发现,把入场时长临时调到 2s
          才量得出来:加上 scale 之前比例一直是 1.000,加上之后才连续爬 0.960→0.981。
          translate-*/rotate-* 同理,以后要动它们记得一起加进这个列表。

          `leave-active-class="hidden"` 是同步加上去的(Vue 在 onLeave 里立刻加 active 类),
          所以旧页面在同一帧就 display:none,不会和新页面重叠;
          又因为新旧两个元素是同时存在的(不是 out-in 模式),中间也不会露出一帧空背景。
          :duration 的 leave:0 是告诉 Vue 别等 transitionend —— hidden 不产生过渡事件,
          不给这个 0 它会一直等到超时才把节点摘掉。

          will-change 让这一页在动画期间单独提到合成层走 GPU,动画结束 Vue 会把类去掉,
          不会长期占着显存。这里写 transform 而不是 scale:提升合成层用 transform 是所有
          浏览器都认的写法,而真正要过渡的属性在上面那个 transition- 里。
        -->
        <Transition
          enter-active-class="transition-[opacity,scale] duration-300 ease-out will-change-[opacity,transform]"
          enter-from-class="opacity-0 scale-95" enter-to-class="opacity-100 scale-100"
          leave-active-class="hidden"
          :duration="{ enter: 300, leave: 0 }">
          <!-- 那两截内边距是给顶栏和侧栏让的位;它们藏起来了就不该还留着 -->
          <div :key="currentView" class="absolute inset-0 overflow-auto"
            :class="zen.on ? 'pt-2.5 pl-2.5' : 'pt-[4.875rem] pl-[4.875rem]'">
            <HomeView v-if="currentView === 'Home'" />
            <AgentView v-else-if="currentView === 'Agent'" />
            <VaultView v-else-if="currentView === 'Vault'" />
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

    <!-- 禅模式:整条顶栏(含右上角三颗控制点)让开 -->
    <TitleBar v-if="!zen.on" class="absolute top-2.5 left-2.5 right-2.5 z-50"
      :active="currentView === 'Home'" @logo="currentView = 'Home'" />

    <!-- 启动黑布:粒子汇聚成 Logo,一切就绪后散场淡出(见 BootCloth.vue) -->
    <BootCloth v-if="booting" ref="bootCloth" />

    <!--
      快捷键冲突提示:右下角浮空小卡片,不占布局(以前是插在顶栏下面把内容整体压下去)。
      8 秒自动消失,也可以点 × 手动关。
    -->
    <Transition enter-active-class="transition-all duration-300 ease-out"
      enter-from-class="opacity-0 translate-y-2" leave-active-class="transition-all duration-200 ease-in"
      leave-to-class="opacity-0 translate-y-2">
      <div v-if="shortcutWarning"
        class="float-card fixed bottom-4 right-4 z-[60] max-w-sm rounded-[14px] border bg-card
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
        **列宽 = 卡片宽 = 58,卡片不居中、外边距 0。**
        以前列是 72、卡片 mx-auto 居中,左右各多出 7px —— 于是左边实际留白是 10+7=17,
        而右边和底部只有 10,四边不等。现在把那 7 去掉,四边一律 10px。
        Logo 也要跟着收成 58 宽才和图标同列(TitleBar.vue),别只改一边。
      -->
      <!--
        top-[4.875rem] = 10(外缩) + 58(顶栏卡片高) + 10(间距) —— 必须从顶栏下面开始。
        以前写 top-2.5,侧栏第一张卡片会直接压在浮空顶栏的 Logo 上面把它盖住。
        这个 4.875rem(78px) 也是 main 的 pt-/pl-,还有各页面的 pl- ——
        58 是全局模数,改它要连着 TitleBar 的 h-/w- 一起改。
      -->
      <aside v-if="!zen.on"
        class="absolute left-2.5 top-[4.875rem] bottom-2.5 z-40 w-[58px] flex flex-col overflow-y-auto">
        <nav v-if="tools.length" class="float-card rounded-[14px] border bg-card p-1.5 flex flex-col items-center gap-1">
          <!-- 笔记页选中时图标染成笔记主题色,其他页还是白的 —— 一眼看出现在在哪 -->
          <button v-for="item in tools" :key="item.id" @click="currentView = item.id" :title="t(item.labelKey)" :class="[
            'size-11 shrink-0 rounded-xl flex items-center justify-center transition-colors',
            currentView === item.id ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
          ]">
            <span :class="item.icon" class="w-6 h-6"
              :style="item.id === 'Vault' && currentView === 'Vault' ? { color: settings.vaultAccent } : undefined" />
          </button>
        </nav>

        <!--
          设置常驻,所以这张卡片永远存在;上面那张在工具全关时整张消失(不留空壳)。
          mt-auto 而不是靠父级 justify-between:后者在只剩这一张卡片时会把它顶到最上面去。
        -->
        <div class="float-card mt-auto rounded-[14px] border bg-card p-1.5 flex flex-col items-center gap-1">
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
