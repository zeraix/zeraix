<div align="center">

<img src="assets/logo.png" alt="Zeraix Logo" width="120" height="120" />

# Zeraix

### AI workspace, built local-first.

Run local models, work with files, use terminal tools, and execute AI agents on your own computer — without an account or subscription.

**The local core is free and open source. Cloud services are entirely optional.**

[Download](https://github.com/zeraix/Zeraix/releases/latest)
· [Getting Started](#-getting-started)
· [Report a Bug](https://github.com/zeraix/Zeraix/issues/new)

[![Discord](https://img.shields.io/badge/Discord-Join%20us-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/PcQ3jr3MfH)
[![X](https://img.shields.io/badge/X-@ZeraixAI-000000?style=flat-square&logo=x&logoColor=white)](https://x.com/ZeraixAI)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-orange?style=flat-square)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey?style=flat-square)](#-download)

</div>

---

<div align="center">

<img src="assets/screenshot-main.png" alt="Zeraix local-first AI workspace" width="800" />

<br />

<img src="assets/screenshot-models.png" alt="Zeraix local model library" width="800" />

</div>

## Why Zeraix?

Most AI workspaces are designed around cloud APIs, with local models added as a secondary option.

Zeraix is built the other way around.

Local models are at the center of the product. Conversations, memory, files, tools, skills, and agent workflows are designed to run on your own computer. Cloud models remain available when you choose to use them, but they are never required for the local experience.

### Local means local

- **Free local core** — use local models and local Agent features without an account, subscription, or usage quota.
- **Private by default** — prompts, conversations, and files used with local models stay on your device.
- **Works offline after setup** — model runtimes, model files, and sandbox resources are downloaded during setup; local features can then run without Zeraix cloud services.
- **Bring your own model** — run supported GGUF models locally or connect an OpenAI-compatible endpoint.
- **Cloud is optional** — official cloud models, accounts, and cloud file services are separate, optional features.

### More than a chat client

Zeraix combines the tools needed for local AI work in one desktop application:

- Local model installation and hardware-aware recommendations
- Assistant and developer modes
- File reading and editing with diff previews
- Integrated terminal and command execution
- QEMU-based execution sandbox
- Browser tools and automation
- Persistent local conversations and memory
- Skills and specialized sub-agents
- Optional cloud models and custom API endpoints

## ✨ Features

### 📦 Local model management

Zeraix manages the local inference workflow from installation to execution:

- Browse and download supported **GGUF** models
- Install and manage the local **llama.cpp** runtime
- Detect system memory, GPU capabilities, and available acceleration
- Recommend model sizes and quantizations based on your hardware
- Support Metal, CUDA, and CPU-oriented runtime variants where available
- Configure model storage separately from the application
- Start, stop, update, and inspect the local inference service

Zeraix offers two model tracks:

- **Community models** — use supported GGUF models from the open model ecosystem.
- **Zeraix optimized models** — an evolving line of model configurations and builds optimized for practical use on consumer hardware.

> Model availability, licenses, performance, and hardware requirements vary by model. Always review the license of a model before using or redistributing it.

### 💬 Assistant mode

Use Zeraix as an everyday local AI assistant:

- Continue conversations across local and cloud models
- Analyze text documents and images with supported models
- Keep conversations and memory on your device
- Add reusable skills for specialized tasks
- Connect compatible MCP servers
- Choose between local models, custom endpoints, and optional cloud models

### 🛠️ Developer mode

Developer mode gives the model controlled access to a selected workspace:

- Read and search project files
- Create and edit files
- Preview changes as diffs before applying sensitive operations
- Run terminal commands
- Inspect command output and iterate
- Use browser tools for documentation and local application testing
- Delegate exploration, planning, and review to specialized sub-agents
- Compress long contexts while preserving the full local conversation history

File and command tools are scoped to the working directory selected by the user. Sensitive operations can require explicit approval before execution.

### 🛡️ Local execution sandbox

Zeraix includes an optional QEMU-based Linux execution environment for Agent commands:

- Hardware-accelerated virtualization where supported
- A persistent VM instead of one VM boot per command
- Workspace sharing between the host and guest
- Per-command filesystem scoping inside the guest
- Captured command output and execution timeouts
- Port forwarding for local development servers
- macOS, Windows, and Linux-oriented execution paths in the source code

If virtualization or sandbox resources are unavailable, Zeraix may offer or use native execution depending on the selected mode and current implementation. Always verify the execution indicator before approving commands that affect important files.

### 🧠 Memory and context

- Store conversations locally by project
- Keep separate workspaces for assistant and developer use
- Switch models without discarding conversation history
- Save reusable memory as local Markdown files
- Compact long model contexts without rewriting the original conversation
- Encrypt supported local conversation data when application encryption is available

### 🧩 Skills and sub-agents

- Built-in skills for coding, research, review, writing, data extraction, and other tasks
- Project-level skill discovery
- User control over which project instructions are enabled
- Specialized exploration, planning, and review sub-agents
- Restricted tool sets for read-only and review-oriented sub-agents

### ☁️ Cloud when you choose it

Cloud capabilities are optional and separate from the free local core:

- Official hosted model access
- OpenAI-compatible custom endpoints
- Account-based services
- Optional cloud file and platform features

When you select a cloud model, requests are sent to the endpoint or provider associated with that model. Third-party API providers may charge separately and apply their own privacy and retention policies.

### 🌍 Multilingual interface

The interface includes translations for English, 简体中文, 繁體中文, 日本語, 한국어, Français, Español, Italiano, Deutsch, Português, and additional variants represented in the repository.

## Local and cloud boundaries

| Capability | Free | Account required | Offline after setup | Source in this repository |
|---|:---:|:---:|:---:|:---:|
| Local model inference | ✅ | No | ✅ | ✅ |
| Local conversations and memory | ✅ | No | ✅ | ✅ |
| File and terminal Agent tools | ✅ | No | ✅ | ✅ |
| QEMU execution sandbox | ✅ | No | ✅ | ✅ |
| Skills and sub-agents | ✅ | No | ✅ | ✅ |
| Custom OpenAI-compatible endpoint | ✅¹ | No | Depends on endpoint | ✅ |
| Zeraix hosted models | Optional service | Yes | No | Client only |
| Zeraix account and cloud files | Optional service | Yes | No | Client only |

¹ Zeraix does not charge for connecting a custom endpoint. The endpoint provider may charge for its service.

## 🔒 Privacy and network behavior

### Local model usage

When a local model is selected, model inference runs on your computer. Local conversations and workspace operations do not need to be sent to a Zeraix model service.

### Initial downloads

Some local features require network access during setup:

- llama.cpp runtime packages
- GGUF model files
- QEMU binaries used for packaged builds
- The Linux sandbox image, kernel, and initial RAM filesystem

After the required resources are installed, the local core is designed to operate without Zeraix cloud services.

### Cloud and custom endpoints

When a cloud model or custom endpoint is selected, prompts and supported attachments are sent to that provider. Review the provider's terms and privacy policy before sending sensitive information.

### Agent permissions

AI-generated commands and file modifications can be incorrect or unsafe. Review permission requests, diffs, paths, and commands before approving them. Keep backups or version control enabled for important projects.

For vulnerability reporting, see [Security.md](Security.md).

## 📥 Download

| Platform | Requirements | Download |
|---|---|---|
| 🍎 macOS | macOS 13+ · Apple Silicon | [Latest Release](https://github.com/zeraix/Zeraix/releases/latest) |
| 🪟 Windows | Windows 10/11 · x64 | [Latest Release](https://github.com/zeraix/Zeraix/releases/latest) |

For local models, **16 GB or more system memory is recommended**. Smaller models may run on lower-memory devices, while larger models and longer contexts require more memory.

## 🚀 Getting started

### Use a release build

1. Download the latest build from [GitHub Releases](https://github.com/zeraix/Zeraix/releases/latest).
2. Install and launch Zeraix.
3. Open the model library.
4. Let Zeraix inspect your hardware or choose a supported GGUF model manually.
5. Install the recommended local runtime and model.
6. Start a local conversation.

No Zeraix account or subscription is required for the local core.

### Run from source

Requirements:

- Node.js 20.9 or newer
- pnpm
- Git

```bash
git clone https://github.com/zeraix/Zeraix.git
cd Zeraix
corepack enable
pnpm install
pnpm electron:dev
```

The renderer is served by Next.js during development and loaded by Electron after the development server becomes available.

Cloud credentials are not required to develop or use the local core. Some optional account or cloud features may be unavailable without the corresponding configuration.

### Web renderer only

```bash
pnpm dev
```

The web renderer does not provide the full desktop runtime. Features that depend on Electron IPC, local files, terminal access, local models, native notifications, or the sandbox require Electron.

### Validate a source checkout

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

Desktop packaging downloads platform resources and may require platform-specific signing tools. Signing and notarization credentials are not stored in the repository. Unsigned local builds may trigger operating-system security warnings.

For QEMU image and binary details, see [`sandbox/qemu/README.md`](sandbox/qemu/README.md) and [`resources/bin/README.md`](resources/bin/README.md).

## Architecture

```text
Zeraix Desktop
├── Next.js / React renderer
│   ├── Assistant and developer interfaces
│   ├── Conversation state
│   ├── Context compaction
│   ├── Skills and sub-agents
│   └── Permission and diff views
├── Electron main process
│   ├── Secure preload and IPC bridges
│   ├── Local conversation storage
│   ├── LLM request proxy
│   ├── Local llama.cpp management
│   ├── File and terminal tools
│   └── Browser automation
├── Execution layer
│   ├── QEMU Linux sandbox
│   └── Native execution path
└── Model layer
    ├── Local GGUF models
    ├── Custom OpenAI-compatible endpoints
    └── Optional Zeraix cloud services
```

Important source directories:

| Path | Purpose |
|---|---|
| `src/app/agent/` | Assistant and developer application pages |
| `src/app/agent/chat/` | Agent conversation UI and runtime loop |
| `src/lib/ai/` | Models, memory, skills, sub-agents, and AI utilities |
| `electron/` | Electron main process and secure renderer bridges |
| `electron/llm/` | Local model runtime and model request proxy |
| `electron/tools/` | Agent tools, terminal integration, and sandbox routing |
| `electron/tools/sandbox/` | QEMU, guest control, filesystem sharing, and execution engine |
| `sandbox/qemu/` | Sandbox image build files and documentation |
| `scripts/` | Packaging and resource publication scripts |

## Known limitations

- macOS release builds currently target Apple Silicon.
- Windows release builds currently target x64.
- Local model quality and tool-calling reliability depend on the selected model.
- Local model performance depends heavily on memory, GPU support, model size, quantization, and context length.
- The sandbox requires hardware virtualization and additional downloaded resources.
- Some Agent operations may use native execution when the sandbox is unavailable or disabled; verify the current execution mode.
- Initial model and sandbox downloads can be large.
- Cloud services require network access and may require an account or separate payment.

## Roadmap

- [x] Local and cloud model workspace
- [x] Assistant mode with tool calling
- [x] Developer mode with files and terminal
- [x] Hardware-aware local model recommendations
- [x] GGUF model downloads and llama.cpp runtime management
- [x] Persistent local conversations and memory
- [x] Cross-model conversation continuity
- [x] Skills and specialized sub-agents
- [x] QEMU-based execution sandbox
- [x] Multimodal attachments for supported models
- [ ] Expand automated tests and continuous integration
- [ ] Publish reproducible performance and hardware benchmarks
- [ ] Improve sandbox visibility and strict execution policies
- [ ] Expand the Zeraix optimized model line
- [ ] Intelligent local/cloud model routing
- [ ] Continue local inference and memory-use optimizations

## Contributing

Bug reports, documentation improvements, feature proposals, translations, model compatibility reports, and focused code contributions are welcome.

Before submitting a pull request:

1. Read [Contributing.md](Contributing.md).
2. Read and accept the [Contributor License Agreement](CLA.md).
3. Keep each pull request focused on one concern.
4. Run the available validation commands.
5. Do not include secrets, proprietary code, model files, or incompatible third-party code.

Please report security vulnerabilities privately according to [Security.md](Security.md), not through a public issue.

## Open-source and commercial services

This repository contains the Zeraix desktop client and local-first runtime. The local core is free to use under the terms of the AGPL-3.0 license.

Zeraix also operates optional proprietary cloud services, including account, hosted model, file, routing, and commercial platform capabilities. These services are not required to use the local core and are not part of this repository.

## License

Zeraix is licensed under the [GNU Affero General Public License v3.0](LICENSE).

You may use, study, modify, and redistribute the software under the terms of that license. AGPL-3.0 obligations may apply when distributing modified versions or providing modified versions for use over a network.

If those obligations do not fit your commercial use case, contact **emma@zeraix.com** to discuss a commercial license.

The licenses of third-party models, runtimes, libraries, and other downloaded components remain governed by their respective owners and license terms.

## Community

- [Discord](https://discord.gg/PcQ3jr3MfH)
- [X / Twitter](https://x.com/ZeraixAI)
- [Bug reports](https://github.com/zeraix/Zeraix/issues/new)
- [Feature requests](https://github.com/zeraix/Zeraix/issues/new)
- Commercial and partnership inquiries: **emma@zeraix.com**

---

<div align="center">

**Local AI should belong to the person running it.**

If that idea resonates with you, consider starring the repository and helping us improve Zeraix.

</div>

<div align="center">

**Built for local. If that's your thing too, a ⭐ means a lot.**

</div>
