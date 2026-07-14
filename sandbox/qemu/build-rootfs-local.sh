#!/usr/bin/env bash
# Bootable-rootfs builder for the QEMU sandbox — the single supported path.
# Builds the one image (toolbox + VM bits, sandbox/qemu/Dockerfile) then converts it to a
# bootable qcow2 locally with `mke2fs -d` + `qemu-img` — NO d2vm, NO loop device, NO
# privilege, NO registry round-trip. Works where HTTPS/registries are blocked but HTTP apt
# mirrors are reachable, and on a macOS host with no loop devices.
#
# Output = a DIRECT-KERNEL-BOOT artifact set (the BOOT=kernel fast path, ~1s boot):
#   rootfs.qcow2   whole-disk ext4 (no partition table) → /dev/vda root
#   Image          kernel   (qemu -kernel)
#   initrd.img     initramfs(qemu -initrd)
# qemu.mjs auto-selects kernel boot when Image + initrd.img sit next to rootfs.qcow2;
# otherwise it falls back to UEFI/edk2.
#
#   ./build-rootfs-local.sh [OUTDIR]     # OUTDIR default: platform local app-data (Zeraix/vm)
#   (npm run build:rootfs passes the right OUTDIR via scripts/build-rootfs.mjs → vmpaths.mjs)
set -euo pipefail

ARCH_DEB="${ARCH_DEB:-arm64}"                 # Debian arch (arm64 for Apple Silicon)
PLATFORM="linux/${ARCH_DEB}"
SUITE="${SUITE:-trixie}"                      # base debian suite (matches sandbox/qemu/Dockerfile default)
SIZE="${SIZE:-6G}"                            # sparse; big enough for the ~2GB toolbox rootfs
# HTTP (port 80) mirrors — 443/registry may be blocked; USTC is ~50x faster here than
# deb.debian.org. Override for other regions.
# Aliyun for both: apt over HTTP (Dockerfile's sed rewrites to http://$APT_MIRROR — no
# ca-certificates needed on the first layer), pip/OCR-models over HTTPS (ca-certs are
# installed by then). Override for other regions.
APT_MIRROR="${APT_MIRROR:-mirrors.aliyun.com}"
PIP_INDEX_URL="${PIP_INDEX_URL:-https://mirrors.aliyun.com/pypi/simple/}"
HERE="$(cd "$(dirname "$0")" && pwd)"
# Default OUTDIR = platform local app-data VM dir (matches electron/tools/sandbox/vmpaths.mjs so the
# runtime picks up a local build). npm run build:rootfs passes it explicitly; this is the standalone default.
case "$(uname -s)" in
  Darwin) DEF_OUT="$HOME/Library/Application Support/Zeraix/vm" ;;
  *)      DEF_OUT="${XDG_DATA_HOME:-$HOME/.local/share}/Zeraix/vm" ;;
esac
OUT="${1:-$DEF_OUT}"
BUILD="${BUILD:-${TMPDIR:-/tmp}/zx-vmbuild}"
IMG_TAG="zx-vm-${ARCH_DEB}"

echo ">> out: $OUT    build: $BUILD    suite: $SUITE"
rm -rf "$BUILD"; mkdir -p "$BUILD" "$OUT"

# ── The one image: toolbox + VM bits, in a single build (FROM debian, no registry pull) ──
echo ">> building VM image ($PLATFORM) from sandbox/qemu/Dockerfile …"
docker build --platform "$PLATFORM" -f "$HERE/Dockerfile" \
  --build-arg "DEBIAN_SUITE=$SUITE" --build-arg "TARGETARCH=$ARCH_DEB" \
  --build-arg "APT_MIRROR=$APT_MIRROR" --build-arg "PIP_INDEX_URL=$PIP_INDEX_URL" \
  -t "$IMG_TAG" "$HERE"

echo ">> exporting rootfs filesystem …"
CID="$(docker create --platform "$PLATFORM" "$IMG_TAG" /bin/true)"
docker export "$CID" -o "$BUILD/rootfs.tar"
docker rm "$CID" >/dev/null

# ── directory → bare ext4 qcow2 (no d2vm / no loop / no privilege) ──────────────────
# Assembly runs in a throwaway debian container. NB: stage + mke2fs on the CONTAINER's own
# fs (/stage, /var/tmp), NOT the host bind mount — llistxattr on symlinks over the OrbStack/
# 9p host mount returns ENOENT and breaks `mke2fs -d`. Only finished artifacts go to /build.
# The assembly container is just a throwaway host for mke2fs + qemu-img (NOT the VM's OS);
# same suite as the rootfs only to avoid confusion — any debian with e2fsprogs works.
echo ">> assembling ext4 → qcow2 (size $SIZE) …"
docker run --rm --platform "$PLATFORM" -v "$BUILD:/build" "debian:${SUITE}-slim" bash -euc "
  printf 'deb http://${APT_MIRROR}/debian ${SUITE} main\n' > /etc/apt/sources.list
  rm -f /etc/apt/sources.list.d/debian.sources
  apt-get -o Acquire::ForceIPv4=true update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends e2fsprogs qemu-utils file >/dev/null
  rm -rf /stage; mkdir -p /stage
  tar -C /stage -xf /build/rootfs.tar
  # kernel + initrd (arm64 vmlinuz already boots via qemu -kernel; decompress only if gzip)
  cp /stage/boot/vmlinuz-* /build/Image
  cp /stage/boot/initrd.img-* /build/initrd.img
  if file /build/Image | grep -qi gzip; then mv /build/Image /build/Image.gz; zcat /build/Image.gz > /build/Image; rm -f /build/Image.gz; fi
  # empty the pseudo-fs mountpoints (systemd remounts them at boot)
  rm -rf /stage/proc/* /stage/sys/* /stage/dev/* /stage/run/* /stage/tmp/*
  mke2fs -q -t ext4 -L zxroot -m 1 -d /stage -F /var/tmp/rootfs.raw ${SIZE}
  rm -f /build/rootfs.qcow2
  # Compress the read-only base (~2.4G→~1G). QEMU decompresses clusters on read; writes go
  # to the uncompressed overlay, so only cold base reads pay a small (cached) CPU cost.
  qemu-img convert -f raw -c -O qcow2 /var/tmp/rootfs.raw /build/rootfs.qcow2
  rm -f /var/tmp/rootfs.raw
  echo '--- artifacts ---'; ls -la /build/rootfs.qcow2 /build/Image /build/initrd.img
"

install -m 0644 "$BUILD/rootfs.qcow2" "$OUT/rootfs.qcow2"
install -m 0644 "$BUILD/Image"        "$OUT/Image"
install -m 0644 "$BUILD/initrd.img"   "$OUT/initrd.img"
echo ">> done. installed to $OUT :"
ls -la "$OUT/rootfs.qcow2" "$OUT/Image" "$OUT/initrd.img"
