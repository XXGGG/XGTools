<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import {
  ENGINES, engineLabel, loadChain, translateRacing, loadRace,
  type ChainFailure, type RaceConfig,
} from '@/lib/translateChain'
import { LazyStore } from '@tauri-apps/plugin-store'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useI18n } from '@/i18n'

const { t } = useI18n()

const store = new LazyStore('settings.json')

// ─── 类型 ─────────────────────────────────────────────

interface AiConfig {
  api_key: string
  api_url: string
  model: string
}

/** AI 类引擎的 id —— 「改译文同步原文」只有它们做得到 */
const AI_IDS = ENGINES.filter(e => e.kind === 'ai').map(e => e.id)

// ─── State ────────────────────────────────────────────

/** 引擎优先级链:从上往下试,谁成功用谁。见 lib/translateChain */
const chain = ref<string[]>([])
/** 最近一次翻译:用了谁、它前面谁失败了 */
const lastUsed = ref<string | null>(null)
const lastFailed = ref<ChainFailure[]>([])

/*
  兜底:和链**同时**出发,谁先回来算谁的。和「排序」是两回事 ——
  排序是前面的不行才轮到后面的,那要先干等一次失败。
  详见 lib/translateChain 里那一大段。
*/
const race = ref<RaceConfig>({ local: false, localAi: false })
/** 各 AI 引擎的 key / 模型（「改译文同步原文」要用） */
const aiConfigs = ref<Record<string, AiConfig>>({})

const inputText = ref('')
const outputText = ref('')
/**
 * 译文「已经和原文对上」的那一版。用户手改译文后,拿它和改后的译文比,
 * 把差别交给 AI,让原文里对应的部分一起改掉(见 syncSource)。
 */
let syncedOutput = ''
const syncing = ref(false)
const syncHint = ref<string | null>(null)
let syncTimer: ReturnType<typeof setTimeout> | null = null
/** 每次发起/作废同步就 +1;回来的结果序号对不上就丢掉 */
let syncSeq = 0
const detectedLang = ref<string | null>(null)
const loading = ref(false)
const copied = ref(false)
const speaking = ref(false)

// ─── 计算属性 ─────────────────────────────────────────

const chainLabel = computed(() => chain.value.map(engineLabel).join(' → '))

// ─── Load / Save ──────────────────────────────────────

/** 设置在「设置 → 翻译」里改，这页只读（每次进来都会重新挂载，读到的就是最新的） */
async function loadSettings() {
  await store.init()
  chain.value = await loadChain()
  race.value = await loadRace()
  aiConfigs.value = (await store.get<Record<string, AiConfig>>('translate_ai_configs')) ?? {}
}

onMounted(loadSettings)

// ─── 翻译逻辑 ─────────────────────────────────────────

let debounceTimer: ReturnType<typeof setTimeout> | null = null

function onInputChange() {
  cancelSync()
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    if (inputText.value.trim()) doTranslate()
    else { outputText.value = ''; syncedOutput = ''; detectedLang.value = null }
  }, 500)
}

// ─── 手改译文 → 原文跟着改 ─────────────────────────────

function cancelSync() {
  if (syncTimer) clearTimeout(syncTimer)
  syncSeq++
  syncing.value = false
  syncHint.value = null
}

function onOutputEdit() {
  syncHint.value = null
  if (syncTimer) clearTimeout(syncTimer)
  syncTimer = setTimeout(syncSource, 900)
}

/**
 * 译文被手改了:让 AI 把原文里对应的词一起改掉(比如删掉「中国」,英文里的 chinese 也没)。
 *
 * 只有 AI 引擎做得到(要知道词与词的对应),所以只挑 AI 引擎;没配就提示一句,不动原文。
 * 改动是从「上次对上的那版」累计算起的:这次没同步成功,下次编辑会把两次的差别一起交过去。
 * 原文是程序改的,不是用户敲的,所以不会触发 @input,也就不会反过来把译文重翻覆盖掉。
 */
async function syncSource() {
  const edited = outputText.value
  if (edited === syncedOutput || !inputText.value.trim()) return
  const isAi = (id: string) => AI_IDS.includes(id) && !!aiConfigs.value[id]?.api_key
  const engine = chain.value.find(isAi) ?? AI_IDS.find(isAi)
  if (!engine) { syncHint.value = t('translate.syncNeedAi'); return }
  const cfg = aiConfigs.value[engine]
  const seq = ++syncSeq
  syncing.value = true
  try {
    const next = await invoke<string>('sync_source_edit', {
      engine,
      aiConfig: { api_key: cfg.api_key, api_url: cfg.api_url || null, model: cfg.model || null },
      source: inputText.value,
      translation: syncedOutput,
      edited,
    })
    if (seq !== syncSeq) return
    // AI 没改动原文 = 它没找到对得上的词(译文和原文本来就没逐词对应时常见),说一声别让人以为没反应
    if (edited.trim() && next.trim() === inputText.value.trim()) syncHint.value = t('translate.syncNoMatch')
    inputText.value = edited.trim() ? next : ''
    syncedOutput = edited
  } catch {
    if (seq === syncSeq) syncHint.value = t('translate.syncFailed')
  } finally {
    if (seq === syncSeq) syncing.value = false
  }
}

async function doTranslate() {
  if (!inputText.value.trim()) return
  cancelSync()
  if (speaking.value) {
    window.speechSynthesis.cancel()
    speaking.value = false
  }
  loading.value = true
  try {
    const r = await translateRacing(inputText.value, detectTargetLang(inputText.value),
      { chain: chain.value, aiConfigs: aiConfigs.value, race: race.value })
    outputText.value = r.text
    syncedOutput = r.text
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
  cancelSync()
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
              @click="cancelSync(); inputText = ''; outputText = ''; syncedOutput = ''; detectedLang = null"
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
          <div v-else-if="syncing" class="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span class="icon-[lucide--loader-2] w-3.5 h-3.5 animate-spin" />
            {{ t('translate.syncing') }}
          </div>
          <div v-else-if="syncHint" class="text-xs text-amber-400">{{ syncHint }}</div>
        </div>

        <!-- 输出区 -->
        <div class="flex-1 relative group">
          <!--
            这一版的译文是谁给的。配了兜底之后这件事**不再是可以推断的** ——
            链里排第一的和两个兜底同时在跑,谁先回来算谁的,所以每次都可能不一样。
            摆在结果框左下角的空地:原来在右上角,会压住译文的最后几个字(2026-10-08 用户嫌挡)。
            译文框底部留了 pb-12,文字不会滚到它底下。
          -->
          <span v-if="outputText && lastUsed && !loading"
            class="absolute bottom-3.5 left-3 z-10 px-2 py-0.5 rounded-md text-[11px] pointer-events-none
                   bg-background/80 border border-border text-muted-foreground backdrop-blur-sm">
            {{ engineLabel(lastUsed) }}
          </span>
          <!-- 译文可以直接改:删掉几个词,原文里对应的词会跟着没(AI 引擎才行,见 syncSource) -->
          <Textarea
            v-model="outputText"
            @input="onOutputEdit"
            :placeholder="t('translate.resultPlaceholder')"
            class="h-full resize-none rounded-xl bg-muted/30 leading-relaxed pb-12"
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
</template>
