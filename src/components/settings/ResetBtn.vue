<script setup lang="ts">
/**
 * 设置行尾的「恢复默认」小按钮：和默认值不一样时才亮，一样时占着位置但看不见（免得整行跳来跳去）。
 */
defineProps<{ show: boolean }>()
defineEmits<{ reset: [] }>()
</script>

<template>
  <button class="shrink-0 size-5 grid place-items-center rounded text-muted-foreground hover:text-foreground transition-opacity"
    :class="show ? 'opacity-100' : 'opacity-0 pointer-events-none'" title="恢复默认" @click="$emit('reset')">
    <span class="icon-[lucide--rotate-ccw] w-3.5 h-3.5" />
  </button>
</template>
