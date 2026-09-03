<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onUnmounted } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-shell'
import { enable, disable, isEnabled } from '@tauri-apps/plugin-autostart'
import { VueDraggable } from 'vue-draggable-plus'
import { Tabs, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import TitleBarTabs from '@/components/TitleBarTabs.vue'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  dshFootprint, uninstallDsh, humanSize, dsh, listPlugins, addPlugin, removePlugin, PLUGIN_INFO,
  type DshFootprint, type PluginState,
} from '@/composables/useDsh'
import {
  chatReady, describeCredentials, setCredential, unsetCredential,
  CREDENTIAL_REFS, type CredentialView,
} from '@/composables/useDshChat'
import { watch } from 'vue'
import { ScrollArea } from '@/components/ui/scroll-area'
import { VAULT_FONT_SIZE, VAULT_ACCENTS, VAULT_FONTS, VAULT_FONT_STACK, settings, applyWindowEffect, applyTheme, AGENT_SIDEBAR,
  type BlurKind, type ThemeMode, type ChatSurface } from '@/composables/useAppSettings'
import { useI18n, detectLocale, type Locale } from '@/i18n'
import { MENU_ITEMS, orderedAll, type MenuItem } from '@/lib/sidebar-prefs'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import {
  readAllShortcuts, writeShortcut, writeEnabled, resetAllShortcuts, syncAllShortcuts, shortcutStatus,
  pauseShortcuts, shortcutFromKeydown, SHORTCUT_DEFAULTS,
  type ShortcutKey, type ShortcutState,
} from '@/lib/shortcuts'

const { t, setLocale } = useI18n()

const version = ref('')
const autostart = ref(false)
const effectError = ref('')

onMounted(async () => {
  try { version.value = await invoke<string>('plugin:app|version') } catch { /* noop */ }
  try { autostart.value = await isEnabled() } catch { /* noop */ }
})

async function setAutostart(v: boolean) {
  try {
    if (v) await enable(); else await disable()
    autostart.value = v
  } catch (e) {
    console.error('切换开机自启失败:', e)
    autostart.value = await isEnabled().catch(() => false)   // 失败回读真实状态,别让开关停在假位置
  }
}

// ---------- 智能体页 ----------
const CHAT_SURFACES: { key: ChatSurface; nameKey: string; descKey: string }[] = [
  { key: 'card', nameKey: 'settings.dshSurfaceCard', descKey: 'settings.dshSurfaceCardDesc' },
  { key: 'flat', nameKey: 'settings.dshSurfaceFlat', descKey: 'settings.dshSurfaceFlatDesc' },
]

/** 滑块给的是数组(range 组件的通用签名),这里只用第一个值 */
function setAgentSidebarWidth(v?: number[] | null) {
  if (v?.length) settings.agentSidebarWidth = v[0]
}

// ── API 密钥 ──
const creds = ref<Record<string, CredentialView>>({})
/** 草稿是一次性的:发走就清空,永远不回显 —— 界面上不该留着密钥 */
const keyDraft = ref<Record<string, string>>({})
const keyError = ref<Record<string, string>>({})
const keySaved = ref('')

async function loadCreds() {
  if (!chatReady.value) return
  try { creds.value = await describeCredentials() } catch (e) { console.error('读凭据状态失败:', e) }
}

async function saveKey(ref: string) {
  const v = (keyDraft.value[ref] ?? '').trim()
  if (!v) return
  keyError.value = { ...keyError.value, [ref]: '' }
  try {
    await setCredential(ref, v)
    keyDraft.value = { ...keyDraft.value, [ref]: '' }   // 立刻清掉,不在内存里多留
    keySaved.value = ref
    setTimeout(() => { if (keySaved.value === ref) keySaved.value = '' }, 3000)
    await loadCreds()
  } catch (e) {
    keyError.value = { ...keyError.value, [ref]: String(e) }
  }
}

async function clearKey(ref: string) {
  try { await unsetCredential(ref); await loadCreds() }
  catch (e) { keyError.value = { ...keyError.value, [ref]: String(e) } }
}

// 连上之后才读得到凭据状态,所以要等 chatReady 翻绿而不是只在挂载时读一次
watch(chatReady, (ok) => { if (ok) loadCreds() }, { immediate: true })

// ── 可选插件 ──
const plugins = ref<PluginState[]>([])
/** 正在装或卸的那个包。同一时刻只允许一个 —— 两个 pnpm 写同一个 node_modules 会打架 */
const busyPlugin = ref('')
const pluginError = ref('')

async function loadPlugins() { plugins.value = await listPlugins() }

async function installPlugin(pkg: string) {
  busyPlugin.value = pkg
  pluginError.value = ''
  dsh.installLine = ''
  try {
    await addPlugin(pkg)
    await loadPlugins()
  } catch (e) {
    pluginError.value = String(e)
  } finally {
    busyPlugin.value = ''
    dsh.installLine = ''
  }
}

/*
  ── 卸载 ──

  要先问一次再动手:卸掉之后模型就少一项能力,而这件事在界面上看不出来 ——
  下次它「不会用 Claude Code 了」你未必想得起来是这儿关的。

  「顺带清缓存」默认不勾,而且说清楚那是 pnpm 的**下载缓存**、不是这个插件的数据。
  这类子智能体插件除了 node_modules 里那个包不留别的东西,
  为了凑一个「清除文件」的选项去编一个出来,比没有这个选项更糟。
*/
const removeTarget = ref<PluginState | null>(null)
const removePrune = ref(false)
/*
  **要卸的那个包自己留一份快照。** AlertDialogAction 被点中时会先关弹窗,
  关闭触发 @update:open 把 removeTarget 清成 null —— 这发生在按钮的 @click **之前**,
  于是拿到 null 直接 return,表现是「点了卸载什么都没发生」。
  这个应用里已经踩过三次(Vault 删除、会话归档、删项目),照同一个办法处理。
*/
let pendingRemove: PluginState | null = null

function askRemovePlugin(p: PluginState) {
  pendingRemove = p
  removeTarget.value = p
  removePrune.value = false
}

async function doRemovePlugin() {
  const p = pendingRemove
  pendingRemove = null
  removeTarget.value = null
  if (!p) return
  busyPlugin.value = p.package
  pluginError.value = ''
  dsh.installLine = ''
  try {
    await removePlugin(p.package, removePrune.value)
    await loadPlugins()
  } catch (e) {
    pluginError.value = String(e)
  } finally {
    busyPlugin.value = ''
    dsh.installLine = ''
  }
}

onMounted(loadPlugins)

// ── DSH 卸载 ──
const footprint = ref<DshFootprint | null>(null)
const uninstallOpen = ref(false)
const purgeHome = ref(false)
const uninstalling = ref(false)
const dshInstalled = computed(() => !!dsh.pre?.dshEntry)

/** 每次打开确认框都重新量一次:体积和会话数是会变的,拿缓存来吓唬人不合适 */
async function openUninstall() {
  footprint.value = await dshFootprint()
  purgeHome.value = false          // 危险选项每次都从「不勾」开始
  uninstallOpen.value = true
}

async function doUninstall() {
  uninstalling.value = true
  try {
    await uninstallDsh(purgeHome.value)
    footprint.value = await dshFootprint()
  } catch (e) {
    console.error('卸载失败:', e)
  } finally {
    uninstalling.value = false
  }
}

