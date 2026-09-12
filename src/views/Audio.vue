<script setup lang="ts">
/**
 * 音频试听。
 *
 * 左边是目录树（可以同时挂好几个工作区），右边一行一个音频：点一下试听、
 * 拖波形两头裁掉头尾、按住拖出去扔进 Godot 这类软件。
 *
 * # 裁剪只影响「拖出去的那一份」
 *
 * 原文件一个字节都不动。裁好之后后台先把片段渲染到临时目录（按住拖的那一刻
 * 必须已经有个真文件可交，现渲染来不及），拖出去的就是那个临时文件。
 *
 * # 拖回自己的目录树
 *
 * 拖出去用的是系统级拖放（和从资源管理器拖文件一模一样），所以松手落回
 * 我们自己窗口时，收到的也是一次普通的「有文件拖进来」。靠「拖进来的是不是
 * 我们刚交出去的那几个」来区分：
 *
 *  · 裁过的   —— 在落点那个文件夹里**生成一个新片段**，格式按右上角选的，原文件不动
 *  · 没裁过的 —— **挪过去**。这是在归类整理，不是在复制素材
 *
 * 不是我们交出去的，就是从资源管理器拖进来的：拷进去（文件夹就当新工作区挂上）。
 *
 * # 目录树里拖文件夹：用指针事件
 *
 * 窗口开着系统级拖放（dragDropEnabled），那一层会吃掉页面里的 HTML5 拖拽。
 * 和笔记页一个处境、一个办法，见 Vault.vue 的「目录栏拖放」。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { invoke, convertFileSrc } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { startDrag } from '@crabnebula/tauri-plugin-drag'
import { settings } from '@/composables/useAppSettings'
import { zen } from '@/composables/useZen'
import { useI18n } from '@/i18n'
import InfoTip from '@/components/InfoTip.vue'
import AudioRow, { type Press } from '@/components/audio/AudioRow.vue'
import type { AudioFile, Trim } from '@/lib/audioPeaks'
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger,
} from '@/components/ui/context-menu'

const { t } = useI18n()
const zenMode = computed(() => zen.on)

// ── 目录栏开合 / 窄窗口 ──
//
// 页面宽度不够同时摆下目录栏（280）和列表时，目录栏**自动收起**，列表占满。
// 这时再点展开，目录栏是**盖在列表上面**拉出来的一层，不去挤列表 ——
// 挤的话列表只剩一条缝，波形和按钮全压扁，那还不如不展开。点外面、按 Esc 就收回去。
// 够宽的时候照笔记页那套：顶卡上一颗收起，收起后左边留一张 58×58 的方卡片用来展开。

const rootEl = ref<HTMLElement | null>(null)
/** 页面（含左边让出的导航栏位置）窄过这个就自动收起目录栏 */
const NARROW_PX = 1040
const narrow = ref(false)
/** 窄窗口下临时拉出来的那一层 */
const drawer = ref(false)
/** 目录栏在正常排版里（宽窗口、没被手动收起） */
const treeInFlow = computed(() => !narrow.value && settings.audioTreeOpen)
const treeVisible = computed(() => treeInFlow.value || (narrow.value && drawer.value))
function showTree() {
  if (narrow.value) drawer.value = true
  else settings.audioTreeOpen = true
}
function hideTree() {
  if (narrow.value) drawer.value = false
  else settings.audioTreeOpen = false
}
let resizeObs: ResizeObserver | null = null

type SubDir = { name: string; path: string }
type Listing = { dirs: SubDir[]; files: AudioFile[] }
type DeepListing = { files: AudioFile[]; truncated: boolean }
type PathKind = { path: string; is_dir: boolean; is_audio: boolean }
type ExportFormat = 'wav' | 'ogg' | 'mp3' | 'flac' | 'original'

const FORMATS: { id: ExportFormat; label: string }[] = [
  { id: 'wav', label: 'WAV' },
  { id: 'ogg', label: 'OGG' },
  { id: 'mp3', label: 'MP3' },
  { id: 'flac', label: 'FLAC' },
  { id: 'original', label: '' }, // 文字走 i18n
]

// ── 路径小工具 ──
//
// 路径原样保留系统给的写法（Windows 上是反斜杠）：它们要原封不动交还给后端、
// 交给系统拖放，改写了反而可能对不上。只在比较时统一一下。

function baseName(p: string) {
  const s = p.replace(/[\\/]+$/, '')
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'))
  return i >= 0 ? s.slice(i + 1) : s
}
function parentOf(p: string) {
  const s = p.replace(/[\\/]+$/, '')
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'))
  return i > 0 ? s.slice(0, i) : ''
}
function stemOf(name: string) {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(0, i) : name
}
const norm = (p: string) => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
const samePath = (a: string, b: string) => !!a && !!b && norm(a) === norm(b)
const isUnder = (p: string, dir: string) => !!p && !!dir && norm(p).startsWith(norm(dir) + '\\')

// ── 目录 ──

const listings = reactive(new Map<string, Listing>())
/** 「含子文件夹」模式下，每个文件夹底下所有层级的音频 */
const deep = reactive(new Map<string, DeepListing>())
const failed = reactive(new Map<string, string>())
const expanded = reactive(new Set<string>())
const selected = computed(() => settings.audioSelected)

async function load(dir: string) {
  if (!dir) return
  try {
    listings.set(dir, await invoke<Listing>('audio_list_dir', { path: dir }))
    failed.delete(dir)
  } catch (e) {
    failed.set(dir, String(e))
    listings.set(dir, { dirs: [], files: [] })
  }
}

