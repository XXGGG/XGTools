<script setup lang="ts">
/*
  提示词页右栏的「Anima」模式：中文写画面 → 大模型按 Anima 的写法打磨成英文提示词。
  规则和系统提示都在 lib/prompt/anima.ts。这里只管界面：输入、底模版本、结果、复制。
  结果分三块给：标签（词库里没有的会标黄，可能是模型自造的）、英文句子、中文回译（用来核对没被改意思）。
*/
import { computed, onMounted, ref } from 'vue'
import { useI18n } from '@/i18n'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { storedRef } from '@/lib/prompt/storedRef'
import type { PromptTag } from '@/lib/prompt/promptData'
import { pickAiEngine, polishForAnima } from '@/lib/prompt/anima'
import { engineLabel, translateChain } from '@/lib/translateChain'
import InfoTip from '@/components/InfoTip.vue'

const props = defineProps<{
  library: PromptTag[]
  /** 标签模式里已选的词（已套好修饰和权重），勾了「带上已选标签」才会发给模型 */
  pickedTags: string[]
  /** 已经嵌进「标签」页的句子（英文原句），按钮据此显示「已嵌入」 */
  embedded: string[]
}>()
// 嵌入 / 取消嵌入：句子会作为一个普通标签进「标签」页（能停用、能删），Prompt.vue 负责增删
const emit = defineEmits<{ toggleSentence: [{ en: string, zh: string }], close: [] }>()
// 三个页签：默认是优化翻译（用户最常用），其次默认翻译，最后拆成标签
type Tab = 'text' | 'literal' | 'tags'
const TABS: Tab[] = ['text', 'literal', 'tags']
const TAB_LABEL: Record<Tab, string> = { text: 'prompt.animaText', literal: 'prompt.animaLiteral', tags: 'prompt.animaTags' }
const tab = ref<Tab>('text')
// 当前页签对应的那段文字（底部「复制」复制它）
const currentText = computed(() => {
  const r = result.value
  if (!r) return ''
  return (tab.value === 'text' ? r.text : tab.value === 'literal' ? r.literal : r.tags) ?? ''
})

const { t } = useI18n()

const input = storedRef('anima_input', '').data
// 复制出去的写法：描述单独成段（默认），还是用括号嵌进标签后面
function toggleEmbed(which: 'literal' | 'text') {
  const r = result.value
  if (!r) return
  const en = (which === 'literal' ? r.literal : r.text) ?? ''
  if (!en.trim()) return
  const adding = !isEmbedded(which)
  emit('toggleSentence', { en: en.trim(), zh: ((which === 'literal' ? r.literalZh : r.zh) ?? '').trim() })
  // 嵌入后直接回到标签页（关掉这个浮窗）
  if (adding) emit('close')
}
const isEmbedded = (which: 'literal' | 'text') => {
  const en = ((which === 'literal' ? result.value?.literal : result.value?.text) ?? '').trim()
  return !!en && props.embedded.includes(en)
}
// 长期提醒：用户自己写的规则（比如「手握 = 攥紧，不是拿着」），每次打磨都会带上，优先级最高
const reminders = storedRef('anima_reminders', '').data
const showReminders = ref(false)
const result = storedRef<{ tags: string, tagZh?: Record<string, string>, literal?: string, literalZh?: string, text: string, zh: string, engine?: string, mode?: 'ai' | 'plain' } | null>('anima_result', null).data

// 有没有配 AI 引擎：没配的话按钮叫「翻译」，只做直译（通用软件，不假设用户有大模型）
const hasAi = ref(true)
onMounted(async () => { hasAi.value = !!(await pickAiEngine().catch(() => null)) })

const busy = ref(false)
const error = ref('')

/** 回车直接翻译，Shift+回车换行；中文输入法还在选字时的回车不算 */
function onEnter(e: KeyboardEvent) {
  if (e.shiftKey || e.isComposing) return
  e.preventDefault()
  run()
}

