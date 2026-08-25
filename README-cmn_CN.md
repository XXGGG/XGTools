[English](README.md) | 官话 - 简体中文 | [官話 - 繁體中文](README-cmn_TW.md) | [廣東話](README-jyut.md)

<br>

<p align='center'>
  <img src='public/app-icon.png' width='120' />
</p>

<h1 align='center'>XGTools</h1>

<p align='center'>
  <samp>Windows 桌面工具集 —— 用一个窗口代替六个小软件</samp>
</p>

<p align='center'>
  <img src="https://img.shields.io/badge/Tauri-v2-FFC131?style=flat-square&logo=tauri" />
  <img src="https://img.shields.io/badge/Vue-3-4FC08D?style=flat-square&logo=vue.js" />
  <img src="https://img.shields.io/badge/Rust-2021-DEA584?style=flat-square&logo=rust" />
  <img src="https://img.shields.io/badge/TypeScript-5.6-3178C6?style=flat-square&logo=typescript" />
  <img src="https://img.shields.io/badge/version-v0.2.0-blue?style=flat-square" />
  <img src="https://img.shields.io/badge/license-CC%20BY--NC--SA%204.0-blue?style=flat-square" />
</p>

<p align='center'>
  <a href="https://github.com/XXGGG/XGTools/releases">下载</a>
</p>

<br>

## 👋 简介

计时器、翻译、格式转换、带 OCR 的截图、启动台、按键显示 —— 这些每天都要用一下的小工具，
XGTools 把它们收进托盘里的一个图标，而不是六个各自带更新器、各自占一个托盘位、
各自对「设置窗口该长什么样」有一套想法的独立程序。

自用工具，为一台 Windows 机器写的，原样分享。

> [!IMPORTANT]
> **v0.2.0 —— 下面列的都能用，只有一项例外。**「键盘桌宠」这一页目前只做了按键显示，
> 桌宠本身还没做。

<div align="center">
  <img src="docs/images/social-preview.png" width="820" />
</div>

<div align="center">
  <img src="docs/images/screenshot-home.png" width="820" />
</div>

## ✨ 有什么不一样

**框架是浮空的，所以内容是相对整个窗口居中。** 侧栏和顶栏是浮层，不参与布局。
常规做法是把内容在「减掉侧栏和顶栏之后剩下的那块」里居中，结果任何居中的东西都会
偏右下各半个框架宽度。这里内容层铺满整窗、框架压在它上面，所以居中是真的居中。

**一个对齐常量，而不是各处手调偏移。** Logo、侧栏图标列、右上角控件都从同一个 72px
的列推出来。改那一个数，三者一起动，不需要为每处单独补一个偏移。

**窗口材质在 CSS 里合成，而不是交给系统。** Windows 11 build 22523 之后，亚克力和云母
的 API 会忽略你传进去的着色，系统只负责「模糊」这一件事。底面、卡片、边框、阴影全部
由 CSS 分层叠出来 —— 这也是为什么这里的不透明度滑块真的推得动东西，以及为什么边框会
跟着主题走，而不是永远一条硬白线。

**每个功能页都能关掉。** 侧栏完全由你定义：拖拽排序、跨组拖动改变它归哪张卡片、
逐项开关。全部关掉那张卡片会整个消失 —— 设置入口是常驻的，所以不存在把自己关到进不去。

<div align="center">
  <img src="docs/images/screenshot-settings.png" width="820" />
</div>

## 🚀 开始用

从 [Releases](https://github.com/XXGGG/XGTools/releases) 下安装包，或者自己构建：

```bash
pnpm install

# 格式转换需要 ffmpeg —— 把 ffmpeg.exe 和 ffprobe.exe 放进
# src-tauri/resources/ffmpeg/  （https://github.com/BtbN/FFmpeg-Builds/releases）

pnpm tauri dev      # 开发
pnpm tauri build    # 安装包 -> src-tauri/target/release/bundle/nsis/
```

环境要求：Node.js 18+、Rust 1.77+、pnpm，以及 Windows 10/11 —— 有几个功能直接调
Win32 API，没有跨平台的路。

## 📦 都有什么

| | |
|---|---|
| **计时器** | 空格键驱动的魔方计时，外加切换页面也不中断的番茄钟 |
| **翻译** | Google / Bing / DeepL，以及 OpenAI 兼容接口（OpenAI、DeepSeek、Claude、Gemini、Groq）。译文可朗读 |
| **格式转换** | 图片、音频、视频，内置 ffmpeg；支持从视频里提取音轨 |
| **启动台** | 全屏应用网格，可拖拽排序、分页，图标直接从可执行文件里抽 |
| **截图** | 选区、标注、窗口吸附、钉图、OCR（PaddleOCR）、原地翻译 |
| **键盘** | 全局按键显示，自动排布、躲避鼠标，延时可调后自动清除 |

<div align="center">
  <img src="docs/images/screenshot-sidebar.png" width="820" />
</div>

## 📁 结构

```
src/
  App.vue                    窗口分流 + 浮空框架
  components/TitleBar.vue    Logo、页面 Tabs 的 Teleport 目标、窗口控件
  components/ParticleLogo.vue  canvas 粒子 Logo（离屏描一遍再采样）
  composables/               全应用共享的设置状态，持久化到 settings.json
  lib/sidebar-prefs.ts       侧栏顺序/可见性的对账逻辑（纯函数，可断言）
  views/                     一个工具页一个文件
src-tauri/src/
  window_effects.rs          云母 / 亚克力，以及 Windows 需要的深色属性
  *_commands.rs              截图、OCR、翻译、转换、启动台、窗口检测
```

## 🙏 致谢

**框架** —— [Tauri](https://tauri.app)、[Vue.js](https://vuejs.org)、
[Tailwind CSS](https://tailwindcss.com)
**UI** —— [shadcn-vue](https://www.shadcn-vue.com)（基于 [reka-ui](https://reka-ui.com)）、
[Lucide](https://lucide.dev) 图标
**截图与 OCR** —— [xcap](https://github.com/nashaofu/xcap)、
[PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR)、
[ONNX Runtime](https://onnxruntime.ai)
**输入与特效** —— [rdev](https://github.com/Narsil/rdev)、
[window-vibrancy](https://github.com/tauri-apps/window-vibrancy)

粒子 Logo 的**想法**来自 [nuxtlabs.com](https://nuxtlabs.com) 上的那个交互 ——
这里的实现是从零写的，没有用他们的任何代码。

README 版式参考 [vitesse](https://github.com/antfu-collective/vitesse) 与
[BewlyBewly](https://github.com/BewlyBewly/BewlyBewly)。

## 许可协议

[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) ——
可自由使用、修改、分发，需注明出处，**不可商用**，衍生作品需使用相同协议。

Copyright © 2026 [Xie Xiage](https://github.com/XXGGG)
