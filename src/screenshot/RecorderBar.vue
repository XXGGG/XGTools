<script setup lang="ts">
/**
 * 录制中的那条小控制条：红点 + 计时 + 停止 / 丢弃。
 *
 * 停止之后它不关掉，而是**原地变成结果条**（已保存 · 打开文件夹 · 转 GIF）。
 * 换成弹主窗口的话，人正在录别的软件，主窗口一跳出来就把画面糊住了；
 * 而且录完最想干的两件事就在这儿，不用再去别处找。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { getCurrentWindow, PhysicalPosition, PhysicalSize } from '@tauri-apps/api/window'
import { emit as tauriEmit, listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { useI18n, applySavedLocale } from '@/i18n'

const { t } = useI18n()
const win = getCurrentWindow()

type Phase = 'recording' | 'stopping' | 'done' | 'error'
const phase = ref<Phase>('recording')
const elapsed = ref(0)
const sizeBytes = ref(0)
const outPath = ref('')
const errMsg = ref('')
const gifBusy = ref(false)
const gifDone = ref(false)
const ready = ref(false)

let timer: number | null = null
let unlisten: (() => void)[] = []

/** mm:ss，超过一小时才显示小时 */
const clock = computed(() => {
  const s = Math.floor(elapsed.value / 1000)
  const hh = Math.floor(s / 3600)
  const mm = Math.floor((s % 3600) / 60)
  const ss = s % 60
  const p = (n: number) => String(n).padStart(2, '0')
  return hh > 0 ? `${hh}:${p(mm)}:${p(ss)}` : `${p(mm)}:${p(ss)}`
})

