<script setup lang="ts">
import { ref, watch, onMounted, computed } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { localModel, checkLocalModel, downloadLocalModel, removeLocalModel, LOCAL_MODEL_BYTES } from '@/lib/bergamot'
import {
  ENGINES, engineLabel, loadChain, translateRacing, loadRace, saveRace, isFreeToRace,
  type ChainFailure, type RaceConfig,
} from '@/lib/translateChain'
import { VueDraggable } from 'vue-draggable-plus'
import { LazyStore } from '@tauri-apps/plugin-store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useI18n } from '@/i18n'

const { t } = useI18n()

const store = new LazyStore('settings.json')
const settingsLoaded = ref(false)

// ─── 类型 ─────────────────────────────────────────────

interface AiConfig {
  api_key: string
  api_url: string
  model: string
}

const aiEngines = [
  { id: 'openai', label: 'OpenAI' },
  { id: 'claude', label: 'Claude' },
  { id: 'gemini', label: 'Gemini' },
  { id: 'deepseek', label: 'DeepSeek' },
  { id: 'qwen', label: '通义千问' },
  { id: 'zhipu', label: '智谱 GLM' },
  { id: 'yi', label: '零一万物' },
  { id: 'moonshot', label: 'Moonshot' },
  { id: 'groq', label: 'Groq' },
  { id: 'custom', label: 'AI 自定义接口' },
]

// 每个引擎可选的模型列表（第一个为默认值）
const engineModels: Record<string, string[]> = {
  openai: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1-nano'],
  claude: ['claude-sonnet-4-20250514', 'claude-haiku-4-5-20251001', 'claude-opus-4-20250514'],
  gemini: ['gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-2.5-pro'],
  deepseek: ['deepseek-chat', 'deepseek-reasoner'],
  qwen: ['qwen-plus', 'qwen-turbo', 'qwen-max', 'qwen-long'],
  zhipu: ['glm-4-flash', 'glm-4-plus', 'glm-4-long'],
  yi: ['yi-lightning', 'yi-large', 'yi-medium'],
  moonshot: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
  groq: ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile', 'gemma2-9b-it'],
}

const defaultModels: Record<string, string> = Object.fromEntries(
  Object.entries(engineModels).map(([k, v]) => [k, v[0]])
)

// ─── State ────────────────────────────────────────────

/** 引擎优先级链:从上往下试,谁成功用谁。见 lib/translateChain */
const chain = ref<string[]>([])
/** 设置弹窗里正展开配置的引擎(AI 或本机离线);null = 都收着 */
const configOpen = ref<string | null>(null)
/** AI 配置表单绑定的引擎。展开哪个 AI 引擎的配置它就指向哪个 */
const aiEngine = ref('openai')
/** 最近一次翻译:用了谁、它前面谁失败了 */
const lastUsed = ref<string | null>(null)
const lastFailed = ref<ChainFailure[]>([])

/*
  兜底:和链**同时**出发,谁先回来算谁的。和「排序」是两回事 ——
  排序是前面的不行才轮到后面的,那要先干等一次失败。
  详见 lib/translateChain 里那一大段。
*/
const race = ref<RaceConfig>({ local: false, localAi: false })
/**
 * 「AI 自定义接口」现在指的是不是本机。
 *
 * 不是的话那个开关就点不动 —— 兜底是**每一次翻译都发**的，
 * 让它指着线上的接口，等于给「顺手打开的一个开关」接了一根按次计费的水管。
 */
const customIsLocal = computed(() => isFreeToRace('custom', aiConfigs.value))

const defaultAiConfig = (): AiConfig => ({ api_key: '', api_url: '', model: '' })
const aiConfigs = ref<Record<string, AiConfig>>(
  Object.fromEntries(aiEngines.map(e => [e.id, defaultAiConfig()]))
)
const aiValidated = ref<Record<string, boolean | null>>(
  Object.fromEntries(aiEngines.map(e => [e.id, null]))
)

const inputText = ref('')
const outputText = ref('')
const detectedLang = ref<string | null>(null)
const loading = ref(false)
const copied = ref(false)
const speaking = ref(false)
const showSettingsDialog = ref(false)
/** 设置弹窗停在哪一页。每次开都回到「引擎」—— 那是常来改的那一页 */
const settingsTab = ref<'chain' | 'race'>('chain')
const validating = ref<string | null>(null)

