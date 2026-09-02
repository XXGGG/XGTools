<script setup lang="ts">
/**
 * 技能库。
 *
 * # 这个界面要回答的问题
 *
 * 1. 我一共有哪些技能 —— 它们散在好几个地方(自己写的、Claude Code 的、Codex 的),
 *    平时没有一个地方看得见全貌。过一阵子谁都记不住自己弄过什么
 * 2. 它们从哪儿来 —— 所以按**目录**分组,而不是揉成一个大列表
 * 3. AI 知不知道往哪儿放新的
 *
 * # 为什么按目录分组而不是「全局 / 项目」
 *
 * 因为现在的做法是**指向,不复制**:技能原件留在各自的位置,我们只是把目录名单
 * 报给 DSH。那么「它在哪个目录」就是这份技能最真实的身份 —— 想改它、想同步它,
 * 都得回到那个目录去。按来源分组,这条路才是通的。
 */
import { watch, ref } from 'vue'
import { useI18n } from '@/i18n'
import { open as openFolderDialog } from '@tauri-apps/plugin-dialog'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog'
import {
  skills, skillGroups, skillCount, loadSkills, prettyPath,
  addSkillRoot, removeSkillRoot, toggleSkillRoot, revealDir,
  taught, checkTaught, teachSkillLocation, DSH_ROOT_ID, type Skill,
} from '@/composables/useSkills'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{
  (e: 'update:open', v: boolean): void
  (e: 'open-skill', s: Skill): void
  (e: 'restart-engine'): void
}>()

const { t } = useI18n()

/** 收起来的目录。技能多了之后,一次只想看一个来源 */
const folded = ref<Record<string, boolean>>({})

// 每次打开都重扫。技能是磁盘上的文件,可能刚在外面加了一个;
// 缓存住的话他会以为「加了没生效」
watch(() => props.open, (v) => {
  if (!v) return
  void loadSkills()
  void checkTaught()
})

async function pickFolder() {
  const picked = await openFolderDialog({ directory: true, multiple: false })
  if (typeof picked === 'string') await addSkillRoot(picked)
}
</script>

