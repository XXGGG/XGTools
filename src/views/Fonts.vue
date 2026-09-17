<script setup lang="ts">
/**
 * 字体库。
 *
 * 用在三处：做游戏、剪视频、PS 做图。跟 XGCut 字体库不一样的地方：
 *
 * - **按用途进门**：推荐按「游戏 / 剪辑 / PS」分小类，不按字长什么样分
 * - **接管整台电脑的字体**：本机所有字体都列出来，自己装的能停用、卸载（进回收区，能恢复）
 * - **协议按用途给结论**：每款字体读它自己写的协议，分别说能不能打包进游戏、用在视频里、做图印刷
 *
 * 样张里缺的字画成方框（见 lib/fontFaces.ts）：做游戏最怕看着都有、一进游戏缺字。
 *
 * # 排版
 *
 * 照音频试听那页：左边分类栏，右边一行一款字体；点一行，最右边拉出详情。
 * 窗口窄了分类栏自动收起、详情改成盖在列表上面的一层。
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { openUrl } from '@tauri-apps/plugin-opener'
import { startDrag } from '@crabnebula/tauri-plugin-drag'
import { settings } from '@/composables/useAppSettings'
import { zen } from '@/composables/useZen'
import { useI18n } from '@/i18n'
import InfoTip from '@/components/InfoTip.vue'
import FontRow, { type Chip } from '@/components/fonts/FontRow.vue'
import FontDetail from '@/components/fonts/FontDetail.vue'
import { localFamily, previewFamily, repFace } from '@/lib/fontFaces'
import { SAMPLE } from '@/lib/fontSamples'
import { TIERS, TIER_COLOR, USE_GROUPS, type Family, type Pack, type Tier, type TrashEntry } from '@/lib/fontTypes'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'

const { t } = useI18n()
const zenMode = computed(() => zen.on)
const accent = computed(() => settings.vaultAccent)

// ── 数据 ──

const families = ref<Family[]>([])
const packs = ref<Pack[]>([])
const trash = ref<TrashEntry[]>([])
const scanning = ref(false)
const loaded = ref(false)

async function scan() {
  scanning.value = true
  try {
    const [f, p, tr] = await Promise.all([
      invoke<Family[]>('font_scan'),
      invoke<Pack[]>('font_catalog'),
      invoke<TrashEntry[]>('font_trash_list'),
    ])
    families.value = f
    packs.value = p
    trash.value = tr
  } catch (e) {
    flash(String(e), true)
  } finally {
    scanning.value = false
    loaded.value = true
  }
}

// ── 提示条 ──

const notice = ref<{ text: string; bad: boolean } | null>(null)
let noticeTimer = 0
function flash(text: string, bad = false) {
  notice.value = { text, bad }
  window.clearTimeout(noticeTimer)
  noticeTimer = window.setTimeout(() => (notice.value = null), bad ? 6000 : 3500)
}

// ── 一行是什么 ──

type Item = {
  id: string
  name: string
  nameEn: string
  /** 本机那一族。推荐里的字体装过了也会有 */
  family: Family | null
  pack: Pack | null
  chips: Chip[]
  /** 只有西文 */
  latin: boolean
  /** 有假名、没汉字（日文字体） */
  kanaOnly: boolean
  dim: boolean
  /** 像素字的原生字号（推荐目录里量好的）；0 = 不是像素字 */
  px: number
  fontKey: string
  resolve: () => Promise<string | null>
}

const collator = new Intl.Collator('zh-Hans-CN')
const famByEn = computed(() => {
  const m = new Map<string, Family>()
  for (const f of families.value) m.set(f.nameEn.toLowerCase(), f)
  return m
})
/** 推荐里的某款，本机是不是已经有了（谁装的都算） */
function localOf(p: Pack): Family | null {
  for (const n of p.families) {
    const f = famByEn.value.get(n.toLowerCase())
    if (f) return f
  }
  return families.value.find((f) => f.catalog === p.id) ?? null
}

const packById = computed(() => new Map(packs.value.map((p) => [p.id, p])))
/** 像素字的原生字号。一款字给了两种尺寸时（寒蝉点阵 8 / 16），px 和 families 按位置一一对应 */
function pxFor(p: Pack | undefined, familyEn?: string): number {
  if (!p?.px.length) return 0
  if (familyEn && p.px.length === p.families.length) {
    const i = p.families.findIndex((f) => f.toLowerCase() === familyEn.toLowerCase())
    if (i >= 0) return p.px[i]
  }
  return p.px[p.px.length - 1]
}
/** 像素字按原生字号的整数倍画，才是清清楚楚的方块；别的字照滑块来 */
function sizeOf(it: Item, base = settings.fontSize) {
  return it.px ? Math.max(it.px, Math.round(base / it.px) * it.px) : base
}

