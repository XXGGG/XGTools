<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow, currentMonitor, LogicalPosition } from '@tauri-apps/api/window';
// 引入 store 插件
import { LazyStore } from '@tauri-apps/plugin-store';
const store = new LazyStore('settings.json');

// 定义输入事件负载接口
interface InputPayload {
    event_type: string;
    key: string;
}

// 定义按键项接口
interface KeyItem {
    id: number;
    key: string;
    timestamp: number;
}

const keys = ref<KeyItem[]>([]); // 按键项列表
let nextId = 0; // 下一个按键项的唯一 ID 计数器
let unlisten: (() => void) | null = null;// 事件监听取消函数
let unlistenConfig: (() => void) | null = null; // 配置监听取消函数
const isEditMode = ref(false);// 是否编辑模式

// 配置
const MAX_ITEMS = 4; // 最大显示按键项数量
const PADDING = 20;

// 按键映射表 (在这里修改别名)
// 格式: '原始键名': '显示名称'
const keyMap: Record<string, string> = {
    // 修饰键
    'ControlLeft': 'Ctrl',
    'ControlRight': 'Ctrl',
    'ShiftLeft': 'Shift',
    'ShiftRight': 'Shift',
    'Alt': 'Alt',
    'AltGr': 'Alt',
    'MetaLeft': 'Win',
    'MetaRight': 'Win',
    // 兼容带 Key 前缀的情况 (防止 rdev 版本差异导致识别失败)
    'KeyControlLeft': 'Ctrl',
    'KeyControlRight': 'Ctrl',
    'KeyShiftLeft': 'Shift',
    'KeyShiftRight': 'Shift',
    'KeyAlt': 'Alt',
    'KeyMetaLeft': 'Win',
    'KeyMetaRight': 'Win',

    // 常用功能键
    'Space': 'Space',
    'Return': 'Enter',
    'Escape': 'Esc',
    'Backspace': 'Backspace',
    'Tab': 'Tab',
    'CapsLock': 'Caps',
    'Delete': 'Del',
    'Home': 'Home',
    'End': 'End',
    'PageUp': 'PgUp',
    'PageDown': 'PgDn',
    'Insert': 'Ins',
    'PrintScreen': 'PrtSc',
    'ScrollLock': 'ScrlLk',
    'Pause': 'Pause',
    'NumLock': 'Num',

    // 方向键
    'UpArrow': '↑',
    'DownArrow': '↓',
    'LeftArrow': '←',
    'RightArrow': '→',

    // rdev 可能是 Up/Down/Left/Right
    'Up': '↑',
    'Down': '↓',
    'Left': '←',
    'Right': '→',

    // 符号
    'Dot': '.',
    'Comma': ',',
    'SemiColon': ';',
    'Quote': "'",
    'LeftBracket': '[',
    'RightBracket': ']',
    'BackSlash': '\\',
    'Slash': '/',
    'Minus': '-',
    'Equal': '=',
    'BackQuote': '`',
};

// 状态跟踪
const activeModifiers = ref<Set<string>>(new Set());
// 标记修饰键按下期间是否有其他键按下
const modifierDirty = ref<Record<string, boolean>>({});

// 辅助函数：获取显示名称
const getDisplayName = (rawKey: string): string => {
    if (keyMap[rawKey]) return keyMap[rawKey];
    // 处理 F1-F12
    if (/^KeyF\d+$/.test(rawKey)) return rawKey.replace('Key', '');
    // 处理数字 Digit0-9
    if (/^Digit\d$/.test(rawKey)) return rawKey.replace('Digit', '');
    // 处理字母 KeyA-KeyZ
    if (/^Key[A-Z]$/.test(rawKey)) return rawKey.replace('Key', '');
    // 处理小键盘 Num1-Num9
    if (/^Num\d$/.test(rawKey)) return rawKey.replace('Num', '');

    // 默认处理
    return rawKey.replace('Key', '');
};

// 辅助函数：判断是否为修饰键
const isModifier = (key: string): boolean => {
    return ['Ctrl', 'Shift', 'Alt', 'Win'].includes(key);
};

// 辅助函数：添加按键到显示列表
const addKeyToDisplay = (displayText: string) => {
    // 如果是重复的最后一个按键，可能只想更新时间或不做处理？
    // 这里我们简单点，每次都加新的，顶掉旧的
    keys.value.unshift({
        id: nextId++,
        key: displayText,
        timestamp: Date.now()
    });

    if (keys.value.length > MAX_ITEMS) {
        keys.value.pop();
    }
};

// 辅助函数：更新窗口位置 (右下角)
const updateWindowPosition = async () => {
    const win = getCurrentWindow(); // 获取当前窗口实例
    const monitor = await currentMonitor(); // 获取当前窗口所在的屏幕

    if (monitor) {
        const scaleFactor = monitor.scaleFactor; // 获取屏幕缩放因子
        const logicalScreenWidth = monitor.size.width / scaleFactor;
        const logicalScreenHeight = monitor.size.height / scaleFactor;
        const winWidth = 270;
        const winHeight = 300;

        const x = logicalScreenWidth - winWidth - PADDING;
        const y = logicalScreenHeight - winHeight - PADDING - 60;

        await win.setPosition(new LogicalPosition(x, y));
    }
};

