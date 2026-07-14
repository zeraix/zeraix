# 打包资源目录（electron-builder buildResources）

将应用图标放在此目录，electron-builder 会自动识别：

- `icon.ico` — Windows 安装包与应用图标（至少 256x256）
- `icon.icns` — macOS 应用图标
- `icon.png` — 备选（512x512 以上，electron-builder 可自动转换）

未提供图标时将使用 Electron 默认图标。