function famChips(f: Family): Chip[] {
  const v = f.verdict
  const c: Chip[] = [{ text: t(`fonts.tier_${v.tier}`), color: TIER_COLOR[v.tier], title: v.license }]
  // Windows 自带的，协议那枚标签已经写着「Windows 自带」了，来源不用再说一遍
  if (v.tier !== 'system') c.push({ text: t(`fonts.src_${f.source}`) })
  const s = [f.sc || f.tc ? t('fonts.short_cjk') : '', f.kana ? t('fonts.short_kana') : '', f.latin ? t('fonts.short_latin') : '']
    .filter(Boolean)
    .join(' ')
  if (s) c.push({ text: s })
  if (f.faces.some((x) => x.disabled)) c.push({ text: t('fonts.disabledChip') })
  return c
}

function famItem(f: Family): Item {
  const cjk = f.sc || f.tc
  return {
    id: 'f:' + f.key,
    name: f.name,
    nameEn: f.nameEn,
    family: f,
    pack: null,
    chips: famChips(f),
    latin: !cjk && !f.kana,
    kanaOnly: !cjk && f.kana,
    dim: f.disabled,
    px: f.catalog ? pxFor(packById.value.get(f.catalog), f.nameEn) : 0,
    fontKey: f.key + '|' + f.faces.map((x) => x.path + (x.disabled ? '-' : '+')).join(','),
    resolve: () => localFamily(f),
  }
}

function packItem(p: Pack): Item {
  const local = localOf(p)
  const chips: Chip[] = [{ text: t('fonts.open_chip', { license: p.license }), color: TIER_COLOR.open }]
  if (p.px.length) chips.push({ text: p.px.map((x) => x + 'px').join(' / '), title: t('fonts.pixelChipTip') })
  if (local) chips.push({ text: t('fonts.installed') })
  else if (p.installedBy === 'xgcut') chips.push({ text: t('fonts.installedByXgcut') })
  else chips.push({ text: t('fonts.sizeMb', { n: p.sizeMb }) })
  const cjk = p.sc || p.tc
  return {
    id: 'p:' + p.id,
    name: p.name,
    nameEn: p.latin,
    family: local,
    pack: p,
    chips,
    latin: !cjk && !p.kana,
    kanaOnly: !cjk && p.kana,
    dim: false,
    px: pxFor(p, local?.nameEn),
    fontKey: p.id + (local ? '|L|' + local.key : '|P'),
    resolve: () => (local ? localFamily(local) : previewFamily(p.id)),
  }
}

function textOf(it: Item) {
  const custom = settings.fontSample.trim()
  if (custom) return custom
  if (it.latin) return SAMPLE.latin
  if (it.kanaOnly) return SAMPLE.kana
  return SAMPLE.zh + '  Aa 0123'
}

// ── 分类 ──

const cat = computed({
  get: () => settings.fontCat || 'all',
  set: (v: string) => {
    settings.fontCat = v
    if (narrowTree.value) drawer.value = false
  },
})
const query = ref('')

const isMine = (f: Family) => f.source === 'user' || f.source === 'xgcut' || f.source === 'xgtools'
const LOCAL_CATS: { id: string; label: string; test: (f: Family) => boolean }[] = [
  { id: 'all', label: 'fonts.catAll', test: () => true },
  { id: 'mine', label: 'fonts.catMine', test: isMine },
  { id: 'xgtools', label: 'fonts.catXgtools', test: (f) => f.source === 'xgtools' },
  { id: 'xgcut', label: 'fonts.catXgcut', test: (f) => f.source === 'xgcut' },
  { id: 'windows', label: 'fonts.catWindows', test: (f) => f.source === 'windows' },
  { id: 'machine', label: 'fonts.catMachine', test: (f) => f.source === 'machine' },
  { id: 'disabled', label: 'fonts.catDisabled', test: (f) => f.faces.some((x) => x.disabled) },
]
const localCats = computed(() =>
  LOCAL_CATS.map((c) => ({ ...c, n: families.value.filter(c.test).length }))
    .filter((c) => c.n > 0 || c.id === 'all' || c.id === 'mine'),
)
const tierCounts = computed(() => {
  const m = {} as Record<Tier, number>
  for (const tier of TIERS) m[tier] = families.value.filter((f) => f.verdict.tier === tier).length
  return m
})
const camel = (s: string) => s.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join('')
const useLabel = (u: string) => t(`fonts.use${camel(u)}`)
const useCount = (u: string) => packs.value.filter((p) => p.uses.some((x) => x === u || x.startsWith(u + '-'))).length