async function run() {
  if (!input.value.trim() || busy.value) return
  busy.value = true
  error.value = ''
  try {
    const r = await polishForAnima(input.value, props.library, [], reminders.value)
    result.value = { tags: r.tags, tagZh: r.tagZh, literal: r.literal, text: r.text, zh: '', literalZh: '', engine: r.engine, mode: r.mode }
    hasAi.value = r.mode === 'ai'
    // 中文回译单独翻：让大模型在同一个回答里顺手翻，它老把标签也一起翻进去（10-11 用户截图），
    // 单独走一次翻译引擎链，只翻这一句，又准又不会混进标签
    const cur = result.value
    void Promise.all([
      cur.text ? translateChain(cur.text, 'zh').then(x => x.text.trim()).catch(() => '') : Promise.resolve(''),
      cur.literal ? translateChain(cur.literal, 'zh').then(x => x.text.trim()).catch(() => '') : Promise.resolve(''),
    ]).then(([z, lz]) => { if (result.value === cur) { cur.zh = z; cur.literalZh = lz } })
  }
  catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
  finally {
    busy.value = false
  }
}

// 标签对照表：词库 + Danbooru 常用的一般标签（public/danbooru-tags.txt，使用 100 次以上的约 1.9 万个）。
// 只在用到 Anima 模式时才去读，读失败就只拿词库比
const danbooru = ref<Set<string>>(new Set())
onMounted(async () => {
  try {
    const txt = await (await fetch('/danbooru-tags.txt')).text()
    danbooru.value = new Set(txt.split(/\r?\n/).map(s => s.trim()).filter(Boolean))
  }
  catch {}
})
const known = computed(() => new Set([...props.library.map(x => x.value.toLowerCase()), ...danbooru.value]))
// 词库里查不到的标签：安全标签、人数标签、@画师 这些本来就不在词库里，不算
const BUILTIN = /^(safe|sensitive|nsfw|explicit|solo|\d\+?(girls?|boys?|others?)|@.*)$/
const unknownTags = computed(() => (result.value?.tags ?? '').split(',').map(s => s.trim()).filter(Boolean)
  .filter(s => !known.value.has(s.toLowerCase()) && !BUILTIN.test(s.toLowerCase())))

// 没配 AI 引擎时只有整句直译，就拿它当描述
// 拆成标签下面逐个显示中文：库里有的用词库的中文，没有的用模型给的
const libLabel = computed(() => new Map(props.library.map(x => [x.value.toLowerCase(), x.label])))
const tagList = computed(() => (result.value?.tags ?? '').split(',').map(s => s.trim()).filter(Boolean).map((en) => {
  const k = en.toLowerCase()
  return { en, zh: libLabel.value.get(k) ?? result.value?.tagZh?.[k] ?? '', unknown: unknownTags.value.includes(en) }
}))
const copied = ref<'' | 'lit' | 'opt' | 'tags'>('')
async function copyText(text: string, which: 'lit' | 'opt' | 'tags') {
  await navigator.clipboard.writeText(text)
  copied.value = which
  setTimeout(() => { copied.value = '' }, 1500)
}
// 打开浮窗时光标直接在输入框里
const inputEl = ref<{ $el?: HTMLElement } | null>(null)
onMounted(() => { (inputEl.value?.$el as HTMLTextAreaElement | undefined)?.focus?.() })
</script>

