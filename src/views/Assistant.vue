<script setup lang="ts">
/**
 * 语音助手页：显示屏 + 遥控器。
 *
 * 收音、唤醒、识别、对话、联网查、念出来都在本机语音服务里（voice/server.py），
 * 这里只通过 /events 看它在干嘛、显示对话，点球 = 让它开始听（它在说话时就是打断）。
 * 喊唤醒词（默认「小精灵」）效果一样，页面不开着也行。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { ASSISTANT_DEFAULTS, ensureVoiceService, loadAssistantCfg, saveAssistantCfg, VOICE_BASE, type AssistantCfg } from '@/lib/assistant'

type Msg = { role: 'user' | 'assistant' | 'note'; content: string }

/** 三个内置音色（Qwen3-TTS 按描述造的参考音，GPT-SoVITS 照着念），默认温柔 */
const VOICES = [
  { id: 'gentle', label: '温柔' },
  { id: 'sweet', label: '甜美' },
  { id: 'lively', label: '活泼' },
]

const cfg = ref<AssistantCfg>({ ...ASSISTANT_DEFAULTS })
const msgs = ref<Msg[]>([])
const state = ref<'starting' | 'idle' | 'listening' | 'thinking' | 'speaking'>('starting')
const level = ref(0)
const error = ref('')
const latency = ref('')
const showSettings = ref(false)
const listEl = ref<HTMLElement | null>(null)

const label = computed(() => ({
  starting: '正在叫醒语音服务…（第一次要等十几秒）',
  idle: cfg.value.wake ? `点一下，或者喊「${cfg.value.wakeWord}」` : '点一下，跟我说话',
  listening: '在听…（说完停一下就好）',
  thinking: '想一下…',
  speaking: `点一下或喊「${cfg.value.wakeWord}」可以打断我`,
}[state.value]))

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
        msgs.value = (ev.history ?? []).map((m: Msg) => ({ role: m.role, content: m.content }))
        scroll()
        break
      case 'state':
        state.value = ev.state
        if (ev.state !== 'listening') level.value = 0
        break
      case 'level': level.value = ev.v; break
      case 'user':
        if (ev.text) msgs.value.push({ role: 'user', content: ev.text })
        scroll()
        break
      case 'reply_start':
        reply = { role: 'assistant', content: '' }
        msgs.value.push(reply)
        break
      case 'delta':
        if (reply) reply.content += ev.text
        scroll()
        break
      case 'search':
        msgs.value.splice(reply ? msgs.value.indexOf(reply) : msgs.value.length, 0, { role: 'note', content: `正在查：${ev.query}` })
        scroll()
        break
      case 'latency': latency.value = `开口用了 ${(ev.ms / 1000).toFixed(1)} 秒`; break
      case 'error': error.value = ev.text; break
    }
  }
  es.onerror = () => { state.value = 'starting' }
}

function onOrb() {
  if (state.value === 'starting') return
  error.value = ''
  void fetch(`${VOICE_BASE}/${state.value === 'listening' ? 'stop' : 'listen'}`, { method: 'POST' })
}

async function save() {
  try {
    await saveAssistantCfg(cfg.value)
    error.value = ''
  }
  catch (e) {
    error.value = String(e)
  }
}
async function clearChat() {
  msgs.value = []
  await fetch(`${VOICE_BASE}/clear`, { method: 'POST' }).catch(() => {})
}
function scroll() {
  void nextTick(() => listEl.value?.scrollTo({ top: listEl.value.scrollHeight }))
}

onMounted(async () => {
  cfg.value = await loadAssistantCfg()
  const err = await ensureVoiceService(cfg.value)
  if (err) error.value = err
  connect()
})
onBeforeUnmount(() => es?.close())
</script>

