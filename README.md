<div align="center">

<img src="assets/logo.png" alt="Zeraix Logo" width="120" height="120" />

# Zeraix

**Born for local models.**
The AI workspace built around on-device LLMs — not one that treats them as an afterthought.



[![Discord](https://img.shields.io/badge/Discord-Join%20us-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/PcQ3jr3MfH)
[![Twitter](https://img.shields.io/badge/X-@YOUR_HANDLE-000000?style=flat-square&logo=x&logoColor=white)](https://x.com/ZeraixAI)

[![Release](https://img.shields.io/github/v/release/zeraix/Zeraix?style=flat-square&color=2ea44f)](https://github.com/zeraix/Zeraix/releases)
[![Downloads](https://img.shields.io/github/downloads/zeraix/Zeraix/total?style=flat-square&color=blue)](https://github.com/zeraix/Zeraix/releases)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-orange?style=flat-square)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey?style=flat-square)](#-download)

</div>

---

## Why Zeraix?

There are plenty of AI clients. Most of them are built for cloud APIs, with local models bolted on as a checkbox feature.

**Zeraix is built the other way around.** Local models are the center of the product, and every feature exists to make running AI on *your own machine* genuinely great — private, fast, and yours. Cloud flagships are there when you want them, but they're the guest, not the host.

What that means in practice:

- 🧠 **Switch models, keep everything** — your memory and context persist when you change models. Jump from one local model to another, or from local to cloud, and the conversation just continues. No other client treats model switching as a first-class experience like this.
- 📦 **One-click local setup** — Zeraix reads your hardware and installs a model that actually runs well on it. No terminal, no guesswork, no downloading a 70B model your laptop can't load.
- 🔧 **Vertical local optimization** — we optimize for local inference continuously, model by model. This is our lane and we're staying in it.
- 🔒 **Local by default** — conversations with local models never leave your device.

<div align="center">

<img src="assets/screenshot-main.png" alt="Zeraix" width="800" />

<img src="assets/screenshot-models.png" alt="Zeraix Model Library" width="800" />

</div>

## ✨ Features

### 📦 Local Models, Two Tracks

- **Community track** — connected to Hugging Face with **GGUF** support: browse, one-click download, run
- **Official track** *(rolling out, one model at a time)* — models deeply optimized by the Zeraix team to use **less memory and deliver better results** on consumer hardware. This is where our vertical focus shows: we tune each model individually rather than shipping generic builds
- **Hardware-aware recommendations** — Zeraix detects your RAM, chip, and GPU, and only suggests models your machine can handle

### 💬 Assistant Mode

Your everyday AI companion — chat, write, summarize, with built-in tool calling.

- Upload documents and images for AI analysis (multimodal)
- Extend capabilities via **MCP (Model Context Protocol)** servers
- Cross-model memory: switch models mid-conversation without losing context
- …and more

### 🛠️ Developer Mode

A coding agent that works right on your machine:

- Read & edit local files in your projects
- Run terminal commands and iterate on results
- Search & browse the web for docs and answers
- Powered by the model of your choice — local or cloud
- …and more

### ☁️ Cloud When You Want It

- Built-in flagship support: **Claude, GPT (OpenAI), Gemini, DeepSeek, Qwen, GLM** and more
- **Bring your own endpoint** — any OpenAI-compatible API
- Local and cloud share one workspace, one memory, one flow

### 🌍 Multilingual Interface

Available in **English, 简体中文, 繁體中文, 日本語, 한국어, Français, Español, Italiano** and more.

## 🔒 Privacy

- Conversations with **local models stay entirely on your device** — nothing is uploaded
- Cloud requests go **only to the provider you explicitly choose**, only when you use a cloud model
- Cloud access is fully optional and can be disabled — Zeraix works offline with local models

## 📥 Download

| Platform | Requirements | Download |
|----------|-------------|----------|
| 🍎 macOS | macOS 13+ · Apple Silicon (M1 or later) | [Latest Release](https://github.com/zeraix/Zeraix/releases/latest) |
| 🪟 Windows | Windows 10/11 · x64 | [Latest Release](https://github.com/zeraix/Zeraix/releases/latest) |

> 💡 **Local models**: 16 GB+ RAM recommended. More memory unlocks larger models — Zeraix recommends the right ones for your hardware automatically.

## 🗺️ Roadmap

- [x] Assistant mode with tool calling & MCP
- [x] Developer mode (files, terminal, web)
- [x] One-click local model setup with hardware-aware recommendations
- [x] Cross-model memory & context persistence
- [x] Multimodal input (documents & images)
- [x] Cloud flagships & custom API endpoints
- [ ] **Official optimized model line** — Zeraix-tuned models, released one by one
- [ ] **Intelligent routing** — automatically pick the best model (local or cloud) for every task
- [ ] Deeper local inference optimizations, continuously

> **Our long-term vision:** local models should handle the vast majority of your tasks — and for the few they can't, Zeraix hands off to the cloud seamlessly. As local models keep getting better and our optimizations go deeper, that "majority" only grows. Follow the repo to watch it happen. ⭐

## 🌍 Community

- 💬 [Join our Discord](https://discord.gg/PcQ3jr3MfH)
- 🐦 [Follow us on X](https://x.com/ZeraixAI)
- 🐛 [Report a bug](https://github.com/zeraix/Zeraix/issues/new)
- 💡 [Request a feature](https://github.com/zeraix/Zeraix/issues/new)

## License

This project is licensed under the [GNU Affero General Public License v3.0](./LICENSE).

Zeraix is free to use, including commercially, under the terms of AGPL-3.0. If the AGPL's obligations (such as releasing source code of your modifications when offering the software over a network) don't fit your use case, a commercial license is available — contact us at emma@zeraix.com.

---

<div align="center">

**Built for local. If that's your thing too, a ⭐ means a lot.**

</div>
