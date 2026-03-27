import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import type { AppEntry } from '../types'

interface Settings {
  dark_mode: boolean
  show_names: boolean
  auto_start: boolean
  icon_size: number
  hover_scale: number
  shortcut: string
  grid_gap: number
  padding_top: number
  padding_horizontal: number
  icon_glow: number
}

export const useDockStore = defineStore('dock', () => {
  const apps = ref<AppEntry[]>([])
  const currentPage = ref(0)
  const isVisible = ref(false)
  const showNames = ref(false)
  const darkMode = ref(true)
  const iconSize = ref(88)
  const hoverScale = ref(1.1)
  const shortcut = ref('Ctrl+Alt+W')
  const gridGap = ref(64)
  const paddingTop = ref(92)
  const paddingHorizontal = ref(56)
  const iconGlow = ref(0)

  const windowWidth = ref(window.innerWidth || 1920)
  const windowHeight = ref(window.innerHeight || 1080)

  function updateWindowSize() {
    windowWidth.value = window.innerWidth
    windowHeight.value = window.innerHeight
  }

  const columns = computed(() => {
    const available = windowWidth.value - paddingHorizontal.value * 2
    const cell = iconSize.value + gridGap.value
    return Math.max(3, Math.min(7, Math.floor(available / cell)))
  })

  const rows = computed(() => {
    const available = windowHeight.value - paddingTop.value - 80
    const cell = iconSize.value + (showNames.value ? 30 : 12) + gridGap.value
    return Math.max(2, Math.min(8, Math.floor(available / cell)))
  })

  const itemsPerPage = computed(() => columns.value * rows.value)

  const totalPages = computed(() =>
    Math.max(1, Math.ceil(apps.value.length / itemsPerPage.value))
  )

  const currentPageApps = computed(() => {
    const start = currentPage.value * itemsPerPage.value
    return apps.value.slice(start, start + itemsPerPage.value)
  })

  async function loadSettings() {
    try {
      const s = await invoke<Settings>('get_settings')
      darkMode.value = s.dark_mode
      showNames.value = s.show_names
      iconSize.value = s.icon_size
      hoverScale.value = s.hover_scale
      shortcut.value = s.shortcut
      gridGap.value = s.grid_gap
      paddingTop.value = s.padding_top
      paddingHorizontal.value = s.padding_horizontal
      iconGlow.value = s.icon_glow ?? 0
    } catch (e) {
      console.error('Failed to load settings:', e)
    }
  }

  async function saveSettingsToFile() {
    try {
      await invoke('save_settings', {
        settings: {
          dark_mode: darkMode.value,
          show_names: showNames.value,
          auto_start: false,
          icon_size: iconSize.value,
          hover_scale: hoverScale.value,
          blur_amount: 30,
          backdrop_opacity: 0.65,
          shortcut: shortcut.value,
          grid_gap: gridGap.value,
          padding_top: paddingTop.value,
          padding_horizontal: paddingHorizontal.value,
          icon_glow: iconGlow.value,
        },
      })
    } catch (e) {
      console.error('Failed to save settings:', e)
    }
  }

  async function loadApps() {
    try {
      apps.value = await invoke<AppEntry[]>('get_apps')
    } catch (e) {
      console.error('Failed to load apps:', e)
    }
  }

  async function saveApps() {
    try {
      await invoke('save_apps', { apps: apps.value })
    } catch (e) {
      console.error('Failed to save apps:', e)
    }
  }

  async function addApp(entry: Omit<AppEntry, 'id' | 'sort_order'>) {
    const newApp: AppEntry = {
      ...entry,
      id: crypto.randomUUID(),
      sort_order: apps.value.length,
    }
    apps.value.push(newApp)
    await saveApps()
  }

  async function removeApp(id: string) {
    apps.value = apps.value.filter((a) => a.id !== id)
    await saveApps()
  }

  async function updateApp(id: string, updates: Partial<AppEntry>) {
    const idx = apps.value.findIndex((a) => a.id === id)
    if (idx !== -1) {
      apps.value[idx] = { ...apps.value[idx], ...updates }
      await saveApps()
    }
  }

  async function launchApp(path: string) {
    try {
      await invoke('launch_app', { path })
    } catch (e) {
      console.error('Failed to launch app:', e)
    }
  }

  function nextPage() {
    if (currentPage.value < totalPages.value - 1) {
      currentPage.value++
    }
  }

  function prevPage() {
    if (currentPage.value > 0) {
      currentPage.value--
    }
  }

  function setPage(page: number) {
    currentPage.value = Math.max(0, Math.min(page, totalPages.value - 1))
  }

  return {
    apps,
    currentPage,
    columns,
    rows,
    itemsPerPage,
    isVisible,
    showNames,
    darkMode,
    iconSize,
    hoverScale,
    shortcut,
    gridGap,
    paddingTop,
    paddingHorizontal,
    iconGlow,
    totalPages,
    currentPageApps,
    updateWindowSize,
    loadApps,
    loadSettings,
    saveSettingsToFile,
    saveApps,
    addApp,
    removeApp,
    updateApp,
    launchApp,
    nextPage,
    prevPage,
    setPage,
  }
})
