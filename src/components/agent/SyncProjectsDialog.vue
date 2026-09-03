<script setup lang="ts">
/**
 * 同步别家 AI 的项目。
 *
 * # 同步，不是导入
 *
 * 接过来的项目**指向同一个文件夹**，不复制任何东西。所以：
 *  · 文件是同一份
 *  · 规矩也是同一份 —— DSH 从项目根往下读 `AGENTS.md` 和 `CLAUDE.md` 两种，
 *    Claude Code 那边写的 CLAUDE.md，这边自动带着；反过来也一样
 *  · 技能同理（项目文件夹里的 `.dsh/skills` / `.claude/skills`）
 *
 * # 有一样同步不了，得说清楚
 *
 * **聊天记录本身**。三家的会话日志压根不是一种东西，要做到「这边聊一半切过去接着聊」
 * 得给每一对格式写双向实时转换器，而且任何一边升级格式就断，
 * 断的方式还是默默给出一段错的历史。所以两边各留各的历史。
 *
 * 界面上把这条直接写出来，不藏在帮助里 —— 让人按下按钮之后才发现，比一开始就说要糟得多。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from '@/i18n'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog'
import { external, scanExternalProjects, type ExternalProject } from '@/composables/useExternalProjects'
import { projects } from '@/composables/useProjects'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{
  (e: 'update:open', v: boolean): void
  (e: 'link', p: ExternalProject): void
}>()

const { t } = useI18n()

const q = ref('')

/** 列表长了就给个筛选框。八条以内一眼扫得完，摆个输入框反而是噪音 */
const shown = computed(() => {
  const k = q.value.trim().toLowerCase()
  if (!k) return external.items
  return external.items.filter(
    (p) => p.name.toLowerCase().includes(k) || p.path.toLowerCase().includes(k),
  )
})

watch(() => props.open, (v) => {
  if (!v) return
  q.value = ''
  void scanExternalProjects(projects.items.map((p) => p.folder))
})
</script>

<template>
  <Dialog :open="open" @update:open="(v: boolean) => emit('update:open', v)">
    <DialogContent class="sm:max-w-lg p-0 gap-0 overflow-hidden">
      <DialogHeader class="px-5 pt-5 pb-3">
        <DialogTitle>{{ t('agent.syncTitle') }}</DialogTitle>
        <DialogDescription>{{ t('agent.syncHint') }}</DialogDescription>
      </DialogHeader>

      <!-- 能同步什么、不能同步什么，摆在最前面 -->
      <div class="mx-5 mb-3 rounded-xl border border-border bg-muted/30 px-3.5 py-3">
        <p class="text-[12.5px] leading-relaxed">{{ t('agent.syncShared') }}</p>
        <p class="mt-1.5 text-[12px] text-amber-500/90 leading-relaxed">{{ t('agent.syncNotShared') }}</p>
      </div>

      <div v-if="external.items.length > 8" class="px-5 pb-2.5">
        <div class="relative">
          <span class="icon-[lucide--search] w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2
                       text-muted-foreground pointer-events-none" />
          <input v-model="q" :placeholder="t('agent.syncFilter')"
            class="w-full h-9 pl-9 pr-3 rounded-lg bg-background border border-border text-[13px]
                   placeholder:text-muted-foreground/60 focus:outline-none focus:border-foreground/25" />
        </div>
      </div>

      <div class="max-h-[20rem] overflow-y-auto px-5 pb-2">
        <p v-if="external.error" class="mb-2 text-[12px] text-red-500 wrap-break-word">{{ external.error }}</p>
        <p v-if="external.loading" class="py-8 text-center text-[13px] text-muted-foreground">…</p>

        <template v-else-if="shown.length">
          <button v-for="p in shown" :key="p.path" @click="emit('link', p)" :disabled="p.linked"
            class="w-full text-left rounded-xl border border-border px-3 py-2.5 mb-1.5 transition-colors
                   hover:bg-muted/50 disabled:opacity-45 disabled:hover:bg-transparent">
            <div class="flex items-center gap-2">
              <span class="text-[13.5px] truncate">{{ p.name }}</span>
              <span class="shrink-0 px-1.5 py-0.5 rounded text-[10.5px] bg-muted text-muted-foreground">
                {{ p.source }}
              </span>
              <!-- 会话日志还在 = 最近还在用。一堆文件夹里先看这几个 -->
              <span v-if="p.recent"
                class="shrink-0 px-1.5 py-0.5 rounded text-[10.5px] bg-emerald-500/15 text-emerald-500">
                {{ t('agent.syncRecent') }}
              </span>
              <span class="ml-auto shrink-0 text-[11px] text-muted-foreground">
                {{ p.linked ? t('agent.syncLinked') : t('agent.syncLink') }}
              </span>
            </div>
            <p class="mt-0.5 text-[11px] text-muted-foreground/70 font-mono truncate">{{ p.path }}</p>
          </button>
        </template>

        <div v-else class="py-8 text-center">
          <span class="icon-[lucide--folder-search] w-7 h-7 text-muted-foreground/40 mx-auto block" />
          <p class="mt-2.5 text-[13px] text-muted-foreground">{{ t('agent.syncNone') }}</p>
          <p class="mt-1 px-6 text-[11.5px] text-muted-foreground/70 leading-relaxed">
            {{ t('agent.syncNoneHint') }}
          </p>
        </div>
      </div>

      <div class="px-5 py-4 flex justify-end">
        <button @click="emit('update:open', false)"
          class="h-8 px-4 rounded-lg border border-border text-sm transition-colors hover:bg-muted">
          {{ t('agent.skillClose') }}
        </button>
      </div>
    </DialogContent>
  </Dialog>
</template>