onMounted(async () => { footprint.value = await dshFootprint() })

// ---------- 窗口背景特效 ----------
const BLUR_KINDS: { key: BlurKind; nameKey: string }[] = [
  { key: 'none', nameKey: 'settings.bgNone' },
  { key: 'mica', nameKey: 'settings.bgMica' },
  { key: 'acrylic', nameKey: 'settings.bgAcrylic' },
]

// 语言:'auto' 跟随系统,选定之后就固定用那个
const LANGS: { key: Locale | 'auto'; label: string }[] = [
  { key: 'auto', label: t('settings.languageAuto') },
  { key: 'zh', label: '中文' },
  { key: 'en', label: 'English' },
]
function setLanguage(v: Locale | 'auto') {
  settings.language = v
  setLocale(v === 'auto' ? detectLocale() : v)
}

async function applyEffect(kind: BlurKind = settings.blurKind): Promise<boolean> {
  const err = await applyWindowEffect(kind)
  effectError.value = err ?? ''
  return err === null
}

/**
 * 切换特效种类。两个方向的顺序是反的,否则会闪:
 *  · 切到「关闭」:先让 CSS 把不透明底画回来,再清系统材质。反过来的话中间会有一帧
 *    「材质已清掉、CSS 还透明」→ 整窗全透明闪一下。
 *  · 切到某个材质:先挂材质,再让 CSS 透出来。同理避免中间那帧全透明。
 */
async function setBlurKind(k: BlurKind) {
  if (k === 'none') {
    settings.blurKind = 'none'
    await nextTick()
    await new Promise((r) => requestAnimationFrame(() => r(null)))   // 等这一帧真的画出来
    await applyEffect('none')
    return
  }
  const ok = await applyEffect(k)
  settings.blurKind = ok ? k : 'none'
}
function setBlurOpacity(v?: number[]) {
  const n = v?.[0]
  if (typeof n !== 'number') return
  settings.blurOpacity = n   // CSS 变量由 App.vue 的 watcher 统一换算,这里不直接碰 DOM
}

// 主题:三档。改完要重新应用材质 —— 深浅属性是跟着主题走的。
const THEMES: { key: ThemeMode; labelKey: string; icon: string }[] = [
  { key: 'auto',  labelKey: 'settings.themeAuto',  icon: 'icon-[lucide--monitor]' },
  { key: 'light', labelKey: 'settings.themeLight', icon: 'icon-[lucide--sun]' },
  { key: 'dark',  labelKey: 'settings.themeDark',  icon: 'icon-[lucide--moon]' },
]
function setTheme(v: ThemeMode) {
  settings.theme = v
  applyTheme()
}

// ---------- 导航栏:排序 + 开关 ----------
const ordered = orderedAll(MENU_ITEMS, { order: settings.sidebarOrder, hidden: settings.sidebarHidden })
// 两组各自一个列表。两个 VueDraggable 共享同一个 group 名,所以条目能在上下两组之间拖来拖去,
// 拖过去就等于改了它归属哪张导航卡片。
const toolList = ref<MenuItem[]>(ordered.filter((m) => m.group === 'tool'))
const configList = ref<MenuItem[]>(ordered.filter((m) => m.group === 'config'))
const hiddenSet = computed(() => new Set(settings.sidebarHidden))

/*
  能当启动页的:上下两排里没被隐藏的那些,顺序跟着侧栏走。
  设置页本身不算 —— 没人会想每次启动停在设置里。
*/
const startCandidates = computed(() =>
  [...toolList.value, ...configList.value].filter((m) => !hiddenSet.value.has(m.id))
)

function persistOrder() {
  // 拖动可能跨组,先把每条的 group 按它现在所在的列表回写,再存顺序
  toolList.value.forEach((m) => { m.group = 'tool' })
  configList.value.forEach((m) => { m.group = 'config' })
  settings.sidebarOrder = [...toolList.value, ...configList.value].map((m) => m.id)
  settings.sidebarGroups = Object.fromEntries(
    [...toolList.value.map((m) => [m.id, 'tool'] as const),
     ...configList.value.map((m) => [m.id, 'config'] as const)]
  )
}
function toggleItem(id: string) {
  // 可以全部关掉:设置入口是常驻的,不在这份清单里,所以关光了也进得去
  settings.sidebarHidden = hiddenSet.value.has(id)
    ? settings.sidebarHidden.filter((x) => x !== id)
    : [...settings.sidebarHidden, id]
}

/** 有多少篇笔记单独设过宽度 —— 为 0 时那张「清除」卡整块不显示 */
const ATTACH_MODES = [
  { key: 'subfolder', labelKey: 'settings.vaultAttachSub' },
  { key: 'note', labelKey: 'settings.vaultAttachNote' },
  { key: 'fixed', labelKey: 'settings.vaultAttachFixed' },
] as const

const pageWidthCount = computed(() => Object.keys(settings.vaultPageWidth).length)
/** 单独设过宽度的笔记,按路径排一下,免得每次打开顺序都不一样 */
const pageWidthList = computed(() =>
  Object.entries(settings.vaultPageWidth).sort((a, b) => a[0].localeCompare(b[0])))
/** 列表里主要显示文件名,完整路径放在下面一行和 title 里 */
const pageWidthName = (path: string) => path.split('/').pop()?.replace(/\.md$/i, '') ?? path
function clearPageWidth(path: string) {
  const next = { ...settings.vaultPageWidth }
  delete next[path]
  settings.vaultPageWidth = next
}
/*
  快捷键总览。

  全软件的全局快捷键汇在这一页:能改、能看出哪个被别的程序占着(想要却没注册上)、
  能一键全部重新注册 —— 占着键的程序退出之后,不用重启我们这边也能把键抢回来。
  各功能页上原来的快捷键行还在,改哪边都是同一份数据。
*/
const HK_META: Record<ShortcutKey, { icon: string; nameKey: string; descKey: string }> = {
  palette: { icon: 'icon-[lucide--command]', nameKey: 'settings.keyPalette', descKey: 'settings.keyPaletteDesc' },
  palette_translate: { icon: 'icon-[lucide--languages]', nameKey: 'settings.keyPaletteTranslate', descKey: 'settings.keyPaletteTranslateDesc' },
  screenshot: { icon: 'icon-[lucide--camera]', nameKey: 'settings.keyScreenshot', descKey: 'settings.keyScreenshotDesc' },
  screenshot_translate: { icon: 'icon-[lucide--scan-text]', nameKey: 'settings.keyScreenshotTranslate', descKey: 'settings.keyScreenshotTranslateDesc' },
  record: { icon: 'icon-[lucide--video]', nameKey: 'settings.keyRecord', descKey: 'settings.keyRecordDesc' },
  dock: { icon: 'icon-[lucide--layout-grid]', nameKey: 'settings.keyDock', descKey: 'settings.keyDockDesc' },
}
type HkStatus = 'on' | 'taken' | 'off' | 'unset'
const HK_STATUS: Record<HkStatus, { cls: string; textKey: string }> = {
  on: { cls: 'text-emerald-500', textKey: 'settings.keyOn' },
  taken: { cls: 'text-red-500', textKey: 'settings.keyTaken' },
  off: { cls: 'text-muted-foreground', textKey: 'settings.keyOff' },
  unset: { cls: 'text-muted-foreground', textKey: 'settings.keyUnset' },
}