<template>
  <div class="h-full w-full flex flex-col items-center px-8 pb-6 gap-4 select-none">
    <div class="w-full max-w-2xl flex items-center justify-between mr-[130px]">
      <div class="text-lg font-semibold">{{ cfg.name }}</div>
      <div class="flex items-center gap-3 text-xs text-muted-foreground">
        <span v-if="latency">{{ latency }}</span>
        <button class="hover:text-foreground" @click="clearChat">清空对话</button>
        <button class="hover:text-foreground" @click="showSettings = !showSettings">设置</button>
      </div>
    </div>

    <div v-if="showSettings" class="w-full max-w-2xl rounded-xl bg-card/60 p-4 grid gap-3 text-sm">
      <div class="flex gap-4 flex-wrap items-center">
        <label class="flex items-center gap-2">名字<input v-model="cfg.name" class="w-28 rounded-md bg-background/60 px-2 py-1" @change="save"></label>
        <label class="flex items-center gap-2"><input v-model="cfg.wake" type="checkbox" @change="save">后台听唤醒词</label>
        <label class="flex items-center gap-2">唤醒词<input v-model="cfg.wakeWord" class="w-28 rounded-md bg-background/60 px-2 py-1" @change="save"></label>
        <label class="flex items-center gap-2"><input v-model="cfg.search" type="checkbox" @change="save">允许上网查</label>
      </div>
      <label class="grid gap-1">人设（{name} 换成名字，{now} 换成现在的日期和时间）
        <textarea v-model="cfg.persona" rows="6" class="rounded-md bg-background/60 px-2 py-1 font-mono text-xs" @change="save" />
      </label>
      <div class="flex gap-4 flex-wrap items-center">
        <div class="flex items-center gap-1">声音
          <button v-for="v in VOICES" :key="v.id" class="rounded-md px-2 py-1" :class="cfg.engine === 'gsv' && cfg.voice === v.id ? 'bg-primary/25' : 'bg-background/60'"
            @click="cfg.engine = 'gsv'; cfg.voice = v.id; save()">{{ v.label }}</button>
          <button class="rounded-md px-2 py-1" :class="cfg.engine === 'kokoro' ? 'bg-primary/25' : 'bg-background/60'"
            @click="cfg.engine = 'kokoro'; save()">极速（不好听）</button>
        </div>
        <label class="flex items-center gap-2">音量
          <input v-model.number="cfg.volume" type="range" min="0.3" max="3" step="0.1" class="w-28" @change="save">
          <span class="w-10 text-xs text-muted-foreground">{{ Math.round(cfg.volume * 100) }}%</span>
        </label>
        <label class="flex items-center gap-2">语速<input v-model.number="cfg.speed" type="number" step="0.05" min="0.7" max="1.5" class="w-20 rounded-md bg-background/60 px-2 py-1" @change="save"></label>
        <label class="flex items-center gap-2">模型<input v-model="cfg.model" class="w-32 rounded-md bg-background/60 px-2 py-1" @change="save"></label>
      </div>
    </div>

    <div ref="listEl" class="w-full max-w-2xl flex-1 min-h-0 overflow-auto flex flex-col gap-3 py-2">
      <template v-for="(m, i) in msgs" :key="i">
        <div v-if="m.role === 'note'" class="self-start text-xs text-muted-foreground px-2">{{ m.content }}</div>
        <div v-else class="max-w-[80%] rounded-2xl px-4 py-2 leading-relaxed whitespace-pre-wrap"
          :class="m.role === 'user' ? 'self-end bg-primary/15' : 'self-start bg-card/70'">
          {{ m.content || '…' }}
        </div>
      </template>
    </div>

    <button class="orb" :data-state="state" :style="{ '--lv': level }" @click="onOrb" />
    <div class="text-sm text-muted-foreground">{{ label }}</div>
    <div v-if="error" class="text-xs text-red-400">{{ error }}</div>
  </div>
</template>

<style scoped>
.orb {
  width: 120px; height: 120px; border-radius: 50%; flex-shrink: 0; cursor: pointer;
  background: radial-gradient(circle at 35% 30%, #ffe3f1, #ff8fc8 45%, #9b7bff 100%);
  box-shadow: 0 0 calc(30px + var(--lv) * 60px) rgb(255 143 200 / .55);
  transform: scale(calc(1 + var(--lv) * .15));
  transition: box-shadow .12s, transform .12s, filter .3s;
}
.orb[data-state="starting"] { filter: grayscale(.8) brightness(.8); cursor: wait; }
.orb[data-state="idle"] { animation: breathe 3.2s ease-in-out infinite; }
.orb[data-state="thinking"] { animation: spin 1.2s linear infinite; background: conic-gradient(from 0deg, #ff8fc8, #9b7bff, #6fd3ff, #ff8fc8); }
.orb[data-state="speaking"] { animation: talk .5s ease-in-out infinite alternate; }
@keyframes breathe { 50% { transform: scale(1.04); } }
@keyframes spin { to { transform: rotate(1turn); } }
@keyframes talk { to { transform: scale(1.08); box-shadow: 0 0 70px rgb(155 123 255 / .6); } }
</style>
