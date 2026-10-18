<script setup lang="ts">
/**
 * 语音助手（voice 分支第一版，先看效果）。
 *
 * 点一下中间的球开始说话，说完停顿一下自动结束（不用再点），
 * 声音发给本机语音服务（voice/server.py）：识别 → qwen 边想边说 → 一句一句念出来。
 * 它在说话时再点球 = 打断：立刻闭嘴开始听你说。
 * 人设、声音这些存在 assistant.json；最近几轮对话带上去当上下文。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { LazyStore } from '@tauri-apps/plugin-store'

const BASE = 'http://127.0.0.1:18733'

type Msg = { role: 'user' | 'assistant'; content: string }
type Cfg = { name: string; persona: string; engine: 'gsv' | 'kokoro' | 'edge'; voice: string; speed: number; volume: number; model: string }

/** 三个内置音色（Qwen3-TTS 按描述造的参考音，GPT-SoVITS 照着念），默认温柔 */
const VOICES = [
  { id: 'gentle', label: '温柔' },
  { id: 'sweet', label: '甜美' },
  { id: 'lively', label: '活泼' },
]

const DEFAULT_PERSONA = `你是 {name}，夏戈的私人助手，一个温柔可爱的女生。
- 用简体中文回答，像平时说话一样自然、亲切，不要播音腔，不要刻意卖萌。
- 回答要短：一般一到三句话，像朋友聊天。不要列表、不要标题、不要 markdown、不要表情符号。
- 问到事实（年龄、日期、谁是谁）就直接给答案；算年龄要按今天的日期算。不知道或不确定就直说。
- 今天是 {date}。`

const cfg = ref<Cfg>({ name: 'Fairy', persona: DEFAULT_PERSONA, engine: 'gsv', voice: 'gentle', speed: 1.1, volume: 1.8, model: 'qwen3.5:9b' })
const store = new LazyStore('assistant.json')

const msgs = ref<Msg[]>([])
const state = ref<'idle' | 'starting' | 'listening' | 'thinking' | 'speaking'>('starting')
const level = ref(0)
const error = ref('')
const latency = ref('')
const showSettings = ref(false)
const listEl = ref<HTMLElement | null>(null)

const label = computed(() => ({
  idle: '点一下，跟我说话', starting: '正在叫醒语音服务…', listening: '在听…（说完停一下就好）',
  thinking: '想一下…', speaking: '点一下可以打断我',
}[state.value]))

// ── 语音服务 ──
async function waitServer() {
  try { await invoke('voice_start') } catch (e) { error.value = String(e) }
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`${BASE}/health`)
      if (r.ok) { state.value = 'idle'; return }
    } catch {}
    await new Promise(r => setTimeout(r, 500))
  }
  error.value = '语音服务没起来'
}

// ── 录音：16k 单声道，能量判断说完没有 ──
let micCtx: AudioContext | null = null
let micStream: MediaStream | null = null
let proc: ScriptProcessorNode | null = null
let chunks: Float32Array[] = []
let spoke = false
let silentMs = 0
let totalMs = 0

async function startListening() {
  stopPlayback()
  abort?.abort()
  error.value = ''
  micStream ??= await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } })
  micCtx ??= new AudioContext({ sampleRate: 16000 })
  await micCtx.resume()
  const src = micCtx.createMediaStreamSource(micStream)
  proc = micCtx.createScriptProcessor(2048, 1, 1)
  chunks = []; spoke = false; silentMs = 0; totalMs = 0
  state.value = 'listening'
  proc.onaudioprocess = (e) => {
    const d = e.inputBuffer.getChannelData(0)
    chunks.push(new Float32Array(d))
    let sum = 0
    for (let i = 0; i < d.length; i++) sum += d[i] * d[i]
    const rms = Math.sqrt(sum / d.length)
    level.value = Math.min(1, rms * 12)
    const ms = (d.length / 16000) * 1000
    totalMs += ms
    if (rms > 0.02) { spoke = true; silentMs = 0 } else if (spoke) silentMs += ms
    // 说过话之后静了 0.7 秒就算说完；一直没开口 8 秒就放弃；最长 20 秒
    if ((spoke && silentMs > 700) || (!spoke && totalMs > 8000) || totalMs > 20000) void finishListening()
  }
  src.connect(proc)
  proc.connect(micCtx.destination)
}