async function loadDeep(dir: string) {
  try {
    deep.set(dir, await invoke<DeepListing>('audio_list_deep', { path: dir }))
  } catch (e) {
    failed.set(dir, String(e))
    deep.set(dir, { files: [], truncated: false })
  }
}

/** 右边当前那个文件夹重读一遍（两种模式各读各的） */
async function reloadSelected() {
  const s = selected.value
  if (!s) return
  await load(s)
  if (settings.audioDeep) await loadDeep(s)
}

async function select(p: string) {
  if (!samePath(settings.audioSelected, p)) picked.clear()
  settings.audioSelected = p
  // 每次点进来都重读：文件夹里的东西可能在外面被改过
  await reloadSelected()
}

async function addRoot(path: string) {
  const hit = settings.audioRoots.find((r) => samePath(r, path))
  const root = hit ?? path
  if (!hit) settings.audioRoots = [...settings.audioRoots, path]
  await invoke('audio_allow_dir', { path: root }).catch(() => {})
  expanded.add(root)
  await select(root)
}

async function pickRoot() {
  const got = await open({ directory: true, multiple: true })
  if (!got) return
  for (const p of Array.isArray(got) ? got : [got]) await addRoot(p)
}

/** 从列表里拿掉。**只是不再显示**，磁盘上的文件夹原样不动 */
function removeRoot(path: string) {
  settings.audioRoots = settings.audioRoots.filter((r) => r !== path)
  if (samePath(settings.audioSelected, path) || isUnder(settings.audioSelected, path)) settings.audioSelected = ''
  for (const e of [...expanded]) if (samePath(e, path) || isUnder(e, path)) expanded.delete(e)
}

type TRow = { path: string; name: string; depth: number; root: boolean }
const rows = computed<TRow[]>(() => {
  const out: TRow[] = []
  const walk = (path: string, name: string, depth: number, root: boolean) => {
    out.push({ path, name, depth, root })
    if (!expanded.has(path)) return
    for (const d of listings.get(path)?.dirs ?? []) walk(d.path, d.name, depth + 1, false)
  }
  for (const r of settings.audioRoots) walk(r, baseName(r) || r, 0, true)
  return out
})

/** 点文件夹：选中（右边换成它的音频）并展开；已经选中又开着的，再点一下收起来 */
async function onRowClick(r: TRow) {
  // 刚拖完文件夹松手，随后那次 click 要吞掉，不然会顺手把它选中/收起
  if (treeDidDrag) {
    treeDidDrag = false
    return
  }
  if (renaming.value) return
  if (samePath(selected.value, r.path) && expanded.has(r.path)) {
    expanded.delete(r.path)
    return
  }
  await select(r.path)
  expanded.add(r.path)
}

function collapseAll() {
  expanded.clear()
}

async function refresh() {
  const dirs = new Set<string>([...settings.audioRoots, ...expanded])
  for (const d of dirs) await load(d)
  await reloadSelected()
}

async function toggleDeep() {
  settings.audioDeep = !settings.audioDeep
  picked.clear()
  if (settings.audioDeep && selected.value) await loadDeep(selected.value)
}

const files = computed<AudioFile[]>(() => {
  const s = selected.value
  if (!s) return []
  return settings.audioDeep ? deep.get(s)?.files ?? [] : listings.get(s)?.files ?? []
})
const truncated = computed(() => settings.audioDeep && !!deep.get(selected.value)?.truncated)
const selectedName = computed(() => (selected.value ? baseName(selected.value) || selected.value : ''))

// ── 多选 ──

/** 选中的音频（路径）。点一下单选并试听，Ctrl 加减，Shift 连选，Ctrl+A 全选 */
const picked = reactive(new Set<string>())
let anchor = ''

function onPress(f: AudioFile, p: Press) {
  if (p.ctrl) {
    if (picked.has(f.path)) picked.delete(f.path)
    else picked.add(f.path)
    anchor = f.path
    return
  }
  if (p.shift && anchor) {
    const list = files.value
    const i = list.findIndex((x) => x.path === anchor)
    const j = list.findIndex((x) => x.path === f.path)
    if (i >= 0 && j >= 0) {
      picked.clear()
      for (let k = Math.min(i, j); k <= Math.max(i, j); k++) picked.add(list[k].path)
      return
    }
  }
  picked.clear()
  picked.add(f.path)
  anchor = f.path
  if (p.wave) void play(f, p.t)
  else toggle(f)
}

function onKey(e: KeyboardEvent) {
  const el = e.target as HTMLElement | null
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
    if (!files.value.length) return
    e.preventDefault()
    files.value.forEach((f) => picked.add(f.path))
  } else if (e.key === 'Escape') {
    if (drawer.value) {
      drawer.value = false
      return
    }
    picked.clear()
  } else if (e.key === ' ') {
    // 空格：放 / 停当前那一行
    const f = files.value.find((x) => x.path === (nowPath.value || anchor))
    if (!f) return
    e.preventDefault()
    toggle(f)
  }
}

// ── 右键：新建 / 改名 / 在资源管理器里看 ──

const renaming = ref('')
const renameText = ref('')
const renameInput = ref<HTMLInputElement | HTMLInputElement[] | null>(null)

async function startRename(path: string, name: string) {
  renaming.value = path
  renameText.value = name
  await nextTick()
  const el = Array.isArray(renameInput.value) ? renameInput.value[0] : renameInput.value
  el?.focus()
  el?.select()
}

