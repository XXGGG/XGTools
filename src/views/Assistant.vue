<script setup lang="ts">
/**
 * 语音助手页：中间一颗粒子球，右下角一个小球按钮，点开从右边滑出一块磨砂面板（聊天窗 / 小设置），
 * 面板开着时大球往左挪，保持在剩下的空间里居中。
 *
 * 收音、唤醒、识别、对话、联网查、念出来都在本机语音服务里（voice/server.py），
 * 这里只通过 /events 看它在干嘛，用球表现出来。两种模式：
 *   待命：颜色淡、慢慢转。
 *   对话：亮起来、转快一点；在听时跟着你的声音变亮，想的时候高速自旋，说话时跟着它自己的声音一胀一缩。
 * 每种模式的颜色、自转、起伏、亮度都能在「小设置」里调（lib/orbLook）。
 * 点球 = 开始对话（说话时点 = 打断，在听时点 = 不聊了）。对话是连续的，不用每句都叫它，
 * 10 秒没人说话或者让它退下，它自己回待命（见 server.py 的 convo）。
 *
 * 球是 public/fairy（自己写的粒子球），参数用 postMessage 实时调，那边会平滑过渡。
 */
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ensureVoiceService, loadAssistantCfg, VOICE_BASE } from '@/lib/assistant'
import { loadOrbLook, orbLook, orbPreview } from '@/lib/orbLook'
import OrbSettings from '@/components/settings/OrbSettings.vue'
import AssistantSettings from '@/components/settings/AssistantSettings.vue'
import SiriBall from '@/components/assistant/SiriBall.vue'

type State = 'starting' | 'idle' | 'listening' | 'thinking' | 'speaking'
type Msg = { role: 'user' | 'assistant' | 'note'; content: string }

const state = ref<State>('starting')
const paused = ref(false)
const frame = ref<HTMLIFrameElement | null>(null)
const panelOpen = ref(false)
const tab = ref<'chat' | 'orb' | 'basic' | 'persona'>('chat')
const TABS = [{ id: 'chat', label: '聊天' }, { id: 'orb', label: '球体' }, { id: 'basic', label: '基础' }, { id: 'persona', label: '人设' }] as const
const msgs = ref<Msg[]>([])
const listEl = ref<HTMLElement | null>(null)

function post(m: Record<string, number | string>) {
  frame.value?.contentWindow?.postMessage({ fairy: m }, '*')
}

/** 当前状态 → 球的参数。待命用 idle 那套，其余都算对话；想的时候换成思考自旋 */
function applyMood() {
  // 正在调设置：按预览的样子来（说话那种还会假装一胀一缩，见下面 fakeTalk）
  const pv = orbPreview.value
  const s: State = pv === 'idle' ? 'idle' : pv === 'talk' ? 'speaking' : pv === 'think' ? 'thinking' : paused.value ? 'starting' : state.value
  const talk = s === 'listening' || s === 'thinking' || s === 'speaking'
  const m = talk ? orbLook.talk : orbLook.idle
  post({
    shell: m.shell, core: m.core, swell: m.swell,
    bright: s === 'starting' ? m.bright * 0.4 : m.bright,
    spin: s === 'thinking' ? orbLook.thinkSpin : s === 'listening' ? m.spin * 0.5 : s === 'starting' ? m.spin * 0.5 : m.spin,
    speed: orbLook.drift * (s === 'thinking' ? 1.2 : talk ? 1.1 : 0.7),
    pulse: 0, glow: 0,
  })
}
watch([state, paused, orbPreview], applyMood)
watch(orbLook, applyMood, { deep: true })

/** 预览「对话时」：假装在说话，按说话的节奏一胀一缩，起伏调多大一眼就看得出来 */
let fakeT = 0
watch(orbPreview, (pv) => {
  window.clearInterval(fakeT)
  if (pv !== 'talk') return
  const t0 = performance.now()
  fakeT = window.setInterval(() => {
    const t = (performance.now() - t0) / 1000
    const v = Math.max(0, Math.sin(t * 7) * 0.5 + Math.sin(t * 2.3) * 0.5) * (0.6 + 0.4 * Math.sin(t * 11))
    post({ pulse: Math.min(1, Math.abs(v)) })
  }, 50)
})

function scroll() {
  void nextTick(() => listEl.value?.scrollTo({ top: listEl.value.scrollHeight, behavior: 'smooth' }))
}

let es: EventSource | null = null
let reply: Msg | null = null
function connect() {
  es?.close()
  es = new EventSource(`${VOICE_BASE}/events`)
  es.onmessage = (e) => {
    const ev = JSON.parse(e.data)
    switch (ev.type) {
      case 'hello':
        state.value = ev.state
        paused.value = !!ev.paused
        msgs.value = (ev.history ?? []).map((m: Msg) => ({ role: m.role, content: m.content }))
        scroll()
        break
      case 'state': state.value = ev.state; break
      // 在听：跟着你的音量只变亮；说话：跟着它自己的音量胀缩加变亮
      case 'level': if (state.value === 'listening') post({ glow: Math.min(1, ev.v * 1.6) }); break
      case 'out': if (state.value === 'speaking') post({ pulse: Math.min(1, ev.v * 1.6) }); break
      case 'paused': paused.value = ev.on; break
      case 'user':
        if (ev.text) { msgs.value.push({ role: 'user', content: ev.text }); scroll() }
        break
      case 'reply_start':
        msgs.value.push({ role: 'assistant', content: '' })
        // 要拿响应式数组里的那一份（代理）来改；直接改原对象，界面不会跟着刷新 —— 回复就一直是「…」
        reply = msgs.value[msgs.value.length - 1]
        break
      case 'delta':
        if (reply) { reply.content += ev.text; scroll() }
        break
      case 'error':
        msgs.value.push({ role: 'note', content: `出错了：${ev.text}` })
        scroll()
        break
      case 'search':
        // 「查了一下」放在这条回复的上面（回复气泡在查之前就开了）
        msgs.value.splice(reply ? msgs.value.indexOf(reply) : msgs.value.length, 0, { role: 'note', content: ev.label ?? `查了一下：${ev.query}` })
        scroll()
        break
    }
  }
  es.onerror = () => { state.value = 'starting' }
}

