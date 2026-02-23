<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { enable, disable, isEnabled } from '@tauri-apps/plugin-autostart'
import { Button } from '@/components/ui/button'

const active = ref(false)

onMounted(async () => {
  try {
    active.value = await isEnabled()
  } catch {}
})

async function toggle() {
  try {
    if (active.value) {
      await disable()
      active.value = false
    } else {
      await enable()
      active.value = true
    }
  } catch (e) {
    console.error('Failed to toggle autostart:', e)
  }
}
</script>

<template>
  <Button
    variant="ghost"
    size="icon"
    @click="toggle"
    :title="active ? '已开启自启' : '开启自启'"
    :class="active ? 'text-foreground' : 'text-muted-foreground/50'"
  >
    <span class="icon-[lucide--power] w-5 h-5" />
  </Button>
</template>
