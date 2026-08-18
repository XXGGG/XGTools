<script setup lang="ts">
import { ref, reactive, watch, computed, onMounted, onUnmounted, nextTick } from 'vue'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { invoke } from '@tauri-apps/api/core'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Slider } from '@/components/ui/slider'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

const orbFrame = ref<HTMLIFrameElement | null>(null)
const tab = ref('look')
const panelOpen = ref(true)
const expandBtn = ref(false)

type Patch = Record<string, number | string>

const params = reactive({
  color: '#d9e6ff', bg: 'transparent', density: '高',
  freq: 1.0, pull: 2.7, turb: 0.56, swirl: 0.35, coreR: 0.5, coreFrac: 0.22, haloFrac: 0.28,
  coreShape: 2.0, shellShape: 2.0, warp: 0.0, warpFreq: 2.0, twist: 0.0,
  speed: 0.75, follow: 0.4, tilt: 0.32, conn: 0.3, bow: 0.18, ctwist: 2.5,
  sizeCore: 1.35, sizeShell: 1.0, sizeHalo: 0.85,
  brightCore: 0.55, brightShell: 0.42, brightHalo: 0.34,
  spinAll: 0.0, spinCore: 0.0, spinShell: 0.0, spinHalo: 0.0,
})

const P_SWATCHES = ['#d9e6ff', '#ffffff', '#38e1c0', '#6bffd8', '#7aa8ff', '#5a7cff',
  '#b388ff', '#e07bff', '#ff8fae', '#ff6b6b', '#ffd27a', '#9dff6b', '#ffb03a']
const B_COLORS = ['#000000', '#050506', '#0a0e14', '#0b1020', '#12061c', '#07140f', '#160b0b']

// 形态:按"全局 / 结构 / 内核层 / 外壳层 / 风沙层"分组
const SECTIONS = [
  { title: '全局', icon: 'icon-[lucide--settings-2]', items: [
    { key: 'speed', label: '速度', icon: 'icon-[lucide--gauge]', min: 0, max: 2.5, step: 0.01 },
    { key: 'spinAll', label: '整体自转(±方向)', icon: 'icon-[lucide--refresh-cw]', min: -1, max: 1, step: 0.05 },
    { key: 'follow', label: '窗口跟随', icon: 'icon-[lucide--move]', min: 0, max: 2, step: 0.01 },
    { key: 'tilt', label: '轴倾斜', icon: 'icon-[lucide--compass]', min: -0.9, max: 0.9, step: 0.02 },
    { key: 'freq', label: '结构大小', icon: 'icon-[lucide--layers]', min: 0.4, max: 2.4, step: 0.01 },
  ] },
  { title: '结构', icon: 'icon-[lucide--shapes]', items: [
    { key: 'pull', label: '球壳紧实', icon: 'icon-[lucide--shrink]', min: 0.8, max: 5, step: 0.01 },
    { key: 'turb', label: '风沙(湍流)', icon: 'icon-[lucide--wind]', min: 0, max: 1.4, step: 0.01 },
    { key: 'swirl', label: '环流(轨道旋)', icon: 'icon-[lucide--tornado]', min: 0, max: 1.2, step: 0.01 },
    { key: 'coreR', label: '内核壳大小', icon: 'icon-[lucide--circle]', min: 0.2, max: 0.8, step: 0.01 },
    { key: 'coreFrac', label: '内核壳占比', icon: 'icon-[lucide--pie-chart]', min: 0, max: 0.6, step: 0.01 },
    { key: 'haloFrac', label: '风沙占比', icon: 'icon-[lucide--sparkles]', min: 0, max: 0.6, step: 0.01 },
    { key: 'conn', label: '连接粒子', icon: 'icon-[lucide--spline]', min: 0, max: 1, step: 0.02 },
    { key: 'bow', label: '连接流动', icon: 'icon-[lucide--waves]', min: 0, max: 0.6, step: 0.01 },
    { key: 'ctwist', label: '连接螺旋', icon: 'icon-[lucide--tornado]', min: 0, max: 10, step: 0.5 },
  ] },
  { title: '几何', icon: 'icon-[lucide--box]', items: [
    { key: 'coreShape', label: '内核形状(球↔多面)', icon: 'icon-[lucide--diamond]', min: 0.6, max: 8, step: 0.05 },
    { key: 'shellShape', label: '外壳形状(球↔多面)', icon: 'icon-[lucide--hexagon]', min: 0.6, max: 8, step: 0.05 },
    { key: 'warp', label: '表面起伏', icon: 'icon-[lucide--mountain]', min: 0, max: 0.5, step: 0.01 },
    { key: 'warpFreq', label: '起伏密度', icon: 'icon-[lucide--grip]', min: 0.5, max: 5, step: 0.1 },
    { key: 'twist', label: '扭转', icon: 'icon-[lucide--tornado]', min: -0.5, max: 0.5, step: 0.02 },
  ] },
  { title: '内核层', icon: 'icon-[lucide--circle-dot]', items: [
    { key: 'brightCore', label: '亮度', icon: 'icon-[lucide--sun]', min: 0.05, max: 1, step: 0.01 },
    { key: 'sizeCore', label: '颗粒', icon: 'icon-[lucide--grip]', min: 0.5, max: 3.5, step: 0.05 },
    { key: 'spinCore', label: '自转(±方向)', icon: 'icon-[lucide--rotate-cw]', min: -1, max: 1, step: 0.05 },
  ] },
  { title: '外壳层', icon: 'icon-[lucide--circle]', items: [
    { key: 'brightShell', label: '亮度', icon: 'icon-[lucide--sun]', min: 0.05, max: 1, step: 0.01 },
    { key: 'sizeShell', label: '颗粒', icon: 'icon-[lucide--grip]', min: 0.5, max: 3.5, step: 0.05 },
    { key: 'spinShell', label: '自转(±方向)', icon: 'icon-[lucide--rotate-cw]', min: -1, max: 1, step: 0.05 },
  ] },
  { title: '风沙层', icon: 'icon-[lucide--sparkles]', items: [
    { key: 'brightHalo', label: '亮度', icon: 'icon-[lucide--sun]', min: 0.05, max: 1, step: 0.01 },
    { key: 'sizeHalo', label: '颗粒', icon: 'icon-[lucide--grip]', min: 0.5, max: 3.5, step: 0.05 },
    { key: 'spinHalo', label: '自转(±方向)', icon: 'icon-[lucide--rotate-cw]', min: -1, max: 1, step: 0.05 },
  ] },
] as const

