<script setup lang="ts">
/**
 * 键盘桌宠窗口（label: key_pet）：透明、置顶、不进任务栏。
 * 舞台本身在 stage.ts（纯 DOM），这里只管窗口的事：接全局按键、拖动、记位置、听设置页发来的配置。
 *
 * 全局按键是后端 rdev 一直在监听、广播给所有窗口的 input-event（按键显示也用它），这里直接接。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWindow, LogicalSize, LogicalPosition } from '@tauri-apps/api/window'
import { LazyStore } from '@tauri-apps/plugin-store'
import { createStage } from './stage'
import { STAGE_W, STAGE_H } from './dims'
import { PET_DEFAULTS, type PetConfig } from './petWindow'


const host = ref<HTMLElement | null>(null)
const win = getCurrentWindow()
const store = new LazyStore('pet.json')
let stage: ReturnType<typeof createStage> | null = null
const cfg = ref<PetConfig>({ ...PET_DEFAULTS })
const offs: UnlistenFn[] = []

async function apply(c: PetConfig) {
  cfg.value = c
  stage?.setSign(c.sign)
  stage?.setScale(c.scale)
  if (host.value) host.value.style.transform = `scale(${c.scale})`
  await win.setSize(new LogicalSize(Math.round(STAGE_W * c.scale), Math.round(STAGE_H * c.scale)))
  await win.setIgnoreCursorEvents(c.locked).catch(() => {})
}

// 没锁住的时候，按住哪里都能拖着走
function onDown(e: MouseEvent) {
  if (e.button === 0 && !cfg.value.locked) void win.startDragging()
}

let saveTimer = 0
onMounted(async () => {
  document.documentElement.style.background = 'transparent'
  document.body.style.background = 'transparent'
  stage = createStage(host.value!, { sign: true })
  await store.init()
  const saved = (await store.get<Partial<PetConfig>>('config')) ?? {}
  await apply({ ...PET_DEFAULTS, ...saved })
  const pos = await store.get<{ x: number; y: number }>('position')
  if (pos) await win.setPosition(new LogicalPosition(pos.x, pos.y))

  offs.push(await listen<{ event_type: string; key: string }>('input-event', (e) => {
    const { event_type, key } = e.payload
    if (event_type === 'KeyPress') stage?.press(key)
    else if (event_type === 'KeyRelease') stage?.release(key)
  }))
  offs.push(await listen<PetConfig>('pet-config', (e) => void apply(e.payload)))
  offs.push(await win.onMoved(async () => {
    window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(async () => {
      const p = await win.outerPosition()
      const f = await win.scaleFactor()
      await store.set('position', { x: Math.round(p.x / f), y: Math.round(p.y / f) })
      await store.save()
    }, 400)
  }))
  window.addEventListener('mousedown', onDown)
})

onBeforeUnmount(() => {
  offs.forEach((f) => f())
  window.removeEventListener('mousedown', onDown)
  stage?.destroy()
})
</script>

<template>
  <div class="fixed inset-0 overflow-hidden select-none">
    <div ref="host" class="origin-top-left" />
  </div>
</template>
