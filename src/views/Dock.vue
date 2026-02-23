<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { readFile, readTextFile } from '@tauri-apps/plugin-fs'
import { LazyStore } from '@tauri-apps/plugin-store'
import { VueDraggable } from 'vue-draggable-plus'
import { Cropper } from 'vue-advanced-cropper'
import 'vue-advanced-cropper/dist/style.css'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { Input } from '@/components/ui/input'
import type { AppEntry, CustomIcon } from '../types'

interface StartMenuEntry {
  name: string
  path: string
  target: string
  icon?: string | null
}

interface Settings {
  dark_mode: boolean
  show_names: boolean
  auto_start: boolean
  icon_size: number
  hover_scale: number
  blur_amount: number
  backdrop_opacity: number
  shortcut: string
  grid_gap: number
  padding_top: number
  padding_horizontal: number
  icon_glow: number
}

const screenshotStore = new LazyStore('settings.json')

// --- State ---
const currentTab = ref<'general' | 'apps' | 'icons'>('general')
const apps = ref<AppEntry[]>([])
const dockEnabled = ref(false)
const settingsLoaded = ref(false)

// General settings
const showNames = ref(false)
const iconSize = ref(88)
const hoverScale = ref(1.1)
const shortcutKey = ref('Ctrl+Alt+D')
const paddingTop = ref(92)
const paddingHorizontal = ref(56)
const iconGlow = ref(0)
const isRecordingShortcut = ref(false)
const recordingKeys = ref('')

// Refresh icons
const isRefreshingIcons = ref(false)

// Manual add dialog
const showManualDialog = ref(false)
const isDragging = ref(false)
const newName = ref('')
const newPath = ref('')
const isAdding = ref(false)

// Start Menu dialog
const showStartMenuDialog = ref(false)
const startMenuApps = ref<StartMenuEntry[]>([])
const isScanning = ref(false)
const scanSearch = ref('')
const addingTargets = ref<Set<string>>(new Set())
const startMenuFilter = ref<'all' | 'added' | 'not_added'>('all')

// Edit app dialog
const showEditDialog = ref(false)
const editingApp = ref<AppEntry | null>(null)
const editName = ref('')
const editIcon = ref<string | null>(null)
const showIconPicker = ref(false)

// Icon management
const customIcons = ref<CustomIcon[]>([])
const cropperSrc = ref('')
const cropperRef = ref<InstanceType<typeof Cropper> | null>(null)
const isCropping = ref(false)
const cropIconName = ref('')
const isSavingIcon = ref(false)

const existingPaths = computed(() => new Set(apps.value.map(a => a.path.toLowerCase())))

const filteredStartMenuApps = computed(() => {
  const q = scanSearch.value.toLowerCase().trim()
  let list = startMenuApps.value

  if (startMenuFilter.value === 'added') {
    list = list.filter(e => existingPaths.value.has(e.target.toLowerCase()))
  } else if (startMenuFilter.value === 'not_added') {
    list = list.filter(e => !existingPaths.value.has(e.target.toLowerCase()))
  }

  if (q) {
    list = list.filter(e => e.name.toLowerCase().includes(q) || e.target.toLowerCase().includes(q))
  }
  return list
})

onMounted(async () => {
  await loadSettings()
  await loadApps()
  try {
    startMenuApps.value = await invoke<StartMenuEntry[]>('get_start_menu_cache')
    if (startMenuApps.value.some(e => !e.icon)) {
      extractIconsProgressively()
    }
  } catch (e) {
    console.error('Failed to load start menu cache:', e)
  }
  await loadCustomIcons()
  window.addEventListener('keydown', handleShortcutKeydown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleShortcutKeydown)
})

async function loadSettings() {
  try {
    const s = await invoke<Settings>('get_settings')
    showNames.value = s.show_names
    iconSize.value = s.icon_size
    hoverScale.value = s.hover_scale
    shortcutKey.value = s.shortcut
    paddingTop.value = s.padding_top
    paddingHorizontal.value = s.padding_horizontal
    iconGlow.value = s.icon_glow ?? 0
    dockEnabled.value = s.auto_start ?? false
    settingsLoaded.value = true
  } catch (e) {
    console.error('Failed to load settings:', e)
  }
}

async function saveSettings() {
  try {
    await invoke('save_settings', {
      settings: {
        dark_mode: true,
        show_names: showNames.value,
        auto_start: dockEnabled.value,
        icon_size: iconSize.value,
        hover_scale: hoverScale.value,
        blur_amount: 30,
        backdrop_opacity: 0.65,
        shortcut: shortcutKey.value,
        grid_gap: 64,
        padding_top: paddingTop.value,
        padding_horizontal: paddingHorizontal.value,
        icon_glow: iconGlow.value,
      },
    })
  } catch (e) {
    console.error('Failed to save settings:', e)
  }
}

watch([showNames, iconSize, hoverScale, iconGlow, paddingTop, paddingHorizontal], () => {
  if (!settingsLoaded.value) return
  saveSettings()
})