// 颜色工具
function hslToHex(h: number, s: number, l: number): string {
  h /= 360
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => {
    const k = (n + h * 12) % 12
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
    return Math.round(255 * c).toString(16).padStart(2, '0')
  }
  return '#' + f(0) + f(8) + f(4)
}
// ===== 离散形态分类(仿 Wisp:外壳 × 内核 × 沙尘 的组合,每个都真正不同)=====
// 超椭球 p:0.8~1 八面/菱、1.3~1.6 多面、2 球、4.5~5 立方
const SHELLS = [
  { key: 'sphere', label: '球', patch: { shellShape: 2.0, warp: 0.0, warpFreq: 2.0 } },
  { key: 'facet', label: '晶面', patch: { shellShape: 1.4, warp: 0.05, warpFreq: 1.8 } },
  { key: 'cube', label: '立方', patch: { shellShape: 4.6, warp: 0.0, warpFreq: 2.0 } },
  { key: 'rugged', label: '崎岖', patch: { shellShape: 2.0, warp: 0.42, warpFreq: 2.4 } },
]
const CORES = [
  { key: 'sphere', label: '球', patch: { coreShape: 2.0, coreR: 0.46, coreFrac: 0.26 } },
  { key: 'octa', label: '菱', patch: { coreShape: 1.0, coreR: 0.5, coreFrac: 0.32 } },
  { key: 'cube', label: '立方', patch: { coreShape: 4.6, coreR: 0.5, coreFrac: 0.3 } },
  { key: 'star', label: '星', patch: { coreShape: 0.85, coreR: 0.48, coreFrac: 0.28 } },
]
// 沙尘/运动:是「运动方式」而非微调——高 pull+低 turb=致密成壳(边缘亮),高 swirl=轨道扫掠帷幔,高 turb=乱流爆发
const DUSTS = [
  { key: 'calm', label: '静谧', patch: { turb: 0.28, haloFrac: 0.1, pull: 4.4, freq: 0.95, swirl: 0.24 } },   // 致密晶莹球壳、几乎无尘
  { key: 'mist', label: '薄雾', patch: { turb: 0.32, haloFrac: 0.52, pull: 3.2, freq: 0.66, swirl: 0.3 } },   // 壳外大片柔和薄雾
  { key: 'surge', label: '涌动', patch: { turb: 0.55, haloFrac: 0.3, pull: 3.4, freq: 1.0, swirl: 0.44 } },   // 翻涌鼓动
  { key: 'current', label: '洋流', patch: { turb: 0.3, haloFrac: 0.3, pull: 3.6, freq: 0.9, swirl: 0.92 } },  // 强环流扫出帷幔
  { key: 'spiral', label: '螺旋', patch: { turb: 0.42, haloFrac: 0.3, pull: 3.2, freq: 1.05, swirl: 0.64 } }, // 螺旋绕流
  { key: 'storm', label: '风暴', patch: { turb: 0.88, haloFrac: 0.44, pull: 2.6, freq: 1.05, swirl: 0.4 } },  // 乱流爆发飞散
]
// 连接:攀附在近邻粒子间的一缕流动粒子(仿 Wisp,绕轴螺旋)。conn 强度、bow 振幅、ctwist 螺旋圈数
const CONNS = [
  { key: 'none', label: '无', patch: { conn: 0.0, bow: 0.0, ctwist: 0 } },
  { key: 'cling', label: '紧贴', patch: { conn: 0.5, bow: 0.06, ctwist: 0 } },   // 紧贴的直缕
  { key: 'web', label: '网', patch: { conn: 0.55, bow: 0.14, ctwist: 2 } },      // 轻缠绕
  { key: 'spiral', label: '螺旋', patch: { conn: 0.6, bow: 0.22, ctwist: 6 } },  // 强麻花螺旋(仿 connectionTwists)
  { key: 'flow', label: '流丝', patch: { conn: 0.52, bow: 0.32, ctwist: 3.5 } }, // 飘逸流丝
  { key: 'dense', label: '密', patch: { conn: 0.85, bow: 0.18, ctwist: 4 } },    // 密集缠绕
]
// 形态画廊 = 外壳 × 内核 × 沙尘 全组合(4×4×3 = 48 种,连接默认「网」)
const GALLERY: any[] = []
for (let si = 0; si < SHELLS.length; si++)
  for (let ci = 0; ci < CORES.length; ci++)
    for (let di = 0; di < DUSTS.length; di++) {
      const idx = GALLERY.length
      GALLERY.push({
        name: `${SHELLS[si].label}·${CORES[ci].label}·${DUSTS[di].label}`,
        icon: 'icon-[lucide--orbit]', shell: SHELLS[si].key, core: CORES[ci].key, dust: DUSTS[di].key,
        patch: {
          ...SHELLS[si].patch, ...CORES[ci].patch, ...DUSTS[di].patch, ...CONNS[2].patch,
          color: hslToHex((idx * 47) % 360, 0.5, 0.7), density: '高',
        },
      })
    }

