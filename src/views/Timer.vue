<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, toRaw, watch } from 'vue'
import { watchDebounced } from '@vueuse/core'
import { LazyStore } from '@tauri-apps/plugin-store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
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

function deleteRecord(id: string) {
  cubeRecords.value = cubeRecords.value.filter(r => r.id !== id)
}

function clearAllRecords() {
  cubeRecords.value = []
}

// ── Records Panel ──

const showRecords = ref(false)

// 有新记录时自动弹出面板
watch(() => cubeRecords.value.length, (newLen, oldLen) => {
  if (newLen > oldLen) showRecords.value = true
})

// ── Cube Stats ──

const bestTime = computed(() => {
  if (!cubeRecords.value.length) return null
  return Math.min(...cubeRecords.value.map(r => r.time))
})

const worstTime = computed(() => {
  if (!cubeRecords.value.length) return null
  return Math.max(...cubeRecords.value.map(r => r.time))
})

const avgTime = computed(() => {
  if (!cubeRecords.value.length) return null
  const sum = cubeRecords.value.reduce((s, r) => s + r.time, 0)
  return sum / cubeRecords.value.length
})

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
  <div class="h-full w-full flex flex-col p-8">
    <Tabs v-model="activeTab" class="flex-1 overflow-hidden flex flex-col max-w-4xl mx-auto w-full">

      <TabsList class="shrink-0 w-fit mx-auto">
        <TabsTrigger value="cube" class="gap-1.5">
          <span class="icon-[lucide--box] w-4 h-4" />
          魔方计时
        </TabsTrigger>
        <TabsTrigger value="pomodoro" class="gap-1.5">
          <span class="icon-[lucide--clock] w-4 h-4" />
          番茄时钟
        </TabsTrigger>
      </TabsList>

      <!-- ═══════ Cube Timer ═══════ -->
      <TabsContent value="cube" class="flex-1 flex flex-col min-h-0 mt-0">

        <!-- Timer area -->
        <div class="flex-1 flex flex-col items-center justify-center shrink-0">
          <div
            :class="[
              'font-mono tracking-wider transition-colors duration-200 text-5xl sm:text-6xl md:text-7xl lg:text-8xl xl:text-9xl',
              cubeState === 'holding' ? 'text-primary' : 'text-foreground',
            ]"
          >
            {{ formatCubeTime(elapsedMs) }}
          </div>

          <p v-if="cubeState === 'idle'" class="text-muted-foreground text-sm mt-4">
            按住空格键开始
          </p>
          <p v-else-if="cubeState === 'holding'" class="text-primary text-sm mt-4 animate-pulse">
            松开开始计时...
          </p>
          <p v-else-if="cubeState === 'running'" class="text-muted-foreground/50 text-sm mt-4">
            按空格键停止
          </p>

          <div v-if="cubeState === 'stopped'" class="flex flex-col items-center gap-2 mt-4">
            <div class="flex gap-3">
              <Button @click="acceptRecord">保存</Button>
              <Button variant="outline" @click="discardRecord">丢弃</Button>
            </div>
            <p class="text-xs text-muted-foreground/50">按空格键快速保存</p>
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
          <span class="text-sm text-muted-foreground">时长</span>
          <Input
            v-model.number="durationInput"
            type="number"
            :min="1" :max="120"
            class="w-20 text-center"
            @change="applyDuration"
          />
          <span class="text-sm text-muted-foreground">分钟</span>
        </div>

        <!-- Controls -->
        <div class="flex gap-3">
          <Button
            v-if="pomodoro.state.value === 'idle' || pomodoro.state.value === 'finished'"
            @click="pomodoro.start()"
          >
            <span class="icon-[lucide--play] w-4 h-4 mr-1.5" />
            开始
          </Button>

          <Button
            v-if="pomodoro.state.value === 'running'"
            variant="outline"
            @click="pomodoro.pause()"
          >
            <span class="icon-[lucide--pause] w-4 h-4 mr-1.5" />
            暂停
          </Button>

          <Button
            v-if="pomodoro.state.value === 'paused'"
            @click="pomodoro.start()"
          >
            <span class="icon-[lucide--play] w-4 h-4 mr-1.5" />
            继续
          </Button>

          <Button
            v-if="pomodoro.state.value !== 'idle'"
            variant="outline"
            @click="pomodoro.reset()"
          >
            <span class="icon-[lucide--rotate-ccw] w-4 h-4 mr-1.5" />
            重置
          </Button>
        </div>

        <p v-if="pomodoro.state.value === 'finished'" class="text-sm text-muted-foreground animate-pulse">
          时间到！
        </p>
      </TabsContent>

    </Tabs>

    <!-- ═══════ Records Floating Panel ═══════ -->
    <div v-if="cubeRecords.length > 0 && activeTab === 'cube'" class="fixed right-2.5 bottom-2.5 z-40 flex flex-col items-end gap-2">

      <!-- Panel (above the toggle button) -->
      <Transition
        enter-active-class="transition-all duration-200 ease-out"
        leave-active-class="transition-all duration-150 ease-in"
        enter-from-class="opacity-0 translate-y-2 scale-95"
        leave-to-class="opacity-0 translate-y-2 scale-95"
      >
        <div
          v-if="showRecords"
          class="w-48 rounded-xl bg-background/95 backdrop-blur border border-border shadow-lg flex flex-col overflow-hidden"
        >
          <!-- Stats column -->
          <div class="shrink-0 flex flex-col gap-1.5 px-3 py-2.5 border-b border-border/50">
            <div class="flex items-center gap-1.5">
              <span class="icon-[lucide--zap] w-3 h-3 text-green-500 shrink-0" />
              <span class="font-mono text-xs">{{ bestTime != null ? formatCubeTime(bestTime) : '--' }}</span>
            </div>
            <div class="flex items-center gap-1.5">
              <span class="icon-[lucide--minus] w-3 h-3 text-muted-foreground shrink-0" />
              <span class="font-mono text-xs">{{ avgTime != null ? formatCubeTime(avgTime) : '--' }}</span>
            </div>
            <div class="flex items-center gap-1.5">
              <span class="icon-[lucide--turtle] w-3 h-3 text-orange-500 shrink-0" />
              <span class="font-mono text-xs">{{ worstTime != null ? formatCubeTime(worstTime) : '--' }}</span>
            </div>
          </div>

          <!-- Records list (fixed height container for ScrollArea) -->
          <div class="h-56 overflow-hidden">
            <ScrollArea class="h-full **:data-[slot=scroll-area-scrollbar]:hidden">
              <div class="px-3 py-1.5 flex flex-col">
                <div
                  v-for="(record, i) in cubeRecords" :key="record.id"
                  class="flex items-center gap-1.5 group py-1 rounded-md hover:bg-muted/50 px-1 -mx-1"
                >
                  <span class="text-muted-foreground/40 text-[10px] w-4 text-right shrink-0">{{ i + 1 }}</span>
                  <span class="font-mono text-xs flex-1">{{ formatCubeTime(record.time) }}</span>
                  <button
                    class="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
                    @click="deleteRecord(record.id)"
                  >
                    <span class="icon-[lucide--x] w-3 h-3" />
                  </button>
                </div>
              </div>
            </ScrollArea>
          </div>
        </div>
      </Transition>

      <!-- Bottom bar: clear + toggle -->
      <div class="flex items-center gap-2">
        <button
          v-if="showRecords && cubeRecords.length > 1"
          class="rounded-full bg-muted/80 backdrop-blur px-3 py-1.5 text-[10px] text-muted-foreground/40 hover:text-destructive transition-colors border border-border/50"
          @click="clearAllRecords"
        >
          清除全部
        </button>
        <button
          class="flex items-center gap-1.5 rounded-full bg-muted/80 backdrop-blur px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors shadow-sm border border-border/50"
          @click="showRecords = !showRecords"
        >
          <span :class="showRecords ? 'icon-[lucide--chevron-down]' : 'icon-[lucide--list]'" class="w-3.5 h-3.5" />
          {{ cubeRecords.length }}
        </button>
      </div>
    </div>
  </div>
</template>