async function syncAllShortcuts() {
  try {
    await screenshotStore.init()
    const ssEnabled = (await screenshotStore.get<boolean>('screenshot_enabled')) ?? true
    const ssShortcut = (await screenshotStore.get<string>('screenshot_shortcut')) ?? 'Ctrl+Alt+A'
    const stEnabled = (await screenshotStore.get<boolean>('screenshot_translate_enabled')) ?? false
    const stShortcut = (await screenshotStore.get<string>('screenshot_translate_shortcut')) ?? ''
    await invoke('update_all_shortcuts', {
      shortcuts: {
        dock_shortcut: dockEnabled.value ? shortcutKey.value : null,
        screenshot_shortcut: ssEnabled ? ssShortcut : null,
        screenshot_translate_shortcut: stEnabled && stShortcut ? stShortcut : null,
      }
    })
  } catch (e) {
    console.error('Failed to sync shortcuts:', e)
  }
}

watch(dockEnabled, async () => {
  if (!settingsLoaded.value) return
  await saveSettings()
  await syncAllShortcuts()
})

// Shortcut recorder
function startRecordingShortcut() {
  isRecordingShortcut.value = true
  recordingKeys.value = ''
}

function handleShortcutKeydown(e: KeyboardEvent) {
  if (!isRecordingShortcut.value) return
  e.preventDefault()
  e.stopPropagation()
  if (e.key === 'Escape') { cancelRecording(); return }
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return

  const parts: string[] = []
  if (e.ctrlKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  if (e.metaKey) parts.push('Super')
  if (parts.length === 0) return

  let key = e.key.toUpperCase()
  if (e.code.startsWith('Key')) key = e.code.slice(3)
  else if (e.code.startsWith('Digit')) key = e.code.slice(5)
  else if (e.code.startsWith('F') && /^F\d+$/.test(e.code)) key = e.code
  else {
    const keyMap: Record<string, string> = {
      ' ': 'Space', 'ENTER': 'Enter', 'TAB': 'Tab',
      'BACKSPACE': 'Backspace', 'DELETE': 'Delete',
      'ARROWUP': 'Up', 'ARROWDOWN': 'Down',
      'ARROWLEFT': 'Left', 'ARROWRIGHT': 'Right',
    }
    key = keyMap[key] || key
  }

  parts.push(key)
  const shortcutStr = parts.join('+')
  recordingKeys.value = shortcutStr
  isRecordingShortcut.value = false
  applyShortcut(shortcutStr)
}

async function applyShortcut(shortcutStr: string) {
  const oldShortcut = shortcutKey.value
  try {
    shortcutKey.value = shortcutStr
    await saveSettings()
    await syncAllShortcuts()
  } catch (e) {
    console.error('Failed to update shortcut:', e)
    shortcutKey.value = oldShortcut
    recordingKeys.value = ''
    await saveSettings()
    await syncAllShortcuts()
  }
}

function cancelRecording() {
  isRecordingShortcut.value = false
  recordingKeys.value = ''
}

async function loadApps() {
  try { apps.value = await invoke<AppEntry[]>('get_apps') } catch (e) { console.error('Failed to load apps:', e) }
}

async function saveApps() {
  try { await invoke('save_apps', { apps: apps.value }) } catch (e) { console.error('Failed to save apps:', e) }
}

async function addApp(entry: Omit<AppEntry, 'id' | 'sort_order'>) {
  const newApp: AppEntry = { ...entry, id: crypto.randomUUID(), sort_order: apps.value.length }
  apps.value.push(newApp)
  await saveApps()
}

async function removeApp(id: string) {
  apps.value = apps.value.filter((a) => a.id !== id)
  await saveApps()
}

// --- Edit App ---
const editOriginalIcon = ref<string | null>(null)

function openEditDialog(app: AppEntry) {
  editingApp.value = app
  editName.value = app.name
  editIcon.value = app.icon
  editOriginalIcon.value = app.icon
  showIconPicker.value = false
  showEditDialog.value = true
}

async function saveEditedApp() {
  if (!editingApp.value || !editName.value.trim()) return
  const idx = apps.value.findIndex(a => a.id === editingApp.value!.id)
  if (idx !== -1) {
    apps.value[idx] = { ...apps.value[idx], name: editName.value.trim(), icon: editIcon.value }
    await saveApps()
  }
  showEditDialog.value = false
}

function selectIconForEdit(dataUri: string) {
  editIcon.value = dataUri
  showIconPicker.value = false
}

async function restoreDefaultIcon() {
  if (!editingApp.value) return
  try {
    const icon = await invoke<string>('extract_icon', { exePath: editingApp.value.path })
    editIcon.value = icon
  } catch (e) {
    console.error('Failed to extract icon:', e)
    editIcon.value = null
  }
}

// --- Manual add ---
async function handleBrowse() {
  const selected = await open({
    multiple: false,
    filters: [
      { name: 'Executables', extensions: ['exe', 'lnk'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  })
  if (selected) {
    const filePath = selected as string
    newPath.value = filePath
    if (filePath.toLowerCase().endsWith('.lnk')) {
      try {
        const [targetPath, displayName] = await invoke<[string, string]>('resolve_lnk', { lnkPath: filePath })
        newPath.value = targetPath
        if (!newName.value) newName.value = displayName
      } catch (e) { console.error('Failed to resolve lnk:', e) }
    }
    if (!newName.value) {
      const parts = filePath.replace(/\\/g, '/').split('/')
      newName.value = parts[parts.length - 1].replace(/\.(exe|lnk)$/i, '')
    }
  }
}

async function handleManualAdd() {
  if (!newName.value.trim() || !newPath.value.trim()) return
  isAdding.value = true
  let icon: string | null = null
  try { icon = await invoke<string>('extract_icon', { exePath: newPath.value }) } catch (e) { console.error(e) }
  await addApp({ name: newName.value.trim(), path: newPath.value.trim(), icon, group: null })
  newName.value = ''
  newPath.value = ''
  isAdding.value = false
  showManualDialog.value = false
}

function handleDragOver(e: DragEvent) { e.preventDefault(); isDragging.value = true }
function handleDragLeave() { isDragging.value = false }
async function handleDrop(e: DragEvent) {
  e.preventDefault()
  isDragging.value = false
  const files = e.dataTransfer?.files
  if (!files?.length) return
  for (const file of Array.from(files)) {
    const filePath = (file as any).path || file.name
    if (!filePath) continue
    let targetPath = filePath
    let displayName = file.name.replace(/\.(exe|lnk)$/i, '')
    if (filePath.toLowerCase().endsWith('.lnk')) {
      try {
        const [resolved, name] = await invoke<[string, string]>('resolve_lnk', { lnkPath: filePath })
        targetPath = resolved; displayName = name
      } catch (e) { console.error(e) }
    }
    let icon: string | null = null
    try { icon = await invoke<string>('extract_icon', { exePath: targetPath }) } catch (e) { console.error(e) }
    await addApp({ name: displayName, path: targetPath, icon, group: null })
  }
  showManualDialog.value = false
}

// --- Start Menu ---
let iconAbort = false

async function extractIconsProgressively() {
  iconAbort = false
  const entries = startMenuApps.value
  for (let i = 0; i < entries.length; i++) {
    if (iconAbort) break
    if (entries[i].icon) continue
    try {
      const icon = await invoke<string | null>('extract_start_menu_icon', { target: entries[i].target })
      if (icon) entries[i].icon = icon
    } catch (_) { /* skip */ }
  }
  try { await invoke('save_start_menu_cache', { entries: startMenuApps.value }) } catch (_) { /* skip */ }
}

async function scanStartMenu() {
  iconAbort = true
  isScanning.value = true
  try { startMenuApps.value = await invoke<StartMenuEntry[]>('scan_start_menu') } catch (e) { console.error('Failed to scan start menu:', e) }
  isScanning.value = false
  extractIconsProgressively()
}

async function addFromStartMenu(entry: StartMenuEntry) {
  addingTargets.value.add(entry.target)
  let extractedIcon = entry.icon || null
  if (!extractedIcon) {
    try { extractedIcon = await invoke<string>('extract_icon', { exePath: entry.target }) } catch (_) { /* skip */ }
  }
  await addApp({ name: entry.name, path: entry.target, icon: extractedIcon, group: null })
  addingTargets.value.delete(entry.target)
}

async function removeByPath(targetPath: string) {
  const app = apps.value.find(a => a.path.toLowerCase() === targetPath.toLowerCase())
  if (app) await removeApp(app.id)
}

async function refreshAllIcons() {
  isRefreshingIcons.value = true
  try {
    const updated = await invoke<AppEntry[]>('refresh_all_icons')
    apps.value = updated
  } catch (e) { console.error('Failed to refresh icons:', e) }
  isRefreshingIcons.value = false
}

// --- Icon Management ---
async function loadCustomIcons() {
  try { customIcons.value = await invoke<CustomIcon[]>('get_custom_icons') } catch (e) { console.error('Failed to load custom icons:', e) }
}

async function browseIconImage() {
  const selected = await open({
    multiple: false,
    filters: [
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'svg', 'webp'] },
    ],
  })
  if (selected) {
    const filePath = selected as string
    // Read file as data URL for cropper
    const ext = filePath.split('.').pop()?.toLowerCase() || 'png'
    if (ext === 'svg') {
      // SVG: read as text, convert to data URI, skip cropper
      const text = await readTextFile(filePath)
      const b64 = btoa(text)
      const dataUri = `data:image/svg+xml;base64,${b64}`
      await saveSvgAsIcon(dataUri, filePath)
    } else {
      // Raster image: read bytes → blob URL → show cropper
      const uint8 = await readFile(filePath)
      const blob = new Blob([uint8], { type: `image/${ext === 'jpg' ? 'jpeg' : ext}` })
      cropperSrc.value = URL.createObjectURL(blob)
      const parts = filePath.replace(/\\/g, '/').split('/')
      cropIconName.value = parts[parts.length - 1].replace(/\.\w+$/i, '')
      isCropping.value = true
    }
  }
}

async function saveSvgAsIcon(dataUri: string, filePath: string) {
  // Render SVG to PNG canvas at 128x128
  const img = new Image()
  img.crossOrigin = 'anonymous'
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = reject
    img.src = dataUri
  })
  const canvas = document.createElement('canvas')
  canvas.width = 128
  canvas.height = 128
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(img, 0, 0, 128, 128)
  const pngDataUrl = canvas.toDataURL('image/png')
  const b64 = pngDataUrl.split(',')[1]
  const parts = filePath.replace(/\\/g, '/').split('/')
  const name = parts[parts.length - 1].replace(/\.\w+$/i, '')
  isSavingIcon.value = true
  try {
    const icon = await invoke<CustomIcon>('save_custom_icon', { name, pngBase64: b64 })
    customIcons.value.push(icon)
  } catch (e) { console.error('Failed to save icon:', e) }
  isSavingIcon.value = false
}