const favs = computed(() => new Set(settings.fontFavorites))
function toggleFav(id: string) {
  const s = new Set(settings.fontFavorites)
  if (s.has(id)) s.delete(id)
  else s.add(id)
  settings.fontFavorites = [...s]
}

const items = computed<Item[]>(() => {
  const c = cat.value
  let list: Item[]
  if (c.startsWith('use:')) {
    const u = c.slice(4)
    list = packs.value.filter((p) => p.uses.some((x) => x === u || x.startsWith(u + '-'))).map(packItem)
  } else if (c === 'fav') {
    list = [
      ...families.value.filter((f) => favs.value.has('f:' + f.key)).map(famItem),
      ...packs.value.filter((p) => favs.value.has('p:' + p.id)).map(packItem),
    ]
  } else {
    const test = c.startsWith('tier:')
      ? (f: Family) => f.verdict.tier === c.slice(5)
      : (LOCAL_CATS.find((x) => x.id === c)?.test ?? (() => true))
    list = families.value.filter(test).map(famItem).sort((a, b) => collator.compare(a.name, b.name))
  }
  if (settings.fontOnlySafe) list = list.filter((it) => !it.family || it.family.verdict.tier === 'open')
  const q = query.value.trim().toLowerCase()
  if (q) list = list.filter((it) => it.name.toLowerCase().includes(q) || it.nameEn.toLowerCase().includes(q))
  return list
})

const catTitle = computed(() => {
  const c = cat.value
  if (c === 'trash') return t('fonts.catTrash')
  if (c === 'fav') return t('fonts.catFav')
  if (c.startsWith('tier:')) return t(`fonts.tier_${c.slice(5)}`)
  if (c.startsWith('use:')) {
    const u = c.slice(4)
    const g = USE_GROUPS.find((x) => x.id === u)
    if (g) return t(`fonts.group${camel(g.id)}`)
    const grp = USE_GROUPS.find((x) => x.uses.includes(u))
    return `${grp ? t(`fonts.group${camel(grp.id)}`) + ' · ' : ''}${useLabel(u)}`
  }
  return t(LOCAL_CATS.find((x) => x.id === c)?.label ?? 'fonts.catAll')
})

// ── 选中、对比 ──

const selectedId = ref<string | null>(null)
function itemById(id: string | null): Item | null {
  if (!id) return null
  if (id.startsWith('f:')) {
    const f = families.value.find((x) => 'f:' + x.key === id)
    return f ? famItem(f) : null
  }
  const p = packs.value.find((x) => 'p:' + x.id === id)
  return p ? packItem(p) : null
}
const selected = computed(() => itemById(selectedId.value))
const detailCss = ref<string | null>(null)
watch(
  () => selected.value?.fontKey,
  async () => {
    const it = selected.value
    detailCss.value = null
    if (!it) return
    const key = it.fontKey
    const css = await it.resolve()
    if (selected.value?.fontKey === key) detailCss.value = css
  },
  { immediate: true },
)

const picked = reactive(new Set<string>())
const comparing = ref(false)
function togglePick(id: string) {
  if (picked.has(id)) picked.delete(id)
  else if (picked.size < 4) picked.add(id)
  else flash(t('fonts.pickMax'), true)
  if (picked.size < 2) comparing.value = false
}
const pickedItems = computed(() => [...picked].map(itemById).filter((x): x is Item => !!x))
const compareCss = reactive(new Map<string, string | null>())
watch(
  () => pickedItems.value.map((i) => i.fontKey).join(),
  async () => {
    for (const it of pickedItems.value) {
      if (!compareCss.has(it.id)) compareCss.set(it.id, await it.resolve())
    }
  },
)

const detailOpen = computed(() => (comparing.value && picked.size >= 2) || !!selected.value)
function closeDetail() {
  if (comparing.value) comparing.value = false
  else selectedId.value = null
}

// ── 操作 ──

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    flash(t('fonts.copied', { name: text }))
  } catch {
    /* 剪贴板被占着，不值得打扰 */
  }
}

async function open(url: string) {
  try {
    await openUrl(url)
  } catch (e) {
    flash(String(e), true)
  }
}

async function reveal(path: string) {
  try {
    await invoke('reveal_in_explorer', { path })
  } catch (e) {
    flash(String(e), true)
  }
}