// 精选模板:命名的整体方案(保留的手调预设)
const TEMPLATES: any[] = [
  { name: '静谧', icon: 'icon-[lucide--moon]', patch: { color: '#d9e6ff', freq: 0.9, pull: 4.0, turb: 0.42, coreR: 0.4, coreFrac: 0.24, haloFrac: 0.12, speed: 0.6, follow: 0.3, sizeCore: 1.4, sizeShell: 1.1, sizeHalo: 0.95, brightCore: 0.6, brightShell: 0.48, brightHalo: 0.35, spinCore: 0.03, spinShell: 0.018, spinHalo: 0.008, density: '高' } },
  // 净透:无风沙、无连接的干净双球(用户喜欢的"默认球")
  { name: '净透', icon: 'icon-[lucide--circle]', patch: { color: '#bfe0ff', coreShape: 2.0, shellShape: 2.0, coreR: 0.5, coreFrac: 0.3, haloFrac: 0.08, conn: 0, bow: 0, ctwist: 0, freq: 0.95, pull: 4.5, turb: 0.26, swirl: 0.22, speed: 0.5, follow: 0.3, tilt: 0.3, sizeCore: 1.35, sizeShell: 1.05, sizeHalo: 0.9, brightCore: 0.55, brightShell: 0.5, brightHalo: 0.3, spinAll: 0, spinCore: 0, spinShell: 0, spinHalo: 0, density: '高' } },
  { name: '星系', icon: 'icon-[lucide--orbit]', patch: { color: '#cbd6ff', freq: 1.0, pull: 2.2, turb: 0.7, coreR: 0.35, coreFrac: 0.28, haloFrac: 0.35, speed: 0.7, follow: 0.35, sizeCore: 1.7, sizeShell: 1.1, sizeHalo: 0.9, brightCore: 0.7, brightShell: 0.45, brightHalo: 0.5, spinCore: 0.09, spinShell: 0.03, spinHalo: -0.02, density: '高' } },
  { name: '行星', icon: 'icon-[lucide--globe]', patch: { color: '#9dd9ff', freq: 0.95, pull: 3.4, turb: 0.45, coreR: 0.55, coreFrac: 0.35, haloFrac: 0.15, speed: 0.5, follow: 0.3, sizeCore: 1.8, sizeShell: 1.05, sizeHalo: 0.9, brightCore: 0.68, brightShell: 0.42, brightHalo: 0.3, spinCore: 0.02, spinShell: 0.015, spinHalo: 0.008, density: '高' } },
  { name: '风暴', icon: 'icon-[lucide--wind]', patch: { color: '#7aa8ff', freq: 1.1, pull: 2.0, turb: 1.0, coreR: 0.45, coreFrac: 0.18, haloFrac: 0.45, speed: 1.0, follow: 0.5, sizeCore: 1.3, sizeShell: 1.15, sizeHalo: 1.05, brightCore: 0.6, brightShell: 0.52, brightHalo: 0.5, spinCore: 0.06, spinShell: 0.03, spinHalo: 0.02, density: '高' } },
  { name: '黑洞', icon: 'icon-[lucide--circle-dot]', patch: { color: '#ffffff', freq: 1.0, pull: 3.2, turb: 0.5, coreR: 0.3, coreFrac: 0.3, haloFrac: 0.24, speed: 0.9, follow: 0.35, sizeCore: 1.2, sizeShell: 1.1, sizeHalo: 1.0, brightCore: 0.75, brightShell: 0.4, brightHalo: 0.32, spinCore: 0.11, spinShell: 0.02, spinHalo: 0.01, density: '高' } },
  { name: '星云', icon: 'icon-[lucide--sparkles]', patch: { color: '#b388ff', freq: 0.55, pull: 1.5, turb: 0.75, coreR: 0.6, coreFrac: 0.28, haloFrac: 0.38, speed: 0.6, follow: 0.35, sizeCore: 1.8, sizeShell: 1.5, sizeHalo: 1.3, brightCore: 0.5, brightShell: 0.42, brightHalo: 0.4, spinCore: 0.02, spinShell: 0.015, spinHalo: 0.01, density: '高' } },
  { name: '极光', icon: 'icon-[lucide--waves]', patch: { color: '#38e1c0', freq: 0.85, pull: 2.6, turb: 0.65, coreR: 0.45, coreFrac: 0.22, haloFrac: 0.3, speed: 0.8, follow: 0.4, sizeCore: 1.5, sizeShell: 1.15, sizeHalo: 1.0, brightCore: 0.62, brightShell: 0.5, brightHalo: 0.42, spinCore: 0.045, spinShell: 0.025, spinHalo: 0.015, density: '高' } },
  { name: '烈焰', icon: 'icon-[lucide--flame]', patch: { color: '#ffb03a', freq: 1.0, pull: 1.8, turb: 1.05, coreR: 0.5, coreFrac: 0.18, haloFrac: 0.46, speed: 0.95, follow: 0.45, sizeCore: 1.4, sizeShell: 1.2, sizeHalo: 1.1, brightCore: 0.6, brightShell: 0.52, brightHalo: 0.5, spinCore: 0.05, spinShell: 0.03, spinHalo: 0.02, density: '高' } },
  { name: '深海', icon: 'icon-[lucide--droplet]', patch: { color: '#5ad0ff', freq: 0.8, pull: 3.0, turb: 0.55, coreR: 0.42, coreFrac: 0.26, haloFrac: 0.2, speed: 0.6, follow: 0.3, sizeCore: 1.6, sizeShell: 1.05, sizeHalo: 0.9, brightCore: 0.66, brightShell: 0.4, brightHalo: 0.34, spinCore: 0.03, spinShell: 0.018, spinHalo: 0.01, density: '高' } },
  { name: '樱粉', icon: 'icon-[lucide--heart]', patch: { color: '#ff9ecb', freq: 0.95, pull: 2.4, turb: 0.6, coreR: 0.46, coreFrac: 0.22, haloFrac: 0.3, speed: 0.7, follow: 0.4, sizeCore: 1.5, sizeShell: 1.15, sizeHalo: 1.0, brightCore: 0.6, brightShell: 0.5, brightHalo: 0.42, spinCore: 0.04, spinShell: 0.022, spinHalo: 0.012, density: '高' } },
  { name: '翡翠', icon: 'icon-[lucide--gem]', patch: { color: '#6bff9d', freq: 0.9, pull: 2.7, turb: 0.6, coreR: 0.44, coreFrac: 0.24, haloFrac: 0.28, speed: 0.75, follow: 0.4, sizeCore: 1.5, sizeShell: 1.1, sizeHalo: 1.0, brightCore: 0.62, brightShell: 0.48, brightHalo: 0.42, spinCore: 0.03, spinShell: -0.02, spinHalo: 0.01, density: '高' } },
  { name: '双核', icon: 'icon-[lucide--target]', patch: { color: '#cbd6ff', freq: 0.9, pull: 3.6, turb: 0.4, coreR: 0.62, coreFrac: 0.42, haloFrac: 0.12, speed: 0.6, follow: 0.3, sizeCore: 1.6, sizeShell: 1.0, sizeHalo: 0.9, brightCore: 0.65, brightShell: 0.42, brightHalo: 0.3, spinCore: 0.05, spinShell: 0.02, spinHalo: 0.01, density: '高' } },
  { name: '薄壳', icon: 'icon-[lucide--circle]', patch: { color: '#ffffff', freq: 1.3, pull: 4.6, turb: 0.35, coreR: 0.5, coreFrac: 0.06, haloFrac: 0.14, speed: 0.6, follow: 0.3, sizeCore: 1.2, sizeShell: 1.15, sizeHalo: 0.95, brightCore: 0.5, brightShell: 0.55, brightHalo: 0.35, spinCore: 0.02, spinShell: 0.025, spinHalo: 0.01, density: '高' } },
  { name: '微光', icon: 'icon-[lucide--star]', patch: { color: '#d9e6ff', freq: 0.95, pull: 2.8, turb: 0.5, coreR: 0.46, coreFrac: 0.24, haloFrac: 0.22, speed: 0.55, follow: 0.3, sizeCore: 1.4, sizeShell: 1.15, sizeHalo: 1.0, brightCore: 0.4, brightShell: 0.32, brightHalo: 0.26, spinCore: 0.025, spinShell: 0.015, spinHalo: 0.008, density: '高' } },
  // 嵌套几何:菱形/立方内核 + 球形外壳(仿 Wisp 的核壳独立)
  { name: '钻核', icon: 'icon-[lucide--diamond]', patch: { color: '#bfe0ff', coreShape: 1.0, shellShape: 2.0, coreR: 0.5, coreFrac: 0.34, haloFrac: 0.24, conn: 0.55, freq: 0.95, pull: 4.2, turb: 0.45, speed: 0.55, follow: 0.32, tilt: 0.34, sizeCore: 1.7, sizeShell: 1.0, sizeHalo: 0.9, brightCore: 0.78, brightShell: 0.4, brightHalo: 0.3, spinCore: 0.03, spinShell: 0.016, spinHalo: 0.009, density: '高' } },
  { name: '晶格', icon: 'icon-[lucide--box]', patch: { color: '#cfe6ff', coreShape: 4.8, shellShape: 2.0, coreR: 0.52, coreFrac: 0.32, haloFrac: 0.24, conn: 0.6, freq: 0.95, pull: 4.4, turb: 0.42, speed: 0.5, follow: 0.32, tilt: 0.3, sizeCore: 1.6, sizeShell: 1.0, sizeHalo: 0.9, brightCore: 0.74, brightShell: 0.4, brightHalo: 0.3, spinCore: 0.028, spinShell: 0.016, spinHalo: 0.009, density: '高' } },
  { name: '经纬', icon: 'icon-[lucide--globe-2]', patch: { color: '#cbe0ff', coreShape: 2.0, shellShape: 2.0, coreR: 0.42, coreFrac: 0.2, haloFrac: 0.22, conn: 0.75, freq: 0.95, pull: 4.4, turb: 0.4, speed: 0.55, follow: 0.32, tilt: 0.3, sizeCore: 1.3, sizeShell: 0.95, sizeHalo: 0.85, brightCore: 0.5, brightShell: 0.36, brightHalo: 0.28, spinCore: 0.03, spinShell: 0.02, spinHalo: 0.01, density: '高' } },
]
// 每个条目一个稳定签名(参数变→缩略图自动失效重生)
function presetSig(p: any): string {
  let h = 2166136261
  const s = p.name + '|' + JSON.stringify(p.patch)
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return (h >>> 0).toString(36)
}
// 需要缩略图的全部条目(画廊 48 + 模板 17)
const THUMBSET = [...GALLERY, ...TEMPLATES]
THUMBSET.forEach((p: any) => { p.sig = presetSig(p) })
// 侧栏只放 10 个精选,其余模板都在画廊里
const FEATURED = TEMPLATES.slice(0, 10)
// 画廊展示:48 形态 + 全部模板(其余模板在此)
const GALLERY_ALL = [...GALLERY, ...TEMPLATES]

