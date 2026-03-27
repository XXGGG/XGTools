<script setup lang="ts">
import { ref, watch, onMounted, computed } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { LazyStore } from '@tauri-apps/plugin-store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from '@/components/ui/select'

const store = new LazyStore('settings.json')
const settingsLoaded = ref(false)

// ─── 类型 ─────────────────────────────────────────────

interface AiConfig {
  api_key: string
  api_url: string
  model: string
}

type TranslateMode = 'free' | 'ai'

const freeEngines = [
  { id: 'google', label: 'Google 翻译' },
  { id: 'bing', label: 'Bing 翻译' },
  { id: 'deepl', label: 'DeepL 翻译' },
  { id: 'transmart', label: '腾讯交互翻译' },
  { id: 'yandex', label: 'Yandex 翻译' },
  { id: 'mymemory', label: 'MyMemory 翻译' },
]

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
  { id: 'custom', label: '自定义接口' },
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

const translateMode = ref<TranslateMode>('free')
const freeEngine = ref('google')
const aiEngine = ref('openai')

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
const validating = ref<string | null>(null)

// 动态模型列表
const fetchedModels = ref<Record<string, string[]>>({})
const fetchingModels = ref(false)


// ─── 计算属性 ─────────────────────────────────────────

const activeEngine = computed(() => {
  if (translateMode.value === 'ai') {
    const cfg = aiConfigs.value[aiEngine.value]
    if (cfg?.api_key && aiValidated.value[aiEngine.value] === true) {
      return aiEngine.value
    }
    return freeEngine.value
  }
  return freeEngine.value
})

const isUsingFallback = computed(() =>
  translateMode.value === 'ai' && activeEngine.value === freeEngine.value
)

const activeEngineLabel = computed(() => {
  const all = [...freeEngines, ...aiEngines]
  return all.find(e => e.id === activeEngine.value)?.label ?? activeEngine.value
})

// ─── Load / Save ──────────────────────────────────────

async function loadSettings() {
  await store.init()
  translateMode.value = (await store.get<TranslateMode>('translate_mode')) ?? 'free'
  freeEngine.value = (await store.get<string>('translate_free_engine')) ?? 'google'
  aiEngine.value = (await store.get<string>('translate_ai_engine')) ?? 'openai'
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
  await store.set('translate_mode', translateMode.value)
  await store.set('translate_free_engine', freeEngine.value)
  await store.set('translate_ai_engine', aiEngine.value)
  await store.set('translate_ai_configs', aiConfigs.value)
  await store.set('translate_ai_validated', aiValidated.value)
  await store.save()
}

onMounted(loadSettings)

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
    const engine = activeEngine.value
    const isAi = aiEngines.some(e => e.id === engine)
    const config = isAi ? aiConfigs.value[engine] : undefined
    const result = await invoke<{ text: string; detected_lang: string | null; engine: string }>('translate', {
      request: {
        text: inputText.value,
        source_lang: 'auto',
        target_lang: detectTargetLang(inputText.value),
        engine,
        ai_config: config?.api_key ? {
          api_key: config.api_key,
          api_url: config.api_url || null,
          model: config.model || null,
        } : null,
      }
    })
    outputText.value = result.text
    detectedLang.value = result.detected_lang ?? null
  } catch (e) {
    outputText.value = `翻译失败: ${e}`
  } finally {
    loading.value = false
  }
}