const icons = new Map<number, string>()
/** 拖动时跟着光标的小图标：主题色方块里一个 Aa；一次拖好几个文件时右上角标个数 */
function dragIcon(n: number) {
  const hit = icons.get(n)
  if (hit) return hit
  const c = document.createElement('canvas')
  c.width = c.height = 72
  const g = c.getContext('2d')!
  g.fillStyle = accent.value
  g.beginPath()
  g.roundRect(6, 14, 52, 52, 14)
  g.fill()
  g.fillStyle = '#fff'
  g.font = 'bold 24px Georgia, serif'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText('Aa', 32, 41)
  if (n > 1) {
    g.beginPath()
    g.arc(56, 16, 14, 0, Math.PI * 2)
    g.fill()
    g.fillStyle = accent.value
    g.font = 'bold 15px system-ui, sans-serif'
    g.fillText(n > 99 ? '99+' : String(n), 56, 17)
  }
  const url = c.toDataURL('image/png')
  icons.set(n, url)
  return url
}

async function dragOut(paths: string[], fam: Family | null) {
  if (!paths.length) {
    flash(t('fonts.dragNeedInstall'), true)
    return
  }
  // 拖得出去，但先提醒一句：这款不许打包进游戏
  if (fam && fam.verdict.game === 'no') {
    flash(t('fonts.dragNoGame', { why: fam.verdict.notes[0] ?? fam.verdict.license }), true)
  }
  try {
    await startDrag({ item: paths, icon: dragIcon(paths.length) })
  } catch (e) {
    flash(String(e), true)
  }
}

function dragItem(it: Item) {
  const fam = it.family
  if (fam) return dragOut([repFace(fam).path], fam)
  return dragOut(it.pack?.files.slice(0, 1) ?? [], null)
}

const manageablePaths = (f: Family) =>
  f.faces.filter((x) => x.source !== 'windows' && x.source !== 'machine').map((x) => x.path)

async function toggle(f: Family, enable: boolean) {
  try {
    await invoke('font_set_enabled', { paths: manageablePaths(f), enabled: enable })
    flash(t(enable ? 'fonts.enabledOk' : 'fonts.disabledOk'))
    await scan()
  } catch (e) {
    flash(String(e), true)
  }
}

/*
  确认框：要做的事自己留一份，不能等点确认时再读 ref。
  AlertDialogAction 被点中时会先把弹窗关掉，关闭又把 ref 清成 null ——
  发生在按钮自己的 @click 之前（Agent.vue 删项目那里踩过）。
*/
const confirmBox = ref<{ title: string; body: string; ok: string } | null>(null)
let pending: (() => Promise<void>) | null = null
function ask(title: string, body: string, ok: string, run: () => Promise<void>) {
  pending = run
  confirmBox.value = { title, body, ok }
}
async function runConfirm() {
  const run = pending
  pending = null
  confirmBox.value = null
  if (run) await run()
}

function askUninstall(f: Family) {
  const paths = manageablePaths(f)
  ask(t('fonts.uninstallTitle', { name: f.name }), t('fonts.uninstallBody'), t('fonts.uninstall'), async () => {
    try {
      await invoke('font_uninstall', { paths, label: f.name })
      flash(t('fonts.uninstalledOk'))
      if (selectedId.value === 'f:' + f.key) selectedId.value = null
      picked.delete('f:' + f.key)
      await scan()
    } catch (e) {
      flash(String(e), true)
    }
  })
}

const installing = reactive(new Map<string, number>())
async function install(p: Pack) {
  if (installing.has(p.id)) return
  installing.set(p.id, 0)
  try {
    await invoke('font_install', { id: p.id })
    flash(t('fonts.installedOk', { name: p.name }))
    await scan()
  } catch (e) {
    flash(String(e), true)
  } finally {
    installing.delete(p.id)
  }
}

async function restore(e: TrashEntry) {
  try {
    await invoke('font_trash_restore', { id: e.id })
    flash(t('fonts.restoredOk'))
    await scan()
  } catch (err) {
    flash(String(err), true)
  }
}

function askPurge(e: TrashEntry | null) {
  ask(e ? t('fonts.purgeTitle') : t('fonts.purgeAllTitle'), t('fonts.purgeBody'), t('fonts.purge'), async () => {
    try {
      await invoke('font_trash_purge', { id: e?.id ?? null })
      flash(t('fonts.purgedOk'))
      trash.value = await invoke<TrashEntry[]>('font_trash_list')
    } catch (err) {
      flash(String(err), true)
    }
  })
}

const size = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)
const when = (ms: number) => new Date(ms).toLocaleString()

// ── 样张底色 ──

