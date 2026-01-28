<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { emit } from '@tauri-apps/api/event';
import { LazyStore } from '@tauri-apps/plugin-store';
import { LogicalSize } from '@tauri-apps/api/window';

const isKeyVisOpen = ref(false); // 是否打开按键可视化窗口
const isEditMode = ref(false);  // 是否编辑模式
const isAvoidMouse = ref(false); // 是否躲避鼠标
const isAutoClear = ref(false); // 是否启用自动清除
const store = new LazyStore('settings.json');

// 切换编辑模式
const toggleEditMode = async () => {
    isEditMode.value = !isEditMode.value;
    await emit('toggle-key-visualizer-edit', isEditMode.value);
};

// 重置窗口位置
const resetWindowPosition = async () => {
    try {
        const win = await WebviewWindow.getByLabel('key_visualizer');
        if (win) {
            // 1. 检查是否被最小化，如果是则恢复
            if (await win.isMinimized()) {
                await win.unminimize();
            }

            // 2. 确保窗口可见
            if (!(await win.isVisible())) {
                await win.show();
            }

            // 3. 强制恢复默认尺寸 (270x300)
            await win.setSize(new LogicalSize(270, 300));

            // 4. 发送重置位置事件 (让窗口自己移动到右下角)
            await emit('reset-key-visualizer-position');
        }
    } catch (error) {
        console.error('Failed to reset position:', error);
    }
};

// 切换躲避鼠标
const toggleAvoidMouse = async () => {
    // 发送躲避事件
    isAvoidMouse.value = !isAvoidMouse.value;
    await emit('toggle-avoid-mouse', isAvoidMouse.value);
    // 6. 同步配置到 store
    await store.set('avoid_mouse', isAvoidMouse.value);
};

// 检查窗口状态并同步配置
const checkWindowState = async () => {
    // 1. 初始化 store
    await store.init();

    // 2. 获取保存的配置
    const savedState = await store.get<boolean>('key_visualizer_enabled');

    // 3. 检查当前窗口是否真的存在
    const win = await WebviewWindow.getByLabel('key_visualizer');
    if (win) {
        isKeyVisOpen.value = await win.isVisible();
    }

    // 4. 如果配置是开启的，但窗口没开 (比如应用刚启动)，则自动开启
    if (savedState && !isKeyVisOpen.value) {
        await toggleKeyVis();
    }

    // 5. 是否有开启躲避鼠标
    isAvoidMouse.value = await store.get<boolean>('avoid_mouse') || false; 
        
    // ✅ 新增：恢复自动清除配置
    isAutoClear.value = await store.get<boolean>('auto_clear_enabled') || false;
};

onMounted(() => {
    checkWindowState();
});

// 切换自动清除
const toggleAutoClear = async () => {
    isAutoClear.value = !isAutoClear.value;

    // 发送事件到 KeyVisualizerWindow
    await emit('toggle-auto-clear', isAutoClear.value);

    // 保存配置到 store
    await store.set('auto_clear_enabled', isAutoClear.value);
    await store.save();

    console.log('自动清除功能:', isAutoClear.value ? '已开启' : '已关闭');
};

