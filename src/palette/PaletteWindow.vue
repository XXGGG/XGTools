<script setup lang="ts">
/**
 * 命令面板。独立的无边框透明窗口,全局快捷键唤起。
 *
 * 形态照 Raycast:一开始只有一行输入框,打字之后结果从下面长出来。
 * 所以窗口高度是跟着结果条数变的 —— 不能用一个固定的大窗口再让内容顶在上面,
 * 那样空白区域虽然透明但照样吃鼠标事件,会挡住底下的东西。
 *
 * 定位交给这里而不是 Rust:要落在**鼠标所在的那块屏幕**上,而且必须先摆好位置
 * 再 show,否则会在旧位置闪一帧。Rust 那边只负责 eval 一句 __togglePalette()。
 */
import { ref, computed, watch, onMounted, nextTick } from 'vue'
import {
  getCurrentWindow, cursorPosition, monitorFromPoint,
  PhysicalPosition, LogicalSize,
} from '@tauri-apps/api/window'
import { useI18n } from '@/i18n'
import { invoke } from '@tauri-apps/api/core'
import {
  settings, loadSettings, reloadSettings, disableSettingsPersist,
  applyTheme, watchSystemTheme, applyVibrancyVars,
  applyWindowEffect,
} from '@/composables/useAppSettings'
import {
  fuzzyScore, loadStatic, staticItems, searchNotes, searchSessions, searchFiles, runItem,
  type PaletteItem,
} from './paletteSources'

const { t } = useI18n()
const win = getCurrentWindow()

/* 版式常量。改这几个数要连着 setSize 的算式一起看。 */
const WIDTH = 720
const HEAD = 64          // 输入行的高度
const ROW = 52           // 每条结果
const MAX_ROWS = 7       // 超过这个数就滚动,不再往下长

const query = ref('')
const cursor = ref(0)
const dynamic = ref<PaletteItem[]>([])
const inputEl = ref<HTMLInputElement | null>(null)
const listEl = ref<HTMLElement | null>(null)
/** 系统材质是否生效。决定卡片用半透明(让磨砂桌面透上来)还是纯色 */
const material = ref(false)

/** 静态源在内存里过滤,动态源直接接在后面(它们已经是后端排好序的) */
const results = computed<PaletteItem[]>(() => {
  const q = query.value.trim()
  // 没输入就只有一行输入框。列一屏功能页看着像"塞满了东西",
  // 而这东西的意义就是敲字才出结果 —— 提示语已经写在 placeholder 里了。
  if (!q) return []
  const scored = staticItems()
    .map(i => ({ ...i, score: fuzzyScore(i.title, q) }))
    .filter(i => (i.score ?? 0) > 0)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 8)
  return [...scored, ...dynamic.value].slice(0, 30)
})

/* ────────── 窗口尺寸跟着结果条数变 ────────── */

/*
  窗口高度跟着结果条数走。

  **必须记住上次的高度。** setSize 是一次 IPC + 一次真实的窗口尺寸变更,
  而 results 每敲一个字都会重算 —— 每次都调的话,连着按退格会把窗口
  连续 resize 十几次,手感就是"输入发涩、删字尤其卡"。行数没变就不动它。
*/
let lastHeight = -1

async function fitWindow() {
  const rows = Math.min(results.value.length, MAX_ROWS)
  const h = HEAD + (rows ? rows * ROW + 8 : 0)
  if (h === lastHeight) return
  lastHeight = h
  try { await win.setSize(new LogicalSize(WIDTH, h)) } catch { lastHeight = -1 }
}
watch(results, () => {
  if (cursor.value >= results.value.length) cursor.value = 0
  void fitWindow()
})

/*
  外观跟主窗口走。四件事,少一件就出问题:

    · palette-window ── body 默认带 bg-background。不去掉的话,圆角卡片外面
                        会露出一个矩形底色(窗口本身是透明的)。
    · vibrancy       ── 开了材质时卡片走 body.vibrancy .bg-popover 那套半透明规则,
                        让 DWM 磨砂过的桌面透上来。
    · 系统材质        ── 云母/亚克力。**CSS 的 backdrop-filter 代替不了它** ——
                        那个只能模糊窗口**内部**的内容,而透明窗口背后是桌面,够不着。
    · DWM 圆角        ── 材质是 DWM 画在**整个窗口矩形**上的,不认 CSS 的 border-radius。
                        不裁窗口的话,圆角卡片外面会原样露出四个尖角的材质。
                        这就是「面板四个角是尖的」那个现象的成因。

  这一段坏了顶多是颜色不对,不能连累上面的入口。
*/
async function applyLook() {
  const on = settings.blurKind !== 'none'
  applyVibrancyVars()
  applyTheme()
  document.body.classList.toggle('vibrancy', on)
  material.value = on
  try {
    await applyWindowEffect(settings.blurKind, 'palette')
    // 关材质时也要裁:纯透明窗口配 DWM 圆角没坏处,而且切换材质时省一次判断
    await invoke('set_window_corners', { label: 'palette', round: true })
  } catch (e) {
    console.error('[palette] 上材质失败,退回纯色卡片', e)
    material.value = false
  }
}