function pushPatch(patch: Patch) {
  orbFrame.value?.contentWindow?.postMessage({ __storm: { patch } }, '*')
}
function onSlide(key: string, v?: number[]) {
  const n = v?.[0]
  if (typeof n !== 'number') return
  ;(params as any)[key] = n
  pushPatch({ [key]: n })
  persistLast()
}
function setColor(hex: string) { params.color = hex; pushPatch({ color: hex }); persistLast() }
function setBg(v: string) { params.bg = v; pushPatch({ bg: v }); persistLast() }
// 改密度会重建粒子系统 → 连同全部当前参数一起下发,避免只传 density 时任何状态不同步导致"变默认球"
function setDensity(d: string) { params.density = d; pushPatch({ ...params }); persistLast() }
// 未指定几何的预设(如模板)回到球形默认,避免沿用上一个的多面体形状
const GEO_DEFAULT = { coreShape: 2.0, shellShape: 2.0, warp: 0, warpFreq: 2.0, twist: 0, tilt: 0.32, conn: 0.3, bow: 0.18, ctwist: 2.5, swirl: 0.35, spinAll: 0 }
function applyPreset(p: any) {
  const patch = { ...GEO_DEFAULT, ...p.patch }
  Object.assign(params, patch)
  // 带入场动画(球从小蹦大跳出)
  orbFrame.value?.contentWindow?.postMessage({ __storm: { patch, reenter: true } }, '*')
  persistLast()
}
function eq(a: string, b: string) { return a.toLowerCase() === b.toLowerCase() }

// ===== 形态下拉选择(外壳/内核/沙尘/连接)=====
const form = reactive({ shell: 'sphere', core: 'octa', dust: 'surge', conn: 'web' })  // 默认:球壳·菱核·涌动·网
const pick = (arr: any[], key: any) => arr.find((o) => o.key === key) || arr[0]
const randKey = (arr: any[]) => arr[Math.floor(Math.random() * arr.length)].key
function formPatch() {
  return { ...pick(SHELLS, form.shell).patch, ...pick(CORES, form.core).patch, ...pick(DUSTS, form.dust).patch, ...pick(CONNS, form.conn).patch }
}
// 设置形态时不放入场动画,原地平滑变形,让粒子移动更直观(入场动画只在切换预设时)
function applyForm(reenter = false) {
  const patch = formPatch()
  Object.assign(params, patch)
  orbFrame.value?.contentWindow?.postMessage({ __storm: { patch, reenter } }, '*')
  persistLast()
}
function randomForm() {
  form.shell = randKey(SHELLS); form.core = randKey(CORES); form.dust = randKey(DUSTS); form.conn = randKey(CONNS)
  params.color = hslToHex(Math.floor(Math.random() * 360), 0.5, 0.72)
  const patch = { ...formPatch(), color: params.color }
  Object.assign(params, patch)
  orbFrame.value?.contentWindow?.postMessage({ __storm: { patch, reenter: false } }, '*')
  persistLast()
}
// 画廊条目 → 应用形态 + 同步下拉(模板无 shell 字段则只应用)
function pickForm(g: any) {
  if (g.shell) { form.shell = g.shell; form.core = g.core; form.dust = g.dust; form.conn = 'web' }
  applyPreset(g)
  galleryOpen.value = false
}

