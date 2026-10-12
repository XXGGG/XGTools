<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, toRaw } from 'vue'
import { watchDebounced } from '@vueuse/core'
import { LazyStore } from '@tauri-apps/plugin-store'
import { Button } from '@/components/ui/button'
import { Tabs, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import TitleBarTabs from '@/components/TitleBarTabs.vue'
import { useI18n } from '@/i18n'
import { usePomodoroTimer } from '@/composables/usePomodoroTimer'

// ── Types ──

interface CubeRecord {
  id: string
  time: number // ms
  createdAt: string
}

type CubeTimerState = 'idle' | 'holding' | 'running' | 'stopped'
type TimerTab = 'cube' | 'pomodoro'

// ── Tab ──

const { t } = useI18n()
const activeTab = ref<TimerTab>('cube')

// ── Cube Timer ──

const cubeState = ref<CubeTimerState>('idle')
const startTime = ref(0)
const elapsedMs = ref(0)
const holdStartTime = ref(0)
const cubeRecords = ref<CubeRecord[]>([])
let rafId = 0

const MAX_MS = 24 * 60 * 60 * 1000 // 24h

function updateDisplay() {
  elapsedMs.value = performance.now() - startTime.value
  if (elapsedMs.value >= MAX_MS) {
    elapsedMs.value = MAX_MS
    cubeState.value = 'stopped'
    cancelAnimationFrame(rafId)
    return
  }
  rafId = requestAnimationFrame(updateDisplay)
}

function formatCubeTime(ms: number): string {
  const total = Math.floor(ms / 10)
  const min = Math.floor(total / 6000)
  const sec = Math.floor((total % 6000) / 100)
  const cs = total % 100
  return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

function onKeyDown(e: KeyboardEvent) {
  if (e.code !== 'Space' || e.repeat) return
  if (activeTab.value !== 'cube') return
  // 不要在 input/button 上触发
  const tag = (e.target as HTMLElement)?.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA') return
  e.preventDefault()

  if (cubeState.value === 'idle') {
    cubeState.value = 'holding'
    holdStartTime.value = performance.now()
  } else if (cubeState.value === 'running') {
    cubeState.value = 'stopped'
    elapsedMs.value = performance.now() - startTime.value
    cancelAnimationFrame(rafId)
  } else if (cubeState.value === 'stopped') {
    acceptRecord()
  }
}

function onKeyUp(e: KeyboardEvent) {
  if (e.code !== 'Space') return
  if (activeTab.value !== 'cube') return
  e.preventDefault()

  if (cubeState.value === 'holding') {
    const held = performance.now() - holdStartTime.value
    if (held >= 300) {
      cubeState.value = 'running'
      startTime.value = performance.now()
      elapsedMs.value = 0
      rafId = requestAnimationFrame(updateDisplay)
    } else {
      cubeState.value = 'idle'
    }
  }
}

function acceptRecord() {
  cubeRecords.value.unshift({
    id: crypto.randomUUID(),
    time: elapsedMs.value,
    createdAt: new Date().toISOString(),
  })
  cubeState.value = 'idle'
  elapsedMs.value = 0
}

function discardRecord() {
  cubeState.value = 'idle'
  elapsedMs.value = 0
}

// ── Records Panel ──


// 有新记录时自动弹出面板
// ── Cube Stats ──

// ── Pomodoro ──

const pomodoro = usePomodoroTimer()
/** 进度弧：r=170 的周长；剩下多少就画多少 */
const arcLen = 2 * Math.PI * 170
const remainFrac = computed(() => 1 - pomodoro.progress.value)
const arcOffset = computed(() => arcLen * (1 - remainFrac.value))
/** 第 i 道刻度（0 在正上方，顺时针）亮不亮：落在剩余那段里就亮 */
function tickLit(i: number) {
  return i / 60 < remainFrac.value - 1e-6
}
/** 背后光晕的色相：刚开始番茄红（8），越到后面越偏洋红（330 = -30） */
const auraHue = computed(() => Math.round(8 - 38 * pomodoro.progress.value))
const statusText = computed(() => ({
  idle: t('timer.statusIdle'),
  running: t('timer.statusRunning'),
  paused: t('timer.statusPaused'),
  finished: t('timer.timeUp'),
})[pomodoro.state.value])
const PRESETS = [15, 25, 45, 60]
function pickPreset(m: number) {
  durationInput.value = m
  applyDuration()
}

const durationInput = ref(pomodoro.durationMinutes.value)

function applyDuration() {
  const v = Math.max(1, Math.min(120, durationInput.value))
  durationInput.value = v
  pomodoro.setDuration(v)
}

// ── Persistence ──

const store = new LazyStore('timer.json')

onMounted(async () => {
  await store.init()
  const saved = await store.get<CubeRecord[]>('cubeRecords')
  if (saved) cubeRecords.value = saved
  const dur = await store.get<number>('durationMinutes')
  if (dur) {
    durationInput.value = dur
    pomodoro.setDuration(dur)
  }

  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
})

onUnmounted(() => {
  cancelAnimationFrame(rafId)
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('keyup', onKeyUp)
})

watchDebounced(cubeRecords, async () => {
  await store.set('cubeRecords', toRaw(cubeRecords.value.map(r => ({ ...r }))))
  await store.save()
}, { deep: true, debounce: 500 })

watchDebounced(durationInput, async () => {
  await store.set('durationMinutes', durationInput.value)
  await store.save()
}, { debounce: 500 })
</script>

<template>
  <!--
    absolute inset-0:逃出 main 的 pt/pl(绝对定位对齐 padding box,不受那层 padding 影响),
    这样内容是相对**整个窗口**居中的 —— 侧栏和顶栏是浮层,不再把居中点往右下推。
    p-8 是对称的,不影响 mx-auto 的居中。
  -->
  <div class="absolute inset-0 flex flex-col p-8">
    <!-- 秒表页不限宽:其他页面用 max-w-* 收着怕太散,这一页就是要铺满 -->
    <Tabs v-model="activeTab" class="flex-1 overflow-hidden flex flex-col w-full">

      <TitleBarTabs>
        <TabsTrigger value="cube" class="gap-1.5 h-full px-4 rounded-[10px] hover:text-foreground">
          <span class="icon-[lucide--box] w-4 h-4" />
          {{ t('timer.cube') }}
        </TabsTrigger>
        <TabsTrigger value="pomodoro" class="gap-1.5 h-full px-4 rounded-[10px] hover:text-foreground">
          <span class="icon-[lucide--clock] w-4 h-4" />
          {{ t('timer.pomodoro') }}
        </TabsTrigger>
      </TitleBarTabs>

      <!-- ═══════ Cube Timer ═══════ -->
      <TabsContent value="cube" class="flex-1 flex flex-col min-h-0 mt-0">

        <!-- Timer area -->
        <div class="flex-1 flex flex-col items-center justify-center shrink-0">
          <div
            :class="[
              'font-mono tracking-wider transition-colors duration-200 leading-none text-[clamp(3rem,9vw,7rem)]',
              cubeState === 'holding' ? 'text-primary' : 'text-foreground',
            ]"
          >
            {{ formatCubeTime(elapsedMs) }}
          </div>

          <p v-if="cubeState === 'idle'" class="text-muted-foreground text-sm mt-4">
            {{ t('timer.holdSpace') }}
          </p>
          <p v-else-if="cubeState === 'holding'" class="text-primary text-sm mt-4 animate-pulse">
            {{ t('timer.releaseToStart') }}
          </p>
          <p v-else-if="cubeState === 'running'" class="text-muted-foreground/50 text-sm mt-4">
            {{ t('timer.spaceToStop') }}
          </p>

          <div v-if="cubeState === 'stopped'" class="flex flex-col items-center gap-2 mt-4">
            <div class="flex gap-3">
              <Button @click="acceptRecord">{{ t('timer.save') }}</Button>
              <Button variant="outline" @click="discardRecord">{{ t('timer.discard') }}</Button>
            </div>
            <p class="text-xs text-muted-foreground/50">{{ t('timer.spaceToSave') }}</p>
          </div>
        </div>

      </TabsContent>

      <!-- ═══════ Pomodoro ═══════ -->
      <!--
        2026-10-12 重做：一块会发光的表盘。
        - 外圈 60 道刻度（每 5 道一道长的），剩下的时间点亮、用掉的熄灭
        - 进度弧是番茄红 → 琥珀 → 洋红的渐变，后面垫一层模糊的同色光晕，计时中会「呼吸」
        - 弧头上有一颗彗星亮点，跟着剩余时间绕圈；表盘里面一圈慢慢旋转的光泽
        - 时间到了整块表盘脉冲一下
      -->
      <TabsContent value="pomodoro" class="flex-1 flex flex-col items-center justify-center gap-9 mt-0">
        <div class="pomo" :class="`pomo-${pomodoro.state.value}`">
          <!-- 背后的大光晕：颜色跟着进度从番茄红走到洋红 -->
          <div class="pomo-aura" :style="{ '--hue': auraHue }" />

          <svg viewBox="0 0 400 400" class="pomo-svg">
            <defs>
              <linearGradient id="pomoGrad" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stop-color="#ff5e3a" />
                <stop offset="50%" stop-color="#ffb347" />
                <stop offset="100%" stop-color="#ff3d8b" />
              </linearGradient>
              <radialGradient id="pomoDisc" cx="50%" cy="38%" r="65%">
                <stop offset="0%" stop-color="currentColor" stop-opacity="0.10" />
                <stop offset="100%" stop-color="currentColor" stop-opacity="0" />
              </radialGradient>
              <filter id="pomoBlur" x="-30%" y="-30%" width="160%" height="160%">
                <feGaussianBlur stdDeviation="7" />
              </filter>
            </defs>

            <!-- 表盘底：一层淡淡的径向光 -->
            <circle cx="200" cy="200" r="158" fill="url(#pomoDisc)" class="text-foreground" />

            <!-- 刻度 -->
            <line v-for="i in 60" :key="i" x1="200" :y1="i % 5 === 1 ? 14 : 18" x2="200" y2="26"
              class="pomo-tick" :class="tickLit(i - 1) ? 'is-lit' : ''"
              :stroke-width="i % 5 === 1 ? 2.4 : 1.4" stroke-linecap="round"
              :transform="`rotate(${(i - 1) * 6} 200 200)`" />

            <!-- 轨道 -->
            <circle cx="200" cy="200" r="170" fill="none" class="pomo-track" stroke-width="3" />
            <!-- 光晕弧 + 实弧 -->
            <circle cx="200" cy="200" r="170" fill="none" stroke="url(#pomoGrad)" stroke-width="10"
              stroke-linecap="round" :stroke-dasharray="arcLen" :stroke-dashoffset="arcOffset"
              transform="rotate(-90 200 200)" filter="url(#pomoBlur)" class="pomo-arc pomo-glow" />
            <circle cx="200" cy="200" r="170" fill="none" stroke="url(#pomoGrad)" stroke-width="5"
              stroke-linecap="round" :stroke-dasharray="arcLen" :stroke-dashoffset="arcOffset"
              transform="rotate(-90 200 200)" class="pomo-arc" />

            <!-- 彗星：弧头那颗亮点 -->
            <g v-if="remainFrac > 0.002" class="pomo-comet" :style="{ transform: `rotate(${remainFrac * 360}deg)` }">
              <circle cx="200" cy="30" r="9" fill="#ffd28a" filter="url(#pomoBlur)" opacity="0.9" />
              <circle cx="200" cy="30" r="4.2" fill="#fff6e8" />
            </g>
          </svg>

          <!-- 里面一圈慢慢转的光泽 -->
          <div class="pomo-sheen" />

          <div class="pomo-center">
            <span class="pomo-status">{{ statusText }}</span>
            <span class="pomo-time">{{ pomodoro.displayTime.value }}</span>
            <span class="pomo-sub">{{ t('timer.ofMinutes', { n: pomodoro.durationMinutes.value }) }}</span>
          </div>
        </div>

        <!-- 时长：几个常用的一点就好，也能自己填；只有没开始的时候能改 -->
        <div class="flex items-center gap-1.5" :class="pomodoro.state.value === 'idle' || pomodoro.state.value === 'finished' ? '' : 'opacity-40 pointer-events-none'">
          <button v-for="m in PRESETS" :key="m" class="pomo-chip" :class="pomodoro.durationMinutes.value === m ? 'is-on' : ''"
            @click="pickPreset(m)">{{ m }}</button>
          <div class="pomo-chip pomo-chip-input" :class="PRESETS.includes(pomodoro.durationMinutes.value) ? '' : 'is-on'">
            <input v-model.number="durationInput" type="number" :min="1" :max="120" @change="applyDuration"
              :title="t('timer.custom')" />
            <span>{{ t('timer.minutes') }}</span>
          </div>
        </div>

        <!-- 控制：中间一颗发光的圆按钮，旁边重置 -->
        <div class="flex items-center gap-5">
          <button class="pomo-side" :class="pomodoro.state.value === 'idle' ? 'invisible' : ''" :title="t('timer.reset')"
            @click="pomodoro.reset()">
            <span class="icon-[lucide--rotate-ccw] w-5 h-5" />
          </button>
          <button class="pomo-main" :title="pomodoro.state.value === 'running' ? t('timer.pause') : pomodoro.state.value === 'paused' ? t('timer.resume') : t('timer.start')"
            @click="pomodoro.state.value === 'running' ? pomodoro.pause() : pomodoro.start()">
            <!--
              播放三角自己画：三个顶点落在同一个圆上（外接圆），圆心就是按钮的圆心 ——
              三角形的外接圆和按钮的圆同心，看着才是正的（图标库那个三角是按方框居中的，会偏）。
              外接圆半径 11，三个顶点在 0° / 120° / 240°；稍微圆角一点。
            -->
            <svg v-if="pomodoro.state.value !== 'running'" viewBox="-14 -14 28 28" class="w-7 h-7">
              <polygon points="11,0 -5.5,9.526 -5.5,-9.526" fill="currentColor" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round" />
            </svg>
            <svg v-else viewBox="-14 -14 28 28" class="w-7 h-7">
              <rect x="-7.5" y="-9" width="5" height="18" rx="1.6" fill="currentColor" />
              <rect x="2.5" y="-9" width="5" height="18" rx="1.6" fill="currentColor" />
            </svg>
          </button>
          <span class="pomo-side invisible" />
        </div>
      </TabsContent>

    </Tabs>

  </div>
</template>

<style scoped>
/* ── 番茄时钟表盘（2026-10-12 重做） ── */
.pomo {
  position: relative;
  width: min(440px, 58vh);
  aspect-ratio: 1;
  display: grid;
  place-items: center;
}
.pomo-svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
}
/* 背后的大光晕：计时中慢慢呼吸 */
.pomo-aura {
  position: absolute;
  inset: 12%;
  border-radius: 50%;
  background: radial-gradient(circle, hsl(var(--hue) 95% 60% / 0.38), hsl(calc(var(--hue) - 30) 90% 55% / 0.12) 55%, transparent 72%);
  filter: blur(28px);
  opacity: 0.55;
  transition: opacity 600ms ease, background 1s linear;
}
.pomo-running .pomo-aura { animation: pomoBreath 4.2s ease-in-out infinite; opacity: 0.9; }
.pomo-paused .pomo-aura { opacity: 0.35; }
.pomo-finished .pomo-aura { animation: pomoBurst 1.6s ease-out infinite; opacity: 1; }
@keyframes pomoBreath {
  0%, 100% { transform: scale(0.94); opacity: 0.7; }
  50% { transform: scale(1.06); opacity: 1; }
}
@keyframes pomoBurst {
  0% { transform: scale(0.9); opacity: 1; }
  100% { transform: scale(1.25); opacity: 0.2; }
}
.pomo-tick { stroke: color-mix(in oklab, var(--foreground) 14%, transparent); transition: stroke 600ms ease; }
.pomo-tick.is-lit { stroke: color-mix(in oklab, var(--foreground) 70%, transparent); }
.pomo-track { stroke: color-mix(in oklab, var(--foreground) 7%, transparent); }
.pomo-arc { transition: stroke-dashoffset 1s linear; }
.pomo-glow { opacity: 0.85; }
.pomo-paused .pomo-arc { opacity: 0.55; }
.pomo-comet {
  transform-origin: 200px 200px;
  transform-box: view-box;
  transition: transform 1s linear;
}
.pomo-running .pomo-comet circle:first-child { animation: pomoTwinkle 1.6s ease-in-out infinite; }
@keyframes pomoTwinkle {
  0%, 100% { opacity: 0.55; }
  50% { opacity: 1; }
}
/* 表盘里面一圈慢慢旋转的光泽 */
.pomo-sheen {
  position: absolute;
  inset: 17%;
  border-radius: 50%;
  background: conic-gradient(from 0deg, transparent 0deg, color-mix(in oklab, var(--foreground) 9%, transparent) 40deg, transparent 110deg, transparent 220deg, color-mix(in oklab, var(--foreground) 5%, transparent) 260deg, transparent 320deg);
  mask: radial-gradient(circle, transparent 62%, #000 64%, #000 100%);
  animation: pomoSpin 18s linear infinite;
  animation-play-state: paused;
}
.pomo-running .pomo-sheen { animation-play-state: running; }
@keyframes pomoSpin { to { transform: rotate(360deg); } }

.pomo-center {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}
.pomo-status {
  font-size: 12px;
  letter-spacing: 0.32em;
  text-indent: 0.32em;
  color: var(--muted-foreground);
}
.pomo-time {
  font-size: clamp(56px, 9vh, 88px);
  font-weight: 200;
  line-height: 1;
  letter-spacing: 0.02em;
  font-variant-numeric: tabular-nums;
  background: linear-gradient(180deg, var(--foreground) 30%, color-mix(in oklab, var(--foreground) 55%, transparent));
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.pomo-finished .pomo-time { animation: pomoBlink 1s steps(2, start) infinite; }
@keyframes pomoBlink { to { opacity: 0.35; } }
.pomo-sub { font-size: 12px; color: color-mix(in oklab, var(--muted-foreground) 70%, transparent); }

/* 时长快捷按钮 */
.pomo-chip {
  height: 32px;
  min-width: 46px;
  padding: 0 12px;
  border-radius: 999px;
  border: 1px solid color-mix(in oklab, var(--foreground) 12%, transparent);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  color: var(--muted-foreground);
  transition: all 160ms ease;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
}
.pomo-chip:hover { color: var(--foreground); border-color: color-mix(in oklab, var(--foreground) 25%, transparent); }
.pomo-chip.is-on {
  color: #fff;
  border-color: transparent;
  background: linear-gradient(135deg, #ff5e3a, #ff3d8b);
  box-shadow: 0 4px 16px rgb(255 80 80 / 0.35);
}
.pomo-chip-input input {
  width: 30px;
  background: transparent;
  text-align: right;
  outline: none;
  color: inherit;
  -moz-appearance: textfield;
}
.pomo-chip-input input::-webkit-inner-spin-button,
.pomo-chip-input input::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
.pomo-chip-input span { font-size: 11px; opacity: 0.75; }

/* 中间那颗圆按钮：渐变 + 光晕 */
.pomo-main {
  width: 72px;
  height: 72px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  color: #fff;
  background: linear-gradient(135deg, #ff6a3d, #ff3d8b);
  box-shadow: 0 8px 28px rgb(255 70 90 / 0.45), inset 0 1px 0 rgb(255 255 255 / 0.35);
  transition: transform 160ms ease, box-shadow 160ms ease;
}
.pomo-main:hover { transform: scale(1.06); box-shadow: 0 10px 36px rgb(255 70 90 / 0.6), inset 0 1px 0 rgb(255 255 255 / 0.35); }
.pomo-main:active { transform: scale(0.96); }
.pomo-side {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  color: var(--muted-foreground);
  border: 1px solid color-mix(in oklab, var(--foreground) 12%, transparent);
  transition: all 160ms ease;
}
.pomo-side:hover { color: var(--foreground); background: color-mix(in oklab, var(--foreground) 8%, transparent); }
</style>