/* ────────── 打开 / 关闭 ────────── */

/*
  **自己记开关状态,不要去问 win.isVisible()。**
  失焦时会自动 hide,那个 hide 是异步的;热键紧接着到达时 isVisible() 可能
  还返回 true,于是"切换"又切成了关闭 —— 现象是按一下没反应、要按两下才出来。
  顺带也省掉一次 IPC 往返,唤起更快。
*/
const open = ref(false)
let searchTimer = 0

async function openPalette() {
  open.value = true
  // 主界面里可能刚改过主题或材质。**必须先重读存储再重算** ——
  // 只调 applyLook 是拿内存里那份旧设置重算,等于什么都没变。
  void reloadSettings().then(applyLook)
  query.value = ''
  cursor.value = 0
  dynamic.value = []
  lastHeight = -1        // 上次关掉时窗口可能是长的,重开要重新收回一行
  // 应用列表可能在上次开面板之后变过(装了新软件、改了启动台),每次都重取。
  // 它读的是两个本地 json,几毫秒的事。
  await loadStatic(t)
  await place()
  await fitWindow()
  await win.show()
  await win.setFocus()
  await nextTick()
  inputEl.value?.focus()
}

async function closePalette() {
  if (!open.value) return          // 已经关了就别再 hide 一次
  open.value = false
  window.clearTimeout(searchTimer)
  await win.hide()
}

/** 摆到鼠标所在那块屏幕的上三分之一处 */
async function place() {
  try {
    const cur = await cursorPosition()
    const m = (await monitorFromPoint(cur.x, cur.y)) ?? null
    if (!m) return
    const scale = m.scaleFactor
    const x = m.position.x + Math.round((m.size.width - WIDTH * scale) / 2)
    const y = m.position.y + Math.round(m.size.height * 0.18)
    await win.setPosition(new PhysicalPosition(x, y))
  } catch { /* 拿不到显示器信息就用上次的位置,总比不弹好 */ }
}

/* ────────── 输入 ────────── */

watch(query, q => {
  window.clearTimeout(searchTimer)
  const s = q.trim()
  if (!s) { dynamic.value = []; return }
  // 防抖:笔记全文搜索要走磁盘,会话搜索要走边车,每敲一个字都发一次会明显卡
  searchTimer = window.setTimeout(async () => {
    // 三路并发。文件那一路在后端没就绪时(没装 Everything / Spotlight 被关)
    // 返回空数组,不会拖慢也不会报错。
    const [files, notes, sessions] = await Promise.all([
      searchFiles(s), searchNotes(s), searchSessions(s),
    ])
    // 迟到的结果不能覆盖新查询 —— 几个请求返回顺序不保证
    if (query.value.trim() !== s) return
    dynamic.value = [...files, ...notes, ...sessions]
  }, 140)
})

/*
  拖动面板。判据和主窗口顶栏那套一样:按下的元素**光标是 default/auto**
  才拖窗口,是文字光标(输入框)或手型(结果行)就归它们自己。
  这样在输入框里选文字、点结果都不受影响,抓卡片的空白处就能挪。
*/
function onCardMouseDown(e: MouseEvent) {
  if (e.button !== 0) return
  const el = e.target as HTMLElement | null
  if (!el) return
  const c = getComputedStyle(el).cursor
  if (c !== 'default' && c !== 'auto') return
  e.preventDefault()
  win.startDragging()
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') { e.preventDefault(); void closePalette(); return }
  if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
    e.preventDefault(); move(1); return
  }
  if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
    e.preventDefault(); move(-1); return
  }
  if (e.key === 'Enter') { e.preventDefault(); void execute(); return }
}

function move(d: number) {
  const n = results.value.length
  if (!n) return
  cursor.value = (cursor.value + d + n) % n
  nextTick(() => {
    listEl.value?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView({ block: 'nearest' })
  })
}

