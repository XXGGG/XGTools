<script setup lang="ts">
/**
 * 「等你拍板」的那张卡片:工具要权限、智能体要问你一句、计划要你过目。
 *
 * # 为什么三种长得不一样
 *
 * 协议上「审批」和「提问」是两套回法,而提问还能带一个**呈现意图**
 * (`intent`)声明「这个问题本质上是哪一类决定」。计划评审(`plan-review`)
 * 就是这么一类:它不是一道选择题,是一份写好的方案摆在你面前等一句「行」。
 * 认得这个意图的界面该把它画成计划,不认得的画成普通选项 —— 两种画法回给
 * 模型的答案一模一样,所以这里只是画得更贴切,没有另立协议。
 *
 * # 为什么单独成一个组件
 *
 * 智能体页和笔记页右侧那栏都要能回。不抽出来的话同一套逻辑得写两遍,
 * 而这块**漏回一次那次工具调用就永远挂着**,是最不该有两份实现的地方。
 *
 * `compact` 给笔记页那栏用:同一套结构,尺寸小一号。
 */
import { ref, computed } from 'vue'
import { chat, answerApproval, answerQuestions } from '@/composables/useDshChat'
import type { QuestionItem } from '@/composables/useDshChat'
import { renderChatMd } from '@/composables/useChatMarkdown'
import { useI18n } from '@/i18n'

defineProps<{ compact?: boolean }>()

const { t } = useI18n()

/** 多选题的勾选状态,按 问题id → 选项文字 存 */
const picked = ref<Record<string, string[]>>({})
/** 「其他」里手打的答案 */
const custom = ref<Record<string, string>>({})

const question = computed(() => (chat.pending?.kind === 'question' ? chat.pending : null))

/** 这一组问题是不是一份等你过目的计划 */
const planReview = computed(() => {
  const q = question.value?.questions
  return q?.length === 1 && q[0].intent?.kind === 'plan-review' ? q[0] : null
})

function toggle(q: QuestionItem, label: string) {
  const cur = picked.value[q.id] ?? []
  picked.value = { ...picked.value, [q.id]: cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label] }
}

/** 单选:点一下就是答完了,不用再按提交 —— 少一步是少一步 */
function pickOne(q: QuestionItem, label: string) {
  const rest = (question.value?.questions ?? []).filter((x) => x.id !== q.id)
  const answers = [
    { id: q.id, selected: [label], custom: custom.value[q.id]?.trim() || undefined },
    ...rest.map((x) => ({ id: x.id, selected: picked.value[x.id] ?? [], custom: custom.value[x.id]?.trim() || undefined })),
  ]
  submit(answers)
}

function submitAll() {
  const answers = (question.value?.questions ?? []).map((q) => ({
    id: q.id,
    selected: picked.value[q.id] ?? [],
    custom: custom.value[q.id]?.trim() || undefined,
  }))
  submit(answers)
}

function submit(answers: { id: string; selected: string[]; custom?: string }[]) {
  picked.value = {}
  custom.value = {}
  void answerQuestions(answers)
}

/** 一组问题里,还有哪一道没给出任何答案 */
const canSubmit = computed(() =>
  (question.value?.questions ?? []).every((q) =>
    (picked.value[q.id]?.length ?? 0) > 0 || (custom.value[q.id] ?? '').trim().length > 0))
</script>

