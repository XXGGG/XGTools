<script setup lang="ts">
/**
 * 同步别家 AI 的项目。
 *
 * # 一个会话就是一个项目
 *
 * 同一个文件夹里可以同时进行好几摊完全不相干的活：`c:\XGCode` 底下既在改 XGTools，
 * 又在弄 ComfyUI 的视频生成，还在管服务器安全。它们**共用一个工作区，但不是同一个项目** ——
 * 各有各的上下文、各有各的进度。
 *
 * 所以这张表的主角是**会话**，不是文件夹。只按文件夹列的话，那十几摊活会塌成一条。
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
import {
  external, scanExternalProjects,
  type ExternalProject, type ExternalSession,
} from '@/composables/useExternalProjects'
import { projects } from '@/composables/useProjects'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{
  (e: 'update:open', v: boolean): void
  (e: 'link', p: ExternalProject): void
  (e: 'linkSession', s: ExternalSession): void
}>()

const { t } = useI18n()
const q = ref('')

const hit = (s: string) => s.toLowerCase().includes(q.value.trim().toLowerCase())

const shownSessions = computed(() =>
  q.value.trim() ? external.sessions.filter((s) => hit(s.title) || hit(s.cwd)) : external.sessions,
)
const shownFolders = computed(() =>
  q.value.trim() ? external.items.filter((p) => hit(p.name) || hit(p.path)) : external.items,
)
const empty = computed(() => !shownSessions.value.length && !shownFolders.value.length)

/** 「刚刚 / 3 小时前 / 前天」。绝对时间在这儿没用 —— 要判断的是「这摊活还热着吗」 */
function ago(ms: number): string {
  const m = Math.max(0, Math.floor((Date.now() - ms) / 60000))
  if (m < 2) return t('agent.agoNow')
  if (m < 60) return t('agent.agoMin', { n: String(m) })
  const h = Math.floor(m / 60)
  if (h < 24) return t('agent.agoHour', { n: String(h) })
  return t('agent.agoDay', { n: String(Math.floor(h / 24)) })
}

/** 只有一个工作区时不必每条都写路径 —— 那时候它是废话 */
const oneFolder = computed(
  () => new Set(external.sessions.map((s) => s.cwd.toLowerCase())).size <= 1,
)

function leaf(p: string) {
  return p.split(/[\\/]/).filter(Boolean).pop() || p
}

watch(() => props.open, (v) => {
  if (!v) return
  q.value = ''
  void scanExternalProjects(
    projects.items.map((p) => p.folder),
    projects.items.map((p) => p.originId ?? ''),
  )
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

      <div v-if="external.sessions.length + external.items.length > 8" class="px-5 pb-2.5">
        <div class="relative">
          <span class="icon-[lucide--search] w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2
                       text-muted-foreground pointer-events-none" />
          <input v-model="q" :placeholder="t('agent.syncFilter')"
            class="w-full h-9 pl-9 pr-3 rounded-lg bg-background border border-border text-[13px]
                   placeholder:text-muted-foreground/60 focus:outline-none focus:border-foreground/25" />
        </div>
      </div>

      <div class="max-h-88 overflow-y-auto px-5 pb-2">
        <p v-if="external.error" class="mb-2 text-[12px] text-red-500 wrap-break-word">{{ external.error }}</p>
        <p v-if="external.loading" class="py-8 text-center text-[13px] text-muted-foreground">…</p>

        <template v-else>
          <!-- ── 会话：一个会话就是一个项目 ── -->
          <template v-if="shownSessions.length">
            <p class="px-0.5 pb-1.5 text-[11.5px] text-muted-foreground/80">
              {{ t('agent.syncSessions') }}
            </p>
            <button v-for="s in shownSessions" :key="s.id" @click="emit('linkSession', s)" :disabled="s.linked"
              class="w-full text-left rounded-xl border border-border px-3 py-2.5 mb-1.5 transition-colors
                     hover:bg-muted/50 disabled:opacity-45 disabled:hover:bg-transparent">
              <div class="flex items-center gap-2">
                <span class="text-[13.5px] truncate" :class="s.named ? 'font-medium' : ''">{{ s.title }}</span>
                <span class="ml-auto shrink-0 text-[11px] text-muted-foreground">
                  {{ s.linked ? t('agent.syncLinked') : t('agent.syncLink') }}
                </span>
              </div>
              <p class="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground/70">
                <span class="tabular-nums">{{ ago(s.mtime) }}</span>
                <!-- 都在同一个工作区时路径是废话,只在混着几个文件夹时才写 -->
                <template v-if="!oneFolder">
                  <span class="opacity-50">·</span>
                  <span class="font-mono truncate" :title="s.cwd">{{ leaf(s.cwd) }}</span>
                </template>
              </p>
            </button>
          </template>

          <!-- ── 文件夹：没有会话记录的（日志过期清掉了） ── -->
          <template v-if="shownFolders.length">
            <p class="px-0.5 pt-2 pb-1.5 text-[11.5px] text-muted-foreground/80">
              {{ t('agent.syncFolders') }}
            </p>
            <button v-for="p in shownFolders" :key="p.path" @click="emit('link', p)" :disabled="p.linked"
              class="w-full text-left rounded-xl border border-border px-3 py-2.5 mb-1.5 transition-colors
                     hover:bg-muted/50 disabled:opacity-45 disabled:hover:bg-transparent">
              <div class="flex items-center gap-2">
                <span class="text-[13.5px] truncate">{{ p.name }}</span>
                <span class="shrink-0 px-1.5 py-0.5 rounded text-[10.5px] bg-muted text-muted-foreground">
                  {{ p.source }}
                </span>
                <span class="ml-auto shrink-0 text-[11px] text-muted-foreground">
                  {{ p.linked ? t('agent.syncLinked') : t('agent.syncLink') }}
                </span>
              </div>
              <p class="mt-0.5 text-[11px] text-muted-foreground/70 font-mono truncate">{{ p.path }}</p>
            </button>
          </template>

          <div v-if="empty" class="py-8 text-center">
            <span class="icon-[lucide--folder-search] w-7 h-7 text-muted-foreground/40 mx-auto block" />
            <p class="mt-2.5 text-[13px] text-muted-foreground">{{ t('agent.syncNone') }}</p>
            <p class="mt-1 px-6 text-[11.5px] text-muted-foreground/70 leading-relaxed">
              {{ t('agent.syncNoneHint') }}
            </p>
          </div>
        </template>
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