const BG_ORDER = ['auto', 'dark', 'light'] as const
function cycleBg() {
  const i = BG_ORDER.indexOf(settings.fontBg)
  settings.fontBg = BG_ORDER[(i + 1) % BG_ORDER.length]
}
/** 列表那张卡换底色时，里面用到的几个颜色变量一起换，不然灰字压在深底上看不见 */
const listStyle = computed(() => {
  const set = (fg: string, muted: string, mutedBg: string, bg: string) => ({
    background: bg,
    color: fg,
    '--foreground': fg,
    '--color-foreground': fg,
    '--muted-foreground': muted,
    '--color-muted-foreground': muted,
    '--muted': mutedBg,
    '--color-muted': mutedBg,
  })
  if (settings.fontBg === 'dark') return set('#f2f1ee', '#9a9aa0', '#26262b', '#141417')
  if (settings.fontBg === 'light') return set('#1b1b1d', '#6d6d73', '#ecebe6', '#fbfaf6')
  return {}
})

// ── 窄窗口 ──

const rootEl = ref<HTMLElement | null>(null)
const width = ref(1920)
const narrowTree = computed(() => width.value < 1100)
const narrowDetail = computed(() => width.value < 1380)
const drawer = ref(false)
const treeInFlow = computed(() => !narrowTree.value && settings.fontTreeOpen)
const treeVisible = computed(() => treeInFlow.value || (narrowTree.value && drawer.value))
function showTree() {
  if (narrowTree.value) drawer.value = true
  else settings.fontTreeOpen = true
}
function hideTree() {
  if (narrowTree.value) drawer.value = false
  else settings.fontTreeOpen = false
}

function onKey(e: KeyboardEvent) {
  if (e.key !== 'Escape' || confirmBox.value) return
  if (drawer.value) drawer.value = false
  else if (detailOpen.value) closeDetail()
}

let resizeObs: ResizeObserver | null = null
let unlisten: UnlistenFn | null = null
let disposed = false

onMounted(async () => {
  resizeObs = new ResizeObserver(() => {
    width.value = rootEl.value?.clientWidth ?? 1920
    if (!narrowTree.value) drawer.value = false
  })
  if (rootEl.value) resizeObs.observe(rootEl.value)
  window.addEventListener('keydown', onKey)
  const un = await listen<{ id: string; got: number; total: number; stage: string }>('font-install', (e) => {
    const { id, got, total, stage } = e.payload
    if (!installing.has(id)) return
    installing.set(id, stage === 'download' ? Math.min(0.96, got / Math.max(total, 1)) : 0.98)
  })
  if (disposed) un()
  else unlisten = un
  await scan()
})

onBeforeUnmount(() => {
  disposed = true
  resizeObs?.disconnect()
  window.removeEventListener('keydown', onKey)
  unlisten?.()
  window.clearTimeout(noticeTimer)
})
</script>

