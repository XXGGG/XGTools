<script setup lang="ts">
/**
 * 托盘菜单。
 *
 * 单独一个无边框小窗口,不是系统原生菜单 —— 原生那套在 Windows 上会被任务栏
 * 挡住,而位置归系统管、改不了。字号圆角配色跟应用对不上还是其次的。
 * 这里就是普通的 Vue 组件,样式和主界面同一套 token。
 *
 * 里面只放「不打开主界面也想干」的事。要在页面里操作的东西(翻译、格式转换、
 * 笔记、计时器)不放 —— 点进去也只是打开主界面再切页,那是命令面板的活。
 */
import { ref, onMounted, nextTick } from 'vue'
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { invoke } from '@tauri-apps/api/core'
import { emit } from '@tauri-apps/api/event'
import { LazyStore } from '@tauri-apps/plugin-store'
import { useI18n } from '@/i18n'
import { loadSettings, reloadSettings, applyTheme, watchSystemTheme } from '@/composables/useAppSettings'

const { t } = useI18n()
const win = getCurrentWindow()
const store = new LazyStore('settings.json')

/** 菜单宽度。和 tray.rs 的定位算式无关(那边读的是实际窗口尺寸),改这里就够 */
const WIDTH = 230

const card = ref<HTMLElement | null>(null)
const petOn = ref(false)

/**
 * 窗口贴着内容高。
 *
 * 配置里那个高度只是个初值。写死的话要么下面空一大截、要么内容被切掉。
 * 量完再把窗口调到刚好。
 */
async function fit() {
  await nextTick()
  // 24 = 四周留给阴影的透明边(下面那层 p-3)上下各一份。
  // 这个数在 src-tauri/src/tray.rs 的 MENU_PADDING 也有一份,定位要用,改就一起改。
  const h = Math.ceil((card.value?.getBoundingClientRect().height ?? 0) + 24)
  if (h <= 24) return
  try {
    await win.setSize(new LogicalSize(WIDTH, h))
    // 窗口是左上角定位的:高度一改下边缘就跑了,得按新高度重新贴一次
    await invoke('anchor_tray_menu')
  } catch { /* 改不了尺寸就维持原样,总比整个菜单不出来强 */ }
}

async function readPet() {
  try {
    await store.init()
    petOn.value = (await store.get<boolean>('key_visualizer_enabled')) ?? false
  } catch { petOn.value = false }
}

/**
 * 开关键盘桌宠。
 *
 * ⚠️ 这段逻辑在 views/KeyboardPet.vue 里还有一份 —— 那边是设置页的开关。
 * 两处都要保证「窗口状态」和「store 里的 key_visualizer_enabled」一起变,
 * 只改一个的话下次开机恢复会和眼前看到的对不上。以后应该抽成 composable。
 */
async function togglePet() {
  try {
    let w = await WebviewWindow.getByLabel('key_visualizer')
    if (!w) {
      w = new WebviewWindow('key_visualizer', {
        url: 'index.html', title: 'key_visualizer',
        width: 270, height: 300,
        decorations: false, shadow: false, transparent: true,
        alwaysOnTop: true, skipTaskbar: true, resizable: false, visible: true,
      })
      petOn.value = true
    } else if (petOn.value) {
      await w.hide()
      petOn.value = false
    } else {
      await w.show()
      petOn.value = true
    }
    await emit('toggle-key-visualizer-edit', false)
    await store.set('key_visualizer_enabled', petOn.value)
    await store.save()
  } catch (e) {
    console.error('[tray] 切换桌宠失败', e)
  }
  await invoke('hide_tray_menu')
}