/** 文件夹改名 / 挪走之后，选中、展开、裁剪这些状态跟着搬到新路径上 —— 不搬的话树会收起来、右边变空 */
function remap(from: string, to: string) {
  const move = (p: string) => (samePath(p, from) ? to : isUnder(p, from) ? to + p.slice(from.length) : p)
  if (settings.audioSelected) settings.audioSelected = move(settings.audioSelected)
  const next = [...expanded].map(move)
  expanded.clear()
  next.forEach((p) => expanded.add(p))
  for (const k of [...listings.keys()]) if (samePath(k, from) || isUnder(k, from)) listings.delete(k)
  for (const k of [...deep.keys()]) if (samePath(k, from) || isUnder(k, from)) deep.delete(k)
  for (const k of [...trims.keys()]) if (isUnder(k, from)) trims.delete(k)
  if (isUnder(nowPath.value, from)) stopPlayback()
}

/** 挪动 / 改名之后，把所有还开着的、看得见的都重读一遍 */
async function reloadVisible() {
  for (const e of expanded) if (!listings.has(e)) await load(e)
  await reloadSelected()
}

async function commitRename() {
  const path = renaming.value
  if (!path) return
  renaming.value = ''
  const name = renameText.value.trim()
  if (!name || name === baseName(path)) return
  try {
    const next = await invoke<string>('audio_rename', { path, newName: name })
    remap(path, next)
    await load(parentOf(path))
    await reloadVisible()
  } catch (e) {
    flash(String(e), true)
  }
}

function onRenameKey(e: KeyboardEvent) {
  if (e.key === 'Enter') void commitRename()
  else if (e.key === 'Escape') renaming.value = ''
}

async function newFolderIn(dir: string) {
  try {
    const p = await invoke<string>('audio_make_dir', { parent: dir, name: t('audio.newFolderName') })
    await load(dir)
    expanded.add(dir)
    await startRename(p, baseName(p))
  } catch (e) {
    flash(String(e), true)
  }
}

function reveal(p: string) {
  void invoke('reveal_in_explorer', { path: p }).catch(() => {})
}

async function copyPath(p: string) {
  try {
    await navigator.clipboard.writeText(p)
    flash(t('audio.pathCopied'))
  } catch { /* 剪贴板被占着，不值得打扰 */ }
}

// ── 目录树里拖文件夹 ──

/** 按下之后移动这么多像素才当成拖拽 */
const DRAG_THRESHOLD = 5
const treeDrag = ref('')
const treeDrop = ref('')
const ghost = reactive({ x: 0, y: 0, name: '' })
let pendingTree: { path: string; name: string; x: number; y: number } | null = null
let treeDidDrag = false

function onTreeDown(e: PointerEvent, r: TRow) {
  // 工作区根不能拖：它只是「挂在列表里的一个入口」，挪它等于挪用户的整个素材库
  if (e.button !== 0 || r.root || renaming.value) return
  pendingTree = { path: r.path, name: r.name, x: e.clientX, y: e.clientY }
  treeDidDrag = false
  window.addEventListener('pointermove', onTreeMove)
  window.addEventListener('pointerup', onTreeUp, { once: true })
}

/** 光标底下能放进去的文件夹；放到自己身上、自己的子孙里、原来那一层都不算 */
function treeDirUnder(x: number, y: number): string {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-audio-dir]')
  const p = el?.dataset.audioDir ?? ''
  const src = treeDrag.value
  if (!p || samePath(p, src) || isUnder(p, src) || samePath(p, parentOf(src))) return ''
  return p
}

function onTreeMove(e: PointerEvent) {
  if (!pendingTree) return
  if (!treeDrag.value) {
    if (Math.hypot(e.clientX - pendingTree.x, e.clientY - pendingTree.y) < DRAG_THRESHOLD) return
    treeDrag.value = pendingTree.path
    ghost.name = pendingTree.name
    treeDidDrag = true
  }
  ghost.x = e.clientX
  ghost.y = e.clientY
  treeDrop.value = treeDirUnder(e.clientX, e.clientY)
}

async function onTreeUp() {
  window.removeEventListener('pointermove', onTreeMove)
  /*
    「吞掉拖完那一下 click」只管紧跟着的那一次。
    从一行拖到**另一行**上松手，浏览器不会给任何一行发 click（按下和松开不在同一个元素上），
    这个标记要是一直留着，下一次正经点文件夹就会被白白吞掉 —— 表现是拖完之后点哪都没反应。
    click 如果有，会在这一轮事件里紧接着 pointerup 发出来，所以下一拍清掉刚好。
  */
  window.setTimeout(() => { treeDidDrag = false }, 0)
  const src = treeDrag.value
  const dst = treeDrop.value
  pendingTree = null
  treeDrag.value = ''
  treeDrop.value = ''
  if (!src || !dst) return
  try {
    const [next] = await invoke<string[]>('audio_move', { paths: [src], destDir: dst })
    if (next && !samePath(next, src)) {
      remap(src, next)
      await load(parentOf(src))
      await load(dst)
      expanded.add(dst)
      await reloadVisible()
      flash(t('audio.movedFolder', { dir: baseName(dst) }))
    }
  } catch (e) {
    flash(String(e), true)
  }
}

// ── 一闪而过的提示（生成了什么、挪了几个、出了什么错） ──

const notice = ref<{ text: string; bad: boolean } | null>(null)
let noticeTimer = 0
function flash(text: string, bad = false) {
  notice.value = { text, bad }
  window.clearTimeout(noticeTimer)
  noticeTimer = window.setTimeout(() => (notice.value = null), 3500)
}

