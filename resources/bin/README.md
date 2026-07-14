# resources/bin — 随包内置的原生二进制（qemu）

按平台/架构分目录：

```
resources/bin/
  <platform>-<arch>/        # 如 darwin-arm64 / win32-x64（platform 用 process.platform）
    qemu/                   # qemu-system-* + qemu-img + 依赖库（Windows 为 .dll，mac 为 libs/*.dylib）
```

打包时 electron-builder 的 extraResources 把 `resources/bin/<platform>-<arch>/**` 原样拷进
`Contents/Resources/`，运行时 `electron/tools/sandbox/qemu.mjs` 从
`process.resourcesPath/<platform>-<arch>/qemu/` 取用。

> **qemu 随包分发**（其 HVF 需构建期用 Developer ID + hypervisor 权限签名，见 scripts/afterSign.cjs；
> 且单一构建、体积小、是核心功能需离线可用）。

## llama 不在这里 —— 运行时动态安装

llama.cpp 构建变体多（Metal / CUDA / Vulkan / CPU × 架构）且体积大，**不随包分发**：
首次「启动本地模型」时按本机平台从 CDN 动态下载安装到 `userData/llama/<version>/<variant>/`。
- 客户端逻辑：`electron/llm/llamaInstaller.mjs`
- 发布各平台构建到 docker.zeraix.com：`npm run publish:llama`（`scripts/publish-llama.mjs`）

## 如何填充 qemu

```bash
npm run bundle:bin:mac   # macOS 发布机：本机 qemu → 重定位 dylib → 签名 → zip → 上传 OSS
npm run bundle:bin:win   # Windows 发布机：本机 qemu + DLL + 固件 → zip → 上传 OSS
```

`dist:*` 打包前自动 `download:bin:*` 把 `bin/<platform>-<arch>.zip` 拆分铺到本目录。

> 本目录随版本库仅留此说明占位（保证 extraResources 的 `from: resources/bin` 存在）；
> 各 `<platform>-<arch>/` 子目录体积大，已在 `.gitignore` 忽略，由发布流程按平台生成。