// ===== 保存自定义 + 恢复上次 =====
const savedList = ref<any[]>([])
const saveName = ref('')
function snapshot() { return { ...JSON.parse(JSON.stringify(params)), _form: { ...form } } }
let lastTimer: number | undefined
function persistLast() {
  if (!store) return
  window.clearTimeout(lastTimer)
  lastTimer = window.setTimeout(async () => { try { await store.set('last', snapshot()); await store.save() } catch { /* noop */ } }, 500)
}
async function saveCustom() {
  const name = saveName.value.trim() || `我的粒子球 ${savedList.value.length + 1}`
  savedList.value = [...savedList.value.filter((s) => s.name !== name), { name, cfg: snapshot() }]
  saveName.value = ''
  if (store) { try { await store.set('saved', JSON.parse(JSON.stringify(savedList.value))); await store.save() } catch { /* noop */ } }
}
function loadCustom(s: any) {
  const { _form, ...p } = s.cfg
  Object.assign(params, p)
  if (_form) Object.assign(form, _form)
  orbFrame.value?.contentWindow?.postMessage({ __storm: { patch: { ...p }, reenter: true } }, '*')
  persistLast()
}
async function delCustom(s: any) {
  savedList.value = savedList.value.filter((x) => x.name !== s.name)
  if (store) { try { await store.set('saved', JSON.parse(JSON.stringify(savedList.value))); await store.save() } catch { /* noop */ } }
}

watch(panelOpen, (open) => {
  if (open) { expandBtn.value = false }
  else { window.setTimeout(() => { if (!panelOpen.value) expandBtn.value = true }, 320) }
})

function onMsg(e: MessageEvent) {
  if (!(e.data && e.data.__storm === 'ready')) return
  if (thumbFrame.value && e.source === thumbFrame.value.contentWindow) thumbReady = true
  else pushPatch({ ...params })   // 主 orb 就绪 → 推初始参数
}
window.addEventListener('message', onMsg)
onUnmounted(() => window.removeEventListener('message', onMsg))

function currentQuery(): string {
  try {
    const fn = (orbFrame.value?.contentWindow as any)?.__stormQuery
    return typeof fn === 'function' ? fn() : ''
  } catch { return '' }
}
async function openFullscreen() {
  const q = currentQuery()
  const existing = await WebviewWindow.getByLabel('storm')
  if (existing) await existing.close()
  new WebviewWindow('storm', { url: `index.html?${q}&fs=1`, title: 'Storm Orb', fullscreen: true, decorations: false })
}

// ---------- 动态壁纸 ----------
const wallpaperOn = ref(false)
const wallMsg = ref('')
async function startWallpaper() {
  wallMsg.value = '开启中…'
  try {
    await invoke('start_wallpaper', { query: currentQuery() })
    wallpaperOn.value = true; wallMsg.value = ''
  } catch (e: any) {
    wallMsg.value = '开启失败：' + (e?.message ?? e)
  }
}
async function stopWallpaper() {
  try { await invoke('stop_wallpaper') } catch { /* noop */ }
  wallpaperOn.value = false; wallMsg.value = ''
}

// ---------- 定时屏保 ----------
const saverOn = ref(false)
const saverMinutes = ref(5)
async function enableSaver() {
  try {
    await invoke('start_screensaver', { minutes: Math.max(1, Math.round(saverMinutes.value || 5)), query: currentQuery() })
    saverOn.value = true
  } catch { /* noop */ }
}
async function disableSaver() {
  try { await invoke('stop_screensaver'); saverOn.value = false } catch { /* noop */ }
}

// ---------- 预设方形预览图 + 图集 ----------
const galleryOpen = ref(false)
const search = ref('')
const thumbs = reactive<Record<string, string>>({})   // sig -> jpeg dataURL
const thumbFrame = ref<HTMLIFrameElement | null>(null)
const showThumbGen = ref(false)
const genDone = ref(0)
const filteredGallery = computed(() => {
  const q = search.value.trim().toLowerCase()
  return q ? GALLERY_ALL.filter((p: any) => p.name.toLowerCase().includes(q)) : GALLERY_ALL
})
const doneCount = computed(() => THUMBSET.filter((p: any) => thumbs[p.sig]).length)

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)) }
const isTauri = typeof (window as any).__TAURI_INTERNALS__ !== 'undefined'
let store: any = null
async function initStore() {
  if (!isTauri) return
  try {
    const { load } = await import('@tauri-apps/plugin-store')
    store = await load('orb-thumbs.json', { autoSave: false, defaults: {} } as any)
    for (const p of THUMBSET as any[]) {
      const v = await store.get('t:' + p.sig)
      if (typeof v === 'string' && v) thumbs[p.sig] = v
    }
  } catch { store = null }
}

let thumbReady = false
let genRunning = false
let genStop = false
async function generateThumbs() {
  if (genRunning) return
  genRunning = true; genStop = false
  let waited = 0
  while (!thumbReady && waited < 8000) { await sleep(120); waited += 120 }
  const fr = thumbFrame.value
  if (!thumbReady || !fr) { genRunning = false; showThumbGen.value = false; return }
  let saved = 0
  for (const p of THUMBSET as any[]) {
    if (genStop) break
    if (thumbs[p.sig]) { genDone.value = doneCount.value; continue }
    const patch: any = { ...GEO_DEFAULT, ...p.patch }; delete patch.density   // 球形兜底 + 固定密度避免重建
    fr.contentWindow?.postMessage({ __storm: { patch } }, '*')
    await sleep(1300)                                          // 等粒子重新聚形
    let url = ''
    try { url = (fr.contentWindow as any)?.__stormShot?.() || '' } catch { /* noop */ }
    if (url) {
      thumbs[p.sig] = url
      genDone.value = doneCount.value
      if (store) { try { await store.set('t:' + p.sig, url); if (++saved % 8 === 0) await store.save() } catch { /* noop */ } }
    }
  }
  if (store) { try { await store.save() } catch { /* noop */ } }
  genRunning = false
  showThumbGen.value = false   // 全部生成完毕 → 卸载隐藏 orb 释放 GPU
}

