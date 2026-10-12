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
  <img src="https://img.shields.io/badge/version-v0.16.0-blue?style=flat-square" />
  <img src="https://img.shields.io/badge/license-CC%20BY--NC--SA%204.0-blue?style=flat-square" />
</p>

<p align='center'>
  <a href="https://github.com/XXGGG/XGTools/releases">下載</a>
</p>

<br>

## 👋 簡介

XGTools 把每天要用一下的小工具 —— 提示詞詞庫、字型庫、音訊試聽、Markdown 筆記、計時器、
翻譯、格式轉換、帶 OCR 的截圖、啟動台 —— 收進系統匣裡的一個圖示，不用一個功能裝一個軟體。

這是一個自用工具，為一台 Windows 電腦做的，原樣分享出來。

> [!IMPORTANT]
> **v0.16.0 —— 下面列的都能用，除了這幾樣：**「鍵盤桌寵」頁目前只有按鍵顯示，桌寵本身還沒做；
> 字型「套用到 Affinity」接好了連線，還沒做完。

<div align="center">
  <img src="docs/images/social-preview.png" width="820" />
</div>

<div align="center">
  <img src="docs/images/screenshot-prompt.png" width="820" />
</div>

## ✨ 有什麼不一樣

**一整塊介面，不是一疊卡片。** 頁面直接鋪在視窗的雲母 / 壓克力材質上，只有左邊導覽列和頂部分頁
是面板，而且也是通透的。清單捲到邊上是漸隱，不是被卡片邊框一刀切掉。

**會跟別的軟體連動的字型庫。** 點一款字，Photoshop、DaVinci Resolve（Fusion 的 Text+）、PhotoCraft
裡選取的文字就換成它。字型裝進 Windows 的個人字型資料夾，跟右鍵「安裝」一模一樣，所有軟體都認得；
還有一個置頂的 mini 小視窗，把常用的字放在你正在做圖的軟體旁邊。每款字都會讀授權，告訴你能不能
打包進遊戲、用在影片裡、做圖印刷。

<div align="center">
  <img src="docs/images/screenshot-fonts.png" width="820" />
</div>

**給二次元模型準備的提示詞詞庫。** 約 2250 個 Danbooru 標籤、139 個小類，按層上色（品質、
鏡頭、場景、人物、服裝、動作……），按語意去重，搜尋認得同義詞。自然語言視窗把中文描述整理成
Anima 這類模型吃的英文句子；常用組合可以存成預設。

**自己會更新。** 新版本發在 GitHub Releases，軟體啟動時檢查，一鍵下載安裝（帶簽章驗證，
被改過的安裝檔會被拒絕）。

<div align="center">
  <img src="docs/images/screenshot-audio.png" width="820" />
</div>

## 🚀 開始用

到 [Releases](https://github.com/XXGGG/XGTools/releases/latest) 下載安裝檔 —— 裝好以後，
更新都在軟體裡完成。也可以自己建置：

```bash
pnpm install

# Format conversion needs ffmpeg — drop ffmpeg.exe and ffprobe.exe into
# src-tauri/resources/ffmpeg/  (https://github.com/BtbN/FFmpeg-Builds/releases)

pnpm tauri dev      # development
pnpm dist           # installer -> installer/
```

環境需求：Node.js 18+、Rust 1.77+、pnpm，Windows 10/11 —— 好幾個功能直接呼叫 Win32 API，沒有跨平台的路。

## 📦 都有什麼

| | |
|---|---|
| **提示詞** | Danbooru 標籤詞庫，分層配色、搜尋、預設，還有自然語言 → 提示詞視窗 |
| **筆記** | 本機 Markdown 筆記：分頁、反向連結、歷史版本、畫布 |
| **字型庫** | 授權體檢、一鍵安裝、套用到別的軟體、mini 小視窗、整列拖出字型檔 |
| **音訊試聽** | 音效庫波形瀏覽：裁剪、轉格式、直接拖進專案 |
| **計時器** | 空白鍵操作的魔術方塊計時，加一個切頁面也不停的番茄鐘錶盤 |
| **翻譯** | 離線（Bergamot）或線上引擎，也能接任何 OpenAI 相容的大模型 |
| **格式轉換** | 圖片、音訊、影片，用內建的 ffmpeg |
| **啟動台** | 全螢幕應用程式格線，拖曳排序，資料夾換圖示 |
| **截圖** | 框選、標註、釘在螢幕上、錄影、OCR、原地翻譯 |
| **命令面板** | 一個快捷鍵搜尋應用程式、筆記、檔案，或者直接翻譯 |

<div align="center">
  <img src="docs/images/screenshot-notes.png" width="820" />
</div>

<div align="center">
  <img src="docs/images/screenshot-timer.png" width="820" />
</div>

## 📁 結構

```
src/
  App.vue                    window routing + the floating chrome
  components/TitleBar.vue    teleport target for page tabs, window controls
  composables/               shared reactive settings (settings.json), updater
  lib/sidebar-prefs.ts       sidebar order/visibility reconciliation (pure, testable)
  lib/prompt/                prompt tag library, dedupe, synonyms
  views/                     one file per tool page
src-tauri/src/
  window_effects.rs          mica / acrylic, and the dark-mode attribute Windows needs
  font_commands.rs           font scan / install (per-user Fonts folder + shared ledger)
  font_apply.rs              apply a font to Photoshop / DaVinci Resolve / PhotoCraft
  *_commands.rs              screenshot, OCR, translate, convert, audio, launcher
```

## 🙏 致謝

**框架** —— [Tauri](https://tauri.app)、[Vue.js](https://vuejs.org)、
[Tailwind CSS](https://tailwindcss.com)
**介面** —— [shadcn-vue](https://www.shadcn-vue.com)（基於 [reka-ui](https://reka-ui.com)）、
[Lucide](https://lucide.dev) 圖示
**截圖與 OCR** —— [xcap](https://github.com/nashaofu/xcap)、
[PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR)、
[ONNX Runtime](https://onnxruntime.ai)
**輸入與特效** —— [rdev](https://github.com/Narsil/rdev)、
[window-vibrancy](https://github.com/tauri-apps/window-vibrancy)
**離線翻譯** —— [Bergamot](https://browser.mt) 和 Mozilla 的翻譯模型
**提示詞標籤** —— 標籤名沿用 [Danbooru](https://danbooru.donmai.us)

應用程式圖示是一個口袋，從零畫的 —— **點子**來自哆啦 A 夢的四次元口袋，所有道具都是從裡面掏出來的。
拿來當工具箱正合適。

README 版面參考 [vitesse](https://github.com/antfu-collective/vitesse) 和
[BewlyBewly](https://github.com/BewlyBewly/BewlyBewly)。

## 授權條款

[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/deed.zh-hant) —— 可以自由使用、
修改和分享，需署名、**不可商用**、改編作品須用相同授權。

Copyright © 2026 [Xie Xiage](https://github.com/XXGGG)