/*
  文件大小。小于 64 KB 就不显示 —— mp4 是攒够一批才落盘的，
  开头十几秒都停在几十字节上，显示成「0 KB」反而像是没在录。
*/
const sizeText = computed(() => {
  const b = sizeBytes.value
  if (b < 64 * 1024) return ''
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`
  return `${(b / 1024 / 1024).toFixed(1)} MB`
})

const fileName = computed(() => outPath.value.split(/[\\/]/).pop() ?? '')

onMounted(async () => {
  applySavedLocale()
  document.body.classList.add('recorder-bar-window')

  unlisten.push(
    await listen<{ x: number; y: number; w: number; h: number }>('rec-bar-init', async (e) => {
      await place(e.payload)
      ready.value = true
      await win.show()
      startTicking()
    }),
  )
  await tauriEmit('rec-bar-ready', {})
})

onUnmounted(() => {
  if (timer) clearInterval(timer)
  unlisten.forEach((f) => f())
})

/**
 * 条子摆在选区正下方居中；下面放不下就翻到上方；再放不下就压在选区里面贴底。
 * 左右超出屏幕就往回收 —— 控制条跑到屏幕外面就没法点停止了。
 */
async function place(r: { x: number; y: number; w: number; h: number }) {
  const bw = 320
  const bh = 44
  const gap = 10
  const sw = window.screen.width * window.devicePixelRatio
  const sh = window.screen.height * window.devicePixelRatio

  let x = Math.round(r.x + r.w / 2 - bw / 2)
  let y = r.y + r.h + gap
  if (y + bh > sh) y = r.y - bh - gap
  if (y < 0) y = Math.max(0, r.y + r.h - bh - gap)
  x = Math.max(0, Math.min(x, sw - bw))

  await win.setSize(new PhysicalSize(bw, bh))
  await win.setPosition(new PhysicalPosition(x, y))
  await win.setAlwaysOnTop(true)
}

function startTicking() {
  timer = window.setInterval(async () => {
    if (phase.value !== 'recording') return
    try {
      const s = await invoke<{ recording: boolean; elapsed_ms: number; size_bytes: number }>(
        'recording_status',
      )
      if (!s.recording) return
      elapsed.value = s.elapsed_ms
      sizeBytes.value = s.size_bytes
    } catch { /* 后端还没起来,下一拍再说 */ }
  }, 500)
}

async function stop() {
  if (phase.value !== 'recording') return
  phase.value = 'stopping'
  try {
    outPath.value = await invoke<string>('stop_recording')
    phase.value = 'done'
    // 红框那个窗口靠这个事件自己收摊
    await tauriEmit('record-stopped', outPath.value)
    await growForResult()
  } catch (e) {
    errMsg.value = String(e)
    phase.value = 'error'
    await tauriEmit('record-cancelled', {})
  }
}

async function discard() {
  try { await invoke('cancel_recording') } catch { /* 已经停了就算了 */ }
  await tauriEmit('record-cancelled', {})
  await win.destroy()
}

/** 结果态要放三个按钮和文件名，比录制时宽 */
async function growForResult() {
  const cur = await win.outerPosition()
  const bw = 420
  const sw = window.screen.width * window.devicePixelRatio
  await win.setSize(new PhysicalSize(bw, 52))
  await win.setPosition(new PhysicalPosition(Math.max(0, Math.min(cur.x, sw - bw)), cur.y))
}

async function toGif() {
  if (gifBusy.value || !outPath.value) return
  gifBusy.value = true
  try {
    await invoke<string>('recording_to_gif', { input: outPath.value, fps: 15, width: 0 })
    gifDone.value = true
  } catch (e) {
    errMsg.value = String(e)
    phase.value = 'error'
  } finally {
    gifBusy.value = false
  }
}

async function reveal() {
  if (!outPath.value) return
  try { await invoke('reveal_in_explorer', { path: outPath.value }) } catch { /* 打不开就算了 */ }
}

function close() { win.destroy().catch(() => {}) }
</script>

<template>
  <div v-show="ready" class="rec-bar" data-tauri-drag-region>
    <!-- ── 录制中 ── -->
    <template v-if="phase === 'recording' || phase === 'stopping'">
      <span class="dot" :class="{ still: phase === 'stopping' }" />
      <span class="clock">{{ clock }}</span>
      <span v-if="sizeText" class="size">{{ sizeText }}</span>
      <div class="spacer" />
      <button class="btn primary" :disabled="phase === 'stopping'" @click="stop">
        <span class="icon-[lucide--square] ic" />
        {{ phase === 'stopping' ? t('rec.saving') : t('rec.stop') }}
      </button>
      <button class="btn ghost" :title="t('rec.discard')" @click="discard">
        <span class="icon-[lucide--trash-2] ic" />
      </button>
    </template>

    <!-- ── 录完了 ── -->
    <template v-else-if="phase === 'done'">
      <span class="icon-[lucide--check] ic ok" />
      <span class="name" :title="outPath">{{ fileName }}</span>
      <div class="spacer" />
      <button class="btn ghost" :title="t('rec.openFolder')" @click="reveal">
        <span class="icon-[lucide--folder-open] ic" />
      </button>
      <button class="btn ghost" :disabled="gifBusy" @click="toGif">
        <span v-if="gifBusy" class="icon-[lucide--loader-2] ic spin" />
        <span v-else-if="gifDone" class="icon-[lucide--check] ic ok" />
        <span v-else class="icon-[lucide--file-image] ic" />
        GIF
      </button>
      <button class="btn ghost" :title="t('rec.close')" @click="close">
        <span class="icon-[lucide--x] ic" />
      </button>
    </template>

    <!-- ── 出错 ── -->
    <template v-else>
      <span class="icon-[lucide--triangle-alert] ic warn" />
      <span class="name" :title="errMsg">{{ errMsg }}</span>
      <div class="spacer" />
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

.dot {
  width: 9px; height: 9px; border-radius: 50%;
  background: #e5484d; flex: none;
  animation: rec-blink 1.2s ease-in-out infinite;
}
.dot.still { animation: none; opacity: 0.5; }
@keyframes rec-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }

.clock { font-variant-numeric: tabular-nums; font-size: 14px; letter-spacing: 0.02em; }
.size { color: rgba(255, 255, 255, 0.45); font-variant-numeric: tabular-nums; }
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
.btn.primary { background: #e5484d; }
.btn.primary:hover { background: #f2585d; }
.btn.ghost { padding: 0 8px; }

.ic { width: 15px; height: 15px; flex: none; }
.ic.ok { color: #46b56a; }
.ic.warn { color: #e5a23c; }
.spin { animation: rec-spin 0.9s linear infinite; }
@keyframes rec-spin { to { transform: rotate(360deg); } }
</style>
