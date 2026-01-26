<script setup lang="ts">
import { Window } from '@tauri-apps/api/window';
import { ref, onMounted } from 'vue';

// 获取当前窗口实例
const appWindow = Window.getCurrent();
const isMaximized = ref(false);

// 最小化
const minimize = () => appWindow.minimize();

// 最大化/还原
const toggleMaximize = async () => {
    await appWindow.toggleMaximize();
    isMaximized.value = await appWindow.isMaximized();
};

// 关闭
const close = () => appWindow.close();

// 初始化时检查状态
onMounted(async () => {
    isMaximized.value = await appWindow.isMaximized();
});
</script>

<template>
    <!-- 
    data-tauri-drag-region: 这是关键属性！
    它告诉 Tauri：按住这块区域可以拖动窗口。
  -->
    <div data-tauri-drag-region
        class="h-10 flex items-center justify-between bg-background select-none fixed top-0 left-0 right-0 z-50">
        <!-- border-b 下方加条横线，但是我不要....-->
         
        <!-- 左侧 -->
        <!-- pointer-events-none 防止图标拦截拖动事件 -->
        <div></div>

        <!-- 右侧：窗口控制按钮 -->
        <!-- 这里的按钮不需要拖动功能，所以正常点击即可 -->
        <div class="flex h-full">

            <!-- 最小化 -->
            <button @click="minimize"
                class="w-12 h-full flex items-center justify-center hover:bg-muted transition-colors text-foreground">
                <span class="icon-[lucide--minus]"></span>
            </button>

            <!-- 最大化/还原 -->
            <button @click="toggleMaximize"
                class="w-12 h-full flex items-center justify-center hover:bg-muted transition-colors text-foreground">
                <span class="icon-[lucide--square]"></span>
            </button>

            <!-- 关闭 (红色背景高亮) -->
            <button @click="close"
                class="w-12 h-full flex items-center justify-center hover:bg-red-500 hover:text-white transition-colors text-foreground">
                <span class="icon-[lucide--x]"></span>
            </button>
        </div>
    </div>
</template>