const hkRows = ref<ShortcutState[]>([])
const hkLive = ref<Record<string, boolean>>({})      // key → 系统层注册上了没
const hkRecording = ref<ShortcutKey | null>(null)
const hkBusy = ref(false)
const hkMsg = ref<{ ok: boolean; text: string } | null>(null)

function hkStatus(r: ShortcutState): HkStatus {
  if (!r.shortcut) return 'unset'
  if (!r.enabled) return 'off'
  return hkLive.value[r.key] ? 'on' : 'taken'
}

async function refreshHk() {
  hkRows.value = await readAllShortcuts()
  const live = await shortcutStatus().catch(() => [])
  hkLive.value = Object.fromEntries(live.map((s) => [s.key, s.registered]))
}

async function reregisterHk() {
  hkBusy.value = true
  hkMsg.value = null
  try {
    const failed = await syncAllShortcuts()
    await refreshHk()
    hkMsg.value = failed.length
      ? { ok: false, text: t('settings.keysStillTaken', { name: failed.map((k) => t(HK_META[k].nameKey)).join('、') }) }
      : { ok: true, text: t('settings.keysAllGood') }
  } catch (e) {
    hkMsg.value = { ok: false, text: String(e) }
  } finally {
    hkBusy.value = false
  }
}

async function startRecordHk(k: ShortcutKey) {
  if (hkRecording.value === k) { await stopRecordHk(); return }
  hkRecording.value = k
  hkMsg.value = null
  try { await pauseShortcuts() } catch { /* 摘不掉就照常录,顶多某些键录不到 */ }
}

/** 录完或取消都要走这里:录制时摘掉的键得装回去 */
async function stopRecordHk() {
  hkRecording.value = null
  await syncAllShortcuts().catch(() => [])
  await refreshHk()
}

/** 截图快捷键"掉了"(键在、窗口没反应)时,重载截图窗口 */
async function restartScreenshot() {
  hkMsg.value = null
  try {
    await invoke('reload_screenshot_window')
    hkMsg.value = { ok: true, text: t('settings.keysRestartShotDone') }
  } catch (e) {
    hkMsg.value = { ok: false, text: String(e) }
  }
}

async function clearHk(k: ShortcutKey) {
  await writeShortcut(k, '')
  await reregisterHk()
}

async function onHkKeydown(e: KeyboardEvent) {
  const k = hkRecording.value
  if (!k) return
  e.preventDefault()
  e.stopPropagation()
  if (e.key === 'Escape') { await stopRecordHk(); return }
  const sc = shortcutFromKeydown(e)
  if (!sc) return
  hkRecording.value = null
  await writeShortcut(k, sc)
  await reregisterHk()
}

/** 直接在这页开关功能,不用跑去各功能页 */
async function toggleHk(k: ShortcutKey, on: boolean) {
  await writeEnabled(k, on)
  await reregisterHk()
}

async function resetHk(k: ShortcutKey) {
  await writeShortcut(k, SHORTCUT_DEFAULTS[k])
  await reregisterHk()
}

const hkResetOpen = ref(false)
async function resetAllHk() {
  hkResetOpen.value = false
  await resetAllShortcuts()
  await reregisterHk()
  if (hkMsg.value?.ok) hkMsg.value = { ok: true, text: t('settings.keysResetDone') }
}

let hkUnlisten: UnlistenFn[] = []
onMounted(async () => {
  window.addEventListener('keydown', onHkKeydown)
  await refreshHk()
  hkUnlisten = await Promise.all([
    listen('shortcut-register-failed', () => { void refreshHk() }),
    listen('shortcut-register-recovered', () => { void refreshHk() }),
  ])
})
onUnmounted(() => {
  window.removeEventListener('keydown', onHkKeydown)
  hkUnlisten.forEach((u) => u())
})
</script>

