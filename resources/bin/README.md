# resources/bin — native binaries bundled with the app (qemu)

Organized into directories by platform/arch:

```
resources/bin/
  <platform>-<arch>/        # e.g. darwin-arm64 / win32-x64 (platform uses process.platform)
    qemu/                   # qemu-system-* + qemu-img + dependency libraries (.dll on Windows, libs/*.dylib on mac)
```

At build time, electron-builder's extraResources copies `resources/bin/<platform>-<arch>/**` verbatim into
`Contents/Resources/`, and at runtime `electron/tools/sandbox/qemu.mjs` reads from
`process.resourcesPath/<platform>-<arch>/qemu/`.

> **qemu is distributed with the app** (its HVF requires build-time signing with a Developer ID + hypervisor entitlement, see scripts/afterSign.cjs;
> plus it's a single build, small in size, and a core feature that must work offline).

## llama is not here — installed dynamically at runtime

llama.cpp has many build variants (Metal / CUDA / Vulkan / CPU × arch) and is large, so it is **not distributed with the app**:
on the first "start local model", it's downloaded from a CDN for the local platform and installed into `userData/llama/<version>/<variant>/`.
- Client logic: `electron/llm/llamaInstaller.mjs`
- Publish per-platform builds to docker.zeraix.com: `npm run publish:llama` (`scripts/publish-llama.mjs`)

## How to populate qemu

```bash
npm run bundle:bin:mac   # macOS release machine: local qemu → relocate dylibs → sign → zip → upload to OSS
npm run bundle:bin:win   # Windows release machine: local qemu + DLLs + firmware → zip → upload to OSS
```

Before `dist:*` packaging, `download:bin:*` automatically splits and lays `bin/<platform>-<arch>.zip` out into this directory.

> This directory keeps only this explanatory placeholder in the repository (to guarantee extraResources' `from: resources/bin` exists);
> each `<platform>-<arch>/` subdirectory is large and is ignored in `.gitignore`, generated per-platform by the release pipeline.
