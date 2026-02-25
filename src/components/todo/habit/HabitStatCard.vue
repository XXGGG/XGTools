<script setup lang="ts">
defineProps<{
  label: string
  value: string | number
  icon?: string
  suffix?: string
}>()
</script>

<template>
  <div class="flex flex-col items-center gap-1 p-3 rounded-lg border bg-card">
    <span v-if="icon" :class="icon" class="w-4 h-4 text-muted-foreground/50" />
    <span class="text-lg font-semibold tabular-nums">{{ value }}<span v-if="suffix" class="text-sm font-normal text-muted-foreground">{{ suffix }}</span></span>
    <span class="text-[10px] text-muted-foreground/60 uppercase tracking-wider">{{ label }}</span>
  </div>
</template>
