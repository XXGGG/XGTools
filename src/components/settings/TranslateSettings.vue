<script setup lang="ts">
/**
 * 设置 → 翻译：引擎顺序（从上往下试）、兜底（和链同时跑，谁快用谁）、各 AI 引擎的 key 和模型、本机离线模型。
 * 原来是翻译页右上角的弹窗，挪进设置页；改完即存，翻译页下次打开就按新的来。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { VueDraggable } from 'vue-draggable-plus'
import { LazyStore } from '@tauri-apps/plugin-store'
import { localModel, checkLocalModel, downloadLocalModel, removeLocalModel, LOCAL_MODEL_BYTES } from '@/lib/bergamot'
import { ENGINES, engineLabel, loadChain, loadRace, saveRace, isFreeToRace, type RaceConfig } from '@/lib/translateChain'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import InfoTip from '@/components/InfoTip.vue'
import { fromTranslateCustom, loadLlm } from '@/lib/llm'
import { useI18n } from '@/i18n'

const { t } = useI18n()
const store = new LazyStore('settings.json')
const loaded = ref(false)

interface AiConfig { api_key: string; api_url: string; model: string }

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
const defaultModels: Record<string, string> = Object.fromEntries(Object.entries(engineModels).map(([k, v]) => [k, v[0]]))

/** 引擎优先级链:从上往下试,谁成功用谁。见 lib/translateChain */
const chain = ref<string[]>([])
/** 正展开配置的引擎(AI 或本机离线);null = 都收着 */
const configOpen = ref<string | null>(null)
/** AI 配置表单绑定的引擎。展开哪个 AI 引擎的配置它就指向哪个 */
const aiEngine = ref('openai')
const race = ref<RaceConfig>({ local: false, localAi: false })

const defaultAiConfig = (): AiConfig => ({ api_key: '', api_url: '', model: '' })
const aiConfigs = ref<Record<string, AiConfig>>(Object.fromEntries(aiEngines.map(e => [e.id, defaultAiConfig()])))
const aiValidated = ref<Record<string, boolean | null>>(Object.fromEntries(aiEngines.map(e => [e.id, null])))
const validating = ref<string | null>(null)
const fetchedModels = ref<Record<string, string[]>>({})
const fetchingModels = ref(false)

/**
 * 「AI 自定义接口」现在指的是不是本机。不是的话兜底那个开关就点不动 ——
 * 兜底是每一次翻译都发的，指着线上接口等于接了一根按次计费的水管。
 */
const customIsLocal = computed(() => isFreeToRace('custom', aiConfigs.value))
const available = computed(() => ENGINES.filter(e => !chain.value.includes(e.id)))
const configKind = computed(() => ENGINES.find(e => e.id === configOpen.value)?.kind ?? null)
const localPct = computed(() => Math.round(localModel.progress * 100))
const localSizeMb = Math.round(LOCAL_MODEL_BYTES / 1024 / 1024)

/** 链里每个引擎的小状态:AI 没配 key / 离线模型没下,都标一下,免得排上去了却一直被跳过 */
function engineWarn(id: string): string | null {
  const kind = ENGINES.find(e => e.id === id)?.kind
  if (kind === 'ai' && !aiConfigs.value[id]?.api_key) return t('translate.aiUnconfigured')
  if (kind === 'local' && localModel.status !== 'ready') return t('translate.localMissing')
  return null
}

async function load() {
  await store.init()
  chain.value = await loadChain()
  race.value = await loadRace()
  const saved = await store.get<Record<string, AiConfig>>('translate_ai_configs')
  if (saved) for (const k of Object.keys(aiConfigs.value)) if (saved[k]) aiConfigs.value[k] = { ...aiConfigs.value[k], ...saved[k] }
  const savedValidation = await store.get<Record<string, boolean | null>>('translate_ai_validated')
  if (savedValidation) for (const k of Object.keys(aiValidated.value)) if (k in savedValidation) aiValidated.value[k] = savedValidation[k]
  loaded.value = true
}