function onOrb() {
  if (state.value === 'starting' || paused.value) return
  const stop = state.value === 'listening'
  // 先在界面上变过去，不等服务回话 —— 点下去马上就要看到它亮起来
  state.value = stop ? 'idle' : 'listening'
  void fetch(`${VOICE_BASE}/${stop ? 'stop' : 'listen'}`, { method: 'POST' })
}

async function clearChat() {
  msgs.value = []
  await fetch(`${VOICE_BASE}/clear`, { method: 'POST' }).catch(() => {})
}

function onMessage(e: MessageEvent) {
  if (e.source === frame.value?.contentWindow && e.data?.fairy === 'ready') applyMood()
}

onMounted(async () => {
  window.addEventListener('message', onMessage)
  await loadOrbLook()
  applyMood()
  await ensureVoiceService(await loadAssistantCfg())
  connect()
})
onBeforeUnmount(() => {
  window.clearInterval(fakeT)
  orbPreview.value = null
  es?.close()
  window.removeEventListener('message', onMessage)
})
</script>

<template>
  <div class="h-full w-full relative select-none overflow-hidden">
    <!-- 大球：面板开着时让出右边那一块，自己在剩下的地方居中（iframe 跟着变窄，球那边按画布重新居中） -->
    <div class="absolute inset-y-0 left-0 transition-[right] duration-500 ease-out" :class="panelOpen ? 'right-[400px]' : 'right-0'">
      <!-- iframe 吃鼠标事件，所以关掉它的指针，点击由中间盖着的透明圆来接 -->
      <iframe ref="frame" src="/fairy/index.html" class="absolute inset-0 size-full border-0 pointer-events-none bg-transparent" />
      <button class="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 size-[min(50vh,50%)] aspect-square rounded-full outline-none"
        :class="state === 'starting' || paused ? 'cursor-wait' : 'cursor-pointer'" aria-label="对话" @click="onOrb" />
    </div>

    <!-- 右边的磨砂面板 -->
    <Transition enter-active-class="transition duration-300 ease-out" enter-from-class="opacity-0 translate-x-6"
      leave-active-class="transition duration-200 ease-in" leave-to-class="opacity-0 translate-x-6">
      <aside v-if="panelOpen"
        class="absolute top-14 bottom-20 right-4 w-[376px] rounded-2xl border border-white/10 bg-background/35 backdrop-blur-2xl shadow-2xl flex flex-col overflow-hidden select-text">
        <!-- 四个页签占满一行 -->
        <div class="shrink-0 p-2">
          <div class="grid grid-cols-4 rounded-lg bg-muted/40 p-0.5 text-sm">
            <button v-for="t in TABS" :key="t.id" class="rounded-md py-1 transition-colors"
              :class="tab === t.id ? 'bg-background/70 text-foreground' : 'text-muted-foreground hover:text-foreground'"
              @click="tab = t.id">{{ t.label }}</button>
          </div>
        </div>

        <div v-show="tab === 'chat'" ref="listEl" class="flex-1 min-h-0 overflow-y-auto px-3 pb-3 flex flex-col gap-2">
          <div v-if="!msgs.length" class="m-auto text-xs text-muted-foreground">还没聊过</div>
          <button v-else class="self-end -mb-1 text-xs text-muted-foreground hover:text-foreground" @click="clearChat">清空</button>
          <template v-for="(m, i) in msgs" :key="i">
            <div v-if="m.role === 'note'" class="self-center text-[11px] text-muted-foreground">{{ m.content }}</div>
            <!-- 气泡：深色模式黑底白字，浅色模式白底黑字，都带一点透 -->
            <div v-else class="max-w-[82%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed whitespace-pre-wrap break-words backdrop-blur-md
                     bg-white/75 text-neutral-900 dark:bg-black/60 dark:text-white"
              :class="m.role === 'user' ? 'self-end rounded-br-md' : 'self-start rounded-bl-md'">
              {{ m.content || '…' }}
            </div>
          </template>
        </div>

        <div v-if="tab === 'orb'" class="flex-1 min-h-0 overflow-y-auto px-3 pb-4"><OrbSettings /></div>
        <div v-if="tab === 'basic'" class="flex-1 min-h-0 overflow-y-auto px-3 pb-4"><AssistantSettings part="basic" /></div>
        <div v-if="tab === 'persona'" class="flex-1 min-h-0 overflow-y-auto px-3 pb-4"><AssistantSettings part="persona" /></div>
      </aside>
    </Transition>

    <!-- 右下角的小球：通透玻璃球 + 一束螺旋拧着的彩色细丝（components/assistant/SiriBall.vue） -->
    <button class="absolute right-6 bottom-6 rounded-full backdrop-blur-sm transition-transform hover:scale-110"
      :class="panelOpen ? 'drop-shadow-[0_0_10px_rgb(127_176_255_/_.5)]' : ''" :title="panelOpen ? '收起' : '聊天记录和设置'" @click="panelOpen = !panelOpen">
      <SiriBall :size="48" :active="panelOpen" />
    </button>
  </div>
</template>
