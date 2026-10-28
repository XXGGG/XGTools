English | [官话 - 简体中文](README-cmn_CN.md) | [官話 - 繁體中文](README-cmn_TW.md) | [廣東話](README-jyut.md)

<br>

<p align='center'>
  <img src='public/app-icon.png' width='120' />
</p>

<h1 align='center'>XGTools</h1>

<p align='center'>
  <samp>A desktop toolbox — the small utilities you reach for daily, behind one icon</samp>
</p>

<p align='center'>
  <img src="https://img.shields.io/badge/Tauri-v2-FFC131?style=flat-square&logo=tauri" />
  <img src="https://img.shields.io/badge/Vue-3-4FC08D?style=flat-square&logo=vue.js" />
  <img src="https://img.shields.io/badge/Rust-2021-DEA584?style=flat-square&logo=rust" />
  <img src="https://img.shields.io/badge/TypeScript-5.6-3178C6?style=flat-square&logo=typescript" />
  <img src="https://img.shields.io/badge/version-v0.17.0-blue?style=flat-square" />
  <img src="https://img.shields.io/badge/license-CC%20BY--NC--SA%204.0-blue?style=flat-square" />
</p>

<p align='center'>
  <a href="https://github.com/XXGGG/XGTools/releases">Download</a>
</p>

<br>

## 👋 Introduction

XGTools puts the small utilities you reach for every day — a prompt tag library, a font
manager, an audio browser, Markdown notes, a timer, a translator, a file converter, a
screenshot tool with OCR, an app launcher — behind a single icon in the tray, instead of a
separate program per task.

It is a personal tool, built for one Windows machine and shared as-is.

> [!IMPORTANT]
> **v0.16.0 — everything listed below works, with these exceptions.** The *Keyboard Pet*
> page only ships the key-press overlay; the pet itself is not built yet. Applying fonts to
> *Affinity* is wired up but not finished.

<div align="center">
  <img src="docs/images/social-preview.png" width="820" />
</div>

<div align="center">
  <img src="docs/images/screenshot-prompt.png" width="820" />
</div>

## ✨ What makes it different

**One surface, not a stack of cards.** Pages sit directly on the window's mica / acrylic
material; the only panels are the navigation bar and the page tabs, and those are
translucent too. Lists fade out at their edges instead of being cut off by a card border.

**A font manager that talks to your other apps.** Click a font and the selected text in
Photoshop, DaVinci Resolve (Fusion Text+) or PhotoCraft switches to it. Fonts are installed
into Windows' per-user Fonts folder — exactly like right-click → Install — so every program
sees them; an always-on-top mini window keeps your favourites next to whatever you are
designing in. Every font also gets a licence check: can it ship in a game, a video, print?

<div align="center">
  <img src="docs/images/screenshot-fonts.png" width="820" />
</div>

**A prompt tag library built for anime models.** About 2,250 Danbooru tags in 139
categories, colour-coded by layer (quality, camera, scene, character, outfit, pose…),
de-duplicated by meaning, searchable with synonyms. A natural-language window turns a
Chinese description into an English sentence for models like Anima, and presets store your
own combinations.

**It updates itself.** New versions are published on GitHub Releases; the app checks on
start-up and installs an update with one click (signed, so a tampered package is refused).

<div align="center">
  <img src="docs/images/screenshot-audio.png" width="820" />
</div>

## 🚀 Getting started

Download the installer from [Releases](https://github.com/XXGGG/XGTools/releases/latest)
— after that, updates arrive inside the app. Or build it yourself:

```bash
pnpm install

# Format conversion needs ffmpeg — drop ffmpeg.exe and ffprobe.exe into
# src-tauri/resources/ffmpeg/  (https://github.com/BtbN/FFmpeg-Builds/releases)

pnpm tauri dev      # development
pnpm dist           # installer -> installer/
```

Requirements: Node.js 18+, Rust 1.77+, pnpm, and Windows 10/11 — several features call
Win32 APIs directly and have no cross-platform path.

## 📦 What's inside

| | |
|---|---|
| **Prompt** | Danbooru tag library with layer colours, search, presets, and a natural-language → prompt window |
| **Notes** | Local Markdown notes with tabs, backlinks, history and a canvas |
| **Fonts** | Licence check, one-click installs, apply-to-app, mini window, drag a font file out |
| **Audio** | Waveform browser for sound libraries: trim, convert, drag clips into your project |
| **Timer** | Cube timer driven by the spacebar, plus a pomodoro dial that keeps running across pages |
| **Translate** | Offline (Bergamot) or online engines, plus any OpenAI-compatible model |
| **Convert** | Images, audio and video via a bundled ffmpeg |
| **Launcher** | Full-screen app grid with drag-to-reorder and custom folder icons |
| **Screenshot** | Region capture, annotation, pin-to-screen, recording, OCR and translate-in-place |
| **Command palette** | One shortcut to search apps, notes, files — or translate what you type |

<div align="center">
  <img src="docs/images/screenshot-notes.png" width="820" />
</div>

<div align="center">
  <img src="docs/images/screenshot-timer.png" width="820" />
</div>

## 📁 Layout

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

## 🙏 Credits

**Frameworks** — [Tauri](https://tauri.app), [Vue.js](https://vuejs.org),
[Tailwind CSS](https://tailwindcss.com)
**UI** — [shadcn-vue](https://www.shadcn-vue.com) (on [reka-ui](https://reka-ui.com)),
[Lucide](https://lucide.dev) icons
**Capture & OCR** — [xcap](https://github.com/nashaofu/xcap),
[PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR),
[ONNX Runtime](https://onnxruntime.ai)
**Input & effects** — [rdev](https://github.com/Narsil/rdev),
[window-vibrancy](https://github.com/tauri-apps/window-vibrancy)
**Offline translation** — [Bergamot](https://browser.mt) with Mozilla's translation models
**Prompt tags** — tag names follow [Danbooru](https://danbooru.donmai.us)

The app icon is a pocket, drawn from scratch — the *idea* comes from Doraemon's
4D pocket (四次元ポケット), the bag he pulls every gadget out of. Fitting for a toolbox.

README layout follows [vitesse](https://github.com/antfu-collective/vitesse) and
[BewlyBewly](https://github.com/BewlyBewly/BewlyBewly).

## License

[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) — free to use,
modify and share, with attribution, **non-commercial**, and derivatives under the same
licence.

Copyright © 2026 [Xie Xiage](https://github.com/XXGGG)