async function save() {
  await saveRace(race.value)
  await store.set('translate_chain', chain.value)
  await store.set('translate_ai_configs', aiConfigs.value)
  await store.set('translate_ai_validated', aiValidated.value)
  await store.save()
  // 「AI 自定义接口」指的是本机时，和「大模型」那页对齐
  await fromTranslateCustom(aiConfigs.value.custom)
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
function debounceSave() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => { if (loaded.value) void save() }, 500)
}

watch([chain, race], () => { if (loaded.value) void save() }, { deep: true })

onMounted(async () => {
  await load()
  // 「AI 自定义接口」还没配过：直接用「大模型」那页选好的本机模型，提前配好
  if (!aiConfigs.value.custom.api_url) {
    const c = await loadLlm()
    aiConfigs.value.custom = { api_key: aiConfigs.value.custom.api_key || 'ollama', api_url: `${c.url.replace(/\/+$/, '')}/v1`, model: c.model }
    await save()
  }
  void checkLocalModel()
})

async function fetchModels(engineId: string) {
  if (engineId === 'custom') return
  const cfg = aiConfigs.value[engineId]
  if (!cfg?.api_key) return
  fetchingModels.value = true
  try {
    const models = await invoke<string[]>('list_models', { request: { engine: engineId, api_key: cfg.api_key, api_url: cfg.api_url || null } })
    if (models.length > 0) fetchedModels.value[engineId] = models
  } catch {
    // 获取失败时静默回退到静态列表
  } finally {
    fetchingModels.value = false
  }
}

