<div align="center">
  <img src='public/app-icon.png' width='120'/>
</div>

<h1 align="center">XGTools</h1>

<p align="center">
  <samp>一个极简风格的桌面工具集，基于 Tauri v2 + Vue 3 构建</samp>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Tauri-v2-orange?style=flat-square&logo=tauri" />
  <img src="https://img.shields.io/badge/Vue-3-4FC08D?style=flat-square&logo=vue.js" />
  <img src="https://img.shields.io/badge/Rust-2021-DEA584?style=flat-square&logo=rust" />
  <img src="https://img.shields.io/badge/TypeScript-5.6-3178C6?style=flat-square&logo=typescript" />
  <img src="https://img.shields.io/badge/license-CC%20BY--NC--SA%204.0-blue?style=flat-square" />
</p>

---

## 简介

XGTools 是一个多功能桌面工具集，追求极简黑白设计风格。集成了待办事项、计时器、截图 OCR、翻译、格式转换等日常高频功能，开箱即用。

> 本项目仅供学习使用，不可商用。

## 功能

### 📋 待办事项
- 任务的增删改查、完成标记
- 支持重复任务（每日/每周/自定义间隔）
- 数据持久化，刷新不丢失

### ⏱ 计时器
- **魔方计时** — 空格键驱动的秒表，按住松开开始、再按停止、空格快速保存
    - 历史记录浮窗面板，统计最快/平均/最慢
- **番茄时钟** — SVG 圆环倒计时，可自定义时长，切换页面不中断


### 🚀 Windows 启动台
- 应用网格展示，拖拽排序
- 分页管理，自定义应用

### ⌨️ 键盘桌宠
- 全局键盘监听，实时显示按键
- 键盘桌宠（开发中...）

### 📸 截图
- **原生截图窗口**（Sidecar，winit + wgpu）
- 选区截图、全屏截图
- 标注工具（矩形、箭头、文字等）
- OCR 文字识别（PaddleOCR）
- 钉图功能

### 🌐 翻译
- 多翻译引擎支持、AI翻译

### 🔄 格式转换
- 多种文件格式互转

### ⚙️ 系统集成
- 开机自启
- 深色/浅色主题切换
- 系统托盘
- 全局快捷键

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端框架 | Vue 3 + TypeScript |
| 桌面框架 | Tauri v2 (Rust) |
| UI 组件 | shadcn-vue (reka-ui) |
| 样式 | Tailwind CSS v4 |
| 状态管理 | Pinia |
| 图标 | Lucide (Iconify) |
| 截图渲染 | wgpu + winit (Sidecar) |
| OCR | PaddleOCR + ONNX Runtime |
| 输入监听 | rdev |

## 开发

### 环境要求

- [Node.js](https://nodejs.org/) >= 18
- [Rust](https://www.rust-lang.org/tools/install) >= 1.77
- [pnpm](https://pnpm.io/) (推荐)
- Windows 10/11（部分功能依赖 Windows API）

### 安装与运行

```bash
# 克隆项目
git clone https://github.com/XXGGG/XGTools.git
cd XGTools

# 安装依赖
pnpm install

# 开发模式
pnpm tauri dev

# 构建
pnpm tauri build
```

## 项目结构

```
XGTools/
├── src/                          # 前端源码
│   ├── App.vue                   # 主应用（侧栏导航 + 视图路由）
│   ├── views/                    # 功能视图
│   │   ├── Todo.vue              # 待办事项
│   │   ├── Timer.vue             # 计时器（魔方 + 番茄）
│   │   ├── Dock.vue              # 启动台
│   │   ├── KeyboardPet.vue       # 键盘桌宠
│   │   ├── Screenshot.vue        # 截图设置
│   │   ├── Translate.vue         # 翻译
│   │   └── Convert.vue           # 格式转换
│   ├── composables/              # 组合式函数
│   │   └── usePomodoroTimer.ts   # 番茄钟逻辑（模块级持久）
│   ├── components/ui/            # shadcn-vue 组件
│   ├── dock/                     # 启动台组件 + 状态
│   ├── screenshot/               # 截图前端（标注、选区等）
│   └── KeyVisualizerWindow.vue   # 按键可视化窗口
│
├── src-tauri/                    # Rust 后端
│   ├── src/
│   │   ├── lib.rs                # 核心（输入监听、窗口管理）
│   │   ├── dock_commands.rs      # 启动台命令
│   │   ├── screenshot_commands.rs# 截图命令
│   │   ├── ocr_commands.rs       # OCR 命令
│   │   ├── translate_commands.rs # 翻译命令
│   │   ├── convert_commands.rs   # 格式转换命令
│   │   ├── window_detect.rs      # 窗口检测
│   │   └── icon_extractor.rs     # 图标提取（Windows）
│   └── bin/screenshot/           # 截图 Sidecar（独立原生窗口）
│       ├── src/main.rs           # winit 窗口 + wgpu 渲染
│       ├── src/overlay.rs        # 覆盖层绘制
│       ├── src/shader.wgsl       # WGSL 着色器
│       └── Cargo.toml
│
└── public/                       # 静态资源
```

## 鸣谢

感谢以下开源项目：

**框架**
- [Tauri](https://tauri.app) — 跨平台桌面应用框架
- [Vue.js](https://vuejs.org) — 渐进式前端框架
- [Tailwind CSS](https://tailwindcss.com) — 原子化 CSS 框架

**UI**
- [shadcn-vue](https://www.shadcn-vue.com) — 基于 reka-ui 的 Vue 组件库
- [Lucide](https://lucide.dev) — 简洁的开源图标库

**截图**
- [Exotik850/cleave](https://github.com/Exotik850/cleave) — 截图架构参考（winit + wgpu + xcap）
- [xcap](https://github.com/nicehash/xcap) — 跨平台屏幕截图
- [wgpu](https://wgpu.rs) — 安全的 GPU 渲染

**AI/OCR**
- [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) — 文字识别引擎
- [ONNX Runtime](https://onnxruntime.ai) — 跨平台推理框架

**工具**
- [rdev](https://github.com/Narsil/rdev) — 全局输入事件监听
- [VueUse](https://vueuse.org) — Vue 组合式工具集
- [Pinia](https://pinia.vuejs.org) — Vue 状态管理

## 许可协议

本项目采用 [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) 许可协议。

- ✅ 可自由使用、修改和分发
- ✅ 需注明出处
- ❌ 不可商用
- 🔄 衍生作品需使用相同协议

Copyright © 2026 [Xie Xiage](https://github.com/XXGGG)
