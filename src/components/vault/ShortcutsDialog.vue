<script setup lang="ts">
/**
 * 笔记编辑器的快捷键一览。
 *
 * # 为什么要有这张表
 *
 * 快捷键是这个编辑器里**唯一完全看不见**的功能：按钮至少还摆在工具栏上，
 * 而 Ctrl+Shift+9 不告诉人，一辈子都不会有人按到。
 * 藏起来的东西等于不存在。
 *
 * # 为什么带搜索
 *
 * 三十来条，找「加粗」要用眼睛扫五组。搜索框认两头：打「加粗」能找到，
 * 打「B」也能找到 —— 人有时候记得按过哪个键，只是忘了它干嘛的。
 */
import { ref, computed, watch } from 'vue'
import { useI18n } from '@/i18n'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ (e: 'update:open', v: boolean): void }>()

const { t } = useI18n()

/** ⌘ 还是 Ctrl。写死 Ctrl 的话 Mac 上整张表都是错的 */
const MOD = navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Ctrl'

/**
 * 一行 = 一件事 + 一组键。
 *
 * 键写成数组，中间的 `/` 由模板画 —— 「Alt+↑ / Alt+↓」这种一组两个的，
 * 拿字符串拼会连斜杠一起套进键帽的框里，看着像一个键叫「Alt+↑/Alt+↓」。
 */
type Row = { id: string; keys: string[] }
type Group = { id: string; rows: Row[] }

const GROUPS: Group[] = [
  {
    id: 'format',
    rows: [
      { id: 'bold', keys: [`${MOD}+B`] },
      { id: 'italic', keys: [`${MOD}+I`] },
      { id: 'underline', keys: [`${MOD}+U`] },
      { id: 'code', keys: [`${MOD}+E`] },
      { id: 'strike', keys: [`${MOD}+Shift+X`] },
      { id: 'mark', keys: [`${MOD}+Shift+H`] },
      { id: 'link', keys: [`${MOD}+K`] },
      { id: 'clear', keys: [`${MOD}+\\`] },
    ],
  },
  {
    id: 'block',
    rows: [
      { id: 'h1to6', keys: [`${MOD}+1`, '…', `${MOD}+6`] },
      { id: 'h0', keys: [`${MOD}+0`] },
      { id: 'quote', keys: [`${MOD}+Shift+Q`] },
      { id: 'bullet', keys: [`${MOD}+Shift+8`] },
      { id: 'ordered', keys: [`${MOD}+Shift+7`] },
      { id: 'task', keys: [`${MOD}+Shift+9`] },
      { id: 'rule', keys: [`${MOD}+Shift+-`] },
    ],
  },
  {
    id: 'list',
    rows: [
      { id: 'indent', keys: ['Tab', 'Shift+Tab'] },
      { id: 'continue', keys: ['Enter'] },
      { id: 'outdent', keys: ['Backspace'] },
    ],
  },
  {
    id: 'edit',
    rows: [
      { id: 'save', keys: [`${MOD}+S`] },
      { id: 'closeTab', keys: [`${MOD}+W`] },
      { id: 'undo', keys: [`${MOD}+Z`, `${MOD}+Shift+Z`] },
      { id: 'moveLine', keys: ['Alt+↑', 'Alt+↓'] },
      { id: 'copyLine', keys: ['Shift+Alt+↑', 'Shift+Alt+↓'] },
      { id: 'delLine', keys: [`${MOD}+Shift+K`] },
      { id: 'nextOccur', keys: [`${MOD}+D`] },
    ],
  },
  {
    id: 'find',
    rows: [
      { id: 'search', keys: [`${MOD}+F`] },
      { id: 'nextHit', keys: ['F3', 'Shift+F3'] },
      { id: 'gotoLine', keys: [`${MOD}+Alt+G`] },
    ],
  },
]

const q = ref('')
watch(() => props.open, (v) => { if (!v) q.value = '' })

/**
 * 搜索同时看说明和键名。整组都没命中就整组不画 ——
 * 留一个只剩标题的空组，比不画更让人以为「这组里没有」。
 */
const shown = computed(() => {
  const kw = q.value.trim().toLowerCase()
  if (!kw) return GROUPS
  return GROUPS
    .map((g) => ({
      ...g,
      rows: g.rows.filter((r) =>
        t(`vault.sc_${r.id}`).toLowerCase().includes(kw) ||
        r.keys.join(' ').toLowerCase().includes(kw)),
    }))
    .filter((g) => g.rows.length)
})
</script>

<template>
  <Dialog :open="open" @update:open="(v: boolean) => emit('update:open', v)">
    <DialogContent class="sm:max-w-xl p-0 gap-0 overflow-hidden">
      <DialogHeader class="px-5 pt-5 pb-3">
        <DialogTitle>{{ t('vault.shortcuts') }}</DialogTitle>
        <DialogDescription>{{ t('vault.shortcutsHint') }}</DialogDescription>
      </DialogHeader>

      <div class="px-5 pb-3">
        <div class="relative">
          <span class="icon-[lucide--search] w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2
                       text-muted-foreground pointer-events-none" />
          <input v-model="q" :placeholder="t('vault.shortcutsSearch')"
            class="w-full h-8 pl-8 pr-2.5 rounded-lg bg-muted/50 border border-border text-[13px]
                   outline-none focus:border-ring" />
        </div>
      </div>

      <div class="max-h-[26rem] overflow-y-auto px-5 pb-4">
        <div v-for="g in shown" :key="g.id" class="mb-4 last:mb-0">
          <p class="mb-1 px-1 text-[11px] text-muted-foreground">{{ t(`vault.scg_${g.id}`) }}</p>
          <div class="rounded-xl border border-border overflow-hidden">
            <div v-for="(r, i) in g.rows" :key="r.id"
              class="flex items-center gap-3 px-3 py-2 text-[13px]"
              :class="i ? 'border-t border-border/60' : ''">
              <span class="flex-1 min-w-0">{{ t(`vault.sc_${r.id}`) }}</span>
              <span class="shrink-0 flex items-center gap-1">
                <template v-for="(k, j) in r.keys" :key="j">
                  <span v-if="k === '…'" class="text-[11px] text-muted-foreground">…</span>
                  <kbd v-else class="px-1.5 py-0.5 rounded-md bg-muted border border-border
                                     text-[11px] text-muted-foreground whitespace-nowrap">{{ k }}</kbd>
                </template>
              </span>
            </div>
          </div>
        </div>

        <p v-if="!shown.length" class="py-10 text-center text-[13px] text-muted-foreground">
          {{ t('vault.shortcutsNone') }}
        </p>
      </div>
    </DialogContent>
  </Dialog>
</template>
