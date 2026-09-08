# Zeraix Model Systems Notes

These notes preserve the model configurations and release-validation results previously listed on the Zeraix homepage. They describe the **v1.7.0–v1.11.0 desktop runtime paths**, not benchmarks of the Imparo engine or a current compatibility guarantee.

The reported optimization work focuses on **Apple Silicon/macOS**. Results do not establish equivalent behavior or performance on Windows. Consult the linked releases for the original scope and limitations.

Our ongoing inference-engine work is now published as **[Imparo](https://github.com/zeraix/imparo)**. See that repository for its current code, supported configurations, and performance reports.

[Back to Zeraix](README.md)

## Historical release progress

### v1.11.0: automation and local model updates

- **Scheduled workflows** — run AI workflows daily, on weekdays, hourly, or every few minutes, with configurable missed-run behavior.
- **Observable automation** — review the next run, latest result, run count, success rate, notifications, and a separate output folder for each run.
- **Readable approvals** — permission requests show the command or instruction and its values, with the raw payload available only when needed.
- **Qwen Bonsai 27B** — a 7.2 GB dense approximately 2-bit model path with multimodal support, up to 256K context, and an optional DSpark speculative-decoding drafter.
- **Hybrid GDN work** — faster Qwen3.6-35B decoding through in-place recurrent-state updates in the KV cache and improved SSM-convolution thread utilization.

### v1.9.0-v1.10.0: MCP, plugins, and safer delegation

- connect local or remote MCP services and make their tools available inside conversations;
- install compatible plugins from the Zeraix registry;
- delegate temporary tasks to concurrent sub-agents with task-scoped capabilities;
- keep capability assignment under application control and recheck it before each protected action;
- separate user approvals from autonomous sub-agent permissions and record protected actions in the audit trail;
- answer several model questions in one structured card without losing the task context.

### v1.8.0-v1.11.0: model and runtime progress

- **Mapped model weights** reduced repeated loading and memory-copy overhead on supported Apple Silicon paths.
- **Correctness gates** produced byte-identical reference outputs for the validated Gemma 4 E4B, Gemma 4 26B-A4B, and Qwen3.6-35B configurations reported in v1.8.0.
- **Right-sized compute buffers** allocate for the active batch instead of the maximum configured batch.
- **Short-lived vision projection** releases the vision projector after image encoding.
- **Lower-overhead speculative decoding** reads fewer language-model-head rows for the drafter path.
- **Parallel MoE staging** improves the I/O path used to prepare expert data.

### Model paths in the referenced releases

| Model | Public configuration | Shipping optimization path |
|---|---|---|
| Qwen Bonsai 27B | Dense approximately 2-bit · 7.2 GB · multimodal · up to 256K context | Optional DSpark speculative decoding and hardware-aware local configuration |
| Qwen3.6-35B-A3B | MTP GGUF · vision · up to 256K context | Profile-guided MoE pooling, mapped weights, hybrid GDN improvements, persistent KV reuse, and published prefix seeds |
| Gemma 4 26B-A4B | QAT GGUF · vision · up to 256K context | Profile-guided MoE pooling, mapped weights, per-host memory planning, MTP speculative decoding, and persistent KV reuse |
| Gemma 4 12B | QAT GGUF · vision/audio · up to 256K context | Hardware-aware sizing, MTP speculative decoding, persistent KV reuse, and published prefix seeds |
| Gemma 4 E4B | QAT GGUF · vision/audio · up to 128K context | Low-memory profile, MTP speculative decoding, persistent KV reuse, and published prefix seeds |
| Community GGUF | Compatible external Hugging Face GGUF repositories | Repository search, architecture checks, quantization selection, memory estimation, context/KV controls, optional vision/MTP assets, and chat-template overrides |

### Selected release measurements

| Release validation | Before | Reported result |
|---|---:|---:|
| Qwen3.6-35B load time on the reported 36 GB Mac | 40.4 s | 8.2 s |
| Additional loading footprint in that run | 18 GB | 0.5 GB |
| Qwen3.6-35B prompt processing in that run | 6.9 tok/s | 121 tok/s |
| Qwen Bonsai 27B decode across the reported 24-prompt suite | 16.2 tok/s | 20.5 tok/s (1.26x) |
| Qwen Bonsai 27B drafted-token acceptance | — | 67% |

These measurements describe the specific release-validation runs documented in [v1.8.0](https://github.com/zeraix/zeraix/releases/tag/v1.8.0) and [v1.11.0](https://github.com/zeraix/zeraix/releases/tag/v1.11.0). They are not universal performance guarantees. Results vary with the exact model, quantization, context, enabled capabilities, hardware, thermals, and workload. Earlier memory-planning, MoE-pooling, persistent-KV, and prefix-seed results remain documented in [v1.7.0](https://github.com/zeraix/zeraix/releases/tag/v1.7.0).


## Interpreting measurements

Model-file size, additional loading footprint, and total process memory are different measurements. Prompt processing, time to first token, and sustained decode throughput should also be evaluated separately.

Future model reports should identify the model revision, quantization, hardware, runtime revision, context and output lengths, commands, memory-measurement method, correctness checks, and known limitations. A result from a fixed configuration is not a guarantee for every model, workload, or hardware tier.