function detectTargetLang(text: string): string {
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

watch([translateMode, freeEngine, aiEngine], () => {
  if (settingsLoaded.value) {
    saveSettings()
    if (inputText.value.trim()) doTranslate()
  }
})
</script>

<template>
  <div class="h-full w-full flex flex-col p-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
    <div class="flex-1 flex flex-col overflow-hidden max-w-3xl mx-auto w-full gap-3">

      <!-- 顶部栏 -->
      <div class="flex items-center justify-between shrink-0">
        <div class="flex items-center gap-2.5">
          <span class="text-sm text-muted-foreground">当前引擎:</span>
          <span class="text-sm font-medium px-3 py-1 rounded-md bg-muted">{{ activeEngineLabel }}</span>
          <span v-if="isUsingFallback" class="text-sm text-amber-400">(AI 不可用, 已回退)</span>
        </div>
        <Button variant="ghost" size="sm" @click="showSettingsDialog = true" title="翻译设置">
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
            placeholder="输入要翻译的文本..."
            class="h-full resize-none rounded-xl pt-8 pb-3 leading-relaxed"
          />
          <div v-if="inputText" class="absolute top-3 right-3 flex items-center gap-1">
            <Button
              variant="ghost" size="icon-sm"
              @click="speakInput"
              :title="speakingInput ? '停止朗读' : '朗读原文'"
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
          <Button variant="outline" size="icon-sm" @click="swapTexts" title="交换">
            <span class="icon-[lucide--arrow-down-up] w-4 h-4" />
          </Button>
          <div v-if="loading" class="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span class="icon-[lucide--loader-2] w-3.5 h-3.5 animate-spin" />
            翻译中...
          </div>
        </div>

        <!-- 输出区 -->
        <div class="flex-1 relative group">
          <Textarea
            :model-value="outputText"
            readonly
            placeholder="翻译结果..."
            class="h-full resize-none rounded-xl bg-muted/30 leading-relaxed"
          />
          <div v-if="outputText" class="absolute bottom-3 right-3 flex items-center gap-1.5">
            <Button
              variant="outline" size="icon-sm"
              @click="speakOutput"
              :title="speaking ? '停止朗读' : '朗读译文'"
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

  <!-- ==================== 设置弹窗 ==================== -->
  <Transition enter-active-class="transition-opacity duration-150" enter-from-class="opacity-0" leave-active-class="transition-opacity duration-150" leave-to-class="opacity-0">
    <div
      v-if="showSettingsDialog"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      @click.self="showSettingsDialog = false"
    >
      <div class="w-[480px] max-h-[80vh] rounded-xl shadow-2xl bg-popover border flex flex-col">
        <!-- 头部 -->
        <div class="flex items-center justify-between p-5 pb-0">
          <h3 class="font-medium">翻译设置</h3>
          <Button variant="ghost" size="icon-sm" @click="showSettingsDialog = false">
            <span class="icon-[lucide--x] w-4 h-4" />
          </Button>
        </div>

        <!-- 内容 -->
        <div class="flex-1 overflow-y-auto p-5 space-y-5">

          <!-- 模式选择 -->
          <div class="space-y-3">
            <p class="text-xs text-muted-foreground uppercase tracking-wider font-medium">翻译来源</p>
            <div class="flex gap-2">
              <Button
                variant="outline"
                @click="translateMode = 'free'"
                class="flex-1 py-3 h-auto"
                :class="translateMode === 'free' ? 'border-primary bg-primary/10 text-foreground' : ''"
              >
                <span class="icon-[lucide--globe] w-4 h-4" />
                免费接口
              </Button>
              <Button
                variant="outline"
                @click="translateMode = 'ai'"
                class="flex-1 py-3 h-auto"
                :class="translateMode === 'ai' ? 'border-primary bg-primary/10 text-foreground' : ''"
              >
                <span class="icon-[lucide--bot] w-4 h-4" />
                AI 翻译
              </Button>
            </div>
          </div>

          <!-- 免费接口选择 -->
          <div v-if="translateMode === 'free'" class="space-y-3">
            <p class="text-xs text-muted-foreground uppercase tracking-wider font-medium">免费接口</p>
            <Select :model-value="freeEngine" @update:model-value="(v) => freeEngine = String(v)">
              <SelectTrigger>
                <SelectValue placeholder="选择接口" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="e in freeEngines" :key="e.id" :value="e.id">{{ e.label }}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <!-- AI 配置 -->
          <div v-if="translateMode === 'ai'" class="space-y-4">
            <!-- AI 引擎选择 -->
            <div class="space-y-3">
              <p class="text-xs text-muted-foreground uppercase tracking-wider font-medium">AI 引擎</p>
              <Select :model-value="aiEngine" @update:model-value="(v) => aiEngine = String(v)">
                <SelectTrigger>
                  <SelectValue placeholder="选择引擎" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="e in aiEngines" :key="e.id" :value="e.id">{{ e.label }}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <!-- 当前 AI 配置表单 -->
            <div class="space-y-3 p-4 border border-border rounded-lg bg-muted/10">
              <div class="flex items-center justify-between">
                <p class="text-sm font-medium">{{ aiEngines.find(e => e.id === aiEngine)?.label }} 配置</p>
                <!-- 验证状态标签 -->
                <span v-if="aiValidated[aiEngine] === true" class="text-xs text-green-400 flex items-center gap-1">
                  <span class="icon-[lucide--check-circle] w-3 h-3" /> 已验证
                </span>
                <span v-else-if="aiValidated[aiEngine] === false" class="text-xs text-red-400 flex items-center gap-1">
                  <span class="icon-[lucide--x-circle] w-3 h-3" /> 验证失败
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
                    placeholder="API 端点 (必填, OpenAI 兼容格式)"
                  />
                  <Input
                    v-model="aiConfigs[aiEngine].model"
                    @input="debounceSave(); aiValidated[aiEngine] = null"
                    type="text"
                    placeholder="模型名 (必填)"
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
                        <SelectValue placeholder="选择模型" />
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
                      :title="fetchedModels[aiEngine] ? '刷新模型列表' : '从 API 获取可用模型'"
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
                连接失败，将自动回退到免费接口
              </p>
            </div>
          </div>


        </div>
      </div>
    </div>
  </Transition>
</template>
