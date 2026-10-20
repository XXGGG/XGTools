<script setup lang="ts">
/**
 * 设置 → 大模型：本机 Ollama 连哪、用哪个模型，翻译 / 提示词 / 笔记各自开不开思考。
 * 思考开关只在模型支持思考时能开；翻译默认关（开了一句话要先想十几秒）。
 */
import { computed, onMounted, ref } from 'vue'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { LLM_DEFAULTS, listLocalModels, loadLlm, saveLlm, syncTranslateCustom, type LlmCfg, type LlmFeature, type LocalModel } from '@/lib/llm'

const cfg = ref<LlmCfg>({ ...LLM_DEFAULTS, think: { ...LLM_DEFAULTS.think } })
const models = ref<LocalModel[] | null>(null)
const checking = ref(false)

const current = computed(() => models.value?.find(m => m.name === cfg.value.model))
const canThink = computed(() => !!current.value?.think)

const FEATURES: { id: LlmFeature; icon: string; title: string; tip: string }[] = [
  { id: 'translate', icon: 'icon-[lucide--languages]', title: '翻译', tip: '翻译页、截图翻译、提示词页里用到本机模型的翻译。开了思考，一句话要先想十几秒，一般不用开。' },
  { id: 'prompt', icon: 'icon-[lucide--wand-sparkles]', title: '提示词', tip: '提示词页的 Anima 打磨。用的是内置的提示词，专门把中文描述写成 Anima 认得的标签和英文句子。' },
  { id: 'notes', icon: 'icon-[lucide--notebook-pen]', title: '笔记', tip: '笔记里让大模型改写、续写、念给你听。' },
]

async function refresh() {
  checking.value = true
  models.value = await listLocalModels(cfg.value.url)
  checking.value = false
}

async function save() {
  // 模型不支持思考，开关全按关存
  if (!canThink.value) cfg.value.think = { translate: false, prompt: false, notes: false }
  await saveLlm(cfg.value)
  // 翻译的「AI 自定义接口」指到同一个本机模型
  await syncTranslateCustom(cfg.value)
}

function gb(n: number) {
  return `${(n / 1024 ** 3).toFixed(1)} GB`
}

onMounted(async () => {
  cfg.value = { ...(await loadLlm()) }
  await refresh()
})
</script>

<template>
  <div class="space-y-6">
    <section class="space-y-2">
      <h3 class="text-sm font-medium">本机模型</h3>
      <div class="rounded-xl border divide-y">
        <div class="flex items-center gap-4 px-4 py-3.5">
          <span class="icon-[lucide--server] w-5 h-5 shrink-0 text-muted-foreground" />
          <div class="flex-1 min-w-0 text-sm">Ollama 地址</div>
          <Input v-model="cfg.url" class="w-64 h-8" @change="save(); refresh()" />
          <button class="text-xs text-muted-foreground hover:text-foreground" :disabled="checking" @click="refresh">
            <span class="icon-[lucide--refresh-cw] w-4 h-4" :class="{ 'animate-spin': checking }" />
          </button>
        </div>
        <div class="flex items-center gap-4 px-4 py-3.5">
          <span class="icon-[lucide--brain] w-5 h-5 shrink-0 text-muted-foreground" />
          <div class="flex-1 min-w-0">
            <div class="text-sm">模型</div>
            <div v-if="models === null" class="text-xs text-muted-foreground">连不上 Ollama：没装或没开，用到大模型的功能会退回原来的做法</div>
            <div v-else-if="!models.length" class="text-xs text-muted-foreground">Ollama 里还没有模型</div>
            <div v-else-if="current" class="text-xs text-muted-foreground">
              {{ gb(current.size) }} · {{ current.think ? '支持思考' : '不支持思考' }}{{ current.vision ? ' · 能看图' : '' }}
            </div>
          </div>
          <Select :model-value="cfg.model" :disabled="!models?.length" @update:model-value="(v: any) => { cfg.model = String(v); save() }">
            <SelectTrigger class="w-56 h-8">
              <SelectValue placeholder="选一个模型" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem v-for="m in models ?? []" :key="m.name" :value="m.name">{{ m.name }}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    </section>

    <section class="space-y-2">
      <h3 class="text-sm font-medium">思考模式</h3>
      <div class="rounded-xl border divide-y">
        <div v-for="f in FEATURES" :key="f.id" class="flex items-center gap-4 px-4 py-3.5">
          <span :class="f.icon" class="w-5 h-5 shrink-0 text-muted-foreground" />
          <div class="flex-1 min-w-0 flex items-center gap-1.5 text-sm">
            {{ f.title }}
            <span class="icon-[lucide--info] w-3.5 h-3.5 text-muted-foreground/70" :title="f.tip" />
          </div>
          <Switch :model-value="canThink && cfg.think[f.id]" :disabled="!canThink"
            :title="canThink ? '' : '这个模型不支持思考'"
            @update:model-value="(v: boolean) => { cfg.think[f.id] = v; save() }" />
        </div>
      </div>
    </section>
  </div>
</template>