async function testAiConnection(engineId: string) {
  const cfg = aiConfigs.value[engineId]
  if (!cfg?.api_key) { aiValidated.value[engineId] = false; return }
  validating.value = engineId
  try {
    await invoke('translate', {
      request: {
        text: 'hello', source_lang: 'en', target_lang: 'zh', engine: engineId,
        ai_config: { api_key: cfg.api_key, api_url: cfg.api_url || null, model: cfg.model || null },
      },
    })
    aiValidated.value[engineId] = true
    void fetchModels(engineId)
  } catch {
    aiValidated.value[engineId] = false
  } finally {
    validating.value = null
    void save()
  }
}

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
  <div class="space-y-6">
    <!-- 引擎顺序:拖动排序,从上往下试 -->
    <section class="space-y-2">
      <h3 class="text-sm font-medium flex items-center gap-1.5">{{ t('translate.chain') }}<InfoTip :text="t('translate.chainHint')" /></h3>
      <VueDraggable v-model="chain" handle=".chain-grip" :animation="180" :force-fallback="true" ghost-class="opacity-30"
        class="rounded-xl border divide-y overflow-hidden">
        <div v-for="(id, i) in chain" :key="id" class="flex items-center gap-3 px-4 py-2.5">
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

      <!-- 没进链的引擎,点一下加到末尾 -->
      <div v-if="available.length" class="flex flex-wrap items-center gap-1.5 pt-1">
        <span class="text-xs text-muted-foreground mr-1">{{ t('translate.addEngine') }}</span>
        <button v-for="e in available" :key="e.id" @click="addEngine(e.id)"
          class="h-7 px-2.5 rounded-md border border-border text-xs transition-colors hover:bg-muted flex items-center gap-1">
          <span class="icon-[lucide--plus] w-3 h-3" />{{ e.label }}
        </button>
      </div>

      <!-- 本机离线模型:不随安装包走,这里按需下 -->
      <div v-if="configOpen === 'local'" class="rounded-xl border p-4 space-y-2">
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
      <div v-if="configOpen && configKind === 'ai'" class="space-y-3 rounded-xl border p-4">
        <div class="flex items-center justify-between">
          <p class="text-sm font-medium">{{ aiEngines.find(e => e.id === aiEngine)?.label }} 配置</p>
          <span v-if="aiValidated[aiEngine] === true" class="text-xs text-green-400 flex items-center gap-1">
            <span class="icon-[lucide--check-circle] w-3 h-3" /> {{ t('translate.verified') }}
          </span>
          <span v-else-if="aiValidated[aiEngine] === false" class="text-xs text-red-400 flex items-center gap-1">
            <span class="icon-[lucide--x-circle] w-3 h-3" /> {{ t('translate.verifyFailed') }}
          </span>
        </div>
        <div class="space-y-2">
          <Input v-model="aiConfigs[aiEngine].api_key" type="password" placeholder="API Key *"
            @input="debounceSave(); aiValidated[aiEngine] = null" />
          <template v-if="aiEngine === 'custom'">
            <Input v-model="aiConfigs[aiEngine].api_url" type="text" :placeholder="t('translate.endpoint')"
              @input="debounceSave(); aiValidated[aiEngine] = null" />
            <Input v-model="aiConfigs[aiEngine].model" type="text" :placeholder="t('translate.modelName')"
              @input="debounceSave(); aiValidated[aiEngine] = null" />
          </template>
          <template v-else>
            <div class="flex items-center gap-1.5">
              <Select :model-value="aiConfigs[aiEngine].model || defaultModels[aiEngine] || ''" class="flex-1"
                @update:model-value="(v) => { aiConfigs[aiEngine].model = String(v); debounceSave(); aiValidated[aiEngine] = null }">
                <SelectTrigger><SelectValue :placeholder="t('translate.pickModel')" /></SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="m in (fetchedModels[aiEngine] ?? engineModels[aiEngine] ?? [])" :key="m" :value="m">{{ m }}</SelectItem>
                </SelectContent>
              </Select>
              <Button variant="ghost" size="icon-sm" :disabled="!aiConfigs[aiEngine]?.api_key || fetchingModels"
                :title="fetchedModels[aiEngine] ? t('translate.refreshModels') : t('translate.fetchModels')" @click="fetchModels(aiEngine)">
                <span :class="fetchingModels ? 'animate-spin' : ''" class="icon-[lucide--refresh-cw] w-3.5 h-3.5" />
              </Button>
            </div>
            <p v-if="fetchedModels[aiEngine]" class="text-xs text-muted-foreground">已从 API 获取 {{ fetchedModels[aiEngine].length }} 个模型</p>
          </template>
        </div>
        <Button variant="outline" size="sm" :disabled="!aiConfigs[aiEngine]?.api_key || validating === aiEngine" @click="testAiConnection(aiEngine)">
          <span v-if="validating === aiEngine" class="icon-[lucide--loader-2] w-3.5 h-3.5 animate-spin mr-1.5" />
          <span v-else class="icon-[lucide--plug] w-3.5 h-3.5 mr-1.5" />
          {{ validating === aiEngine ? '验证中...' : '测试连接' }}
        </Button>
        <p v-if="aiValidated[aiEngine] === false" class="text-xs text-amber-400 flex items-center gap-1.5">
          <span class="icon-[lucide--info] w-3 h-3 shrink-0" />{{ t('translate.aiFallback') }}
        </p>
      </div>
    </section>

    <!-- 兜底:和链同时跑,谁快用谁。只收跑在本机的东西,理由见 lib/translateChain -->
    <section class="space-y-2">
      <h3 class="text-sm font-medium flex items-center gap-1.5">{{ t('translate.race') }}<InfoTip :text="t('translate.raceHint')" /></h3>
      <div class="rounded-xl border divide-y">
        <div class="flex items-center gap-4 px-4 py-3.5">
          <span class="icon-[lucide--hard-drive] w-5 h-5 shrink-0 text-muted-foreground" />
          <span class="text-sm flex-1 truncate">{{ t('translate.raceLocal') }}</span>
          <span v-if="race.local && localModel.status !== 'ready'" class="text-xs text-amber-400 shrink-0">{{ t('translate.localMissing') }}</span>
          <Switch :model-value="race.local" @update:model-value="race.local = $event" />
        </div>
        <div class="flex items-center gap-4 px-4 py-3.5" :class="customIsLocal ? '' : 'opacity-50'">
          <span class="icon-[lucide--sparkles] w-5 h-5 shrink-0 text-muted-foreground" />
          <span class="text-sm flex-1 truncate">{{ t('translate.raceAi') }}</span>
          <span v-if="!customIsLocal" class="text-xs text-muted-foreground shrink-0">{{ t('translate.raceAiNotLocal') }}</span>
          <Switch :model-value="race.localAi" :disabled="!customIsLocal" @update:model-value="race.localAi = $event" />
        </div>
      </div>
    </section>
  </div>
</template>