<template>
  <!--
    「自然语言」浮窗（原来的 Anima 页，2026-10-11 改成标签页底部按钮打开的一个窗口）：
    上：三个页签（优化翻译 / 默认翻译 / 拆成标签），结果只读；中：结果；下：输入中文。
    点「嵌入标签」把这句作为一个标签放进已选，窗口自动关掉回到标签页。
  -->
  <!-- 高度跟内容走：结果多少就往上顶多少，不再整块占满（外层限制了最高高度，超出才滚动） -->
  <div class="flex flex-col max-h-full min-h-0">
    <div class="shrink-0 flex items-center gap-1 px-3 pt-3 pb-2">
      <button v-for="tb in TABS" :key="tb" class="nl-tab" :class="{ 'nl-tab-on': tab === tb }" @click="tab = tb">
        {{ t(TAB_LABEL[tb]) }}
      </button>
      <span class="flex-1" />
      <button class="nl-close" :title="t('prompt.nlClose')" @click="emit('close')">
        <span class="icon-[lucide--x] size-4" />
      </button>
    </div>

    <!-- 结果（只读） -->
    <div class="min-h-0 overflow-y-auto px-4 pb-3 flex flex-col gap-3">
      <div v-if="error" class="text-[12px] text-destructive whitespace-pre-wrap">{{ error }}</div>
      <template v-if="result">
        <template v-if="tab === 'text' || tab === 'literal'">
          <template v-if="(tab === 'text' ? result.text : result.literal)">
            <p class="nl-out">{{ tab === 'text' ? result.text : result.literal }}</p>
            <p v-if="tab === 'text' ? result.zh : result.literalZh" class="nl-zh">
              {{ tab === 'text' ? result.zh : result.literalZh }}
            </p>
          </template>
          <p v-else class="text-[13px] text-muted-foreground/60">{{ t('prompt.nlNoSentence') }}</p>
        </template>
        <template v-else>
          <div v-if="tagList.length" class="flex flex-wrap gap-1.5">
            <span v-for="tg in tagList" :key="tg.en" class="tag-pair" :class="{ 'tag-pair-warn': tg.unknown }">
              <span class="font-mono">{{ tg.en }}</span><span v-if="tg.zh" class="text-muted-foreground">{{ tg.zh }}</span>
            </span>
          </div>
          <p v-else class="text-[13px] text-muted-foreground/60">{{ t('prompt.nlNoTags') }}</p>
          <div v-if="unknownTags.length" class="text-[11.5px] text-amber-600 dark:text-amber-400">
            {{ t('prompt.animaUnknown') }}{{ unknownTags.join(', ') }}
          </div>
        </template>
        <div v-if="result.engine" class="flex items-center gap-1 text-[11.5px] text-muted-foreground/70">
          <span>{{ result.mode === 'plain' ? t('prompt.animaPlainBy', { e: engineLabel(result.engine) }) : t('prompt.animaBy', { e: engineLabel(result.engine) }) }}</span>
          <InfoTip v-if="result.mode === 'plain'" :text="t('prompt.animaPlainTip')" />
        </div>
      </template>
      <div v-else-if="!busy" class="flex flex-col items-center justify-center gap-2 text-[13px] text-muted-foreground/50 py-6">
        <span class="icon-[lucide--languages] size-10 opacity-30" />
        <span>{{ t('prompt.animaEmpty') }}</span>
      </div>
      <div v-else class="flex items-center justify-center text-[13px] text-muted-foreground/60 gap-2 py-6">
        <span class="icon-[lucide--loader-circle] size-4 animate-spin" />{{ t('prompt.animaBusy') }}
      </div>
    </div>

    <!-- 输入（在底部） -->
    <div class="shrink-0 px-3 pb-3 pt-2 flex flex-col gap-2">
      <Textarea v-if="showReminders" v-model="reminders" class="anima-reminders" :placeholder="t('prompt.animaRemindersPlaceholder')" />
      <Textarea ref="inputEl" v-model="input" class="anima-input" :placeholder="t('prompt.animaPlaceholder')"
        @keydown.enter="onEnter" />
      <div class="flex items-center gap-2 flex-wrap">
        <template v-if="result && currentText">
          <Button variant="outline" size="sm" @click="copyText(currentText, tab === 'tags' ? 'tags' : tab === 'text' ? 'opt' : 'lit')">
            <span class="size-3.5" :class="copied ? 'icon-[lucide--check]' : 'icon-[lucide--copy]'" />
            {{ copied ? t('prompt.copied') : t('prompt.copy') }}
          </Button>
          <Button v-if="tab !== 'tags'" variant="outline" size="sm" :class="{ 'embed-on': isEmbedded(tab) }" @click="toggleEmbed(tab)">
            <span class="size-3.5" :class="isEmbedded(tab) ? 'icon-[lucide--check]' : 'icon-[lucide--brackets]'" />
            {{ isEmbedded(tab) ? t('prompt.animaEmbedOn') : t('prompt.animaEmbed') }}
          </Button>
        </template>
        <span class="flex-1" />
        <button class="text-[12px] text-muted-foreground hover:text-foreground flex items-center gap-1"
          :class="{ 'text-foreground': showReminders || reminders.trim() }" @click="showReminders = !showReminders">
          <span class="icon-[lucide--sticky-note] size-3.5" />
          {{ t('prompt.animaReminders') }}<template v-if="reminders.trim() && !showReminders"> ·</template>
        </button>
        <Button size="sm" :disabled="busy || !input.trim()" @click="run">
          <span class="size-3.5" :class="busy ? 'icon-[lucide--loader-circle] animate-spin' : 'icon-[lucide--sparkles]'" />
          {{ busy ? t('prompt.animaBusy') : hasAi ? t('prompt.animaRun') : t('prompt.animaTranslate') }}
        </Button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.anima-input {
  min-height: 96px;
  font-size: 14px;
  line-height: 1.6;
  resize: vertical;
}
.anima-reminders {
  min-height: 72px;
  font-size: 13px;
  line-height: 1.6;
  resize: vertical;
}
.anima-field {
  min-height: 64px;
  font-size: 12.5px;
  line-height: 1.6;
  font-family: "SF Mono", "Cascadia Code", "Fira Code", monospace;
  resize: vertical;
}
/* 两块结果各用一块半透明磨砂底板分开（和提示词页底部那块一个做法） */
.nl-tab {
  font-size: 13px;
  padding: 5px 12px;
  border-radius: 8px;
  color: var(--muted-foreground);
  transition: background-color 120ms, color 120ms;
}
.nl-tab:hover { color: var(--foreground); }
.nl-tab-on { color: var(--foreground); background: color-mix(in oklab, var(--foreground) 9%, transparent); font-weight: 600; }
.nl-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 7px;
  color: var(--muted-foreground);
}
.nl-close:hover { color: var(--foreground); background: color-mix(in oklab, var(--foreground) 8%, transparent); }
/* 中文回译：加粗、换成暖金色，和上面的英文一眼分开 */
.nl-zh {
  font-size: 14px;
  line-height: 1.7;
  font-weight: 600;
  color: hsl(38 75% 40%);
}
.dark .nl-zh { color: hsl(42 85% 68%); }
.nl-out {
  font-size: 14px;
  line-height: 1.7;
  font-family: "SF Mono", "Cascadia Code", "Fira Code", monospace;
  user-select: text;
}
.anima-block {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  border-radius: 12px;
  border: 1px solid color-mix(in oklab, var(--border) 40%, transparent);
  background: color-mix(in oklab, var(--card) 55%, transparent);
  backdrop-filter: blur(24px);
}
.block-actions {
  display: flex;
  gap: 8px;
}
.tag-pair {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  font-size: 12px;
  padding: 3px 8px;
  border-radius: 6px;
  border: 1px solid color-mix(in oklab, var(--border) 70%, transparent);
}
.tag-pair-warn { border-style: dashed; border-color: hsl(45 95% 50% / 0.7); }
.block-title {
  font-size: 13px;
  font-weight: 600;
}
.copy-mini {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11.5px;
  color: var(--muted-foreground);
}
.copy-mini:hover { color: var(--foreground); }
.embed-on {
  border-color: hsl(168 58% 39% / 0.5) !important;
  background: hsl(168 58% 39% / 0.12) !important;
  color: hsl(168 58% 39%) !important;
}
.dark .embed-on { color: hsl(168 55% 62%) !important; }
.sec-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--muted-foreground);
}
.seg {
  display: inline-flex;
  padding: 2px;
  border-radius: 8px;
  background: color-mix(in oklab, var(--muted) 80%, transparent);
}
.seg-item {
  font-size: 12px;
  padding: 3px 10px;
  border-radius: 6px;
  color: var(--muted-foreground);
  transition: background-color 120ms, color 120ms;
}
.seg-item:hover { color: var(--foreground); }
.seg-on {
  background: var(--background);
  color: var(--foreground);
  box-shadow: 0 1px 2px rgb(0 0 0 / 0.08);
}
.rp-btn-copy {
  border-color: hsl(210 70% 55% / 0.35) !important;
  color: hsl(210 65% 45%) !important;
  background: hsl(210 70% 55% / 0.06) !important;
}
.dark .rp-btn-copy {
  color: hsl(210 70% 70%) !important;
  border-color: hsl(210 70% 60% / 0.3) !important;
}
.rp-btn-copied {
  border-color: hsl(142 60% 45% / 0.35) !important;
  color: hsl(142 71% 35%) !important;
  background: hsl(142 60% 45% / 0.08) !important;
}
.dark .rp-btn-copied { color: hsl(142 65% 60%) !important; }
</style>
