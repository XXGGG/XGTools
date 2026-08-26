<script setup lang="ts">
/**
 * 笔记页 —— 左边文件树、中间编辑器、右边智能体。
 *
 * 三栏各自能收:文件树可以拖宽,右边那栏可以整个收起来 ——
 * 没配 DSH 的人不该被一个用不了的面板占掉三分之一屏幕。
 *
 * 版式和智能体页一致:四边外缩一律 10px,左边给导航栏让出 4.875rem(78px)。
 */
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick, useTemplateRef } from 'vue'
import { useI18n } from '@/i18n'
import {
  vault, hasVault, activeTab, dirtyPaths, dotColor, displayName,
  restoreVault, pickVault, toggleDir, collapseAll, expandAll, setSort,
  openFile, closeTab, saveActive, createEntry, createWithContent, clearVault,
  renameEntry, deleteEntry, moveEntry, revealEntry, copyPath,
  search, type Entry,
} from '@/composables/useVault'
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger,
  ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger, ContextMenuPortal,
} from '@/components/ui/context-menu'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

/*
  空状态那个粒子 Logo 用的图标路径。和 assets/icons/obsidian.svg 是同一份 ——
  那边是界面上的小图标(走 CSS 遮罩),这里要的是给 canvas 采样的原始路径,
  两种用法拿不到对方的数据,所以各存一份。改图标要改两处。
  视框 48、描边 4,和那个 svg 文件一致。
*/
const OBSIDIAN_PATHS = [
  'M17.133 40.912c3.155-6.394 3.071-10.982 1.722-14.24c-1.229-3.014-3.527-4.913-5.333-6.095a2.3 2.3 0 0 1-.167.503L9.11 30.526c-.44.975-.237 2.12.512 2.885l6.784 6.98c.214.213.466.39.726.52Zm8.581-12.973c.847.083 1.675.27 2.494.567c2.587.968 4.942 3.146 6.887 7.343c.14-.242.279-.474.428-.698a114 114 0 0 0 3.415-5.388a1.3 1.3 0 0 0-.093-1.461a28.2 28.2 0 0 1-3.322-5.445c-.894-2.14-1.024-5.481-1.033-7.1c0-.615-.196-1.22-.577-1.704l-6.747-8.561l-.112-.14c.493 1.629.465 2.931.158 4.113c-.28 1.099-.8 2.094-1.35 3.146c-.185.354-.372.717-.548 1.089a13 13 0 0 0-1.47 5.398c-.094 2.252.362 5.072 1.86 8.84z',
  'M25.704 27.939c-1.498-3.77-1.954-6.59-1.86-8.841c.092-2.234.744-3.91 1.47-5.398l.558-1.09c.54-1.05 1.052-2.047 1.34-3.145a7.3 7.3 0 0 0-.158-4.113a2.606 2.606 0 0 0-3.667-.186l-8.022 7.212c-.45.403-.746.949-.838 1.545L13.55 20.4c0 .065-.019.121-.028.186c1.806 1.173 4.095 3.072 5.333 6.078c.242.595.447 1.219.595 1.898a18.6 18.6 0 0 1 6.254-.633z',
  'M29.91 43.406c1.732.475 3.472-.912 3.714-2.699c.198-1.695.7-3.34 1.48-4.858c-1.954-4.197-4.309-6.375-6.887-7.343c-2.745-1.023-5.733-.68-8.767.056c.68 3.08.28 7.11-2.308 12.35c.289.149.615.232.94.26l4.086.307c2.215.159 5.519 1.303 7.743 1.927Z',
]

/** 新建文件时的初始内容。空文件在 Obsidian 里打不开(画布会报错、数据库是空白) */
const CANVAS_TEMPLATE = `---

excalidraw-plugin: parsed
tags: [excalidraw]

---
==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠==

# Excalidraw Data

## Text Elements
%%
## Drawing
\`\`\`json
{"type":"excalidraw","version":2,"source":"XGTools","elements":[],"appState":{"gridSize":null,"viewBackgroundColor":"#ffffff"},"files":{}}
\`\`\`
%%`

const BASE_TEMPLATE = `views:
  - type: table
    name: 表格
`

import { settings, VAULT_FONT_SIZE, VAULT_FONTS, VAULT_FONT_STACK } from '@/composables/useAppSettings'
import ParticleLogo from '@/components/ParticleLogo.vue'
import MarkdownEditor from '@/components/MarkdownEditor.vue'
import { invoke } from '@tauri-apps/api/core'
import { open as openExternal } from '@tauri-apps/plugin-shell'
import { chat, chatReady, sendPrompt, respondPending } from '@/composables/useDshChat'

const { t } = useI18n()

onMounted(restoreVault)

// ── 三栏宽度 ──
const rootEl = ref<HTMLElement | null>(null)
const dragging = ref<'tree' | 'chat' | null>(null)

function startDrag(which: 'tree' | 'chat', e: PointerEvent) {
  dragging.value = which
  const startX = e.clientX
  const startW = which === 'tree' ? settings.vaultTreeWidth : settings.vaultChatWidth
  const el = e.currentTarget as HTMLElement
  el.setPointerCapture(e.pointerId)
  const move = (ev: PointerEvent) => {
    // 右栏是从右往左量的,所以位移取反
    const delta = which === 'tree' ? ev.clientX - startX : startX - ev.clientX
    const total = rootEl.value?.clientWidth ?? 1200
    // 中间的编辑器至少留 420px —— 比这窄的话 markdown 根本没法读
    const max = Math.max(180, total - 420 - (which === 'tree' ? settings.vaultChatWidth : settings.vaultTreeWidth))
    const w = Math.round(Math.min(max, Math.max(180, startW + delta)))
    if (which === 'tree') settings.vaultTreeWidth = w
    else settings.vaultChatWidth = w
  }
  const up = (ev: PointerEvent) => {
    dragging.value = null
    el.releasePointerCapture(ev.pointerId)
    el.removeEventListener('pointermove', move)
    el.removeEventListener('pointerup', up)
  }
  el.addEventListener('pointermove', move)
  el.addEventListener('pointerup', up)
}

// ── 文件树 ──

/** 一层一层铺平成可渲染的行,带缩进层级 */
type Row = { entry: Entry; depth: number }
function flatten(dir: string, depth: number, out: Row[]) {
  for (const e of vault.children[dir] ?? []) {
    out.push({ entry: e, depth })
    if (e.isDir && vault.expanded.has(e.path)) flatten(e.path, depth + 1, out)
  }
}
const rows = computed<Row[]>(() => {
  const out: Row[] = []
  flatten('', 0, out)
  return out
})



// ── 新建 / 重命名 / 删除 ──

/** 新建的落点:选中的是目录就放它里面,是文件就放它旁边 */
const targetDir = computed(() => {
  const cur = vault.activeTab
  if (!cur) return ''
  return cur.includes('/') ? cur.slice(0, cur.lastIndexOf('/')) : ''
})

/**
 * 新建完直接进原地改名。
 *
 * 「未命名」这个名字对谁都没用,建完第一件事必然是改名 —— 与其让用户
 * 再去右键一次,不如建出来就把光标放进去。Obsidian 就是这个手感。
 */
async function created(rel: string | void) {
  if (!rel) return
  /*
    **先把它所在的那一层展开。**
    新建的位置是「当前文件所在的文件夹」,那个文件夹很可能是收着的 ——
    收着的话这一行根本没渲染出来,原地改名就静默失效了(建是建出来了,
    用户只看到编辑区空白一片,不知道东西去哪了)。
  */
  const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
  if (dir && !vault.expanded.has(dir)) await toggleDir(dir)
  await nextTick()
  await startInline(rel, rel.split('/').pop() ?? rel)
}

const newNote = async () => created(await createEntry(targetDir.value, false, t('vault.newNoteName')))
const newFolder = async () => created(await createEntry(targetDir.value, true, t('vault.newFolderName')))