// ── 试听 ──

const player = new Audio()
player.preload = 'auto'
const nowPath = ref('')
const playing = ref(false)
const position = ref(0)
let raf = 0

function tick() {
  position.value = player.currentTime
  // 裁过的就只放裁剩的那一段：到终点就停，播放头留在终点
  const tr = trims.get(nowPath.value)
  if (tr && player.currentTime >= tr.end) {
    player.pause()
    position.value = tr.end
    return
  }
  if (!player.paused) raf = requestAnimationFrame(tick)
}
player.addEventListener('pause', () => { playing.value = false })
player.addEventListener('ended', () => { playing.value = false })
player.addEventListener('error', () => {
  playing.value = false
  if (nowPath.value && player.getAttribute('src')) flash(t('audio.cantPlay'), true)
})

/** 放手这个文件：要挪走它之前必须先停，不然文件被占着挪不动 */
function stopPlayback() {
  player.pause()
  player.removeAttribute('src')
  player.load()
  nowPath.value = ''
  position.value = 0
  cancelAnimationFrame(raf)
}

/** 等它知道时长了再跳：新换的 src 还没读到头信息时，直接设 currentTime 会被当场丢掉 */
function whenReady() {
  if (player.readyState >= 1) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const done = () => {
      player.removeEventListener('loadedmetadata', done)
      player.removeEventListener('error', done)
      resolve()
    }
    player.addEventListener('loadedmetadata', done)
    player.addEventListener('error', done)
  })
}

async function play(f: AudioFile, from?: number) {
  if (nowPath.value !== f.path) {
    player.src = convertFileSrc(f.path)
    nowPath.value = f.path
    position.value = 0
  }
  const tr = trims.get(f.path)
  const start = from ?? tr?.start ?? 0
  try {
    if (start > 0) await whenReady()
    player.currentTime = start
    await player.play()
    playing.value = true
    cancelAnimationFrame(raf)
    raf = requestAnimationFrame(tick)
  } catch { /* 'error' 事件会报 */ }
}

function toggle(f: AudioFile) {
  if (nowPath.value === f.path && playing.value) {
    player.pause()
    return
  }
  // 同一行暂停之后再点：接着刚才停的地方放；已经放到头了才从起点重来
  if (nowPath.value === f.path && !player.ended) {
    const end = trims.get(f.path)?.end ?? player.duration
    if (player.currentTime > 0 && player.currentTime < end - 0.02) {
      void play(f, player.currentTime)
      return
    }
  }
  void play(f)
}

// ── 裁剪 ──

const trims = reactive(new Map<string, Trim>())
/** 每个文件的时长。波形解出来时才知道，判断「到底裁没裁」要用 */
const durations = new Map<string, number>()

/** 真的裁过（不是原封不动的整段）才算数 */
function trimOf(path: string): Trim | null {
  const tr = trims.get(path)
  const d = durations.get(path) ?? 0
  if (!tr || !d) return null
  return tr.start > 0.005 || tr.end < d - 0.005 ? tr : null
}

function resetTrim(path: string) {
  trims.delete(path)
}

/*
  裁好的片段提前渲染好。

  拖拽是按住鼠标那一刻就要交出一个**已经存在的文件** —— 等按下了再去调 ffmpeg，
  音效几百毫秒还行，长一点的素材还没渲染完手就松了，拖出去的是个空。
  所以把手一停就在后台先渲一份，按住拖的时候大多数情况直接拿现成的。
*/
const rendered = new Map<string, string>()
const renderTimers = new Map<string, number>()
const clipKey = (path: string, tr: Trim) =>
  `${path}|${tr.start.toFixed(3)}|${tr.end.toFixed(3)}|${settings.audioExportFormat}`

function exportTemp(path: string, tr: Trim) {
  return invoke<string>('audio_export', {
    src: path, start: tr.start, end: tr.end, format: settings.audioExportFormat, destDir: null, name: null,
  })
}

function onTrim(f: AudioFile, v: Trim) {
  trims.set(f.path, v)
  window.clearTimeout(renderTimers.get(f.path))
  renderTimers.set(f.path, window.setTimeout(async () => {
    const tr = trimOf(f.path)
    if (!tr) return
    const k = clipKey(f.path, tr)
    if (rendered.has(k)) return
    try {
      rendered.set(k, await exportTemp(f.path, tr))
    } catch { /* 拖的时候会再试一次，那时再报 */ }
  }, 300))
}

// ── 拖出去（一个或一批） ──

type Outgoing = { src: string; path: string; trimmed: boolean }
/** 正在拖出去的那一批。落回自己窗口时靠它认出「这是我们自己的」 */
let outgoing: Outgoing[] | null = null

const icons = new Map<number, string>()
/** 拖动时跟着光标的小图标：主题色方块里几根波形竖条；一次拖好几个时右上角标个数 */
function dragIcon(n: number) {
  const cached = icons.get(n)
  if (cached) return cached
  const c = document.createElement('canvas')
  c.width = c.height = 72
  const g = c.getContext('2d')!
  g.fillStyle = settings.vaultAccent
  g.beginPath()
  g.roundRect(6, 14, 52, 52, 14)
  g.fill()
  g.fillStyle = '#fff'
  ;[12, 24, 34, 20, 30, 14].forEach((h, i) => g.fillRect(15 + i * 6.5, 40 - h / 2, 3.5, h))
  if (n > 1) {
    g.fillStyle = '#fff'
    g.beginPath()
    g.arc(56, 16, 14, 0, Math.PI * 2)
    g.fill()
    g.fillStyle = settings.vaultAccent
    g.font = 'bold 15px system-ui, sans-serif'
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillText(n > 99 ? '99+' : String(n), 56, 17)
  }
  const url = c.toDataURL('image/png')
  icons.set(n, url)
  return url
}