// 动态模型列表
const fetchedModels = ref<Record<string, string[]>>({})
const fetchingModels = ref(false)


// ─── 计算属性 ─────────────────────────────────────────

const chainLabel = computed(() => chain.value.map(engineLabel).join(' → '))
/** 还没进链的引擎,设置里列成一排可以点着加 */
const available = computed(() => ENGINES.filter(e => !chain.value.includes(e.id)))
const configKind = computed(() => ENGINES.find(e => e.id === configOpen.value)?.kind ?? null)

/** 链里每个引擎的小状态:AI 没配 key / 离线模型没下,都标一下,免得排上去了却一直被跳过 */
function engineWarn(id: string): string | null {
  const kind = ENGINES.find(e => e.id === id)?.kind
  if (kind === 'ai' && !aiConfigs.value[id]?.api_key) return t('translate.aiUnconfigured')
  if (kind === 'local' && localModel.status !== 'ready') return t('translate.localMissing')
  return null
}

// ─── Load / Save ──────────────────────────────────────

async function loadSettings() {
  await store.init()
  chain.value = await loadChain()
  race.value = await loadRace()
  const saved = await store.get<Record<string, AiConfig>>('translate_ai_configs')
  if (saved) {
    for (const key of Object.keys(aiConfigs.value)) {
      if (saved[key]) aiConfigs.value[key] = { ...aiConfigs.value[key], ...saved[key] }
    }
  }
  const savedValidation = await store.get<Record<string, boolean | null>>('translate_ai_validated')
  if (savedValidation) {
    for (const key of Object.keys(aiValidated.value)) {
      if (key in savedValidation) aiValidated.value[key] = savedValidation[key]
    }
  }
  settingsLoaded.value = true
}

async function saveSettings() {
  await saveRace(race.value)
  await store.set('translate_chain', chain.value)
  await store.set('translate_ai_configs', aiConfigs.value)
  await store.set('translate_ai_validated', aiValidated.value)
  await store.save()
}

onMounted(async () => { await loadSettings(); void checkLocalModel() })

const localPct = computed(() => Math.round(localModel.progress * 100))
const localSizeMb = Math.round(LOCAL_MODEL_BYTES / 1024 / 1024)

// ─── 翻译逻辑 ─────────────────────────────────────────

let debounceTimer: ReturnType<typeof setTimeout> | null = null

function onInputChange() {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    if (inputText.value.trim()) doTranslate()
    else { outputText.value = ''; detectedLang.value = null }
  }, 500)
}

async function doTranslate() {
  if (!inputText.value.trim()) return
  if (speaking.value) {
    window.speechSynthesis.cancel()
    speaking.value = false
  }
  loading.value = true
  try {
    const r = await translateRacing(inputText.value, detectTargetLang(inputText.value),
      { chain: chain.value, aiConfigs: aiConfigs.value, race: race.value })
    outputText.value = r.text
    detectedLang.value = r.detected
    lastUsed.value = r.engine
    lastFailed.value = r.failed
  } catch (e) {
    outputText.value = `翻译失败: ${e}`
  } finally {
    loading.value = false
  }
}

function detectTargetLang(text: string): 'zh' | 'en' {
  const chineseRatio = (text.match(/[\u4e00-\u9fff]/g) || []).length / text.length
  return chineseRatio > 0.3 ? 'en' : 'zh'
}

function swapTexts() {
  const tmp = outputText.value
  outputText.value = ''
  inputText.value = tmp
  if (tmp.trim()) doTranslate()
}

async function copyResult() {
  if (!outputText.value) return
  await navigator.clipboard.writeText(outputText.value)
  copied.value = true
  setTimeout(() => (copied.value = false), 1500)
}

// ─── TTS 朗读 ─────────────────────────────────────────

const speakingInput = ref(false)

