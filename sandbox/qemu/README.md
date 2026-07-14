# QEMU sandbox VM — end-to-end (macOS/HVF · Windows/WHPX · Linux/KVM)

One long-lived VM running the agent toolbox, with **path-isomorphic host binds** and
**dynamic port forward** driven live from the Electron main process — no reboot per task,
one warm VM for the whole session. Same control code on every OS.

`run_command` runs inside the VM (via qemu-guest-agent), confined per-command by
**bubblewrap** to the session's mount set; long-lived services (dev servers) run in the
guest and their ports are **hostfwd-forwarded** to the host (QMP), so the host can preview
them. Not ready / on failure it silently degrades to native (host) execution.

## How it plugs in

`electron/tools/sandbox/qemu.mjs` is the engine (selected by `engine.mjs` when the host has
hardware virtualization). It launches `qemu` directly and talks to it over two 127.0.0.1
TCP sockets via `control.mjs`:

| | |
| --- | --- |
| **QMP** (4444) | VM lifecycle + dynamic port forward (`hostfwd_add`/`hostfwd_remove`) |
| **guest-agent** (4445) | `qemu-guest-agent`: run the (bubblewrap-confined) workload, capture output |

Mount model: share ONE broad 9p root (posix `/`, Windows drive) at `/mnt/hostfs`; every cwd
is already covered. bubblewrap binds the mount set (session common-root ∪ explicitly-chosen
folders) into the guest at the **same absolute path** (posix), so tool output paths match on
both sides — no per-task remount, no VM rebuild.

## Files

| file | role |
| --- | --- |
| `control.mjs` | `qmp()` → `addPort/removePort`; `guestAgent()` → `runStatus/exec` |
| `ninep-server.mjs` | Windows host share: in-process 9p2000.L server over TCP (Windows qemu has no virtio-9p) |
| `Dockerfile` | the one image: agent toolbox + VM bits (systemd + kernel + qemu-guest-agent + bubblewrap + firstboot) |
| `build-rootfs-local.sh` | build the image + convert → bootable `rootfs.qcow2` (+`Image`/`initrd.img`) via `mke2fs -d` — no d2vm/loop/registry |
| `requirements.txt` / `rapidocr_v6_api.py` | toolbox python deps + the PP-OCRv6 adapter (baked into the image) |
| `guest/firstboot.{sh,service}` | guest boot: bring up the NIC, then mount the 9p share (virtio on mac/Linux; skipped on Windows — host mounts over TCP) |
| `.env` | OSS creds + config for the publish scripts (gitignored) |

## Size (Apple Silicon, QEMU 11)

| ship | size |
| --- | --- |
| `qemu-system-aarch64` + `qemu-img` + dylibs | **~61 MB** (x86_64 build ≈ same) |
| firmware | none — direct **kernel boot** (`Image` + `initrd.img`); x86 uses bundled SeaBIOS |
| toolbox rootfs | ~1 GB compressed qcow2 → **download on first run** |

QEMU is fetched from the CDN into the app bundle at **build time** (`dist:*` → `download:bin:*`);
on macOS `afterSign` re-signs it with the `com.apple.security.hypervisor` entitlement. The rootfs
is downloaded from the CDN at **first run** into the platform's local app-data dir (Win
`%LOCALAPPDATA%\<App>\vm\<VM_VERSION>`, macOS `~/Library/Application Support/<App>/vm/<VM_VERSION>`, Linux
`~/.local/share/<App>/vm/<VM_VERSION>`) — `rootfs.qcow2`, `Image`, `initrd.img`. `<VM_VERSION>` is the per-arch
**docker image ID** short hash (`sha-<12hex>`), auto-written to `electron/versions.mjs` by `npm run build:rootfs`;
a new image → new dir → re-download + prune old. Dir layout is in `vmpaths.mjs` (`ZERAIX_VMDIR` overrides the dir).
See **Distribution** below.

## Building the rootfs (CI / publisher, not the client)

Builds the one image from `Dockerfile` and converts it to a bootable qcow2 **locally** — no d2vm,
no loop device, no registry round-trip (works where HTTPS/registries are blocked but HTTP apt
mirrors are reachable, and on a macOS host with no loop devices). Needs Docker.

```sh
# from the repo root — cross-platform wrapper (WSL Docker on Windows, bash on macOS/Linux):
npm run build:rootfs                 # ARCH_DEB defaults: amd64 (Win/Linux-x64), arm64 (Apple Silicon)
# …or call the script directly (no OUTDIR arg = platform local app-data VM dir):
cd sandbox/qemu && ARCH_DEB=amd64 SUITE=trixie ./build-rootfs-local.sh
# override: ARCH_DEB / SUITE / APT_MIRROR / SIZE, or pass an explicit OUTDIR
```

