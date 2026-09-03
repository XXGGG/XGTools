<script setup lang="ts">
/**
 * 笔记页 —— 左边文件树、中间编辑器、右边智能体。
 *
 * 三栏各自能收:文件树可以拖宽,右边那栏可以整个收起来 ——
 * 没配 DSH 的人不该被一个用不了的面板占掉三分之一屏幕。
 *
 * 版式和智能体页一致:四边外缩一律 10px,左边给导航栏让出 4.875rem(78px)。
 */
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick, useTemplateRef, defineAsyncComponent } from 'vue'
import { useI18n } from '@/i18n'
import {
  vault, hasVault, activeTab, dirtyPaths, fileBadge, displayName,
  restoreVault, bindVaultEvents, pickVault, toggleDir, collapseAll, expandAll, setSort,
  openFile, closeTab, saveActive, createEntry, createWithContent, clearVault,
  renameEntry, deleteEntry, moveEntry, revealEntry, copyPath, markEdited,
  trashList, trashRestore, trashPurge, type TrashItem,
  snapshot, historyList, historyRead, historyClear, type Snapshot,
  attachBytes, attachFile, isHiddenEntry, findOrphanImages, type OrphanImage,
  search, type Entry, type Hit,
  resolveConflictTakeDisk, resolveConflictKeepMine,
} from '@/composables/useVault'
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger,
  ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger, ContextMenuPortal,
} from '@/components/ui/context-menu'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
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

import { settings, isDarkNow, VAULT_FONT_SIZE, VAULT_FONTS, VAULT_FONT_STACK } from '@/composables/useAppSettings'
import { zen, toggleZen } from '@/composables/useZen'
import ParticleLogo from '@/components/ParticleLogo.vue'
import MarkdownEditor from '@/components/MarkdownEditor.vue'
/*
  画布走异步:它背后是 React + Excalidraw,一兆多。
  不画画的人不该为它买单,所以只在真的打开一张画布时才下载。
*/
const ExcalidrawCanvas = defineAsyncComponent(() => import('@/components/ExcalidrawCanvas.vue'))
import { parseCanvas, updateCanvas, isCanvasContent } from '@/composables/useExcalidraw'
import { invoke, convertFileSrc } from '@tauri-apps/api/core'
import { open as openExternal } from '@tauri-apps/plugin-shell'
import { chat, chatReady, sendPrompt } from '@/composables/useDshChat'
import PendingCard from '@/components/agent/PendingCard.vue'
import ShortcutsDialog from '@/components/vault/ShortcutsDialog.vue'
import { INK_COLORS, type InkColor } from '@/components/editor/markdownShortcuts'

const { t } = useI18n()

onMounted(() => {
  void bindVaultEvents()
  void restoreVault()
  void bindSystemDrop()
})

/** 系统拖放的监听。只在笔记页挂着,离开页面要摘掉,否则在别的页面拖文件也会往笔记里塞图 */
let unlistenDrop: (() => void) | null = null
async function bindSystemDrop() {
  const { getCurrentWebview } = await import('@tauri-apps/api/webview')
  unlistenDrop = await getCurrentWebview().onDragDropEvent((e) => {
    if (e.payload.type === 'drop') void onSystemDrop(e.payload.paths)
  })
}
onBeforeUnmount(() => { unlistenDrop?.(); unlistenDrop = null })

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
    // 附件目录默认不进树:里面全是机器生成的文件名,摊开只会挤掉真正的笔记
    if (isHiddenEntry(e)) continue
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
/**
 * 树里当前选中的那一项(相对路径)。空串 = 选中的是库根。
 *
 * **新建的落点由它决定,不再跟着「当前打开的文件」走。**
 * 原来那样一旦打开过某个文件夹里的笔记,之后新建就永远落在那个文件夹里,
 * 想建到库根只能先去打开一篇库根下的笔记 —— 这不是选择,是被绑架。
 * 现在和 VSCode 一个规矩:点谁就往谁那儿建,点空白处就回库根。
 */
const selected = ref('')