function speak(text: string, lang: string, isInput: boolean) {
  const speakingRef = isInput ? speakingInput : speaking
  if (speakingRef.value) {
    window.speechSynthesis.cancel()
    speakingRef.value = false
    return
  }

  window.speechSynthesis.cancel()
  speakingInput.value = false
  speaking.value = false

  const utterance = new SpeechSynthesisUtterance(text)
  utterance.lang = lang
  utterance.rate = 0.9
  utterance.onstart = () => { speakingRef.value = true }
  utterance.onend = () => { speakingRef.value = false }
  utterance.onerror = () => { speakingRef.value = false }
  window.speechSynthesis.speak(utterance)
}

function speakInput() {
  if (!inputText.value) return
  // 输入区语言：与目标语言相反
  const tgt = detectTargetLang(inputText.value)
  const lang = tgt === 'zh' ? 'en-US' : 'zh-CN'
  speak(inputText.value, lang, true)
}

function speakOutput() {
  if (!outputText.value) return
  const tgt = detectTargetLang(inputText.value)
  const lang = tgt === 'zh' ? 'zh-CN' : 'en-US'
  speak(outputText.value, lang, false)
}

// ─── 动态获取模型列表 ──────────────────────────────────

async function fetchModels(engineId: string) {
  if (engineId === 'custom') return
  const cfg = aiConfigs.value[engineId]
  if (!cfg?.api_key) return
  fetchingModels.value = true
  try {
    const models = await invoke<string[]>('list_models', {
      request: {
        engine: engineId,
        api_key: cfg.api_key,
        api_url: cfg.api_url || null,
      }
    })
    if (models.length > 0) {
      fetchedModels.value[engineId] = models
    }
  } catch {
    // 获取失败时静默回退到静态列表
  } finally {
    fetchingModels.value = false
  }
}

// ─── AI 连接测试 ──────────────────────────────────────

async function testAiConnection(engineId: string) {
  const cfg = aiConfigs.value[engineId]
  if (!cfg?.api_key) { aiValidated.value[engineId] = false; return }
  validating.value = engineId
  try {
    await invoke<{ text: string }>('translate', {
      request: {
        text: 'hello',
        source_lang: 'en',
        target_lang: 'zh',
        engine: engineId,
        ai_config: {
          api_key: cfg.api_key,
          api_url: cfg.api_url || null,
          model: cfg.model || null,
        },
      }
    })
    aiValidated.value[engineId] = true
    // 验证成功后自动获取模型列表
    fetchModels(engineId)
  } catch {
    aiValidated.value[engineId] = false
  } finally {
    validating.value = null
    saveSettings()
  }
}

// ─── 设置保存 ─────────────────────────────────────────

let saveTimer: ReturnType<typeof setTimeout> | null = null
function debounceSave() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => { if (settingsLoaded.value) saveSettings() }, 500)
}

watch(chain, () => {
  if (settingsLoaded.value) {
    saveSettings()
    if (inputText.value.trim()) doTranslate()
  }
}, { deep: true })

// 兜底和链一样是「改完就该生效」的东西 —— 这弹窗没有保存按钮，不存就是白改
watch(race, () => {
  if (settingsLoaded.value) {
    saveSettings()
    if (inputText.value.trim()) doTranslate()
  }
}, { deep: true })

function addEngine(id: string) {
  if (!chain.value.includes(id)) chain.value = [...chain.value, id]
  // 加进来的是要配置的那种,顺手把它的配置展开
  if (ENGINES.find(e => e.id === id)?.kind !== 'free') toggleConfig(id, true)
}
function removeEngine(id: string) {
  chain.value = chain.value.filter(e => e !== id)
  if (configOpen.value === id) configOpen.value = null
}
function toggleConfig(id: string, forceOpen = false) {
  if (!forceOpen && configOpen.value === id) { configOpen.value = null; return }
  configOpen.value = id
  if (ENGINES.find(e => e.id === id)?.kind === 'ai') aiEngine.value = id
}
</script>

