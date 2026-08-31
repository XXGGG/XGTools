/*
  全局快捷键的单一入口。

  五个快捷键散在两处存:启动台的键在 Rust 那份 settings(get_settings / save_settings),
  其余四个在 plugin-store 的 settings.json。启动台页和截图页各自攒过一份
  「读全部 → update_all_shortcuts」,加一个键要改两处;设置页的快捷键总览从这里走。
*/
import { invoke } from '@tauri-apps/api/core'
import { LazyStore } from '@tauri-apps/plugin-store'

export type ShortcutKey = 'dock' | 'screenshot' | 'screenshot_translate' | 'palette' | 'palette_translate'

/** 设置页里的展示顺序:最常按的在上面 */
export const SHORTCUT_KEYS: ShortcutKey[] = ['palette', 'palette_translate', 'screenshot', 'screenshot_translate', 'dock']

export type ShortcutState = {
  key: ShortcutKey
  /** 空串 = 没设 */
  shortcut: string
  /** 所属功能开着没。关着就不注册,也不算「被占用」 */
  enabled: boolean
  /** 允许留空不注册(清掉就是明确不要,不会再回到默认) */
  optional: boolean
  /** 有自己的启用开关。翻译面板没有,跟着命令面板一起开关 */
  ownSwitch: boolean
}

export type ShortcutLive = { key: ShortcutKey; wanted: boolean; registered: boolean }

export const SHORTCUT_DEFAULTS: Record<ShortcutKey, string> = {
  dock: 'Ctrl+Alt+W',
  screenshot: 'Ctrl+Alt+A',
  screenshot_translate: 'Ctrl+Alt+D',
  palette: 'Ctrl+Alt+Space',
  palette_translate: 'Ctrl+Alt+E',
}

type DockSettings = { shortcut: string; auto_start: boolean; [k: string]: unknown }

const store = new LazyStore('settings.json')

export async function readAllShortcuts(): Promise<ShortcutState[]> {
  await store.init()
  const dock = await invoke<DockSettings>('get_settings').catch(() => null)
  const get = async <T>(k: string, d: T): Promise<T> => (await store.get<T>(k)) ?? d
  const paletteEnabled = await get('palette_enabled', true)
  const all: Record<ShortcutKey, ShortcutState> = {
    dock: {
      key: 'dock', optional: false, ownSwitch: true,
      shortcut: dock?.shortcut ?? SHORTCUT_DEFAULTS.dock,
      enabled: dock?.auto_start ?? false,          // 启动台页那个「启用」开关存的就是 auto_start
    },
    screenshot: {
      key: 'screenshot', optional: false, ownSwitch: true,
      shortcut: await get('screenshot_shortcut', SHORTCUT_DEFAULTS.screenshot),
      enabled: await get('screenshot_enabled', true),
    },
    screenshot_translate: {
      key: 'screenshot_translate', optional: false, ownSwitch: true,
      shortcut: await get('screenshot_translate_shortcut', SHORTCUT_DEFAULTS.screenshot_translate),
      enabled: await get('screenshot_translate_enabled', false),
    },
    palette: {
      key: 'palette', optional: false, ownSwitch: true,
      shortcut: await get('palette_shortcut', SHORTCUT_DEFAULTS.palette),
      enabled: paletteEnabled,
    },
    palette_translate: {
      // 和别的键一样有自己的开关(不用「清除」来表达「不要它」)。
      // 但它和命令面板是同一个窗口,面板整个关掉时它也无从唤起 —— 所以两个都开着才算开。
      key: 'palette_translate', optional: false, ownSwitch: true,
      shortcut: await get('palette_translate_shortcut', SHORTCUT_DEFAULTS.palette_translate),
      enabled: paletteEnabled && (await get('palette_translate_enabled', true)),
    },
  }
  return SHORTCUT_KEYS.map((k) => all[k])
}

export async function writeShortcut(key: ShortcutKey, value: string): Promise<void> {
  if (key === 'dock') {
    const s = await invoke<DockSettings>('get_settings')
    await invoke('save_settings', { settings: { ...s, shortcut: value } })
    return
  }
  await store.init()
  await store.set(`${key}_shortcut`, value)
  await store.save()
}

/** 功能的启用开关。关掉的功能不注册键,也不算「被占用」 */
export async function writeEnabled(key: ShortcutKey, on: boolean): Promise<void> {
  if (key === 'dock') {
    const s = await invoke<DockSettings>('get_settings')
    await invoke('save_settings', { settings: { ...s, auto_start: on } })
    return
  }
  await store.init()
  // 命令面板那一项存在 palette_enabled 里(启动台页那个开关也读它);其余各存各的
  const flag = key === 'palette' ? 'palette_enabled' : `${key}_enabled`
  await store.set(flag, on)
  await store.save()
}

/** 五个键全改回出厂值。只动键,不动功能开关 */
export async function resetAllShortcuts(): Promise<void> {
  for (const k of SHORTCUT_KEYS) await writeShortcut(k, SHORTCUT_DEFAULTS[k])
}

/** 按当前配置把全部快捷键重新装一遍。返回没装上的(被别的程序占着的)键 */
export async function syncAllShortcuts(): Promise<ShortcutKey[]> {
  const all = await readAllShortcuts()
  const pick = (k: ShortcutKey): string | null => {
    const s = all.find((x) => x.key === k)
    return s && s.enabled && s.shortcut ? s.shortcut : null
  }
  const failed = await invoke<string[]>('update_all_shortcuts', {
    shortcuts: {
      dock_shortcut: pick('dock'),
      screenshot_shortcut: pick('screenshot'),
      screenshot_translate_shortcut: pick('screenshot_translate'),
      palette_shortcut: pick('palette'),
      palette_translate_shortcut: pick('palette_translate'),
    },
  })
  return (failed ?? []) as ShortcutKey[]
}

export const shortcutStatus = (): Promise<ShortcutLive[]> => invoke<ShortcutLive[]>('shortcut_status')

/** 录制期间把我们自己的全局键全摘掉,否则想录 Ctrl+Space 这种正被自己占着的键,网页收不到 keydown */
export const pauseShortcuts = (): Promise<void> => invoke('pause_shortcuts')

/** 把录制时的 keydown 变成 "Ctrl+Alt+P" 这种串。只按了修饰键 / 没带修饰键 → null */
export function shortcutFromKeydown(e: KeyboardEvent): string | null {
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return null
  const parts: string[] = []
  if (e.ctrlKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  if (e.metaKey) parts.push('Super')
  if (parts.length === 0) return null

  let key = e.key.toUpperCase()
  if (e.code.startsWith('Key')) key = e.code.slice(3)
  else if (e.code.startsWith('Digit')) key = e.code.slice(5)
  else if (/^F\d+$/.test(e.code)) key = e.code
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
  return parts.join('+')
}