/** 新建落在哪个目录:选中文件夹就是它自己,选中文件就是它所在那层 */
const targetDir = computed(() => {
  const sel = selected.value
  if (!sel) return ''
  const isDir = rows.value.find((r) => r.entry.path === sel)?.entry.isDir
  if (isDir) return sel
  return sel.includes('/') ? sel.slice(0, sel.lastIndexOf('/')) : ''
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

/*
  弹窗改名只给主干,后缀不进输入框。

  后缀是**类型**不是名字:`.md` 改成 `.txt` 之后这篇笔记就打不开了,而那多半
  是手滑,不是本意。树里的原地改名让后缀留在框里但不选中(那儿改起来更随手,
  真想改也拦不住),弹窗这边更正式,干脆不让碰。
*/
const renameTarget = ref<Entry | null>(null)
const renameText = ref('')
/** 见上面 askDelete 那段:弹窗关闭比按钮的 click 早,不能等到那会儿再读 ref */
let pendingRename: Entry | null = null
/** 被摘出去的后缀(含点)。文件夹和没有后缀的文件是空串 */
const renameExt = computed(() => {
  const name = renameTarget.value?.name ?? ''
  if (renameTarget.value?.isDir) return ''
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i) : ''
})

function startRename(e: Entry) {
  pendingRename = e
  renameTarget.value = e
  const i = e.isDir ? -1 : e.name.lastIndexOf('.')
  renameText.value = i > 0 ? e.name.slice(0, i) : e.name
}

async function doRename() {
  const e = pendingRename
  pendingRename = null
  const stem = renameText.value.trim()
  if (!e || !stem) return
  // **后缀要从快照里现算,不能读 renameExt** —— 那个 computed 是跟着
  // renameTarget 走的,而弹窗关闭已经把它清成 null 了,这会儿取到的是空串,
  // 结果就是改完名字后缀整个没了(zz-dialog-ok 而不是 zz-dialog-ok.md)。
  // renameExt 只负责弹窗开着时把后缀显示出来。
  const i = e.isDir ? -1 : e.name.lastIndexOf('.')
  const ext = i > 0 ? e.name.slice(i) : ''
  renameTarget.value = null
  if (stem + ext !== e.name) await renameEntry(e.path, stem + ext)
}

/*
  **确认框里要动的对象必须自己留一份快照,不能等到点确认时再去读 ref。**

  弹窗是靠 `:open="!!deleteTarget"` 驱动的,而 AlertDialogAction 被点中时
  会先把弹窗关掉 —— 关闭触发 @update:open,那个回调把 deleteTarget 清成 null,
  **这件事发生在按钮自己的 @click 之前**。于是 doDelete 拿到 null,
  一句 `if (!e) return` 就悄悄结束了:弹窗正常关闭、没有任何报错、文件纹丝不动。
  用户看到的就是「点了删除什么都没发生」,而后端连调都没被调到。

  重命名那个弹窗是同一套结构,同一个毛病,所以也用同样的办法。
*/
const deleteTarget = ref<Entry | null>(null)
let pendingDelete: Entry | null = null

function askDelete(e: Entry | null) {
  pendingDelete = e
  deleteTarget.value = e
}
// 注意:关闭弹窗时**只清 ref、不清快照**。点确认的时候关闭比 click 先跑,
// 那会儿把快照也清了就等于没修。快照由确认动作自己收尾,
// 「取消」留下的那一份会在下次打开时被覆盖,不会误删。

async function doDelete() {
  const e = pendingDelete
  pendingDelete = null
  deleteTarget.value = null
  if (!e) return
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
  if (e.key === 'F1') {
    e.preventDefault()
    shortcutsOpen.value = !shortcutsOpen.value
    return
  }
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
/**
 * 笔记里的相对路径 → webview 能加载的地址。
 *
 * 三种写法都要认:`attachments/a.png`(相对当前笔记)、`/attachments/a.png`
 * (相对库根,Obsidian 里也这么写)、以及 `../` 往上走。统一拼成绝对路径
 * 再交给 convertFileSrc —— 那才是 asset:// 协议认的形式。
 */
function resolveAsset(src: string) {
  if (!vault.root) return src
  let rel = decodeURI(src)
  if (rel.startsWith('/')) {
    rel = rel.slice(1)
  } else {
    const cur = activeTab.value?.path ?? ''
    const dir = cur.includes('/') ? cur.slice(0, cur.lastIndexOf('/')) : ''
    rel = dir ? `${dir}/${rel}` : rel
  }
  // 手动收掉 ./ 和 ../,不然拼出来的路径里带着它们,asset 协议不认
  const parts: string[] = []
  for (const seg of rel.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return convertFileSrc(`${vault.root}/${parts.join('/')}`)
}

// ── 大纲 ────────────────────────────────────────────

type Heading = { level: number, text: string, line: number }

/**
 * 从正文抽标题。
 *
 * 自己扫行而不是走 CM6 的语法树:大纲要的是「第几行、几级、写了什么」,
 * 一次正则就够;拿语法树反而要处理它的分块加载(视口外的节点根本没解析)。
 *
 * **代码块里的 `#` 不是标题** —— Python 注释、shell 命令全长这样,
 * 不跳过的话一篇带代码的笔记大纲里能冒出几十条垃圾。
 */
const outline = computed<Heading[]>(() => {
  const raw = activeTab.value?.kind === 'markdown' ? activeTab.value.content : ''
  if (!raw) return []
  const out: Heading[] = []
  let inFence = false
  raw.split('\n').forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return }
    if (inFence) return
    const m = /^(#{1,6})\s+(.*)$/.exec(line)
    if (!m) return
    const text = m[2]
      .replace(/[*_`~]/g, '')                       // 标题里的行内格式不进大纲
      .replace(/\[\[([^\]|]+)(\|[^\]]+)?\]\]/g, '$1')  // [[双链]] 只留显示名
      .trim()
    if (text) out.push({ level: m[1].length, text, line: i })
  })
  return out
})

/*
  源码模式和禅模式都是**当次会话的临时状态**,不进设置。

  它们是「我现在要干这件事」而不是「我一直喜欢这样」—— 存下来的话,
  用户某次调完格式关掉应用,下次打开发现笔记全是灰的,得先想半天这是怎么了。
*/
const sourceMode = ref(false)

/**
 * 编辑器最后拿到的那一档。
 *
 * 「源码模式」是临时的（上面那段），「露不露记号」是长期口味（存在设置里），
 * 两者合成一个值交给编辑器 —— 开着源码模式时它最大，盖过另一个。
 */
const markMode = computed<'source' | 'reveal' | 'clean'>(() =>
  sourceMode.value ? 'source' : settings.vaultMarkMode)

/*
  禅模式 = 只剩「一篇笔记」。

  让开的是:左边的功能侧栏、右上角窗口控制点、目录栏、标签条、右侧栏。
  **留下文档顶栏和底部状态栏** —— 顶栏上有返回和 ⋯ 菜单,那是退出禅模式的入口;
  状态栏是只读的一条细线,不抢注意力,反而写长文时想知道写了多少。

  状态在 useZen 里而不是这儿:要让开的东西有一半画在 App.vue,笔记页够不着。
*/
const zenMode = computed(() => zen.on)

function onZenEsc(e: KeyboardEvent) {
  if (e.key === 'Escape' && zen.on) {
    e.preventDefault()
    void toggleZen(false)
  }
}
onMounted(() => window.addEventListener('keydown', onZenEsc))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onZenEsc)
  // 离开笔记页时别把窗口留在全屏里 —— 那会变成「整个应用卡在全屏」
  if (zen.on) void toggleZen(false)
})

/*
  大纲的配色:一眼分得出层级,而不是全靠缩进去数。

  H1 给一块主题色的底(它是全篇的骨架,值得一块面积);H2 深主题色加粗;
  H3 正常主题色;H4 浅一点;H5 就是正文色;H6 淡灰 —— 越往下越退到背景里去。
  用 color-mix 从笔记主题色现算,换主题色时整条大纲跟着变,不用另外配一套。
*/
function outlineStyle(level: number): Record<string, string> {
  const a = settings.vaultAccent
  switch (level) {
    case 1: return {
      background: `color-mix(in srgb, ${a} 22%, transparent)`,
      color: `color-mix(in srgb, ${a} 70%, var(--foreground))`,
      fontWeight: '600',
    }
    case 2: return { color: `color-mix(in srgb, ${a} 78%, var(--foreground))`, fontWeight: '600' }
    case 3: return { color: a }
    case 4: return { color: `color-mix(in srgb, ${a} 55%, var(--muted-foreground))` }
    case 5: return { color: 'var(--foreground)' }
    default: return { color: 'color-mix(in srgb, var(--muted-foreground) 70%, transparent)' }
  }
}

/** 右缘那一列短横线,颜色跟着同一套层级走,和面板对得上 */
function outlineBarColor(level: number): string {
  const a = settings.vaultAccent
  if (level <= 2) return `color-mix(in srgb, ${a} 80%, var(--foreground))`
  if (level === 3) return a
  if (level === 4) return `color-mix(in srgb, ${a} 50%, var(--muted-foreground))`
  if (level === 5) return 'color-mix(in srgb, var(--foreground) 45%, transparent)'
  return 'color-mix(in srgb, var(--muted-foreground) 45%, transparent)'
}

/** 大纲里最浅的那一级。整篇都是 ## 开头时,不该让它们全部缩进一格 */
const outlineBase = computed(() =>
  outline.value.length ? Math.min(...outline.value.map((h) => h.level)) : 1)

/** 点大纲跳到那一行 */
function gotoHeading(h: Heading) {
  editor.value?.gotoLine(h.line)
}

// ── 底部状态栏 ──────────────────────────────────────

/**
 * 正文统计。
 *
 * 中文按**字**数，英文按**词**数 —— 拿空格切词在中文上会把整段算成一个词，
 * 而按字符算英文又会把 "hello" 算成 5。所以两边分开数再相加，
 * 这也是 Obsidian 和 Typora 的做法。
 *
 * 数之前先把不算正文的东西剥掉：代码块、frontmatter、图片链接的 URL。
 * 「这篇写了多少字」问的是内容量，不该把一段 base64 也算进去。
 */
const docStats = computed(() => {
  const raw = activeTab.value?.kind === 'markdown' ? activeTab.value.content : ''
  if (!raw) return { chars: 0, words: 0, lines: 0 }
  const body = raw
    .replace(/^---\n[\s\S]*?\n---\n/, '')       // frontmatter
    .replace(/```[\s\S]*?```/g, '')               // 代码块
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')          // 图片(连 URL 一起)
  const cjk = body.match(/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g)?.length ?? 0
  const latin = body
    .replace(/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g, ' ')
    .match(/[A-Za-z0-9_'-]+/g)?.length ?? 0
  return {
    chars: body.replace(/\s/g, '').length,
    words: cjk + latin,
    lines: raw.split('\n').length,
  }
})

// ── 导出 / 打印 ─────────────────────────────────────

/**
 * 导出。四种格式共用一份「markdown → 完整 HTML」,见 useExport。
 *
 * 保存路径走系统对话框:导出是要发给别人的,存哪儿只有用户自己知道,
 * 替他挑一个目录多半还得再另存一次。
 */
async function exportAs(kind: 'html' | 'pdf' | 'word' | 'image') {
  const t = activeTab.value
  if (!t || t.kind !== 'markdown') return
  const title = displayName(t.name)

  const {
    renderStandalone, noteToPng, noteToDoc, printNote,
  } = await import('@/composables/useExport')

  // PDF 走系统打印对话框里的「另存为 PDF」—— 浏览器那套分页引擎
  // 比塞一个 pdf 库进来靠谱得多,中文也不用另配字体
  if (kind === 'pdf') {
    await printNote(title, t.content, resolveAsset)
    return
  }

  const spec = {
    html: { ext: 'html', name: 'HTML', b64: false },
    word: { ext: 'doc', name: 'Word', b64: false },
    image: { ext: 'png', name: 'PNG', b64: true },
  }[kind]

  try {
    const { save } = await import('@tauri-apps/plugin-dialog')
    const path = await save({
      defaultPath: `${title}.${spec.ext}`,
      filters: [{ name: spec.name, extensions: [spec.ext] }],
    })
    if (!path) return

    let content: string
    if (kind === 'image') {
      // dataURL 前面那段 `data:image/png;base64,` 要去掉,后端只认纯 base64
      content = (await noteToPng(title, t.content, resolveAsset)).split(',')[1] ?? ''
    } else if (kind === 'word') {
      content = await noteToDoc(title, t.content, resolveAsset)
    } else {
      content = await renderStandalone(title, t.content, resolveAsset)
    }
    await invoke('save_export', { path, content, base64: spec.b64 })
  } catch (e) {
    vault.error = String(e)
  }
}

async function doPrint() {
  const t = activeTab.value
  if (!t || t.kind !== 'markdown') return
  const { printNote } = await import('@/composables/useExport')
  await printNote(displayName(t.name), t.content, resolveAsset)
}

// ── 文件恢复(历史版本) ──────────────────────────────

/**
 * 每隔多久存一次快照。
 *
 * 两分钟:再短一点,一段话还没写完就存了好几份,翻历史时全是半句话;
 * 再长一点,一次误删和上一份之间可能隔着十几分钟的活儿。
 * 后端会按内容去重,没改动的那些周期不产生任何文件。
 */
const SNAP_EVERY = 2 * 60 * 1000
let snapTimer: number | undefined

const historyOpen = ref(false)
const snapList = ref<Snapshot[]>([])
const historyPick = ref<Snapshot | null>(null)
const historyText = ref('')
const historyBusy = ref(false)

async function openHistory(path?: string) {
  const rel = path ?? activeTab.value?.path
  if (!rel) return
  historyOpen.value = true
  historyBusy.value = true
  historyPick.value = null
  historyText.value = ''
  /*
    打开之前先存一份当前的 —— 不然「现在这一版」不在列表里,没法对照。
    只有开着的那一篇才存得了:别的文件我们手上没有它的最新内容,
    拿磁盘上的再存一遍是白占一个版本位。
  */
  const tab = vault.tabs.find((x) => x.path === rel)
  if (tab) await snapshot(rel, tab.content)
  snapList.value = await historyList(rel)
  historyBusy.value = false
}

const historyCopied = ref(false)
async function copyHistoryText() {
  await putOnClipboard(historyText.value)
}

/*
  刮选出来的那一段也要能复制。

  「复制全文」只解决「我全都要」;更常见的是从旧版本里抠一句话贴回正文。
  这个界面里 Ctrl+C 不一定顺手(弹窗里焦点在哪儿不好说),右键又不该弹浏览器
  自带的那个菜单 —— 所以刮选之后就地长出一颗「复制选中」,选了什么它就拿什么,
  再配一条 Ctrl+C 的兜底,两条路都通。
*/
const historyPre = useTemplateRef<HTMLElement>('historyPre')
const historySel = ref('')

function readHistorySelection() {
  const sel = window.getSelection()
  const text = sel && !sel.isCollapsed ? sel.toString() : ''
  const inPreview = sel?.anchorNode && historyPre.value?.contains(sel.anchorNode)
  historySel.value = text && inPreview ? text : ''
}

async function copyHistorySelection() {
  await putOnClipboard(historySel.value)
}

/** Ctrl/Cmd+C 的兜底:有刮选就复制刮选的,没有就复制整份 */
function onHistoryCopyKey(e: KeyboardEvent) {
  if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'c') return
  readHistorySelection()
  e.preventDefault()
  void putOnClipboard(historySel.value || historyText.value)
}

async function putOnClipboard(text: string) {
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    return // 剪贴板被拒就别显示「已复制」骗人
  }
  historyCopied.value = true
  setTimeout(() => (historyCopied.value = false), 1500)
}

async function pickSnapshot(sn: Snapshot) {
  const rel = activeTab.value?.path
  if (!rel) return
  historyPick.value = sn
  historyText.value = await historyRead(rel, sn.id)
}

/**
 * 用这一版覆盖当前内容。
 *
 * **只写进编辑器,不直接落盘** —— 恢复完还能 Ctrl+Z 撤回去,
 * 也能看一眼不对再选别的版本。真正存盘还是走平时那条路。
 */
function restoreSnapshot() {
  const t = activeTab.value
  if (!t || !historyPick.value) return
  t.content = historyText.value
  markEdited(t.path)
  historyOpen.value = false
}

async function clearHistory() {
  const rel = activeTab.value?.path
  if (!rel) return
  await historyClear(rel)
  snapList.value = []
  historyPick.value = null
  historyText.value = ''
}

onMounted(() => {
  snapTimer = window.setInterval(() => {
    const t = activeTab.value
    if (t?.kind === 'markdown' && t.content) void snapshot(t.path, t.content)
  }, SNAP_EVERY)
})
onBeforeUnmount(() => window.clearInterval(snapTimer))

// ── 文件属性 ────────────────────────────────────────

type FileInfo = {
  rel: string
  size: number
  created: number
  modified: number
}

const infoOpen = ref(false)
const info = ref<FileInfo | null>(null)

async function openInfo(path?: string) {
  const rel = path ?? activeTab.value?.path
  if (!rel) return
  infoOpen.value = true
  info.value = null
  try {
    info.value = await invoke<FileInfo>('vault_file_info', { root: vault.root, rel })
  } catch (e) {
    vault.error = String(e)
    infoOpen.value = false
  }
}

/** 「2026-08-27 11:42」。属性面板里精确到秒没意义,到分钟就够回忆「什么时候写的」 */
function fmtTime(ms: number) {
  if (!ms) return '—'
  const d = new Date(ms)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// ── 往笔记里塞图片 ──────────────────────────────────

/** 图片存好之后要插进正文的那段。相对路径按当前笔记算,和 Obsidian 一样 */
function imageMarkdown(rel: string) {
  const cur = activeTab.value?.path ?? ''
  const dir = cur.includes('/') ? cur.slice(0, cur.lastIndexOf('/')) : ''
  // 存到笔记同级时写成相对路径,笔记跟图一起搬走也不会断
  const shown = dir && rel.startsWith(dir + '/') ? rel.slice(dir.length + 1) : '/' + rel
  return `![](${encodeURI(shown)})`
}

async function onPasteImage(file: File) {
  const note = activeTab.value?.path
  if (!note) return ''
  const b64 = await fileToBase64(file)
  const ext = (file.type.split('/')[1] ?? 'png').replace('jpeg', 'jpg')
  const rel = await attachBytes(note, ext, b64)
  return rel ? imageMarkdown(rel) : ''
}

/** File → base64。走 FileReader 而不是自己拼字节:大图上手写循环会卡住 UI */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '')
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
}

/*
  从资源管理器拖图片进来。

  **不能用 HTML5 的 drop 事件** —— 和目录栏拖拽同一个坑:Tauri 的窗口开着
  系统级拖放,那一层把 webview 里的 drop 全吃了。好在这次它吃掉之后
  会转成 Tauri 自己的事件,而且给的是**文件路径**,比 File 对象还好用:
  直接让后端复制,不用把几 MB 的图编码一遍再传过去。
*/
const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i

async function onSystemDrop(paths: string[]) {
  const note = activeTab.value?.path
  if (!note || activeTab.value?.kind !== 'markdown') return
  const imgs = paths.filter((p) => IMG_EXT.test(p))
  if (!imgs.length) return
  const md: string[] = []
  for (const p of imgs) {
    const rel = await attachFile(note, p)
    if (rel) md.push(imageMarkdown(rel))
  }
  if (md.length) editor.value?.insertAtCursor(md.join('\n\n'))
}

// ── 正文右键菜单 ──────────────────────────────────────

// ── 画布 ────────────────────────────────────────────

/*
  当前这张画布的场景。

  从文件正文里现挖 —— 画布文件本身就是一篇 markdown,场景压在末尾的
  注释块里。用 computed 而不是存一份状态:切标签、外部改动同步进来,
  都自动跟着变,不用另外记得同步。
*/
/** 画布跟着应用的深浅色走。isDarkNow 认的是 settings.theme 那一处真相 */
const isDark = computed(() => isDarkNow())

/** 当前这一篇是不是画布。顶栏、底栏、⋯ 菜单都要按它分叉 */
const isCanvas = computed(() => activeTab.value?.kind === 'canvas')

const canvas = computed(() => {
  const t = activeTab.value
  /*
    只认 Excalidraw 那种画布,而且**按内容认**。

    - Obsidian 自己那套 `.canvas`(JSON Canvas)是完全不同的格式,虽然也归在
      kind='canvas' 底下 —— 拿 Excalidraw 去开只会开出一张空白画,一改还会
      把人家的文件写坏。
    - 反过来,名字里没有 `.excalidraw` 的画布(用户改过名)也得认出来,
      不然会被当成「打不开的格式」。

    所以判据是文件开头那句 `excalidraw-plugin:` —— 和 Obsidian 插件同一个判据。
  */
  if (!t || t.kind !== 'canvas' || !isCanvasContent(t.content)) return null
  return parseCanvas(t.content)
})

/**
 * 画布改了 —— 写回文件正文,剩下的交给平时那套自动保存。
 *
 * 写不回去(文件结构不认识)时只报错不硬写:宁可这一次没存上,
 * 也不能把一份看不懂的文件覆盖成我们以为的样子。
 */
function onCanvasChange(scene: Parameters<typeof updateCanvas>[1]) {
  // 变量别叫 t —— 这个文件里 t 是 i18n 的翻译函数
  const tab = activeTab.value
  if (!tab || tab.kind !== 'canvas') return
  const next = updateCanvas(tab.content, scene, canvas.value?.compressed ?? true)
  if (next === null) {
    vault.error = t('vault.canvasBroken')
    return
  }
  if (next === tab.content) return
  tab.content = next
  markEdited(tab.path)
}

// ── 反向链接 ─────────────────────────────────────────

/*
  谁链到了这一篇。

  走后端专门的 vault_backlinks,不是全文搜索 —— 搜索只认「文本里出现了
  这个名字」,而正文里顺口提一句标题不算链接;搜索还规定一个文件只报一处,
  而一篇文章链同一个地方三次,那三处都该看得见。
*/
const backOpen = ref(false)
const backBusy = ref(false)
const backlinks = ref<Hit[]>([])

async function openBacklinks(path?: string) {
  const rel = path ?? activeTab.value?.path
  if (!rel) return
  backOpen.value = true
  backBusy.value = true
  backlinks.value = []
  try {
    const hits = await invoke<Hit[]>('vault_backlinks', {
      root: vault.root,
      target: displayName(rel.split('/').pop() ?? rel),
    })
    // 自己链自己不算 —— 一篇笔记里写 [[自己]] 多半是笔误,列出来只是噪音
    backlinks.value = hits.filter((h) => h.path !== rel)
  } catch (e) {
    vault.error = String(e)
  }
  backBusy.value = false
}

async function gotoBacklink(h: Hit) {
  backOpen.value = false
  await openFile(h.path)
}

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

// ── 回收站 ──────────────────────────────────────────

const trashOpen = ref(false)
const trash = ref<TrashItem[]>([])
const trashBusy = ref(false)
const trashTab = ref<'deleted' | 'orphan'>('deleted')
/** null = 还没扫过。空数组和「没扫」要分开,否则一打开就显示「一张没有」 */
const orphans = ref<OrphanImage[] | null>(null)
const confirmSweep = ref(false)
const orphanTotal = computed(() => (orphans.value ?? []).reduce((a, o) => a + o.size, 0))

function switchTrashTab(tab: 'deleted' | 'orphan') {
  trashTab.value = tab
}

async function scanOrphans() {
  trashBusy.value = true
  orphans.value = await findOrphanImages()
  trashBusy.value = false
}

/**
 * 把扫出来的图**送进回收站,不是直接抹掉**。
 *
 * 扫描是按「文件名有没有在任何笔记里出现过」判断的,一定有漏网的情况。
 * 走一趟回收站,发现清错了还能捞回来 —— 这点代价换的是「不会因为一次扫描
 * 就丢掉在用的图」。
 */
async function doSweep() {
  const list = orphans.value ?? []
  confirmSweep.value = false
  if (!list.length) return
  trashBusy.value = true
  for (const o of list) await deleteEntry(o.rel)
  orphans.value = await findOrphanImages()
  trash.value = await trashList()
  trashBusy.value = false
}
/** 要彻底删的那一条;'*' 表示清空整个回收站 */
const purgeTarget = ref<string>('')
let pendingPurge = ''      // 同 askDelete:弹窗关闭比按钮的 click 早

/*
  回收站开一个独立窗口,不占目录栏。

  原来是盖在树上面的,结果是「翻一眼回收站」要先挤掉文件树、看完还得再点回来 ——
  而回收站是偶尔进来一次的地方,不该让常驻的树给它让位。
*/
async function openTrash() {
  trashOpen.value = true
  trashBusy.value = true
  trash.value = await trashList()
  trashBusy.value = false
}

async function reloadTrash() {
  trashBusy.value = true
  trash.value = await trashList()
  trashBusy.value = false
}

async function doRestore(item: TrashItem) {
  const rel = await trashRestore(item.id)
  await reloadTrash()
  // 还原完顺手打开,省得用户再去树里找 —— 但别把回收站关掉,
  // 常见动作是一次还原好几样
  if (rel) await openFile(rel)
}

function askPurge(id: string) {
  pendingPurge = id
  purgeTarget.value = id
}

async function doPurge() {
  const id = pendingPurge
  pendingPurge = ''
  purgeTarget.value = ''
  if (!id) return
  await trashPurge(id === '*' ? undefined : id)
  await reloadTrash()
}

/** 「3 天前」这种。回收站里精确到秒没意义,只想知道大概多久了 */
function ago(ms: number) {
  if (!ms) return ''
  const d = Date.now() - ms
  const min = Math.floor(d / 60000)
  if (min < 1) return t('vault.justNow')
  if (min < 60) return t('vault.minAgo', { n: min })
  const h = Math.floor(min / 60)
  if (h < 24) return t('vault.hourAgo', { n: h })
  return t('vault.dayAgo', { n: Math.floor(h / 24) })
}

function humanSize(b: number) {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / 1048576).toFixed(1)} MB`
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
/*
  单击 = 预览打开(标签斜体,再点别的会顶掉它);双击 = 常驻。

  学 VSCode。之前每点一个文件就攒一个标签,而其中绝大多数只是「看一眼」,
  点十下就要手动关九个。
*/
function onRowClick(entry: Entry) {
  if (didDrag) {
    didDrag = false
    return
  }
  selected.value = entry.path
  if (entry.isDir) toggleDir(entry.path)
  else openFile(entry.path, true, false, true)
}

function onRowDblClick(entry: Entry) {
  if (!entry.isDir) void openFile(entry.path, true, false, false)
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

const sidePanel = computed({
  get: () => settings.vaultSidePanel,
  set: (v: 'none' | 'chat') => { settings.vaultSidePanel = v },
})

/** 点已经开着的那个就收起来,和侧栏图标的通用手感一致 */
function toggleSide(which: 'chat') {
  sidePanel.value = sidePanel.value === which ? 'none' : which
}

const chatOpen = computed({
  get: () => sidePanel.value === 'chat',
  set: (v: boolean) => { sidePanel.value = v ? 'chat' : 'none' },
})

// ── 搜索(按需展开) ──────────────────────────────────

const searchOpen = ref(false)
const searchInput = useTemplateRef<HTMLInputElement>('searchInput')

async function openSearch() {
  searchOpen.value = true
  await nextTick()
  searchInput.value?.focus()
}

function closeSearch() {
  searchOpen.value = false
  if (vault.query) search('')
}

/** 失焦就收起来 —— 但输入框里还有字的话不收,那说明用户正在看结果 */
function onSearchBlur() {
  if (!vault.query.trim()) searchOpen.value = false
}

/** 鼠标在悬浮大纲上。线段和面板靠它 */
const outlineHover = ref(false)

/**
 * 视口中间那一节是大纲里的第几条。
 *
 * 取「行号不超过视口中线的最后一个标题」——「正在看哪一节」问的是
 * 我现在处于谁的管辖范围,不是屏幕上离中线最近的那个标题
 * (后者在长段落里会一路空着,滚半天没有任何一条亮起来)。
 */
const activeHeading = ref(-1)

function syncActiveHeading() {
  const list = outline.value
  if (!list.length) { activeHeading.value = -1; return }
  const line = editor.value?.centerLine() ?? 0
  let idx = -1
  for (let i = 0; i < list.length; i++) {
    if (list[i].line <= line) idx = i
    else break
  }
  activeHeading.value = idx
}

/*
  滚动时重算「正在看哪一节」。

  监听放在根节点上、用捕获阶段 —— 滚动事件不冒泡,挂在外层的普通监听收不到,
  而编辑器那个 .cm-scroller 是 CM6 自己建的,我们拿不到稳定的引用去逐个挂。
*/
onMounted(() => rootEl.value?.addEventListener('scroll', syncActiveHeading, true))
onBeforeUnmount(() => rootEl.value?.removeEventListener('scroll', syncActiveHeading, true))
watch(() => activeTab.value?.path, () => {
  // 换了篇笔记先清掉,等它渲染完再算 —— 否则算的是上一篇的行号
  activeHeading.value = -1
  void nextTick(syncActiveHeading)
})

// 鼠标刚移进来那一下也要算一次:在此之前可能一次都没滚过,
// 高亮会停在 -1,看着像这个功能没做
watch(outlineHover, (v) => { if (v) syncActiveHeading() })
/** 右栏开着。布局要靠它决定正文那一列留不留窗口控制点的位置 */
const sideOpen = computed(() => sidePanel.value !== 'none')

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
/** 前进后退的浏览记录(打开过哪几篇),和「文件恢复」那套快照没关系 */
const visited = ref<string[]>([])
const histAt = ref(-1)
let navigating = false

watch(activeTab, (t) => {
  if (!t || navigating) return
  if (visited.value[histAt.value] === t.path) return
  visited.value = visited.value.slice(0, histAt.value + 1)
  visited.value.push(t.path)
  histAt.value = visited.value.length - 1
})

const canBack = computed(() => histAt.value > 0)
const canForward = computed(() => histAt.value < visited.value.length - 1)

async function go(step: number) {
  const i = histAt.value + step
  if (i < 0 || i >= visited.value.length) return
  histAt.value = i
  navigating = true
  await openFile(visited.value[i])
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

/*
  右键菜单的开关。

  颜色那一排是**普通按钮**,不是 ContextMenuItem —— 七颗要摆成一行,
  而 ContextMenuItem 一颗占一行。代价是它们不会像菜单项那样点完自动收起,
  所以这里自己把菜单关掉:选完颜色人是要看效果的,菜单杵在那儿正好挡着。
*/
const ctxOpen = ref(false)
function pickColor(c: InkColor | null) {
  ed.value?.color(c)
  ctxOpen.value = false
}

/*
  文本格式那八颗。

  写成一张表而不是八段一样的模板 —— 它们只差「图标、名字、干什么」三样,
  排成表之后加一件、换个顺序都是改一行数据。
  `clear` 单独一类:它不是包一对标记,是把标记全剥掉。
*/
const FORMAT_BTNS = [
  { key: 'fmtBold', icon: 'icon-[lucide--bold]', mark: '**' },
  { key: 'fmtItalic', icon: 'icon-[lucide--italic]', mark: '*' },
  { key: 'fmtStrike', icon: 'icon-[lucide--strikethrough]', mark: '~~' },
  { key: 'fmtHighlight', icon: 'icon-[lucide--highlighter]', mark: '==' },
  { key: 'fmtCode', icon: 'icon-[lucide--code]', mark: '`' },
  { key: 'fmtMath', icon: 'icon-[lucide--sigma]', mark: '$' },
  { key: 'fmtComment', icon: 'icon-[lucide--message-square-off]', mark: '%%' },
  { key: 'fmtClear', icon: 'icon-[lucide--eraser]', mark: null },
] as const

/** 和颜色那排一样:点完把菜单收起来,好让人看见效果 */
function runFormat(f: (typeof FORMAT_BTNS)[number]) {
  if (f.mark) ed.value?.wrap(f.mark)
  else ed.value?.clearFormat()
  ctxOpen.value = false
}

/**
 * 快捷键一览。
 *
 * F1 是这台机器上唯一还空着、又人人都会去按的键 —— Ctrl+/ 已经被
 * CodeMirror 的「注释」占了，Ctrl+? 在中文键盘上要按三个键。
 */
const shortcutsOpen = ref(false)

/** 当前标签对应的树条目形状 —— 重命名和删除那两个函数吃的是 Entry */
const tabEntry = computed(() => {
  const t = activeTab.value
  if (!t) return null
  const dot = t.name.lastIndexOf('.')
  // size / modified 补 0:重命名和删除都用不到它们,但 Entry 的类型要求有
  return {
    path: t.path, name: t.name, isDir: false,
    ext: dot > 0 ? t.name.slice(dot + 1) : '', size: 0, modified: 0,
    isCanvas: t.kind === 'canvas',
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
  selected.value = dir
  await created(await createEntry(dir, isDir, isDir ? t('vault.newFolderName') : t('vault.newNoteName')))
}

/** 空白处右键新建。都建在库根下 —— 右键的是空白,没有"当前目录"这个概念 */
async function newAt(kind: 'note' | 'folder' | 'base' | 'canvas') {
  if (kind === 'note') return created(await createEntry('', false, t('vault.newNoteName')))
  if (kind === 'folder') return created(await createEntry('', true, t('vault.newFolderName')))
  if (kind === 'base') return created(await createWithContent('', t('vault.newBaseName'), BASE_TEMPLATE))
  return created(await createWithContent('', t('vault.newCanvasName'), CANVAS_TEMPLATE))
}

/*
  「全展开」按钮要不要出现。

  折叠状态在编辑器里(CM6 的 EditorState),Vue 这边看不见它的变化 —— 没有可 watch 的响应式源。
  所以按定时轮询:只在开着 markdown 的时候每 700ms 问一句「有没有折起来的」。
  一次 between 遍历而已,比给编辑器加一条对外的事件通道简单得多,也不会漏掉
  「用户自己点把手折的」这种编辑器内部发生的变化。
*/
const anyFolded = ref(false)
let foldPoll: number | undefined
onMounted(() => {
  foldPoll = window.setInterval(() => {
    anyFolded.value = activeTab.value?.kind === 'markdown' && (editor.value?.hasFolds?.() ?? false)
  }, 700)
})
onBeforeUnmount(() => { if (foldPoll) clearInterval(foldPoll) })

function expandAllHeadings() {
  editor.value?.unfoldAll?.()
  anyFolded.value = false
}

/** 一次只问一篇,答完自动轮到下一篇 */
const conflict = computed(() => vault.conflicts[0] ?? null)

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
  <div ref="rootEl" class="absolute inset-0 pt-2.5 pr-2.5 pb-2.5 flex"
    :class="[dragging ? 'select-none' : '', zenMode ? 'pl-2.5' : 'pl-[4.875rem]']">

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
      <div v-if="treeOpen && !zenMode" class="shrink-0 flex flex-col gap-2.5" :style="{ width: settings.vaultTreeWidth + 'px' }">

        <!-- 卡片直接贴在 y=10,不再套一层更高的行 -->
        <div class="float-card h-[58px] shrink-0 rounded-[14px] border bg-card flex items-center gap-1 px-3">
          <!-- 工作区这一组放最左边:它决定了下面所有东西是什么,和「新建」不是一类操作 -->
          <button @click="pickVault" :title="t('vault.changeFolder')" class="tool-btn">
            <span class="icon-[lucide--folder-open] w-4 h-4" />
          </button>
          <button @click="confirmClear = true" :title="t('vault.removeVault')" class="tool-btn">
            <span class="icon-[lucide--folder-x] w-4 h-4" />
          </button>
          <!-- 回收站也是「这个库整体」的事,跟工作区那两个放一组,不和新建混在一起 -->
          <button @click="openTrash" :title="t('vault.trash')" class="tool-btn">
            <span class="icon-[lucide--trash-2] w-4 h-4" />
          </button>

          <!--
            收起目录栏。ml-auto 顶到最右 —— 它不是「对这个库做什么」,
            是「这一栏要不要占地方」,和左边那三个不是一类,拉开距离才不会误点。
          -->
          <button @click="treeOpen = false" :title="t('vault.hideTree')" class="tool-btn ml-auto">
            <span class="icon-[lucide--panel-left-close] w-4 h-4" />
          </button>
        </div>

      <aside class="float-card flex-1 min-h-0 rounded-[14px] border bg-card flex flex-col overflow-hidden">
        <!--
          这一行平时是「搜索图标 + 四个常用操作」,点搜索才把输入框铺开盖住那四个。

          搜索框原来常驻一整行,可它绝大多数时候是空的 —— 一个空输入框霸占
          目录栏最显眼的位置,而真正天天点的新建/排序反而被挤到上面那张卡里。
          现在换过来:常用的常驻,搜索按需展开。
        -->
        <div class="relative px-2 py-2 h-[52px] shrink-0">
          <div class="flex items-center gap-1 h-9">
            <button @click="openSearch" :title="t('vault.search')" class="tool-btn">
              <span class="icon-[lucide--search] w-4 h-4" />
            </button>
            <div class="flex-1" />
            <button @click="newNote" class="tool-btn"
              :title="targetDir ? t('vault.newNoteIn', { dir: targetDir }) : t('vault.newNoteAtRoot')">
              <span class="icon-[lucide--file-plus] w-4 h-4" />
            </button>
            <button @click="newFolder" class="tool-btn"
              :title="targetDir ? t('vault.newFolderIn', { dir: targetDir }) : t('vault.newFolderAtRoot')">
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
          </div>

          <!-- 展开态整个盖上去,不是把按钮挤走 —— 挤走会让这一行的宽度跳一下 -->
          <!--
            这一层得有实底。它是**盖在工具条上面**的,底下就是新建/排序那几个按钮;
            以前输入框用的是半透明底,结果按钮的图标从搜索框里透出来,
            像是框里印了几个鬼影。圆角外面那点缝隙也要盖住,所以底垫在外层。
          -->
          <div v-if="searchOpen" class="absolute inset-x-2 top-2 h-9 rounded-lg bg-card">
            <!-- z-10:输入框现在是实底的,不抬一层这个放大镜会被它盖住 -->
            <span class="icon-[lucide--search] w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 z-10
                         text-muted-foreground pointer-events-none" />
            <input ref="searchInput" :value="vault.query"
              @input="search(($event.target as HTMLInputElement).value)"
              @keydown.escape="closeSearch" @blur="onSearchBlur"
              :placeholder="t('vault.search')"
              class="w-full h-9 pl-9 pr-8 rounded-lg bg-background border border-border text-[15px]
                     placeholder:text-muted-foreground/60 focus:outline-none focus:border-foreground/25" />
            <button @click="closeSearch" :title="t('common.cancel')"
              class="absolute right-1.5 top-1/2 -translate-y-1/2 tool-btn size-6">
              <span class="icon-[lucide--x] w-3.5 h-3.5" />
            </button>
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
        <!--
          .self 不能少:行的点击会冒泡到这里,不加的话选中刚设好就被这一句清掉,
          表现是「点了文件夹,新建还是建到库根」——和没做这个功能一模一样。
        -->
        <div ref="treeBox" @click.self="selected = ''"
          class="flex-1 min-h-0 overflow-y-auto px-1.5 pb-2"
          :style="{
            outline: dropTarget === '__root__' ? '2px solid ' + settings.vaultAccent : '',
            outlineOffset: '-2px', borderRadius: '6px',
          }">
          <ContextMenu v-for="r in rows" :key="r.entry.path">
            <ContextMenuTrigger as-child>
              <button @click="onRowClick(r.entry)" @dblclick="onRowDblClick(r.entry)"
                @pointerdown="onRowDown($event, r.entry)"
                :data-path="r.entry.path" :data-dir="r.entry.isDir ? '1' : ''"
                :style="{
                  paddingLeft: (r.depth * 14 + 8) + 'px',
                  outline: dropTarget === r.entry.path ? '2px solid ' + settings.vaultAccent : '',
                  outlineOffset: '-2px',
                }" :class="[
                  'w-full flex items-center gap-1.5 rounded-md py-1 pr-2 text-left transition-colors',
                  /*
                    只有**文件**才有常驻底色(当前这篇、或者选中的那篇)。
                    文件夹点一下只是展开,不该留下一块和「当前打开的文件」一模一样的底 ——
                    那样树上会同时亮着两行,看着像开了两个东西。
                    文件夹保留鼠标经过和按下的反馈,够用了。
                  */
                  !r.entry.isDir && (vault.activeTab === r.entry.path || selected === r.entry.path)
                    ? 'bg-muted' : 'hover:bg-muted/50 active:bg-muted',
                  dropTarget === r.entry.path ? 'bg-muted/70' : '',
                  dragPath === r.entry.path ? 'opacity-40' : ''
                ]">
                <!--
                  文件夹用开合两种图标,不用三角形 —— 一个图标同时说明「这是文件夹」
                  和「它开着还是关着」,比三角形 + 文件夹图标两个元素省地方。
                -->
                <span v-if="r.entry.isDir" class="w-4 h-4 shrink-0 text-muted-foreground"
                  :class="vault.expanded.has(r.entry.path) ? 'icon-[lucide--folder-open]' : 'icon-[lucide--folder]'" />
                <!--
                  文件用彩色小图标前缀。笔记跟着主题色走,所以它的颜色是内联的,
                  其余按类型给固定色(见 useVault 的 fileBadge)。
                -->
                <span v-else class="w-4 h-4 shrink-0"
                  :class="[fileBadge(r.entry.name, r.entry.isCanvas).icon, fileBadge(r.entry.name, r.entry.isCanvas).cls]"
                  :style="fileBadge(r.entry.name, r.entry.isCanvas).accent ? { color: settings.vaultAccent } : undefined" />

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
              <!--
                这三个是「针对某个文件」的操作,以前只在右上角 ⋯ 菜单里。
                画布页没有顶栏(整张画要铺满),那边就够不着了 ——
                何况它们本来就该在文件身上,右键点谁就是谁的。
              -->
              <template v-if="!r.entry.isDir">
                <ContextMenuSeparator />
                <ContextMenuItem @select="openBacklinks(r.entry.path)">
                  <span class="icon-[lucide--link] w-4 h-4 mr-2" />{{ t('vault.backlinks') }}
                </ContextMenuItem>
                <ContextMenuItem @select="openHistory(r.entry.path)">
                  <span class="icon-[lucide--history] w-4 h-4 mr-2" />{{ t('vault.history') }}
                </ContextMenuItem>
                <ContextMenuItem @select="openInfo(r.entry.path)">
                  <span class="icon-[lucide--info] w-4 h-4 mr-2" />{{ t('vault.fileInfo') }}
                </ContextMenuItem>
              </template>
              <ContextMenuSeparator />
              <!-- 树里的重命名走原地改名;弹窗那套只留给右上角更多菜单 -->
              <ContextMenuItem @select="startInline(r.entry.path, r.entry.name)">
                <span class="icon-[lucide--pencil] w-4 h-4 mr-2" />{{ t('vault.rename') }}
              </ContextMenuItem>
              <ContextMenuItem @select="askDelete(r.entry)" class="text-destructive focus:text-destructive">
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
              <span class="icon-[lucide--shapes] w-4 h-4 mr-2" />{{ t('vault.newCanvas') }}
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

      <!-- 禅模式下目录栏藏了,这根推拉杠也得跟着走 —— 留着就是一条谁都拖不动的竖线 -->
      <div v-if="treeOpen && !zenMode" @pointerdown="startDrag('tree', $event)"
        class="w-2.5 shrink-0 cursor-col-resize flex items-center justify-center group">
        <!-- 常显,不是悬停才出现 —— 不然没人知道这两栏之间能拖 -->
        <div class="w-0.5 h-10 rounded-full bg-border transition-colors group-hover:bg-foreground/40"
          :class="dragging === 'tree' ? 'bg-foreground/60' : ''" />
      </div>

      <!-- ═══════ 编辑器列 ═══════ -->
      <div class="flex-1 min-w-0 flex flex-col gap-2.5">

        <!--
          目录栏收起来之后,展开按钮变成标签条前面一张 58×58 的方卡片。

          尺寸和标签卡同高、正方形,看着就是「目录栏缩成了一个格子」——
          比原来那颗浮在左下角的按钮好找:展开的入口应该在目录栏原来的位置,
          而不是跑到屏幕另一头。
        -->
        <!--
          标签这一行 = [展开按钮] + [标签卡]。

          右边留出窗口控制点的位置:它们浮在最上层,标签滚到那儿会被压住。
          用外边距而不是内边距 —— 内边距只是把内容推开,卡片本身还是顶到最右,
          看着像"标签栏一直延伸到控件底下"。130 = 控件卡片宽 120 + 间隔 10。
          智能体栏开着的时候编辑器列本来就够不到右上角,那时候不用留。
        -->
        <div v-if="!zenMode" class="shrink-0 flex items-stretch gap-2.5"
          :class="sideOpen ? '' : 'mr-[130px]'">

          <!--
            目录栏收起来之后,展开按钮变成标签条前面一张 58×58 的方卡片。

            和标签卡同高、正方形,看着就是「目录栏缩成了一个格子」——
            展开的入口留在目录栏原来的位置,比原先那颗浮在左下角的按钮好找。
          -->
          <button v-if="!treeOpen" @click="treeOpen = true" :title="t('vault.showTree')"
            class="float-card size-[58px] shrink-0 rounded-[14px] border bg-card
                   flex items-center justify-center text-muted-foreground
                   transition-colors hover:text-foreground">
            <span class="icon-[lucide--panel-left-open] w-[18px] h-[18px]" />
          </button>

          <!-- 标签卡:和工具卡同高(58),同一条基线 -->
          <div
            class="float-card h-[58px] flex-1 min-w-0 rounded-[14px] border bg-card flex items-center gap-1 px-2 overflow-x-auto">
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
              @dblclick="tb.preview = false"
              class="h-full pl-2.5 pr-1 flex items-center gap-1.5 text-[13px]"
              :class="vault.activeTab === tb.path ? '' : 'text-muted-foreground'">
              <!-- 标签这边没有 Entry,拿 tab 自己的 kind 当画布判据 —— 它是读完内容定的 -->
              <span class="w-3.5 h-3.5 shrink-0"
                :class="[fileBadge(tb.name, tb.kind === 'canvas').icon, fileBadge(tb.name, tb.kind === 'canvas').cls]"
                :style="fileBadge(tb.name, tb.kind === 'canvas').accent ? { color: settings.vaultAccent } : undefined" />
              <!-- 预览标签用斜体,和 VSCode 一个约定:一眼看出它随时会被顶掉 -->
              <span class="max-w-40 truncate" :class="tb.preview ? 'italic' : ''">
                {{ displayName(tb.name) }}
              </span>
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
        </div>

        <!-- relative:悬浮大纲要贴着这张卡片的右缘定位 -->
        <section class="float-card relative flex-1 min-h-0 rounded-[14px] border bg-card flex flex-col overflow-hidden">
          <!--
            正文上面这一小行:左边前进后退,中间当前文件的路径,右边是智能体开关和更多。
            智能体那个开关原来是右下角一颗浮标 —— 挪上来之后所有跟"这篇文档"有关的
            操作都在同一行,不用满屏找。
          -->
          <!--
            和底部那两块一样浮在正文上、一样磨砂 —— 三块用同一套质感,
            正文才像是「铺在底下的一整页」,而不是被几条实心杠切成三段。
          -->
          <!--
            画布页整条顶栏都不要。

            那一行里对画布还有意义的只剩重命名/属性这几样,而它们在目录栏右键
            里都有;剩下的字体、字号、页宽、导出、源码模式对一张画全无意义。
            为了几个用不上的按钮压掉一条画布,不值 —— 无限画布的价值就在于铺满。
          -->
          <div v-if="activeTab && !isCanvas"
            class="absolute left-2 right-2 top-2 z-10 h-9 flex items-center gap-1 px-1.5
                   rounded-lg border border-border/40 bg-card/55 backdrop-blur-xl">
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

            <!--
              全展开。**只有这一篇真有折起来的段落时才出现** —— 没折东西的时候
              摆一颗按不出效果的按钮,只会让人怀疑自己点错了。
              收了十几段之后一个个点回去太费事,这是那种情形的出口。
            -->
            <button v-if="anyFolded" @click="expandAllHeadings" :title="t('vault.expandFolds')"
              class="tool-btn size-7">
              <span class="icon-[lucide--unfold-vertical] w-4 h-4" />
            </button>

            <button @click="toggleSide('chat')"
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
              <!--
                这张面板攒到十几项之后已经比窗口还高,不给它上限的话最下面的
                「删除」直接被窗口底边切掉、也滚不到 —— 等于点不着。
                12rem 是顶栏 + 上下留白的份。
              -->
              <PopoverContent align="end" class="w-52 p-1.5 max-h-[calc(100vh-12rem)] overflow-y-auto">
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
                <button class="menu-row" @click="menu(() => (shortcutsOpen = true))">
                  <span class="icon-[lucide--keyboard] w-4 h-4" />
                  <span class="flex-1 text-left">{{ t('vault.shortcuts') }}</span>
                  <kbd class="text-[10.5px] text-muted-foreground">F1</kbd>
                </button>

                <!--
                  记号（`**`、`==`、`<span style="color:red">` 这些）露不露，三选一。

                  做成三个并排的单选而不是「源码模式」一个开关：
                  「点上才露」和「点上也不露」是两种读写姿势，不是同一件事的开和关。
                  「源码模式」只管当次会话，另外两个是长期口味（存设置）——
                  所以点前者不动设置，点后两个会顺手把源码模式关掉。
                -->
                <div class="h-px bg-border my-1 mx-1" />
                <p class="px-2 py-1 text-[11px] text-muted-foreground">{{ t('vault.markMode') }}</p>
                <button class="menu-row" :title="t('vault.markRevealTip')"
                  @click="sourceMode = false; settings.vaultMarkMode = 'reveal'">
                  <span class="icon-[lucide--check] w-4 h-4" :class="markMode === 'reveal' ? '' : 'opacity-0'" />
                  <span class="flex-1 text-left">{{ t('vault.markReveal') }}</span>
                </button>
                <button class="menu-row" :title="t('vault.markCleanTip')"
                  @click="sourceMode = false; settings.vaultMarkMode = 'clean'">
                  <span class="icon-[lucide--check] w-4 h-4" :class="markMode === 'clean' ? '' : 'opacity-0'" />
                  <span class="flex-1 text-left">{{ t('vault.markClean') }}</span>
                </button>
                <button class="menu-row" :title="t('vault.sourceModeTip')" @click="sourceMode = true">
                  <span class="icon-[lucide--check] w-4 h-4" :class="markMode === 'source' ? '' : 'opacity-0'" />
                  <span class="flex-1 text-left">{{ t('vault.sourceMode') }}</span>
                </button>
                <div class="h-px bg-border my-1 mx-1" />
                <button class="menu-row" @click="settings.vaultStatusBar = !settings.vaultStatusBar">
                  <span class="icon-[lucide--check] w-4 h-4"
                    :class="settings.vaultStatusBar ? '' : 'opacity-0'" />
                  {{ t('vault.statusBar') }}
                </button>
                <button class="menu-row" @click="toggleZen()">
                  <span class="icon-[lucide--check] w-4 h-4" :class="zenMode ? '' : 'opacity-0'" />
                  {{ t('vault.zenMode') }}
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

                <!--
                  导出摊平成一节,不做二级弹出菜单。

                  这张 ⋯ 面板是个 Popover,里面全是普通 button —— reka 的
                  ContextMenuSub 要 MenuRoot 提供上下文,塞进来只会在 setup 里抛
                  「Injection Symbol(MenuContext) not found」,整块静默消失。
                  何况上面「正文字体」「本页宽度」也都是摊平的小节,飞出菜单
                  反而跟这张面板的其余部分对不上。
                -->
                <div class="h-px bg-border my-1 mx-1" />
                <p class="px-2 py-1 text-[11px] text-muted-foreground">{{ t('vault.export') }}</p>
                <button class="menu-row" @click="menu(() => exportAs('pdf'))">
                  <span class="icon-[lucide--file-text] w-4 h-4" />PDF
                </button>
                <button class="menu-row" @click="menu(() => exportAs('html'))">
                  <span class="icon-[lucide--code-xml] w-4 h-4" />HTML
                </button>
                <button class="menu-row" @click="menu(() => exportAs('word'))">
                  <span class="icon-[lucide--file-type] w-4 h-4" />Word
                </button>
                <!--
                  「长图」先藏起来,不是删了。

                  导出成长图这条路有已知缺陷(见 useExport 里 noteToPng 上面那段),
                  暂时不修 —— 但它和另外三种共用同一条渲染管线,把代码删掉
                  等于把那条管线也拆了。所以只摘掉入口,函数原样留着。
                  修好了把这三行放回来就行。
                <button class="menu-row" @click="menu(() => exportAs('image'))">
                  <span class="icon-[lucide--image] w-4 h-4" />{{ t('vault.exportImage') }}
                </button>
                -->
                <button class="menu-row" @click="menu(doPrint)">
                  <span class="icon-[lucide--printer] w-4 h-4" />{{ t('vault.print') }}
                </button>

                <div class="h-px bg-border my-1 mx-1" />
                <button class="menu-row" @click="menu(openBacklinks)">
                  <span class="icon-[lucide--link] w-4 h-4" />{{ t('vault.backlinks') }}
                </button>
                <button class="menu-row" @click="menu(openHistory)">
                  <span class="icon-[lucide--history] w-4 h-4" />{{ t('vault.history') }}
                </button>
                <button class="menu-row" @click="menu(openInfo)">
                  <span class="icon-[lucide--info] w-4 h-4" />{{ t('vault.fileInfo') }}
                </button>

                <div class="h-px bg-border my-1 mx-1" />
                <button class="menu-row text-destructive" @click="menu(() => { askDelete(tabEntry ?? null) })">
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
        <ContextMenu v-else-if="activeTab.kind === 'markdown'" v-model:open="ctxOpen"
          @update:open="onCtxOpen">
          <ContextMenuTrigger as-child>
            <div @keydown="onEditorKey" class="flex-1 min-h-0 overflow-hidden">
              <MarkdownEditor ref="editor" v-model="activeTab.content"
                :scroll-key="activeTab.path"
                @update:model-value="activeTab && markEdited(activeTab.path)"
                :accent="settings.vaultAccent" :resolve-asset="resolveAsset"
                :on-paste-image="onPasteImage"
                :font="settings.vaultFont" :font-size="settings.vaultFontSize"
                :full-width="effectiveFullWidth"
                :color-headings="settings.vaultColorHeadings"
                :mark-mode="markMode" :typewriter="zenMode"
                :status-bar="settings.vaultStatusBar"
                :on-open-link="(u: string) => { void openExternal(u) }"
                :wiki-suggest="wikiSuggest" :on-open-wiki="openWiki" />
            </div>
          </ContextMenuTrigger>

          <!--
            菜单的排法。

            **最上面两格是四列两行的图标格子,不是一条条的菜单项。**
            上色和加粗这类事是「点一下就走」的高频操作,一条条排下去要滑很远;
            铺成格子之后八个入口在一块巴掌大的地方,眼睛一扫就到。
            名字挂在 title 上,鼠标停一下才出来 —— 图标本身认得出来,
            平时不需要那行字占地方。

            往下只保留「段落」「插入」两个二级菜单,以及一个「更多」把链接、
            剪切复制粘贴那些收起来。**整张菜单固定四行**,不会因为功能变多就越长越离谱。
          -->
          <ContextMenuContent class="w-auto min-w-52 whitespace-nowrap">
            <!--
              颜色。第一颗是「默认颜色」= 把颜色去掉,所以它长得就是正文的颜色。
              摆在第一位是因为「改回去」和「改成红色」是同一类动作,
              不该让它跑到七颗后面去。

              只写颜色名不写十六进制:颜色名会被换成 `--xg-ink-*`,亮暗各一套。
              「能给几种」= 我们定义了几个 ink 变量。
            -->
            <div class="grid grid-cols-4 gap-1.5 px-2 py-2">
              <button type="button" :title="t('vault.fmtColorDefault')" @click="pickColor(null)"
                class="h-6 flex items-center justify-center rounded-md transition-colors hover:bg-muted">
                <span class="w-[18px] h-[18px] rounded-full border border-border/70"
                  :style="{ background: 'var(--foreground)' }" />
              </button>
              <button v-for="c in INK_COLORS" :key="c" type="button"
                :title="t('vault.ink_' + c)" @click="pickColor(c)"
                class="h-6 flex items-center justify-center rounded-md transition-colors hover:bg-muted">
                <span class="w-[18px] h-[18px] rounded-full border border-border/70"
                  :style="{ background: `var(--xg-ink-${c})` }" />
              </button>
            </div>

            <ContextMenuSeparator />

            <!-- 文本格式:七件 + 一颗橡皮,同样四列两行 -->
            <div class="grid grid-cols-4 gap-1.5 px-2 py-2">
              <button v-for="f in FORMAT_BTNS" :key="f.key" type="button"
                :title="t('vault.' + f.key)" @click="runFormat(f)"
                class="h-7 flex items-center justify-center rounded-md text-muted-foreground
                       transition-colors hover:bg-muted hover:text-foreground">
                <span :class="f.icon" class="w-4 h-4" />
              </button>
            </div>

            <ContextMenuSeparator />

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

            <!--
              链接、查找、剪切复制粘贴全收进这一层。

              它们不是「常用」而是「偶尔要」—— 剪切复制粘贴人人都有键盘上那三个键,
              新增链接一天用不了几次。摆在外面的话这张菜单会长出一屏,
              而上面那两格格子才是你右键的真正理由。
            -->
            <ContextMenuSub>
              <ContextMenuSubTrigger>
                <span class="icon-[lucide--ellipsis] w-4 h-4 mr-2" />{{ t('vault.ctxMore') }}
              </ContextMenuSubTrigger>
              <ContextMenuPortal>
                <ContextMenuSubContent class="w-auto min-w-40 whitespace-nowrap">
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
                </ContextMenuSubContent>
              </ContextMenuPortal>
            </ContextMenuSub>
          </ContextMenuContent>
        </ContextMenu>

        <!--
          无限画布。key 挂当前文件 —— 换一张画就整个重建。
          Excalidraw 的场景是在挂载时一次性喂进去的,不重建的话切了标签
          还是上一张图。
        -->
        <!-- 顶栏底栏在画布页都不出现,这里不用给它们让位,直接铺满 -->
        <div v-else-if="activeTab.kind === 'canvas' && canvas" class="flex-1 min-h-0">
          <ExcalidrawCanvas :key="activeTab.path" :scene="canvas.scene"
            :dark="isDark" @change="onCanvasChange" />
        </div>

        <!-- 二进制文件还没做查看器,如实说,别装作打开了 -->
        <div v-else class="flex-1 flex items-center justify-center px-6">
          <div class="text-center">
            <span class="icon-[lucide--file-question] w-8 h-8 mx-auto block text-muted-foreground/50" />
            <p class="mt-3 text-sm text-muted-foreground">{{ t('vault.notEditable') }}</p>
            <button @click="revealEntry(activeTab.path)" class="mt-3 text-xs text-muted-foreground underline">
              {{ t('vault.reveal') }}
            </button>
          </div>
        </div>
        <!--
          底部状态栏。和顶上那条文档小行同一个模子(圆角矩形、h-9、同样的底色),
          一上一下把正文夹住 —— 不然底下空着一截,整块卡片看着是"没写完"。

          只放**只读信息**:字数、行数、光标位置、存没存下去。
          可点的东西一律不进来 —— 状态栏一旦能点,用户就得逐个去认那些图标是什么,
          而它本来的价值是"扫一眼就知道",不是又一个工具条。
        -->
        <!--
          悬浮大纲(学 Notion)。

          平时只是右缘一列短横线,一行一个标题,长度按层级递减 —— 不占版面,
          又能一眼看出这篇有多长、结构多深。鼠标移过去才浮出真正的面板。

          **整块 pointer-events-none,只有里面两块打开** —— 不然那条透明的
          定位层会盖住正文右侧,用户点不到那半边的字。
        -->
        <div v-if="activeTab?.kind === 'markdown' && outline.length && !zenMode"
          class="absolute right-5 top-1/2 -translate-y-1/2 z-20 flex items-center pointer-events-none"
          @pointerenter="outlineHover = true" @pointerleave="outlineHover = false">

          <!-- 浮出来的面板在左边,线段在右边:面板往正文上盖,不往窗口外跑 -->
          <Transition
            enter-active-class="transition-[opacity,translate] duration-150 ease-out"
            enter-from-class="opacity-0 translate-x-2"
            leave-active-class="transition-[opacity,translate] duration-100 ease-in"
            leave-to-class="opacity-0 translate-x-2">
            <!--
              面板**自己也贴着内容页右边 20px**,不是贴着线段左边 ——
              外层容器已经在 right-5 上,所以这里 right-0 就正好对齐。
              它会盖住线段,那是有意的:面板出来之后线段没有存在的必要了。
            -->
            <div v-if="outlineHover"
              class="pointer-events-auto absolute right-0 top-1/2 -translate-y-1/2
                     max-h-[60vh] w-56 overflow-y-auto rounded-xl
                     border bg-popover shadow-lg py-2 px-1.5">
              <button v-for="(h, i) in outline" :key="i" @click="gotoHeading(h)"
                :style="{ paddingLeft: ((h.level - outlineBase) * 12 + 10) + 'px', ...outlineStyle(h.level) }"
                class="w-full text-left rounded-md py-1 pr-2 truncate transition-colors hover:bg-muted/60"
                :class="h.level <= 2 ? 'text-[13px]' : 'text-[12px]'">
                {{ h.text }}
              </button>
            </div>
          </Transition>

          <!--
            线段那一列。宽度按层级递减(20 / 18 / 16 / 14 …),和 Notion 一样。
          -->
          <!--
            右边留 10px 给滚动条:两者贴在一起时,鼠标一进来滚动条浮出来
            正好压在最短的那几条线段上,看着像线段被啃掉一截。
          -->
          <!--
            限高:标题多的长文里,这一列会一路铺到窗口上下边缘,压住顶部标签栏和
            底部那块字数统计。给它一个 56vh 的活动范围,超出的部分自己滚
            (滚动条藏掉 —— 这是一条装饰性的索引,不该冒出一根灰杆子)。
          -->
          <div class="pointer-events-auto flex flex-col items-end gap-[10px] py-2 pl-3
                      max-h-[56vh] overflow-y-auto xg-no-scrollbar"
            :class="outlineHover ? '' : 'opacity-60'">
            <span v-for="(h, i) in outline" :key="i"
              :style="{
                width: Math.max(20 - (h.level - outlineBase) * 2, 8) + 'px',
                background: i === activeHeading ? settings.vaultAccent : outlineBarColor(h.level),
              }"
              class="h-[2px] shrink-0 rounded-full transition-colors" />
          </div>

        </div>

        <!--
          统计靠右。左半边**暂时空着**是有意的:那儿留给以后要放的东西
          (光标位置、选中字数),现在硬塞一个「已保存」只是为了填满,
          而它绝大多数时候都是同一句话,看久了等于没有。
          真正要提醒的是「没存下去」,那个已经在标签上有小圆点了。
        -->
        <!--
          **浮在正文上,不占布局。**

          原来是塞在正文下面的一块,背后就是卡片的纯色底 —— backdrop-blur
          糊的是一块纯色,当然看不出磨砂。改成绝对定位压在正文上之后,
          它背后是滚动的文字,磨砂才有东西可糊。
          正文底部相应留出一截空白(见 .xg-doc-pad),免得最后一行被压住。
        -->
        <!--
          底部拆成左右两块独立的小卡片,不做成一整条。

          一整条横跨全宽,中间那大片空白什么都不承载,却把正文和卡片底边
          硬生生隔开一道线。拆成两块之后,底部看着是「两个浮在角上的小控件」,
          正文一直铺到底。
        -->
        <div v-if="activeTab?.kind === 'markdown' && settings.vaultStatusBar"
          class="absolute right-2 bottom-2 z-10 h-9 flex items-center gap-3 px-3
                 rounded-lg border border-border/40 bg-card/55 backdrop-blur-xl
                 text-[11px] text-muted-foreground/70 tabular-nums select-none pointer-events-none">
          <span>{{ t('vault.statWords', { n: docStats.words }) }}</span>
          <span class="opacity-40">·</span>
          <span>{{ t('vault.statChars', { n: docStats.chars }) }}</span>
          <span class="opacity-40">·</span>
          <span>{{ t('vault.statLines', { n: docStats.lines }) }}</span>
        </div>
        </section>
      </div>

      <!-- ═══════ 智能体栏 ═══════ -->
      <template v-if="chatOpen && !zenMode">
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
            <div v-if="chat.pending" class="mx-3 mb-2"><PendingCard compact /></div>

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
        <!-- 后缀摆在框外面看得见,但改不了 —— 它是类型不是名字 -->
        <div class="flex items-center gap-2">
          <Input v-model="renameText" autofocus @keydown.enter="doRename" class="flex-1" />
          <span v-if="renameExt" class="text-sm text-muted-foreground shrink-0">{{ renameExt }}</span>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>{{ t('convert.cancel') }}</AlertDialogCancel>
          <AlertDialogAction @click="doRename">{{ t('vault.rename') }}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>


    <!--
      回收站单开一个窗口,不占目录栏。

      它是偶尔进来一次的地方,原来那样盖在树上面,等于「翻一眼」要先挤掉
      常驻的文件树、看完还得点回来。清理未引用图片也放在这儿 ——
      两件事都是「这个库的存储在占多少地方」,凑一块用户才想得起来用。
    -->
    <Dialog :open="trashOpen" @update:open="(v: boolean) => { trashOpen = v; if (!v) orphans = null }">
      <DialogContent class="sm:max-w-2xl p-0 gap-0 overflow-hidden">
        <DialogHeader class="px-5 pt-5 pb-3">
          <DialogTitle>{{ t('vault.trash') }}</DialogTitle>
          <DialogDescription>{{ t('vault.trashHint') }}</DialogDescription>
        </DialogHeader>

        <!-- 两个页签:删掉的笔记 / 没人用的图。都是「占着地方的东西」 -->
        <div class="px-5 flex items-center gap-1 border-b">
          <button v-for="tab in (['deleted', 'orphan'] as const)" :key="tab"
            @click="switchTrashTab(tab)" :class="[
              'px-3 py-2 text-sm border-b-2 -mb-px transition-colors',
              trashTab === tab ? 'border-foreground text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            ]">
            {{ tab === 'deleted' ? t('vault.trashDeleted') : t('vault.trashOrphan') }}
          </button>
        </div>

        <div class="min-h-[18rem] max-h-[24rem] overflow-y-auto px-3 py-2">
          <p v-if="trashBusy" class="py-10 text-center text-sm text-muted-foreground">…</p>

          <!-- 删掉的笔记 -->
          <template v-else-if="trashTab === 'deleted'">
            <p v-if="!trash.length" class="py-10 text-center text-sm text-muted-foreground">
              {{ t('vault.trashEmpty') }}
            </p>
            <div v-for="it in trash" :key="it.id"
              class="group flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-muted/50">
              <span class="w-4 h-4 shrink-0 text-muted-foreground"
                :class="it.isDir ? 'icon-[lucide--folder]' : 'icon-[lucide--file-text]'" />
              <div class="flex-1 min-w-0">
                <div class="text-[13px] truncate">{{ displayName(it.id) }}</div>
                <!-- 原路径要显示:回收站是扁平的,光看文件名不知道它原来在哪一层 -->
                <div class="text-[11px] text-muted-foreground truncate">{{ it.orig }}</div>
              </div>
              <span class="text-[11px] text-muted-foreground shrink-0 tabular-nums">
                {{ ago(it.deletedAt) }}
              </span>
              <button @click="doRestore(it)" class="tool-btn size-7 opacity-0 group-hover:opacity-100"
                :title="t('vault.trashRestore')">
                <span class="icon-[lucide--undo-2] w-4 h-4" />
              </button>
              <button @click="askPurge(it.id)" :title="t('vault.trashPurge')"
                class="tool-btn size-7 opacity-0 group-hover:opacity-100 text-destructive">
                <span class="icon-[lucide--x] w-4 h-4" />
              </button>
            </div>
          </template>

          <!-- 没人引用的图 -->
          <template v-else>
            <p v-if="orphans === null" class="py-10 text-center text-sm text-muted-foreground">
              {{ t('vault.orphanIdle') }}
            </p>
            <p v-else-if="!orphans.length" class="py-10 text-center text-sm text-muted-foreground">
              {{ t('vault.orphanNone') }}
            </p>
            <div v-for="o in orphans ?? []" :key="o.rel"
              class="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-muted/50">
              <span class="icon-[lucide--image] w-4 h-4 shrink-0 text-muted-foreground" />
              <span class="text-[13px] truncate flex-1">{{ o.rel }}</span>
              <span class="text-[11px] text-muted-foreground shrink-0 tabular-nums">
                {{ humanSize(o.size) }}
              </span>
            </div>
          </template>
        </div>

        <DialogFooter class="px-5 py-3 border-t sm:justify-between">
          <span class="text-xs text-muted-foreground self-center">
            {{ trashTab === 'deleted'
              ? t('vault.trashCount', { n: trash.length })
              : orphans === null ? '' : t('vault.orphanCount', { n: orphans.length, size: humanSize(orphanTotal) }) }}
          </span>
          <div class="flex items-center gap-2">
            <button v-if="trashTab === 'deleted' && trash.length" @click="askPurge('*')"
              class="h-8 px-3 rounded-lg border text-xs text-destructive transition-colors hover:bg-destructive/10">
              {{ t('vault.trashPurgeAll') }}
            </button>
            <button v-if="trashTab === 'orphan'" @click="scanOrphans"
              class="h-8 px-3 rounded-lg border text-xs text-muted-foreground transition-colors hover:bg-muted">
              {{ t('vault.orphanScan') }}
            </button>
            <button v-if="trashTab === 'orphan' && orphans?.length" @click="confirmSweep = true"
              class="h-8 px-3 rounded-lg border text-xs text-destructive transition-colors hover:bg-destructive/10">
              {{ t('vault.orphanSweep') }}
            </button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- 清理未引用图片的确认。它们**进回收站,不是抹掉** —— 扫描一定有漏网,留条后路 -->
    <AlertDialog :open="confirmSweep" @update:open="(v: boolean) => { confirmSweep = v }">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{{ t('vault.orphanSweepTitle', { n: orphans?.length ?? 0 }) }}</AlertDialogTitle>
          <AlertDialogDescription>{{ t('vault.orphanSweepBody') }}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{{ t('common.cancel') }}</AlertDialogCancel>
          <AlertDialogAction @click="doSweep">{{ t('vault.orphanSweep') }}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <AlertDialog :open="!!purgeTarget" @update:open="(v: boolean) => { if (!v) purgeTarget = '' }">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {{ purgeTarget === '*' ? t('vault.trashPurgeAllTitle') : t('vault.trashPurgeTitle') }}
          </AlertDialogTitle>
          <AlertDialogDescription>{{ t('vault.trashPurgeBody') }}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{{ t('common.cancel') }}</AlertDialogCancel>
          <AlertDialogAction @click="doPurge"
            class="bg-destructive text-white hover:bg-destructive/90">
            {{ t('vault.trashPurge') }}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <!-- 反向链接。一行一处,点了跳过去 -->
    <Dialog :open="backOpen" @update:open="(v: boolean) => { backOpen = v }">
      <DialogContent class="sm:max-w-2xl p-0 gap-0 overflow-hidden">
        <DialogHeader class="px-5 pt-5 pb-3">
          <DialogTitle>{{ t('vault.backlinks') }}</DialogTitle>
          <DialogDescription>{{ t('vault.backlinksHint') }}</DialogDescription>
        </DialogHeader>
        <div class="border-t min-h-[16rem] max-h-[24rem] overflow-y-auto p-2">
          <p v-if="backBusy" class="py-12 text-center text-xs text-muted-foreground">…</p>
          <p v-else-if="!backlinks.length" class="py-12 text-center text-xs text-muted-foreground">
            {{ t('vault.backlinksEmpty') }}
          </p>
          <button v-for="(h, i) in backlinks" :key="h.path + h.line + i" @click="gotoBacklink(h)"
            class="w-full text-left rounded-lg px-3 py-2 transition-colors hover:bg-muted/60">
            <div class="text-[13px] truncate">{{ displayName(h.name) }}</div>
            <div class="text-[11px] text-muted-foreground truncate">{{ h.snippet }}</div>
          </button>
        </div>
      </DialogContent>
    </Dialog>

    <!--
      文件恢复。左边列版本、右边预览那一版的正文 —— 光有时间戳选不出来,
      必须能看见内容才知道要哪一份。
    -->
    <!--
      外部改动。

      磁盘上这一篇变了(别的机器同步过来、Obsidian 里改的、git pull),而我们正开着它。
      以前是本地没改动就悄悄换成磁盘那份 —— 用户看到的是「我正看着的东西自己变了」,
      而且万一那次外部改动本身是误操作,这边连挽回的机会都没有。现在两份都留着,问一句。
      弹窗一次只问一篇,答完接着问下一篇。
    -->
    <AlertDialog :open="!!conflict">
      <AlertDialogContent v-if="conflict">
        <AlertDialogHeader>
          <AlertDialogTitle>{{ t('vault.conflictTitle') }}</AlertDialogTitle>
          <AlertDialogDescription>
            {{ t('vault.conflictBody', { name: displayName(conflict.path) }) }}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <p class="text-xs text-muted-foreground font-mono wrap-break-word">{{ conflict.path }}</p>
        <AlertDialogFooter>
          <AlertDialogCancel @click="resolveConflictKeepMine(conflict.path)">
            {{ t('vault.conflictKeepMine') }}
          </AlertDialogCancel>
          <AlertDialogAction @click="resolveConflictTakeDisk(conflict.path)">
            {{ t('vault.conflictTakeDisk') }}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <Dialog :open="historyOpen" @update:open="(v: boolean) => { historyOpen = v }">
      <DialogContent class="sm:max-w-3xl p-0 gap-0 overflow-hidden">
        <DialogHeader class="px-5 pt-5 pb-3">
          <DialogTitle>{{ t('vault.history') }}</DialogTitle>
          <DialogDescription>{{ t('vault.historyHint') }}</DialogDescription>
        </DialogHeader>

        <div class="flex border-t min-h-[22rem] max-h-[26rem]">
          <div class="w-52 shrink-0 border-r overflow-y-auto py-2 px-1.5">
            <p v-if="historyBusy" class="py-8 text-center text-xs text-muted-foreground">…</p>
            <p v-else-if="!snapList.length" class="py-8 px-3 text-center text-xs text-muted-foreground leading-relaxed">
              {{ t('vault.historyEmpty') }}
            </p>
            <button v-for="sn in snapList" :key="sn.id" @click="pickSnapshot(sn)" :class="[
              'w-full text-left rounded-md px-2 py-1.5 transition-colors',
              historyPick?.id === sn.id ? 'bg-muted' : 'hover:bg-muted/50'
            ]">
              <div class="text-[12px] tabular-nums">{{ fmtTime(sn.at) }}</div>
              <div class="text-[11px] text-muted-foreground">{{ humanSize(sn.size) }}</div>
            </button>
          </div>

          <!--
            右边这块是**可以刮选、可以复制**的。

            全局有一条 `* { user-select: none }`(整个界面按桌面应用的规矩来,免得到处误选中),
            这块是例外:历史版本经常只想抠出中间一段贴回正文,不能只给「整份覆盖」这一个出口。
            所以这里明确开 select-text,再配一颗「复制全文」按钮兜住「我全都要」那种情形。
          -->
          <div class="flex-1 min-w-0 flex flex-col">
            <div v-if="historyPick" class="flex items-center justify-end gap-2 px-3 pt-2 shrink-0">
              <button v-if="historySel" @click="copyHistorySelection"
                class="h-7 px-2.5 rounded-lg border border-foreground/30 text-[11px] text-foreground
                       transition-colors hover:bg-muted flex items-center gap-1">
                <span class="icon-[lucide--text-cursor-input] w-3 h-3" />
                {{ t('vault.historyCopySel') }}
              </button>
              <button @click="copyHistoryText"
                class="h-7 px-2.5 rounded-lg border border-border text-[11px] text-muted-foreground
                       transition-colors hover:bg-muted hover:text-foreground flex items-center gap-1">
                <span :class="historyCopied ? 'icon-[lucide--check]' : 'icon-[lucide--copy]'" class="w-3 h-3" />
                {{ historyCopied ? t('vault.historyCopied') : t('vault.historyCopy') }}
              </button>
            </div>
            <div class="flex-1 min-w-0 overflow-auto px-4 pb-4 pt-2">
              <pre v-if="historyPick" ref="historyPre" tabindex="0"
                   @mouseup="readHistorySelection" @keyup="readHistorySelection"
                   @keydown="onHistoryCopyKey"
                   class="text-[12px] leading-relaxed whitespace-pre-wrap wrap-break-word outline-none
                   font-mono text-muted-foreground select-text cursor-text">{{ historyText }}</pre>
              <p v-else class="h-full flex items-center justify-center text-sm text-muted-foreground">
                {{ t('vault.historyPick') }}
              </p>
            </div>
          </div>
        </div>

        <DialogFooter class="px-5 py-3 border-t sm:justify-between">
          <button v-if="snapList.length" @click="clearHistory"
            class="h-8 px-3 rounded-lg border text-xs text-destructive transition-colors hover:bg-destructive/10">
            {{ t('vault.historyClear') }}
          </button>
          <span v-else />
          <button :disabled="!historyPick" @click="restoreSnapshot"
            class="h-8 px-3 rounded-lg border text-xs transition-colors hover:bg-muted
                   disabled:opacity-40 disabled:pointer-events-none">
            {{ t('vault.historyRestore') }}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog :open="infoOpen" @update:open="(v: boolean) => { infoOpen = v }">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{{ t('vault.fileInfo') }}</DialogTitle>
        </DialogHeader>
        <dl v-if="info" class="text-[13px] space-y-2.5">
          <div class="flex gap-3">
            <dt class="w-20 shrink-0 text-muted-foreground">{{ t('vault.infoName') }}</dt>
            <dd class="min-w-0 wrap-break-word">{{ info.rel.split('/').pop() }}</dd>
          </div>
          <div class="flex gap-3">
            <dt class="w-20 shrink-0 text-muted-foreground">{{ t('vault.infoPath') }}</dt>
            <dd class="min-w-0 wrap-break-word">{{ info.rel }}</dd>
          </div>
          <div class="flex gap-3">
            <dt class="w-20 shrink-0 text-muted-foreground">{{ t('vault.infoWords') }}</dt>
            <dd>{{ t('vault.statWords', { n: docStats.words }) }} ·
              {{ t('vault.statChars', { n: docStats.chars }) }} ·
              {{ t('vault.statLines', { n: docStats.lines }) }}</dd>
          </div>
          <div class="flex gap-3">
            <dt class="w-20 shrink-0 text-muted-foreground">{{ t('vault.infoSize') }}</dt>
            <dd>{{ humanSize(info.size) }}</dd>
          </div>
          <div class="flex gap-3">
            <dt class="w-20 shrink-0 text-muted-foreground">{{ t('vault.infoCreated') }}</dt>
            <dd>{{ fmtTime(info.created) }}</dd>
          </div>
          <div class="flex gap-3">
            <dt class="w-20 shrink-0 text-muted-foreground">{{ t('vault.infoModified') }}</dt>
            <dd>{{ fmtTime(info.modified) }}</dd>
          </div>
        </dl>
        <p v-else class="py-6 text-center text-sm text-muted-foreground">…</p>
      </DialogContent>
    </Dialog>

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

    <ShortcutsDialog v-model:open="shortcutsOpen" />
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
