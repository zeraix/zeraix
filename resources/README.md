# Build resources directory (electron-builder buildResources)

Place the app icons in this directory; electron-builder recognizes them automatically:

- `icon.ico` — Windows installer and app icon (at least 256x256)
- `icon.icns` — macOS app icon
- `icon.png` — fallback (512x512 or larger; electron-builder can convert automatically)

When no icon is provided, the default Electron icon is used.
