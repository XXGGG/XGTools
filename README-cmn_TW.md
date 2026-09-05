[English](README.md) | [官话 - 简体中文](README-cmn_CN.md) | 官話 - 繁體中文 | [廣東話](README-jyut.md)

<br>

<p align='center'>
  <img src='public/app-icon.png' width='120' />
</p>

<h1 align='center'>XGTools</h1>

<p align='center'>
  <samp>桌面小工具集 —— 每天要用一下的那些小工具，收進一個圖示</samp>
</p>

<p align='center'>
  <img src="https://img.shields.io/badge/Tauri-v2-FFC131?style=flat-square&logo=tauri" />
  <img src="https://img.shields.io/badge/Vue-3-4FC08D?style=flat-square&logo=vue.js" />
  <img src="https://img.shields.io/badge/Rust-2021-DEA584?style=flat-square&logo=rust" />
  <img src="https://img.shields.io/badge/TypeScript-5.6-3178C6?style=flat-square&logo=typescript" />
  <img src="https://img.shields.io/badge/version-v0.8.4-blue?style=flat-square" />
  <img src="https://img.shields.io/badge/license-CC%20BY--NC--SA%204.0-blue?style=flat-square" />
</p>

<p align='center'>
  <a href="https://github.com/XXGGG/XGTools/releases">下載</a>
</p>

<br>

## 👋 簡介

計時器、翻譯、格式轉換、附 OCR 的截圖、啟動台、按鍵顯示 —— 這些每天都要用一下的小工具，
XGTools 把它們收進系統匣裡的一個圖示，而不是一件事裝一個軟體 —— 各自帶更新器、
各自佔一個匣位、各自對「設定視窗該長什麼樣」有一套想法。

自用工具，為一台 Windows 機器寫的，原樣分享。

> [!IMPORTANT]
> **v0.2.0 —— 下面列的都能用，只有一項例外。**「鍵盤桌寵」這一頁目前只做了按鍵顯示，
> 桌寵本身還沒做。

<div align="center">
  <img src="docs/images/social-preview.png" width="820" />
</div>

<div align="center">
  <img src="docs/images/screenshot-home.png" width="820" />
</div>

## ✨ 有什麼不一樣

**框架是浮空的，所以內容是相對整個視窗置中。** 側欄和頂欄是浮層，不參與版面配置。
常規做法是把內容在「扣掉側欄和頂欄之後剩下的那塊」裡置中，結果任何置中的東西都會
偏右下各半個框架寬度。這裡內容層鋪滿整個視窗、框架壓在它上面，所以置中是真的置中。

**一個對齊常數，而不是各處手調偏移。** Logo、側欄圖示列、右上角控制項都從同一個 72px
的欄推出來。改那一個數，三者一起動，不需要為每處單獨補一個偏移。

**視窗材質在 CSS 裡合成，而不是交給系統。** Windows 11 build 22523 之後，壓克力和雲母
的 API 會忽略你傳進去的著色，系統只負責「模糊」這一件事。底面、卡片、邊框、陰影全部
由 CSS 分層疊出來 —— 這也是為什麼這裡的不透明度滑桿真的推得動東西，以及為什麼邊框會
跟著佈景主題走，而不是永遠一條硬白線。

**每個功能頁都能關掉。** 側欄完全由你定義：拖曳排序、跨組拖曳改變它歸哪張卡片、
逐項開關。全部關掉那張卡片會整個消失 —— 設定入口是常駐的，所以不存在把自己關到進不去。

<div align="center">
  <img src="docs/images/screenshot-settings.png" width="820" />
</div>

## 🚀 開始用

從 [Releases](https://github.com/XXGGG/XGTools/releases) 下載安裝檔，或者自己建置：

```bash
pnpm install

# 格式轉換需要 ffmpeg —— 把 ffmpeg.exe 和 ffprobe.exe 放進
# src-tauri/resources/ffmpeg/  （https://github.com/BtbN/FFmpeg-Builds/releases）

pnpm tauri dev      # 開發
pnpm tauri build    # 安裝檔 -> src-tauri/target/release/bundle/nsis/
```

環境需求：Node.js 18+、Rust 1.77+、pnpm，以及 Windows 10/11 —— 有幾個功能直接呼叫
Win32 API，沒有跨平台的路。

## 📦 都有什麼

| | |
|---|---|
| **計時器** | 空白鍵驅動的魔術方塊計時，外加切換頁面也不中斷的番茄鐘 |
| **翻譯** | Google / Bing / DeepL，以及 OpenAI 相容介面（OpenAI、DeepSeek、Claude、Gemini、Groq）。譯文可朗讀 |
| **格式轉換** | 圖片、音訊、視訊，內建 ffmpeg；支援從影片裡擷取音軌 |
| **啟動台** | 全螢幕應用程式格狀排列，可拖曳排序、分頁，圖示直接從執行檔裡抽 |
| **截圖** | 選區、標註、視窗吸附、釘圖、OCR（PaddleOCR）、原地翻譯 |
| **鍵盤** | 全域按鍵顯示，自動排布、閃避滑鼠，延時可調後自動清除 |

<div align="center">
  <img src="docs/images/screenshot-sidebar.png" width="820" />
</div>

## 📁 結構

```
src/
  App.vue                    視窗分流 + 浮空框架
  components/TitleBar.vue    Logo、頁面 Tabs 的 Teleport 目標、視窗控制項
  components/ParticleLogo.vue  canvas 粒子 Logo（離屏描一遍再取樣）
  composables/               全應用共用的設定狀態，持久化到 settings.json
  lib/sidebar-prefs.ts       側欄順序/可見性的對帳邏輯（純函式，可斷言）
  views/                     一個工具頁一個檔案
src-tauri/src/
  window_effects.rs          雲母 / 壓克力，以及 Windows 需要的深色屬性
  *_commands.rs              截圖、OCR、翻譯、轉換、啟動台、視窗偵測
```

## 🙏 致謝

**框架** —— [Tauri](https://tauri.app)、[Vue.js](https://vuejs.org)、
[Tailwind CSS](https://tailwindcss.com)
**UI** —— [shadcn-vue](https://www.shadcn-vue.com)（基於 [reka-ui](https://reka-ui.com)）、
[Lucide](https://lucide.dev) 圖示
**截圖與 OCR** —— [xcap](https://github.com/nashaofu/xcap)、
[PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR)、
[ONNX Runtime](https://onnxruntime.ai)
**輸入與特效** —— [rdev](https://github.com/Narsil/rdev)、
[window-vibrancy](https://github.com/tauri-apps/window-vibrancy)

粒子 Logo 的**想法**來自 [nuxtlabs.com](https://nuxtlabs.com) 上的那個互動 ——
這裡的實作是從零寫的，沒有用他們的任何程式碼。

README 版式參考 [vitesse](https://github.com/antfu-collective/vitesse) 與
[BewlyBewly](https://github.com/BewlyBewly/BewlyBewly)。

## 授權條款

[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) ——
可自由使用、修改、散布，需註明出處，**不可商用**，衍生作品需使用相同條款。

Copyright © 2026 [Xie Xiage](https://github.com/XXGGG)