<template>
  <div class="h-full w-full flex flex-col p-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
    <div class="flex-1 flex flex-col overflow-hidden max-w-3xl mx-auto w-full gap-3">

      <!-- 顶部栏 -->
      <div class="flex items-center justify-between shrink-0">
        <div class="flex items-center gap-2.5">
          <span class="text-sm text-muted-foreground">{{ t('translate.currentEngine') }}</span>
          <span class="text-sm font-medium px-3 py-1 rounded-md bg-muted truncate max-w-[26rem]" :title="chainLabel">{{ chainLabel || t('translate.chainEmpty') }}</span>
          <span v-if="lastUsed && lastFailed.length" class="text-sm text-amber-400 truncate"
            :title="lastFailed.map(f => engineLabel(f.engine) + '：' + f.error).join('\n')">
            {{ t('translate.fellBack', { failed: lastFailed.map(f => engineLabel(f.engine)).join('、'), engine: engineLabel(lastUsed) }) }}
          </span>
        </div>
        <Button variant="ghost" size="sm" :title="t('translate.settings')"
          @click="settingsTab = 'chain'; showSettingsDialog = true">
          <span class="icon-[lucide--settings] w-5 h-5" />
        </Button>
      </div>

      <!-- 翻译界面 -->
      <div class="flex-1 min-h-0 flex flex-col gap-3">
        <!-- 输入区 -->
        <div class="flex-1 relative group">
          <div class="absolute top-3 left-3 text-xs text-muted-foreground/60 pointer-events-none select-none">
            {{ detectedLang ? `检测: ${detectedLang}` : '自动检测语言' }}
          </div>
          <Textarea
            v-model="inputText"
            @input="onInputChange"
            :placeholder="t('translate.inputPlaceholder')"
            class="h-full resize-none rounded-xl pt-8 pb-3 leading-relaxed"
          />
          <div v-if="inputText" class="absolute top-3 right-3 flex items-center gap-1">
            <Button
              variant="ghost" size="icon-sm"
              @click="speakInput"
              :title="speakingInput ? t('translate.stopSpeaking') : t('translate.speakInput')"
              class="text-muted-foreground/40 hover:text-foreground"
            >
              <span :class="speakingInput ? 'icon-[lucide--square]' : 'icon-[lucide--volume-2]'" class="w-3.5 h-3.5" />
            </Button>
            <Button
              variant="ghost" size="icon-sm"
              @click="inputText = ''; outputText = ''; detectedLang = null"
              class="text-muted-foreground/40 hover:text-foreground"
            >
              <span class="icon-[lucide--x] w-3.5 h-3.5" />
            </Button>
          </div>
        </div>

        <!-- 中间操作栏 -->
        <div class="flex items-center justify-center gap-3">
          <Button variant="outline" size="icon-sm" @click="swapTexts" :title="t('translate.swap')">
            <span class="icon-[lucide--arrow-down-up] w-4 h-4" />
          </Button>
          <div v-if="loading" class="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span class="icon-[lucide--loader-2] w-3.5 h-3.5 animate-spin" />
            {{ t('translate.translating') }}
          </div>
        </div>

        <!-- 输出区 -->
        <div class="flex-1 relative group">
          <!--
            这一版的译文是谁给的。配了兜底之后这件事**不再是可以推断的** ——
            链里排第一的和两个兜底同时在跑,谁先回来算谁的,所以每次都可能不一样。
            摆在结果框右上角:看结果的时候眼睛正好在那儿。
          -->
          <span v-if="outputText && lastUsed && !loading"
            class="absolute top-2.5 right-3 z-10 px-2 py-0.5 rounded-md text-[11px]
                   bg-background/80 border border-border text-muted-foreground backdrop-blur-sm">
            {{ engineLabel(lastUsed) }}
          </span>
          <Textarea
            :model-value="outputText"
            readonly
            :placeholder="t('translate.resultPlaceholder')"
            class="h-full resize-none rounded-xl bg-muted/30 leading-relaxed"
          />
          <div v-if="outputText" class="absolute bottom-3 right-3 flex items-center gap-1.5">
            <Button
              variant="outline" size="icon-sm"
              @click="speakOutput"
              :title="speaking ? t('translate.stopSpeaking') : t('translate.speakResult')"
            >
              <span :class="speaking ? 'icon-[lucide--square]' : 'icon-[lucide--volume-2]'" class="w-3.5 h-3.5" />
            </Button>
            <Button
              variant="outline" size="sm"
              @click="copyResult"
            >
              <span :class="copied ? 'icon-[lucide--check]' : 'icon-[lucide--copy]'" class="w-3 h-3" />
              {{ copied ? '已复制' : '复制' }}
            </Button>
          </div>
        </div>
      </div>

    </div>
  </div>

  <!--
    ==================== 设置弹窗 ====================

    ⚠ 点背景关闭走的是 **mousedown**,不是 click。

    弹窗是上下居中的,内容一换高度就变,整张卡片跟着上下挪。用 click 的话:
    在页签上按下 → 内容换掉、卡片位移 → 松手时鼠标底下已经不是那颗页签了,
    浏览器就把 click 派发到两者的**共同祖先**,也就是这层背景 ——
    `.self` 命中,弹窗当场关掉。现象是「点第二个页签就把设置关了」。
    拖引擎排序时松手松到卡片外面,也是同一个坑。
    mousedown 只认按下那一刻的目标,不受后面的重排影响。
  -->
  <Transition enter-active-class="transition-opacity duration-150" enter-from-class="opacity-0" leave-active-class="transition-opacity duration-150" leave-to-class="opacity-0">
    <div
      v-if="showSettingsDialog"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      @mousedown.self="showSettingsDialog = false"
    >
      <div class="w-[480px] max-h-[80vh] rounded-xl shadow-2xl bg-popover border flex flex-col">
        <!-- 头部 -->
        <div class="flex items-center justify-between p-5 pb-0">
          <h3 class="font-medium">{{ t('translate.settings') }}</h3>
          <Button variant="ghost" size="icon-sm" @click="showSettingsDialog = false">
            <span class="icon-[lucide--x] w-4 h-4" />
          </Button>
        </div>

        <!--
          排序和兜底分成两页。

          它们**不是一件事**:排序是「前面的不行才轮到后面」,兜底是「同时跑,谁快用谁」。
          原来上下叠着,读的人一路扫下来,几乎一定把第二块当成第一块的延续 ——
          所以那两段说明得越写越长,才拦得住这个误会。
          分成两页之后,那个误会从版面上就不成立了,说明也就能收回一句话。
        -->
        <Tabs v-model="settingsTab" class="flex-1 min-h-0 flex flex-col">
          <TabsList class="mx-5 mt-4">
            <TabsTrigger value="chain">{{ t('translate.chain') }}</TabsTrigger>
            <TabsTrigger value="race">{{ t('translate.race') }}</TabsTrigger>
          </TabsList>

        <!-- 内容 -->
        <div class="flex-1 overflow-y-auto p-5 space-y-5">

          <!-- 引擎顺序:拖动排序,从上往下试 -->
          <div v-if="settingsTab === 'chain'" class="space-y-2">
            <p class="text-xs text-muted-foreground leading-relaxed">{{ t('translate.chainHint') }}</p>
            <VueDraggable v-model="chain" handle=".chain-grip" :animation="180" :force-fallback="true" ghost-class="opacity-30"
              class="rounded-lg border divide-y overflow-hidden">
              <div v-for="(id, i) in chain" :key="id" class="flex items-center gap-2 px-2.5 py-2 bg-background">
                <span class="chain-grip icon-[lucide--grip-vertical] w-4 h-4 shrink-0 text-muted-foreground cursor-grab active:cursor-grabbing" />
                <span class="w-4 text-xs text-muted-foreground tabular-nums text-center">{{ i + 1 }}</span>
                <span class="text-sm flex-1 truncate">{{ engineLabel(id) }}</span>
                <span v-if="engineWarn(id)" class="text-xs text-amber-400 shrink-0">{{ engineWarn(id) }}</span>
                <Button v-if="ENGINES.find(e => e.id === id)?.kind !== 'free'" variant="ghost" size="icon-sm"
                  :title="t('translate.configure')" @click="toggleConfig(id)">
                  <span class="icon-[lucide--settings-2] w-3.5 h-3.5" :class="configOpen === id ? 'text-foreground' : 'text-muted-foreground'" />
                </Button>
                <Button variant="ghost" size="icon-sm" :title="t('translate.removeEngine')" @click="removeEngine(id)">
                  <span class="icon-[lucide--x] w-3.5 h-3.5 text-muted-foreground" />
                </Button>
              </div>
            </VueDraggable>
            <p v-if="!chain.length" class="text-xs text-amber-400">{{ t('translate.chainEmpty') }}</p>
          </div>

          <!-- 兜底:和链同时跑,谁快用谁。只收跑在本机的东西,理由见 lib/translateChain -->
          <div v-if="settingsTab === 'race'" class="space-y-2">
            <p class="text-xs text-muted-foreground leading-relaxed">{{ t('translate.raceHint') }}</p>
            <div class="rounded-lg border divide-y overflow-hidden">
              <!-- 本地离线包就一个（Bergamot），所以是开关不是下拉 -->
              <div class="flex items-center gap-2 px-2.5 py-2 bg-background">
                <span class="icon-[lucide--hard-drive] w-4 h-4 shrink-0 text-muted-foreground" />
                <span class="text-sm flex-1 truncate">{{ t('translate.raceLocal') }}</span>
                <span v-if="race.local && localModel.status !== 'ready'"
                  class="text-xs text-amber-400 shrink-0">{{ t('translate.localMissing') }}</span>
                <Switch :model-value="race.local" @update:model-value="race.local = $event" />
              </div>
              <!-- 只有指向本机的「AI 自定义接口」能进来。在线的一概不给选，理由见 raceHint -->
              <div class="flex items-center gap-2 px-2.5 py-2 bg-background"
                :class="customIsLocal ? '' : 'opacity-50'">
                <span class="icon-[lucide--sparkles] w-4 h-4 shrink-0 text-muted-foreground" />
                <span class="text-sm flex-1 truncate">{{ t('translate.raceAi') }}</span>
                <span v-if="!customIsLocal" class="text-xs text-muted-foreground shrink-0">
                  {{ t('translate.raceAiNotLocal') }}
                </span>
                <Switch :model-value="race.localAi" :disabled="!customIsLocal"
                  @update:model-value="race.localAi = $event" />
              </div>
            </div>
          </div>

          <!-- 没进链的引擎,点一下加到末尾 -->
          <div v-if="settingsTab === 'chain' && available.length" class="space-y-2">
            <p class="text-xs text-muted-foreground uppercase tracking-wider font-medium">{{ t('translate.addEngine') }}</p>
            <div class="flex flex-wrap gap-1.5">
              <button v-for="e in available" :key="e.id" @click="addEngine(e.id)"
                class="h-7 px-2.5 rounded-md border border-border text-xs transition-colors hover:bg-muted flex items-center gap-1">
                <span class="icon-[lucide--plus] w-3 h-3" />{{ e.label }}
              </button>
            </div>
          </div>

          <!-- 本机离线模型:不随安装包走,这里按需下 -->
          <div v-if="settingsTab === 'chain' && configOpen === 'local'" class="rounded-lg border p-3 space-y-2">
            <div class="flex items-center justify-between text-sm">
              <span>{{ t('translate.localModel') }}</span>
              <span class="text-xs" :class="localModel.status === 'ready' ? 'text-emerald-500' : localModel.status === 'error' ? 'text-red-500' : 'text-muted-foreground'">
                {{ localModel.status === 'ready' ? t('translate.localReady')
                  : localModel.status === 'downloading' ? t('translate.localDownloading', { pct: localPct })
                  : localModel.status === 'error' ? t('translate.localFailed')
                  : t('translate.localMissing') }}
              </span>
            </div>
            <p class="text-xs text-muted-foreground leading-relaxed">{{ t('translate.localDesc', { mb: localSizeMb }) }}</p>
            <div v-if="localModel.status === 'downloading'" class="h-1.5 rounded-full bg-muted overflow-hidden">
              <div class="h-full bg-primary transition-[width] duration-300" :style="{ width: localPct + '%' }" />
            </div>
            <div class="flex gap-2">
              <Button v-if="localModel.status !== 'ready'" size="sm" :disabled="localModel.status === 'downloading'" @click="downloadLocalModel()">
                {{ localModel.status === 'downloading' ? t('translate.localDownloading', { pct: localPct }) : t('translate.localDownload') }}
              </Button>
              <Button v-else variant="outline" size="sm" @click="removeLocalModel()">{{ t('translate.localRemove') }}</Button>
            </div>
            <p v-if="localModel.error" class="text-xs text-red-500 wrap-break-word">{{ localModel.error }}</p>
          </div>

          <!-- AI 引擎配置(展开了哪个就显示哪个的) -->
          <div v-if="settingsTab === 'chain' && configOpen && configKind === 'ai'" class="space-y-4">
            <!-- 当前 AI 配置表单 -->
            <div class="space-y-3 p-4 border border-border rounded-lg bg-muted/10">
              <div class="flex items-center justify-between">
                <p class="text-sm font-medium">{{ aiEngines.find(e => e.id === aiEngine)?.label }} 配置</p>
                <!-- 验证状态标签 -->
                <span v-if="aiValidated[aiEngine] === true" class="text-xs text-green-400 flex items-center gap-1">
                  <span class="icon-[lucide--check-circle] w-3 h-3" /> {{ t('translate.verified') }}
                </span>
                <span v-else-if="aiValidated[aiEngine] === false" class="text-xs text-red-400 flex items-center gap-1">
                  <span class="icon-[lucide--x-circle] w-3 h-3" /> {{ t('translate.verifyFailed') }}
                </span>
              </div>

              <div class="space-y-2">
                <Input
                  v-model="aiConfigs[aiEngine].api_key"
                  @input="debounceSave(); aiValidated[aiEngine] = null"
                  type="password"
                  placeholder="API Key *"
                />

                <!-- 自定义接口：显示端点 + 模型名输入 -->
                <template v-if="aiEngine === 'custom'">
                  <Input
                    v-model="aiConfigs[aiEngine].api_url"
                    @input="debounceSave(); aiValidated[aiEngine] = null"
                    type="text"
                    :placeholder="t('translate.endpoint')"
                  />
                  <Input
                    v-model="aiConfigs[aiEngine].model"
                    @input="debounceSave(); aiValidated[aiEngine] = null"
                    type="text"
                    :placeholder="t('translate.modelName')"
                  />
                </template>

                <!-- 预设引擎：模型下拉选择 -->
                <template v-else>
                  <div class="flex items-center gap-1.5">
                    <Select
                      :model-value="aiConfigs[aiEngine].model || defaultModels[aiEngine] || ''"
                      @update:model-value="(v) => { aiConfigs[aiEngine].model = String(v); debounceSave(); aiValidated[aiEngine] = null }"
                      class="flex-1"
                    >
                      <SelectTrigger>
                        <SelectValue :placeholder="t('translate.pickModel')" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem v-for="m in (fetchedModels[aiEngine] ?? engineModels[aiEngine] ?? [])" :key="m" :value="m">{{ m }}</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      :disabled="!aiConfigs[aiEngine]?.api_key || fetchingModels"
                      @click="fetchModels(aiEngine)"
                      :title="fetchedModels[aiEngine] ? t('translate.refreshModels') : t('translate.fetchModels')"
                    >
                      <span :class="fetchingModels ? 'animate-spin' : ''" class="icon-[lucide--refresh-cw] w-3.5 h-3.5" />
                    </Button>
                  </div>
                  <p v-if="fetchedModels[aiEngine]" class="text-xs text-muted-foreground">
                    已从 API 获取 {{ fetchedModels[aiEngine].length }} 个模型
                  </p>
                </template>
              </div>

              <!-- 测试连接 -->
              <Button
                variant="outline"
                size="sm"
                :disabled="!aiConfigs[aiEngine]?.api_key || validating === aiEngine"
                @click="testAiConnection(aiEngine)"
              >
                <span v-if="validating === aiEngine" class="icon-[lucide--loader-2] w-3.5 h-3.5 animate-spin mr-1.5" />
                <span v-else class="icon-[lucide--plug] w-3.5 h-3.5 mr-1.5" />
                {{ validating === aiEngine ? '验证中...' : '测试连接' }}
              </Button>

              <p v-if="aiValidated[aiEngine] === false" class="text-xs text-amber-400 flex items-center gap-1.5">
                <span class="icon-[lucide--info] w-3 h-3 shrink-0" />
                {{ t('translate.aiFallback') }}
              </p>
            </div>
          </div>


        </div>
        </Tabs>
      </div>
    </div>
  </Transition>
</template>