Output = a **direct-kernel-boot** set (~1s boot): `rootfs.qcow2` (whole-disk ext4, no partition
table) + `Image` (kernel) + `initrd.img` (initramfs), all in the local app-data VM dir. `qemu.mjs` needs all
three; the compressed qcow2 boots as-is (QEMU decompresses the read-only base on read; a throwaway
overlay holds writes).

## Distribution — OSS/CDN & scripts

Neither the qemu binaries nor the rootfs are committed. Both are published to Aliyun OSS (bucket
`zeraix-docker`) and served publicly via the CDN **`docker.zeraix.com`**. Uploads authenticate (OSS
creds in gitignored `sandbox/qemu/.env`); downloads use the public CDN URL, so clients need **no
credentials**. All scripts are pure Node in `scripts/` (dev deps `adm-zip` + `ali-oss`; no
ossutil/tar).

| command | what it does |
| --- | --- |
| `npm run bundle:bin:win` | stage local qemu → zip → upload `qemu/win32-x64.zip` (run on a Windows publisher) |
| `npm run bundle:bin:mac` | stage + relocate + ad-hoc-sign local qemu → zip → upload `qemu/darwin-arm64.zip` (macOS publisher) |
| `npm run build:rootfs` | build the VM disk + kernel → local app-data VM dir (Docker) |
| `npm run publish:rootfs` | upload `rootfs.qcow2` / `Image` / `initrd.img` → `vm/<arch>/<VM_VERSION>/` (resumable multipart) |
| **`npm run image:publish`** | **build + publish the rootfs in one step** (`build:rootfs` → `publish:rootfs`) |
| `npm run download:bin:win` · `:mac` | fetch qemu from the CDN → `resources/qemu/<os>-<arch>/` (run automatically by `dist:*`) |

**How it's consumed:**

- **qemu binaries** — `dist:win` / `dist:mac` / `dist:dir` run `download:bin:*` first, so the
  installer bundles qemu pulled from the CDN (build machines need no local qemu). On macOS,
  `afterSign` re-signs the downloaded qemu with the app's Developer ID + hypervisor entitlement.
- **rootfs (VM disk)** — downloaded **at runtime on first launch** by `qemu.mjs` `ensureRootfs()`
  into the local app-data VM dir (`vmpaths.mjs`; `ZERAIX_VMDIR` overrides): if it lacks the disk/kernel,
  it pulls `vm/<arch>/<VM_VERSION>/{rootfs.qcow2,Image,initrd.img}` from `docker.zeraix.com` (~1.15 GB; progress
  broadcast to the UI; atomic `.part`→rename; a failed download degrades to native). `npm run build:rootfs`
  writes to the **same** dir, so a local build is picked up by the runtime with no extra config.

**Publisher workflow** (one-time, or when qemu/rootfs changes): install qemu locally, put OSS creds
in `sandbox/qemu/.env`, then `npm run bundle:bin:win` (or `:mac`) + `npm run image:publish`.
`SKIP_UPLOAD=1` stages+zips a qemu bundle without uploading; `ZERAIX_CDN` / `OSS_QEMU_KEY` /
`ARCH_DEB` / `SUITE` override defaults.

## Boot / mount notes

- Boot ~1s cold (HVF/WHPX/KVM accelerated; `RESUME=none` baked so it doesn't wait for a
  non-existent swap). Paid once — binds/port-forwards apply to the running VM.
- Bind **inside the guest** off the 9p share (not a host symlink): macOS passes symlinks
  through 9p as symlinks, so the guest can't resolve a host path.
- bubblewrap runs as root in the guest **without** `--unshare-user` — a user namespace makes
  the 9p share (`security_model=none`) refuse the bind sources (EPERM); the VM is the
  privilege boundary, bwrap scopes the filesystem view.
- **Network is allowed by default** (bwrap does not `--unshare-net`): sandbox commands reach
  the internet (pip/npm/git/curl) via the guest's SLIRP NAT. `firstboot.sh` gives the NIC the
  deterministic SLIRP address + `nameserver 10.0.2.3` for DNS.

## Platform deltas (only in qemu.mjs's arg builder)

|  | macOS | Windows | Linux |
| --- | --- | --- | --- |
| binary | `qemu-system-aarch64` | `qemu-system-x86_64.exe` | `qemu-system-<arch>` |
| accel / machine | `hvf` / `virt` | `whpx,kernel-irqchip=off` / `q35` | `kvm` / `virt`\|`q35` |
| `-cpu` | `host` | `Haswell` (WHPX rejects `max`) | `host` |
| rootfs arch | arm64 | amd64 | host arch |
| host share | virtio-9p (`/`) | 9p-over-tcp (in-process server, all drives) | virtio-9p (`/`) |