<template>
  <ScrollArea class="h-full">
    <div class="max-w-3xl mx-auto px-8 py-8">
      <Tabs default-value="general">
        <TitleBarTabs>
          <TabsTrigger value="general" class="h-11 px-4 rounded-xl">{{ t('settings.general') }}</TabsTrigger>
          <TabsTrigger value="keys" class="h-11 px-4 rounded-xl">{{ t('settings.keys') }}</TabsTrigger>
          <TabsTrigger value="sidebar" class="h-11 px-4 rounded-xl">{{ t('settings.nav') }}</TabsTrigger>
          <TabsTrigger value="vault" class="h-11 px-4 rounded-xl">{{ t('settings.vault') }}</TabsTrigger>
          <TabsTrigger value="dsh" class="h-11 px-4 rounded-xl">{{ t('settings.dsh') }}</TabsTrigger>
        </TitleBarTabs>

        <!-- ================= 常规（含外观 / 关于）================= -->
        <TabsContent value="general" class="space-y-6">
          <div class="rounded-xl border divide-y">
            <div class="flex items-center gap-4 px-4 py-3.5">
              <span class="icon-[lucide--power] w-5 h-5 shrink-0 text-muted-foreground" />
              <div class="flex-1 min-w-0">
                <div class="text-sm">{{ t('settings.autostart') }}</div>
                <div class="text-xs text-muted-foreground mt-0.5">{{ t('settings.autostartDesc') }}</div>
              </div>
              <Switch :model-value="autostart" @update:model-value="setAutostart" />
            </div>
          </div>

          <div class="rounded-xl border divide-y">
            <div class="flex items-center gap-4 px-4 py-3.5">
              <span class="icon-[lucide--palette] w-5 h-5 shrink-0 text-muted-foreground" />
              <div class="flex-1 min-w-0">
                <div class="text-sm">{{ t('settings.theme') }}</div>
                <div class="text-xs text-muted-foreground mt-0.5">{{ t('settings.themeDesc') }}</div>
              </div>
              <div class="flex items-center gap-1 rounded-lg border p-1">
                <button v-for="m in THEMES" :key="m.key" @click="setTheme(m.key)" :title="t(m.labelKey)" :class="[
                  'flex items-center gap-1.5 px-3 py-1 rounded-md text-sm transition-colors',
                  settings.theme === m.key ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'
                ]">
                  <span :class="m.icon" class="w-4 h-4" />
                  {{ t(m.labelKey) }}
                </button>
              </div>
            </div>

            <div class="flex items-center gap-4 px-4 py-3.5">
              <span class="icon-[lucide--languages] w-5 h-5 shrink-0 text-muted-foreground" />
              <div class="flex-1 min-w-0">
                <div class="text-sm">{{ t('settings.language') }}</div>
                <div class="text-xs text-muted-foreground mt-0.5">{{ t('settings.languageDesc') }}</div>
              </div>
              <div class="flex items-center gap-1 rounded-lg border p-1">
                <button v-for="l in LANGS" :key="l.key" @click="setLanguage(l.key)" :class="[
                  'px-3 py-1 rounded-md text-sm transition-colors',
                  settings.language === l.key ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'
                ]">{{ l.key === 'auto' ? t('settings.languageAuto') : l.label }}</button>
              </div>
            </div>
          </div>

          <!-- 窗口背景特效 -->
          <section class="space-y-3">
            <div class="text-sm font-medium">{{ t('settings.background') }}</div>
            <div class="grid grid-cols-3 gap-2">
              <button v-for="k in BLUR_KINDS" :key="k.key" @click="setBlurKind(k.key)" :class="[
                'rounded-xl border px-3 py-3 text-left transition-colors',
                settings.blurKind === k.key ? 'border-foreground/60 bg-muted/60' : 'hover:bg-muted/40'
              ]">
                <div class="text-sm">{{ t(k.nameKey) }}</div>
              </button>
            </div>
            <div v-if="settings.blurKind !== 'none'" class="rounded-xl border px-4 py-3.5 space-y-3">
              <div class="flex items-center justify-between">
                <div class="text-sm">{{ t('settings.surfaceOpacity') }}</div>
                <span class="text-xs font-mono text-muted-foreground">{{ settings.blurOpacity }}</span>
              </div>
              <Slider :model-value="[settings.blurOpacity]" :min="0" :max="100" :step="1"
                @update:model-value="setBlurOpacity" />
            </div>

            <p v-if="effectError" class="text-xs text-amber-500">{{ t('settings.effectFailed', { msg: effectError }) }}</p>
          </section>


          <section class="space-y-1">
            <h3 class="text-sm font-medium text-muted-foreground">{{ t('settings.about') }}</h3>
          <div class="rounded-xl border divide-y">
            <div class="flex items-center gap-4 px-4 py-3.5">
              <span class="icon-[lucide--box] w-5 h-5 shrink-0 text-muted-foreground" />
              <div class="flex-1 min-w-0"><div class="text-sm">{{ t('settings.version') }}</div></div>
              <span class="text-sm font-mono text-muted-foreground">v{{ version || '—' }}</span>
            </div>
            <button class="w-full flex items-center gap-4 px-4 py-3.5 text-left hover:bg-muted/50 transition-colors"
              @click="open('https://github.com/XXGGG/XGTools')">
              <span class="icon-[lucide--github] w-5 h-5 shrink-0 text-muted-foreground" />
              <div class="flex-1 min-w-0">
                <div class="text-sm">GitHub</div>
                <div class="text-xs text-muted-foreground mt-0.5">XXGGG/XGTools</div>
              </div>
              <span class="icon-[lucide--arrow-up-right] w-4 h-4 shrink-0 text-muted-foreground" />
            </button>
          </div>
          </section>
        </TabsContent>

        <!-- ================= 导航 ================= -->
        <TabsContent value="keys" class="space-y-5">
          <p class="text-xs text-muted-foreground">{{ t('settings.keysHint') }}</p>

          <div class="rounded-xl border divide-y">
            <div v-for="r in hkRows" :key="r.key" class="flex items-center gap-4 px-4 py-3.5">
              <span :class="[HK_META[r.key].icon, 'w-5 h-5 shrink-0 text-muted-foreground']" />
              <div class="flex-1 min-w-0">
                <div class="text-sm">{{ t(HK_META[r.key].nameKey) }}</div>
                <div class="text-xs text-muted-foreground mt-0.5">{{ t(HK_META[r.key].descKey) }}</div>
              </div>
              <span class="flex items-center gap-1.5 text-xs shrink-0" :class="HK_STATUS[hkStatus(r)].cls">
                <span class="w-1.5 h-1.5 rounded-full bg-current" />
                {{ t(HK_STATUS[hkStatus(r)].textKey) }}
              </span>
              <button v-if="r.key === 'screenshot'" @click="restartScreenshot"
                :title="t('settings.keysRestartShotHint')"
                class="h-8 px-2.5 shrink-0 rounded-lg border border-border text-xs text-muted-foreground transition-colors hover:bg-muted flex items-center gap-1">
                <span class="icon-[lucide--rotate-cw] w-3.5 h-3.5" />{{ t('settings.keysRestartShot') }}
              </button>
              <button v-if="r.shortcut !== SHORTCUT_DEFAULTS[r.key] && hkRecording !== r.key" @click="resetHk(r.key)"
                :title="t('settings.keysReset')"
                class="h-8 w-8 shrink-0 rounded-lg border border-border text-muted-foreground transition-colors hover:bg-muted flex items-center justify-center">
                <span class="icon-[lucide--rotate-ccw] w-3.5 h-3.5" />
              </button>
              <button v-if="r.optional && r.shortcut && hkRecording !== r.key" @click="clearHk(r.key)"
                class="h-8 px-3 rounded-lg border border-border text-xs text-muted-foreground transition-colors hover:bg-muted">
                {{ t('settings.keysClear') }}
              </button>
              <button @click="startRecordHk(r.key)" :class="[
                'h-8 min-w-36 px-3 rounded-lg border text-xs font-mono transition-colors',
                hkRecording === r.key ? 'border-foreground/60 bg-muted/60 animate-pulse' : 'border-border hover:bg-muted'
              ]">
                {{ hkRecording === r.key ? t('dock.pressKeys') : (r.shortcut || '—') }}
              </button>
              <!-- 功能开关。翻译面板没有自己的开关,占个位保持右边对齐 -->
              <div class="w-11 shrink-0 flex justify-end">
                <Switch v-if="r.ownSwitch" :model-value="r.enabled" :title="t('settings.keysEnable')"
                  @update:model-value="(v: boolean) => toggleHk(r.key, v)" />
              </div>
            </div>
          </div>

          <div class="rounded-xl border divide-y">
            <div class="flex items-center gap-4 px-4 py-3.5">
              <span class="icon-[lucide--refresh-cw] w-5 h-5 shrink-0 text-muted-foreground" />
              <div class="flex-1 min-w-0">
                <div class="text-sm">{{ t('settings.keysReregister') }}</div>
                <div class="text-xs text-muted-foreground mt-0.5">{{ t('settings.keysReregisterDesc') }}</div>
              </div>
              <button @click="reregisterHk" :disabled="hkBusy"
                class="h-8 px-3.5 rounded-lg border border-border text-sm transition-colors hover:bg-muted disabled:opacity-50">
                {{ hkBusy ? t('settings.keysRefreshing') : t('settings.keysRefresh') }}
              </button>
            </div>
            <div class="flex items-center gap-4 px-4 py-3.5">
              <span class="icon-[lucide--rotate-ccw] w-5 h-5 shrink-0 text-muted-foreground" />
              <div class="flex-1 min-w-0">
                <div class="text-sm">{{ t('settings.keysResetAll') }}</div>
                <div class="text-xs text-muted-foreground mt-0.5">{{ t('settings.keysResetAllDesc') }}</div>
              </div>
              <button @click="hkResetOpen = true" :disabled="hkBusy"
                class="h-8 px-3.5 rounded-lg border border-border text-sm transition-colors hover:bg-muted disabled:opacity-50">
                {{ t('settings.keysResetAllBtn') }}
              </button>
            </div>
          </div>
          <p v-if="hkMsg" class="text-xs" :class="hkMsg.ok ? 'text-emerald-500' : 'text-red-500'">{{ hkMsg.text }}</p>
        </TabsContent>

        <TabsContent value="sidebar" class="space-y-5">
          <p class="text-xs text-muted-foreground">
            {{ t('settings.navHint') }}
          </p>

          <!--
            候选只列**没被隐藏的**页:选一个自己关掉的页当启动页,
            结果只能是启动时被退回别的地方 —— 那就不该让人选得到。
          -->
          <div class="rounded-xl border divide-y overflow-hidden">
            <div class="flex items-center gap-4 px-4 py-3.5">
              <span class="icon-[lucide--play] w-5 h-5 shrink-0 text-muted-foreground" />
              <div class="flex-1 min-w-0">
                <div class="text-sm">{{ t('settings.startPage') }}</div>
                <div class="text-xs text-muted-foreground mt-0.5">{{ t('settings.startPageDesc') }}</div>
              </div>
              <!--
                用项目自己的 Select,不用原生 <select> —— 原生下拉是系统控件,
                跟这套界面的圆角、配色、材质全对不上,深色模式下尤其像贴上去的。
                「__auto__」是自动那一档:reka 的 Select 不接受空串当值。
              -->
              <Select :model-value="settings.startPage || '__auto__'"
                @update:model-value="(v: any) => { settings.startPage = v === '__auto__' ? '' : String(v ?? '') }">
                <SelectTrigger class="w-44 shrink-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__auto__">{{ t('settings.startPageAuto') }}</SelectItem>
                  <SelectItem v-for="m in startCandidates" :key="m.id" :value="m.id">
                    {{ t(m.labelKey) }}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <section class="space-y-2">
            <h3 class="text-sm font-medium">{{ t('settings.navTools') }}</h3>
            <VueDraggable v-model="toolList" group="sidebar" :animation="180" :force-fallback="true"
              filter=".no-drag" :prevent-on-filter="false" ghost-class="opacity-30" @end="persistOrder"
              class="rounded-xl border divide-y overflow-hidden min-h-16">
              <div v-for="item in toolList" :key="item.id"
                class="flex items-center gap-4 px-4 py-4 bg-background cursor-grab active:cursor-grabbing">
                <span class="icon-[lucide--grip-vertical] w-4 h-4 shrink-0 text-muted-foreground" />
                <span :class="item.icon" class="w-5 h-5 shrink-0"
                  :style="{ opacity: hiddenSet.has(item.id) ? 0.4 : 1 }" />
                <span class="text-sm flex-1" :class="hiddenSet.has(item.id) ? 'text-muted-foreground' : ''">
                  {{ t(item.labelKey) }}
                </span>
                <!--
                  no-drag 区要比开关本身宽得多:filter 只在指针真正命中该元素时才拦截,
                  开关本体才十几像素,擦边就会被判成拖行 —— 这是误触的根源。
                  这里给它一整条右侧列(含内边距),够手抖的余量。
                -->
                <div class="no-drag shrink-0 flex items-center justify-end pl-6 pr-1 py-2 cursor-default">
                  <Switch :model-value="!hiddenSet.has(item.id)"
                    @update:model-value="() => toggleItem(item.id)" />
                </div>
              </div>
            </VueDraggable>
          </section>

          <section class="space-y-2">
            <h3 class="text-sm font-medium">{{ t('settings.navConfigs') }}</h3>
            <VueDraggable v-model="configList" group="sidebar" :animation="180" :force-fallback="true"
              filter=".no-drag" :prevent-on-filter="false" ghost-class="opacity-30" @end="persistOrder"
              class="rounded-xl border divide-y overflow-hidden min-h-16">
              <div v-for="item in configList" :key="item.id"
                class="flex items-center gap-4 px-4 py-4 bg-background cursor-grab active:cursor-grabbing">
                <span class="icon-[lucide--grip-vertical] w-4 h-4 shrink-0 text-muted-foreground" />
                <span :class="item.icon" class="w-5 h-5 shrink-0"
                  :style="{ opacity: hiddenSet.has(item.id) ? 0.4 : 1 }" />
                <span class="text-sm flex-1" :class="hiddenSet.has(item.id) ? 'text-muted-foreground' : ''">
                  {{ t(item.labelKey) }}
                </span>
                <!--
                  no-drag 区要比开关本身宽得多:filter 只在指针真正命中该元素时才拦截,
                  开关本体才十几像素,擦边就会被判成拖行 —— 这是误触的根源。
                  这里给它一整条右侧列(含内边距),够手抖的余量。
                -->
                <div class="no-drag shrink-0 flex items-center justify-end pl-6 pr-1 py-2 cursor-default">
                  <Switch :model-value="!hiddenSet.has(item.id)"
                    @update:model-value="() => toggleItem(item.id)" />
                </div>
              </div>
            </VueDraggable>
          </section>

        </TabsContent>

        <!-- ═══════ DSH ═══════ -->

        <!-- ================= 笔记 ================= -->
        <TabsContent value="vault" class="space-y-6">
          <p class="text-xs text-muted-foreground">{{ t('settings.vaultHint') }}</p>

          <section class="space-y-2">
            <h3 class="text-sm font-medium">{{ t('settings.vaultSecLook') }}</h3>
            <div class="rounded-xl border divide-y">
            <div class="px-4 py-3.5 space-y-3">
              <div class="flex items-center gap-4">
                <span class="icon-[lucide--type] w-5 h-5 shrink-0 text-muted-foreground" />
                <div class="flex-1 min-w-0">
                  <div class="text-sm">{{ t('settings.vaultFont') }}</div>
                  <div class="text-xs text-muted-foreground mt-0.5">{{ t('settings.vaultFontDesc') }}</div>
                </div>
              </div>
              <!--
                每一档用它自己的字体写自己的名字 —— 字体这种东西说再多也不如看一眼,
                尤其后三档中文差别很大,光看「快乐体 / 智芒星 / 马善政」根本分不出来。
              -->
              <div class="grid grid-cols-3 gap-2 pl-9">
                <button v-for="f in VAULT_FONTS" :key="f" @click="settings.vaultFont = f"
                  :style="{ fontFamily: VAULT_FONT_STACK[f] }" :class="[
                    'rounded-lg border px-3 py-2.5 text-[15px] transition-colors',
                    settings.vaultFont === f ? 'border-foreground/60 bg-muted/60' : 'hover:bg-muted/40'
                  ]">{{ t('vault.font_' + f) }}</button>
              </div>
            </div>

            <div class="flex items-center gap-4 px-4 py-3.5">
              <span class="icon-[lucide--palette] w-5 h-5 shrink-0 text-muted-foreground" />
              <div class="flex-1 min-w-0">
                <div class="text-sm">{{ t('settings.vaultAccent') }}</div>
                <div class="text-xs text-muted-foreground mt-0.5">{{ t('settings.vaultAccentDesc') }}</div>
              </div>
              <!-- 给一组定好的色而不是取色器:原生取色器和界面对不上,而且随便选容易选出看不清的 -->
              <div class="flex items-center gap-1.5 shrink-0">
                <button v-for="c in VAULT_ACCENTS" :key="c" @click="settings.vaultAccent = c"
                  :style="{ background: c }" :title="c"
                  class="size-6 rounded-full transition-transform hover:scale-110"
                  :class="settings.vaultAccent === c ? 'ring-2 ring-offset-2 ring-offset-background ring-foreground/60' : ''" />
              </div>
            </div>


            <div class="flex items-center gap-4 px-4 py-3.5">
              <span class="icon-[lucide--spell-check] w-5 h-5 shrink-0 text-muted-foreground" />
              <div class="flex-1 min-w-0">
                <div class="text-sm">{{ t('settings.vaultSpellcheck') }}</div>
                <div class="text-xs text-muted-foreground mt-0.5">{{ t('settings.vaultSpellcheckDesc') }}</div>
              </div>
              <Switch v-model="settings.vaultSpellcheck" />
            </div>

            <div class="flex items-center gap-4 px-4 py-3.5">
              <span class="icon-[lucide--panel-bottom] w-5 h-5 shrink-0 text-muted-foreground" />
              <div class="flex-1 min-w-0">
                <div class="text-sm">{{ t('settings.vaultStatusBar') }}</div>
                <div class="text-xs text-muted-foreground mt-0.5">{{ t('settings.vaultStatusBarDesc') }}</div>
              </div>
              <Switch v-model="settings.vaultStatusBar" />
            </div>

            <div class="flex items-center gap-4 px-4 py-3.5">
              <span class="icon-[lucide--paintbrush] w-5 h-5 shrink-0 text-muted-foreground" />
              <div class="flex-1 min-w-0">
                <div class="text-sm">{{ t('settings.vaultColorHeadings') }}</div>
                <div class="text-xs text-muted-foreground mt-0.5">{{ t('settings.vaultColorHeadingsDesc') }}</div>
              </div>
              <Switch v-model="settings.vaultColorHeadings" />
            </div>

            <div class="flex items-center gap-4 px-4 py-3.5">
              <span class="icon-[lucide--a-large-small] w-5 h-5 shrink-0 text-muted-foreground" />
              <div class="flex-1 min-w-0">
                <div class="text-sm">{{ t('settings.vaultFontSize') }}</div>
                <div class="text-xs text-muted-foreground mt-0.5">
                  {{ t('settings.vaultFontSizeDesc', { min: VAULT_FONT_SIZE.min, max: VAULT_FONT_SIZE.max }) }}
                </div>
              </div>
              <!-- 滑块行程就是允许的范围本身,超出的值根本选不到 -->
              <div class="flex items-center gap-3 shrink-0">
                <Slider :model-value="[settings.vaultFontSize]" :min="VAULT_FONT_SIZE.min"
                  :max="VAULT_FONT_SIZE.max" :step="VAULT_FONT_SIZE.step" class="w-40"
                  @update:model-value="(v: number[] | undefined) => { if (v) settings.vaultFontSize = v[0] }" />
                <span class="w-10 text-right text-sm tabular-nums text-muted-foreground">
                  {{ settings.vaultFontSize }}px
                </span>
              </div>
            </div>




            <div class="flex items-center gap-4 px-4 py-3.5">
              <span class="icon-[lucide--between-horizontal-start] w-5 h-5 shrink-0 text-muted-foreground" />
              <div class="flex-1 min-w-0">
                <div class="text-sm">{{ t('settings.vaultFullWidth') }}</div>
                <div class="text-xs text-muted-foreground mt-0.5">{{ t('settings.vaultFullWidthDesc') }}</div>
              </div>
              <Switch v-model="settings.vaultFullWidth" />
            </div>
            </div>
          </section>

          <section class="space-y-2">
            <h3 class="text-sm font-medium">{{ t('settings.vaultSecImages') }}</h3>
            <div class="rounded-xl border divide-y">
          <!--
            三个模式按钮和上面那行是**同一件事**,必须待在同一个格子里。
            分成两个格子的话 divide-y 会在标题和它自己的选项之间划一道线,
            看着像「图片存放」和一排来路不明的按钮各是一项。
          -->
          <div class="px-4 py-3.5 space-y-3">
            <div class="flex items-center gap-4">
              <span class="icon-[lucide--image] w-5 h-5 shrink-0 text-muted-foreground" />
              <div class="flex-1 min-w-0">
                <div class="text-sm">{{ t('settings.vaultAttach') }}</div>
                <div class="text-xs text-muted-foreground mt-0.5">{{ t('settings.vaultAttachDesc') }}</div>
              </div>
              <!-- 「和笔记并排」不需要目录名,那个框跟着隐藏,免得填了没用还让人以为坏了 -->
              <Input v-if="settings.vaultAttachMode !== 'note'" v-model="settings.vaultAttachDir"
                class="w-40 h-9 shrink-0" :placeholder="t('settings.vaultAttachPlaceholder')" />
            </div>
            <!-- 缩进对齐上面那行的标题:图标 w-5 + gap-4 = pl-9 -->
            <div class="grid grid-cols-3 gap-2 pl-9">
              <button v-for="m in ATTACH_MODES" :key="m.key" @click="settings.vaultAttachMode = m.key" :class="[
                'rounded-lg border px-3 py-2 text-sm transition-colors',
                settings.vaultAttachMode === m.key ? 'border-foreground/60 bg-muted/60' : 'hover:bg-muted/40'
              ]">{{ t(m.labelKey) }}</button>
            </div>
          </div>
          <div class="flex items-center gap-4 px-4 py-3.5">
            <span class="icon-[lucide--eye-off] w-5 h-5 shrink-0 text-muted-foreground" />
            <div class="flex-1 min-w-0">
              <div class="text-sm">{{ t('settings.vaultHideAttach') }}</div>
              <div class="text-xs text-muted-foreground mt-0.5">{{ t('settings.vaultHideAttachDesc') }}</div>
            </div>
            <Switch v-model="settings.vaultHideAttachDir"
              :disabled="settings.vaultAttachMode === 'note'" />
          </div>
          <div class="flex items-center gap-4 px-4 py-3.5">
            <span class="icon-[lucide--file-image] w-5 h-5 shrink-0 text-muted-foreground" />
            <div class="flex-1 min-w-0">
              <div class="text-sm">{{ t('settings.vaultWebp') }}</div>
              <div class="text-xs text-muted-foreground mt-0.5">{{ t('settings.vaultWebpDesc') }}</div>
            </div>
            <Switch v-model="settings.vaultWebp" />
          </div>
            </div>
          </section>

          <section class="space-y-2">
            <h3 class="text-sm font-medium">{{ t('settings.vaultSecDelete') }}</h3>
            <div class="rounded-xl border divide-y">
          <div class="flex items-center gap-4 px-4 py-3.5">
            <span class="icon-[lucide--trash-2] w-5 h-5 shrink-0 text-muted-foreground" />
            <div class="flex-1 min-w-0">
              <div class="text-sm">{{ t('settings.vaultTrash') }}</div>
              <div class="text-xs text-muted-foreground mt-0.5">{{ t('settings.vaultTrashDesc') }}</div>
            </div>
            <div class="flex items-center gap-1 rounded-lg border p-1 shrink-0">
              <button v-for="o in [false, true]" :key="String(o)" @click="settings.vaultTrashToSystem = o" :class="[
                'px-3 py-1 rounded-md text-sm transition-colors',
                settings.vaultTrashToSystem === o ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'
              ]">{{ o ? t('settings.vaultTrashSystem') : t('settings.vaultTrashVault') }}</button>
            </div>
          </div>
            </div>
          </section>

          <!--
            单页宽度:哪几篇笔记单独设过。

            以前只有一颗「一键清除」—— 想留着其中一两篇就没辙了,只能全清再一篇篇设回去。
            现在摊开成一份清单,每条自己一个 ×,底下再留一颗「全部清除」。
            条目攒久了会指向已经删掉的笔记,所以还是要有那颗全清。
          -->
          <section v-if="pageWidthCount > 0" class="space-y-2">
            <div class="flex items-baseline justify-between">
              <h3 class="text-sm font-medium">{{ t('settings.vaultPageWidthTitle') }}</h3>
              <button @click="settings.vaultPageWidth = {}"
                class="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
                {{ t('settings.vaultPageWidthClearAll') }}
              </button>
            </div>
            <p class="text-xs text-muted-foreground">{{ t('settings.vaultPageWidthDesc', { n: pageWidthCount }) }}</p>
            <div class="rounded-xl border divide-y max-h-64 overflow-y-auto">
              <div v-for="[path, mode] in pageWidthList" :key="path"
                class="flex items-center gap-3 px-4 py-2.5">
                <span class="icon-[lucide--file-text] w-4 h-4 shrink-0 text-muted-foreground" />
                <div class="flex-1 min-w-0">
                  <div class="text-sm truncate" :title="path">{{ pageWidthName(path) }}</div>
                  <div class="text-xs text-muted-foreground truncate" :title="path">{{ path }}</div>
                </div>
                <span class="text-xs text-muted-foreground shrink-0">
                  {{ mode === 'wide' ? t('settings.vaultPageWidthWide') : t('settings.vaultPageWidthNarrow') }}
                </span>
                <button @click="clearPageWidth(path)" :title="t('settings.vaultPageWidthClear')"
                  class="size-7 shrink-0 rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground flex items-center justify-center">
                  <span class="icon-[lucide--x] w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </section>
        </TabsContent>

        <TabsContent value="dsh" class="space-y-6">

          <section class="space-y-3">
            <div class="text-sm font-medium">{{ t('settings.dshSurface') }}</div>
            <div class="grid grid-cols-2 gap-2">
              <button v-for="s in CHAT_SURFACES" :key="s.key" @click="settings.agentChatSurface = s.key" :class="[
                'rounded-xl border px-4 py-3 text-left transition-colors',
                settings.agentChatSurface === s.key ? 'border-foreground/60 bg-muted/60' : 'hover:bg-muted/40'
              ]">
                <div class="text-sm">{{ t(s.nameKey) }}</div>
                <div class="text-xs text-muted-foreground mt-1 leading-relaxed">{{ t(s.descKey) }}</div>
              </button>
            </div>
          </section>

          <div class="rounded-xl border divide-y">
            <div class="flex items-center gap-4 px-4 py-3.5">
              <span class="icon-[lucide--message-square-quote] w-5 h-5 shrink-0 text-muted-foreground" />
              <div class="flex-1 min-w-0">
                <div class="text-sm">{{ t('settings.dshGreeting') }}</div>
                <div class="text-xs text-muted-foreground mt-0.5">{{ t('settings.dshGreetingDesc') }}</div>
              </div>
              <Input v-model="settings.agentGreeting" :placeholder="t('settings.dshGreetingPlaceholder')"
                class="w-52 shrink-0" />
            </div>

            <div class="px-4 py-3.5 space-y-3">
              <div class="flex items-center gap-4">
                <span class="icon-[lucide--panel-left] w-5 h-5 shrink-0 text-muted-foreground" />
                <div class="flex-1 min-w-0">
                  <div class="text-sm">{{ t('settings.dshSidebarWidth') }}</div>
                  <div class="text-xs text-muted-foreground mt-0.5">{{ t('settings.dshSidebarWidthDesc') }}</div>
                </div>
                <span class="text-xs font-mono text-muted-foreground">{{ settings.agentSidebarWidth }}px</span>
              </div>
              <Slider :model-value="[settings.agentSidebarWidth]"
                :min="AGENT_SIDEBAR.min" :max="AGENT_SIDEBAR.max" :step="4"
                @update:model-value="setAgentSidebarWidth" />
            </div>
          </div>

          <!--
            可选插件。装的是 **DSH 的插件**,不是我们的功能 —— 装上之后模型多一个
            能力,界面一行都不用改。这就是「一切皆插件」在产品层面的样子。
          -->
          <section class="space-y-3">
            <div>
              <div class="text-sm font-medium">{{ t('settings.dshPlugins') }}</div>
              <div class="text-xs text-muted-foreground mt-1">{{ t('settings.dshPluginsDesc') }}</div>
            </div>
            <div class="rounded-xl border divide-y">
              <div v-for="p in plugins" :key="p.package" class="px-4 py-3.5">
                <div class="flex items-start gap-4">
                  <span class="icon-[lucide--puzzle] w-5 h-5 shrink-0 mt-0.5 text-muted-foreground" />
                  <div class="flex-1 min-w-0">
                    <div class="text-sm">{{ PLUGIN_INFO[p.id]?.name ?? p.id }}</div>
                    <div class="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                      {{ PLUGIN_INFO[p.id]?.desc ?? p.package }}
                    </div>
                  </div>
                  <span v-if="p.installed" class="text-xs text-emerald-500 shrink-0 mt-1.5">
                    {{ t('settings.dshPluginInstalled') }}
                  </span>
                  <button v-if="p.installed" @click="askRemovePlugin(p)" :disabled="!!busyPlugin"
                    class="h-8 px-3.5 shrink-0 rounded-lg border border-border text-sm transition-colors
                           hover:bg-muted disabled:opacity-50">
                    {{ t('settings.dshPluginRemove') }}
                  </button>
                  <button v-else @click="installPlugin(p.package)" :disabled="!!busyPlugin"
                    class="h-8 px-3.5 shrink-0 rounded-lg border border-border text-sm transition-colors
                           hover:bg-muted disabled:opacity-50">
                    {{ t('settings.dshPluginAdd') }}
                  </button>
                </div>

                <!--
                  装/卸的进度。pnpm 拉一个包能拉十几秒,期间按钮只写着「安装中」的话
                  没人知道它是在动还是卡了 —— 一条不定长的进度条 + 它自己最后吐的那行,
                  合起来才回答「还在动吗」和「在干什么」。
                -->
                <div v-if="busyPlugin === p.package" class="mt-3 pl-9">
                  <div class="h-1 rounded-full bg-muted overflow-hidden">
                    <div class="h-full w-1/3 rounded-full bg-foreground/60 animate-[dsh-slide_1.2s_ease-in-out_infinite]" />
                  </div>
                  <p class="mt-1.5 text-[11px] text-muted-foreground font-mono truncate">
                    {{ dsh.installLine || t('settings.dshPluginWorking') }}
                  </p>
                </div>
              </div>
            </div>
            <p v-if="pluginError" class="text-xs text-red-500 wrap-break-word">{{ pluginError }}</p>
          </section>

          <!--
            API 密钥。
            走 DSH 的 credentials 接口而不是手改它的 yaml —— 那接口的 describe
            **永远不返回值**,所以 XGTools 全程不持有你的密钥,界面上也没法泄露。
            输入框是一次性的:填完就发走清空,不回显。
          -->
          <section class="space-y-3">
            <div>
              <div class="text-sm font-medium">{{ t('settings.dshKeys') }}</div>
              <div class="text-xs text-muted-foreground mt-1">{{ t('settings.dshKeysDesc') }}</div>
            </div>

            <p v-if="!chatReady" class="text-xs text-muted-foreground">{{ t('settings.dshKeyNeedConnect') }}</p>

            <div v-else class="rounded-xl border divide-y">
              <div v-for="c in CREDENTIAL_REFS" :key="c.ref" class="px-4 py-3.5 space-y-2.5">
                <div class="flex items-center gap-3">
                  <span class="icon-[lucide--key-round] w-4 h-4 shrink-0 text-muted-foreground" />
                  <div class="flex-1 min-w-0">
                    <div class="text-sm">{{ c.label }}</div>
                    <div class="text-xs mt-0.5" :class="creds[c.ref]?.configured ? 'text-emerald-500' : 'text-muted-foreground'">
                      {{ creds[c.ref]?.configured ? t('settings.dshKeySet') : t('settings.dshKeyUnset') }}
                      <template v-if="creds[c.ref]?.configured && creds[c.ref]?.source">
                        · {{ creds[c.ref]?.source === 'env' ? t('settings.dshKeySourceEnv') : t('settings.dshKeySourceFile') }}
                      </template>
                    </div>
                  </div>
                  <button v-if="creds[c.ref]?.configured && creds[c.ref]?.writable"
                    @click="clearKey(c.ref)"
                    class="h-8 px-3 rounded-lg border border-border text-xs text-muted-foreground transition-colors hover:bg-muted">
                    {{ t('settings.dshKeyClear') }}
                  </button>
                </div>

                <!-- 环境变量层是只读的:那种情况下写进去也不会生效,与其让用户白填,不如直说 -->
                <p v-if="creds[c.ref] && !creds[c.ref].writable" class="text-xs text-amber-500 pl-7">
                  {{ t('settings.dshKeyLocked') }}
                </p>
                <div v-else class="flex gap-2 pl-7">
                  <Input v-model="keyDraft[c.ref]" type="password" autocomplete="off"
                    :placeholder="t('settings.dshKeyPlaceholder')" class="flex-1"
                    @keydown.enter="saveKey(c.ref)" />
                  <button @click="saveKey(c.ref)" :disabled="!keyDraft[c.ref]?.trim()"
                    class="h-9 px-3.5 rounded-lg border border-border text-sm transition-colors
                           hover:bg-muted disabled:opacity-40">
                    {{ t('settings.dshKeySave') }}
                  </button>
                </div>
                <p v-if="keySaved === c.ref" class="text-xs text-emerald-500 pl-7">{{ t('settings.dshKeySaved') }}</p>
                <p v-if="keyError[c.ref]" class="text-xs text-red-500 pl-7 wrap-break-word">{{ keyError[c.ref] }}</p>
              </div>
            </div>
          </section>

          <!-- 卸载。能一键装就得能一键卸,否则那 250MB 只能让用户自己去 AppData 里翻。 -->
          <div class="rounded-xl border divide-y">
            <div class="flex items-center gap-4 px-4 py-3.5">
              <span class="icon-[lucide--trash-2] w-5 h-5 shrink-0 text-muted-foreground" />
              <div class="flex-1 min-w-0">
                <div class="text-sm">{{ t('settings.dshUninstall') }}</div>
                <div class="text-xs text-muted-foreground mt-0.5">
                  {{ dshInstalled
                    ? t('settings.dshUninstallDesc', { size: humanSize(footprint?.installBytes ?? 0) })
                    : t('settings.dshNothing') }}
                </div>
              </div>
              <button v-if="dshInstalled" @click="openUninstall" :disabled="uninstalling"
                class="h-8 px-3.5 rounded-lg border border-destructive/40 text-sm text-destructive
                       transition-colors hover:bg-destructive/10 disabled:opacity-50">
                {{ uninstalling ? t('settings.dshUninstalling') : t('settings.dshUninstallBtn') }}
              </button>
            </div>
          </div>

        </TabsContent>
      </Tabs>
    </div>

    <!--
      卸载确认。用项目自己的 AlertDialog,不用浏览器原生 confirm。
      正文里给的是真实数字(占用体积、会话数、有没有密钥)—— 只写"会清除记忆"
      用户没法判断这个决定有多重。
    -->
    <AlertDialog v-model:open="uninstallOpen">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{{ t('settings.dshUninstallTitle') }}</AlertDialogTitle>
          <AlertDialogDescription>
            {{ t('settings.dshUninstallBody', { size: humanSize(footprint?.installBytes ?? 0) }) }}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <!-- DSH 自己的家目录单独一档:它装的是聊天历史和密钥,不该跟着程序本体一起被删 -->
        <div v-if="footprint?.homePath" class="rounded-xl border p-3.5 space-y-2.5">
          <label class="flex items-start gap-3 cursor-pointer">
            <Checkbox v-model="purgeHome" class="mt-0.5 shrink-0" />
            <span class="min-w-0">
              <span class="block text-sm">{{ t('settings.dshPurge') }}</span>
              <span class="block text-xs text-muted-foreground mt-1 font-mono wrap-break-word">
                {{ footprint.homePath }}
              </span>
              <span class="block text-xs text-muted-foreground mt-0.5">
                {{ footprint.sessionCount }} 段会话 · {{ humanSize(footprint.homeBytes) }}<template
                  v-if="footprint.hasCredentials">{{ t('settings.dshPurgeCred') }}</template>
              </span>
            </span>
          </label>
          <p v-if="purgeHome" class="text-xs leading-relaxed text-amber-500">
            {{ t('settings.dshPurgeWarn') }}
          </p>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel>{{ t('convert.cancel') }}</AlertDialogCancel>
          <AlertDialogAction @click="doUninstall"
            class="bg-destructive text-white hover:bg-destructive/90">
            {{ t('settings.dshUninstallBtn') }}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <!--
      卸插件的确认。和卸 DSH 本体同一套版式:先说清楚卸掉之后少了什么,
      再把「可选清除」单独框出来 —— 那一档默认不勾,而且写明它是 pnpm 的下载缓存,
      不是这个插件的数据。这类插件除了 node_modules 里那个包不留别的东西,
      为了凑一个「清除文件」的选项去编一个,比没有这个选项更糟。
    -->
    <AlertDialog :open="!!removeTarget" @update:open="(v: boolean) => { if (!v) removeTarget = null }">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {{ t('settings.dshPluginRemoveTitle', { name: PLUGIN_INFO[removeTarget?.id ?? '']?.name ?? removeTarget?.id ?? '' }) }}
          </AlertDialogTitle>
          <AlertDialogDescription>{{ t('settings.dshPluginRemoveBody') }}</AlertDialogDescription>
        </AlertDialogHeader>

        <div class="rounded-xl border p-3.5 space-y-2.5">
          <label class="flex items-start gap-3 cursor-pointer">
            <Checkbox v-model="removePrune" class="mt-0.5 shrink-0" />
            <span class="min-w-0">
              <span class="block text-sm">{{ t('settings.dshPluginPrune') }}</span>
              <span class="block text-xs text-muted-foreground mt-1 leading-relaxed">
                {{ t('settings.dshPluginPruneDesc') }}
              </span>
            </span>
          </label>
          <p v-if="removePrune" class="text-xs leading-relaxed text-amber-500">
            {{ t('settings.dshPluginPruneWarn') }}
          </p>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel>{{ t('convert.cancel') }}</AlertDialogCancel>
          <AlertDialogAction @click="doRemovePlugin"
            class="bg-destructive text-white hover:bg-destructive/90">
            {{ removePrune ? t('settings.dshPluginRemoveBtnPrune') : t('settings.dshPluginRemoveBtn') }}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <AlertDialog v-model:open="hkResetOpen">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{{ t('settings.keysResetAllTitle') }}</AlertDialogTitle>
          <AlertDialogDescription>{{ t('settings.keysResetAllBody') }}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{{ t('convert.cancel') }}</AlertDialogCancel>
          <AlertDialogAction @click="resetAllHk">{{ t('settings.keysResetAllBtn') }}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </ScrollArea>
</template>