<template>
  <div ref="rootEl" class="absolute inset-0 pt-2.5 pr-2.5 pb-2.5 flex gap-2.5"
    :class="zenMode ? 'pl-2.5' : 'pl-[4.875rem]'">

    <!-- 窄窗口下拉出分类栏时垫在底下的一层：点它就收回去 -->
    <div v-if="narrowTree && drawer" class="absolute inset-0 z-20" @pointerdown="drawer = false" />

    <!-- ═══════ 左：分类栏 ═══════ -->
    <div v-if="treeVisible" class="w-[248px] flex flex-col gap-2.5"
      :class="treeInFlow ? 'shrink-0'
        : ['font-drawer absolute z-30 top-2.5 bottom-2.5 drop-shadow-2xl', zenMode ? 'left-2.5' : 'left-[4.875rem]']">
      <div class="float-card h-[58px] shrink-0 rounded-[14px] border bg-card flex items-center gap-1 px-3">
        <!-- 收起放最左，和收起后那张「展开」方卡片同一个位置（笔记、音频试听也是这样） -->
        <button @click="hideTree" :title="t('fonts.hideTree')" class="tool-btn">
          <span class="icon-[lucide--panel-left-close] w-4 h-4" />
        </button>
        <span class="w-px h-5 mx-1 shrink-0 bg-border" />
        <span class="icon-[lucide--search] w-4 h-4 shrink-0 text-muted-foreground" />
        <input v-model="query" :placeholder="t('fonts.searchPlaceholder')"
          class="flex-1 min-w-0 bg-transparent text-[14px] outline-none placeholder:text-muted-foreground/70" />
        <button @click="scan" :title="t('fonts.refresh')" class="tool-btn">
          <span class="w-4 h-4" :class="scanning ? 'icon-[lucide--loader-circle] animate-spin' : 'icon-[lucide--refresh-cw]'" />
        </button>
      </div>

      <aside class="float-card flex-1 min-h-0 rounded-[14px] border bg-card overflow-y-auto px-1.5 py-2 flex flex-col gap-3">
        <!-- 协议体检：整台电脑一眼看完 -->
        <section>
          <div class="flex items-center gap-1 px-2 pb-1.5">
            <span class="text-[12px] font-medium text-muted-foreground">{{ t('fonts.secCheck') }}</span>
            <InfoTip :text="t('fonts.checkTip')" />
          </div>
          <div v-if="families.length" class="mx-2 mb-1.5 flex h-1.5 rounded-full overflow-hidden">
            <span v-for="tier in TIERS" :key="tier" :title="t(`fonts.tier_${tier}`) + ' ' + tierCounts[tier]"
              :style="{ flexGrow: tierCounts[tier], background: TIER_COLOR[tier] }" />
          </div>
          <button v-for="tier in TIERS" :key="tier" @click="cat = 'tier:' + tier" class="cat-row"
            :class="cat === 'tier:' + tier ? 'bg-muted' : ''">
            <span class="size-2 rounded-full shrink-0" :style="{ background: TIER_COLOR[tier] }" />
            <span class="flex-1 truncate">{{ t(`fonts.tier_${tier}`) }}</span>
            <span class="cat-n">{{ tierCounts[tier] }}</span>
          </button>
        </section>

        <section>
          <div class="px-2 pb-1 text-[12px] font-medium text-muted-foreground">{{ t('fonts.secLocal') }}</div>
          <button v-for="c in localCats" :key="c.id" @click="cat = c.id" class="cat-row"
            :class="cat === c.id ? 'bg-muted' : ''">
            <span class="flex-1 truncate">{{ t(c.label) }}</span>
            <span class="cat-n">{{ c.n }}</span>
          </button>
          <button @click="cat = 'trash'" class="cat-row" :class="cat === 'trash' ? 'bg-muted' : ''">
            <span class="flex-1 truncate">{{ t('fonts.catTrash') }}</span>
            <span class="cat-n">{{ trash.length }}</span>
          </button>
        </section>

        <section>
          <div class="flex items-center gap-1 px-2 pb-1">
            <span class="text-[12px] font-medium text-muted-foreground">{{ t('fonts.secRec') }}</span>
            <InfoTip :text="t('fonts.recTip')" />
          </div>
          <template v-for="g in USE_GROUPS" :key="g.id">
            <button @click="cat = 'use:' + g.id" class="cat-row font-medium" :class="cat === 'use:' + g.id ? 'bg-muted' : ''">
              <span class="w-4 h-4 shrink-0 text-muted-foreground" :class="{
                game: 'icon-[lucide--gamepad-2]', video: 'icon-[lucide--clapperboard]', ps: 'icon-[lucide--image]',
              }[g.id]" />
              <span class="flex-1 truncate">{{ t(`fonts.group${camel(g.id)}`) }}</span>
              <span class="cat-n">{{ useCount(g.id) }}</span>
            </button>
            <button v-for="u in g.uses" :key="u" @click="cat = 'use:' + u" class="cat-row pl-8!"
              :class="cat === 'use:' + u ? 'bg-muted' : ''">
              <span class="flex-1 truncate">{{ useLabel(u) }}</span>
              <span class="cat-n">{{ useCount(u) }}</span>
            </button>
          </template>
        </section>

        <section>
          <button @click="cat = 'fav'" class="cat-row" :class="cat === 'fav' ? 'bg-muted' : ''">
            <span class="icon-[lucide--star] w-4 h-4 shrink-0" style="color: #f2b21c" />
            <span class="flex-1 truncate">{{ t('fonts.catFav') }}</span>
            <span class="cat-n">{{ settings.fontFavorites.length }}</span>
          </button>
        </section>
      </aside>
    </div>

    <!-- ═══════ 右 ═══════ -->
    <div class="flex-1 min-w-0 flex flex-col gap-2.5">
      <div class="flex gap-2.5 shrink-0">
        <button v-if="!treeVisible" @click="showTree" :title="t('fonts.showTree')"
          class="float-card size-[58px] shrink-0 rounded-[14px] border bg-card flex items-center justify-center
                 text-muted-foreground transition-colors hover:text-foreground">
          <span class="icon-[lucide--panel-left-open] w-[18px] h-[18px]" />
        </button>

        <!-- 顶卡：试字那句话、字号、底色、只看放心商用、对比。右边给窗口控制点让位 -->
        <div class="float-card h-[58px] flex-1 min-w-0 rounded-[14px] border bg-card flex items-center gap-3 px-4"
          :class="zenMode ? '' : 'mr-[130px]'">
          <span class="icon-[lucide--type] w-4 h-4 shrink-0 text-muted-foreground" />
          <input v-model="settings.fontSample" :placeholder="t('fonts.samplePlaceholder')"
            class="flex-1 min-w-0 bg-transparent text-[14px] outline-none placeholder:text-muted-foreground/70" />
          <button v-if="settings.fontSample" @click="settings.fontSample = ''" class="tool-btn size-7! -ml-2">
            <span class="icon-[lucide--x] w-3.5 h-3.5" />
          </button>
          <label class="flex items-center gap-2 shrink-0 text-[12px] text-muted-foreground" :title="t('fonts.size')">
            <input type="range" min="14" max="72" step="1" v-model.number="settings.fontSize"
              class="w-24" :style="{ accentColor: accent }" />
            <span class="w-6 tabular-nums text-foreground">{{ settings.fontSize }}</span>
          </label>
          <button @click="cycleBg" :title="t(`fonts.bg_${settings.fontBg}`)" class="tool-btn shrink-0">
            <span class="w-4 h-4" :class="{
              auto: 'icon-[lucide--contrast]', dark: 'icon-[lucide--moon]', light: 'icon-[lucide--sun]',
            }[settings.fontBg]" />
          </button>
          <button @click="settings.fontOnlySafe = !settings.fontOnlySafe" :title="t('fonts.onlySafe')"
            class="tool-btn shrink-0" :class="settings.fontOnlySafe ? 'is-on' : ''"
            :style="settings.fontOnlySafe ? { color: TIER_COLOR.open } : undefined">
            <span class="icon-[lucide--shield-check] w-4 h-4" />
          </button>
          <button v-if="picked.size >= 2" @click="comparing = true"
            class="shrink-0 h-8 px-3 rounded-lg text-[12.5px] font-medium text-white whitespace-nowrap"
            :style="{ background: accent }">{{ t('fonts.compare', { n: picked.size }) }}</button>
        </div>
      </div>

      <div class="flex-1 min-h-0 flex gap-2.5 relative">
        <!-- ═══════ 列表 ═══════ -->
        <div class="float-card flex-1 min-w-0 rounded-[14px] border bg-card overflow-y-auto p-2 flex flex-col"
          :style="cat === 'trash' ? undefined : listStyle">
          <div class="flex items-center gap-2 px-3 pt-1 pb-2 shrink-0">
            <span class="text-[14px] font-medium">{{ catTitle }}</span>
            <span class="text-[12px] text-muted-foreground tabular-nums">
              {{ cat === 'trash' ? t('fonts.count', { n: trash.length }) : t('fonts.count', { n: items.length }) }}
            </span>
            <InfoTip v-if="cat === 'trash'" :text="t('fonts.trashTip')" />
            <span v-if="notice" class="flex-1 min-w-0 truncate text-[12px] text-right"
              :class="notice.bad ? 'text-destructive' : 'text-muted-foreground'">{{ notice.text }}</span>
            <div v-else class="flex-1" />
            <button v-if="cat === 'trash' && trash.length" @click="askPurge(null)" class="text-[12px] text-destructive hover:underline shrink-0">
              {{ t('fonts.purgeAll') }}
            </button>
          </div>

          <!-- 回收区 -->
          <template v-if="cat === 'trash'">
            <div v-if="!trash.length" class="flex-1 flex items-center justify-center text-[13px] text-muted-foreground">
              {{ t('fonts.trashEmpty') }}
            </div>
            <div v-for="e in trash" :key="e.id" class="flex items-center gap-3 rounded-[10px] px-3 py-2.5 hover:bg-muted/50">
              <span class="icon-[lucide--archive-restore] w-4 h-4 text-muted-foreground shrink-0" />
              <div class="flex-1 min-w-0">
                <div class="text-[14px] truncate">{{ e.label }}</div>
                <div class="text-[11.5px] text-muted-foreground">
                  {{ when(e.time) }} · {{ t('fonts.trashFiles', { n: e.items.length, size: size(e.bytes) }) }}
                </div>
              </div>
              <button @click="restore(e)" class="h-8 px-3 rounded-lg text-[12.5px] font-medium text-white" :style="{ background: accent }">
                {{ t('fonts.restore') }}
              </button>
              <button @click="askPurge(e)" :title="t('fonts.purge')" class="tool-btn">
                <span class="icon-[lucide--trash-2] w-4 h-4" />
              </button>
            </div>
          </template>

          <template v-else>
            <div v-if="!loaded" class="flex-1 flex items-center justify-center gap-2 text-[13px] text-muted-foreground">
              <span class="icon-[lucide--loader-circle] w-4 h-4 animate-spin" />{{ t('fonts.scanning') }}
            </div>
            <div v-else-if="!items.length" class="flex-1 flex items-center justify-center text-[13px] text-muted-foreground">
              {{ query.trim() ? t('fonts.emptySearch', { q: query.trim() }) : t('fonts.empty') }}
            </div>
            <FontRow v-for="it in items" :key="it.id"
              :name="it.name" :name-en="it.nameEn" :chips="it.chips" :resolve="it.resolve" :font-key="it.fontKey"
              :text="textOf(it)" :size="sizeOf(it)" :accent="accent"
              :selected="selectedId === it.id" :picked="picked.has(it.id)" :favorite="favs.has(it.id)" :dim="it.dim"
              :action="it.pack ? {
                label: it.family || it.pack.installedBy ? t('fonts.installed') : t('fonts.install'),
                busy: installing.get(it.pack.id) ?? null,
                done: !!(it.family || it.pack.installedBy),
              } : null"
              :pick-label="t('fonts.pick')" :fav-label="t('fonts.fav')" :copy-label="t('fonts.copyName')"
              :drag-label="t('fonts.drag')" :fail-label="t('fonts.fail')"
              @select="selectedId = it.id; comparing = false"
              @pick="togglePick(it.id)" @fav="toggleFav(it.id)" @copy="copy(it.name)"
              @drag="dragItem(it)" @action="it.pack && install(it.pack)" />
          </template>
        </div>

        <!-- 窄窗口：详情盖在列表上面，点外面收回 -->
        <div v-if="narrowDetail && detailOpen" class="absolute inset-0 z-10" @pointerdown="closeDetail" />

        <!-- ═══════ 详情 / 对比 ═══════ -->
        <div v-if="detailOpen"
          class="float-card w-[400px] max-w-full rounded-[14px] border bg-card overflow-y-auto px-4 py-4"
          :class="narrowDetail ? 'font-drawer absolute right-0 top-0 bottom-0 z-20 drop-shadow-2xl' : 'shrink-0'">
          <template v-if="comparing && picked.size >= 2">
            <div class="flex items-center gap-2 mb-3">
              <span class="text-[15px] font-medium">{{ t('fonts.compareTitle') }}</span>
              <div class="flex-1" />
              <button @click="picked.clear(); comparing = false" class="text-[12px] text-muted-foreground hover:text-foreground">
                {{ t('fonts.clearPick') }}
              </button>
              <button @click="comparing = false" :title="t('fonts.close')" class="tool-btn -mr-1">
                <span class="icon-[lucide--x] w-4 h-4" />
              </button>
            </div>
            <div class="flex flex-col gap-2">
              <div v-for="it in pickedItems" :key="it.id" class="rounded-[10px] border px-3 py-2.5">
                <div class="flex items-center gap-1.5 text-[12px] text-muted-foreground mb-1">
                  <span class="truncate">{{ it.name }}</span>
                  <button @click="togglePick(it.id)" class="ml-auto icon-[lucide--x] w-3.5 h-3.5 hover:text-foreground" />
                </div>
                <div class="break-words" :style="{ fontFamily: compareCss.get(it.id) ?? undefined, fontSize: sizeOf(it, 32) + 'px', lineHeight: 1.3 }">
                  {{ textOf(it) }}
                </div>
              </div>
            </div>
          </template>
          <FontDetail v-else-if="selected" :family="selected.family" :pack="selected.pack" :css="detailCss"
            :latin="selected.latin" :custom="settings.fontSample" :accent="accent"
            :installing="selected.pack ? installing.get(selected.pack.id) ?? null : null"
            @close="selectedId = null"
            @toggle="(on) => selected?.family && toggle(selected.family, on)"
            @uninstall="selected?.family && askUninstall(selected.family)"
            @install="selected?.pack && install(selected.pack)"
            @reveal="reveal" @copy="copy" @open="open"
            @drag="(paths) => dragOut(paths, selected?.family ?? null)" />
        </div>
      </div>
    </div>

    <AlertDialog :open="!!confirmBox" @update:open="(v: boolean) => { if (!v) confirmBox = null }">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{{ confirmBox?.title }}</AlertDialogTitle>
          <AlertDialogDescription>{{ confirmBox?.body }}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{{ t('fonts.cancel') }}</AlertDialogCancel>
          <AlertDialogAction @click="runConfirm">{{ confirmBox?.ok }}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>

<style scoped>
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
.cat-row {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  border-radius: 0.375rem;
  padding: 0.3rem 0.5rem;
  text-align: left;
  font-size: 14px;
  transition: background-color 120ms ease;
}
.cat-row:hover {
  background: color-mix(in srgb, var(--muted) 60%, transparent);
}
.cat-n {
  font-size: 12px;
  color: var(--muted-foreground);
  font-variant-numeric: tabular-nums;
}
/*
  窄窗口拉出来的分类栏、详情是压在列表上面的一层。开了云母/亚克力时卡片只有 92% 实心，
  叠在别的卡片上底下的字会透上来 —— 这里改成全实心（音频试听那页同一个问题）。
*/
.font-drawer.bg-card,
.font-drawer .bg-card {
  background-color: var(--card);
}
</style>
