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
 *
 * # 翻译优先
 *
 * 面板里**回车默认是翻译**这句话,不是打开第一条结果 —— 想开结果就先按 ↓ 选中
 * 再回车(点鼠标也行)。这样翻译只要「唤起 → 打字 → 回车」三步,不用先切形态。
 * 另外两条路直接进翻译形态(只剩翻译,不列结果):
 *   · 输入 `/fy 正文`(也认 /tr、/翻译)
 *   · 翻译面板快捷键(设置页可配)—— 唤起就是翻译形态
 * 有译文时放大镜换成翻译图标,卡片边上一圈淡红微光。回车翻译,再回车把译文
 * 复制走并收起面板。
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
import { quickTranslate, type QuickTranslation } from '@/lib/quickTranslate'

const { t } = useI18n()
const win = getCurrentWindow()

/* 版式常量。改这几个数要连着 setSize 的算式一起看。 */
const WIDTH = 720
const HEAD = 64          // 输入行的高度
const ROW = 52           // 每条结果
const MAX_ROWS = 7       // 超过这个数就滚动,不再往下长
const TRANS_ROW = 84     // 译文那一格。两行正文 + 一行引擎信息

const query = ref('')
/** 选中的结果行。-1 = 没选:这时回车是翻译,按 ↓ 才进入结果 */
const cursor = ref(-1)
const dynamic = ref<PaletteItem[]>([])
const inputEl = ref<HTMLInputElement | null>(null)
const listEl = ref<HTMLElement | null>(null)
/** 系统材质是否生效。决定卡片用半透明(让磨砂桌面透上来)还是纯色 */
const material = ref(false)

/* ────────── 翻译形态 ────────── */

type Mode = 'search' | 'translate'
/** 快捷键唤起时定下的形态。'translate' 时整个输入都是待翻译的正文 */
const mode = ref<Mode>('search')
const translated = ref<QuickTranslation | null>(null)
const translating = ref(false)
const translateError = ref('')

/**
 * `/fy 正文` 这种前缀。前缀后面的才是正文;只打了前缀还没写正文也算进翻译形态。
 * 英文别名后面必须跟空格(不然 /try、/fyi 会被误认);中文的 `/翻译你好` 不用空格 ——
 * 中文输入习惯本来就不打词间空格,而且输入法常把空格吃掉。
 */
const PREFIX = /^\/(?:(?:fy|tr)(?:\s+|$)|翻译\s*)/i

/** 这一次要翻译的正文。null 表示当前不是翻译形态 */
const translateText = computed<string | null>(() => {
  const q = query.value.trim()
  if (mode.value === 'translate') return q
  const m = PREFIX.exec(q)
  return m ? q.slice(m[0].length).trim() : null
})
const inTranslate = computed(() => translateText.value !== null)
/** 这一刻回车会翻译的那句话:翻译形态是前缀后面的正文,平时就是整个输入 */
const textToTranslate = computed(() => translateText.value ?? query.value.trim())
/** 译文格要不要占位:翻译中、有结果、或者报错了 */
const hasTranslatePanel = computed(() =>
  translating.value || !!translated.value || !!translateError.value)
/** 图标和红光:进了翻译形态,或者已经翻出东西了 */
const translateLook = computed(() => inTranslate.value || hasTranslatePanel.value)

