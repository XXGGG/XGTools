/**
 * 桌宠窗口的开关（设置页和启动时恢复共用）。开没开、大小这些存在 pet.json，不跟 settings.json 混。
 */
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { emit } from '@tauri-apps/api/event'
import { LazyStore } from '@tauri-apps/plugin-store'
import { STAGE_W, STAGE_H } from './stage'

export type PetConfig = { scale: number; sign: boolean; locked: boolean }
export const PET_DEFAULTS: PetConfig = { scale: 0.85, sign: true, locked: false }
export const PET_LABEL = 'key_pet'

const store = new LazyStore('pet.json')
let ready: Promise<void> | null = null
const init = () => (ready ??= store.init())

export async function loadPetConfig(): Promise<PetConfig> {
  await init()
  return { ...PET_DEFAULTS, ...((await store.get<Partial<PetConfig>>('config')) ?? {}) }
}

export async function savePetConfig(c: PetConfig) {
  await init()
  await store.set('config', c)
  await store.save()
  await emit('pet-config', c)
}

export async function isPetOpen() {
  return !!(await WebviewWindow.getByLabel(PET_LABEL))
}

export async function openPet() {
  if (await isPetOpen()) return
  const c = await loadPetConfig()
  new WebviewWindow(PET_LABEL, {
    url: 'index.html',
    title: 'XGTools Pet',
    width: Math.round(STAGE_W * c.scale),
    height: Math.round(STAGE_H * c.scale),
    decorations: false,
    shadow: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focus: false,
  })
  await init()
  await store.set('enabled', true)
  await store.save()
}

export async function closePet() {
  const w = await WebviewWindow.getByLabel(PET_LABEL)
  await w?.destroy().catch(() => {})
  await init()
  await store.set('enabled', false)
  await store.save()
}

/** 启动时：上次开着就再开 */
export async function restorePet() {
  await init()
  if (await store.get<boolean>('enabled')) await openPet()
}

/** 回到屏幕右下角（拖丢了的时候用） */
export async function resetPetPosition() {
  await init()
  await store.delete('position')
  await store.save()
  const w = await WebviewWindow.getByLabel(PET_LABEL)
  if (!w) return
  const { currentMonitor, LogicalPosition } = await import('@tauri-apps/api/window')
  const m = await currentMonitor()
  const c = await loadPetConfig()
  if (!m) return
  const sf = m.scaleFactor
  const x = m.position.x / sf + m.size.width / sf - STAGE_W * c.scale - 40
  const y = m.position.y / sf + m.size.height / sf - STAGE_H * c.scale - 80
  await w.setPosition(new LogicalPosition(Math.round(x), Math.round(y)))
}