async function dragOut(f: AudioFile) {
  // 拖的是选中那一批里的一个：整批一起走；拖的是没选中的：只拖它，并且改成选中它
  if (!picked.has(f.path)) {
    picked.clear()
    picked.add(f.path)
    anchor = f.path
  }
  const group = files.value.filter((x) => picked.has(x.path))
  const items: Outgoing[] = []
  for (const x of group) {
    const tr = trimOf(x.path)
    let path = x.path
    if (tr) {
      const k = clipKey(x.path, tr)
      try {
        path = rendered.get(k) ?? (await exportTemp(x.path, tr))
        rendered.set(k, path)
      } catch (e) {
        flash(String(e), true)
        return
      }
    }
    items.push({ src: x.path, path, trimmed: !!tr })
  }
  outgoing = items
  try {
    await startDrag({ item: items.map((i) => i.path), icon: dragIcon(items.length) })
  } catch (e) {
    flash(String(e), true)
  } finally {
    // 落回自己窗口的那次「拖进来」可能比这里晚一拍到，留一小会儿再清
    window.setTimeout(() => { if (outgoing === items) outgoing = null }, 1500)
  }
}

// ── 拖进来（资源管理器的文件 / 自己拖出去又落回来的） ──

type Hit = { kind: 'dir'; path: string } | { kind: 'list' } | { kind: 'tree' } | { kind: 'none' }
const dropHit = ref<Hit>({ kind: 'none' })

/** 系统给的落点是物理像素，换成 CSS 像素再去找底下是哪一块 */
function hitTest(pos: { x: number; y: number }): Hit {
  const dpr = window.devicePixelRatio || 1
  const el = document.elementFromPoint(pos.x / dpr, pos.y / dpr) as HTMLElement | null
  if (!el) return { kind: 'none' }
  const row = el.closest<HTMLElement>('[data-audio-dir]')
  if (row?.dataset.audioDir) return { kind: 'dir', path: row.dataset.audioDir }
  if (el.closest('[data-audio-list]')) return { kind: 'list' }
  if (el.closest('[data-audio-tree]')) return { kind: 'tree' }
  return { kind: 'none' }
}

/** 拖进来的这几个路径，是不是正好就是我们刚交出去的那一批 */
function ours(paths: string[]): Outgoing[] | null {
  const o = outgoing
  if (!o || paths.length !== o.length) return null
  return paths.every((p) => o.some((i) => samePath(i.path, p))) ? o : null
}

/** 自己的那一批落到目录树的某个文件夹上：裁过的生成新片段，没裁过的挪过去 */
async function dropOwn(items: Outgoing[], dir: string) {
  let made = 0
  let lastMade = ''
  for (const c of items.filter((i) => i.trimmed)) {
    const tr = trims.get(c.src)
    if (!tr) continue
    try {
      lastMade = await invoke<string>('audio_export', {
        src: c.src, start: tr.start, end: tr.end,
        format: settings.audioExportFormat, destDir: dir, name: stemOf(baseName(c.src)) + '_cut',
      })
      made++
    } catch (e) {
      flash(String(e), true)
    }
  }

  let moved = 0
  const plain = items.filter((i) => !i.trimmed && !samePath(parentOf(i.src), dir))
  if (plain.length) {
    if (plain.some((p) => samePath(p.src, nowPath.value))) stopPlayback()
    try {
      const res = await invoke<string[]>('audio_move', { paths: plain.map((p) => p.src), destDir: dir })
      plain.forEach((p, i) => {
        if (samePath(res[i], p.src)) return
        moved++
        picked.delete(p.src)
        trims.delete(p.src)
      })
      for (const par of new Set(plain.map((p) => parentOf(p.src)))) await load(par)
    } catch (e) {
      flash(String(e), true)
    }
  }

  await load(dir)
  expanded.add(dir)
  await reloadSelected()
  if (moved) flash(t('audio.moved', { n: moved, dir: baseName(dir) }))
  else if (made === 1) flash(t('audio.made', { name: baseName(lastMade) }))
  else if (made > 1) flash(t('audio.madeN', { n: made }))
}

async function onDrop(paths: string[], hit: Hit) {
  const mine = ours(paths)
  if (mine) {
    outgoing = null
    // 只认目录树上的文件夹。松回列表里（多半是手一滑）什么都不做，不然会平白多出一份
    if (hit.kind === 'dir') await dropOwn(mine, hit.path)
    return
  }

  const kinds = await invoke<PathKind[]>('audio_classify', { paths })
  // 拖进来的是文件夹：当成新的工作区挂上
  for (const k of kinds) if (k.is_dir) await addRoot(k.path)
  const audios = kinds.filter((k) => k.is_audio).map((k) => k.path)
  if (!audios.length) return
  const dest = hit.kind === 'dir' ? hit.path : hit.kind === 'list' ? selected.value : ''
  if (!dest) {
    flash(t('audio.pickTargetFirst'), true)
    return
  }
  try {
    const made = await invoke<string[]>('audio_copy_into', { paths: audios, destDir: dest })
    await load(dest)
    await reloadSelected()
    flash(t('audio.copied', { n: made.length }))
  } catch (e) {
    flash(String(e), true)
  }
}

