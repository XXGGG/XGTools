<script setup lang="ts">
/**
 * 长截图进行中的那条小控制条。
 *
 * 和录屏那条一样：抓完不关掉，**原地变成结果条**（已保存 · 打开文件夹）。
 * 抓长图的时候人正盯着别的软件，主窗口跳出来就把画面糊住了，
 * 而且抓完最想干的事就在这儿。
 *
 * # 为什么要有「自己滚」这个按钮
 *
 * 自动滚是给目标窗口发滚轮事件，不是所有窗口都吃这一套（见 long_shot.rs）。
 * 后端发现滚不动会自动转手动，但也有「滚得动、可是滚得不对」的情况 ——
 * 比如一次滚太多、或者滚的是页面里另一个容器。那种时候后端看不出问题，
 * 得留一个人工出口。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { getCurrentWindow, PhysicalPosition, PhysicalSize } from '@tauri-apps/api/window'
import { emit as tauriEmit, listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { useI18n, applySavedLocale } from '@/i18n'

const { t } = useI18n()
const win = getCurrentWindow()

type Phase = 'running' | 'saving' | 'done' | 'error'
const phase = ref<Phase>('running')
const mode = ref<'auto' | 'manual'>('auto')
const height = ref(0)
const width = ref(0)
const outPath = ref('')
const errMsg = ref('')
const ready = ref(false)
/** 后端说滚到底了（不是人点的完成）。结果条上要说一声 */
const reachedEnd = ref(false)

let unlisten: (() => void)[] = []

const fileName = computed(() => outPath.value.split(/[\\/]/).pop() ?? '')
/** 已经接了多少屏。比"多少像素"直观 */
const screens = computed(() => (width.value ? (height.value / Math.max(1, frameH.value)).toFixed(1) : '0'))
const frameH = ref(1)

onMounted(async () => {
  applySavedLocale()
  document.body.classList.add('recorder-bar-window')

  unlisten.push(
    await listen<{ x: number; y: number; w: number; h: number }>('ls-bar-init', async (e) => {
      await invoke('disable_window_transitions').catch(() => {})
      // 不抢焦点，否则第一下点击只用来激活窗口，点完成得点两次
      await invoke('set_window_no_activate').catch(() => {})
      frameH.value = e.payload.h
      await place(e.payload)
      ready.value = true
      await win.show()
      await tauriEmit('ls-bar-shown', {})
    }),
  )

  unlisten.push(
    await listen<{ height: number; width: number; mode: 'auto' | 'manual'; done: boolean }>(
      'long-shot-progress',
      (e) => {
        height.value = e.payload.height
        width.value = e.payload.width
        mode.value = e.payload.mode
      },
    ),
  )

  /*
    后端自己收尾了（滚到底 / 到了内存上限 / 出错）。
    这边接着去取图 —— 不接的话屏幕上会留一条永远在"抓取中"的条子。
  */
  unlisten.push(
    await listen<boolean>('long-shot-ended', async (e) => {
      if (phase.value !== 'running') return
      reachedEnd.value = e.payload
      await save()
    }),
  )

  await tauriEmit('ls-bar-ready', {})
})

onUnmounted(() => unlisten.forEach((f) => f()))

/** 摆在选区正下方居中；下面放不下就翻到上方；再放不下就贴屏幕底 */
async function place(r: { x: number; y: number; w: number; h: number }) {
  const bw = 340
  const bh = 44
  const gap = 10
  const sw = window.screen.width * window.devicePixelRatio
  const sh = window.screen.height * window.devicePixelRatio

  let x = Math.round(r.x + r.w / 2 - bw / 2)
  let y = r.y + r.h + gap
  if (y + bh > sh) y = r.y - bh - gap
  /*
    上下都塞不下就贴屏幕最下面。**绝不能压回选区里** ——
    压进去它自己就被抓进长图了。
  */
  if (y < 0) y = Math.max(0, sh - bh - gap)
  x = Math.max(0, Math.min(x, sw - bw))

  await win.setSize(new PhysicalSize(bw, bh))
  await win.setPosition(new PhysicalPosition(x, y))
  await win.setAlwaysOnTop(true)
}

/** 人点了完成：让后端停下来，`long-shot-ended` 回来时再去取图 */
async function finish() {
  if (phase.value !== 'running') return
  await invoke('stop_long_shot').catch(() => {})
}

async function save() {
  phase.value = 'saving'
  try {
    outPath.value = await invoke<string>('take_long_shot', { dir: null })
    phase.value = 'done'
    await growForResult()
  } catch (e) {
    errMsg.value = String(e)
    phase.value = 'error'
    await growForResult()
  }
}

