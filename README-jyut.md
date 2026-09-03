[English](README.md) | [官话 - 简体中文](README-cmn_CN.md) | [官話 - 繁體中文](README-cmn_TW.md) | 廣東話

<br>

<p align='center'>
  <img src='public/app-icon.png' width='120' />
</p>

<h1 align='center'>XGTools</h1>

<p align='center'>
  <samp>桌面細工具集 —— 日日要用一用嗰啲細工具，收埋喺一個圖示度</samp>
</p>

<p align='center'>
  <img src="https://img.shields.io/badge/Tauri-v2-FFC131?style=flat-square&logo=tauri" />
  <img src="https://img.shields.io/badge/Vue-3-4FC08D?style=flat-square&logo=vue.js" />
  <img src="https://img.shields.io/badge/Rust-2021-DEA584?style=flat-square&logo=rust" />
  <img src="https://img.shields.io/badge/TypeScript-5.6-3178C6?style=flat-square&logo=typescript" />
  <img src="https://img.shields.io/badge/version-v0.4.2-blue?style=flat-square" />
  <img src="https://img.shields.io/badge/license-CC%20BY--NC--SA%204.0-blue?style=flat-square" />
</p>

<p align='center'>
  <a href="https://github.com/XXGGG/XGTools/releases">下載</a>
</p>

<br>

## 👋 講咩嚟嘅

計時器、翻譯、轉格式、連 OCR 嘅截圖、啟動台、撳掣顯示 —— 呢啲日日都要用一用嘅細工具，
XGTools 一次過收晒喺工作列嗰一個圖示入面，唔使一件事裝一個軟件 —— 每個都自己一個
更新器、自己霸個圖示位、自己一套諗法嘅設定窗。

自己整嚟自己用嘅嘢，淨係為一部 Windows 機寫，照原樣攞出嚟分享。

> [!IMPORTANT]
> **v0.2.0 —— 下面列嗰啲全部用得，得一樣例外。**「鍵盤桌寵」嗰版而家淨係做咗撳掣顯示，
> 隻寵物本身未整。

<div align="center">
  <img src="docs/images/social-preview.png" width="820" />
</div>

<div align="center">
  <img src="docs/images/screenshot-home.png" width="820" />
</div>

## ✨ 邊度唔同

**框架係浮起嘅，所以內容係對住成個窗置中。** 側欄同頂欄係浮層，唔佔版面。
一般做法係將內容擺喺「扣走側欄同頂欄之後淨低嗰嚿」入面置中，咁樣任何置中嘅嘢
都會向右下各偏半個框架闊度。呢度內容層鋪滿成個窗、框架冚喺佢上面，所以置中係真置中。

**得一個對齊常數，唔使逐處手動補位。** Logo、側欄圖示嗰行、右上角控件全部由同一個
72px 嘅欄推出嚟。改嗰個數，三樣嘢一齊郁，唔使為每一處另外加個偏移。

**窗嘅材質喺 CSS 度砌，唔係掉畀系統。** Windows 11 build 22523 之後，亞加力同雲母
嗰兩個 API 會直接無視你傳入嘅顏色，系統淨係負責「矇」呢一樣。底面、卡片、邊框、陰影
全部由 CSS 一層層疊出嚟 —— 所以呢度嘅透明度掣真係推得郁，邊框亦都會跟住主題行，
唔會成日都係一條死白線。

**每一版功能都可以熄咗佢。** 側欄完全由你話事：拖嚟排序、跨組拖過去改佢屬邊張卡、
逐項開關。全部熄晒嗰張卡會直情消失 —— 設定入口係長駐嘅，所以你點熄都唔會入唔返去。

<div align="center">
  <img src="docs/images/screenshot-settings.png" width="820" />
</div>

## 🚀 點開始

去 [Releases](https://github.com/XXGGG/XGTools/releases) 攞安裝檔，或者自己 build：

```bash
pnpm install

# 轉格式要用 ffmpeg —— 將 ffmpeg.exe 同 ffprobe.exe 掉入
# src-tauri/resources/ffmpeg/  （https://github.com/BtbN/FFmpeg-Builds/releases）

pnpm tauri dev      # 開發
pnpm tauri build    # 安裝檔 -> src-tauri/target/release/bundle/nsis/
```

要求：Node.js 18+、Rust 1.77+、pnpm，同埋 Windows 10/11 —— 有幾個功能直接叫 Win32 API，
冇跨平台嗰條路行。

## 📦 有啲乜

| | |
|---|---|
| **計時器** | 撳空白鍵開嘅扭計骰計時，加埋轉版都唔會斷嘅蕃茄鐘 |
| **翻譯** | Google / Bing / DeepL，仲有 OpenAI 相容嗰啲（OpenAI、DeepSeek、Claude、Gemini、Groq）。譯文讀得出聲 |
| **轉格式** | 相、聲、片都得，內置 ffmpeg；仲可以由片度抽條聲出嚟 |
| **啟動台** | 成個芒嘅程式格，拖得郁、分得版，圖示直接由 exe 度抽 |
| **截圖** | 圈選、畫嘢、黐窗、釘住、OCR（PaddleOCR）、就地翻譯 |
| **鍵盤** | 全域撳掣顯示，自動排位、識閃開老鼠，過咗你設嘅秒數自動清走 |

<div align="center">
  <img src="docs/images/screenshot-sidebar.png" width="820" />
</div>

## 📁 結構

```
src/
  App.vue                    分窗 + 浮起嘅框架
  components/TitleBar.vue    Logo、頁面 Tabs 嘅 Teleport 目標、窗控件
  components/ParticleLogo.vue  canvas 粒子 Logo（離屏畫一次再採樣）
  composables/               成個 app 共用嘅設定，寫入 settings.json
  lib/sidebar-prefs.ts       側欄次序／顯唔顯示嘅對數邏輯（純函數，測得到）
  views/                     一版工具一個檔
src-tauri/src/
  window_effects.rs          雲母 / 亞加力，同埋 Windows 要嘅深色屬性
  *_commands.rs              截圖、OCR、翻譯、轉格式、啟動台、偵測窗
```

## 🙏 多謝

**框架** —— [Tauri](https://tauri.app)、[Vue.js](https://vuejs.org)、
[Tailwind CSS](https://tailwindcss.com)
**UI** —— [shadcn-vue](https://www.shadcn-vue.com)（行 [reka-ui](https://reka-ui.com)）、
[Lucide](https://lucide.dev) 圖示
**截圖同 OCR** —— [xcap](https://github.com/nashaofu/xcap)、
[PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR)、
[ONNX Runtime](https://onnxruntime.ai)
**輸入同特效** —— [rdev](https://github.com/Narsil/rdev)、
[window-vibrancy](https://github.com/tauri-apps/window-vibrancy)

粒子 Logo 嗰個**諗頭**係睇返 [nuxtlabs.com](https://nuxtlabs.com) 上面嗰個互動 ——
呢度嘅實作由零寫起，冇用過佢哋任何一行 code。

README 版式參考 [vitesse](https://github.com/antfu-collective/vitesse) 同
[BewlyBewly](https://github.com/BewlyBewly/BewlyBewly)。

## 授權

[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) ——
用得、改得、派得，要註明出處，**唔可以商用**，改完出嚟嘅嘢要用返同一個授權。

Copyright © 2026 [Xie Xiage](https://github.com/XXGGG)
