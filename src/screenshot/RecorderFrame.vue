<script setup lang="ts">
/**
 * 录制时套在选区外面的那圈框。
 *
 * # 为什么要单独一个窗口
 *
 * 录屏用的是 ffmpeg 的 gdigrab —— 它抓的是**桌面真实画面**。截图那个遮罩上盖着的是
 * 一张冻住的截图，要是留着不动，录下来的就是那张静止图。所以一开始录，
 * 遮罩必须整个让开。
 *
 * 让开之后屏幕上就什么标记都没有了，人根本不知道自己现在在录哪一块。
 * 所以补一个只画一圈边的小窗口。
 *
 * # 这圈边为什么不会被录进去
 *
 * 窗口比选区大一圈（每边 `BORDER` 像素），**边画在选区外面**，中间那块是全透明的。
 * gdigrab 只抓选区那个矩形，边正好在框外，录不进去。
 *
 * 再加上鼠标穿透（`setIgnoreCursorEvents`）—— 不然这圈边会挡住底下的软件，
 * 录一个「点按钮」的演示，按钮反而点不着。
 */
import { onMounted, onUnmounted, ref } from 'vue'
import { getCurrentWindow, PhysicalPosition, PhysicalSize } from '@tauri-apps/api/window'
import { emit as tauriEmit, listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'

/** 边宽（物理像素）。太细看不见，太粗遮住旁边的东西 */
const BORDER = 3
/**
 * 边和选区之间再留一像素透明。
 *
 * 窗口的位置尺寸是**物理像素**，而 CSS 的 border-width 是**CSS 像素** ——
 * 屏幕缩放不是 100% 时（125% 很常见）两者对不齐，边会往里渗进去半个到一个像素，
 * 那半个像素就会被 gdigrab 录进画面里。留一格空的，怎么取整都碰不到。
 */
const PAD = 1

const win = getCurrentWindow()
const ready = ref(false)
let unlisten: (() => void)[] = []

onMounted(async () => {
  document.body.classList.add('recorder-frame-window')

  unlisten.push(
    await listen<{ x: number; y: number; w: number; h: number }>('rec-frame-init', async (e) => {
      const { x, y, w, h } = e.payload
      // 先关掉开窗动画：默认那个「从中心放大」会把框的头几帧画进选区里面，
      // 而那正是 gdigrab 抓的地方 —— 成品视频开头就多一圈往外扩的边
      await invoke('disable_window_transitions').catch(() => {})
      const out = BORDER + PAD
      await win.setPosition(new PhysicalPosition(x - out, y - out))
      await win.setSize(new PhysicalSize(w + out * 2, h + out * 2))
      await win.setIgnoreCursorEvents(true)
      await win.setAlwaysOnTop(true)
      ready.value = true
      await win.show()
      // 告诉开录的那一方「我已经贴到位了」，它才会去起 ffmpeg
      await tauriEmit('rec-frame-shown', {})
    }),
  )
  // 录制结束 / 取消，自己收摊
  for (const ev of ['record-stopped', 'record-cancelled']) {
    unlisten.push(await listen(ev, () => win.destroy().catch(() => {})))
  }

  // 告诉开录的那一方「我已经挂上监听了，可以发数据了」
  await tauriEmit('rec-frame-ready', {})
})

onUnmounted(() => unlisten.forEach((f) => f()))
</script>

<template>
  <!--
    整窗透明，只有 border 是实的。box-sizing 用 border-box：
    窗口尺寸已经算进了两条边，内容区剩下的正好是选区那么大。
  -->
  <div v-show="ready" class="rec-frame" />
</template>

<style>
body.recorder-frame-window {
  margin: 0;
  background: transparent !important;
  overflow: hidden;
}
.rec-frame {
  width: 100vw;
  height: 100vh;
  box-sizing: border-box;
  /* 外面 1px 透明的空档,边只画在里面那一圈 —— 见上面 PAD 的注释 */
  border: 1px solid transparent;
  outline: 3px solid #e8952f;
  outline-offset: -4px;
  /* 录制中呼吸一下,一眼能看出"正在录"而不是"框在那儿" */
  animation: rec-breathe 1.6s ease-in-out infinite;
  pointer-events: none;
}
@keyframes rec-breathe {
  0%, 100% { outline-color: #e8952f; }
  50% { outline-color: #ffbe6b; }
}
</style>