/** 结果条比进行条要宽一点：多了文件名和「打开文件夹」 */
async function growForResult() {
  const p = await win.outerPosition()
  await win.setSize(new PhysicalSize(400, 44))
  await win.setPosition(new PhysicalPosition(Math.max(0, p.x - 30), p.y))
}

async function toManual() {
  mode.value = 'manual'
  await invoke('long_shot_manual').catch(() => {})
}

async function discard() {
  await invoke('cancel_long_shot').catch(() => {})
  await tauriEmit('long-shot-cancelled', {})
  await win.destroy().catch(() => {})
}

async function reveal() {
  if (outPath.value) await invoke('reveal_in_explorer', { path: outPath.value }).catch(() => {})
}

async function close() {
  await tauriEmit('long-shot-cancelled', {})
  await win.destroy().catch(() => {})
}
</script>

<template>
  <div v-show="ready" class="rec-bar">
    <template v-if="phase === 'running'">
      <span class="dot" :class="{ still: mode === 'manual' }" />
      <span class="clock">{{ screens }} {{ t('ls.screens') }}</span>
      <span class="size">{{ height }}px</span>
      <span class="spacer" />
      <span v-if="mode === 'manual'" class="hint">{{ t('ls.scrollYourself') }}</span>
      <button v-else class="btn ghost" :title="t('ls.manualTip')" @click="toManual">
        {{ t('ls.manual') }}
      </button>
      <button class="btn primary" @click="finish">{{ t('ls.finish') }}</button>
      <button class="btn ghost" :title="t('ls.discard')" @click="discard">
        <span class="icon-[lucide--x] ic" />
      </button>
    </template>

    <template v-else-if="phase === 'saving'">
      <span class="icon-[lucide--loader-2] ic spin" />
      <span>{{ t('ls.saving') }}</span>
    </template>

    <template v-else-if="phase === 'done'">
      <span class="icon-[lucide--check] ic ok" />
      <span class="name" :title="outPath">{{ fileName }}</span>
      <span class="size">{{ height }}px</span>
      <span v-if="!reachedEnd" class="size">· {{ t('ls.stoppedByYou') }}</span>
      <span class="spacer" />
      <button class="btn" @click="reveal">{{ t('ls.openFolder') }}</button>
      <button class="btn ghost" @click="close"><span class="icon-[lucide--x] ic" /></button>
    </template>

    <template v-else>
      <span class="icon-[lucide--triangle-alert] ic warn" />
      <span class="name" :title="errMsg">{{ errMsg }}</span>
      <span class="spacer" />
      <button class="btn ghost" @click="close"><span class="icon-[lucide--x] ic" /></button>
    </template>
  </div>
</template>

<style>
body.recorder-bar-window { margin: 0; background: transparent !important; overflow: hidden; }

.rec-bar {
  display: flex; align-items: center; gap: 8px;
  width: 100vw; height: 100vh; box-sizing: border-box;
  padding: 0 8px 0 12px;
  border-radius: 10px;
  background: rgba(28, 28, 30, 0.94);
  border: 1px solid rgba(255, 255, 255, 0.12);
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.45);
  color: #f2f2f4;
  font-size: 13px;
  /* 系统字体栈:这个窗口不加载应用的字体资源 */
  font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  user-select: none;
}

/* 长截图是青色,和录屏的琥珀色分开 */
.dot {
  width: 9px; height: 9px; border-radius: 50%;
  background: #2ec4b6; flex: none;
  animation: ls-blink 1.2s ease-in-out infinite;
}
.dot.still { animation: none; opacity: 0.5; }
@keyframes ls-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }

.clock { font-variant-numeric: tabular-nums; font-size: 14px; letter-spacing: 0.02em; }
.size { color: rgba(255, 255, 255, 0.45); font-variant-numeric: tabular-nums; }
.hint { color: #2ec4b6; }
.name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 190px; }
.spacer { flex: 1 1 auto; }

.btn {
  display: inline-flex; align-items: center; gap: 5px;
  height: 28px; padding: 0 10px;
  border: none; border-radius: 7px;
  background: rgba(255, 255, 255, 0.08);
  color: inherit; font-size: 12.5px; cursor: pointer;
  transition: background 0.12s;
}
.btn:hover { background: rgba(255, 255, 255, 0.16); }
.btn:disabled { opacity: 0.5; cursor: default; }
.btn.primary { background: #2ec4b6; color: #06302c; }
.btn.primary:hover { background: #45d8ca; }
.btn.ghost { padding: 0 8px; }

.ic { width: 15px; height: 15px; flex: none; }
.ic.ok { color: #46b56a; }
.ic.warn { color: #e5a23c; }
.spin { animation: ls-spin 0.9s linear infinite; }
@keyframes ls-spin { to { transform: rotate(360deg); } }
</style>
