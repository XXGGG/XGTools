<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, toRaw } from 'vue'
import { watchDebounced } from '@vueuse/core'
import { LazyStore } from '@tauri-apps/plugin-store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
const circumference = 2 * Math.PI * 90 // r=90
const dashOffset = computed(() => circumference * pomodoro.progress.value)

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
        <TabsTrigger value="cube" class="gap-1.5 h-11 px-4 rounded-xl">
          <span class="icon-[lucide--box] w-4 h-4" />
          {{ t('timer.cube') }}
        </TabsTrigger>
        <TabsTrigger value="pomodoro" class="gap-1.5 h-11 px-4 rounded-xl">
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
      <TabsContent value="pomodoro" class="flex-1 flex flex-col items-center justify-center gap-8 mt-0">

        <!-- SVG Ring + Time -->
        <div class="relative">
          <svg viewBox="0 0 200 200" class="w-56 h-56">
            <circle
              cx="100" cy="100" r="90"
              fill="none"
              stroke="currentColor"
              class="text-muted/20"
              stroke-width="4"
            />
            <circle
              cx="100" cy="100" r="90"
              fill="none"
              stroke="currentColor"
              class="text-foreground transition-[stroke-dashoffset] duration-1000 ease-linear"
              stroke-width="4"
              stroke-linecap="round"
              :stroke-dasharray="circumference"
              :stroke-dashoffset="dashOffset"
              transform="rotate(-90 100 100)"
            />
          </svg>
          <div class="absolute inset-0 flex items-center justify-center">
            <span class="font-mono text-4xl tracking-wider">{{ pomodoro.displayTime.value }}</span>
          </div>
        </div>

        <!-- Duration setting -->
        <div v-if="pomodoro.state.value === 'idle'" class="flex items-center gap-3">
          <span class="text-sm text-muted-foreground">{{ t('timer.duration') }}</span>
          <Input
            v-model.number="durationInput"
            type="number"
            :min="1" :max="120"
            class="w-20 text-center"
            @change="applyDuration"
          />
          <span class="text-sm text-muted-foreground">{{ t('timer.minutes') }}</span>
        </div>

        <!-- Controls -->
        <div class="flex gap-3">
          <Button
            v-if="pomodoro.state.value === 'idle' || pomodoro.state.value === 'finished'"
            @click="pomodoro.start()"
          >
            <span class="icon-[lucide--play] w-4 h-4 mr-1.5" />
            {{ t('timer.start') }}
          </Button>

          <Button
            v-if="pomodoro.state.value === 'running'"
            variant="outline"
            @click="pomodoro.pause()"
          >
            <span class="icon-[lucide--pause] w-4 h-4 mr-1.5" />
            {{ t('timer.pause') }}
          </Button>

          <Button
            v-if="pomodoro.state.value === 'paused'"
            @click="pomodoro.start()"
          >
            <span class="icon-[lucide--play] w-4 h-4 mr-1.5" />
            {{ t('timer.resume') }}
          </Button>

          <Button
            v-if="pomodoro.state.value !== 'idle'"
            variant="outline"
            @click="pomodoro.reset()"
          >
            <span class="icon-[lucide--rotate-ccw] w-4 h-4 mr-1.5" />
            {{ t('timer.reset') }}
          </Button>
        </div>

        <p v-if="pomodoro.state.value === 'finished'" class="text-sm text-muted-foreground animate-pulse">
          {{ t('timer.timeUp') }}
        </p>
      </TabsContent>

    </Tabs>

  </div>
</template>
