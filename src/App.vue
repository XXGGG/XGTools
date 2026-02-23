<script setup lang="ts">
import { ref, onMounted, defineAsyncComponent } from 'vue';
import TitleBar from './components/TitleBar.vue';
import { useDark } from '@vueuse/core'; // 引入 useDark
import { getCurrentWindow } from '@tauri-apps/api/window';
import KeyVisualizerWindow from './KeyVisualizerWindow.vue'; //【窗口】显示按键
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';// 引入 WebviewWindow 用于创建窗口
import { emit } from '@tauri-apps/api/event'; // 引入 emit 用于事件通信
import { LazyStore } from '@tauri-apps/plugin-store'; // 引入 Store

import HomeView from './views/Home.vue';
import KeyboardPetView from './views/KeyboardPet.vue';//【页面】键盘桌宠
import DockView from './views/Dock.vue'; //【页面】启动台设置
import ScreenshotView from './views/Screenshot.vue'; //【页面】截图设置
import TranslateView from './views/Translate.vue'; //【页面】翻译
const ConvertView = defineAsyncComponent(() => import('./views/Convert.vue')); //【页面】格式转换
import DockWindow from './dock/DockWindow.vue'; //【窗口】启动台
import ScreenshotWindow from './screenshot/ScreenshotWindow.vue'; //【窗口】截图
import PinWindow from './screenshot/PinWindow.vue'; //【窗口】钉图

const currentView = ref('Home');  // 定义当前显示的页面，默认是 'Home'
// 定义菜单项
const menuItems = [
  { id: 'Home', label: '主页', icon: 'icon-[lucide--house]' },
  { id: 'Dock', label: '启动台', icon: 'icon-[lucide--layout-grid]' },
  { id: 'KeyboardPet', label: '键盘桌宠', icon: 'icon-[lucide--keyboard]' },
  { id: 'Screenshot', label: '截图', icon: 'icon-[lucide--focus]' },
  { id: 'Translate', label: '翻译', icon: 'icon-[lucide--book-type]' },
  { id: 'Convert', label: '格式转换', icon: 'icon-[lucide--refresh-ccw]' },
];

// 初始化暗黑模式 (这就够了，它会自动生效)
useDark();

// 定义是否显示键盘可视化窗口
const isKeyVisualizer = ref(false);
// 定义是否为 Dock 窗口
const isDockWindow = ref(false);
// 定义是否为截图窗口
const isScreenshotWindow = ref(false);
// 定义是否为钉图窗口
const isPinWindow = ref(false);

onMounted(async () => {
  const win = getCurrentWindow(); // 获取当前窗口实例
  if (win.label === 'key_visualizer') {
    isKeyVisualizer.value = true;
    return; // 如果是副窗口，就只做副窗口该做的事
  }
  if (win.label === 'dock') {
    isDockWindow.value = true;
    return;
  }
  if (win.label === 'screenshot') {
    isScreenshotWindow.value = true;
    return;
  }
  if (win.label.startsWith('pin_')) {
    isPinWindow.value = true;
    return;
  }

  // 初始化 Store
  const store = new LazyStore('settings.json');
  await store.init();

  // --- 恢复按键显示窗口状态 ---
  try {
    // 1. 从 Store 中获取之前 key_visualizer_enabled 的状态
    const savedKeyVisState = await store.get<boolean>('key_visualizer_enabled');
    const isKeyVisOpen = ref(false); // 临时变量用于逻辑判断

    // 检查当前窗口是否存在
    let win = await WebviewWindow.getByLabel('key_visualizer');
    if (win) {
      isKeyVisOpen.value = await win.isVisible();
    }

    if (savedKeyVisState && !isKeyVisOpen.value) {
      if (!win) {
        // 动态创建窗口
        win = new WebviewWindow('key_visualizer', {
          url: 'index.html',
          title: '',
          width: 270,
          height: 300,
          decorations: false,
          shadow: false,
          transparent: true,
          alwaysOnTop: true,
          skipTaskbar: true,
          resizable: false,
          visible: true
        });

        // 确保新建窗口处于非编辑模式
        await emit('toggle-key-visualizer-edit', false);
      } else {
        await win.show();
        await win.setFocus();
        await emit('toggle-key-visualizer-edit', false);
      }
    }
  } catch (err) {
    console.error('Failed to restore Key Visualizer state:', err);
  }

});
</script>

<template>

  <KeyVisualizerWindow v-if="isKeyVisualizer" />
  <DockWindow v-else-if="isDockWindow" />
  <ScreenshotWindow v-else-if="isScreenshotWindow" />
  <PinWindow v-else-if="isPinWindow" />

  <!-- 整个应用容器：全屏，flex 布局 -->
  <div v-else class="h-screen w-screen overflow-hidden bg-background text-foreground flex flex-col">

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
            <DockView v-else-if="currentView === 'Dock'" />
            <KeyboardPetView v-else-if="currentView === 'KeyboardPet'" />
            <ScreenshotView v-else-if="currentView === 'Screenshot'" />
            <TranslateView v-else-if="currentView === 'Translate'" />
            <ConvertView v-else-if="currentView === 'Convert'" />

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
