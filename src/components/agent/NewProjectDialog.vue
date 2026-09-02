<script setup lang="ts">
/**
 * 起个名字、挑个图标。
 *
 * 新建项目类、新建项目、给它们改名 —— 四件事要填的东西一模一样,所以是同一个对话框。
 * 做成几个长得几乎一样的框只会让人怀疑「这几个是不是不一样」。
 *
 * **改名也能重挑图标**:名字和图标一起构成「这是哪个」,只让改一半,
 * 图标就永远钉在建的那天随手点的那个上。
 */
import { ref, watch } from 'vue'
import { useI18n } from '@/i18n'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'

const props = withDefaults(defineProps<{
  open: boolean
  title: string
  placeholder: string
  /** 改名时把当前值带进来 */
  initialName?: string
  initialIcon?: string
  submitLabel?: string
}>(), { initialName: '', initialIcon: '📁', submitLabel: '' })

const emit = defineEmits<{
  (e: 'update:open', v: boolean): void
  (e: 'submit', p: { name: string; icon: string }): void
}>()

const { t } = useI18n()

const name = ref('')
const icon = ref('📁')

/**
 * 能挑的图标。
 *
 * 不做完整 emoji 面板(那要搜索、分组、肤色变体,是另一个功能),但也不能只给十来个 ——
 * 项目多起来之后图标撞脸就等于没有图标,一眼扫过去分不出哪个是哪个。
 * 按「做事的类别」铺开:资料、创作、代码、钱、生活、身份。
 */
const ICONS = [
  '📁', '📂', '🗂', '📦', '🗃', '📋', '📝', '📄',
  '🎨', '🖼', '🎬', '🎞', '📷', '🎙', '🎵', '🎧',
  '✍', '📚', '📖', '🔖', '🧠', '💡', '🔬', '🧪',
  '💻', '⚙', '🔧', '🛠', '🧩', '🚀', '🌐', '🗄',
  '💰', '📊', '📈', '🧾', '🏦', '🛒', '🎯', '📌',
  '🎮', '🕹', '🍜', '☕', '🌱', '🏠', '🚗', '✈',
  '🐳', '🦊', '🐣', '🌙', '⭐', '🔥', '❄', '🌈',
]

watch(() => props.open, (v) => {
  if (!v) return
  name.value = props.initialName
  icon.value = props.initialIcon || '📁'
})

function submit() {
  const n = name.value.trim()
  if (!n) return
  emit('submit', { name: n, icon: icon.value })
  emit('update:open', false)
}
</script>

<template>
  <Dialog :open="open" @update:open="(v: boolean) => emit('update:open', v)">
    <DialogContent class="sm:max-w-md p-0 gap-0 overflow-hidden">
      <DialogHeader class="px-5 pt-5 pb-3">
        <DialogTitle>{{ title }}</DialogTitle>
      </DialogHeader>

      <div class="px-5 space-y-3">
        <!-- 名字和当前图标并排:图标就在眼前,不用先想「我刚才选的是哪个」 -->
        <div class="flex items-center gap-2">
          <span class="size-9 shrink-0 rounded-lg bg-muted/60 flex items-center justify-center text-[18px]">
            {{ icon }}
          </span>
          <input v-model="name" autofocus @keydown.enter="submit" :placeholder="placeholder"
            class="flex-1 min-w-0 h-9 rounded-lg border border-border bg-background/40 px-2.5 text-[14px]
                   placeholder:text-muted-foreground/60 focus:outline-none focus:border-foreground/25" />
        </div>

        <!-- 图标多了要能滚,不然对话框会被撑得比屏幕还高 -->
        <div class="flex flex-wrap gap-1 max-h-40 overflow-y-auto pr-1">
          <button v-for="ic in ICONS" :key="ic" @click="icon = ic" :class="[
            'size-8 rounded-lg text-[16px] transition-colors',
            icon === ic ? 'bg-muted ring-1 ring-foreground/25' : 'hover:bg-muted/60'
          ]">{{ ic }}</button>
        </div>
      </div>

      <div class="px-5 py-4 flex justify-end gap-2">
        <button @click="emit('update:open', false)"
          class="h-8 px-3.5 rounded-lg border border-border text-sm transition-colors hover:bg-muted">
          {{ t('convert.cancel') }}
        </button>
        <button @click="submit" :disabled="!name.trim()"
          class="h-8 px-4 rounded-lg bg-foreground text-background text-sm transition-opacity
                 hover:opacity-85 disabled:opacity-40 disabled:cursor-not-allowed">
          {{ submitLabel || t('agent.projCreate') }}
        </button>
      </div>
    </DialogContent>
  </Dialog>
</template>