onMounted(async () => {
  await initStore()
  // 恢复上次的粒子球 + 我的收藏
  let restored = false
  if (store) {
    try {
      const last = await store.get('last')
      if (last && typeof last === 'object') {
        const { _form, ...p } = last as any
        Object.assign(params, p)
        if (_form) Object.assign(form, _form)
        restored = true
      }
      const saved = await store.get('saved')
      if (Array.isArray(saved)) savedList.value = saved
    } catch { /* noop */ }
  }
  if (!restored) Object.assign(params, formPatch())   // 初始状态与下拉一致
  pushPatch({ ...params })                            // 同步到 orb(ready 可能已先触发)
  if (THUMBSET.some((p: any) => !thumbs[p.sig])) {
    showThumbGen.value = true
    await nextTick()
    generateThumbs()
  }
})
onUnmounted(() => { genStop = true })
</script>

<template>
  <div class="h-full w-full flex">
    <div class="flex-1 min-w-0 relative grid place-items-center" style="container-type:size">
      <iframe ref="orbFrame" src="orb/index.html" style="width:100cqmin;height:100cqmin" class="border-0 block bg-transparent" title="Storm Orb" />
      <button
        @click="openFullscreen"
        class="absolute top-4 left-4 h-9 px-3 rounded-lg text-sm bg-black/25 hover:bg-black/45 border border-white/12 text-foreground/90 backdrop-blur-md flex items-center gap-1.5"
      >
        <span class="icon-[lucide--maximize] w-4 h-4" /> 全屏观赏
      </button>
      <button
        v-show="expandBtn" @click="panelOpen = true" title="展开面板"
        class="absolute top-4 right-4 size-9 rounded-lg bg-black/25 hover:bg-black/45 border border-white/12 text-foreground/90 backdrop-blur-md flex items-center justify-center"
      >
        <span class="icon-[lucide--sliders-horizontal] w-4 h-4" />
      </button>
    </div>

    <div class="shrink-0 overflow-hidden transition-[width] duration-300 ease-out" :class="panelOpen ? 'w-76.5' : 'w-0'">
      <div class="w-76.5 h-full p-3 transition-transform duration-300 ease-out" :class="panelOpen ? 'translate-x-0' : 'translate-x-full'">
        <div class="h-full rounded-2xl border border-border bg-card/75 backdrop-blur-xl shadow-2xl flex flex-col overflow-hidden">
          <div class="flex items-center justify-between pl-4 pr-2.5 pt-3 pb-0.5">
            <span class="text-sm font-semibold tracking-wide">粒子球</span>
            <button
              @click="panelOpen = false" title="收起面板"
              class="size-7 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted flex items-center justify-center"
            >
              <span class="icon-[lucide--panel-right-close] w-4 h-4" />
            </button>
          </div>

          <Tabs v-model="tab" class="flex-1 flex flex-col min-h-0">
            <TabsList class="grid grid-cols-4 h-10 mx-3 mt-2 mb-1 shrink-0">
              <TabsTrigger value="look" class="text-sm">外观</TabsTrigger>
              <TabsTrigger value="shape" class="text-sm">形态</TabsTrigger>
              <TabsTrigger value="wall" class="text-sm">壁纸</TabsTrigger>
              <TabsTrigger value="saver" class="text-sm">屏保</TabsTrigger>
            </TabsList>

            <!-- 外观 -->
            <TabsContent value="look" class="flex-1 min-h-0 mt-0">
              <ScrollArea class="h-full">
                <div class="px-4 pb-6 pt-2 space-y-5">
                  <div>
                    <div class="flex items-center justify-between mb-2">
                      <span class="text-xs text-muted-foreground">精选模板</span>
                      <button
                        @click="galleryOpen = true"
                        class="flex items-center gap-1 text-xs text-primary/90 hover:text-primary transition-colors"
                      >
                        <span class="icon-[lucide--layout-grid] w-3.5 h-3.5" /> 形态画廊
                      </button>
                    </div>
                    <div class="grid grid-cols-2 gap-2">
                      <button
                        v-for="p in FEATURED" :key="p.name" @click="applyPreset(p)"
                        class="flex items-center gap-2 pl-1.5 pr-2.5 py-1.5 rounded-lg border border-border bg-muted/40 hover:bg-muted hover:border-primary/60 text-sm transition-colors"
                      >
                        <img v-if="thumbs[p.sig]" :src="thumbs[p.sig]" class="w-7 h-7 rounded-md object-cover shrink-0 bg-black" alt="" />
                        <span v-else class="w-7 h-7 rounded-md bg-black/60 grid place-items-center shrink-0">
                          <span :class="p.icon" class="w-3.5 h-3.5 text-primary/80" />
                        </span>
                        <span class="truncate">{{ p.name }}</span>
                      </button>
                    </div>
                  </div>

                  <!-- 我的收藏(保存/恢复自定义粒子球)-->
                  <div>
                    <div class="text-xs text-muted-foreground mb-2">我的收藏</div>
                    <div class="flex gap-1.5 mb-2">
                      <Input v-model="saveName" placeholder="命名当前粒子球…" class="h-8 text-sm flex-1" />
                      <button
                        @click="saveCustom"
                        class="h-8 px-2.5 rounded-md bg-primary text-primary-foreground text-xs flex items-center gap-1 shrink-0 hover:opacity-90"
                      >
                        <span class="icon-[lucide--bookmark-plus] w-3.5 h-3.5" /> 保存
                      </button>
                    </div>
                    <div v-if="savedList.length" class="space-y-1.5">
                      <div
                        v-for="s in savedList" :key="s.name"
                        class="group flex items-center gap-2 pl-1.5 pr-1 py-1 rounded-lg border border-border bg-muted/30 hover:bg-muted transition-colors"
                      >
                        <button @click="loadCustom(s)" class="flex items-center gap-2 flex-1 min-w-0 text-left">
                          <span class="w-6 h-6 rounded-md bg-black/60 grid place-items-center shrink-0">
                            <span class="icon-[lucide--sparkles] w-3 h-3 text-primary/80" />
                          </span>
                          <span class="truncate text-sm">{{ s.name }}</span>
                        </button>
                        <button
                          @click="delCustom(s)" title="删除"
                          class="size-6 rounded-md text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive hover:bg-destructive/10 grid place-items-center shrink-0"
                        >
                          <span class="icon-[lucide--trash-2] w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                    <div v-else class="text-xs text-muted-foreground/60 py-1">调好后点「保存」,下次打开自动恢复上次的球。</div>
                  </div>
                  <div>
                    <div class="text-xs text-muted-foreground mb-2">粒子颜色</div>
                    <div class="flex flex-wrap gap-2">
                      <button
                        v-for="c in P_SWATCHES" :key="c" @click="setColor(c)" :style="{ background: c }"
                        class="w-7 h-7 rounded-lg border transition-all"
                        :class="eq(params.color, c) ? 'border-primary ring-2 ring-primary/40' : 'border-white/15'"
                      />
                      <label class="w-7 h-7 rounded-lg border border-white/15 bg-muted flex items-center justify-center cursor-pointer relative overflow-hidden text-muted-foreground">
                        <span class="icon-[lucide--pipette] w-3.5 h-3.5" />
                        <input type="color" :value="params.color" @input="setColor(($event.target as HTMLInputElement).value)" class="absolute inset-0 opacity-0 cursor-pointer" />
                      </label>
                    </div>
                  </div>
                  <div>
                    <div class="text-xs text-muted-foreground mb-2">背景色</div>
                    <div class="flex flex-wrap gap-2">
                      <button
                        @click="setBg('transparent')" title="透明(融入应用)"
                        class="w-7 h-7 rounded-lg border transition-all"
                        :class="params.bg === 'transparent' ? 'border-primary ring-2 ring-primary/40' : 'border-white/15'"
                        style="background-image:repeating-conic-gradient(#5a5f6b 0% 25%,#31353d 0% 50%);background-size:10px 10px"
                      />
                      <button
                        v-for="c in B_COLORS" :key="c" @click="setBg(c)" :style="{ background: c }"
                        class="w-7 h-7 rounded-lg border transition-all"
                        :class="eq(params.bg, c) ? 'border-primary ring-2 ring-primary/40' : 'border-white/15'"
                      />
                      <label class="w-7 h-7 rounded-lg border border-white/15 bg-muted flex items-center justify-center cursor-pointer relative overflow-hidden text-muted-foreground">
                        <span class="icon-[lucide--pipette] w-3.5 h-3.5" />
                        <input type="color" :value="params.bg === 'transparent' ? '#000000' : params.bg" @input="setBg(($event.target as HTMLInputElement).value)" class="absolute inset-0 opacity-0 cursor-pointer" />
                      </label>
                    </div>
                  </div>
                </div>
              </ScrollArea>
            </TabsContent>

            <!-- 形态(分层)-->
            <TabsContent value="shape" class="flex-1 min-h-0 mt-0">
              <ScrollArea class="h-full">
                <div class="px-4 pb-6 pt-2 space-y-5">
                  <!-- 形态选择:外壳 × 内核 × 沙尘 × 连接(下拉,仿 Wisp)-->
                  <div>
                    <button
                      @click="galleryOpen = true"
                      class="w-full h-10 rounded-lg border border-border bg-muted/40 hover:bg-muted hover:border-primary/60 text-sm flex items-center justify-center gap-2 transition-colors mb-3"
                    >
                      <span class="icon-[lucide--layout-grid] w-4 h-4 text-primary" /> 形态画廊({{ GALLERY.length }} 种)
                    </button>
                    <div class="space-y-2">
                      <div class="grid grid-cols-[3.5rem_1fr] items-center gap-2">
                        <span class="text-xs text-muted-foreground">外壳</span>
                        <Select v-model="form.shell" @update:model-value="applyForm()">
                          <SelectTrigger class="h-8 w-full text-sm"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem v-for="o in SHELLS" :key="o.key" :value="o.key">{{ o.label }}</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div class="grid grid-cols-[3.5rem_1fr] items-center gap-2">
                        <span class="text-xs text-muted-foreground">内核</span>
                        <Select v-model="form.core" @update:model-value="applyForm()">
                          <SelectTrigger class="h-8 w-full text-sm"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem v-for="o in CORES" :key="o.key" :value="o.key">{{ o.label }}</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div class="grid grid-cols-[3.5rem_1fr] items-center gap-2">
                        <span class="text-xs text-muted-foreground">沙尘</span>
                        <Select v-model="form.dust" @update:model-value="applyForm()">
                          <SelectTrigger class="h-8 w-full text-sm"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem v-for="o in DUSTS" :key="o.key" :value="o.key">{{ o.label }}</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div class="grid grid-cols-[3.5rem_1fr] items-center gap-2">
                        <span class="text-xs text-muted-foreground">连接</span>
                        <Select v-model="form.conn" @update:model-value="applyForm()">
                          <SelectTrigger class="h-8 w-full text-sm"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem v-for="o in CONNS" :key="o.key" :value="o.key">{{ o.label }}</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    <button
                      @click="randomForm"
                      class="w-full h-9 mt-3 rounded-lg border border-border bg-muted/40 hover:bg-muted hover:border-primary/60 text-sm flex items-center justify-center gap-2 transition-colors"
                    >
                      <span class="icon-[lucide--dices] w-4 h-4 text-primary" /> 随机形态
                    </button>
                  </div>

                  <div>
                    <div class="text-xs text-muted-foreground mb-2">密度</div>
                    <div class="grid grid-cols-3 gap-1.5">
                      <button
                        v-for="d in ['低', '中', '高']" :key="d" @click="setDensity(d)"
                        class="py-1.5 rounded-md text-xs transition-colors"
                        :class="params.density === d ? 'bg-primary text-primary-foreground' : 'bg-muted/50 text-muted-foreground hover:bg-muted'"
                      >{{ d }}</button>
                    </div>
                  </div>
                  <div class="pt-3 border-t border-border/60 flex items-center gap-1.5 text-xs font-medium text-foreground/70">
                    <span class="icon-[lucide--sliders-horizontal] w-3.5 h-3.5" /> 精细微调
                  </div>
                  <!-- 每个分组一张卡片,清晰成块 -->
                  <div v-for="sec in SECTIONS" :key="sec.title" class="rounded-xl border border-border/60 bg-muted/20 p-3.5">
                    <div class="flex items-center gap-1.5 text-xs font-semibold text-foreground/85 mb-3">
                      <span v-if="sec.icon" :class="sec.icon" class="w-4 h-4 text-primary" />
                      {{ sec.title }}
                    </div>
                    <div class="space-y-3.5">
                      <div v-for="s in sec.items" :key="s.key">
                        <div class="flex items-center justify-between text-xs mb-1.5">
                          <span class="text-muted-foreground flex items-center gap-1.5">
                            <span :class="s.icon" class="w-3.5 h-3.5" /> {{ s.label }}
                          </span>
                          <span class="tabular-nums">{{ (params as any)[s.key].toFixed(s.step < 0.01 ? 3 : 2) }}</span>
                        </div>
                        <Slider
                          :model-value="[(params as any)[s.key]]"
                          :min="s.min" :max="s.max" :step="s.step"
                          @update:model-value="(v: number[] | undefined) => onSlide(s.key, v)"
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </ScrollArea>
            </TabsContent>

            <!-- 动态壁纸 -->
            <TabsContent value="wall" class="flex-1 min-h-0 mt-0">
              <div class="px-4 pt-4 space-y-4">
                <div class="flex items-center gap-2 text-sm font-medium">
                  <span class="icon-[lucide--monitor] w-4 h-4 text-primary" /> 动态壁纸
                </div>
                <div class="text-xs text-muted-foreground leading-relaxed">把当前这颗粒子球设为桌面动态壁纸,铺在桌面图标背后。颜色、形态、律动都跟随你现在的设置。</div>
                <button
                  v-if="!wallpaperOn" @click="startWallpaper"
                  class="w-full h-10 rounded-lg bg-primary text-primary-foreground text-sm flex items-center justify-center gap-2 hover:opacity-90"
                >
                  <span class="icon-[lucide--play] w-4 h-4" /> 开启动态壁纸
                </button>
                <button
                  v-else @click="stopWallpaper"
                  class="w-full h-10 rounded-lg border border-border bg-muted/40 text-sm flex items-center justify-center gap-2 hover:bg-muted"
                >
                  <span class="icon-[lucide--square] w-4 h-4" /> 停止动态壁纸
                </button>
                <div v-if="wallMsg" class="text-xs text-primary/90">{{ wallMsg }}</div>
                <div class="text-xs text-muted-foreground/60 leading-relaxed">
                  壁纸由独立小程序渲染,退出 XGTools 后仍保留。有全屏应用(游戏/视频)在前台时自动暂停,几乎不占 GPU。改好设置后重新「开启」即可更新。
                </div>
              </div>
            </TabsContent>

            <!-- 定时屏保 -->
            <TabsContent value="saver" class="flex-1 min-h-0 mt-0">
              <div class="px-4 pt-4 space-y-4">
                <div class="flex items-center gap-2 text-sm font-medium">
                  <span class="icon-[lucide--tv-minimal] w-4 h-4 text-primary" /> 定时屏保
                </div>
                <div class="text-xs text-muted-foreground leading-relaxed">无操作一段时间后自动全屏播放粒子球;动一下鼠标或按键即退出。</div>
                <div class="flex items-center gap-2">
                  <span class="text-xs text-muted-foreground">闲置</span>
                  <Input v-model.number="saverMinutes" type="number" min="1" max="120" class="h-8 w-20 text-sm" />
                  <span class="text-xs text-muted-foreground">分钟后启动</span>
                </div>
                <button
                  v-if="!saverOn" @click="enableSaver"
                  class="w-full h-10 rounded-lg bg-primary text-primary-foreground text-sm flex items-center justify-center gap-2 hover:opacity-90"
                >
                  <span class="icon-[lucide--play] w-4 h-4" /> 启用定时屏保
                </button>
                <button
                  v-else @click="disableSaver"
                  class="w-full h-10 rounded-lg border border-border bg-muted/40 text-sm flex items-center justify-center gap-2 hover:bg-muted"
                >
                  <span class="icon-[lucide--square] w-4 h-4" /> 关闭定时屏保
                </button>
                <div class="text-xs text-muted-foreground/60 leading-relaxed">
                  需 XGTools 保持运行(可在托盘)。屏保跟随你启用时的设置。
                </div>
              </div>
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>

    <!-- 隐藏的缩略图渲染 orb(生成完毕即卸载释放 GPU)-->
    <iframe
      v-if="showThumbGen" ref="thumbFrame"
      src="orb/index.html?fs=1&thumb=1&density=中"
      class="fixed bottom-0 right-0 opacity-0 pointer-events-none -z-10 border-0"
      style="width:220px;height:220px" aria-hidden="true" title="thumb"
    />

    <!-- 图集:方形预览大窗 -->
    <Dialog v-model:open="galleryOpen">
      <DialogContent class="max-w-[min(1120px,94vw)] w-[min(1120px,94vw)] h-[min(820px,90vh)] p-0 gap-0 overflow-hidden flex flex-col">
        <div class="flex items-center gap-3 px-5 py-3.5 border-b border-border shrink-0">
          <DialogTitle class="text-base font-semibold">形态画廊</DialogTitle>
          <span class="text-xs text-muted-foreground tabular-nums">{{ GALLERY_ALL.length }} 款 · 预览 {{ doneCount }}/{{ THUMBSET.length }}</span>
          <span v-if="showThumbGen" class="text-xs text-muted-foreground flex items-center gap-1">
            <span class="icon-[lucide--loader-circle] w-3.5 h-3.5 animate-spin" /> 预览生成中
          </span>
          <div class="flex-1" />
          <div class="relative w-56 max-w-[45vw]">
            <span class="icon-[lucide--search] w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input v-model="search" placeholder="搜索形态…" class="h-8 pl-8 text-sm" />
          </div>
        </div>
        <ScrollArea class="flex-1 min-h-0">
          <div class="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-3 p-5">
            <button
              v-for="p in filteredGallery" :key="p.name" @click="pickForm(p)"
              class="group relative rounded-xl overflow-hidden border border-border bg-black hover:border-primary/70 hover:ring-2 hover:ring-primary/30 transition-all aspect-square"
              :title="p.name"
            >
              <img v-if="thumbs[p.sig]" :src="thumbs[p.sig]" class="w-full h-full object-cover" alt="" />
              <div v-else class="w-full h-full grid place-items-center bg-linear-to-b from-white/5 to-transparent">
                <span :class="p.icon" class="w-6 h-6 text-white/25 animate-pulse" />
              </div>
              <div class="absolute inset-x-0 bottom-0 px-2 py-1.5 bg-linear-to-t from-black/85 to-transparent">
                <div class="flex items-center gap-1 text-[11px] text-white/90 truncate">
                  <span :class="p.icon" class="w-3 h-3 shrink-0 opacity-80" />
                  <span class="truncate">{{ p.name }}</span>
                </div>
              </div>
            </button>
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  </div>
</template>