/** 静态源在内存里过滤,动态源直接接在后面(它们已经是后端排好序的) */
const results = computed<PaletteItem[]>(() => {
  if (inTranslate.value) return []
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
  // 译文格和结果列表可以同时在:译文在上,结果在下
  let h = HEAD
  if (hasTranslatePanel.value) h += TRANS_ROW + 8
  const rows = Math.min(results.value.length, MAX_ROWS)
  if (rows) h += rows * ROW + 8
  if (h === lastHeight) return
  lastHeight = h
  try { await win.setSize(new LogicalSize(WIDTH, h)) } catch { lastHeight = -1 }
  // 高度变了,该待的位置也变了(居中要按新高度算;有结果就抬上去)
  if (open.value) glideTo(targetY(h))
}
watch(results, () => {
  if (cursor.value >= results.value.length) cursor.value = -1
  void fitWindow()
})
watch(hasTranslatePanel, () => void fitWindow())

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

async function openPalette(kind: Mode = 'search') {
  open.value = true
  mode.value = kind
  // 主界面里可能刚改过主题或材质。**必须先重读存储再重算** ——
  // 只调 applyLook 是拿内存里那份旧设置重算,等于什么都没变。
  void reloadSettings().then(applyLook)
  query.value = ''
  cursor.value = -1
  dynamic.value = []
  translated.value = null
  translating.value = false
  translateError.value = ''
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

/*
  位置。

  **整块面板永远在屏幕正中**:刚唤起是一个输入框居中;搜出结果、译文格长出来,
  面板变高,就按新高度重新居中 —— 顶边缓缓上移给下面腾地方,把字删光了又
  缓缓滑回去。试过「有结果就抬到屏幕上部」,一输入就蹿得太高,不要。

  面板是独立的 OS 窗口,没法用 CSS transition,只能自己逐帧 setPosition。
  一次滑动 600ms、ease-out(先快后慢),三十几帧、三十几次 IPC,感觉不到开销。
*/
const GLIDE_MS = 600

/** 鼠标所在那块屏幕的几何,唤起时取一次,后面滑动都按它算(物理像素) */
let mon = { x: 0, y: 0, w: 1920, h: 1080, scale: 1 }
let winX = 0
let curY = 0
let glide = 0

/** 面板居中时该在的纵坐标。h 是窗口的逻辑高度 */
function targetY(h: number): number {
  return mon.y + Math.round((mon.h - h * mon.scale) / 2)
}

/** 缓缓滑到 y。中途目标变了就从当前位置接着滑,不会跳 */
function glideTo(y: number) {
  cancelAnimationFrame(glide)
  const from = curY
  const dist = y - from
  if (!dist) return
  const t0 = performance.now()
  const step = (now: number) => {
    const p = Math.min(1, (now - t0) / GLIDE_MS)
    const eased = 1 - Math.pow(1 - p, 3)          // ease-out cubic
    curY = Math.round(from + dist * eased)
    void win.setPosition(new PhysicalPosition(winX, curY))
    if (p < 1) glide = requestAnimationFrame(step)
  }
  glide = requestAnimationFrame(step)
}

/** 唤起时:记下屏幕几何,直接摆到正中(这一下不滑,滑的是之后的变化) */
async function place() {
  try {
    const cur = await cursorPosition()
    const m = (await monitorFromPoint(cur.x, cur.y)) ?? null
    if (!m) return
    mon = { x: m.position.x, y: m.position.y, w: m.size.width, h: m.size.height, scale: m.scaleFactor }
    winX = mon.x + Math.round((mon.w - WIDTH * mon.scale) / 2)
    cancelAnimationFrame(glide)
    curY = targetY(HEAD)
    await win.setPosition(new PhysicalPosition(winX, curY))
  } catch { /* 拿不到显示器信息就用上次的位置,总比不弹好 */ }
}

/* ────────── 输入 ────────── */

watch(query, q => {
  window.clearTimeout(searchTimer)
  // 正文一变,上一次的译文就作废 —— 不然回车会把旧译文当成「已经翻好」复制走;
  // 选中行也归零:新的一句话,回车又是翻译
  if (translated.value && translated.value.source !== textToTranslate.value) translated.value = null
  translateError.value = ''
  cursor.value = -1
  const s = q.trim()
  if (!s || inTranslate.value) { dynamic.value = []; return }
  /*
    防抖 + 起搜门槛。

    一个字的查询对全盘文件和笔记全文几乎只会命中一堆噪音,还要把整个库
    读一遍 —— 两个字起才去磁盘。间隔 260ms:比一次按键间隔长、比"停下来等"短,
    连着打一个词只会在最后发一次。
  */
  if (s.length < 2) { dynamic.value = []; return }
  searchTimer = window.setTimeout(() => {
    /*
      三路各自回来各自上,不等最慢的那个。以前 Promise.all 等三个一起 ——
      会话那路要问边车、文件那路要问系统索引,最慢的一个决定了整个列表
      什么时候出现;现在笔记先回来就先显示笔记。
      迟到的结果不能覆盖新查询:每一路回来都要核对一次输入还是不是这句。
    */
    const slots: { files?: PaletteItem[]; notes?: PaletteItem[]; sessions?: PaletteItem[] } = {}
    const flush = () => {
      if (query.value.trim() !== s) return
      dynamic.value = [...(slots.files ?? []), ...(slots.notes ?? []), ...(slots.sessions ?? [])]
    }
    searchFiles(s).then(r => { slots.files = r; flush() })
    searchNotes(s).then(r => { slots.notes = r; flush() })
    searchSessions(s).then(r => { slots.sessions = r; flush() })
  }, 260)
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
  if (e.key === 'Enter') {
    e.preventDefault()
    // 用 ↓ 选中了某条结果才是「打开它」;其余情况回车一律翻译
    if (!inTranslate.value && cursor.value >= 0 && results.value[cursor.value]) { void execute(); return }
    void runTranslate()
  }
}

/**
 * 回车两段式:第一下翻译,第二下(译文还是这句的)复制并收起。
 * 平时的搜索形态不切走:结果列表留在译文下面,想开哪条按 ↓ 就能选。
 */
async function runTranslate() {
  const text = textToTranslate.value
  if (!text) return
  if (translated.value && translated.value.source === text) {
    try { await navigator.clipboard.writeText(translated.value.text) } catch { /* 剪贴板被拒就只收面板 */ }
    await closePalette()
    return
  }
  translating.value = true
  translateError.value = ''
  translated.value = null
  try {
    const r = await quickTranslate(text)
    // 翻译期间又改了字,这份结果就是过期的
    if (textToTranslate.value === text) translated.value = r
  } catch (e) {
    translateError.value = String(e)
  } finally {
    translating.value = false
  }
}

/** 在「没选」和 n 条结果之间循环:-1 → 0 → … → n-1 → -1 */
function move(d: number) {
  const n = results.value.length
  if (!n) return
  const m = n + 1
  cursor.value = (((cursor.value + 1 + d) % m) + m) % m - 1
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

/** 输入行右边那个提示:告诉你此刻回车会干什么 */
const hint = computed(() => {
  if (!textToTranslate.value) return ''
  if (!inTranslate.value && cursor.value >= 0) return t('palette.enterHint')
  if (translated.value && translated.value.source === textToTranslate.value) return t('palette.enterCopy')
  return inTranslate.value || !results.value.length
    ? t('palette.enterTranslate')
    : t('palette.enterTranslateOrPick')
})

onMounted(async () => {
  /*
    **入口函数必须第一个装上,不能排在任何 await 后面。**
    踩过一次:原来第一行是 await loadSettings(),而那时 palette 窗口还没写进
    capabilities,store 插件被拒直接抛异常 —— __togglePalette 压根没定义,
    于是按快捷键毫无反应,而且不报错、看不出哪里坏了。
    快捷键那边只 eval 这一句,其余全在前端做。

    带参数 'translate' 就是翻译面板那个快捷键:面板开着且已经是翻译形态 → 收起;
    开着但是搜索形态 → 原地切成翻译;没开 → 以翻译形态打开。
  */
  ;(window as any).__togglePalette = async (kind?: string) => {
    const want: Mode = kind === 'translate' ? 'translate' : 'search'
    try {
      if (open.value && mode.value === want) await closePalette()
      else if (open.value) {
        mode.value = want
        translated.value = null
        translateError.value = ''
        await fitWindow()
        inputEl.value?.focus()
      } else await openPalette(want)
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

      翻译形态:边框换淡红,再加一圈淡红微光 —— 有道那种「翻译=红」的联想。
    -->
    <div @mousedown="onCardMouseDown"
      class="h-full w-full border shadow-2xl flex flex-col overflow-hidden transition-[border-color,box-shadow] duration-200"
      :class="[
        material ? 'rounded-lg bg-popover/70' : 'rounded-[14px] bg-popover',
        translateLook ? 'border-red-400/40 shadow-[0_0_28px_rgba(248,113,113,0.22)]' : 'border-border',
      ]">
      <!-- 输入行。高度写死 HEAD(64),窗口高度的算式依赖它 -->
      <div class="h-16 shrink-0 flex items-center gap-3 px-4">
        <span class="w-5 h-5 shrink-0 transition-colors"
          :class="translateLook ? 'icon-[lucide--languages] text-red-400/90' : 'icon-[lucide--search] text-muted-foreground'" />
        <input ref="inputEl" v-model="query" @keydown="onKey" spellcheck="false"
          :placeholder="inTranslate ? t('palette.translatePlaceholder') : t('palette.placeholder')"
          class="flex-1 h-full bg-transparent text-[17px] text-foreground
                 placeholder:text-muted-foreground/60 focus:outline-none" />
        <kbd v-if="hint" class="shrink-0 text-[13px] text-muted-foreground font-mono whitespace-nowrap">
          {{ hint }}
        </kbd>
      </div>

      <!-- 译文格 -->
      <div v-if="hasTranslatePanel" class="shrink-0 border-t border-border px-4 py-3 flex flex-col justify-center"
        :style="{ height: TRANS_ROW + 'px' }">
        <p v-if="translating" class="flex items-center gap-2 text-sm text-muted-foreground">
          <span class="icon-[lucide--loader-2] w-4 h-4 animate-spin" />{{ t('palette.translating') }}
        </p>
        <p v-else-if="translateError" class="text-sm text-red-400 line-clamp-2">
          {{ t('palette.translateFailed') }}：{{ translateError }}
        </p>
        <template v-else-if="translated">
          <p class="text-[15px] leading-snug whitespace-pre-wrap line-clamp-2 select-text cursor-text">
            {{ translated.text }}
          </p>
          <p class="mt-1 text-[11px] text-muted-foreground/70 font-mono">
            {{ translated.detected ?? 'auto' }} → {{ translated.target }} · {{ translated.engine }}
          </p>
        </template>
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
