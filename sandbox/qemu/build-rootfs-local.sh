#!/usr/bin/env bash
# Bootable-rootfs builder for the QEMU sandbox — the single supported path.
# Builds the one image (toolbox + VM bits, sandbox/qemu/Dockerfile) then converts it to a
# bootable qcow2 with `mke2fs -d` + `qemu-img` — NO d2vm, NO loop device, NO privilege, NO
# registry round-trip. Runs on any host with Docker + bash; CI runs it on ubuntu.
#
# Output = a DIRECT-KERNEL-BOOT artifact set (the BOOT=kernel fast path, ~1s boot):
#   rootfs.qcow2   whole-disk ext4 (no partition table) → /dev/vda root
#   Image          kernel   (qemu -kernel)
#   initrd.img     initramfs(qemu -initrd)
# qemu.mjs auto-selects kernel boot when Image + initrd.img sit next to rootfs.qcow2;
# otherwise it falls back to UEFI/edk2.
#
#   ./build-rootfs-local.sh [OUTDIR]     # OUTDIR default: platform local app-data (Zeraix/vm)
#   (.github/workflows/vm-image.yml passes an explicit OUTDIR; it is the supported way to build one)
set -euo pipefail

# Follow the host unless told otherwise. It used to default to arm64 outright, which on an x64 host
# silently produced an EMULATED arm64 build. CI passes ARCH_DEB explicitly either way.
case "$(uname -m)" in
  arm64 | aarch64) HOST_DEB=arm64 ;;
  *)               HOST_DEB=amd64 ;;
esac
ARCH_DEB="${ARCH_DEB:-$HOST_DEB}"             # Debian arch of the guest to build
PLATFORM="linux/${ARCH_DEB}"
SUITE="${SUITE:-trixie}"                      # base debian suite (matches sandbox/qemu/Dockerfile default)
SIZE="${SIZE:-6G}"                            # sparse; big enough for the ~2GB toolbox rootfs
# Aliyun for both, over HTTP (port 80) because 443/registries may be blocked where this is run by hand:
# apt via the Dockerfile's sed to http://$APT_MIRROR (no ca-certificates on the first layer), pip and the
# OCR models over HTTPS (ca-certs are installed by then). CI overrides both to the upstream defaults —
# these are ~50x faster from China and slower from anywhere else.
APT_MIRROR="${APT_MIRROR:-mirrors.aliyun.com}"
PIP_INDEX_URL="${PIP_INDEX_URL:-https://mirrors.aliyun.com/pypi/simple/}"
HERE="$(cd "$(dirname "$0")" && pwd)"
# Default OUTDIR = platform local app-data VM dir (matches electron/tools/sandbox/vmpaths.mjs so the
# runtime picks up a local build, though it looks under vm/<VM_VERSION>/ — pass that path to be found).
case "$(uname -s)" in
  Darwin) DEF_OUT="$HOME/Library/Application Support/Zeraix/vm" ;;
  *)      DEF_OUT="${XDG_DATA_HOME:-$HOME/.local/share}/Zeraix/vm" ;;
esac
OUT="${1:-$DEF_OUT}"
BUILD="${BUILD:-${TMPDIR:-/tmp}/zx-vmbuild}"
IMG_TAG="zx-vm-${ARCH_DEB}"
ASM_TAG="zx-vmasm-${ARCH_DEB}"   # throwaway assembly host; cached as a layer, see Dockerfile.assembly

echo ">> out: $OUT    build: $BUILD    suite: $SUITE"
rm -rf "$BUILD"; mkdir -p "$BUILD" "$OUT"

# ── The one image: toolbox + VM bits, in a single build (FROM debian, no registry pull) ──
echo ">> building VM image ($PLATFORM) from sandbox/qemu/Dockerfile …"
# DOCKER_BUILD / DOCKER_BUILD_FLAGS are hooks for CI, empty by default so a local build is unchanged.
# A GitHub runner starts with an empty layer store, so without them every run reinstalls the whole
# toolbox (LibreOffice, ffmpeg, the OCR models) from apt. CI sets them to buildx + a GitHub Actions
# cache; see .github/workflows/vm-image.yml. Unquoted on purpose: they carry several flags.
# shellcheck disable=SC2086
${DOCKER_BUILD:-docker build} --platform "$PLATFORM" -f "$HERE/Dockerfile" \
  --build-arg "DEBIAN_SUITE=$SUITE" --build-arg "TARGETARCH=$ARCH_DEB" \
  --build-arg "APT_MIRROR=$APT_MIRROR" --build-arg "PIP_INDEX_URL=$PIP_INDEX_URL" \
  ${DOCKER_BUILD_FLAGS:-} \
  -t "$IMG_TAG" "$HERE"

echo ">> exporting rootfs filesystem …"
CID="$(docker create --platform "$PLATFORM" "$IMG_TAG" /bin/true)"
docker export "$CID" -o "$BUILD/rootfs.tar"
docker rm "$CID" >/dev/null

# ── directory → bare ext4 qcow2 (no d2vm / no loop / no privilege) ──────────────────
# Assembly runs in a throwaway container (Dockerfile.assembly: mke2fs + qemu-img, NOT the VM's OS).
# It is still a container on a Linux runner, where the tools are one apt away, for ONE reason: it runs
# as root, so `tar -x` keeps the rootfs's uid/gid and `mke2fs -d` copies them in. Unpacked as an
# ordinary CI user the whole guest filesystem would end up owned by that user. sudo would do as well,
# at the price of root-owned artifacts to chown afterwards and a second code path.
#
# Stage on the CONTAINER's own fs (/stage, /var/tmp), never the /build bind mount: `mke2fs -d` reads
# xattrs off every symlink, which a bind mount backed by a network/virtual filesystem can fail. Only
# finished artifacts go to /build.
echo ">> building the assembly image …"
# shellcheck disable=SC2086
${DOCKER_BUILD:-docker build} --platform "$PLATFORM" -f "$HERE/Dockerfile.assembly" \
  --build-arg "DEBIAN_SUITE=$SUITE" --build-arg "APT_MIRROR=$APT_MIRROR" \
  ${DOCKER_BUILD_FLAGS_ASM:-} \
  -t "$ASM_TAG" "$HERE"

echo ">> assembling ext4 → qcow2 (size $SIZE) …"
docker run --rm --platform "$PLATFORM" -v "$BUILD:/build" "$ASM_TAG" bash -euc "
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
