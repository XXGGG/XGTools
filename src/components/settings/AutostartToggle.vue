<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { enable, disable, isEnabled } from '@tauri-apps/plugin-autostart';
import { Switch } from '@/components/ui/switch';

const autostartActive = ref(false);

// 初始化时检查当前状态
onMounted(async () => {
   try {
      autostartActive.value = await isEnabled();
   } catch (error) {
      console.error('Failed to check autostart status:', error);
   }
});

// 切换处理函数
const toggleAutostart = async (checked: boolean) => {
   try {
      if (checked) {
         await enable();
         console.log('Autostart enabled');
      } else {
         await disable();
         console.log('Autostart disabled');
      }
      autostartActive.value = checked;
   } catch (error) {
      console.error('Failed to toggle autostart:', error);
      // 失败时回滚状态
      autostartActive.value = !checked;
   }
};
</script>

<template>
      <Switch id="autostart-mode" :model-value="autostartActive" @update:model-value="toggleAutostart" />
</template>