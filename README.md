<div align="center">

<img src="assets/logo.png" alt="Zeraix Logo" width="120" height="120" />

# Zeraix

### Local AI, engineered from workspace to runtime.

Zeraix is an open-source AI desktop for working with models, files, tools, and agents—with local inference at its core.

Run supported models on your own hardware, work with your files, and carry out multi-step tasks in one workspace. Connect cloud models and services when you need them.

Our model-systems research continues in **[Imparo](https://github.com/zeraix/imparo)**, our open-source LLM inference engine that adapts to hardware and workload.

[Download](#quick-start)
· [Why Zeraix](#why-zeraix)
· [News](#news)
· [Imparo Engine](https://github.com/zeraix/imparo)
· [Developer Guide](#development)

[![Discord](https://img.shields.io/badge/Discord-Join%20us-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/PcQ3jr3MfH)
[![X](https://img.shields.io/badge/X-@ZeraixAI-000000?style=flat-square&logo=x&logoColor=white)](https://x.com/ZeraixAI)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue?style=flat-square)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey?style=flat-square)](#quick-start)

</div>

---

<div align="center">

<img src="assets/screenshot-main.png" alt="Zeraix local-first AI workspace" width="800" />

<br />

<img src="assets/screenshot-models.png" alt="Zeraix local model library" width="800" />

</div>

## Why Zeraix

- **Local models at the center.** Download and run supported GGUF models with hardware-aware recommendations and runtime management. The local core requires no Zeraix account, subscription, or API key.
- **Work with files and tools.** Read, search, and edit project files, inspect diffs, run terminal commands, and use browser tools from the same conversation.
- **Agents you can follow and control.** Use Skills and specialized sub-agents for multi-step work, with task-scoped permissions and readable approvals. In 2.0 Beta, inspect each sub-agent's execution and stop it individually.
- **Built for ongoing work.** Keep local conversations and memory, track task goals, and schedule recurring workflows with run history and notifications.
- **Create and organize.** In 2.0 Beta, collect uploaded and generated assets in a media library, preview images, video, audio, PDFs, and text, and connect compatible image or video generation services.
- **Extend your workspace.** Connect local or remote MCP servers, install compatible plugins, or bring your own model endpoint. An optional QEMU sandbox provides an isolated environment for supported commands.

Local inference and local tools can work offline after setup. Web search, remote MCP servers, generation services, and cloud models need their respective network connections.

## News

- **[2026-09-08 · main]** Added built-in Skills, runtime crash-recovery work, a plugin catalogue with detail views, reorganized settings, and tool-approval modes. These changes are in the [`v2.0.0-beta.2` source tag](https://github.com/zeraix/zeraix/tree/v2.0.0-beta.2); see Releases for available installers.
- **[2026-09-04 · v2.0.0-beta.1]** Added individual sub-agent cancellation and improved large-file handling, conversation storage, context budgeting, and sandbox startup feedback. [Release notes](https://github.com/zeraix/zeraix/releases/tag/v2.0.0-beta.1)
- **[2026-09-03 · v2.0.0-beta.0]** Moved core tool execution into the Rust Agent Runtime, added the sub-agent Execution Inspector, and introduced unified media previews. [Release notes](https://github.com/zeraix/zeraix/releases/tag/v2.0.0-beta.0)
- **[2026-09-01 · v2.0.0-beta]** Introduced the media library, configurable image/video generation services, and the initial Rust runtime infrastructure. [Release notes](https://github.com/zeraix/zeraix/releases/tag/v2.0.0-beta)
- **[2026-08-24 · v1.12.0]** Added goal tracking and plugin OAuth improvements, unified the chat experience, and improved local runtime delivery and sub-agent cache isolation. [Release notes](https://github.com/zeraix/zeraix/releases/tag/v1.12.0)

Earlier model optimization results are collected in [Model Systems Notes](MODEL_SYSTEMS.md). For the full history, see [Releases](https://github.com/zeraix/zeraix/releases).

## Quick Start

### 1. Download and install

| Channel | Version | Downloads |
|---|---|---|
| Stable | v1.12.0 | [macOS](https://github.com/zeraix/zeraix/releases/download/v1.12.0/Zeraix-intl-1.12.0.dmg) · [Windows](https://github.com/zeraix/zeraix/releases/download/v1.12.0/Zeraix-intl-1.12.0.exe) |
| Beta | v2.0.0-beta.1 | [macOS](https://github.com/zeraix/zeraix/releases/download/v2.0.0-beta.1/Zeraix-intl-2.0.0-beta.1.dmg) · [Windows](https://github.com/zeraix/zeraix/releases/download/v2.0.0-beta.1/Zeraix-intl-2.0.0-beta.1.exe) |

Check [all releases](https://github.com/zeraix/zeraix/releases) for newer installers. Features marked **2.0 Beta** are not included in v1.12.0; the `main` branch may contain changes newer than the available installers.

- **macOS:** macOS 13+ on Apple Silicon. Open the `.dmg` and drag Zeraix into Applications.
- **Windows:** Windows 10/11 x64. Run the `.exe` installer.
- **Memory:** 16 GB or more is recommended. Some smaller models support 8 GB systems; larger models and longer contexts require more memory.

If your operating system shows a security warning, verify that the installer came from this official repository before continuing.

### 2. Start a local model

1. Open **Model Library** and let Zeraix detect your hardware.
2. Choose a recommended model and review its memory and disk requirements.
3. Download the model and required runtime, then start it.
4. Select the running model in chat and send your first message.

Initial setup downloads model and runtime assets. Sandbox resources are downloaded when needed. Model capabilities and context limits depend on the selected model, configuration, and hardware.

### 3. Give it a task

Choose a working directory when you want Zeraix to work with your files. For example:

> Read this project, explain how it works, and suggest a focused improvement.

You can also add Skills, connect MCP tools, or set up a recurring workflow. Review permissions and file changes, and check whether commands will run on the host or in the sandbox.

## Local Models

Zeraix combines a curated model catalogue with compatible community GGUF imports and custom OpenAI-compatible endpoints.

| Curated model | Supported profile |
|---|---|
| Qwen3.6-35B-A3B | MoE, vision, and MTP |
| Qwen Bonsai 27B | Compact dense model, vision, and optional DSpark speculative decoding |
| Gemma 4 26B-A4B | MoE, vision, and MTP |
| Gemma 4 12B | Vision/audio and MTP |
| Gemma 4 E4B | Smaller-memory profile, vision/audio, and MTP |
| LFM2.5-2.6B | Lightweight text model with tool calling |

Availability depends on the runtime and platform. The usable context length depends on your available memory and configuration.

For community GGUF models, Zeraix provides repository search, quantization selection, memory estimates, context/KV settings, and compatible auxiliary assets. Architecture and tool-calling support depend on the selected runtime.

The desktop currently uses **llama.cpp-based runtimes** for general local inference. Zeraix's tuned Apple Silicon paths include model-specific memory planning, mapped weights, MoE pooling, speculative decoding, and persistent KV reuse where supported. See [Model Systems Notes](MODEL_SYSTEMS.md) for historical configurations and reported results.

These optimization results are specific to their tested Apple Silicon configurations. Windows users should use the capabilities documented for their runtime; Apple Silicon results do not establish Windows performance.

## Imparo

**[Imparo](https://github.com/zeraix/imparo)** is our open-source LLM inference engine, designed to adapt execution to hardware and workload.

Its work brings together native model execution, measurement-driven hardware tuning, and persistent inference state for long conversations and repeated tool use. The engine has its own source code, development updates, and performance reports.

Zeraix is the desktop workspace; Imparo is the inference-engine project. The desktop's Rust **Agent Runtime** handles agent execution and tools and is a separate component. Imparo is not yet the bundled default inference engine in Zeraix.

[Explore Imparo →](https://github.com/zeraix/imparo)

## Development

Use **Node.js 22**, Corepack/pnpm, Git, and the stable **Rust toolchain with Cargo** (Rust 1.85 or newer). Native dependencies may also require your platform's compiler and build tools.

```bash
git clone https://github.com/zeraix/zeraix.git
cd zeraix
corepack enable
pnpm install --frozen-lockfile
pnpm electron:dev
```

The desktop development command builds the Rust runtime when missing or stale, then starts Next.js and Electron. The first build can take several minutes.

For interface-only development, use `pnpm dev`. Local files, model management, terminal tools, and other native capabilities require the Electron application.

Validate changes with:

```bash
pnpm build:runtime
cargo test --locked --manifest-path runtime/Cargo.toml
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

CI runs JavaScript and Rust tests, type checks, and macOS/Windows runtime smoke checks. Lint currently runs as an advisory check.

Build desktop installers with `pnpm dist:mac` or `pnpm dist:win` on the corresponding platform. Packaging downloads additional resources; signing and notarization require the appropriate credentials.

Cloud credentials are optional for local-core development. See [`.env.example`](.env.example) for configuration, and never commit real credentials.

### Source map

| Directory | Purpose |
|---|---|
| `src/app/agent/` | Chat, media library, settings, and other application pages |
| `src/lib/agent/`, `src/lib/ai/` | Agent control flow, models, memory, Skills, and generation services |
| `runtime/` | Rust Agent Runtime: core tools, processes, permissions, scheduling, and related infrastructure |
| `electron/` | Desktop lifecycle, IPC, storage, local model management, and integrations |
| `electron/automation/` | Recurring workflows and execution |
| `electron/mcp/`, `electron/plugins/` | MCP and plugin integrations |
| `sandbox/qemu/` | Sandbox image and environment |
| `test/`, `.github/workflows/` | Tests and CI/release workflows |

More setup information: [sandbox](sandbox/qemu/README.md) · [runtime assets](resources/bin/README.md) · [resources](resources/README.md).

## Privacy and Permissions

Local-model inference runs on your device, and local conversations are stored locally. When you choose a cloud model, remote tool, web service, or generation provider, the data needed for that action is sent to that service. Selecting a local model does not make external tools offline.

The local core requires no Zeraix account or subscription. Optional hosted models and account/cloud services are separate; providers may charge for their services.

Protected actions use application-controlled permissions and approvals. Check the execution destination: host commands run on your computer, while sandboxed commands run in the optional QEMU environment. Keep important files under version control.

Read [Privacy.md](Privacy.md) and [Security.md](Security.md) for details.

## Contributing

We welcome bug fixes, documentation, translations, Skills and plugin improvements, model compatibility reports, and hardware testing.

When reporting a problem, include your Zeraix version, operating system, hardware, model and quantization, and steps to reproduce it. For code changes, read [Contributing.md](Contributing.md), keep the change focused, and run the relevant checks.

Inference-engine contributions are welcome in [Imparo](https://github.com/zeraix/imparo). Report security vulnerabilities through the private process in [Security.md](Security.md).

## License and Community

Zeraix is licensed under [Apache 2.0](LICENSE). Third-party models, runtimes, plugins, and downloaded assets retain their own licenses. Optional hosted services are separate from the open-source local core.

[Discord](https://discord.gg/PcQ3jr3MfH) · [X / Twitter](https://x.com/ZeraixAI) · [Issues and feature requests](https://github.com/zeraix/zeraix/issues)

Commercial and partnership inquiries: **emma@zeraix.com**

---

<div align="center">

**Built for local. If that's your thing too, a ⭐ means a lot.**

</div>
