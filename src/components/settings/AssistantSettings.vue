<script setup lang="ts">
/**
 * 设置 → 语音助手：唤醒词（也就是它的名字）、上网查、声音、主人声纹、游戏模式、人设。
 * 助手页右边面板的「小设置」也嵌着这一份，两边读写同一个存档。
 * 每一行都按窄面板（不到 400px 宽）也排得下来写：标签不换行，放不下的输入框换到下一行。
 * 原来摊在助手页顶上，挪进设置页。改完即存（saveAssistantCfg 会同步给正在跑的语音服务）。
 * 用哪个大模型在「大模型」那一栏统一选。
 */
import { onMounted, ref } from 'vue'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { Slider } from '@/components/ui/slider'
import InfoTip from '@/components/InfoTip.vue'
import ResetBtn from '@/components/settings/ResetBtn.vue'
import { ASSISTANT_DEFAULTS, ensureVoiceService, loadAssistantCfg, PERSONAS, resolvePersona, saveAssistantCfg, VOICE_BASE, type AssistantCfg } from '@/lib/assistant'

/** 三个内置音色（Qwen3-TTS 按描述造的参考音，GPT-SoVITS 照着念），默认温柔 */
type VoiceItem = { id: string; name: string; pack: boolean; weights?: boolean }
const voices = ref<VoiceItem[]>([{ id: 'gentle', name: '温柔', pack: false }, { id: 'sweet', name: '甜美', pack: false }, { id: 'lively', name: '活泼', pack: false }])
const packMsg = ref('')

async function refreshVoices() {
  const r = await fetch(`${VOICE_BASE}/voices`).then(r => r.json()).catch(() => null)
  if (r) voices.value = r.voices
}
/** 导入语音包：选一个文件夹（里面放 GPT-SoVITS 的 .ckpt / .pth、参考音 .wav、ref.txt） */
async function importPack() {
  packMsg.value = ''
  const { open } = await import('@tauri-apps/plugin-dialog')
  const dir = await open({ directory: true, title: '选语音包所在的文件夹' })
  if (!dir || Array.isArray(dir)) return
  const err = await ensureVoiceService(cfg.value)
  if (err) { packMsg.value = err; return }
  const r = await fetch(`${VOICE_BASE}/pack`, { method: 'POST', body: JSON.stringify({ path: dir }) }).then(r => r.json()).catch(e => ({ ok: false, error: String(e) }))
  if (!r.ok) { packMsg.value = r.error ?? '导入失败'; return }
  await refreshVoices()
  cfg.value.voice = r.id
  void audition()
}
async function deletePack(id: string) {
  await fetch(`${VOICE_BASE}/pack`, { method: 'POST', body: JSON.stringify({ delete: id }) }).catch(() => {})
  if (cfg.value.voice === id) { cfg.value.voice = D.voice; await save() }
  await refreshVoices()
}

/** 只显示一部分：助手页面板里「基础」「人设」是两个页签；不传就全显示（设置页） */
const props = defineProps<{ part?: 'basic' | 'persona' }>()
const showBasic = props.part !== 'persona'
const showPersona = props.part !== 'basic'
const D = ASSISTANT_DEFAULTS
const REPLY_LANGS = [{ id: 'zh', label: '中文' }, { id: 'en', label: '英文' }] as const
const LLMS = [{ id: 'local', label: '本机' }, { id: 'online', label: '在线' }] as const

const cfg = ref<AssistantCfg>({ ...ASSISTANT_DEFAULTS })
const error = ref('')