<template>
  <!-- 审批 -->
  <div v-if="chat.pending?.kind === 'approval'"
    :class="['rounded-2xl border border-amber-500/40 bg-amber-500/5', compact ? 'p-2.5' : 'p-4']">
    <div class="flex items-start gap-2.5">
      <span class="icon-[lucide--hand] shrink-0 text-amber-500"
        :class="compact ? 'w-3.5 h-3.5 mt-0.5' : 'w-4 h-4 mt-0.5'" />
      <div class="min-w-0 flex-1">
        <p :class="compact ? 'text-[12px] font-medium' : 'text-sm font-medium'">
          {{ t('agent.approveTitle', { tool: chat.pending.toolName }) }}
        </p>
        <p v-if="chat.pending.reason"
          class="mt-1 text-xs leading-relaxed text-muted-foreground wrap-break-word">
          {{ chat.pending.reason }}
        </p>
        <div class="mt-3 flex flex-wrap gap-2">
          <button @click="answerApproval(true)"
            class="h-8 px-3.5 rounded-lg bg-foreground text-background text-sm transition-opacity hover:opacity-85">
            {{ t('agent.approveAllow') }}
          </button>
          <button @click="answerApproval(false)"
            class="h-8 px-3.5 rounded-lg border border-border text-sm transition-colors hover:bg-muted">
            {{ t('agent.approveDeny') }}
          </button>
        </div>
      </div>
    </div>
  </div>

  <!--
    计划评审:把方案本身当主角。
    正文按 markdown 渲染(模型写的计划就是 markdown),批准那颗按钮用实心 ——
    它是这张卡片存在的意义,不该和「再改改」长得一样。
  -->
  <div v-else-if="planReview"
    :class="['rounded-2xl border border-violet-500/40 bg-violet-500/5', compact ? 'p-2.5' : 'p-4']">
    <div class="flex items-center gap-2">
      <span class="icon-[lucide--list-checks] w-4 h-4 shrink-0 text-violet-500" />
      <p :class="compact ? 'text-[12px] font-medium' : 'text-sm font-medium'">
        {{ planReview.header || t('agent.planReview') }}
      </p>
    </div>
    <p class="mt-1 text-xs text-muted-foreground">{{ planReview.question }}</p>
    <div v-if="planReview.detail"
      class="chat-md mt-2.5 max-h-72 overflow-auto rounded-xl bg-background/50 px-3 py-2 text-[13px]"
      v-html="renderChatMd(planReview.detail)" />
    <div class="mt-3 flex flex-wrap gap-2">
      <button v-for="o in planReview.options" :key="o.label" @click="pickOne(planReview, o.label)"
        :title="o.description"
        :class="['h-8 px-3.5 rounded-lg text-sm transition-colors',
                 o.label === planReview.intent?.approve
                   ? 'bg-foreground text-background hover:opacity-85'
                   : 'border border-border hover:bg-muted']">
        {{ o.label }}
      </button>
    </div>
  </div>

  <!-- 普通提问:一道或几道选择题,外加一个想自己打字时用的输入框 -->
  <div v-else-if="question"
    :class="['rounded-2xl border border-sky-500/40 bg-sky-500/5', compact ? 'p-2.5' : 'p-4']">
    <div class="flex items-center gap-2">
      <span class="icon-[lucide--message-circle-question] w-4 h-4 shrink-0 text-sky-500" />
      <p :class="compact ? 'text-[12px] font-medium' : 'text-sm font-medium'">{{ t('agent.askTitle') }}</p>
    </div>

    <div v-for="q in question.questions" :key="q.id" class="mt-3 first:mt-2">
      <p v-if="q.header" class="text-[11px] uppercase tracking-wide text-muted-foreground">{{ q.header }}</p>
      <p class="text-sm">{{ q.question }}</p>
      <p v-if="q.detail" class="mt-1 text-xs leading-relaxed text-muted-foreground wrap-break-word">{{ q.detail }}</p>

      <div class="mt-2 flex flex-wrap gap-2">
        <button v-for="o in q.options" :key="o.label"
          @click="q.multiSelect ? toggle(q, o.label) : pickOne(q, o.label)"
          :title="o.description"
          :class="['h-8 px-3.5 rounded-lg text-sm transition-colors',
                   (picked[q.id] ?? []).includes(o.label)
                     ? 'bg-foreground text-background'
                     : 'border border-border hover:bg-muted']">
          <span v-if="q.multiSelect && (picked[q.id] ?? []).includes(o.label)"
            class="icon-[lucide--check] w-3.5 h-3.5 mr-1 -ml-0.5 inline-block align-[-2px]" />
          {{ o.label }}
        </button>
      </div>

      <!-- 选项都不合适时的出口。协议本来就允许 custom 和选项并存 -->
      <input v-model="custom[q.id]" :placeholder="t('agent.askOther')"
        class="mt-2 w-full h-8 rounded-lg border border-border bg-background/40 px-2.5 text-[13px]
               placeholder:text-muted-foreground/60 focus:outline-none focus:border-foreground/25" />
    </div>

    <!-- 单选点一下就走了;多选和自由输入要自己按一下 -->
    <button v-if="question.questions.some((q) => q.multiSelect) || question.questions.length > 1"
      @click="submitAll" :disabled="!canSubmit"
      class="mt-3 h-8 px-3.5 rounded-lg bg-foreground text-background text-sm transition-opacity
             hover:opacity-85 disabled:opacity-40 disabled:cursor-not-allowed">
      {{ t('agent.askSubmit') }}
    </button>
  </div>
</template>