async function finishListening() {
  if (!proc) return
  proc.disconnect(); proc.onaudioprocess = null; proc = null
  level.value = 0
  if (!spoke) { state.value = 'idle'; return }
  const len = chunks.reduce((n, c) => n + c.length, 0)
  const pcm = new Float32Array(len)
  let o = 0
  for (const c of chunks) { pcm.set(c, o); o += c.length }
  await turn(pcm)
}

// ── 一轮对话：流式收文字和一句句的声音 ──
let abort: AbortController | null = null
async function turn(pcm: Float32Array) {
  state.value = 'thinking'
  const t0 = performance.now()
  let firstAudio = 0
  const sys = cfg.value.persona.split('{name}').join(cfg.value.name).split('{date}').join(new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' }))
  const meta = { system: sys, history: msgs.value.slice(-12), engine: cfg.value.engine, voice: cfg.value.voice, speed: cfg.value.speed, model: cfg.value.model }
  abort = new AbortController()
  const me = abort
  let reply: Msg | null = null
  try {
    const r = await fetch(`${BASE}/turn`, {
      method: 'POST', body: pcm.buffer as ArrayBuffer, signal: me.signal,
      headers: { 'X-Meta-B64': btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(meta)))) },
    })
    const reader = r.body!.getReader()
    const dec = new TextDecoder()
    let buf = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1)
        if (!line.trim()) continue
        const ev = JSON.parse(line)
        if (ev.type === 'user') {
          if (!ev.text) { state.value = 'idle'; return }
          msgs.value.push({ role: 'user', content: ev.text })
          reply = { role: 'assistant', content: '' }
          msgs.value.push(reply)
          scroll()
        } else if (ev.type === 'delta' && reply) {
          reply.content += ev.text
          scroll()
        } else if (ev.type === 'pcm' || ev.type === 'mp3') {
          if (!firstAudio) {
            firstAudio = performance.now() - t0
            latency.value = `开口用了 ${(firstAudio / 1000).toFixed(1)} 秒`
          }
          if (ev.type === 'pcm') playPcm(ev.data, ev.rate)
          else enqueue(ev.data)
        } else if (ev.type === 'error') {
          error.value = ev.text
        }
      }
    }
  } catch (e) {
    if (!me.signal.aborted) error.value = `出错了：${e}`
  } finally {
    if (abort === me) abort = null
    if (state.value === 'thinking') state.value = playing?.size ? 'speaking' : 'idle'
  }
}

// ── 播放：收到一小段就排到上一段后面，首尾相接；能随时全部掐掉 ──
let outCtx: AudioContext | null = null
let outGain: GainNode | null = null
let nextAt = 0

/** 输出都走一个增益节点，音量设置改它；能调到 3 倍（合成出来的声音本身偏小） */
function out() {
  if (!outCtx) {
    outCtx = new AudioContext()
    outGain = outCtx.createGain()
    outGain.connect(outCtx.destination)
  }
  outGain!.gain.value = cfg.value.volume
  return outCtx
}
function setVolume() {
  if (outGain) outGain.gain.value = cfg.value.volume
  void saveCfg()
}
let playing: Set<AudioBufferSourceNode> | null = null
let decodeChain = Promise.resolve()

function schedule(ab: AudioBuffer) {
  const ctx = outCtx!
  const s = ctx.createBufferSource()
  s.buffer = ab
  s.connect(outGain!)
  // 第一段留 60ms 余量，免得网络抖一下就断音
  nextAt = Math.max(nextAt, ctx.currentTime + 0.06)
  s.start(nextAt)
  nextAt += ab.duration
  playing ??= new Set()
  playing.add(s)
  state.value = 'speaking'
  s.onended = () => {
    playing?.delete(s)
    if (playing && !playing.size) {
      playing = null
      if (!abort && state.value === 'speaking') state.value = 'idle'
    }
  }
}
function playPcm(b64: string, rate: number) {
  const ctx = out()
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
  const i16 = new Int16Array(bytes.buffer, 0, bytes.length >> 1)
  const ab = ctx.createBuffer(1, i16.length, rate)
  const ch = ab.getChannelData(0)
  for (let i = 0; i < i16.length; i++) ch[i] = i16[i] / 32768
  schedule(ab)
}
function enqueue(b64: string) {
  out()
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
  decodeChain = decodeChain.then(async () => schedule(await outCtx!.decodeAudioData(bytes.buffer))).catch(() => {})
}
function stopPlayback() {
  const p = playing
  playing = null
  nextAt = 0
  p?.forEach((s) => { try { s.stop() } catch {} })
}