// 检测窗口位置并更新布局模式
// const updateLayoutMode = async () => {
//     try {
//         const win = getCurrentWindow();
//         const pos = await win.outerPosition();
//         const size = await win.outerSize();
//         const monitor = await currentMonitor();

//         if (monitor) {
//             const factor = monitor.scaleFactor;
//             // 窗口中心点的逻辑坐标
//             const windowCenterX = (pos.x + size.width / 2) / factor;
//             const windowCenterY = (pos.y + size.height / 2) / factor;

//             // 屏幕中心点
//             const screenCenterX = monitor.size.width / factor / 2;
//             const screenCenterY = monitor.size.height / factor / 2;

//             // 判断窗口在屏幕的哪个象限
//             const isLeft = windowCenterX < screenCenterX;
//             const isTop = windowCenterY < screenCenterY;

//             if (isLeft && isTop) {
//                 layoutMode.value = 'left-top';
//             } else if (!isLeft && isTop) {
//                 layoutMode.value = 'right-top';
//             } else if (isLeft && !isTop) {
//                 layoutMode.value = 'left-bottom';
//             } else {
//                 layoutMode.value = 'right-bottom';
//             }

//         }
//     } catch (err) {
//         console.error('Failed to update layout mode:', err);
//     }
// };

// 保存窗口位置
const saveWindowPosition = async () => {
    try {
        const win = getCurrentWindow();
        const pos = await win.outerPosition(); // Returns PhysicalPosition
        const monitor = await currentMonitor();

        if (monitor) {
            const factor = monitor.scaleFactor;
            // 转换为逻辑坐标保存，防止 DPI 缩放导致的偏移
            const logicalX = pos.x / factor;
            const logicalY = pos.y / factor;

            await store.set('key_visualizer_position', { x: logicalX, y: logicalY });
            await store.save();
            console.log('Window position saved (Logical):', { x: logicalX, y: logicalY });

            // 更新布局模式
            // await updateLayoutMode();
        }
    } catch (err) {
        console.error('Failed to save window position:', err);
    }
};

// 恢复窗口位置
const restoreWindowPosition = async () => {
    try {
        const savedPos = await store.get<{ x: number, y: number }>('key_visualizer_position');
        if (savedPos && typeof savedPos.x === 'number' && typeof savedPos.y === 'number') {
            const win = getCurrentWindow();
            await win.setPosition(new LogicalPosition(savedPos.x, savedPos.y));
            console.log('Window position restored:', savedPos);
        } else {
            await updateWindowPosition();// 恢复默认位置
            console.log('No saved position found. Restored to default position.');
        }
        // 恢复位置后更新布局模式
        // await updateLayoutMode();
    } catch (err) {
        console.error('Failed to restore window position:', err);
        await updateWindowPosition();// 恢复默认位置
        // await updateLayoutMode();
    }
};