let unlistenDrop: (() => void) | null = null
let disposed = false
async function bindDrop() {
  const { getCurrentWebview } = await import('@tauri-apps/api/webview')
  const un = await getCurrentWebview().onDragDropEvent((e) => {
    const p = e.payload
    if (p.type === 'leave') {
      dropHit.value = { kind: 'none' }
      return
    }
    const hit = hitTest(p.position)
    if (p.type === 'drop') {
      dropHit.value = { kind: 'none' }
      void onDrop(p.paths, hit)
      return
    }
    // 自己拖出去的只有落在文件夹上才有意义，别的地方不给高亮，免得误导
    dropHit.value = outgoing && hit.kind !== 'dir' ? { kind: 'none' } : hit
  })
  // 页面在监听挂上之前就被切走了：立刻摘掉，不然在别的页拖文件也会被这里吃掉
  if (disposed) un()
  else unlistenDrop = un
}

/** 这个文件夹现在是不是落点（系统拖放 / 树里拖文件夹，两种都算） */
const isDropDir = (p: string) =>
  samePath(treeDrop.value, p) || (dropHit.value.kind === 'dir' && samePath(dropHit.value.path, p))

// ── 进出页面 ──

onMounted(async () => {
  resizeObs = new ResizeObserver(() => {
    const w = rootEl.value?.clientWidth ?? 0
    narrow.value = w > 0 && w < NARROW_PX
    // 宽回来了：抽屉那层没用了，目录栏回到正常排版
    if (!narrow.value) drawer.value = false
  })
  if (rootEl.value) resizeObs.observe(rootEl.value)
  void bindDrop()
  window.addEventListener('keydown', onKey)
  for (const r of settings.audioRoots) {
    await invoke('audio_allow_dir', { path: r }).catch(() => {})
    await load(r)
    expanded.add(r)
  }
  // 上次停在哪个文件夹：一路把它的上级都展开，再把它自己读出来
  const sel = settings.audioSelected
  const root = sel && settings.audioRoots.find((r) => samePath(r, sel) || isUnder(sel, r))
  if (!root) {
    settings.audioSelected = ''
    return
  }
  const chain: string[] = []
  for (let p = parentOf(sel); p && !samePath(p, root); p = parentOf(p)) chain.unshift(p)
  for (const c of chain) {
    await load(c)
    expanded.add(c)
  }
  await reloadSelected()
})

onBeforeUnmount(() => {
  resizeObs?.disconnect()
  disposed = true
  unlistenDrop?.()
  unlistenDrop = null
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('pointermove', onTreeMove)
  player.pause()
  player.removeAttribute('src')
  cancelAnimationFrame(raf)
  window.clearTimeout(noticeTimer)
  renderTimers.forEach((id) => window.clearTimeout(id))
})
</script>

