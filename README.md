<div align="center">

<img src="assets/brand/imparo-wordmark-black.png" alt="Imparo — the Zeraix model-systems engine" width="680" />

### Local AI inference that learns, adapts, and keeps getting better.

<p>
  <a href="https://zeraix.com">Website</a> |
  <a href="#-quick-start">Download</a> |
  <a href="#-model-systems-research">Research</a> |
  <a href="#latest-progress">Latest Progress</a> |
  <a href="https://github.com/zeraix/zeraix/releases/latest">Releases</a> |
  <a href="https://discord.gg/PcQ3jr3MfH">Discord</a> |
  <a href="https://x.com/ZeraixAI">X</a>
</p>

**Imparo is the model-systems engine developed by Zeraix for efficient on-device AI.**

Zeraix Desktop is the open-source workspace people can use today. Imparo is under active research, with a focus on real memory use, sustained generation speed, hardware adaptation, self-improving execution, and verified output correctness. We intend to open-source Imparo after its architecture and validation baseline are stable.

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue?style=flat-square)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey?style=flat-square)](#-quick-start)
[![Latest release](https://img.shields.io/github/v/release/zeraix/zeraix?style=flat-square&label=release)](https://github.com/zeraix/zeraix/releases/latest)

</div>

> 🚀 **Latest release:** [Zeraix v1.11.0](https://github.com/zeraix/zeraix/releases/tag/v1.11.0) adds scheduled AI workflows, clearer approvals, Qwen Bonsai 27B, and new local model/runtime improvements.

---

<div align="center">

<img src="assets/screenshot-main.png" alt="Zeraix local-first AI workspace" width="800" />

<br />

<img src="assets/screenshot-models.png" alt="Zeraix local model library" width="800" />

</div>

## What Zeraix is

Zeraix is built around two connected efforts:

### Zeraix Desktop

The open-source application people can use today:

- run supported local models without a Zeraix account or subscription;
- work with conversations, files, terminal tools, Skills, and sub-agents;
- schedule recurring AI workflows and review their run history;
- connect local or remote MCP services and install compatible plugins;
- install and manage GGUF models and compatible runtimes;
- use hardware-aware model and quantization recommendations;
- execute Agent commands through an optional QEMU-based sandbox;
- connect custom OpenAI-compatible endpoints or optional hosted models.

### Zeraix Model Systems

Our ongoing research into how modern models run on consumer hardware:

- model-specific inference optimization;
- memory, storage, and accelerator coordination;
- sustained decoding and tail-latency improvement;
- speculative decoding and multi-token prediction;
- architecture adaptation across MoE, dense, multimodal, long-context, and future model families;
- correctness validation across long requests and multi-turn sessions.

The public desktop release currently uses **llama.cpp** as its general-purpose compatibility runtime. Imparo is still under active research and is not yet included in the public source tree because its architecture, interfaces, and validation requirements are still changing rapidly. **We intend to open-source Imparo after the research reaches a stable and sufficiently validated stage.** Until then, we will publish progress and reproducible evidence progressively without presenting research prototypes as shipping features.

> We do not claim to train or own the underlying foundation models. Our work focuses on how supported models are prepared, configured, validated, and executed on-device.

## 🚀 Quick Start

Get Zeraix running with a local AI model in a few steps.

No Zeraix account, subscription, or API key is required for the local core.

### 1. Download Zeraix

| Platform | Requirements | Direct download |
|---|---|---|
| 🍎 macOS | macOS 13+ · Apple Silicon | [⬇️ **Download for macOS**](https://github.com/zeraix/zeraix/releases/latest/download/Zeraix-intl-1.11.0.dmg) |
| 🪟 Windows | Windows 10/11 · x64 | [⬇️ **Download for Windows**](https://github.com/zeraix/zeraix/releases/latest/download/Zeraix-intl-1.11.0.exe) |

You can also view the [latest release notes](https://github.com/zeraix/zeraix/releases/latest).

For local models:

- **16 GB or more system memory is recommended**;
- some smaller models can run with 8 GB;
- larger models and longer contexts require more memory;
- model downloads can require several gigabytes of disk space.

### 2. Install and open Zeraix

#### macOS

1. Open the downloaded `.dmg` file.
2. Drag Zeraix into the Applications folder.
3. Open Zeraix from Applications.

If macOS displays a security warning, verify that the installer was downloaded from the official `zeraix/zeraix` GitHub repository.

#### Windows

1. Open the downloaded `.exe` installer.
2. Choose an installation directory.
3. Complete the installation.
4. Launch Zeraix.

If Windows displays a SmartScreen warning, verify that the installer was downloaded from the official `zeraix/zeraix` GitHub repository before continuing.

### 3. Install a local model

1. Open **Model Library** in Zeraix.
2. Wait for Zeraix to inspect your memory and GPU.
3. Select the model marked **Recommended**.
4. Review its estimated memory and storage requirements.
5. Click **Download & Start**.

Zeraix automatically selects and downloads an appropriate `llama.cpp` runtime for your hardware.

The initial setup may include:

- a `llama.cpp` runtime;
- a GGUF model;
- optional vision or speculative-decoding model files;
- QEMU sandbox resources when the execution sandbox is enabled.

The model is ready when its status changes to **Running**.

### 4. Start your first conversation

1. Return to the Assistant.
2. Select the running local model.
3. Enter a message such as:

> Explain what you can do while keeping model inference on this device.

When a local model is selected, model inference runs on your computer.

### 5. Optional: use Developer Mode

Developer Mode allows Zeraix to work with a directory selected by you.

It can:

- read and search project files;
- create and edit files;
- show changes as diffs;
- execute terminal commands;
- inspect command output;
- use browser tools;
- delegate work to specialized sub-agents.

Before using Developer Mode:

- keep important projects under version control;
- review file diffs before applying changes;
- review commands before approving them;
- verify whether commands are running in the QEMU sandbox or directly on your computer.

Need help? [Report a bug](https://github.com/zeraix/zeraix/issues/new) or join the [Zeraix Discord](https://discord.gg/PcQ3jr3MfH).

## 🔬 Model systems research

Models keep evolving. Zeraix continuously profiles, adapts, and optimizes how they use memory, storage, compute, and decoding resources on personal devices.

Our work is not limited to a single architecture or model family.

> **Current research platform scope (August 2026):** Imparo model-systems research currently focuses on **Apple Silicon and macOS**. Zeraix Desktop is available on Windows and can use compatible general-purpose runtimes, but the Imparo optimization work described in this section has **not yet been researched or validated on Windows**. Windows model-systems research is planned and will begin as soon as the current Apple Silicon research baseline is sufficiently stable.

### Research areas

| Area | What we study and optimize |
|---|---|
| Memory systems | Real physical memory, unified memory, model working sets, KV cache, and storage-backed execution |
| Runtime execution | Model-specific scheduling, data movement, accelerator utilization, and stable long-running inference |
| Decoding | Sustained token generation, speculative decoding, MTP, and tail-latency behavior |
| Architecture adaptation | MoE, dense, multimodal, long-context, and emerging model architectures |
| Hardware adaptation | Metal, CUDA, Vulkan, CPU, and different system-memory or VRAM tiers |
| Model preparation | Quantization selection, runtime packaging, model assets, and validated device profiles |
| Correctness | Same-algorithm comparisons, deterministic checks, long requests, and multi-turn stability |

### Latest progress

_Last updated: August 2026_

#### v1.11.0: automation and local model updates

- **Scheduled workflows** — run AI workflows daily, on weekdays, hourly, or every few minutes, with configurable missed-run behavior.
- **Observable automation** — review the next run, latest result, run count, success rate, notifications, and a separate output folder for each run.
- **Readable approvals** — permission requests show the command or instruction and its values, with the raw payload available only when needed.
- **Qwen Bonsai 27B** — a 7.2 GB dense approximately 2-bit model path with multimodal support, up to 256K context, and an optional DSpark speculative-decoding drafter.
- **Hybrid GDN work** — faster Qwen3.6-35B decoding through in-place recurrent-state updates in the KV cache and improved SSM-convolution thread utilization.

#### v1.9.0-v1.10.0: MCP, plugins, and safer delegation

- connect local or remote MCP services and make their tools available inside conversations;
- install compatible plugins from the Zeraix registry;
- delegate temporary tasks to concurrent sub-agents with task-scoped capabilities;
- keep capability assignment under application control and recheck it before each protected action;
- separate user approvals from autonomous sub-agent permissions and record protected actions in the audit trail;
- answer several model questions in one structured card without losing the task context.

#### v1.8.0-v1.11.0: model and runtime progress

- **Mapped model weights** reduced repeated loading and memory-copy overhead on supported Apple Silicon paths.
- **Correctness gates** produced byte-identical reference outputs for the validated Gemma 4 E4B, Gemma 4 26B-A4B, and Qwen3.6-35B configurations reported in v1.8.0.
- **Right-sized compute buffers** allocate for the active batch instead of the maximum configured batch.
- **Short-lived vision projection** releases the vision projector after image encoding.
- **Lower-overhead speculative decoding** reads fewer language-model-head rows for the drafter path.
- **Parallel MoE staging** improves the I/O path used to prepare expert data.

#### Shipping model paths

| Model | Public configuration | Shipping optimization path |
|---|---|---|
| Qwen Bonsai 27B | Dense approximately 2-bit · 7.2 GB · multimodal · up to 256K context | Optional DSpark speculative decoding and hardware-aware local configuration |
| Qwen3.6-35B-A3B | MTP GGUF · vision · up to 256K context | Profile-guided MoE pooling, mapped weights, hybrid GDN improvements, persistent KV reuse, and published prefix seeds |
| Gemma 4 26B-A4B | QAT GGUF · vision · up to 256K context | Profile-guided MoE pooling, mapped weights, per-host memory planning, MTP speculative decoding, and persistent KV reuse |
| Gemma 4 12B | QAT GGUF · vision/audio · up to 256K context | Hardware-aware sizing, MTP speculative decoding, persistent KV reuse, and published prefix seeds |
| Gemma 4 E4B | QAT GGUF · vision/audio · up to 128K context | Low-memory profile, MTP speculative decoding, persistent KV reuse, and published prefix seeds |
| Community GGUF | Compatible external Hugging Face GGUF repositories | Repository search, architecture checks, quantization selection, memory estimation, context/KV controls, optional vision/MTP assets, and chat-template overrides |

#### Selected release measurements

| Release validation | Before | Reported result |
|---|---:|---:|
| Qwen3.6-35B load time on the reported 36 GB Mac | 40.4 s | 8.2 s |
| Additional loading footprint in that run | 18 GB | 0.5 GB |
| Qwen3.6-35B prompt processing in that run | 6.9 tok/s | 121 tok/s |
| Qwen Bonsai 27B decode across the reported 24-prompt suite | 16.2 tok/s | 20.5 tok/s (1.26x) |
| Qwen Bonsai 27B drafted-token acceptance | — | 67% |

These measurements describe the specific release-validation runs documented in [v1.8.0](https://github.com/zeraix/zeraix/releases/tag/v1.8.0) and [v1.11.0](https://github.com/zeraix/zeraix/releases/tag/v1.11.0). They are not universal performance guarantees. Results vary with the exact model, quantization, context, enabled capabilities, hardware, thermals, and workload. Earlier memory-planning, MoE-pooling, persistent-KV, and prefix-seed results remain documented in [v1.7.0](https://github.com/zeraix/zeraix/releases/tag/v1.7.0).

> The optimizations above are shipping capabilities in Zeraix Desktop's supported runtime paths. **Imparo remains a broader active research engine and is not yet included in this public source tree.**

### Research status definitions

| Status | Meaning |
|---|---|
| Exploring | Structural analysis and feasibility experiments are in progress |
| Prototype | The approach runs, but has not passed the complete validation gate |
| Validated | The current configuration has passed defined performance and correctness checks |
| Preview | A build is available to selected testers with documented limitations |
| Stable | The capability is included in a supported public release |

### What we measure

Optimization is not judged by a single peak-speed number. Depending on the research track, we evaluate:

- real physical memory rather than model-file size alone;
- prompt processing and sustained token generation separately;
- first-token latency;
- P95/P99 token latency and maximum stalls;
- long-output and multi-turn stability;
- context growth and KV-cache behavior;
- storage traffic and page-fault behavior when relevant;
- same-algorithm output consistency and deterministic hashes;
- behavior across different hardware and memory tiers.

We do not publish per-model performance claims in this README while a research track is still unstable. Once a model track has completed its research and validation gates, it will receive a dedicated model report containing the exact model, quantization, hardware, runtime version, command line, test length, measurement method, results, and known limitations. Until such a report is published, research status should not be interpreted as a reproducible public benchmark or a shipping guarantee.

## Why Zeraix?

Most AI workspaces are designed around cloud APIs, with local models added as a secondary option. Zeraix is built the other way around.

Local models are at the center of the product. Conversations, memory, files, tools, Skills, and Agent workflows are designed to run on your own computer. Cloud models remain available when you choose to use them, but they are not required for the local experience.

Zeraix also treats local inference as an active systems problem. The desktop application provides a usable product today, while our model-systems research explores how larger and more capable models can run on the hardware people already own.

### Local means local

- **Free local core** — use local models and local Agent features without an account, subscription, or usage quota.
- **Private by default** — prompts, conversations, and files used with local models stay on your device.
- **Works offline after setup** — after the required runtimes and models are downloaded, local features can run without Zeraix cloud services.
- **Bring your own model** — run supported GGUF models locally or connect an OpenAI-compatible endpoint.
- **Cloud is optional** — hosted models, accounts, and cloud file services are separate optional features.

### More than a chat client

Zeraix combines the tools needed for local AI work in one desktop application:

- local model installation and management;
- hardware-aware model recommendations;
- Assistant and Developer modes;
- file reading and editing with diff previews;
- integrated terminal and command execution;
- QEMU-based execution sandbox;
- browser tools and automation;
- scheduled workflows with run history and notifications;
- persistent conversations and local memory;
- Skills and specialized sub-agents;
- local or remote MCP services and compatible plugins;
- optional cloud models and custom API endpoints.

## ✨ Features

### 📦 Local model management

Zeraix manages the local inference workflow from installation to execution:

- browse and download supported GGUF models;
- install and manage a local `llama.cpp` runtime;
- detect system memory, GPU capabilities, and available acceleration;
- recommend models and quantizations based on your hardware;
- support Metal, CUDA, Vulkan, and CPU-oriented runtimes where available;
- choose a separate model storage directory;
- start, stop, update, and inspect the local inference service;
- expose the running model through an OpenAI-compatible local endpoint.

Zeraix distinguishes between three model paths:

- **Community GGUF models** — compatible models and quantizations from the broader open-model ecosystem.
- **Zeraix-tested profiles** — model, quantization, context, and runtime configurations tested by the Zeraix team for specific hardware tiers. These profiles do not imply that Zeraix trained or owns the underlying model.
- **Imparo research builds** — model-specific inference builds under active internal research. They are not part of the public release unless a future release explicitly states otherwise.

Model availability, licensing, performance, and hardware requirements vary. Review the license of each model before using or redistributing it.

### 💬 Assistant Mode

Assistant Mode is designed for everyday local AI work:

- continue conversations across supported models;
- analyze text documents and images with compatible models;
- keep local conversations and memory on your device;
- add reusable Skills for specialized tasks;
- connect compatible MCP servers;
- switch between local models, custom endpoints, and optional hosted models.

### 🛠️ Developer Mode

Developer Mode gives the selected model controlled access to a workspace:

- read and search project files;
- create and edit files;
- preview changes as diffs;
- execute terminal commands;
- inspect command output and iterate;
- use browser tools for documentation and application testing;
- delegate exploration, planning, and review to specialized sub-agents;
- compact long contexts while preserving the original conversation history.

File and command tools are scoped to the working directory selected by the user. Sensitive operations may require explicit approval.

### Scheduled automation

Zeraix can turn repeatable AI work into scheduled workflows:

- schedule daily, weekday, hourly, or frequent interval runs;
- choose whether a missed run is skipped, run once, or backfilled;
- review the next run, last outcome, run count, and success rate;
- receive run notifications and keep each run in a separate output folder;
- inspect and approve sensitive commands through readable permission requests.

### 🛡️ Local execution sandbox

Zeraix includes an optional QEMU-based Linux environment for Agent commands:

- hardware-accelerated virtualization where supported;
- one persistent virtual machine per session instead of one boot per command;
- workspace sharing between the host and guest;
- per-command filesystem scoping using `bubblewrap`;
- captured command output and execution timeouts;
- port forwarding for local development servers;
- execution paths for macOS, Windows, and Linux environments.

If sandbox resources or hardware virtualization are unavailable, some operations may use native host execution depending on the selected mode and current implementation.

Always verify the execution indicator before approving commands that affect important files.

### 🧠 Memory and context

- store conversations locally by project;
- keep separate Assistant and Developer workspaces;
- switch models without discarding conversation history;
- save reusable memory as local Markdown files;
- compact long model contexts without rewriting the original conversation;
- encrypt supported local conversation data when application encryption is available.

### 🧩 Skills and sub-agents

- built-in Skills for coding, research, review, writing, and data extraction;
- project-level Skill discovery;
- user control over project instructions;
- temporary specialized sub-agents for focused tasks;
- concurrent delegation without giving sub-agents unrestricted application access;
- task-scoped capabilities assigned and rechecked by the application;
- separate user-approval and autonomous-agent permission boundaries;
- an audit trail for protected actions.

### MCP services and plugins

- connect local or remote Model Context Protocol services;
- make approved MCP tools available inside AI conversations;
- install compatible plugins from the Zeraix registry;
- manage plugin capabilities and integrity checks through the desktop application.

### ☁️ Cloud when you choose it

Cloud capabilities are optional and separate from the local core:

- official hosted model access;
- OpenAI-compatible custom endpoints;
- account-based services;
- optional cloud file and platform features.

When you select a hosted model or custom endpoint, prompts and supported attachments are sent to the provider associated with that model. Third-party providers may charge separately and apply their own privacy and retention policies.

### 🌍 Multilingual interface

The interface includes translations for:

- English;
- 简体中文;
- 繁體中文;
- 日本語;
- 한국어;
- Français;
- Español;
- Italiano;
- Deutsch;
- Português;
- and additional variants represented in the repository.

## Public, upstream, and research boundaries

| Capability | Available | Account required | Offline after setup | Implementation status |
|---|:---:|:---:|:---:|---|
| Zeraix Desktop local core | ✅ | No | ✅ | Open source in this repository |
| Local conversations and memory | ✅ | No | ✅ | Open source in this repository |
| File and terminal Agent tools | ✅ | No | ✅ | Open source in this repository |
| QEMU execution sandbox | ✅ | No | ✅ | Open source in this repository |
| Skills and sub-agents | ✅ | No | ✅ | Open source in this repository |
| Scheduled workflows | ✅ | No | ✅ | Open source in this repository |
| Local and remote MCP connections | ✅ | No | Depends on service | Open source in this repository |
| Compatible plugins | ✅ | No | Depends on plugin | Open source in this repository; registry content may use separate licenses |
| Custom OpenAI-compatible endpoints | ✅ | No | Depends on endpoint | Open source in this repository |
| General local inference | ✅ | No | ✅ | Uses separately licensed upstream runtimes such as llama.cpp |
| Zeraix-tested model profiles | ✅ | No | ✅ | Configuration and validation layer in this repository |
| Imparo research engine | Research | No | Intended | Currently focused on Apple Silicon/macOS; planned for open source after stabilization and validation |
| Zeraix hosted models | Optional | Yes | No | Proprietary service; client integration only |
| Zeraix account and cloud files | Optional | Yes | No | Proprietary service; client integration only |

Zeraix does not charge for connecting a custom endpoint. The endpoint provider may charge for its service.

## 🔒 Privacy and network behavior

### Local model usage

When a local model is selected:

- inference runs on your computer;
- prompts do not need to be sent to a Zeraix model service;
- local conversations and workspace operations remain on your device.

### Initial downloads

Some local features require network access during setup:

- `llama.cpp` runtime packages;
- GGUF model files;
- QEMU binaries;
- the Linux sandbox image, kernel, and initial RAM filesystem.

After the required resources are installed, the local core is designed to operate without Zeraix cloud services.

### Cloud and custom endpoints

When a hosted model or custom endpoint is selected, prompts and supported attachments are sent to that provider.

Review the provider’s terms, pricing, privacy policy, and retention policy before sending sensitive information.

### Agent permissions

AI-generated commands and file modifications can be incorrect or unsafe.

Zeraix keeps protected capabilities under application control. A model or sub-agent can request a capability, but cannot grant it to itself. Protected actions are rechecked at execution time, and user approval for a direct request does not automatically authorize an autonomous sub-agent.

Always:

- review permission requests;
- inspect proposed diffs;
- verify file paths;
- review commands before approving them;
- keep backups or version control enabled.

For vulnerability reporting, see [Security.md](Security.md). For additional privacy information, see [Privacy.md](Privacy.md).

## 🧑‍💻 Developer Quick Start

### Requirements

- Node.js 20.9 or newer;
- Corepack;
- Git;
- macOS, Windows, or Linux for local development.

### Run the full desktop application

```bash
git clone https://github.com/zeraix/zeraix.git
cd zeraix
corepack enable
pnpm install --frozen-lockfile
pnpm electron:dev
```

This starts:

- the Next.js renderer at `http://localhost:3000`;
- the Electron desktop process;
- Electron IPC integrations;
- local model, file, terminal, browser, and sandbox features.

Use the Electron window for the complete Zeraix experience.

Cloud credentials are not required to run the local core. Some optional authentication and hosted services require additional configuration.

### Run only the web renderer

```bash
pnpm dev
```

The web renderer is useful for interface development, but it does not provide the complete desktop runtime.

The following features require Electron:

- local model management;
- Electron IPC;
- local file access;
- terminal execution;
- native notifications;
- browser automation;
- QEMU sandbox integration.

### Optional environment configuration

Copy the example environment file only when you need to override the defaults:

```bash
cp .env.example .env.local
```

Never commit real API keys, OAuth credentials, access tokens, private keys, or `.env` files.

### Validate your changes

```bash
pnpm typecheck
pnpm lint
pnpm build
```

### Build desktop packages

```bash
# macOS
pnpm dist:mac

# Windows
pnpm dist:win
```

Desktop packaging downloads platform resources and may require platform-specific signing and notarization credentials. Unsigned local builds can trigger operating-system security warnings.

For additional implementation details, see:

- [`sandbox/qemu/README.md`](sandbox/qemu/README.md)
- [`resources/bin/README.md`](resources/bin/README.md)
- [`resources/README.md`](resources/README.md)

## Architecture

```text
Zeraix
├── Zeraix Desktop
│   ├── Next.js / React renderer
│   │   ├── Assistant and Developer interfaces
│   │   ├── Conversation state and context compaction
│   │   ├── Skills, plugins, and sub-agents
│   │   ├── Automation dashboard and run history
│   │   └── Permission and diff views
│   ├── Electron main process
│   │   ├── Secure preload and IPC bridges
│   │   ├── Local conversation storage
│   │   ├── LLM request proxy
│   │   ├── Local model and runtime management
│   │   ├── Workflow scheduler and notifications
│   │   ├── MCP and plugin management
│   │   ├── Capability broker and audit log
│   │   ├── File and terminal tools
│   │   └── Browser automation
│   ├── Execution layer
│   │   ├── QEMU Linux sandbox
│   │   └── Native execution path
│   └── Model layer
│       ├── Community GGUF models
│       ├── Zeraix-tested profiles
│       ├── Custom OpenAI-compatible endpoints
│       └── Optional Zeraix cloud services
└── Zeraix Model Systems
    ├── Architecture and workload profiling
    ├── Memory and runtime research
    ├── Decoding and hardware adaptation
    ├── Correctness and regression validation
    └── Imparo research engine
```

Important source directories:

| Path | Purpose |
|---|---|
| `src/app/agent/` | Assistant and Developer application pages |
| `src/app/agent/chat/` | Agent conversation UI and runtime loop |
| `src/lib/ai/` | Models, memory, Skills, sub-agents, orchestration, permissions, and AI utilities |
| `src/components/ai/` | Model library and AI interface components |
| `electron/` | Electron main process and renderer bridges |
| `electron/automation/` | Scheduled workflow parsing, persistence, and execution |
| `electron/mcp/` | Local and remote MCP connection management |
| `electron/plugins/` | Plugin installation, validation, and lifecycle management |
| `electron/llm/` | Local model runtime management and request proxy |
| `electron/tools/` | Agent tools, terminal integration, and sandbox routing |
| `electron/tools/sandbox/` | QEMU control, filesystem sharing, and execution engine |
| `sandbox/qemu/` | Sandbox image build files and documentation |
| `scripts/` | Build, packaging, and resource publication scripts |

The Imparo research engine is not currently part of the public source directories listed above. We intend to open-source it after the architecture and validation baseline are stable enough for external use and contribution.

## Known limitations

- macOS release builds currently target Apple Silicon.
- Windows release builds currently target x64.
- Imparo model-systems research currently focuses on Apple Silicon/macOS and has not yet been validated on Windows. Windows users should not assume that current research claims apply to their hardware.
- Local model quality and tool-calling reliability depend on the selected model.
- Performance depends on memory, GPU support, model size, quantization, context length, and runtime configuration.
- Initial model and sandbox downloads can be large.
- The QEMU sandbox requires hardware virtualization and additional resources.
- Some Agent operations may use native execution when the sandbox is unavailable or disabled.
- Hosted services require network access and may require an account or separate payment.
- Imparo research results are not shipping features unless a release explicitly states otherwise.

## Troubleshooting

### No local models are recommended

Zeraix currently requires approximately 8 GB of usable memory for the smallest supported local model.

Close memory-intensive applications and run hardware detection again.

### A model download is slow

GGUF model files can be several gigabytes. Download speed depends on your network connection and the model host.

Keep Zeraix open until the download finishes.

### A model does not start

Try the following:

1. stop the model;
2. restart Zeraix;
3. open Model Library;
4. recheck the local runtime;
5. reduce context length;
6. disable vision;
7. select a smaller model;
8. inspect the runtime log from Model Library.

On Windows, Zeraix may fall back from CUDA to Vulkan and then to CPU when a GPU runtime cannot start.

### Developer Mode cannot execute a command

Check the current execution mode.

If the QEMU sandbox is unavailable, verify that:

- hardware virtualization is enabled;
- sandbox resources have finished downloading;
- sufficient disk space is available;
- security software is not blocking QEMU.

Some modes may offer native execution as a fallback. Review the execution indicator before approving a command.

### The web page does not have desktop features

`pnpm dev` starts only the web renderer. Use:

```bash
pnpm electron:dev
```

to run the full desktop application.

## Roadmap

### Zeraix Desktop

- [x] Local and cloud model workspace
- [x] Assistant Mode with tool calling
- [x] Developer Mode with files and terminal
- [x] Hardware-aware model recommendations
- [x] GGUF model downloads and `llama.cpp` management
- [x] Persistent local conversations and memory
- [x] Cross-model conversation continuity
- [x] Skills and specialized sub-agents
- [x] QEMU-based execution sandbox
- [x] Multimodal attachments for supported models
- [x] Scheduled workflows with run history and notifications
- [x] Local and remote MCP service connections
- [x] Plugin installation and registry integration
- [x] Task-scoped sub-agent capabilities, readable approvals, and execution audit trails
- [x] Expand automated test coverage for orchestration, automation, plugins, permissions, and scheduling
- [ ] Add dedicated pull-request CI for tests, type checking, and linting
- [ ] Continue hardening sandbox isolation and execution-policy coverage
- [ ] Add intelligent local and cloud model routing

### Zeraix Model Systems

- [x] Establish repeatable low-memory model research baselines
- [x] Add correctness gates for model-specific optimization experiments
- [x] Validate deterministic correctness for the initial shipping Qwen3.6 and Gemma 4 paths
- [x] Extend shipping optimization work across MoE, dense, multimodal, and hybrid GDN paths
- [x] Publish recurring release-level model-systems updates
- [ ] Publish reproducible benchmark methodology and hardware reports
- [ ] Expand validation across Apple Silicon memory tiers
- [ ] Begin Windows model-systems profiling and establish the first Windows research baseline
- [ ] Generalize model-specific research code into reusable architecture adapters
- [ ] Prepare the first Imparo research preview
- [ ] Extend research to additional architectures and hardware backends

Roadmap items are directional and may change as model architectures, upstream runtimes, hardware, and validation results evolve.

## Contributing

Bug reports, documentation improvements, feature proposals, translations, model compatibility reports, hardware results, and focused code contributions are welcome.

Good ways to contribute include:

- testing models on different hardware;
- reporting model compatibility and performance behavior;
- improving translations and documentation;
- reproducing reported bugs;
- improving error messages;
- adding tests;
- submitting focused bug fixes.

Before submitting a pull request:

1. Read [Contributing.md](Contributing.md).
2. Keep each pull request focused on one concern.
3. Run the available validation commands.
4. Do not include secrets, proprietary code, model files, or incompatible third-party material.

Opening Issues, reporting bugs, suggesting features, sharing hardware results, and participating in Discussions are all welcome.

Look for issues labeled:

- `good first issue`;
- `help wanted`;
- `documentation`;
- `translation`.

## Security

Do not report security vulnerabilities through public Issues, Discussions, or pull requests.

Follow the private reporting process described in [Security.md](Security.md).

## Open source and optional services

This repository contains Zeraix Desktop and its local-first application runtime.

The public local core is available under the permissive Apache License 2.0. Separately licensed third-party runtimes, models, and downloaded assets remain governed by their respective licenses.

Imparo is an active research engine and is not currently included in this public source tree. We intend to open-source it after the architecture, interfaces, and validation baseline are stable enough for external use and contribution. The exact release scope, timing, and license will be stated clearly before publication; no specific release date is promised while the research remains unstable.

Zeraix also operates optional proprietary services, which may include:

- accounts;
- hosted models;
- cloud files;
- routing;
- commercial platform capabilities.

These services are not required to use the public local core and are not part of this repository.

## License

Zeraix Desktop is licensed under the [Apache License 2.0](LICENSE).

You may use, study, modify, distribute, and use the software commercially under the terms of that license.

Apache-2.0 does not require derivative works or larger works to be released as open source. Distributions must preserve the applicable license and copyright notices, and modified files must carry notices stating that they were changed.

Third-party models, runtimes, libraries, and downloaded components remain governed by their respective licenses.

## Community

- [Discord](https://discord.gg/PcQ3jr3MfH)
- [X / Twitter](https://x.com/ZeraixAI)
- [Bug reports](https://github.com/zeraix/zeraix/issues/new)
- [Feature requests](https://github.com/zeraix/zeraix/issues/new)
- Commercial and partnership inquiries: **emma@zeraix.com**

---


<div align="center">

**Built for local. If that's your thing too, a ⭐ means a lot.**

</div>
</table>
