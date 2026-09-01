<script setup lang="ts">
/**
 * 新建项目。
 *
 * 只问三件事:叫什么、归哪一类、用什么图标。**文件夹留到进去之后再选** ——
 * 建项目的当下人还在想「我要开始做这件事」,不该马上被拽去文件资源管理器里翻目录;
 * 而且没有文件夹这个项目也能先立着,想清楚了再绑。
 *
 * 分类可以直接打字新建,不用先去别处「管理分类」——大类本来就是随手起的名字。
 */
import { ref, watch } from 'vue'
import { useI18n } from '@/i18n'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog'

const props = defineProps<{ open: boolean; categories: string[] }>()
const emit = defineEmits<{
  (e: 'update:open', v: boolean): void
  (e: 'create', p: { name: string; category: string; icon: string }): void
}>()

const { t } = useI18n()

const name = ref('')
const category = ref('')
const icon = ref('📁')

/** 随手能挑的几个。不做完整 emoji 面板 —— 这里只是给项目一个能认出来的脸 */
const ICONS = ['📁', '💰', '🎬', '✍', '📚', '🧪', '🎨', '🎮', '🧠', '📷', '🍜', '🏠']

watch(() => props.open, (v) => {
  if (!v) return
  name.value = ''
  category.value = ''
  icon.value = '📁'
})

function submit() {
  const n = name.value.trim()
  if (!n) return
  emit('create', { name: n, category: category.value.trim(), icon: icon.value })
  emit('update:open', false)
}
</script>

<template>
  <Dialog :open="open" @update:open="(v: boolean) => emit('update:open', v)">
    <DialogContent class="sm:max-w-md p-0 gap-0 overflow-hidden">
      <DialogHeader class="px-5 pt-5 pb-3">
        <DialogTitle>{{ t('agent.newProject') }}</DialogTitle>
        <DialogDescription>{{ t('agent.newProjectHint') }}</DialogDescription>
      </DialogHeader>

      <div class="px-5 space-y-3">
        <div>
          <p class="text-xs text-muted-foreground mb-1.5">{{ t('agent.projName') }}</p>
          <input v-model="name" autofocus @keydown.enter="submit"
            :placeholder="t('agent.projNamePlaceholder')"
            class="w-full h-9 rounded-lg border border-border bg-background/40 px-2.5 text-[14px]
                   placeholder:text-muted-foreground/60 focus:outline-none focus:border-foreground/25" />
        </div>

        <div>
          <p class="text-xs text-muted-foreground mb-1.5">{{ t('agent.projCategory') }}</p>
          <input v-model="category" list="xg-proj-cats" @keydown.enter="submit"
            :placeholder="t('agent.projCategoryPlaceholder')"
            class="w-full h-9 rounded-lg border border-border bg-background/40 px-2.5 text-[14px]
                   placeholder:text-muted-foreground/60 focus:outline-none focus:border-foreground/25" />
          <!-- 已有的大类给个下拉,新的直接打字 —— 不为「管理分类」单开一个界面 -->
          <datalist id="xg-proj-cats">
            <option v-for="c in categories" :key="c" :value="c" />
          </datalist>
        </div>

        <div>
          <p class="text-xs text-muted-foreground mb-1.5">{{ t('agent.projIcon') }}</p>
          <div class="flex flex-wrap gap-1">
            <button v-for="ic in ICONS" :key="ic" @click="icon = ic" :class="[
              'size-8 rounded-lg text-[16px] transition-colors',
              icon === ic ? 'bg-muted ring-1 ring-foreground/25' : 'hover:bg-muted/60'
            ]">{{ ic }}</button>
          </div>
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
          {{ t('agent.projCreate') }}
        </button>
      </div>
    </DialogContent>
  </Dialog>
</template>
