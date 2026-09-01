<script setup lang="ts">
/**
 * 「规矩」编辑面板。
 *
 * 两栏切换:全局(所有项目都生效)和这个文件夹(只在这个项目里生效)。
 * 里面就是一个大文本框 —— 写的是给人看的大白话,不是配置项,
 * 所以不做表单、不做开关,一句一句写下去就行。
 *
 * 没选工作区的时候只剩全局那一栏:没有文件夹就没有「这个项目」可言,
 * 摆一个写了也没处存的框子只会让人白写一遍。
 */
import { computed } from 'vue'
import { rules, saveRules, RULE_EXAMPLES } from '@/composables/useAgentRules'
import { useI18n } from '@/i18n'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog'

const { t } = useI18n()

const text = computed({
  get: () => (rules.tab === 'global' ? rules.globalText : rules.workspaceText),
  set: (v: string) => {
    if (rules.tab === 'global') rules.globalText = v
    else rules.workspaceText = v
  },
})

/** 这一栏写在哪个文件里。写出来是让人心里有底:这不是存在某个看不见的地方 */
const where = computed(() =>
  rules.tab === 'global' ? '~/.dsh/AGENTS.md' : `${rules.workspacePath}\\AGENTS.md`)

function useExample() {
  text.value = RULE_EXAMPLES[rules.tab]
}
</script>

<template>
  <Dialog :open="rules.open" @update:open="(v: boolean) => { rules.open = v }">
    <DialogContent class="sm:max-w-2xl p-0 gap-0 overflow-hidden">
      <DialogHeader class="px-5 pt-5 pb-3">
        <DialogTitle>{{ t('agent.rulesTitle') }}</DialogTitle>
        <DialogDescription>{{ t('agent.rulesHint') }}</DialogDescription>
      </DialogHeader>

      <!-- 两栏:作用范围不同,不能混在一个框里 -->
      <div class="px-5 flex items-center gap-1">
        <button v-for="tab in (['workspace', 'global'] as const)" :key="tab"
          :disabled="tab === 'workspace' && !rules.workspacePath"
          @click="rules.tab = tab" :class="[
            'h-8 px-3 rounded-lg text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed',
            rules.tab === tab ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'
          ]">
          {{ tab === 'global' ? t('agent.rulesGlobal') : t('agent.rulesWorkspace') }}
        </button>
        <span class="ml-auto text-[11px] font-mono text-muted-foreground truncate max-w-[16rem]"
          :title="where">{{ where }}</span>
      </div>

      <div class="px-5 pt-3">
        <textarea v-model="text" :placeholder="t('agent.rulesPlaceholder')"
          class="w-full h-64 resize-none rounded-xl border border-border bg-background/40 px-3 py-2.5
                 text-[14px] leading-relaxed placeholder:text-muted-foreground/60
                 focus:outline-none focus:border-foreground/25" />
      </div>

      <div class="px-5 py-4 flex items-center gap-2">
        <!-- 空框子最难的是第一句写什么,给个起点 -->
        <button @click="useExample"
          class="h-8 px-3 rounded-lg border border-border text-[13px] text-muted-foreground
                 transition-colors hover:bg-muted hover:text-foreground">
          {{ t('agent.rulesExample') }}
        </button>
        <p v-if="rules.error" class="text-xs text-red-500 truncate">{{ rules.error }}</p>
        <button @click="saveRules"
          class="ml-auto h-8 px-4 rounded-lg bg-foreground text-background text-sm
                 transition-opacity hover:opacity-85">
          {{ rules.saved ? t('agent.rulesSaved') : t('agent.rulesSave') }}
        </button>
      </div>
    </DialogContent>
  </Dialog>
</template>