onMounted(async () => {

    // 初始化 Store
    await store.init();

    // 强制设置透明背景
    document.documentElement.style.backgroundColor = 'transparent';
    document.body.style.backgroundColor = 'transparent';

    const win = getCurrentWindow();// 获取当前窗口实例

    try {
        // 默认开启鼠标穿透 (忽略鼠标事件)
        await win.setIgnoreCursorEvents(true);
    } catch (e) {
        console.error('setIgnoreCursorEvents failed:', e);
    }

    // 恢复位置
    await restoreWindowPosition();

    // 监听配置变更事件
    unlistenConfig = await listen('toggle-key-visualizer-edit', async (event: any) => {
        const enabled = event.payload;
        isEditMode.value = enabled;
        // 如果是编辑模式，不忽略鼠标 (可以点击/拖拽)
        // 如果是正常模式，忽略鼠标 (穿透)
        await win.setIgnoreCursorEvents(!enabled);

        if (enabled) {
            // 编辑模式下，显示并置顶，确保用户能看到
            await win.show();
            await win.setFocus();
        } else {
            // 退出编辑模式时，保存位置
            await saveWindowPosition(); //添加这一行，确保退出编辑模式时保存位置
        }
    });

    // 监听重置位置事件
    await listen('reset-key-visualizer-position', async () => {
        console.log('Resetting window position...');
        await updateWindowPosition(); // 恢复默认位置
        await saveWindowPosition();   // 保存新位置
    });



    // 监听输入事件
    unlisten = await listen<InputPayload>('input-event', (event) => {
        // console.log('Received input-event:', event.payload); // 打印原始事件
        // event_type: KeyPress/KeyRelease/ButtonPress
        // key: 原始按键名称 (如 KeyA, KeyF1, Digit0, etc.)
        const { event_type, key } = event.payload; 
        // 转换为显示名称 (如 KeyA -> A, KeyF1 -> F1, Digit0 -> 0)
        const displayName = getDisplayName(key);

        
        // 按键事件处理 KeyPress 意思是【按键按下】
        if (event_type === 'KeyPress') {
            // 【处理组合按钮，例如 Ctrl+A，Ctrl+Alt+A】
            if (isModifier(displayName)) {
                // 修饰键（Ctrl/Shift/Alt/Win）按下
                // 只在首次按下时添加到 activeModifiers
                if (!activeModifiers.value.has(displayName)) {
                    activeModifiers.value.add(displayName);
                    modifierDirty.value[displayName] = false; // 只有首次按下重置状态
                }
            } else {
                // 普通按键按下
                // 标记所有当前按下的修饰键为 dirty (已使用)
                activeModifiers.value.forEach(m => modifierDirty.value[m] = true);

                // 构建组合字符串
                // 顺序：Ctrl -> Shift -> Alt -> Win -> Key
                const combo: string[] = [];
                if (activeModifiers.value.has('Ctrl')) combo.push('Ctrl');
                if (activeModifiers.value.has('Shift')) combo.push('Shift');
                if (activeModifiers.value.has('Alt')) combo.push('Alt');
                if (activeModifiers.value.has('Win')) combo.push('Win');

                combo.push(displayName); //最后连接普通按键
                addKeyToDisplay(combo.join(' + '));//用 + 号连接，例如：Ctrl + A
            }
        } else if (event_type === 'KeyRelease') {//【处理按键释放事件】
            if (isModifier(displayName)) { //如果是修饰键
                // 如果修饰键释放，且期间没有被使用过（没有与其他键组合），则单独显示
                if (modifierDirty.value[displayName] === false) {
                    addKeyToDisplay(displayName);
                }
                activeModifiers.value.delete(displayName);
                delete modifierDirty.value[displayName];
            }
        } else if (event_type === 'ButtonPress') {//【处理鼠标按键事件】
            // 鼠标按键
            let mouseKey = key;
            if (key === 'Left') mouseKey = '左键';
            if (key === 'Right') mouseKey = '右键';
            if (key === 'Middle') mouseKey = '中键';

            // 鼠标也可以配合修饰键
            const combo: string[] = [];
            if (activeModifiers.value.has('Ctrl')) combo.push('Ctrl');
            if (activeModifiers.value.has('Shift')) combo.push('Shift');
            if (activeModifiers.value.has('Alt')) combo.push('Alt');
            if (activeModifiers.value.has('Win')) combo.push('Win');

            combo.push(mouseKey);
            addKeyToDisplay(combo.join(' + '));
        }
    });
});

// 组件卸载时，移除事件监听
onUnmounted(() => {
    if (unlisten) unlisten(); //移除输入事件监听
    if (unlistenConfig) unlistenConfig(); //移除配置变更事件监听
});
</script>



<template>
    <!-- 
    根容器
    isEditMode=true: 显示背景，允许鼠标事件 (pointer-events-auto)
    isEditMode=false: 透明背景，禁止鼠标事件 (pointer-events-none)
  -->
    <div class="h-full w-full flex flex-col-reverse items-end p-0 overflow-hidden transition-colors duration-300 relative"
        :class="{
            'bg-black border-2 border-dashed border-yellow-400 pointer-events-auto': isEditMode,
            'bg-transparent pointer-events-none': !isEditMode
        }">
        <!-- 拖拽区域：仅在编辑模式下存在，覆盖全屏 -->
        <div v-if="isEditMode" data-tauri-drag-region class="absolute inset-0 z-0 cursor-move"></div>

        <!-- 提示文字 -->
        <div v-if="isEditMode" class="absolute top-2 left-2 text-yellow-400 font-bold text-xs pointer-events-none z-10">
            Drag to Move
        </div>

        <!-- 按键列表容器 (z-10 确保在拖拽层之上) -->
        <TransitionGroup name="list" tag="div"
            class="flex flex-col-reverse items-end w-full z-10 pointer-events-none pb-2 pr-2">
            <div v-for="(item, index) in keys" :key="item.id" class="mb-2 transition-all duration-300" :class="{
                'opacity-100 scale-100': index === 0,
                'opacity-70 scale-90': index === 1,
                'opacity-40 scale-80': index === 2,
                'opacity-10 scale-75': index >= 3
            }">
                <div
                    class="bg-black/70 text-white px-4 py-2 rounded-lg backdrop-blur-sm font-mono font-bold text-xl border border-white/10">
                    {{ item.key }}
                </div>
            </div>
        </TransitionGroup>
    </div>
</template>

<style scoped>
.list-move,
.list-enter-active,
.list-leave-active {
    transition: all 0.3s ease;
}

.list-enter-from {
    opacity: 0;
    transform: translateY(20px);
}

.list-leave-to {
    opacity: 0;
    transform: translateY(-20px);
}

/* 确保列表项在移动时绝对定位，实现平滑过渡 */
.list-leave-active {
    position: absolute;
}
</style>