/**
 * 桌面格子：桌面上的半透明小框，把文件、文件夹、快捷方式拖进去归类放好（像 Fences 那样）。
 *
 * 每个格子是一个贴在桌面层的窗口（label: fence_<id>，永远在其他窗口下面），
 * 格子里只记文件路径，文件本身不挪地方。配合「隐藏桌面图标」用，桌面就只剩这些格子。
 * 名字可以不填（无名格子就不显示标题，只剩一条拖动用的细边）。
 */
import { emit } from '@tauri-apps/api/event'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { LazyStore } from '@tauri-apps/plugin-store'

export type Fence = { id: string; name: string; x: number; y: number; w: number; h: number; items: string[] }

const store = new LazyStore('fences.json')
let ready: Promise<void> | null = null
const init = () => (ready ??= store.init())

export async function loadFences(): Promise<Fence[]> {
  await init()
  await store.reload().catch(() => {})
  return (await store.get<Fence[]>('fences')) ?? []
}

export async function saveFences(list: Fence[]) {
  await init()
  await store.set('fences', list)
  await store.save()
  await emit('fences-changed')
}

export async function updateFence(id: string, patch: Partial<Fence>) {
  const list = await loadFences()
  await saveFences(list.map(f => (f.id === id ? { ...f, ...patch } : f)))
}

export const fenceLabel = (id: string) => `fence_${id}`

export async function openFence(f: Fence) {
  if (await WebviewWindow.getByLabel(fenceLabel(f.id))) return
  new WebviewWindow(fenceLabel(f.id), {
    url: 'index.html',
    title: f.name || '格子',
    x: f.x,
    y: f.y,
    width: f.w,
    height: f.h,
    minWidth: 140,
    minHeight: 90,
    decorations: false,
    transparent: true,
    shadow: false,
    skipTaskbar: true,
    alwaysOnBottom: true,
    resizable: true,
    maximizable: false,
    minimizable: false,
    focus: false,
  })
}

export async function closeFence(id: string) {
  await (await WebviewWindow.getByLabel(fenceLabel(id)))?.destroy()
}

export async function addFence(name = '') {
  const list = await loadFences()
  const n = list.length
  const f: Fence = { id: `${Date.now().toString(36)}`, name, x: 80 + n * 40, y: 120 + n * 40, w: 320, h: 220, items: [] }
  await saveFences([...list, f])
  await openFence(f)
  return f
}

export async function removeFence(id: string) {
  await closeFence(id)
  await saveFences((await loadFences()).filter(f => f.id !== id))
}

/** 启动时：开着「显示格子」就把所有格子摆出来 */
export async function restoreFences() {
  await init()
  if ((await store.get<boolean>('shown')) === false) return
  for (const f of await loadFences()) await openFence(f)
}

export async function setFencesShown(on: boolean) {
  await init()
  await store.set('shown', on)
  await store.save()
  for (const f of await loadFences()) {
    if (on) await openFence(f)
    else await closeFence(f.id)
  }
}

export async function fencesShown() {
  await init()
  return (await store.get<boolean>('shown')) !== false
}