<template>
  <Dialog :open="open" @update:open="(v: boolean) => emit('update:open', v)">
    <DialogContent class="sm:max-w-2xl p-0 gap-0 overflow-hidden">
      <DialogHeader class="px-5 pt-5 pb-3">
        <DialogTitle>{{ t('agent.skills') }}<span v-if="skillCount" class="ml-2 text-[13px] font-normal text-muted-foreground">{{ skillCount }}</span></DialogTitle>
        <DialogDescription>{{ t('agent.skillsHint') }}</DialogDescription>
      </DialogHeader>

      <!-- 改了目录名单要重启边车才生效:配置是启动时读的 -->
      <div v-if="skills.needsRestart"
        class="mx-5 mb-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3.5 py-2.5
               flex items-center gap-2.5">
        <span class="icon-[lucide--refresh-cw] w-4 h-4 shrink-0 text-amber-500" />
        <p class="flex-1 text-[12.5px] leading-relaxed">{{ t('agent.skillRestart') }}</p>
        <button @click="emit('restart-engine')"
          class="shrink-0 h-7 px-2.5 rounded-lg border border-border bg-background text-[12px]
                 transition-colors hover:bg-muted">
          {{ t('agent.skillRestartNow') }}
        </button>
      </div>

      <!-- 「AI 知不知道往哪儿放」。知道了就不用再开这个界面，聊天里丢给它就行 -->
      <div class="mx-5 mb-3 rounded-xl border border-border bg-muted/30 px-3.5 py-3 flex items-start gap-2.5">
        <span class="w-4 h-4 mt-0.5 shrink-0"
          :class="taught.known ? 'icon-[lucide--circle-check] text-emerald-500'
                               : 'icon-[lucide--circle-help] text-muted-foreground'" />
        <div class="min-w-0 flex-1">
          <p class="text-[13px] leading-relaxed">
            {{ taught.known ? t('agent.skillTaughtYes') : t('agent.skillTaughtNo') }}
          </p>
          <p class="mt-1 text-[11.5px] text-muted-foreground leading-relaxed">
            {{ taught.known ? t('agent.skillTaughtYesHint') : t('agent.skillTaughtNoHint') }}
          </p>
        </div>
        <button @click="teachSkillLocation" :disabled="taught.busy"
          class="shrink-0 h-7 px-2.5 rounded-lg border border-border text-[12px] transition-colors
                 hover:bg-muted disabled:opacity-40">
          {{ taught.known ? t('agent.skillRewrite') : t('agent.skillTeach') }}
        </button>
      </div>

      <div class="max-h-[24rem] overflow-y-auto px-5 pb-2">
        <p v-if="skills.error" class="mb-2 text-[12px] text-red-500 wrap-break-word">{{ skills.error }}</p>
        <p v-if="skills.loading && !skills.items.length"
          class="py-8 text-center text-[13px] text-muted-foreground">…</p>

        <!-- 一个目录一块。关掉的整块变灰 —— 它还在，只是这一阵不参与 -->
        <div v-for="g in skillGroups" :key="g.root.id"
          class="mb-2 rounded-xl border border-border overflow-hidden"
          :class="g.root.enabled ? '' : 'opacity-45'">
          <div class="flex items-center gap-2 px-3 py-2 bg-muted/30">
            <button @click="folded[g.root.id] = !folded[g.root.id]"
              class="w-3.5 h-3.5 shrink-0 text-muted-foreground"
              :class="folded[g.root.id] ? 'icon-[lucide--chevron-right]' : 'icon-[lucide--chevron-down]'" />
            <span class="text-[13px] font-medium truncate">{{ g.root.label }}</span>
            <span class="text-[11px] text-muted-foreground tabular-nums">
              {{ g.cats.reduce((n, c) => n + c.items.length, 0) }}
            </span>
            <span v-if="!g.root.exists" class="text-[11px] text-amber-500">{{ t('agent.skillDirGone') }}</span>

            <span class="flex-1" />
            <button @click="revealDir(g.root.path)" :title="g.root.path"
              class="size-6 rounded-md flex items-center justify-center text-muted-foreground
                     transition-colors hover:bg-muted hover:text-foreground">
              <span class="icon-[lucide--folder-open] w-3.5 h-3.5" />
            </button>
            <button v-if="g.root.id !== DSH_ROOT_ID" @click="toggleSkillRoot(g.root.id)"
              :title="g.root.enabled ? t('agent.skillDirOff') : t('agent.skillDirOn')"
              class="size-6 rounded-md flex items-center justify-center text-muted-foreground
                     transition-colors hover:bg-muted hover:text-foreground">
              <span class="w-3.5 h-3.5"
                :class="g.root.enabled ? 'icon-[lucide--eye]' : 'icon-[lucide--eye-off]'" />
            </button>
            <button v-if="!g.root.builtin" @click="removeSkillRoot(g.root.id)" :title="t('agent.skillDirDrop')"
              class="size-6 rounded-md flex items-center justify-center text-muted-foreground
                     transition-colors hover:bg-muted hover:text-foreground">
              <span class="icon-[lucide--x] w-3.5 h-3.5" />
            </button>
          </div>

          <!-- 主目录收成 ~，截图发出去不会带着用户名 -->
          <p class="px-3 pt-1.5 text-[10.5px] text-muted-foreground/70 font-mono truncate">{{ prettyPath(g.root.path) }}</p>

          <div v-if="!folded[g.root.id]" class="p-1.5 pt-1">
            <p v-if="!g.cats.length" class="px-2 py-2 text-[12px] text-muted-foreground">
              {{ t('agent.skillDirEmpty') }}
            </p>
            <template v-for="c in g.cats" :key="c.name || '_'">
              <p v-if="c.name" class="px-2 pt-2 pb-1 text-[11px] text-muted-foreground">{{ c.name }}</p>
              <button v-for="s in c.items" :key="s.path" @click="emit('open-skill', s)"
                class="w-full text-left rounded-lg px-2 py-1.5 transition-colors hover:bg-muted/60">
                <div class="flex items-center gap-2">
                  <span class="icon-[lucide--sparkles] w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                  <span class="text-[13px] truncate">{{ s.name }}</span>
                </div>
                <p v-if="s.description"
                  class="mt-0.5 pl-5.5 text-[11.5px] text-muted-foreground leading-relaxed line-clamp-2">
                  {{ s.description }}
                </p>
              </button>
            </template>
          </div>
        </div>

        <button @click="pickFolder"
          class="w-full h-9 rounded-xl border border-dashed border-border text-[12.5px]
                 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground">
          ＋ {{ t('agent.skillDirAdd') }}
        </button>
        <p class="mt-1.5 px-1 text-[11px] text-muted-foreground/70 leading-relaxed">
          {{ t('agent.skillDirAddHint') }}
        </p>
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