async function confirmCrop() {
  if (!cropperRef.value) return
  const { canvas } = cropperRef.value.getResult()
  if (!canvas) return
  isSavingIcon.value = true
  // Resize to 128x128 for consistency
  const resized = document.createElement('canvas')
  resized.width = 128
  resized.height = 128
  const ctx = resized.getContext('2d')!
  ctx.drawImage(canvas, 0, 0, 128, 128)
  const pngDataUrl = resized.toDataURL('image/png')
  const b64 = pngDataUrl.split(',')[1]
  try {
    const icon = await invoke<CustomIcon>('save_custom_icon', { name: cropIconName.value || 'icon', pngBase64: b64 })
    customIcons.value.push(icon)
  } catch (e) { console.error('Failed to save icon:', e) }
  isSavingIcon.value = false
  cancelCrop()
}

function cancelCrop() {
  if (cropperSrc.value.startsWith('blob:')) URL.revokeObjectURL(cropperSrc.value)
  cropperSrc.value = ''
  isCropping.value = false
  cropIconName.value = ''
}

async function deleteCustomIcon(id: string) {
  try {
    await invoke('delete_custom_icon', { id })
    customIcons.value = customIcons.value.filter(i => i.id !== id)
  } catch (e) { console.error('Failed to delete icon:', e) }
}