function onOrb() {
  if (state.value === 'starting') return
  if (state.value === 'listening') { void finishListening(); return }
  // 空闲、思考中、说话中：都直接开始听（后两种就是打断）
  void startListening().catch(e => { error.value = `麦克风打不开：${e}`; state.value = 'idle' })
}

function scroll() {
  void nextTick(() => listEl.value?.scrollTo({ top: listEl.value.scrollHeight }))
}

async function saveCfg() {
  await store.set('config.v2', cfg.value)
  await store.save()
}
function clearChat() { msgs.value = [] }

onMounted(async () => {
  await store.init()
  const saved = await store.get<Partial<Cfg>>('config.v2')
  if (saved) cfg.value = { ...cfg.value, ...saved }
  await waitServer()
})
onBeforeUnmount(() => {
  stopPlayback(); abort?.abort()
  micStream?.getTracks().forEach(t => t.stop())
  void micCtx?.close(); void outCtx?.close()
})
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
      <label class="grid gap-1">名字<input v-model="cfg.name" class="rounded-md bg-background/60 px-2 py-1" @change="saveCfg"></label>
      <label class="grid gap-1">人设（{name} 换成名字，{date} 换成今天）
        <textarea v-model="cfg.persona" rows="6" class="rounded-md bg-background/60 px-2 py-1 font-mono text-xs" @change="saveCfg" />
      </label>
      <div class="flex gap-4 flex-wrap items-center">
        <label class="flex items-center gap-2">声音
          <select v-model="cfg.engine" class="rounded-md bg-background/60 px-2 py-1" @change="cfg.voice = cfg.engine === 'edge' ? 'zh-CN-XiaoxiaoNeural' : cfg.engine === 'kokoro' ? '47' : 'gentle'; saveCfg()">
            <option value="gsv">内置音色（推荐）</option>
            <option value="kokoro">本机小模型（最快，不好听）</option>
            <option value="edge">微软在线（慢 2 秒，要联网）</option>
          </select>
        </label>
        <div v-if="cfg.engine === 'gsv'" class="flex items-center gap-1">
          <button v-for="v in VOICES" :key="v.id" class="rounded-md px-2 py-1" :class="cfg.voice === v.id ? 'bg-primary/25' : 'bg-background/60'"
            @click="cfg.voice = v.id; saveCfg()">{{ v.label }}</button>
        </div>
        <label v-else class="flex items-center gap-2">音色<input v-model="cfg.voice" class="w-48 rounded-md bg-background/60 px-2 py-1" @change="saveCfg"></label>
        <label class="flex items-center gap-2">音量
          <input v-model.number="cfg.volume" type="range" min="0.3" max="3" step="0.1" class="w-32" @input="setVolume">
          <span class="w-10 text-xs text-muted-foreground">{{ Math.round(cfg.volume * 100) }}%</span>
        </label>
        <label class="flex items-center gap-2">语速<input v-model.number="cfg.speed" type="number" step="0.05" min="0.7" max="1.5" class="w-20 rounded-md bg-background/60 px-2 py-1" @change="saveCfg"></label>
        <label class="flex items-center gap-2">模型<input v-model="cfg.model" class="w-32 rounded-md bg-background/60 px-2 py-1" @change="saveCfg"></label>
      </div>
    </div>

    <div ref="listEl" class="w-full max-w-2xl flex-1 min-h-0 overflow-auto flex flex-col gap-3 py-2">
      <div v-for="(m, i) in msgs" :key="i" class="max-w-[80%] rounded-2xl px-4 py-2 leading-relaxed whitespace-pre-wrap"
        :class="m.role === 'user' ? 'self-end bg-primary/15' : 'self-start bg-card/70'">
        {{ m.content || '…' }}
      </div>
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