/* ── 人设：平时收着，点开才能改。改内置的那段会自动变成「自定义」（内置的原文不动） ── */
const personaOpen = ref(false)
const personaText = () => resolvePersona(cfg.value)
function pickPersona(id: string) {
  cfg.value.personaPreset = id
  // 第一次切到自定义还没写过：拿当前这套当底稿，免得面对一个空框
  if (id === 'custom' && !cfg.value.personaCustom.trim()) cfg.value.personaCustom = (PERSONAS[0]).text
  void save()
}
function editPersona(text: string) {
  cfg.value.personaCustom = text
  cfg.value.personaPreset = 'custom'
  void save()
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

/** 换了音色 / 松开音量、语速滑条：存好以后念一句听听 */
async function audition() {
  await save()
  const err = await ensureVoiceService(cfg.value)
  if (err) { error.value = err; return }
  await fetch(`${VOICE_BASE}/say`, { method: 'POST', body: JSON.stringify({ text: '你好呀！这个声音怎么样？！' }) }).catch(() => {})
}

/* ── 主人声纹：照着念三句，每句录 5 秒，合成一个声纹存在本机（只存特征向量，不存录音） ── */
const LINES = ['小精灵，今天天气怎么样？', '帮我查一下明天要做的事情。', '好了，没事了，你先去休息吧。']
const owner = ref(false)
const enrollStep = ref(-1)      // -1 没在录；0~2 正在录第几句
const recording = ref(false)
const enrollMsg = ref('')

async function enroll(action: string) {
  const r = await fetch(`${VOICE_BASE}/enroll`, { method: 'POST', body: JSON.stringify({ action }) })
  return r.json() as Promise<{ ok: boolean; error?: string; owner?: boolean }>
}
async function startEnroll() {
  enrollMsg.value = ''
  const err = await ensureVoiceService(cfg.value)
  if (err) { enrollMsg.value = err; return }
  await enroll('reset')
  enrollStep.value = 0
}
async function recordLine() {
  recording.value = true
  enrollMsg.value = ''
  const r = await enroll('record').catch(e => ({ ok: false, error: String(e) }))
  recording.value = false
  if (!r.ok) { enrollMsg.value = r.error ?? '录音失败'; return }
  if (enrollStep.value < LINES.length - 1) { enrollStep.value++; return }
  const s = await enroll('save')
  enrollStep.value = -1
  if (!s.ok) { enrollMsg.value = s.error ?? '保存失败'; return }
  owner.value = true
  enrollMsg.value = '录好了'
}
async function clearOwner() {
  await enroll('clear').catch(() => {})
  owner.value = false
  if (cfg.value.ownerOnly) { cfg.value.ownerOnly = false; await save() }
}

onMounted(async () => {
  cfg.value = await loadAssistantCfg()
  void refreshVoices()
  owner.value = !!(await enroll('status').catch(() => null))?.owner
})
</script>

<template>
  <div class="space-y-6">
    <section v-if="showBasic" class="space-y-2">
      <h3 class="text-sm font-medium">基本</h3>
      <div class="rounded-xl border divide-y">
        <div class="flex items-center gap-4 px-4 py-3.5">
          <span class="icon-[lucide--sparkles] w-5 h-5 shrink-0 text-muted-foreground" />
          <div class="flex-1 min-w-0 text-sm whitespace-nowrap flex items-center gap-1.5">中文唤醒词<InfoTip text="喊它的名字就能跟它说话，这也是它对自己的称呼。只能是 2～8 个汉字。右边的开关关掉就不在后台听（中英文都不听），只能点球跟它说话。" /></div>
          <Input v-model="cfg.wakeWord" class="w-28 h-8 min-w-0" :disabled="!cfg.wake" @change="save" />
          <ResetBtn :show="cfg.wakeWord !== D.wakeWord" @reset="cfg.wakeWord = D.wakeWord; save()" />
          <Switch :model-value="cfg.wake" @update:model-value="(v: boolean) => { cfg.wake = v; save() }" />
        </div>
        <div class="flex items-center gap-4 px-4 py-3.5" :class="{ 'opacity-40 pointer-events-none': !cfg.wake }">
          <span class="icon-[lucide--languages] w-5 h-5 shrink-0 text-muted-foreground" />
          <div class="flex-1 min-w-0 text-sm whitespace-nowrap flex items-center gap-1.5">英文唤醒词<InfoTip text="喊英文也能叫醒它，和中文唤醒词同时有效。1～4 个英文单词，比如 Hey Fairy；留空就只用中文的。第一次用会自动下一个 17MB 的英文模型。" /></div>
          <Input v-model="cfg.wakeWordEn" placeholder="Hey Fairy" class="w-28 h-8 min-w-0" @change="save" />
          <ResetBtn :show="cfg.wakeWordEn !== D.wakeWordEn" @reset="cfg.wakeWordEn = D.wakeWordEn; save()" />
        </div>
        <div class="flex items-center gap-4 px-4 py-3.5">
          <span class="icon-[lucide--message-circle] w-5 h-5 shrink-0 text-muted-foreground" />
          <div class="flex-1 min-w-0 text-sm whitespace-nowrap flex items-center gap-1.5">默认回复<InfoTip text="它平时用哪种语言回答你。你用另一种语言问它，它也照这个答，除非你明确让它换。" /></div>
          <div class="flex items-center gap-0.5 rounded-lg border p-0.5 text-sm shrink-0">
            <button v-for="o in REPLY_LANGS" :key="o.id" class="rounded-md px-2.5 py-1 transition-colors"
              :class="cfg.replyLang === o.id ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'"
              @click="cfg.replyLang = o.id; save()">{{ o.label }}</button>
          </div>
        </div>
        <div class="flex items-center gap-4 px-4 py-3.5">
          <span class="icon-[lucide--globe] w-5 h-5 shrink-0 text-muted-foreground" />
          <div class="flex-1 min-w-0 text-sm whitespace-nowrap">允许上网查</div>
          <Switch :model-value="cfg.search" @update:model-value="(v: boolean) => { cfg.search = v; save() }" />
        </div>
      </div>
    </section>

    <section v-if="showBasic" class="space-y-2">
      <h3 class="text-sm font-medium flex items-center gap-1.5">大模型<InfoTip text="本机：用「设置 → 大模型」里选的 Ollama 模型，不花钱、不联网也能聊。在线：填一个 OpenAI 兼容的接口（比如 DeepSeek），更聪明，按用量收费。" /></h3>
      <div class="rounded-xl border divide-y">
        <div class="flex items-center gap-4 px-4 py-3.5">
          <span class="icon-[lucide--cpu] w-5 h-5 shrink-0 text-muted-foreground" />
          <div class="flex-1 min-w-0 text-sm whitespace-nowrap">用哪个</div>
          <div class="flex items-center gap-0.5 rounded-lg border p-0.5 text-sm shrink-0">
            <button v-for="o in LLMS" :key="o.id" class="rounded-md px-2.5 py-1 transition-colors"
              :class="cfg.llm === o.id ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'"
              @click="cfg.llm = o.id; save()">{{ o.label }}</button>
          </div>
        </div>
        <template v-if="cfg.llm === 'online'">
          <div class="flex items-center gap-4 px-4 py-3.5">
            <span class="icon-[lucide--link] w-5 h-5 shrink-0 text-muted-foreground" />
            <div class="flex-1 min-w-0 text-sm whitespace-nowrap">接口地址</div>
            <Input v-model="cfg.apiUrl" placeholder="https://api.deepseek.com" class="w-52 h-8 min-w-0" @change="save" />
          </div>
          <div class="flex items-center gap-4 px-4 py-3.5">
            <span class="icon-[lucide--key-round] w-5 h-5 shrink-0 text-muted-foreground" />
            <div class="flex-1 min-w-0 text-sm whitespace-nowrap">API Key</div>
            <Input v-model="cfg.apiKey" type="password" placeholder="sk-…" class="w-52 h-8 min-w-0" @change="save" />
          </div>
          <div class="flex items-center gap-4 px-4 py-3.5">
            <span class="icon-[lucide--box] w-5 h-5 shrink-0 text-muted-foreground" />
            <div class="flex-1 min-w-0 text-sm whitespace-nowrap">模型</div>
            <Input v-model="cfg.apiModel" placeholder="deepseek-chat" class="w-52 h-8 min-w-0" @change="save" />
          </div>
        </template>
        <div v-else class="flex items-center gap-4 px-4 py-3.5">
          <span class="icon-[lucide--brain] w-5 h-5 shrink-0 text-muted-foreground" />
          <div class="flex-1 min-w-0 text-sm whitespace-nowrap flex items-center gap-1.5">先想一想再回答<InfoTip text="回答前先在心里想一遍：该查的去查、该算的去算，答得更准。每句话大概慢一两秒。" /></div>
          <Switch :model-value="cfg.think" @update:model-value="(v: boolean) => { cfg.think = v; save() }" />
        </div>
      </div>
    </section>

    <section v-if="showPersona" class="space-y-2">
      <h3 class="text-sm font-medium">音色</h3>
      <div class="rounded-xl border divide-y">
        <div class="px-4 py-3.5 space-y-2.5">
          <div class="flex items-center gap-4">
            <span class="icon-[lucide--audio-lines] w-5 h-5 shrink-0 text-muted-foreground" />
            <div class="flex-1 min-w-0 text-sm whitespace-nowrap flex items-center gap-1.5">音色<InfoTip text="点一下就试听。导入的语音包会用它自带的模型念，最像原声。" /></div>
            <button class="rounded-md border px-2.5 py-1 text-xs hover:bg-muted" @click="importPack">导入语音包</button>
            <ResetBtn :show="cfg.voice !== D.voice" @reset="cfg.voice = D.voice; audition()" />
          </div>
          <div class="flex flex-wrap gap-1.5 pl-9">
            <div v-for="v in voices" :key="v.id" class="group relative">
              <button class="rounded-md border px-2.5 py-1 text-sm transition-colors"
                :class="cfg.voice === v.id ? 'bg-muted text-foreground border-foreground/20' : 'text-muted-foreground hover:text-foreground'"
                @click="cfg.voice = v.id; audition()">{{ v.name }}</button>
              <button v-if="v.pack" class="absolute -top-1.5 -right-1.5 size-4 rounded-full bg-muted text-muted-foreground hover:text-red-400 hidden group-hover:grid place-items-center"
                title="删掉这个语音包" @click="deletePack(v.id)"><span class="icon-[lucide--x] w-3 h-3" /></button>
            </div>
          </div>
          <p v-if="packMsg" class="pl-9 text-xs text-red-400">{{ packMsg }}</p>
        </div>
        <div class="flex items-center gap-4 px-4 py-3.5">
          <span class="icon-[lucide--volume-2] w-5 h-5 shrink-0 text-muted-foreground" />
          <div class="flex-1 min-w-0 text-sm whitespace-nowrap">音量</div>
          <Slider :model-value="[cfg.volume]" :min="0.3" :max="3" :step="0.1" class="w-48 max-w-[40%]"
            @update:model-value="(v) => { if (v) cfg.volume = v[0] }" @value-commit="audition" />
          <span class="w-12 text-right text-sm tabular-nums text-muted-foreground">{{ Math.round(cfg.volume * 100) }}%</span>
          <ResetBtn :show="cfg.volume !== D.volume" @reset="cfg.volume = D.volume; audition()" />
        </div>
        <div class="flex items-center gap-4 px-4 py-3.5">
          <span class="icon-[lucide--gauge] w-5 h-5 shrink-0 text-muted-foreground" />
          <div class="flex-1 min-w-0 text-sm whitespace-nowrap">语速</div>
          <Slider :model-value="[cfg.speed]" :min="0.7" :max="1.5" :step="0.05" class="w-48 max-w-[40%]"
            @update:model-value="(v) => { if (v) cfg.speed = v[0] }" @value-commit="audition" />
          <span class="w-12 text-right text-sm tabular-nums text-muted-foreground">{{ cfg.speed.toFixed(2) }}×</span>
          <ResetBtn :show="cfg.speed !== D.speed" @reset="cfg.speed = D.speed; audition()" />
        </div>
      </div>
    </section>

    <section v-if="showBasic" class="space-y-2">
      <h3 class="text-sm font-medium flex items-center gap-1.5">声纹<InfoTip text="录一次你的声音（照着念三句话），它就认得你了：可以只听你的，别人说话、别人喊它都不理；它说话时你一开口就能打断它。存在本机的只是声音特征，不存录音。" /></h3>
      <div class="rounded-xl border divide-y">
        <div class="flex items-center gap-4 px-4 py-3.5">
          <span class="icon-[lucide--fingerprint] w-5 h-5 shrink-0 text-muted-foreground" />
          <div class="flex-1 min-w-0">
            <div class="text-sm">主人的声音</div>
            <div class="text-xs text-muted-foreground">{{ owner ? '已录入' : '还没录' }}{{ enrollMsg ? ` · ${enrollMsg}` : '' }}</div>
          </div>
          <button v-if="owner && enrollStep < 0" class="text-xs text-muted-foreground hover:text-red-400" @click="clearOwner">删掉</button>
          <button v-if="enrollStep < 0" class="rounded-md border px-3 py-1 text-sm hover:bg-muted" @click="startEnroll">{{ owner ? '重新录' : '录入' }}</button>
        </div>
        <div v-if="enrollStep >= 0" class="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3.5 bg-muted/20">
          <div class="w-full flex items-baseline gap-2">
            <span class="text-xs text-muted-foreground tabular-nums">{{ enrollStep + 1 }}/3</span>
            <span class="text-base">「{{ LINES[enrollStep] }}」</span>
          </div>
          <div class="flex-1" />
          <button class="rounded-md px-3 py-1 text-sm" :class="recording ? 'bg-red-500/20 text-red-400' : 'bg-primary/80 text-primary-foreground'"
            :disabled="recording" @click="recordLine">{{ recording ? '正在听，照着念…' : '开始念（5 秒）' }}</button>
          <button class="text-xs text-muted-foreground hover:text-foreground" :disabled="recording" @click="enrollStep = -1">取消</button>
        </div>
        <div class="flex items-center gap-4 px-4 py-3.5" :class="{ 'opacity-40 pointer-events-none': !owner }">
          <span class="icon-[lucide--user-check] w-5 h-5 shrink-0 text-muted-foreground" />
          <div class="flex-1 min-w-0 text-sm whitespace-nowrap flex items-center gap-1.5">只听主人的<InfoTip text="别人喊唤醒词、别人说话，它都不理。" /></div>
          <Switch :model-value="cfg.ownerOnly" @update:model-value="(v: boolean) => { cfg.ownerOnly = v; save() }" />
        </div>
        <div class="flex items-center gap-4 px-4 py-3.5" :class="{ 'opacity-40 pointer-events-none': !owner }">
          <span class="icon-[lucide--hand] w-5 h-5 shrink-0 text-muted-foreground" />
          <div class="flex-1 min-w-0 text-sm whitespace-nowrap flex items-center gap-1.5">说话时可以打断它<InfoTip text="它在说话或念文章时，你直接开口，它就停下来听你说。靠声音认出是你，所以它自己的声音不会把自己打断。" /></div>
          <Switch :model-value="cfg.bargeIn" @update:model-value="(v: boolean) => { cfg.bargeIn = v; save() }" />
        </div>
      </div>
    </section>

    <section v-if="showBasic" class="space-y-2">
      <h3 class="text-sm font-medium">游戏模式</h3>
      <div class="rounded-xl border divide-y">
        <div class="flex items-center gap-4 px-4 py-3.5">
          <span class="icon-[lucide--gamepad-2] w-5 h-5 shrink-0 text-muted-foreground" />
          <div class="flex-1 min-w-0 text-sm whitespace-nowrap flex items-center gap-1.5">全屏游戏时歇着<InfoTip text="全屏玩游戏时，助手不听唤醒词、不回话，不占显卡。浏览器和播放器全屏看视频不算。" /></div>
          <Switch :model-value="cfg.gameMode" @update:model-value="(v: boolean) => { cfg.gameMode = v; save() }" />
        </div>
        <div class="px-4 py-3.5 space-y-2" :class="{ 'opacity-40 pointer-events-none': !cfg.gameMode }">
          <div class="flex items-center gap-4">
            <span class="icon-[lucide--list-plus] w-5 h-5 shrink-0 text-muted-foreground" />
            <div class="flex-1 min-w-0 text-sm whitespace-nowrap flex items-center gap-1.5">这些程序也算游戏<InfoTip text="不是全屏、但开着就想让助手歇着的程序，填程序文件名，用逗号隔开。" /></div>
          </div>
          <Input :model-value="cfg.gameApps.join(', ')" placeholder="例如 LeagueClient.exe, steam.exe" class="w-full h-8"
            @change="(e: Event) => { cfg.gameApps = (e.target as HTMLInputElement).value.split(/[,，\s]+/).filter(Boolean); save() }" />
        </div>
      </div>
    </section>

    <section v-if="showPersona" class="space-y-2">
      <h3 class="text-sm font-medium flex items-center gap-1.5">人设<InfoTip text="它说话的性格。内置几套可以直接选；改了内容就成了「自定义」，再切回内置的，自定义的那份也还留着。{name} 会换成唤醒词，{now} 会换成现在的日期和时间。" /></h3>
      <div class="rounded-xl border divide-y">
        <div class="flex flex-wrap items-center gap-2 px-4 py-3">
          <button v-for="p in [...PERSONAS, { id: 'custom', label: '自定义', text: '' }]" :key="p.id"
            class="rounded-md border px-2.5 py-1 text-sm transition-colors"
            :class="cfg.personaPreset === p.id ? 'bg-muted text-foreground border-foreground/20' : 'text-muted-foreground hover:text-foreground'"
            @click="pickPersona(p.id)">{{ p.label }}</button>
          <div class="flex-1" />
          <ResetBtn :show="cfg.personaPreset !== D.personaPreset" @reset="pickPersona(D.personaPreset)" />
          <button class="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1" @click="personaOpen = !personaOpen">
            {{ personaOpen ? '收起' : '查看 / 修改' }}
            <span class="icon-[lucide--chevron-down] w-3.5 h-3.5 transition-transform" :class="{ 'rotate-180': personaOpen }" />
          </button>
        </div>
        <div v-if="personaOpen" class="p-3">
          <textarea :value="personaText()" rows="8"
            class="w-full rounded-lg bg-transparent px-1 text-xs font-mono leading-relaxed outline-none resize-y"
            @change="(e) => editPersona((e.target as HTMLTextAreaElement).value)" />
        </div>
      </div>
    </section>

    <p v-if="error" class="text-xs text-red-400">{{ error }}</p>
  </div>
</template>