<template>
  <!-- 网格和笔记页一样：10 的间距，58 的顶卡，左让位 78 -->
  <div ref="rootEl" class="absolute inset-0 pt-2.5 pr-2.5 pb-2.5 flex gap-2.5"
    :class="[zenMode ? 'pl-2.5' : 'pl-[4.875rem]', treeDrag ? 'select-none' : '']">

    <!-- ═══════ 还没有工作区 ═══════ -->
    <div v-if="!settings.audioRoots.length" data-audio-tree
      class="flex-1 float-card rounded-[14px] border bg-card flex items-center justify-center"
      :style="dropHit.kind === 'tree' ? { outline: '2px solid ' + settings.vaultAccent, outlineOffset: '-2px' } : undefined">
      <div class="max-w-sm text-center px-6">
        <span class="icon-[lucide--audio-lines] w-10 h-10 mx-auto block text-muted-foreground/60" />
        <p class="mt-5 text-[15px] leading-relaxed">{{ t('audio.pickHint') }}</p>
        <button @click="pickRoot"
          class="mt-5 h-10 px-5 rounded-xl bg-primary text-primary-foreground text-sm font-medium">
          {{ t('audio.addRoot') }}
        </button>
      </div>
    </div>

    <template v-else>
      <!-- 窄窗口下拉出目录栏时垫在底下的一层：点它就收回去 -->
      <div v-if="narrow && drawer" class="absolute inset-0 z-20" @pointerdown="drawer = false" />

      <!-- ═══════ 左：目录树 ═══════ -->
      <div v-if="treeVisible" class="w-[280px] flex flex-col gap-2.5"
        :class="treeInFlow ? 'shrink-0'
          : ['tree-drawer absolute z-30 top-2.5 bottom-2.5 drop-shadow-2xl', zenMode ? 'left-2.5' : 'left-[4.875rem]']">
        <div class="float-card h-[58px] shrink-0 rounded-[14px] border bg-card flex items-center gap-1 px-3">
          <button @click="pickRoot" :title="t('audio.addRoot')" class="tool-btn">
            <span class="icon-[lucide--folder-plus] w-4 h-4" />
          </button>
          <div class="flex-1" />
          <!-- 右边列表：只看这一层 / 连子文件夹一起列。开着的时候按钮亮着 -->
          <button @click="toggleDeep" class="tool-btn"
            :class="settings.audioDeep ? 'is-on' : ''"
            :style="settings.audioDeep ? { color: settings.vaultAccent } : undefined"
            :title="settings.audioDeep ? t('audio.deepOn') : t('audio.deepOff')">
            <span class="icon-[lucide--folder-tree] w-4 h-4" />
          </button>
          <button @click="refresh" :title="t('audio.refresh')" class="tool-btn">
            <span class="icon-[lucide--refresh-cw] w-4 h-4" />
          </button>
          <button @click="collapseAll" :title="t('audio.collapseAll')" class="tool-btn">
            <span class="icon-[lucide--chevrons-down-up] w-4 h-4" />
          </button>
          <button @click="hideTree" :title="t('audio.hideTree')" class="tool-btn">
            <span class="icon-[lucide--panel-left-close] w-4 h-4" />
          </button>
        </div>

        <!-- 右键落在空白处：添加工作区。落在某一行上时，那一行自己的菜单先接住 -->
        <ContextMenu>
          <ContextMenuTrigger as-child>
            <aside data-audio-tree
              class="float-card flex-1 min-h-0 rounded-[14px] border bg-card overflow-y-auto px-1.5 py-2"
              :style="dropHit.kind === 'tree' ? { outline: '2px solid ' + settings.vaultAccent, outlineOffset: '-2px' } : undefined">
              <ContextMenu v-for="r in rows" :key="r.path">
                <ContextMenuTrigger as-child>
                  <button @click="onRowClick(r)" @pointerdown="onTreeDown($event, r)" :data-audio-dir="r.path"
                    :style="{
                      paddingLeft: (r.depth * 14 + 8) + 'px',
                      outline: isDropDir(r.path) ? '2px solid ' + settings.vaultAccent : '',
                      outlineOffset: '-2px',
                    }"
                    :class="[
                      'w-full flex items-center gap-1.5 rounded-md py-1 pr-2 text-left transition-colors',
                      samePath(selected, r.path) ? 'bg-muted' : 'hover:bg-muted/50 active:bg-muted',
                      isDropDir(r.path) ? 'bg-muted/70' : '',
                      samePath(treeDrag, r.path) ? 'opacity-40' : '',
                    ]">
                    <!-- 工作区根用单独的图标，一眼分得出「这是我加进来的那一层」 -->
                    <span class="w-4 h-4 shrink-0 text-muted-foreground"
                      :class="r.root ? 'icon-[lucide--folder-root]'
                        : expanded.has(r.path) ? 'icon-[lucide--folder-open]' : 'icon-[lucide--folder]'" />
                    <input v-if="renaming === r.path" ref="renameInput" v-model="renameText"
                      @click.stop @pointerdown.stop @keydown.stop="onRenameKey" @blur="commitRename"
                      :style="{ outline: '2px solid ' + settings.vaultAccent, outlineOffset: '1px' }"
                      class="flex-1 min-w-0 bg-transparent text-[15px] rounded-[3px] px-1 -mx-1" />
                    <span v-else class="text-[15px] truncate" :class="r.root ? 'font-medium' : ''"
                      :title="r.root ? r.path : undefined">{{ r.name }}</span>
                    <span v-if="failed.has(r.path)" :title="failed.get(r.path)"
                      class="icon-[lucide--triangle-alert] w-3.5 h-3.5 shrink-0 ml-auto text-destructive" />
                  </button>
                </ContextMenuTrigger>
                <ContextMenuContent class="w-auto min-w-44 whitespace-nowrap">
                  <ContextMenuItem @select="newFolderIn(r.path)">
                    <span class="icon-[lucide--folder-plus] w-4 h-4 mr-2" />{{ t('audio.newFolder') }}
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem @select="reveal(r.path)">
                    <span class="icon-[lucide--external-link] w-4 h-4 mr-2" />{{ t('audio.reveal') }}
                  </ContextMenuItem>
                  <ContextMenuItem @select="copyPath(r.path)">
                    <span class="icon-[lucide--copy] w-4 h-4 mr-2" />{{ t('audio.copyPath') }}
                  </ContextMenuItem>
                  <ContextMenuItem @select="load(r.path)">
                    <span class="icon-[lucide--refresh-cw] w-4 h-4 mr-2" />{{ t('audio.refresh') }}
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem v-if="!r.root" @select="startRename(r.path, r.name)">
                    <span class="icon-[lucide--pencil] w-4 h-4 mr-2" />{{ t('audio.rename') }}
                  </ContextMenuItem>
                  <!-- 工作区根：只从列表里拿掉，磁盘上的文件夹不动 -->
                  <ContextMenuItem v-else @select="removeRoot(r.path)">
                    <span class="icon-[lucide--folder-x] w-4 h-4 mr-2" />{{ t('audio.removeRoot') }}
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            </aside>
          </ContextMenuTrigger>
          <ContextMenuContent class="w-auto min-w-44 whitespace-nowrap">
            <ContextMenuItem @select="pickRoot">
              <span class="icon-[lucide--folder-plus] w-4 h-4 mr-2" />{{ t('audio.addRoot') }}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </div>

      <!-- ═══════ 右：音频列表 ═══════ -->
      <div class="flex-1 min-w-0 flex flex-col gap-2.5">
        <div class="flex gap-2.5 shrink-0">
          <!--
            目录栏收起来之后，展开按钮是顶卡前面一张 58×58 的方卡片 ——
            和笔记页一样：入口留在目录栏原来的位置，一眼就找得到。
          -->
          <button v-if="!treeVisible" @click="showTree" :title="t('audio.showTree')"
            class="float-card size-[58px] shrink-0 rounded-[14px] border bg-card
                   flex items-center justify-center text-muted-foreground
                   transition-colors hover:text-foreground">
            <span class="icon-[lucide--panel-left-open] w-[18px] h-[18px]" />
          </button>

        <!-- 右边留出窗口控制点的位置：它们浮在最上层，排到那儿的按钮会被压住点不到 -->
        <div class="float-card h-[58px] flex-1 min-w-0 rounded-[14px] border bg-card flex items-center gap-3 px-4"
          :class="zenMode ? '' : 'mr-[130px]'">
          <span class="icon-[lucide--folder-open] w-4 h-4 shrink-0 text-muted-foreground" />
          <!-- 名字至少留出几个字的位置：窄的时候先让提示文字让路，别把文件夹名挤没了 -->
          <span class="text-[14px] font-medium truncate min-w-12 max-w-[40%]" :title="selected">{{ selectedName }}</span>
          <span v-if="selected" class="text-[12px] text-muted-foreground tabular-nums shrink-0">
            {{ picked.size > 1 ? t('audio.picked', { n: picked.size })
              : truncated ? t('audio.truncated', { n: files.length }) : t('audio.count', { n: files.length }) }}
          </span>
          <span class="flex-1 min-w-0 text-[12px] truncate"
            :class="notice?.bad ? 'text-destructive' : 'text-muted-foreground'">{{ notice?.text }}</span>

          <!-- 格式：裁过的片段拖出去、拖回目录树生成新文件时用。ⓘ 紧跟在它解释的字后面 -->
          <span class="text-[12px] text-muted-foreground shrink-0">{{ t('audio.format') }}</span>
          <InfoTip :text="t('audio.formatTip')" />
          <div class="flex items-center rounded-lg bg-muted/60 p-0.5 shrink-0">
            <button v-for="f in FORMATS" :key="f.id" @click="settings.audioExportFormat = f.id"
              class="h-7 px-2.5 rounded-md text-[12px] transition-colors whitespace-nowrap"
              :class="settings.audioExportFormat === f.id
                ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'">
              {{ f.label || t('audio.formatOriginal') }}
            </button>
          </div>
        </div>
        </div>

        <div data-audio-list
          class="float-card flex-1 min-h-0 rounded-[14px] border bg-card overflow-y-auto p-2"
          :style="dropHit.kind === 'list' ? { outline: '2px solid ' + settings.vaultAccent, outlineOffset: '-2px' } : undefined">
          <p v-if="!selected" class="mt-10 text-center text-sm text-muted-foreground">{{ t('audio.pickFolder') }}</p>
          <p v-else-if="failed.has(selected)" class="mt-10 text-center text-sm text-destructive">
            {{ t('audio.loadFailed') }}
          </p>
          <p v-else-if="!files.length" class="mt-10 text-center text-sm text-muted-foreground">{{ t('audio.noAudio') }}</p>

          <ContextMenu v-for="f in files" :key="f.path">
            <ContextMenuTrigger as-child>
              <AudioRow :file="f" :accent="settings.vaultAccent"
                :selected="picked.has(f.path)"
                :current="nowPath === f.path" :playing="playing"
                :position="nowPath === f.path ? position : 0"
                :trim="trims.get(f.path) ?? null"
                @press="(p: Press) => onPress(f, p)"
                @trim="(v: Trim) => onTrim(f, v)" @drag-out="dragOut(f)"
                @duration="(d: number) => durations.set(f.path, d)" />
            </ContextMenuTrigger>
            <ContextMenuContent class="w-auto min-w-44 whitespace-nowrap">
              <ContextMenuItem @select="reveal(f.path)">
                <span class="icon-[lucide--external-link] w-4 h-4 mr-2" />{{ t('audio.reveal') }}
              </ContextMenuItem>
              <ContextMenuItem @select="copyPath(f.path)">
                <span class="icon-[lucide--copy] w-4 h-4 mr-2" />{{ t('audio.copyPath') }}
              </ContextMenuItem>
              <template v-if="trims.has(f.path)">
                <ContextMenuSeparator />
                <ContextMenuItem @select="resetTrim(f.path)">
                  <span class="icon-[lucide--scissors] w-4 h-4 mr-2" />{{ t('audio.resetTrim') }}
                </ContextMenuItem>
              </template>
            </ContextMenuContent>
          </ContextMenu>
        </div>
      </div>
    </template>

    <!-- 树里拖文件夹时跟着光标走的那个小标签 -->
    <div v-if="treeDrag"
      class="fixed z-50 pointer-events-none flex items-center gap-1.5 h-7 px-2.5 rounded-lg
             bg-card border text-[13px] shadow-lg"
      :style="{ left: ghost.x + 14 + 'px', top: ghost.y + 10 + 'px', borderColor: settings.vaultAccent }">
      <span class="icon-[lucide--folder] w-3.5 h-3.5 text-muted-foreground" />{{ ghost.name }}
    </div>
  </div>
</template>

<style scoped>
/* 和笔记页顶卡里的按钮同一个尺寸：44×44 */
.tool-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2.75rem;
  height: 2.75rem;
  border-radius: 0.75rem;
  color: var(--muted-foreground);
  transition: background-color 140ms ease, color 140ms ease;
}
.tool-btn:hover {
  background: color-mix(in srgb, var(--foreground) 8%, transparent);
  color: var(--foreground);
}
.tool-btn.is-on {
  background: color-mix(in srgb, var(--foreground) 10%, transparent);
}
/*
  窄窗口拉出来的目录栏是压在列表上面的一层。开了云母/亚克力时卡片只有 92% 实心，
  平铺着没关系，一叠到别的卡片上，底下的文件夹名、波形就会透上来 —— 这里改成全实心。
*/
.tree-drawer .bg-card {
  background-color: var(--card);
}
</style>
