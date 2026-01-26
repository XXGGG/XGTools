<script setup lang="ts">
import ModeToggle from "../components/settings/ModeToggle.vue";
import AutostartToggle from '../components/settings/AutostartToggle.vue';
</script>

<template>
    <div class="h-full flex flex-col p-8 space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
        <!-- 欢迎头部 -->
        <div class="flex flex-col items-center justify-center space-y-4 py-8">
            <div class="text-6xl mb-4 hover:scale-110 transition-transform cursor-default">👋</div>
            <h1 class="text-4xl font-bold bg-linear-to-r from-primary to-purple-600 bg-clip-text text-transparent">
                Welcome to XGTools
            </h1>
        </div>

        <!-- 快速设置区域 -->
        <div class="grid gap-4 md:grid-cols-2 max-w-4xl mx-auto w-full">
            <!-- 1. 外观设置 -->
            <div
                class="flex items-center justify-between p-4 border rounded-xl bg-card/50 backdrop-blur-sm hover:bg-card/80 transition-colors shadow-sm">
                <div class="flex items-center gap-3">
                    <div class="flex p-2 bg-primary/10 rounded-lg text-primary">
                        <div class="icon-[lucide--sun] w-5 h-5"></div>
                    </div>
                    <div>
                        <h3 class="font-medium">外观主题</h3>
                        <p class="text-xs text-muted-foreground">深色 / 浅色模式</p>
                    </div>
                </div>
                <!-- 切换暗黑模式 -->
                <ModeToggle />
            </div>

            <!-- 2. 开机自启 -->
            <div
                class="flex items-center justify-between p-4 border rounded-xl bg-card/50 backdrop-blur-sm hover:bg-card/80 transition-colors shadow-sm">
                <div class="flex items-center gap-3">
                    <div class="flex p-2 bg-primary/10 rounded-lg text-primary">
                        <div class="icon-[lucide--power] w-5 h-5"></div>
                    </div>
                    <div>
                        <h3 class="font-medium">开机自启</h3>
                        <p class="text-xs text-muted-foreground">跟随系统启动</p>
                    </div>
                </div>
                <!-- 开机自启模块 -->
                <AutostartToggle />
            </div>
        </div>
    </div>
</template>