onMounted(async () => {
  document.body.classList.add('tray-window')
  try {
    await loadSettings()
    applyTheme()
    watchSystemTheme()   // 「跟随系统」时,系统切深浅色要跟着变
    /*
      **不要给这扇窗上 DWM 圆角。** 试过,结果是菜单外面多出一圈框:
      DWM 裁圆角的同时会给窗口画一道边框,透明窗口上它就显出来了。
      而且这扇窗是**故意比卡片大一圈**的(p-3 那 12px 留给阴影),
      裁窗口对贴在里面的卡片毫无用处,只会多一道边框、还可能切掉阴影。
      圆角由卡片自己的 rounded-xl 画就够了 —— 它没上系统材质,不存在
      「材质盖不住圆角」那个问题(那是命令面板才需要处理的)。
    */
  } catch { /* 读不到设置就用默认主题,不能因此不弹菜单 */ }
  await readPet()
  fit()
  // 这扇窗在应用启动时就建好了(藏着),里面的状态到用户点开时早就旧了。
  // 每次被显示出来(拿到焦点)重读一次。
  win.onFocusChanged(({ payload }) => {
    if (payload) {
      // **必须重读存储**:这扇窗是独立 webview,自己那份 settings 停在启动那一刻,
      // 只调 applyTheme 是拿旧值重算,主界面里改的主题传不过来。
      void reloadSettings().then(() => { applyTheme(); return readPet() }).then(fit)
    }
  })
})
</script>

<template>
  <!-- 窗口是透明的,圆角和阴影由这一层画;p-3 那圈留白就是给阴影的 -->
  <div class="w-screen p-3 select-none">
    <div ref="card"
      class="rounded-xl bg-popover text-popover-foreground shadow-2xl border border-border/60
             p-1.5 flex flex-col gap-0.5 overflow-hidden">
      <button class="flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[13px] text-left transition-colors hover:bg-muted/60" @click="invoke('tray_show_main')">
        <span class="icon-[lucide--panel-top] size-3.5 shrink-0 opacity-70" />
        {{ t('tray.openMain') }}
      </button>
      <button class="flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[13px] text-left transition-colors hover:bg-muted/60" @click="invoke('tray_open_palette')">
        <span class="icon-[lucide--search] size-3.5 shrink-0 opacity-70" />
        {{ t('tray.palette') }}
      </button>

      <div class="h-px bg-border/60 my-1 mx-1.5" />

      <button class="flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[13px] text-left transition-colors hover:bg-muted/60" @click="invoke('tray_screenshot')">
        <span class="icon-[lucide--focus] size-3.5 shrink-0 opacity-70" />
        {{ t('tray.screenshot') }}
      </button>
      <button class="flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[13px] text-left transition-colors hover:bg-muted/60" @click="invoke('tray_toggle_dock')">
        <span class="icon-[lucide--layout-grid] size-3.5 shrink-0 opacity-70" />
        {{ t('tray.dock') }}
      </button>
      <button class="flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[13px] text-left transition-colors hover:bg-muted/60" @click="togglePet">
        <span class="icon-[lucide--keyboard] size-3.5 shrink-0 opacity-70" />
        <span class="flex-1">{{ t('tray.pet') }}</span>
        <!-- 有状态的项给个勾,不是靠文案说「开启/关闭」—— 那样每次都得读一遍才知道现在是哪种 -->
        <span class="icon-[lucide--check] size-3.5 shrink-0 transition-opacity"
          :class="petOn ? 'opacity-100' : 'opacity-0'" />
      </button>

      <div class="h-px bg-border/60 my-1 mx-1.5" />

      <button class="flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[13px] text-left transition-colors hover:bg-muted/60" @click="invoke('tray_force_close_overlays')">
        <span class="icon-[lucide--layers-2] size-3.5 shrink-0 opacity-70" />
        {{ t('tray.forceClose') }}
      </button>

      <div class="h-px bg-border/60 my-1 mx-1.5" />

      <button class="flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[13px] text-left transition-colors hover:bg-destructive/10 hover:text-destructive"
        @click="invoke('tray_quit')">
        <span class="icon-[lucide--log-out] size-3.5 shrink-0 opacity-70" />
        {{ t('tray.quit') }}
      </button>
    </div>
  </div>
</template>

