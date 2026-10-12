<script setup lang="ts">
/**
 * 「套用到」那一排：Photoshop / 达芬奇 / PhotoCraft / Affinity，主窗口字体库和 mini 小窗共用。
 * 选了 PhotoCraft 而常驻联动还没开时，旁边出一个「开启联动」（见 font_apply.rs 的常驻联动）。
 */
import { ref, watch } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { useI18n } from '@/i18n'

const props = defineProps<{ target: string; busy?: boolean }>()
const emit = defineEmits<{ change: [target: string]; notice: [text: string, bad: boolean] }>()
const { t } = useI18n()

const APPLY = [
  { id: 'photoshop', label: 'Photoshop' },
  { id: 'resolve', label: 'fonts.applyResolve' },
  { id: 'photocraft', label: 'PhotoCraft' },
  { id: 'affinity', label: 'Affinity' },
] as const

const pcLinked = ref(true)
watch(
  () => props.target,
  async (v) => {
    if (v === 'photocraft') pcLinked.value = await invoke<boolean>('font_photocraft_linked').catch(() => true)
  },
  { immediate: true },
)
async function linkPhotocraft() {
  try {
    await invoke('font_photocraft_link')
    pcLinked.value = true
    emit('notice', t('fonts.applyPhotocraftLinked'), false)
  } catch (e) {
    emit('notice', String(e), true)
  }
}
</script>

<template>
  <div class="flex items-center gap-1.5 min-w-0">
    <button v-if="target === 'photocraft' && !pcLinked" @click="linkPhotocraft" :title="t('fonts.applyPhotocraftLinkTip')"
      class="shrink-0 h-7 px-2.5 rounded-lg text-[12px] whitespace-nowrap text-amber-600 dark:text-amber-400 hover:bg-muted/60">
      {{ t('fonts.applyPhotocraftLinkBtn') }}
    </button>
    <div class="apply-seg shrink-0" :title="t('fonts.applyTip')">
      <span class="icon-[lucide--mouse-pointer-click] w-3.5 h-3.5 mx-1.5 text-muted-foreground" />
      <button v-for="a in APPLY" :key="a.id" class="apply-opt" :class="target === a.id ? 'is-on' : ''"
        @click="emit('change', target === a.id ? '' : a.id)">
        {{ a.label.startsWith('fonts.') ? t(a.label) : a.label }}
      </button>
      <span v-if="busy" class="icon-[lucide--loader-circle] w-3.5 h-3.5 mx-1 animate-spin text-muted-foreground" />
    </div>
  </div>
</template>

<style scoped>
.apply-seg {
  display: flex;
  align-items: center;
  height: 28px;
  padding: 0 2px;
  border-radius: 8px;
  border: 1px solid color-mix(in oklab, var(--border) 80%, transparent);
}
.apply-opt {
  height: 22px;
  padding: 0 8px;
  border-radius: 6px;
  font-size: 12px;
  color: var(--muted-foreground);
  white-space: nowrap;
  transition: background-color 120ms ease, color 120ms ease;
}
.apply-opt:hover { color: var(--foreground); }
.apply-opt.is-on { background: var(--muted); color: var(--foreground); font-weight: 500; }
</style>