async function execute(item?: PaletteItem) {
  const target = item ?? results.value[cursor.value]
  if (!target) return
  // 先收面板再干活:启动应用或唤起主窗口都要几百毫秒,
  // 面板挂在最上层不收的话,新窗口会被它盖住一角。
  await closePalette()
  await runItem(target)
}

const kindLabel: Record<string, string> = {
  page: 'palette.kindPage', app: 'palette.kindApp',
  note: 'palette.kindNote', session: 'palette.kindSession',
  file: 'palette.kindFile',
}

onMounted(async () => {
  /*
    **入口函数必须第一个装上,不能排在任何 await 后面。**
    踩过一次:原来第一行是 await loadSettings(),而那时 palette 窗口还没写进
    capabilities,store 插件被拒直接抛异常 —— __togglePalette 压根没定义,
    于是按快捷键毫无反应,而且不报错、看不出哪里坏了。
    快捷键那边只 eval 这一句,其余全在前端做。
  */
  ;(window as any).__togglePalette = async () => {
    try {
      if (open.value) await closePalette()
      else await openPalette()
    } catch (e) {
      console.error('[palette] 唤起失败', e)
    }
  }

  disableSettingsPersist()   // 这扇窗只读设置,不回写(见 useAppSettings 的注释)
  document.body.classList.add('palette-window')
  try {
    await loadSettings()
    watchSystemTheme()   // 主题设成「跟随系统」时,系统切深浅色要跟着变
    await applyLook()
  } catch (e) {
    console.error('[palette] 读设置失败,用默认外观', e)
  }

  // 点到别处就收起来。面板是临时表面,不该赖在屏幕上。
  try {
    await win.onFocusChanged(({ payload }) => { if (!payload) void closePalette() })
    open.value = false
    await win.hide()
  } catch { /* 窗口还没就绪就算了 */ }
})
</script>

<template>
  <div class="h-screen w-screen overflow-hidden select-none">
    <!--
      backdrop-blur 写在卡片上而不是靠系统材质:CSS 的模糊**会被 border-radius
      裁切**,圆角才干净。系统材质是 DWM 画在整个窗口矩形上的,裁不了。
    -->
    <!--
      开了材质时:圆角用 8px 跟 DWM 裁出来的窗口圆角对齐(它固定就是这个值),
      不然卡片和窗口两个半径对不上,角上会露出一牙材质。底色也要半透明,
      让 DWM 磨砂过的桌面透上来。
      关了材质时:窗口纯透明,卡片自己做主 —— 用我们的 14px 和实色。
    -->
    <div @mousedown="onCardMouseDown"
      class="h-full w-full border border-border shadow-2xl flex flex-col overflow-hidden"
      :class="material ? 'rounded-lg bg-popover/70' : 'rounded-[14px] bg-popover'">
      <!-- 输入行。高度写死 HEAD(64),窗口高度的算式依赖它 -->
      <div class="h-16 shrink-0 flex items-center gap-3 px-4">
        <span class="icon-[lucide--search] w-5 h-5 shrink-0 text-muted-foreground" />
        <input ref="inputEl" v-model="query" @keydown="onKey" spellcheck="false"
          :placeholder="t('palette.placeholder')"
          class="flex-1 h-full bg-transparent text-[17px] text-foreground
                 placeholder:text-muted-foreground/60 focus:outline-none" />
        <kbd v-if="results.length" class="shrink-0 text-[11px] text-muted-foreground/70 font-mono">
          {{ t('palette.enterHint') }}
        </kbd>
      </div>

      <div v-if="results.length" ref="listEl"
        class="flex-1 min-h-0 overflow-y-auto border-t border-border py-1">
        <button v-for="(item, i) in results" :key="item.id"
          :data-active="i === cursor"
          @click="execute(item)" @mousemove="cursor = i"
          class="w-full h-13 px-4 flex items-center gap-3 text-left transition-colors"
          :class="i === cursor ? 'bg-muted' : ''">
          <img v-if="item.iconData" :src="item.iconData" alt=""
            class="w-6 h-6 shrink-0 object-contain" />
          <span v-else :class="item.icon || 'icon-[lucide--circle]'"
            class="w-5 h-5 shrink-0 text-muted-foreground" />
          <span class="min-w-0 flex-1">
            <span class="block text-[14px] truncate">{{ item.title }}</span>
            <span v-if="item.subtitle" class="block text-[11px] text-muted-foreground truncate">
              {{ item.subtitle }}
            </span>
          </span>
          <span class="shrink-0 text-[11px] text-muted-foreground/60">
            {{ t(kindLabel[item.kind]) }}
          </span>
        </button>
      </div>
    </div>
  </div>
</template>
