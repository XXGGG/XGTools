<script setup lang="ts">
import { Window } from '@tauri-apps/api/window'
import { ref, onMounted } from 'vue'
import { useI18n } from '@/i18n'
import { useDshStatus } from '@/composables/useDshStatus'

defineProps<{
  active?: boolean
  /**
   * 显示引擎那盏灯。**只在智能体页给 true**。
   *
   * 别的页(笔记、翻译、计时)跟这台引擎没关系,在那儿摆一条「已连接」
   * 是在说一件当下用不上的事 —— 还会和页面自己的顶栏内容抢位置。
   */
  engine?: boolean
}>()

// 灯和文字的判断全在这一份里(见 useDshStatus),别在这儿再写一遍
const engineStatus = useDshStatus()
const emit = defineEmits<{ logo: [] }>()

const { t } = useI18n()
const appWindow = Window.getCurrent()
const isMaximized = ref(false)

const minimize = () => appWindow.minimize()
const toggleMaximize = async () => {
  await appWindow.toggleMaximize()
  isMaximized.value = await appWindow.isMaximized()
}
const close = () => appWindow.close()

onMounted(async () => {
  isMaximized.value = await appWindow.isMaximized()
})
</script>

<template>
  <!--
    左上角对齐常量:列宽 / 栏高 = **58**,和浮空卡片自身的厚度相等。
    Logo 不进浮空卡片,直接落在 (29, 29);侧栏卡片宽 58、外边距 0,卡片内图标中心同样是 29
    —— 三者共线。改这里的 58 或侧栏卡片的内部尺寸都会让 Logo 错位。
    (以前是 72 的列 + 居中的 58 卡片,左右各多 7px,导致左/上留白 17 而右/下留白 10。)

    右上角这张卡片和侧栏卡片同一套模数:内边距 p-1.5(6px) + 每格 size-11(44px) → 总高 58,
    正好等于侧栏卡片的宽度;左右做成完全圆角(rounded-full)。
    每个圆点包在 44×44 的点击格里(和侧栏选框一样大,好点),但**点本身仍是 14px 不放大**,
    格子也不画底色(不出现选框)。悬停整组时才在点里浮现符号(同 Mac)。
    可调参数:卡片内边距 p-1.5 / 点击格 size-11 / 点直径 size-3.5。
    顺序是我们自己定的:绿=最小化 / 黄=最大化 / 红=关闭,红色排最右(关闭在最外侧,和 Windows 习惯一致)。
  -->
  <!--
    **根容器 pointer-events-none。**
    这一条横跨整个窗口顶部、z-50 压在所有页面内容之上。不关掉指针事件的话,
    页面顶部那一行(笔记页的工具卡和标签卡)会被它整片盖住 —— 按钮看得见、点不动,
    点下去还被当成拖窗口。踩过一次:工具卡上的按钮全是死的,查了半天才发现是它。

    真正需要交互的子元素各自 pointer-events-auto 打开。
  -->
  <div class="h-[58px] shrink-0 flex items-center select-none z-50 pointer-events-none">
    <button @click="emit('logo')" :class="[
      'pointer-events-auto',
      'w-[58px] shrink-0 flex items-center justify-center transition-colors',
      active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
    ]">
      <span class="icon-[lucide--box] w-9 h-9" />
    </button>

    <!--
      页面的 Tabs 会 Teleport 到这里(见 TitleBarTabs.vue)。
      两侧各留一段 data-tauri-drag-region 保住拖拽;这个插槽本身不带那个属性,
      所以落在 Tabs 上的点击是真的点击,不会被当成拖窗口。
    -->
    <!--
      这里**没有** data-tauri-drag-region。拖窗口改由 App.vue 按光标形状判断:
      顶部那一行里,光标是 default/auto 的地方就能拖,是手型/文字/col-resize 的地方
      归控件自己。以前在这儿留固定宽度的拖拽带,结果是大部分地方都拖不动。

      插槽本身不能带 relative —— 带了标签卡就会改成以插槽为心居中,见 TitleBarTabs.vue。
    -->
    <div id="titlebar-slot" class="shrink-0 flex items-center pointer-events-auto"></div>
    <div class="flex-1"></div>

    <!--
      间隔的推导（别随手改这三个数，改一个另两个要跟着算）：
        点径 D = 14(size-3.5)、点击格 W = 36(size-9)、卡片内边距 P = 5、边框 1
        点到点 = W - D = 22
        边到点 = P + (W - D)/2 = 5 + 11 = 16
        卡片高 = 1 + P + W + P + 1 = 48

      **这张不跟 58 的模数，是有意的。** 48 高居中在 58 的顶栏行里，上下各留 5px，
      比左边那几张薄一圈 —— 试过做成 58 齐平，胶囊显得又粗又抢眼。
      所以这里只保证右边距 10px，高度按视觉走。
    -->
    <!--
      引擎状态。**贴着控制点左边**,和它们凑成右上角这一组。

      以前它在会话侧栏最底下 —— 那是整个窗口最不容易看见的角落,而它说的是
      「现在还能不能干活」,是随时要瞄一眼的东西。挪到这儿之后,不管在哪一页
      都看得见,侧栏底下那条也就空出来给「新会话」了。

      高度跟着控制点那张卡片走(48),不是 58 的模数 —— 右上角这一组自成一体。
    -->
    <button v-if="engine" @click="engineStatus.click" :disabled="engineStatus.busy.value"
      :title="engineStatus.label.value"
      class="float-card rounded-full border bg-card h-12 pl-3.5 pr-4 mr-2.5 flex items-center gap-2
             pointer-events-auto transition-colors hover:bg-muted/50 disabled:hover:bg-card
             max-w-[18rem]">
      <span class="size-1.5 rounded-full shrink-0" :class="engineStatus.dot.value" />
      <span class="text-xs text-muted-foreground truncate">{{ engineStatus.label.value }}</span>
      <span v-if="engineStatus.canStart.value"
        class="icon-[lucide--play] w-3 h-3 shrink-0 text-muted-foreground" />
    </button>

    <!-- 根容器关了指针事件,这张卡片要自己打开,否则三颗控制点也点不动 -->
    <div class="float-card group rounded-full border bg-card p-[5px] flex items-center pointer-events-auto">
      <button @click="minimize" :title="t('window.minimize')"
        class="size-9 rounded-full flex items-center justify-center">
        <span class="size-3.5 rounded-full bg-[#28c840] flex items-center justify-center">
        <span class="icon-[lucide--minus] w-2.5 h-2.5 text-black/60 opacity-0 group-hover:opacity-100 transition-opacity" />
        </span>
      </button>
      <button @click="toggleMaximize" :title="isMaximized ? t('window.restore') : t('window.maximize')"
        class="size-9 rounded-full flex items-center justify-center">
        <span class="size-3.5 rounded-full bg-[#febc2e] flex items-center justify-center">
        <span :class="isMaximized ? 'icon-[lucide--chevrons-down-up]' : 'icon-[lucide--chevrons-up-down]'"
          class="w-2.5 h-2.5 text-black/60 opacity-0 group-hover:opacity-100 transition-opacity" />
        </span>
      </button>
      <button @click="close" :title="t('window.close')"
        class="size-9 rounded-full flex items-center justify-center">
        <span class="size-3.5 rounded-full bg-[#ff5f57] flex items-center justify-center">
        <span class="icon-[lucide--x] w-2.5 h-2.5 text-black/60 opacity-0 group-hover:opacity-100 transition-opacity" />
        </span>
      </button>
    </div>
  </div>
</template>