// ── 原地重命名 ────────────────────────────────────────
//
// 树里改名走这一套(新建完自动进来);右上角更多菜单里的「重命名」还是弹窗。

/** 正在原地改名的那一项(相对路径),空串表示没有 */
const inlineEdit = ref('')
const inlineText = ref('')
const inlineInput = useTemplateRef<HTMLInputElement[] | HTMLInputElement>('inlineInput')
/** 防重入:回车提交之后紧接着还会来一次 blur,不挡的话会提交两遍 */
let committing = false

/*
  菜单收起时,Radix 默认把焦点还给触发它的那个行按钮。
  从菜单里进原地改名的话这就是灾难:焦点被抢走 → 输入框失焦 → 当场按"没改"提交,
  用户眼睁睁看着刚弹出来的框自己关掉。等一帧也没用,它比一帧还晚。
  所以进改名的时候直接把这次焦点归还挡掉 —— 焦点本来就该在输入框里。
*/
let keepFocus = false
function onMenuClose(e: Event) {
  if (!keepFocus) return
  keepFocus = false
  e.preventDefault()
}

async function startInline(path: string, name: string) {
  keepFocus = true
  inlineEdit.value = path
  inlineText.value = name
  await nextTick()
  const el = Array.isArray(inlineInput.value) ? inlineInput.value[0] : inlineInput.value
  if (!el) return
  /*
    **要等一帧再聚焦。**

    从右键菜单进来时,菜单关闭的那一下 Radix 会把焦点还给触发它的那个行按钮 ——
    那件事发生在我们之后,于是刚设好的选区被抹掉(输入框看着是亮的,
    里面却什么都没选中,用户一打字得先自己全选)。等到下一帧,菜单已经收完了。
  */
  requestAnimationFrame(() => {
    el.focus()
    // 只选中主干,扩展名留在后面不选 —— 改名基本都是改主干,
    // 全选中的话用户一打字就把 .md 一起覆盖掉了
    const stem = name.replace(/\.[^.]+$/, '')
    el.setSelectionRange(0, stem.length)
  })
}

function onInlineKey(e: KeyboardEvent) {
  if (e.key === 'Enter') { e.preventDefault(); void commitInline() }
  else if (e.key === 'Escape') { e.preventDefault(); cancelInline() }
}

function cancelInline() {
  keepFocus = false
  committing = true
  inlineEdit.value = ''
  inlineText.value = ''
  setTimeout(() => { committing = false }, 0)
}

async function commitInline() {
  if (committing) return
  const path = inlineEdit.value
  const name = inlineText.value.trim()
  if (!path) return
  keepFocus = false
  committing = true
  inlineEdit.value = ''
  const old = path.split('/').pop() ?? path
  // 没改、或者清空了,就当没发生过,不去打扰磁盘
  if (name && name !== old) await renameEntry(path, name)
  committing = false
}

const renameTarget = ref<Entry | null>(null)
const renameText = ref('')
function startRename(e: Entry) { renameTarget.value = e; renameText.value = e.name }
async function doRename() {
  const e = renameTarget.value
  if (!e || !renameText.value.trim()) return
  renameTarget.value = null
  await renameEntry(e.path, renameText.value.trim())
}

const deleteTarget = ref<Entry | null>(null)
async function doDelete() {
  const e = deleteTarget.value
  if (!e) return
  deleteTarget.value = null
  await deleteEntry(e.path)
}

// ── 编辑 ──

/**
 * 自动保存。
 * 笔记应用不该让人记着按 Ctrl+S —— 忘了就是丢内容。
 * 800ms 静默后落盘,期间标签页上有个小圆点表示还没存。
 */
let saveTimer: number | undefined
watch(() => activeTab.value?.content, () => {
  window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(saveActive, 800)
})

function onEditorKey(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault()
    window.clearTimeout(saveTimer)
    saveActive()
  }
}

// 切走页面前把没存的落盘,别指望防抖那 800ms 一定跑得完
onBeforeUnmount(() => { window.clearTimeout(saveTimer); saveActive() })

/** 有任何目录展开着,按钮就显示「折叠」 */
const anyExpanded = computed(() => vault.expanded.size > 0)
const toggleAll = () => (anyExpanded.value ? collapseAll() : expandAll())

/**
 * 全局快捷键。绑在 window 上而不是编辑器上 —— Ctrl+W 在焦点落在
 * 文件树或标签条上时也该管用。
 */
function onGlobalKey(e: KeyboardEvent) {
  if (!(e.ctrlKey || e.metaKey)) return
  const k = e.key.toLowerCase()
  if (k === 'w' && vault.activeTab) {
    e.preventDefault()
    closeTab(vault.activeTab)
  } else if (k === 's') {
    e.preventDefault()
    window.clearTimeout(saveTimer)
    saveActive()
  }
}
onMounted(() => window.addEventListener('keydown', onGlobalKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onGlobalKey))

// ── 正文编辑 ──
//
// 编辑器本体在 components/MarkdownEditor.vue(CodeMirror 6 + 实时渲染装饰)。
// 这里只负责把它需要的东西喂进去:内容、字体字号行宽、以及下面这两个回调。
// ── 正文右键菜单 ──────────────────────────────────────

const editor = useTemplateRef<InstanceType<typeof MarkdownEditor>>('editor')
/** 菜单模板里到处要用,起个短名字 */
const ed = computed(() => editor.value)

/**
 * 右键那一刻选中的文字。
 *
 * 要在菜单打开的瞬间抓下来存着:菜单一旦获得焦点,编辑器的选区就不再是「当前选区」,
 * 等用户点到菜单项时再去读已经晚了。
 */
const selText = ref('')
function onCtxOpen(open: boolean) {
  if (open) selText.value = editor.value?.selectedText() ?? ''
}

const TABLE_SNIPPET = '|  |  |\n| --- | --- |\n|  |  |'
const CALLOUT_SNIPPET = '> [!note]\n> '
const CODE_SNIPPET = '```\n\n```'
const MATH_SNIPPET = '$$\n\n$$'

/** 拿选中的词去搜整个库 —— 和 Obsidian 那条「查找 "xxx"」一样 */
function searchSelection() {
  if (selText.value) search(selText.value)
}

// ── 目录栏拖放 ────────────────────────────────────────
//
// **不能用 HTML5 的 draggable/dragstart。**
//
// Tauri 的窗口默认开着系统级拖放(dragDropEnabled),那一层会把 webview 里的
// 拖拽事件整个吃掉 —— 页面内的 draggable 元素完全拖不动,而且不报错。
// 关掉它就能用,但格式转换页正靠 onDragDropEvent 接收从资源管理器拖进来的文件,
// 那个不能牺牲。
//
// 所以这里自己用指针事件做:按下记位置,移动超过阈值才算拖,
// 落点用 elementFromPoint 找行 —— 逻辑全在我们自己手里,和那个开关无关。

/** 正在被拖的那一项(相对路径)。空串表示没在拖 */
const dragPath = ref('')
/** 当前会落进去的目标目录;'__root__' 是库根 */
const dropTarget = ref('')
/** 拖着的那个小标签跟着光标走 */
const ghost = ref({ x: 0, y: 0, name: '' })
const treeBox = useTemplateRef<HTMLElement>('treeBox')

/** 按下之后要移动这么多像素才当成拖拽 —— 不给阈值的话手一抖点击就变成了拖动 */
const DRAG_THRESHOLD = 5

let pending: { path: string, name: string, x: number, y: number } | null = null
/** 这一轮真的拖过,松手时要把随后那次 click 吞掉(否则会顺手打开文件) */
let didDrag = false

function onRowDown(e: PointerEvent, entry: Entry) {
  if (e.button !== 0) return
  pending = { path: entry.path, name: entry.name, x: e.clientX, y: e.clientY }
  didDrag = false
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp, { once: true })
}

