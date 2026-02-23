import { ref, computed } from 'vue'

type PomodoroState = 'idle' | 'running' | 'paused' | 'finished'

// 模块级状态 — 组件销毁后仍然保持
const state = ref<PomodoroState>('idle')
const totalSeconds = ref(25 * 60)
const remainingSeconds = ref(25 * 60)
const durationMinutes = ref(25)
let intervalId: ReturnType<typeof setInterval> | null = null

function tick() {
  if (remainingSeconds.value <= 0) {
    state.value = 'finished'
    if (intervalId) { clearInterval(intervalId); intervalId = null }
    return
  }
  remainingSeconds.value--
}

function start() {
  if (state.value === 'idle' || state.value === 'finished') {
    totalSeconds.value = durationMinutes.value * 60
    remainingSeconds.value = totalSeconds.value
  }
  state.value = 'running'
  if (!intervalId) {
    intervalId = setInterval(tick, 1000)
  }
}

function pause() {
  state.value = 'paused'
  if (intervalId) { clearInterval(intervalId); intervalId = null }
}

function reset() {
  state.value = 'idle'
  if (intervalId) { clearInterval(intervalId); intervalId = null }
  totalSeconds.value = durationMinutes.value * 60
  remainingSeconds.value = totalSeconds.value
}

function setDuration(minutes: number) {
  durationMinutes.value = minutes
  if (state.value === 'idle') {
    totalSeconds.value = minutes * 60
    remainingSeconds.value = totalSeconds.value
  }
}

const progress = computed(() => {
  if (totalSeconds.value === 0) return 0
  return 1 - remainingSeconds.value / totalSeconds.value
})

const displayTime = computed(() => {
  const m = Math.floor(remainingSeconds.value / 60)
  const s = remainingSeconds.value % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
})

export function usePomodoroTimer() {
  return {
    state,
    totalSeconds,
    remainingSeconds,
    durationMinutes,
    progress,
    displayTime,
    start,
    pause,
    reset,
    setDuration,
  }
}
