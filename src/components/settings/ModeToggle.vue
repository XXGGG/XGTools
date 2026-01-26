<script setup lang="ts">
import { useDark, useToggle } from '@vueuse/core'
import { Button } from '@/components/ui/button'

const isDark = useDark()
const toggleDark = useToggle(isDark)
</script>

<template>
   <Button variant="outline" size="icon" @click="toggleDark()">
      <span :class="isDark ? 'icon-[lucide--moon]' : 'icon-[lucide--sun-dim]'" class="w-5 h-5"></span>
   </Button>
</template>