/** 光标底下那一行会落进哪个目录;返回 null 表示这里不能放 */
function dirUnder(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y)?.closest('[data-path]') as HTMLElement | null
  if (!el) {
    // 不在任何一行上:落在树的空白处才算「移回库根」,落在树外面不算
    const box = treeBox.value?.getBoundingClientRect()
    if (!box || x < box.left || x > box.right || y < box.top || y > box.bottom) return null
    return ''
  }
  const path = el.dataset.path ?? ''
  const isDir = el.dataset.dir === '1'
  const src = dragPath.value
  // 放到自己身上、放进自己的子孙里都不行(后者会把整棵子树搬进正在移动的目录)
  if (path === src || path.startsWith(src + '/')) return null
  return isDir ? path : path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
}

function onPointerMove(e: PointerEvent) {
  if (!pending) return
  if (!dragPath.value) {
    if (Math.hypot(e.clientX - pending.x, e.clientY - pending.y) < DRAG_THRESHOLD) return
    dragPath.value = pending.path
    ghost.value.name = displayName(pending.name)
    didDrag = true
  }
  ghost.value.x = e.clientX
  ghost.value.y = e.clientY
  const dir = dirUnder(e.clientX, e.clientY)
  const from = dragPath.value.includes('/')
    ? dragPath.value.slice(0, dragPath.value.lastIndexOf('/')) : ''
  // 拖回原来那一层不给高亮 —— 松手也什么都不会发生,先别给用户错误的期待
  dropTarget.value = dir === null || dir === from ? '' : dir === '' ? '__root__' : dir
}

async function onPointerUp(e: PointerEvent) {
  window.removeEventListener('pointermove', onPointerMove)
  const src = dragPath.value
  const target = dropTarget.value
  pending = null
  dragPath.value = ''
  dropTarget.value = ''
  if (!src || !target) return
  const dir = target === '__root__' ? '' : target
  await moveEntry(src, dir)
  // 放进一个关着的文件夹,展开给用户看一眼东西去哪了
  if (dir && !vault.expanded.has(dir)) await toggleDir(dir)
  void e
}

/** 拖完那一下的 click 要吞掉,不然松手顺手就把文件打开了 */
function onRowClick(entry: Entry) {
  if (didDrag) {
    didDrag = false
    return
  }
  if (entry.isDir) toggleDir(entry.path)
  else openFile(entry.path)
}

/** [[双链]] 的候选。走 vault_search —— 它连文件名一起匹配,能搜到整个库 */
async function wikiSuggest(q: string) {
  if (!vault.root || !q.trim()) return []
  try {
    type Hit = { path: string; name: string }
    const hits = await invoke<Hit[]>('vault_search', { root: vault.root, query: q, limit: 12 })
    const seen = new Set<string>()
    return hits
      .filter((h: Hit) => !seen.has(h.path) && seen.add(h.path))
      .map((h: Hit) => ({ target: displayName(h.name), label: displayName(h.name), detail: h.path }))
  } catch {
    return []
  }
}

/** 点了 [[双链]]:在库里找同名文件开出来 */
async function openWiki(target: string) {
  if (!vault.root) return
  try {
    type Hit = { path: string; name: string }
    const hits = await invoke<Hit[]>('vault_search', { root: vault.root, query: target, limit: 20 })
    const hit = hits.find((h: Hit) => displayName(h.name).toLowerCase() === target.toLowerCase()) ?? hits[0]
    if (hit) await openFile(hit.path)
  } catch { /* 找不到就当没点 */ }
}

const chatOpen = computed({
  get: () => settings.vaultChatOpen,
  set: (v: boolean) => { settings.vaultChatOpen = v },
})

const treeOpen = computed({
  get: () => settings.vaultTreeOpen,
  set: (v: boolean) => { settings.vaultTreeOpen = v },
})

/*
  前进后退。

  记的是**打开过哪些文件的顺序**,不是浏览器那种页面历史 —— 用户在这里的
  「后退」意思是「回到刚才看的那篇」。所以从历史里跳转时不能再往历史里追加,
  否则一来一回就把自己锁死在两条记录之间。navigating 就是干这个的。
*/
const history = ref<string[]>([])
const histAt = ref(-1)
let navigating = false

watch(activeTab, (t) => {
  if (!t || navigating) return
  if (history.value[histAt.value] === t.path) return
  history.value = history.value.slice(0, histAt.value + 1)
  history.value.push(t.path)
  histAt.value = history.value.length - 1
})

const canBack = computed(() => histAt.value > 0)
const canForward = computed(() => histAt.value < history.value.length - 1)

async function go(step: number) {
  const i = histAt.value + step
  if (i < 0 || i >= history.value.length) return
  histAt.value = i
  navigating = true
  await openFile(history.value[i])
  navigating = false
}

/** 面包屑:路径切成段。最后一段是文件名,去掉后缀 */
const crumbs = computed(() => {
  const p = activeTab.value?.path
  if (!p) return [] as string[]
  const parts = p.split('/')
  return parts.map((x, i) => (i === parts.length - 1 ? displayName(x) : x))
})

const moreOpen = ref(false)

/** 当前标签对应的树条目形状 —— 重命名和删除那两个函数吃的是 Entry */
const tabEntry = computed(() => {
  const t = activeTab.value
  if (!t) return null
  const dot = t.name.lastIndexOf('.')
  // size / modified 补 0:重命名和删除都用不到它们,但 Entry 的类型要求有
  return {
    path: t.path, name: t.name, isDir: false,
    ext: dot > 0 ? t.name.slice(dot + 1) : '', size: 0, modified: 0,
  }
})

/** 点了就该收起菜单。字体和全宽那几项例外 —— 它们要能连着点着看效果 */
function menu(fn: () => void) {
  moreOpen.value = false
  fn()
}

/*
  每篇笔记可以单独覆盖宽度,没覆盖就跟随设置页里那个全局默认。

  覆盖记在我们自己的设置里(按文件相对路径),**不写进笔记的 frontmatter** ——
  那等于改动用户的文件,和「打开不重写」这条原则冲突。
*/
const pageWidth = computed(() => settings.vaultPageWidth[activeTab.value?.path ?? ''] ?? null)

const effectiveFullWidth = computed(() => {
  const o = pageWidth.value
  return o === 'wide' ? true : o === 'narrow' ? false : settings.vaultFullWidth
})

function setPageWidth(v: 'wide' | 'narrow' | null) {
  const path = activeTab.value?.path
  if (!path) return
  if (v === null) delete settings.vaultPageWidth[path]
  else settings.vaultPageWidth[path] = v
}

/** 字号步进。夹在 VAULT_FONT_SIZE 的上下限里 —— 两头都不可用 */
function stepFont(d: number) {
  settings.vaultFontSize = Math.min(VAULT_FONT_SIZE.max,
    Math.max(VAULT_FONT_SIZE.min, settings.vaultFontSize + d * VAULT_FONT_SIZE.step))
}

/** 移除工作区的确认。不动磁盘上的文件,但会清掉标签,所以还是问一句 */
const confirmClear = ref(false)

function doClearVault() {
  confirmClear.value = false
  clearVault()
}

/** 在某个文件夹里新建。建完展开它,不然新东西藏在收起的文件夹里看不见 */
async function newIn(dir: string, isDir: boolean) {
  await created(await createEntry(dir, isDir, isDir ? t('vault.newFolderName') : t('vault.newNoteName')))
}

/** 空白处右键新建。都建在库根下 —— 右键的是空白,没有"当前目录"这个概念 */
async function newAt(kind: 'note' | 'folder' | 'base' | 'canvas') {
  if (kind === 'note') return created(await createEntry('', false, t('vault.newNoteName')))
  if (kind === 'folder') return created(await createEntry('', true, t('vault.newFolderName')))
  if (kind === 'base') return created(await createWithContent('', t('vault.newBaseName'), BASE_TEMPLATE))
  return created(await createWithContent('', t('vault.newCanvasName'), CANVAS_TEMPLATE))
}

