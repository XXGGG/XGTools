<script setup lang="ts">
/**
 * 桌宠窗口（label: key_pet）：透明、置顶、不进任务栏。
 * 舞台有两款：键盘款（keyboardPet.ts，默认）和小动物款（stage.ts，带 three.js，用到才加载）。
 * 这里只管窗口的事：接全局按键、拖动、记位置、听设置页发来的配置，款式变了就换一个舞台。
 *
 * 全局按键是后端 rdev 一直在监听、广播给所有窗口的 input-event（按键显示也用它），这里直接接。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWindow, LogicalSize, LogicalPosition } from '@tauri-apps/api/window'
import { LazyStore } from '@tauri-apps/plugin-store'
import { stageSize, type PetKind } from './dims'
import { PET_DEFAULTS, type PetConfig } from './petWindow'
import type { Ink } from './keyboardPet'

type Stage = {
  press(key: string): void
  release(key: string): void
  setSign(on: boolean): void
  setScale(s: number): void
  setInk?(ink: Ink): void
  destroy(): void
}

const host = ref<HTMLElement | null>(null)
const win = getCurrentWindow()
const store = new LazyStore('pet.json')
let stage: Stage | null = null
let stageKind: PetKind | null = null
const cfg = ref<PetConfig>({ ...PET_DEFAULTS })
const offs: UnlistenFn[] = []

async function mountStage(c: PetConfig) {
  if (stage && stageKind === c.kind) return
  stage?.destroy()
  stage = null
  stageKind = c.kind
  if (c.kind === 'keyboard') {
    const { createKeyboardPet } = await import('./keyboardPet')
    stage = createKeyboardPet(host.value!, { ink: c.ink })
  } else {
    const { createStage } = await import('./stage')
    stage = createStage(host.value!, { sign: c.sign })
  }
}

async function apply(c: PetConfig) {
  cfg.value = c
  await mountStage(c)
  stage?.setSign(c.sign)
  stage?.setScale(c.scale)
  stage?.setInk?.(c.ink)
  if (host.value) host.value.style.transform = `scale(${c.scale})`
  const { w, h } = stageSize(c.kind)
  await win.setSize(new LogicalSize(Math.round(w * c.scale), Math.round(h * c.scale)))
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