// Edit icon name
const editingIconId = ref<string | null>(null)
const editingIconName = ref('')

function startEditIconName(icon: CustomIcon) {
  editingIconId.value = icon.id
  editingIconName.value = icon.name
}

async function saveIconName(id: string) {
  const name = editingIconName.value.trim()
  if (!name) { editingIconId.value = null; return }
  try {
    await invoke('rename_custom_icon', { id, name })
    const icon = customIcons.value.find(i => i.id === id)
    if (icon) icon.name = name
  } catch (e) { console.error('Failed to rename icon:', e) }
  editingIconId.value = null
}
</script>

<template>
  <div class="h-full w-full flex flex-col p-8 animate-in fade-in slide-in-from-bottom-4 duration-500">

    <!-- Tab switcher -->
    <div class="flex gap-2 mb-6 max-w-2xl mx-auto w-full">
      <Button
        :variant="currentTab === 'general' ? 'default' : 'outline'"
        size="sm"
        @click="currentTab = 'general'"
      >
        <span class="icon-[lucide--settings] w-4 h-4" />
        通用设置
      </Button>
      <Button
        :variant="currentTab === 'apps' ? 'default' : 'outline'"
        size="sm"
        @click="currentTab = 'apps'"
      >
        <span class="icon-[lucide--layout-grid] w-4 h-4" />
        应用管理
      </Button>
      <Button
        :variant="currentTab === 'icons' ? 'default' : 'outline'"
        size="sm"
        @click="currentTab = 'icons'"
      >
        <span class="icon-[lucide--image] w-4 h-4" />
        图标管理
      </Button>
    </div>

    <!-- ==================== GENERAL TAB ==================== -->
    <div v-if="currentTab === 'general'" class="flex-1 overflow-y-auto space-y-3 max-w-2xl mx-auto w-full">

      <!-- 开启启动台 (始终可操作) -->
      <div class="flex items-center justify-between p-4 border rounded-lg hover:bg-accent/50 transition-colors">
        <div class="flex items-center gap-3">
          <div class="flex items-center justify-center w-9 h-9 rounded-md text-muted-foreground">
            <span class="icon-[lucide--layout-grid] w-5 h-5" />
          </div>
          <div>
            <h3 class="font-medium">开启启动台</h3>
            <p class="text-xs text-muted-foreground">启用后可通过快捷键呼出启动台</p>
          </div>
        </div>
        <Switch :model-value="dockEnabled" @update:model-value="dockEnabled = $event" />
      </div>

      <!-- 以下设置仅在开启时可用 -->
      <div :class="{ 'opacity-40 pointer-events-none select-none': !dockEnabled }" class="space-y-3 transition-opacity duration-300">

      <!-- Global Shortcut -->
      <div class="flex items-center justify-between p-4 border rounded-lg hover:bg-accent/50 transition-colors">
        <div class="flex items-center gap-3">
          <div class="flex items-center justify-center w-9 h-9 rounded-md text-muted-foreground">
            <span class="icon-[lucide--keyboard] w-5 h-5" />
          </div>
          <div>
            <h3 class="font-medium">全局快捷键</h3>
            <p class="text-xs text-muted-foreground">切换启动台</p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          class="min-w-[120px] font-mono"
          @click="isRecordingShortcut ? cancelRecording() : startRecordingShortcut()"
        >
          {{ isRecordingShortcut ? '按下组合键...' : shortcutKey }}
        </Button>
      </div>

      <!-- Show Names -->
      <div class="flex items-center justify-between p-4 border rounded-lg hover:bg-accent/50 transition-colors">
        <div class="flex items-center gap-3">
          <div class="flex items-center justify-center w-9 h-9 rounded-md text-muted-foreground">
            <span class="icon-[lucide--tag] w-5 h-5" />
          </div>
          <div>
            <h3 class="font-medium">显示名称</h3>
            <p class="text-xs text-muted-foreground">在图标下方显示应用名称</p>
          </div>
        </div>
        <Switch :model-value="showNames" @update:model-value="showNames = $event" />
      </div>

      <!-- Icon Size -->
      <div class="flex items-center justify-between p-4 border rounded-lg hover:bg-accent/50 transition-colors">
        <div class="flex items-center gap-3">
          <div class="flex items-center justify-center w-9 h-9 rounded-md text-muted-foreground">
            <span class="icon-[lucide--maximize-2] w-5 h-5" />
          </div>
          <div>
            <h3 class="font-medium">图标大小</h3>
            <p class="text-xs text-muted-foreground">{{ iconSize }}px</p>
          </div>
        </div>
        <Slider :model-value="[iconSize]" @update:model-value="(v) => iconSize = v![0]" :min="64" :max="128" :step="4" class="w-36" />
      </div>

      <!-- Hover Scale -->
      <div class="flex items-center justify-between p-4 border rounded-lg hover:bg-accent/50 transition-colors">
        <div class="flex items-center gap-3">
          <div class="flex items-center justify-center w-9 h-9 rounded-md text-muted-foreground">
            <span class="icon-[lucide--move-diagonal] w-5 h-5" />
          </div>
          <div>
            <h3 class="font-medium">悬停缩放</h3>
            <p class="text-xs text-muted-foreground">{{ hoverScale.toFixed(2) }}x</p>
          </div>
        </div>
        <Slider :model-value="[hoverScale]" @update:model-value="(v) => hoverScale = v![0]" :min="1" :max="1.5" :step="0.05" class="w-36" />
      </div>

      <!-- Icon Glow -->
      <div class="flex items-center justify-between p-4 border rounded-lg hover:bg-accent/50 transition-colors">
        <div class="flex items-center gap-3">
          <div class="flex items-center justify-center w-9 h-9 rounded-md text-muted-foreground">
            <span class="icon-[lucide--sparkles] w-5 h-5" />
          </div>
          <div>
            <h3 class="font-medium">图标光晕</h3>
            <p class="text-xs text-muted-foreground">{{ iconGlow === 0 ? '关闭' : iconGlow + 'px' }}</p>
          </div>
        </div>
        <Slider :model-value="[iconGlow]" @update:model-value="(v) => iconGlow = v![0]" :min="0" :max="20" :step="1" class="w-36" />
      </div>

      <!-- Padding Top -->
      <div class="flex items-center justify-between p-4 border rounded-lg hover:bg-accent/50 transition-colors">
        <div class="flex items-center gap-3">
          <div class="flex items-center justify-center w-9 h-9 rounded-md text-muted-foreground">
            <span class="icon-[lucide--arrow-up-from-line] w-5 h-5" />
          </div>
          <div>
            <h3 class="font-medium">顶部间距</h3>
            <p class="text-xs text-muted-foreground">{{ paddingTop }}px</p>
          </div>
        </div>
        <Slider :model-value="[paddingTop]" @update:model-value="(v) => paddingTop = v![0]" :min="64" :max="128" :step="4" class="w-36" />
      </div>

      <!-- Padding Horizontal -->
      <div class="flex items-center justify-between p-4 border rounded-lg hover:bg-accent/50 transition-colors">
        <div class="flex items-center gap-3">
          <div class="flex items-center justify-center w-9 h-9 rounded-md text-muted-foreground">
            <span class="icon-[lucide--arrow-left-right] w-5 h-5" />
          </div>
          <div>
            <h3 class="font-medium">水平间距</h3>
            <p class="text-xs text-muted-foreground">{{ paddingHorizontal }}px</p>
          </div>
        </div>
        <Slider :model-value="[paddingHorizontal]" @update:model-value="(v) => paddingHorizontal = v![0]" :min="64" :max="128" :step="4" class="w-36" />
      </div>


      </div><!-- /disabled wrapper -->
    </div>

    <!-- ==================== APPS TAB ==================== -->
    <div v-if="currentTab === 'apps'" class="flex-1 flex flex-col max-w-2xl mx-auto w-full min-h-0" :class="{ 'opacity-40 pointer-events-none select-none': !dockEnabled }">

      <!-- Action buttons -->
      <div class="flex gap-2 mb-4">
        <Button variant="outline" class="flex-1" @click="showManualDialog = true">
          <span class="icon-[lucide--upload] w-4 h-4" />
          手动添加
        </Button>
        <Button variant="outline" class="flex-1" @click="showStartMenuDialog = true">
          <span class="icon-[lucide--layout-grid] w-4 h-4" />
          开始菜单
        </Button>
      </div>

      <!-- Apps count + refresh -->
      <div class="flex items-center justify-between mb-3">
        <p class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          应用列表
          <span v-if="apps.length > 0" class="ml-1">&middot; {{ apps.length }}</span>
        </p>
        <Button
          v-if="apps.length > 0"
          variant="ghost"
          size="sm"
          :disabled="isRefreshingIcons"
          @click="refreshAllIcons"
        >
          <span class="icon-[lucide--refresh-cw] w-3.5 h-3.5" :class="isRefreshingIcons ? 'animate-spin' : ''" />
          {{ isRefreshingIcons ? '刷新中...' : '刷新图标' }}
        </Button>
      </div>

      <!-- App list (scrollable) -->
      <div class="flex-1 overflow-y-auto border rounded-xl bg-card/50">
        <div v-if="apps.length === 0" class="py-10 text-center text-muted-foreground">
          <p class="text-sm">还没有添加应用</p>
          <p class="text-xs mt-1">使用上面的按钮来添加</p>
        </div>

        <VueDraggable
          v-else
          v-model="apps"
          :animation="150"
          :force-fallback="true"
          handle=".drag-handle"
          ghost-class="drag-ghost"
          chosen-class="drag-chosen"
          drag-class="drag-active"
          @end="saveApps"
          class="divide-y divide-border"
        >
          <div
            v-for="app in apps"
            :key="app.id"
            class="flex items-center gap-2 py-2.5 px-3 transition-colors group hover:bg-accent/50"
          >
            <!-- Drag handle -->
            <div class="drag-handle shrink-0 w-5 h-5 flex items-center justify-center cursor-grab opacity-0 group-hover:opacity-60 transition-opacity text-muted-foreground">
              <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor">
                <circle cx="3" cy="2" r="1.2"/><circle cx="7" cy="2" r="1.2"/>
                <circle cx="3" cy="7" r="1.2"/><circle cx="7" cy="7" r="1.2"/>
                <circle cx="3" cy="12" r="1.2"/><circle cx="7" cy="12" r="1.2"/>
              </svg>
            </div>
            <div class="w-8 h-8 shrink-0 flex items-center justify-center">
              <img v-if="app.icon" :src="app.icon" :alt="app.name" class="w-full h-full object-contain" />
              <span v-else class="icon-[lucide--box] w-5 h-5 text-muted-foreground" />
            </div>
            <div class="flex-1 min-w-0">
              <p class="text-sm truncate">{{ app.name }}</p>
              <p class="text-[11px] truncate font-mono text-muted-foreground">{{ app.path }}</p>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              class="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-primary"
              @click="openEditDialog(app)"
            >
              <span class="icon-[lucide--pencil] w-4 h-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              class="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive"
              @click="removeApp(app.id)"
            >
              <span class="icon-[lucide--trash-2] w-4 h-4" />
            </Button>
          </div>
        </VueDraggable>
      </div>
    </div>

    <!-- ==================== ICONS TAB ==================== -->
    <div v-if="currentTab === 'icons'" class="flex-1 flex flex-col max-w-2xl mx-auto w-full min-h-0">

      <!-- Upload button -->
      <div class="flex gap-2 mb-4">
        <Button variant="outline" class="flex-1" @click="browseIconImage" :disabled="isSavingIcon">
          <span class="icon-[lucide--upload] w-4 h-4" />
          {{ isSavingIcon ? '保存中...' : '上传图标' }}
        </Button>
      </div>

      <p class="text-xs text-muted-foreground mb-3">
        支持 PNG、JPG、SVG、WebP 格式，上传后可裁剪为正方形，支持透明通道。
      </p>

      <!-- Cropper area -->
      <div v-if="isCropping" class="mb-4 border rounded-xl p-4 bg-card/50">
        <div class="cropper-container mb-3">
          <Cropper
            ref="cropperRef"
            :src="cropperSrc"
            :stencil-props="{ aspectRatio: 1 }"
            class="w-full h-[300px]"
          />
        </div>
        <div class="flex items-center gap-2">
          <Input
            v-model="cropIconName"
            type="text"
            placeholder="图标名称"
            class="flex-1"
          />
          <Button @click="confirmCrop" :disabled="isSavingIcon">
            {{ isSavingIcon ? '保存中...' : '确认裁剪' }}
          </Button>
          <Button variant="outline" @click="cancelCrop">取消</Button>
        </div>
      </div>

      <!-- Icon grid -->
      <div class="flex-1 overflow-y-auto">
        <div v-if="customIcons.length === 0 && !isCropping" class="py-10 text-center text-muted-foreground">
          <span class="icon-[lucide--image] w-8 h-8 mx-auto mb-2 block opacity-40" />
          <p class="text-sm">还没有自定义图标</p>
          <p class="text-xs mt-1">上传图片来创建自定义图标</p>
        </div>

        <div v-else class="grid grid-cols-5 gap-3 p-2">
          <div
            v-for="icon in customIcons"
            :key="icon.id"
            class="group relative flex flex-col items-center gap-1.5 p-2 pt-3 rounded-lg hover:bg-accent/50 transition-colors"
          >
            <div class="w-14 h-14 rounded-lg bg-muted/30 flex items-center justify-center shrink-0">
              <img :src="icon.data_uri" :alt="icon.name" class="w-full h-full object-contain" />
            </div>
            <!-- Editable name -->
            <div v-if="editingIconId === icon.id" class="w-full">
              <Input
                v-model="editingIconName"
                type="text"
                class="h-6 px-1 text-[10px] text-center rounded"
                @keydown.enter="saveIconName(icon.id)"
                @blur="saveIconName(icon.id)"
                @keydown.escape="editingIconId = null"
              />
            </div>
            <p
              v-else
              class="text-[10px] text-muted-foreground truncate w-full text-center cursor-pointer hover:text-foreground transition-colors"
              @dblclick="startEditIconName(icon)"
            >
              {{ icon.name }}
            </p>
            <!-- Delete button -->
            <button
              class="absolute top-0.5 right-0.5 w-5 h-5 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
              @click="deleteCustomIcon(icon.id)"
            >
              <span class="icon-[lucide--x] w-3 h-3" />
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- ==================== EDIT APP DIALOG ==================== -->
    <Transition enter-active-class="transition-opacity duration-150" enter-from-class="opacity-0" leave-active-class="transition-opacity duration-150" leave-to-class="opacity-0">
      <div
        v-if="showEditDialog"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
        @click.self="showEditDialog = false"
      >
        <div class="w-[420px] rounded-xl p-5 shadow-2xl bg-popover border">
          <div class="flex items-center justify-between mb-4">
            <h3 class="font-medium">编辑应用</h3>
            <Button variant="ghost" size="icon-sm" @click="showEditDialog = false">
              <span class="icon-[lucide--x] w-4 h-4" />
            </Button>
          </div>

          <!-- Current icon + fields -->
          <div class="flex items-center gap-4 mb-4">
            <div class="w-16 h-16 rounded-xl border bg-muted/30 flex items-center justify-center shrink-0 overflow-hidden">
              <img v-if="editIcon" :src="editIcon" class="w-full h-full object-contain" />
              <span v-else class="icon-[lucide--box] w-8 h-8 text-muted-foreground" />
            </div>
            <div class="flex-1 space-y-2">
              <Input
                v-model="editName"
                type="text"
                placeholder="应用名称"
              />
              <div class="flex gap-1.5">
                <Button variant="outline" size="sm" @click="showIconPicker = !showIconPicker">
                  <span class="icon-[lucide--image] w-3.5 h-3.5" />
                  {{ showIconPicker ? '收起' : '更换图标' }}
                </Button>
                <Button variant="outline" size="sm" @click="restoreDefaultIcon">
                  <span class="icon-[lucide--rotate-ccw] w-3.5 h-3.5" />
                  恢复默认
                </Button>
              </div>
            </div>
          </div>

          <!-- Path (readonly) -->
          <div v-if="editingApp" class="mb-4">
            <p class="text-[11px] font-mono text-muted-foreground truncate px-1">{{ editingApp.path }}</p>
          </div>

          <!-- Icon picker (custom icons grid) -->
          <div v-if="showIconPicker" class="mb-4 border rounded-lg p-3 max-h-[200px] overflow-y-auto">
            <div v-if="customIcons.length === 0" class="py-4 text-center text-muted-foreground">
              <p class="text-xs">没有自定义图标，请先在「图标管理」中上传</p>
            </div>
            <div v-else class="grid grid-cols-6 gap-2">
              <button
                v-for="icon in customIcons"
                :key="icon.id"
                class="w-12 h-12 rounded-lg border hover:border-primary transition-colors overflow-hidden flex items-center justify-center"
                :class="editIcon === icon.data_uri ? 'border-primary ring-2 ring-primary/30' : 'border-transparent'"
                @click="selectIconForEdit(icon.data_uri)"
              >
                <img :src="icon.data_uri" class="w-full h-full object-contain" />
              </button>
            </div>
          </div>

          <div class="flex justify-end gap-2">
            <Button variant="outline" @click="showEditDialog = false">取消</Button>
            <Button :disabled="!editName.trim()" @click="saveEditedApp">保存</Button>
          </div>
        </div>
      </div>
    </Transition>

    <!-- ==================== MANUAL ADD DIALOG ==================== -->
    <Transition enter-active-class="transition-opacity duration-150" enter-from-class="opacity-0" leave-active-class="transition-opacity duration-150" leave-to-class="opacity-0">
      <div
        v-if="showManualDialog"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
        @click.self="showManualDialog = false"
      >
        <div class="w-[420px] rounded-xl p-5 shadow-2xl bg-popover border">
          <div class="flex items-center justify-between mb-4">
            <h3 class="font-medium">添加应用</h3>
            <Button variant="ghost" size="icon-sm" @click="showManualDialog = false">
              <span class="icon-[lucide--x] w-4 h-4" />
            </Button>
          </div>

          <!-- Drop Zone -->
          <div
            class="mb-4 py-6 flex flex-col items-center gap-2 rounded-lg transition-all duration-150 cursor-default border border-dashed"
            :class="isDragging ? 'border-primary bg-primary/5' : 'border-border'"
            @dragover="handleDragOver" @dragleave="handleDragLeave" @drop="handleDrop"
          >
            <span class="icon-[lucide--upload] w-5 h-5 text-muted-foreground" />
            <p class="text-xs text-muted-foreground">拖放 .exe 或 .lnk 文件到这里</p>
          </div>

          <!-- Form -->
          <div class="flex flex-col gap-2.5">
            <Input v-model="newName" type="text" placeholder="名称" />
            <div class="flex gap-2">
              <Input v-model="newPath" type="text" placeholder="可执行文件路径" class="flex-1 font-mono" />
              <Button variant="outline" size="sm" @click="handleBrowse">浏览</Button>
            </div>
            <div class="flex justify-end mt-1">
              <Button
                :disabled="!newName.trim() || !newPath.trim() || isAdding"
                @click="handleManualAdd"
              >
                {{ isAdding ? '添加中...' : '添加' }}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </Transition>

    <!-- ==================== START MENU DIALOG ==================== -->
    <Transition enter-active-class="transition-opacity duration-150" enter-from-class="opacity-0" leave-active-class="transition-opacity duration-150" leave-to-class="opacity-0">
      <div
        v-if="showStartMenuDialog"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
        @click.self="showStartMenuDialog = false"
      >
        <div class="w-[480px] h-[520px] rounded-xl shadow-2xl flex flex-col bg-popover border">
          <!-- Header -->
          <div class="flex items-center justify-between px-5 pt-4 pb-3 shrink-0">
            <h3 class="font-medium">开始菜单应用</h3>
            <div class="flex items-center gap-2">
              <Button variant="outline" size="sm" :disabled="isScanning" @click="scanStartMenu">
                <span class="icon-[lucide--refresh-cw] w-3.5 h-3.5" :class="isScanning ? 'animate-spin' : ''" />
                {{ isScanning ? '扫描中...' : startMenuApps.length > 0 ? '刷新' : '扫描' }}
              </Button>
              <Button variant="ghost" size="icon-sm" @click="showStartMenuDialog = false">
                <span class="icon-[lucide--x] w-4 h-4" />
              </Button>
            </div>
          </div>

          <!-- Filter tabs + search -->
          <div class="px-5 pb-3 shrink-0 space-y-2">
            <div class="flex gap-1 p-0.5 rounded-md bg-muted">
              <button
                v-for="tab in (['all', 'added', 'not_added'] as const)" :key="tab"
                class="flex-1 h-7 rounded text-xs transition-all"
                :class="startMenuFilter === tab
                  ? 'bg-background text-foreground font-medium shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'"
                @click="startMenuFilter = tab"
              >
                {{ tab === 'all' ? '全部' : tab === 'added' ? '已添加' : '未添加' }}
                <span v-if="tab === 'all'" class="ml-1 opacity-60">{{ startMenuApps.length }}</span>
              </button>
            </div>
            <Input
              v-if="startMenuApps.length > 0"
              v-model="scanSearch"
              type="text"
              placeholder="搜索..."
              class="h-8 text-xs"
            />
          </div>

          <!-- List -->
          <div class="flex-1 overflow-y-auto px-5 pb-4">
            <div v-if="startMenuApps.length === 0 && !isScanning" class="py-10 text-center text-muted-foreground">
              <p class="text-sm">点击 "扫描" 检测已安装的应用</p>
            </div>

            <div v-else-if="filteredStartMenuApps.length === 0 && !isScanning" class="py-10 text-center text-muted-foreground">
              <p class="text-sm">没有匹配的结果</p>
            </div>

            <div v-else class="space-y-0.5">
              <div
                v-for="entry in filteredStartMenuApps"
                :key="entry.target"
                class="flex items-center gap-3 py-2 px-2 -mx-2 rounded-md transition-colors hover:bg-accent/50"
              >
                <div class="w-7 h-7 rounded-md overflow-hidden flex items-center justify-center shrink-0">
                  <img v-if="entry.icon" :src="entry.icon" :alt="entry.name" class="w-full h-full object-contain" />
                  <span v-else class="icon-[lucide--box] w-4 h-4 text-muted-foreground" />
                </div>
                <div class="flex-1 min-w-0">
                  <p class="text-xs truncate">{{ entry.name }}</p>
                  <p class="text-[10px] truncate font-mono text-muted-foreground">{{ entry.target }}</p>
                </div>

                <!-- Already added → trash -->
                <Button
                  v-if="existingPaths.has(entry.target.toLowerCase())"
                  variant="ghost"
                  size="icon-sm"
                  class="text-muted-foreground hover:text-destructive shrink-0"
                  @click="removeByPath(entry.target)"
                >
                  <span class="icon-[lucide--trash-2] w-3.5 h-3.5" />
                </Button>

                <!-- Not added → plus -->
                <Button
                  v-else
                  variant="outline"
                  size="icon-sm"
                  class="shrink-0"
                  :disabled="addingTargets.has(entry.target)"
                  @click="addFromStartMenu(entry)"
                >
                  <span v-if="!addingTargets.has(entry.target)" class="icon-[lucide--plus] w-3.5 h-3.5" />
                  <span v-else class="icon-[lucide--loader-2] w-3.5 h-3.5 animate-spin" />
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style>
.drag-handle:active { cursor: grabbing; }
.drag-ghost { opacity: 0.15; }
.drag-chosen { background: var(--accent) !important; }
.drag-active {
  opacity: 0.9;
  background: var(--card) !important;
  border: 1px solid var(--border) !important;
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.15);
}
/* Cropper background: checkerboard for transparency */
.cropper-container .vue-advanced-cropper__background {
  background-image: conic-gradient(#ccc 25%, #fff 25%, #fff 50%, #ccc 50%, #ccc 75%, #fff 75%);
  background-size: 16px 16px;
}
</style>
