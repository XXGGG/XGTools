<script setup lang="ts">
import { ref } from 'vue';
import TitleBar from './components/TitleBar.vue';

import HomeView from './views/Home.vue';

const currentView = ref('Home');  // 定义当前显示的页面，默认是 'Home'
// 定义菜单项
const menuItems = [
  { id: 'Home', label: '主页', icon: 'icon-[lucide--house]' },
  { id: 'KeyboardPet', label: '键盘桌宠', icon: 'icon-[lucide--keyboard]' },
  { id: 'Screenshot', label: '截图', icon: 'icon-[lucide--focus]' },
  { id: 'Translate', label: '翻译', icon: 'icon-[lucide--book-type]' },
  { id: 'Convert', label: '格式转换', icon: 'icon-[lucide--refresh-ccw]' },
];
</script>

<template>

  <!-- 整个应用容器：全屏，flex 布局 -->
  <div class="h-screen w-screen overflow-hidden bg-background text-foreground flex flex-col">

    <!-- 1. 顶部标题栏 -->
    <TitleBar />

    <!-- 2. 下方主体内容 (Sidebar + Content) -->
    <div class="flex-1 flex overflow-hidden pt-4">

      <!-- 左侧侧边栏 Sidebar -->
      <aside class="w-50 flex flex-col">
        <!-- Logo 区域 -->
        <div class="p-6 flex items-center gap-2">
          <img src="/app-icon.png" alt="XGTools" class="w-8 h-8" />
          <span class="font-bold text-xl">XGTools</span>
        </div>

        <!-- 导航菜单 -->
        <nav class="flex-1 px-4 space-y-2">
          <button v-for="item in menuItems" :key="item.id" @click="currentView = item.id" :class="[
            'w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-all duration-200 text-sm font-medium',
            currentView === item.id
              ? 'bg-primary text-primary-foreground shadow-md'
              : 'hover:bg-muted text-muted-foreground hover:text-foreground'
          ]">
            <!-- 动态组件显示图标 -->
            <span :class="item.icon" class="w-5 h-5"/>
            {{ item.label }}
          </button>
        </nav>

      </aside>

      <!-- 右侧内容区 Content -->
      <main class="flex-1 overflow-auto bg-background/50 relative">
        <!-- 使用 Transition 组件实现切换动画 -->
        <Transition enter-active-class="transition-all duration-300 ease-out" enter-from-class="opacity-0 translate-y-4"
          enter-to-class="opacity-100 translate-y-0"
          leave-active-class="transition-all duration-200 ease-in absolute top-0 w-full" leave-from-class="opacity-100"
          leave-to-class="opacity-0 -translate-y-4">
          <!-- 根据 currentView 显示不同组件 -->
          <div :key="currentView" class="h-full w-full">
            <HomeView v-if="currentView === 'Home'" />

            <!-- 还没做的功能先显示这个 -->
            <div v-else class="h-full flex flex-col items-center justify-center text-muted-foreground">
              <span :class="menuItems.find(i => i.id === currentView)?.icon" class="w-16 h-16 mb-4 opacity-20"></span>
              <p>🚧 {{menuItems.find(i => i.id === currentView)?.label}} 功能开发中...</p>
            </div>
          </div>
        </Transition>
      </main>

    </div>
  </div>
</template>