// ── 右侧智能体 ──
const chatInput = ref('')
const chatListEl = ref<HTMLElement | null>(null)

function onChatKey(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    sendFromVault()
  }
}

/**
 * 从笔记页发问。
 *
 * 会把当前打开的文件**路径**一起带上 —— 用户说「总结这份笔记」时,
 * 智能体得知道指的是哪一份。给路径而不是全文:它自己有 read 工具,
 * 让它按需读比我们把几千字塞进提示词划算,也不会撑爆上下文。
 */
async function sendFromVault() {
  const text = chatInput.value.trim()
  if (!text) return
  chatInput.value = ''
  const t = activeTab.value
  // 路径用 / 拼即可 —— DSH 的 fs 工具在 Windows 上也认正斜杠,
  // 而拼反斜杠反而要在模板字符串里做一层转义,容易出错
  const prefixed = t ? `[当前笔记] ${vault.root}/${t.path}\n\n${text}` : text
  await sendPrompt(prefixed)
  await nextTick()
  const el = chatListEl.value
  if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
}
</script>

<template>
  <!--
    对齐网格。**只有两个数:58 和 10。**

    58 = 浮空卡片的厚度 = 图标格 44 + 卡片内边距 6×2 + 边框 1×2
         (算式在 App.vue 的侧栏注释里)。横竖都用它。
    10 = 所有间距,包括四边外缩。

      横:10 │ 导航栏 58 │ 10 │ 文件树 … │ 10 │ 编辑器 … │ 10 │ 智能体 … │ 10
      纵:10 │ 顶部卡片 58 │ 10 │ 主卡片 一直到 bottom-10

    → 页面左让位 pl-[4.875rem] = 10 + 58 + 10 = 78
    → 主卡片上边线 y = 10 + 58 + 10 = 78,和 App.vue 的 `top-[4.875rem]` 同一条线

    以前列宽是 72、卡片 58 居中,左右各留 7px,于是左边/上边实际留白 17
    而右边/下边只有 10,四边不等。那 7px 已经去掉,别再加回来。
  -->
  <div ref="rootEl" class="absolute inset-0 pt-2.5 pl-[4.875rem] pr-2.5 pb-2.5 flex"
    :class="dragging ? 'select-none' : ''">

    <!-- ═══════ 没选工作区 ═══════ -->
    <div v-if="!hasVault" class="flex-1 float-card rounded-[14px] border bg-card flex items-center justify-center">
      <div class="max-w-sm text-center px-6">
        <span class="icon-[lucide--folder-open] w-10 h-10 mx-auto block text-muted-foreground/60" />
        <p class="mt-5 text-[15px] leading-relaxed">{{ t('vault.pickHint') }}</p>
        <button @click="pickVault"
          class="mt-5 h-10 px-5 rounded-xl bg-primary text-primary-foreground text-sm font-medium">
          {{ t('vault.pickFolder') }}
        </button>
        <p v-if="vault.error" class="mt-4 text-xs text-red-500 wrap-break-word">{{ vault.error }}</p>
      </div>
    </div>

    <template v-else>
      <!-- ═══════ 文件树 ═══════ -->
      <div v-if="treeOpen" class="shrink-0 flex flex-col gap-2.5" :style="{ width: settings.vaultTreeWidth + 'px' }">

        <!-- 卡片直接贴在 y=10,不再套一层更高的行 -->
        <div class="float-card h-[58px] shrink-0 rounded-[14px] border bg-card flex items-center gap-1 px-3">
          <!-- 工作区这一组放最左边:它决定了下面所有东西是什么,和「新建」不是一类操作 -->
          <button @click="pickVault" :title="t('vault.changeFolder')" class="tool-btn">
            <span class="icon-[lucide--folder-open] w-4 h-4" />
          </button>
          <button @click="confirmClear = true" :title="t('vault.removeVault')" class="tool-btn">
            <span class="icon-[lucide--folder-x] w-4 h-4" />
          </button>
          <div class="w-px h-4 bg-border mx-1 shrink-0" />
          <button @click="newNote" :title="t('vault.newNote')" class="tool-btn">
            <span class="icon-[lucide--file-plus] w-4 h-4" />
          </button>
          <button @click="newFolder" :title="t('vault.newFolder')" class="tool-btn">
            <span class="icon-[lucide--folder-plus] w-4 h-4" />
          </button>
          <button @click="setSort(vault.sortKey === 'name' ? 'modified' : 'name')"
            :title="vault.sortKey === 'name' ? t('vault.sortByName') : t('vault.sortByTime')" class="tool-btn">
            <span class="icon-[lucide--arrow-down-up] w-4 h-4" />
          </button>
          <!-- 展开和折叠合成一个开关:两个按钮长得像又互斥,分开只会让人犹豫点哪个 -->
          <button @click="toggleAll" :title="anyExpanded ? t('vault.collapseAll') : t('vault.expandAll')" class="tool-btn">
            <span class="w-4 h-4"
              :class="anyExpanded ? 'icon-[lucide--chevrons-down-up]' : 'icon-[lucide--chevrons-up-down]'" />
          </button>
          <button @click="treeOpen = false" :title="t('vault.hideTree')" class="tool-btn ml-auto">
            <span class="icon-[lucide--panel-left-close] w-4 h-4" />
          </button>
        </div>

      <aside class="float-card flex-1 min-h-0 rounded-[14px] border bg-card flex flex-col overflow-hidden">
        <!-- 搜索 -->
        <div class="px-2 py-2">
          <div class="relative">
            <span class="icon-[lucide--search] w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input :value="vault.query" @input="search(($event.target as HTMLInputElement).value)"
              :placeholder="t('vault.search')"
              class="w-full h-9 pl-9 pr-2 rounded-lg bg-background/40 border border-border text-[15px]
                     placeholder:text-muted-foreground/60 focus:outline-none focus:border-foreground/25" />
          </div>
        </div>

        <!-- 搜索结果盖在树上面:找东西的时候不需要同时看见树 -->
        <div v-if="vault.query.trim()" class="flex-1 min-h-0 overflow-y-auto px-2 pb-2">
          <p v-if="!vault.hits.length" class="mt-4 text-center text-xs text-muted-foreground">
            {{ vault.searching ? '…' : t('vault.noHits') }}
          </p>
          <button v-for="h in vault.hits" :key="h.path + h.line" @click="openFile(h.path)"
            class="w-full text-left rounded-lg px-2 py-1.5 transition-colors hover:bg-muted/50">
            <div class="text-[13px] truncate">{{ displayName(h.name) }}</div>
            <div v-if="h.snippet" class="text-[11px] text-muted-foreground truncate">{{ h.snippet }}</div>
          </button>
        </div>

        <!-- 树 -->
        <!--
          整块树区域套一层右键菜单:右键落在**空白处**时新建到库根。
          落在某一行上时,那一行自己的 ContextMenu 会先接住(事件从内往外冒),
          所以两套菜单不会打架。
        -->
        <ContextMenu v-else>
          <ContextMenuTrigger as-child>
        <!-- 空白处也收:松在这儿就是移回库根 -->
        <div ref="treeBox" class="flex-1 min-h-0 overflow-y-auto px-1.5 pb-2"
          :style="{
            outline: dropTarget === '__root__' ? '2px solid ' + settings.vaultAccent : '',
            outlineOffset: '-2px', borderRadius: '6px',
          }">
          <ContextMenu v-for="r in rows" :key="r.entry.path">
            <ContextMenuTrigger as-child>
              <button @click="onRowClick(r.entry)"
                @pointerdown="onRowDown($event, r.entry)"
                :data-path="r.entry.path" :data-dir="r.entry.isDir ? '1' : ''"
                :style="{
                  paddingLeft: (r.depth * 14 + 8) + 'px',
                  outline: dropTarget === r.entry.path ? '2px solid ' + settings.vaultAccent : '',
                  outlineOffset: '-2px',
                }" :class="[
                  'w-full flex items-center gap-1.5 rounded-md py-1 pr-2 text-left transition-colors',
                  vault.activeTab === r.entry.path ? 'bg-muted' : 'hover:bg-muted/50',
                  dropTarget === r.entry.path ? 'bg-muted/70' : '',
                  dragPath === r.entry.path ? 'opacity-40' : ''
                ]">
                <!--
                  文件夹用开合两种图标,不用三角形 —— 一个图标同时说明「这是文件夹」
                  和「它开着还是关着」,比三角形 + 文件夹图标两个元素省地方。
                -->
                <span v-if="r.entry.isDir" class="w-4 h-4 shrink-0 text-muted-foreground"
                  :class="vault.expanded.has(r.entry.path) ? 'icon-[lucide--folder-open]' : 'icon-[lucide--folder]'" />
                <!-- 文件用彩色圆点前缀:按扩展名分色,窄侧栏里比一堆图标干净 -->
                <span v-else class="size-2 rounded-full shrink-0 ml-1 mr-0.5" :class="dotColor(r.entry.ext)" />

                <!--
                  重命名就在这一行原地改。新建完自动进这个状态,和 Obsidian 一样 ——
                  弹窗那套留给右上角更多菜单里的「重命名」(那时候用户不在树上,
                  原地改反而要先去树里把那一行找出来)。
                -->
                <input v-if="inlineEdit === r.entry.path" ref="inlineInput" v-model="inlineText"
                  @click.stop @pointerdown.stop @keydown.stop="onInlineKey($event)" @blur="commitInline"
                  :style="{ outline: '2px solid ' + settings.vaultAccent, outlineOffset: '1px' }"
                  class="flex-1 min-w-0 bg-transparent text-[15px] rounded-[3px] px-1 -mx-1" />
                <span v-else class="text-[15px] truncate">{{ displayName(r.entry.name) }}</span>
                <!-- 有未保存改动的文件标一个点 -->
                <span v-if="dirtyPaths.has(r.entry.path)" class="size-1.5 rounded-full bg-amber-500 shrink-0 ml-auto" />
              </button>
            </ContextMenuTrigger>

            <ContextMenuContent class="w-auto min-w-44 whitespace-nowrap"
              @close-auto-focus="onMenuClose">
              <ContextMenuItem v-if="r.entry.isDir" @select="newIn(r.entry.path, false)">
                <span class="icon-[lucide--file-plus] w-4 h-4 mr-2" />{{ t('vault.newNote') }}
              </ContextMenuItem>
              <ContextMenuItem v-if="r.entry.isDir" @select="newIn(r.entry.path, true)">
                <span class="icon-[lucide--folder-plus] w-4 h-4 mr-2" />{{ t('vault.newFolder') }}
              </ContextMenuItem>
              <ContextMenuSeparator v-if="r.entry.isDir" />
              <ContextMenuItem @select="copyPath(r.entry.path)">
                <span class="icon-[lucide--copy] w-4 h-4 mr-2" />{{ t('vault.copyPath') }}
              </ContextMenuItem>
              <ContextMenuItem @select="revealEntry(r.entry.path)">
                <span class="icon-[lucide--external-link] w-4 h-4 mr-2" />{{ t('vault.reveal') }}
              </ContextMenuItem>
              <ContextMenuSeparator />
              <!-- 树里的重命名走原地改名;弹窗那套只留给右上角更多菜单 -->
              <ContextMenuItem @select="startInline(r.entry.path, r.entry.name)">
                <span class="icon-[lucide--pencil] w-4 h-4 mr-2" />{{ t('vault.rename') }}
              </ContextMenuItem>
              <ContextMenuItem @select="deleteTarget = r.entry" class="text-destructive focus:text-destructive">
                <span class="icon-[lucide--trash-2] w-4 h-4 mr-2" />{{ t('vault.delete') }}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        </div>

          </ContextMenuTrigger>
          <ContextMenuContent class="w-auto min-w-44 whitespace-nowrap">
            <ContextMenuItem @select="newAt('note')">
              <span class="icon-[lucide--file-plus] w-4 h-4 mr-2" />{{ t('vault.newNote') }}
            </ContextMenuItem>
            <ContextMenuItem @select="newAt('folder')">
              <span class="icon-[lucide--folder-plus] w-4 h-4 mr-2" />{{ t('vault.newFolder') }}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem @select="newAt('base')">
              <span class="icon-[lucide--table] w-4 h-4 mr-2" />{{ t('vault.newBase') }}
            </ContextMenuItem>
            <ContextMenuItem @select="newAt('canvas')">
              <span class="icon-[lucide--pen-tool] w-4 h-4 mr-2" />{{ t('vault.newCanvas') }}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>

        <p v-if="vault.error" class="px-3 py-2 text-xs text-red-500 border-t border-border wrap-break-word">
          {{ vault.error }}
        </p>
      </aside>

      <!--
        跟着光标走的小标签。用 fixed + 坐标,不用 HTML5 那个拖影 ——
        我们本来就没用原生拖放,拖影也就无从谈起。
      -->
      <Teleport to="body">
        <div v-if="dragPath" :style="{ left: ghost.x + 12 + 'px', top: ghost.y + 12 + 'px' }"
          class="fixed z-50 pointer-events-none rounded-md border bg-popover px-2 py-1
                 text-[13px] shadow-lg">
          {{ ghost.name }}
        </div>
      </Teleport>
      </div>

      <div v-if="treeOpen" @pointerdown="startDrag('tree', $event)"
        class="w-2.5 shrink-0 cursor-col-resize flex items-center justify-center group">
        <!-- 常显,不是悬停才出现 —— 不然没人知道这两栏之间能拖 -->
        <div class="w-0.5 h-10 rounded-full bg-border transition-colors group-hover:bg-foreground/40"
          :class="dragging === 'tree' ? 'bg-foreground/60' : ''" />
      </div>

      <!-- ═══════ 编辑器列 ═══════ -->
      <div class="flex-1 min-w-0 flex flex-col gap-2.5">

        <!--
          标签卡:和工具卡同高(58),同一条基线。
          右边留出 pr-36 是给右上角那三颗窗口控制点让位 —— 它们浮在最上层,
          标签滚到那儿会被压住。
        -->
        <!--
          右边留出窗口控制点的位置:它们浮在最上层,标签滚到那儿会被压住。
          用外边距而不是内边距 —— 内边距只是把内容推开,卡片本身还是顶到最右,
          看着像"标签栏一直延伸到控件底下"。130 = 控件卡片宽 120 + 间隔 10。
          智能体栏开着的时候编辑器列本来就够不到右上角,那时候不用留。
        -->
        <div class="float-card h-[58px] shrink-0 rounded-[14px] border bg-card flex items-center gap-1 px-2 overflow-x-auto"
          :class="chatOpen ? '' : 'mr-[130px]'">
          <!-- 目录栏收起来之后,展开的入口挪到这里 —— 原来那个按钮跟着一起藏了 -->
          <button v-if="!treeOpen" @click="treeOpen = true" :title="t('vault.showTree')"
            class="tool-btn shrink-0 mr-1">
            <span class="icon-[lucide--panel-left-open] w-4 h-4" />
          </button>
          <!--
            关闭做成**独立的 button**,不是 button 里套 span:
            嵌在按钮里的元素,点击区会被父按钮吃掉 —— 表现就是「点 × 只切换了标签页」。
            两个按钮并排放在同一个容器里,各管各的点击。
          -->
          <div v-for="tb in vault.tabs" :key="tb.path" :class="[
            'group shrink-0 h-8 rounded-lg flex items-center transition-colors',
            vault.activeTab === tb.path ? 'bg-muted' : 'hover:bg-muted/50'
          ]">
            <button @click="vault.activeTab = tb.path"
              class="h-full pl-2.5 pr-1 flex items-center gap-1.5 text-[13px]"
              :class="vault.activeTab === tb.path ? '' : 'text-muted-foreground'">
              <span class="size-1.5 rounded-full shrink-0" :class="dotColor(tb.name.split('.').pop() ?? '')" />
              <span class="max-w-40 truncate">{{ displayName(tb.name) }}</span>
            </button>
            <button @click="closeTab(tb.path)" :title="t('vault.closeTab')"
              class="h-full pr-2 pl-0.5 flex items-center">
              <!-- 有未存改动时是黄点,鼠标移上来才变成 × —— 和编辑器的通用行为一致 -->
              <span v-if="tb.content !== tb.saved" class="size-1.5 rounded-full bg-amber-500 group-hover:hidden" />
              <span class="icon-[lucide--x] w-3.5 h-3.5 opacity-50 hover:opacity-100"
                :class="tb.content !== tb.saved ? 'hidden group-hover:inline-block' : ''" />
            </button>
          </div>
        </div>

        <section class="float-card flex-1 min-h-0 rounded-[14px] border bg-card flex flex-col overflow-hidden">
          <!--
            正文上面这一小行:左边前进后退,中间当前文件的路径,右边是智能体开关和更多。
            智能体那个开关原来是右下角一颗浮标 —— 挪上来之后所有跟"这篇文档"有关的
            操作都在同一行,不用满屏找。
          -->
          <div v-if="activeTab"
            class="h-9 shrink-0 mx-2 mt-2 flex items-center gap-1 px-1.5
                   rounded-lg border border-border bg-background/40">
            <button @click="go(-1)" :disabled="!canBack" :title="t('vault.back')"
              class="tool-btn size-7 disabled:opacity-30 disabled:pointer-events-none">
              <span class="icon-[lucide--arrow-left] w-4 h-4" />
            </button>
            <button @click="go(1)" :disabled="!canForward" :title="t('vault.forward')"
              class="tool-btn size-7 disabled:opacity-30 disabled:pointer-events-none">
              <span class="icon-[lucide--arrow-right] w-4 h-4" />
            </button>

            <div class="flex-1 min-w-0 flex items-center justify-center gap-1 text-[12px] text-muted-foreground">
              <template v-for="(c, i) in crumbs" :key="i">
                <span v-if="i" class="opacity-40">/</span>
                <span class="truncate" :class="i === crumbs.length - 1 ? 'text-foreground' : ''">{{ c }}</span>
              </template>
            </div>

            <button @click="chatOpen = !chatOpen"
              :title="chatOpen ? t('vault.hideAssistant') : t('vault.showAssistant')"
              class="tool-btn size-7" :class="chatOpen ? 'text-foreground' : ''">
              <span class="icon-[ri--deepseek-line] w-4 h-4" />
            </button>

            <Popover v-model:open="moreOpen">
              <PopoverTrigger as-child>
                <button :title="t('vault.more')" class="tool-btn size-7">
                  <span class="icon-[lucide--more-horizontal] w-4 h-4" />
                </button>
              </PopoverTrigger>
              <PopoverContent align="end" class="w-52 p-1.5">
                <button class="menu-row" @click="menu(() => startRename(tabEntry!))">
                  <span class="icon-[lucide--pencil] w-4 h-4" />{{ t('vault.rename') }}
                </button>
                <button class="menu-row" @click="menu(() => copyPath(activeTab!.path))">
                  <span class="icon-[lucide--copy] w-4 h-4" />{{ t('vault.copyPath') }}
                </button>
                <button class="menu-row" @click="menu(() => revealEntry(activeTab!.path))">
                  <span class="icon-[lucide--external-link] w-4 h-4" />{{ t('vault.reveal') }}
                </button>

                <div class="h-px bg-border my-1 mx-1" />
                <p class="px-2 py-1 text-[11px] text-muted-foreground">{{ t('vault.bodyFont') }}</p>
                <button v-for="f in VAULT_FONTS" :key="f" class="menu-row"
                  :style="{ fontFamily: VAULT_FONT_STACK[f] }" @click="settings.vaultFont = f">
                  <span class="icon-[lucide--check] w-4 h-4 shrink-0"
                    :class="settings.vaultFont === f ? '' : 'opacity-0'" />
                  {{ t('vault.font_' + f) }}
                </button>

                <div class="h-px bg-border my-1 mx-1" />
                <div class="flex items-center gap-2 px-2 py-1">
                  <span class="text-[11px] text-muted-foreground flex-1">{{ t('vault.fontSize') }}</span>
                  <button class="tool-btn size-6" :disabled="settings.vaultFontSize <= VAULT_FONT_SIZE.min"
                    @click="stepFont(-1)">
                    <span class="icon-[lucide--minus] w-3.5 h-3.5" />
                  </button>
                  <span class="w-6 text-center text-[12px] tabular-nums">{{ settings.vaultFontSize }}</span>
                  <button class="tool-btn size-6" :disabled="settings.vaultFontSize >= VAULT_FONT_SIZE.max"
                    @click="stepFont(1)">
                    <span class="icon-[lucide--plus] w-3.5 h-3.5" />
                  </button>
                </div>

                <div class="h-px bg-border my-1 mx-1" />
                <p class="px-2 py-1 text-[11px] text-muted-foreground">{{ t('vault.pageWidth') }}</p>
                <button class="menu-row" @click="setPageWidth(null)">
                  <span class="icon-[lucide--check] w-4 h-4" :class="pageWidth === null ? '' : 'opacity-0'" />
                  {{ t('vault.widthFollow') }}
                </button>
                <button class="menu-row" @click="setPageWidth('wide')">
                  <span class="icon-[lucide--check] w-4 h-4" :class="pageWidth === 'wide' ? '' : 'opacity-0'" />
                  {{ t('vault.widthWide') }}
                </button>
                <button class="menu-row" @click="setPageWidth('narrow')">
                  <span class="icon-[lucide--check] w-4 h-4" :class="pageWidth === 'narrow' ? '' : 'opacity-0'" />
                  {{ t('vault.widthNarrow') }}
                </button>

                <div class="h-px bg-border my-1 mx-1" />
                <button class="menu-row text-destructive" @click="menu(() => { deleteTarget = tabEntry })">
                  <span class="icon-[lucide--trash-2] w-4 h-4" />{{ t('vault.delete') }}
                </button>
              </PopoverContent>
            </Popover>
          </div>

        <!--
          没打开文件时给粒子 Logo,和首页同一个组件(只是换成 Obsidian 图标、不带字标)。
          原来是一行「从左边选一个文件」—— 一句废话占着整块空间,而且用户已经
          看得见左边有文件树了,不需要被告知。
        -->
        <div v-if="!activeTab" class="flex-1 flex items-center justify-center">
          <ParticleLogo :icon-paths="OBSIDIAN_PATHS" :icon-view-box="48"
            :icon-stroke-width="4" :icon-size="120" text="" :pad="80" :radius="110" />
        </div>

        <!--
          预览态点一下就进编辑,和 Obsidian 一个手感 —— 不用先去找「编辑」按钮。
          编辑态失焦回预览。
        -->
        <!--
          所见即所得的 Markdown 编辑器。收窄居中作用在编辑器容器上,
          Ctrl+S 挂在外层 —— CodeMirror 的按键事件会冒泡上来。
        -->
        <!-- 字体、字号、行宽都由编辑器内部的 CSS 变量驱动,这里只负责把值传进去 -->
        <ContextMenu v-else-if="activeTab.kind === 'markdown'" @update:open="onCtxOpen">
          <ContextMenuTrigger as-child>
            <div @keydown="onEditorKey" class="flex-1 min-h-0 overflow-hidden">
              <MarkdownEditor ref="editor" v-model="activeTab.content"
                :accent="settings.vaultAccent"
                :font="settings.vaultFont" :font-size="settings.vaultFontSize"
                :full-width="effectiveFullWidth"
                :on-open-link="(u: string) => { void openExternal(u) }"
                :wiki-suggest="wikiSuggest" :on-open-wiki="openWiki" />
            </div>
          </ContextMenuTrigger>

          <ContextMenuContent class="w-auto min-w-52 whitespace-nowrap">
            <ContextMenuItem @select="ed?.wrap('[[', ']]')">
              <span class="icon-[lucide--link] w-4 h-4 mr-2" />{{ t('vault.ctxWikiLink') }}
            </ContextMenuItem>
            <ContextMenuItem @select="ed?.wrap('[', '](https://)')">
              <span class="icon-[lucide--external-link] w-4 h-4 mr-2" />{{ t('vault.ctxExtLink') }}
            </ContextMenuItem>
            <!-- 有选中文字才给「查找」—— 没选中的话这条没有宾语 -->
            <ContextMenuItem v-if="selText" @select="searchSelection">
              <span class="icon-[lucide--search] w-4 h-4 mr-2" />
              {{ t('vault.ctxFind', { q: selText.length > 12 ? selText.slice(0, 12) + '…' : selText }) }}
            </ContextMenuItem>

            <ContextMenuSeparator />

            <ContextMenuSub>
              <ContextMenuSubTrigger>
                <span class="icon-[lucide--type] w-4 h-4 mr-2" />{{ t('vault.ctxFormat') }}
              </ContextMenuSubTrigger>
              <ContextMenuPortal>
                <ContextMenuSubContent class="w-auto min-w-36 whitespace-nowrap">
                  <ContextMenuItem @select="ed?.wrap('**')">
                    <span class="icon-[lucide--bold] w-4 h-4 mr-2" />{{ t('vault.fmtBold') }}
                  </ContextMenuItem>
                  <ContextMenuItem @select="ed?.wrap('*')">
                    <span class="icon-[lucide--italic] w-4 h-4 mr-2" />{{ t('vault.fmtItalic') }}
                  </ContextMenuItem>
                  <ContextMenuItem @select="ed?.wrap('~~')">
                    <span class="icon-[lucide--strikethrough] w-4 h-4 mr-2" />{{ t('vault.fmtStrike') }}
                  </ContextMenuItem>
                  <ContextMenuItem @select="ed?.wrap('==')">
                    <span class="icon-[lucide--highlighter] w-4 h-4 mr-2" />{{ t('vault.fmtHighlight') }}
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem @select="ed?.wrap('`')">
                    <span class="icon-[lucide--code] w-4 h-4 mr-2" />{{ t('vault.fmtCode') }}
                  </ContextMenuItem>
                  <ContextMenuItem @select="ed?.wrap('$')">
                    <span class="icon-[lucide--sigma] w-4 h-4 mr-2" />{{ t('vault.fmtMath') }}
                  </ContextMenuItem>
                  <ContextMenuItem @select="ed?.wrap('%%')">
                    <span class="icon-[lucide--message-square-off] w-4 h-4 mr-2" />{{ t('vault.fmtComment') }}
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem @select="ed?.clearFormat()">
                    <span class="icon-[lucide--eraser] w-4 h-4 mr-2" />{{ t('vault.fmtClear') }}
                  </ContextMenuItem>
                </ContextMenuSubContent>
              </ContextMenuPortal>
            </ContextMenuSub>

            <ContextMenuSub>
              <ContextMenuSubTrigger>
                <span class="icon-[lucide--pilcrow] w-4 h-4 mr-2" />{{ t('vault.ctxBlock') }}
              </ContextMenuSubTrigger>
              <ContextMenuPortal>
                <ContextMenuSubContent class="w-auto min-w-36 whitespace-nowrap">
                  <ContextMenuItem @select="ed?.setBlock('- ')">
                    <span class="icon-[lucide--list] w-4 h-4 mr-2" />{{ t('vault.blkBullet') }}
                  </ContextMenuItem>
                  <ContextMenuItem @select="ed?.setBlock('', true)">
                    <span class="icon-[lucide--list-ordered] w-4 h-4 mr-2" />{{ t('vault.blkOrdered') }}
                  </ContextMenuItem>
                  <ContextMenuItem @select="ed?.setBlock('- [ ] ')">
                    <span class="icon-[lucide--list-checks] w-4 h-4 mr-2" />{{ t('vault.blkTask') }}
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem v-for="h in 6" :key="h" @select="ed?.setBlock('#'.repeat(h) + ' ')">
                    <span class="w-4 h-4 mr-2 text-[11px] leading-4 text-center">H{{ h }}</span>
                    {{ t('vault.blkHeading', { n: h }) }}
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem @select="ed?.setBlock('')">
                    <span class="icon-[lucide--align-left] w-4 h-4 mr-2" />{{ t('vault.blkBody') }}
                  </ContextMenuItem>
                  <ContextMenuItem @select="ed?.setBlock('> ')">
                    <span class="icon-[lucide--quote] w-4 h-4 mr-2" />{{ t('vault.blkQuote') }}
                  </ContextMenuItem>
                </ContextMenuSubContent>
              </ContextMenuPortal>
            </ContextMenuSub>

            <ContextMenuSub>
              <ContextMenuSubTrigger>
                <span class="icon-[lucide--between-horizontal-start] w-4 h-4 mr-2" />{{ t('vault.ctxInsert') }}
              </ContextMenuSubTrigger>
              <ContextMenuPortal>
                <ContextMenuSubContent class="w-auto min-w-36 whitespace-nowrap">
                  <ContextMenuItem @select="ed?.insertBlock(TABLE_SNIPPET)">
                    <span class="icon-[lucide--table] w-4 h-4 mr-2" />{{ t('vault.insTable') }}
                  </ContextMenuItem>
                  <ContextMenuItem @select="ed?.insertBlock(CALLOUT_SNIPPET)">
                    <span class="icon-[lucide--message-square-quote] w-4 h-4 mr-2" />{{ t('vault.insCallout') }}
                  </ContextMenuItem>
                  <ContextMenuItem @select="ed?.insertBlock('---')">
                    <span class="icon-[lucide--minus] w-4 h-4 mr-2" />{{ t('vault.insRule') }}
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem @select="ed?.insertBlock(CODE_SNIPPET)">
                    <span class="icon-[lucide--code-xml] w-4 h-4 mr-2" />{{ t('vault.insCode') }}
                  </ContextMenuItem>
                  <ContextMenuItem @select="ed?.insertBlock(MATH_SNIPPET)">
                    <span class="icon-[lucide--sigma] w-4 h-4 mr-2" />{{ t('vault.insMath') }}
                  </ContextMenuItem>
                </ContextMenuSubContent>
              </ContextMenuPortal>
            </ContextMenuSub>

            <ContextMenuSeparator />

            <ContextMenuItem @select="ed?.clip(true)">
              <span class="icon-[lucide--scissors] w-4 h-4 mr-2" />{{ t('vault.ctxCut') }}
            </ContextMenuItem>
            <ContextMenuItem @select="ed?.clip()">
              <span class="icon-[lucide--copy] w-4 h-4 mr-2" />{{ t('vault.ctxCopy') }}
            </ContextMenuItem>
            <ContextMenuItem @select="ed?.paste()">
              <span class="icon-[lucide--clipboard] w-4 h-4 mr-2" />{{ t('vault.ctxPaste') }}
            </ContextMenuItem>
            <ContextMenuItem @select="ed?.paste(true)">
              <span class="icon-[lucide--clipboard-type] w-4 h-4 mr-2" />{{ t('vault.ctxPastePlain') }}
            </ContextMenuItem>
            <ContextMenuItem @select="ed?.selectAll()">
              <span class="icon-[lucide--text-select] w-4 h-4 mr-2" />{{ t('vault.ctxSelectAll') }}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>

        <!-- 画布和二进制文件还没做编辑器,如实说,别装作打开了 -->
        <div v-else class="flex-1 flex items-center justify-center px-6">
          <div class="text-center">
            <span class="icon-[lucide--file-question] w-8 h-8 mx-auto block text-muted-foreground/50" />
            <p class="mt-3 text-sm text-muted-foreground">{{ t('vault.notEditable') }}</p>
            <button @click="revealEntry(activeTab.path)" class="mt-3 text-xs text-muted-foreground underline">
              {{ t('vault.reveal') }}
            </button>
          </div>
        </div>
        </section>
      </div>

      <!-- ═══════ 智能体栏 ═══════ -->
      <template v-if="chatOpen">
        <div @pointerdown="startDrag('chat', $event)"
          class="w-2.5 shrink-0 cursor-col-resize flex items-center justify-center group">
          <div class="w-0.5 h-10 rounded-full bg-border transition-colors group-hover:bg-foreground/40"
            :class="dragging === 'chat' ? 'bg-foreground/60' : ''" />
        </div>
        <!--
          从 y=78 起,和左边两列的主卡片同一条上边线。
          外层已经有 pt-2.5(10),所以这里只需再让 68px(4.25rem)。
          那段空白正好把右上角三颗窗口控制点让出去,标题就不用再往下推,
          这一栏也不会显得比别的列高出一截。
        -->
        <aside :style="{ width: settings.vaultChatWidth + 'px', marginTop: '4.25rem' }"
          class="float-card shrink-0 rounded-[14px] border bg-card flex flex-col overflow-hidden">
          <div class="flex items-center gap-2 px-3 py-2.5 border-b border-border">
            <span class="icon-[ri--deepseek-line] w-4 h-4 text-muted-foreground" />
            <span class="text-[13px] mr-auto">{{ t('vault.assistant') }}</span>
            <button @click="chatOpen = false" :title="t('vault.hideAssistant')" class="tool-btn">
              <span class="icon-[lucide--panel-right-close] w-4 h-4" />
            </button>
          </div>
          <!-- 没连上 DSH 时如实说,别给一个发出去石沉大海的输入框 -->
          <div v-if="!chatReady" class="flex-1 flex items-center justify-center px-5 text-center">
            <p class="text-xs leading-relaxed text-muted-foreground">{{ t('vault.assistantNeedDsh') }}</p>
          </div>

          <template v-else>
            <div ref="chatListEl" class="flex-1 min-h-0 overflow-y-auto px-3 py-3 flex flex-col gap-3">
              <p v-if="!chat.items.length" class="text-xs text-center text-muted-foreground mt-6 leading-relaxed">
                {{ t('vault.assistantHint') }}
              </p>
              <div v-for="m in chat.items" :key="m.id">
                <div v-if="m.kind === 'user'" class="flex justify-end">
                  <div class="max-w-[90%] rounded-xl rounded-br-sm bg-muted px-3 py-1.5 text-[13px] leading-relaxed whitespace-pre-wrap wrap-break-word">
                    {{ m.text }}
                  </div>
                </div>
                <div v-else-if="m.kind === 'assistant'" class="text-[13px] leading-relaxed whitespace-pre-wrap wrap-break-word">
                  {{ m.text }}<span v-if="m.streaming" class="inline-block w-1 h-3.5 align-text-bottom bg-foreground/60 animate-pulse ml-0.5" />
                </div>
                <div v-else-if="m.kind === 'tool'" class="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span :class="[
                    'w-3 h-3 shrink-0',
                    m.status === 'running' ? 'icon-[lucide--loader] animate-spin'
                    : m.status === 'failed' ? 'icon-[lucide--circle-x] text-red-500' : 'icon-[lucide--circle-check] text-emerald-500'
                  ]" />
                  <span class="font-mono truncate">{{ m.name }}</span>
                </div>
                <p v-else class="text-[11px] text-muted-foreground text-center">{{ m.text }}</p>
              </div>
            </div>

            <!-- 审批也要能在这儿回,否则智能体一要权限,这一栏就永远卡住 -->
            <div v-if="chat.pending" class="mx-3 mb-2 rounded-xl border border-amber-500/40 bg-amber-500/5 p-2.5">
              <p class="text-[12px] font-medium">{{ chat.pending.title }}</p>
              <div class="mt-2 flex flex-wrap gap-1.5">
                <button v-for="o in chat.pending.options" :key="o.id" @click="respondPending(o.id)"
                  class="h-7 px-2.5 rounded-md border border-border text-[12px] hover:bg-muted">{{ o.label }}</button>
              </div>
            </div>

            <div class="p-2.5 border-t border-border">
              <!-- 带上下文:把当前打开的文件路径一起发过去,不然「这份笔记」它不知道指哪份 -->
              <textarea v-model="chatInput" @keydown="onChatKey" rows="2"
                :placeholder="activeTab ? t('vault.askAbout', { name: activeTab.name }) : t('vault.askAnything')"
                class="w-full resize-none rounded-xl border border-border bg-background/40 px-3 py-2 text-[13px]
                       leading-relaxed placeholder:text-muted-foreground/60 focus:outline-none focus:border-foreground/25" />
            </div>
          </template>
        </aside>
      </template>
      <!--
        收起来之后不占列宽,变成右下角一颗浮标 —— 不用智能体的人不该被一条空竖条
        占掉版面。位置贴着窗口右下角,和输入框、卡片边缘都留 10px。
      -->
      <!--
        右下角这颗浮标只在**没打开文件**时留着 —— 有文件的时候开关已经在
        顶部那一小行里了,两个入口做同一件事只会让人犹豫点哪个。
      -->
      <button v-else-if="!activeTab" @click="chatOpen = true" :title="t('vault.showAssistant')"
        class="float-card fixed bottom-5 right-5 z-40 size-11 rounded-[14px] border bg-card
               flex items-center justify-center text-muted-foreground transition-colors
               hover:text-foreground hover:bg-muted/50">
        <span class="icon-[ri--deepseek-line] w-5 h-5" />
      </button>
    </template>

    <!-- 重命名 -->
    <AlertDialog :open="!!renameTarget" @update:open="(v: boolean) => { if (!v) renameTarget = null }">
      <AlertDialogContent>
        <AlertDialogHeader><AlertDialogTitle>{{ t('vault.rename') }}</AlertDialogTitle></AlertDialogHeader>
        <Input v-model="renameText" autofocus @keydown.enter="doRename" />
        <AlertDialogFooter>
          <AlertDialogCancel>{{ t('convert.cancel') }}</AlertDialogCancel>
          <AlertDialogAction @click="doRename">{{ t('vault.rename') }}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <!-- 删除 -->
    <AlertDialog :open="confirmClear" @update:open="(v: boolean) => { confirmClear = v }">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{{ t('vault.removeVaultTitle') }}</AlertDialogTitle>
          <AlertDialogDescription>{{ t('vault.removeVaultBody') }}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{{ t('common.cancel') }}</AlertDialogCancel>
          <AlertDialogAction @click="doClearVault">{{ t('vault.removeVault') }}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <AlertDialog :open="!!deleteTarget" @update:open="(v: boolean) => { if (!v) deleteTarget = null }">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{{ t('vault.deleteTitle', { name: deleteTarget?.name ?? '' }) }}</AlertDialogTitle>
          <AlertDialogDescription>{{ t('vault.deleteBody') }}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{{ t('convert.cancel') }}</AlertDialogCancel>
          <AlertDialogAction @click="doDelete" class="bg-destructive text-white hover:bg-destructive/90">
            {{ t('vault.delete') }}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>

<style scoped>

.menu-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  padding: 0.35rem 0.5rem;
  border-radius: 0.375rem;
  font-size: 13px;
  text-align: left;
  transition: background-color 120ms;
}
.menu-row:hover { background: color-mix(in srgb, var(--foreground) 8%, transparent); }

.tool-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.75rem;
  height: 1.75rem;
  border-radius: 0.5rem;
  color: var(--muted-foreground);
  transition: background-color 140ms ease, color 140ms ease;
}
.tool-btn:hover {
  background: color-mix(in srgb, var(--foreground) 8%, transparent);
  color: var(--foreground);
}
</style>