// 切换按键可视化窗口
const toggleKeyVis = async () => {
    try {
        let win = await WebviewWindow.getByLabel('key_visualizer');

        if (!win) {
            // 动态创建窗口
            win = new WebviewWindow('key_visualizer', {
                url: 'index.html',
                title: 'key_visualizer',
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

            // 监听创建错误
            win.once('tauri://error', (e) => {
                console.error('Failed to create window:', e);
                alert('无法创建按键显示窗口，请尝试重启应用。' + JSON.stringify(e));
            });

            // 监听创建完成事件
            win.once('tauri://created', () => {
                console.log('[Pet.vue] Window created event received');
            });

            // 重置编辑模式
            isEditMode.value = false;
            // 同步编辑模式到窗口
            await emit('toggle-key-visualizer-edit', false);

            // 窗口打开状态
            isKeyVisOpen.value = true;
            // 保存状态
            await store.set('key_visualizer_enabled', true);
            await store.save();
            return;
        }

        // 如果窗口可见
        if (isKeyVisOpen.value) {
            // 那么久把窗口关闭
            await win.hide();
            isKeyVisOpen.value = false;

            // 关闭时也重置编辑模式
            isEditMode.value = false;
            await emit('toggle-key-visualizer-edit', false);

            // 保存状态
            await store.set('key_visualizer_enabled', false);
            await store.save();
        } else {
            // 否则窗口就打开
            await win.show();
            isKeyVisOpen.value = true;
            // await win.setFocus(); // 确保窗口获得焦点
            // await win.center(); // 强制居中，防止跑偏 (已移除，避免影响位置恢复)

            // 窗口打开时默认关闭编辑模式
            isEditMode.value = false;
            await emit('toggle-key-visualizer-edit', false);

            
            // 调试提示
            const isVisible = await win.isVisible();
            if (!isVisible) {
                alert('警告：窗口已调用 show() 但 isVisible 仍为 false。请检查 tauri.conf.json 配置。');
            }

            // 保存状态
            await store.set('key_visualizer_enabled', true);
            await store.save();
        }
    } catch (error) {
        console.error('Toggle error:', error);
        alert('操作失败: ' + String(error));
    }
};
onUnmounted(() => {
    // 组件卸载时，发送关闭编辑模式事件
    emit('toggle-key-visualizer-edit', false);
});
</script>

<template>
    <div class="h-full w-full p-8 flex flex-col space-y-4">
        <!-- 极简版按键显示控制 -->
        <div class="w-full max-w-2xl mx-auto bg-card border rounded-xl p-4 flex items-center justify-between shadow-sm">
            <div class="flex items-center gap-4">
                <div class="flex p-2 bg-primary/10 rounded-lg text-primary">
                    <span class="icon-[lucide--keyboard] w-6 h-6" />
                </div>
                <span class="font-bold text-lg">按键显示</span>
            </div>

            <div class="flex items-center gap-2">
                <!-- ✅ 新增：自动清除按钮 (在躲避按钮之前) -->
                <button v-if="isKeyVisOpen" @click="toggleAutoClear" class="flex p-2 rounded-lg transition-colors"
                    :class="isAutoClear
                        ? 'bg-blue-500 text-white hover:bg-blue-600'
                        : 'hover:bg-accent text-muted-foreground hover:text-foreground'" title="自动清除">
                    <span class="icon-[lucide--eraser] w-6 h-6" />
                </button>

                <!-- 躲避按钮 (仅开启时显示) -->
                <button v-if="isKeyVisOpen" @click="toggleAvoidMouse" class="flex p-2 rounded-lg transition-colors"
                    :class="isAvoidMouse ? 'bg-green-500 text-white hover:bg-green-600' : 'hover:bg-accent text-muted-foreground hover:text-foreground'"
                    title="躲避鼠标">
                    <span class="icon-[lucide--square-dashed-mouse-pointer] w-6 h-6" />
                </button>

                <!-- 重置位置按钮 (仅开启时显示) -->
                <button v-if="isKeyVisOpen" @click="resetWindowPosition"
                    class="flex p-2 rounded-lg transition-colors hover:bg-accent text-muted-foreground hover:text-foreground"
                    title="重置位置">
                    <span class="icon-[lucide--rotate-ccw] w-6 h-6" />
                </button>

                <!-- 移动/调整位置按钮 (仅开启时显示) -->
                <button v-if="isKeyVisOpen" @click="toggleEditMode" class="flex p-2 rounded-lg transition-colors"
                    :class="isEditMode ? 'bg-yellow-500 text-white hover:bg-yellow-600' : 'hover:bg-accent text-muted-foreground hover:text-foreground'"
                    title="调整位置">
                    <span class="icon-[lucide--move] w-6 h-6" />
                </button>

                <!-- 开关按钮 -->
                <button @click="toggleKeyVis" class="flex p-2 rounded-lg transition-colors"
                    :class="isKeyVisOpen ? 'text-primary hover:bg-primary/10' : 'text-muted-foreground hover:text-foreground hover:bg-accent'"
                    :title="isKeyVisOpen ? '关闭显示' : '开启显示'">
                    <span :class="isKeyVisOpen? 'icon-[lucide--eye]' : 'icon-[lucide--eye-off]'" class="w-6 h-6" />
                </button>
            </div>
        </div>

        <!-- 桌宠区域 (占满剩余空间) -->
        <div
            class="w-full max-w-2xl mx-auto flex-1 bg-card border rounded-xl p-8 flex flex-col items-center justify-center space-y-6 shadow-sm opacity-60">
            <div class="flex p-6 bg-muted rounded-full text-muted-foreground">
                <span class="icon-[lucide--cat] w-20 h-20" />
            </div>
            <div class="text-center space-y-2">
                <h3 class="font-bold text-2xl">键盘桌宠</h3>
                <p class="text-muted-foreground">
                    可爱的键盘桌宠，即将来袭。
                </p>
            </div>
            <button disabled
                class="px-8 py-3 bg-muted text-muted-foreground rounded-full font-medium cursor-not-allowed">
                开发中...
            </button>
        </div>
    </div>
</template>
