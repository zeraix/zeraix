# syntax=docker/dockerfile:1
# The one image for the QEMU sandbox: agent toolbox + VM-boot bits, built in a single
# pass from Debian slim. build-rootfs-local.sh converts it to a bootable qcow2.
#
#   Toolbox (glibc/Debian, chosen over Alpine so PDF/office wheels install prebuilt, and
#   LibreOffice ships python3-uno for unoserver): media/PDF/office/OCR/CLI + a python venv.
#   VM bits: systemd (PID 1), a kernel + initramfs, qemu-guest-agent (host control channel),
#   bubblewrap (in-guest confinement), and the firstboot unit (mount 9p share + bring up NIC).
#
# Context = sandbox/qemu/ (holds requirements.txt, rapidocr_v6_api.py, guest/):
#   docker build --platform linux/arm64 -f sandbox/qemu/Dockerfile -t zx-vm sandbox/qemu
# Default suite trixie (Python 3.13 + LibreOffice 25.x); bookworm works via --build-arg.
ARG DEBIAN_SUITE=trixie
FROM debian:${DEBIAN_SUITE}-slim
ARG TARGETARCH   # buildx/BuildKit provides amd64 | arm64 — matches Debian linux-image-<arch>

ENV LANG=C.UTF-8 \
    PYTHONUNBUFFERED=1 \
    DEBIAN_FRONTEND=noninteractive \
    PYTHONPATH="/opt/ocr" \
    UV_LINK_MODE=copy \
    PATH="/opt/venv/bin:$PATH"

# ── China build acceleration ─────────────────────────────────────────────────
# Mirror defaults target Aliyun (built in / shipped from China; deb.debian.org / PyPI are
# slow/flaky there). For an upstream build override BOTH:
#   --build-arg APT_MIRROR=deb.debian.org --build-arg PIP_INDEX_URL=https://pypi.org/simple/
ARG APT_MIRROR=mirrors.aliyun.com
ARG PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/
# Persist the PyPI mirror as ENV so both build-time uv AND runtime `pip install` use it.
ENV UV_DEFAULT_INDEX=${PIP_INDEX_URL} \
    PIP_INDEX_URL=${PIP_INDEX_URL}

# Point apt at $APT_MIRROR (classic sources.list AND deb822 debian.sources).
RUN for f in /etc/apt/sources.list /etc/apt/sources.list.d/debian.sources; do \
      [ -f "$f" ] && sed -i -E "s#https?://(deb|security)\.debian\.org#http://${APT_MIRROR}#g" "$f" || true; \
    done

# ── Toolbox: media / PDF / office / OCR native deps + python interpreter ──────
RUN apt-get update && apt-get install -y --no-install-recommends \
      # media / image / vector
      ffmpeg imagemagick librsvg2-bin \
      libpango-1.0-0 libpangocairo-1.0-0 libcairo2 libgdk-pixbuf-2.0-0 \
      # PDF (raster/vector tooling; OCR handled by rapidocr/PP-OCRv6 in the venv)
      ghostscript poppler-utils qpdf pngquant unpaper \
      # office (headless) + UNO python bridge + universal doc conversion
      libreoffice-writer libreoffice-calc libreoffice-impress python3-uno pandoc \
      # graph / archive / search CLIs
      graphviz p7zip-full zstd jq ripgrep \
      # fonts — REQUIRED or PDF/office render empty boxes; noto-cjk for Chinese
      fontconfig fonts-dejavu fonts-noto fonts-noto-cjk \
      # python (uv provides the venv + pip; only the interpreter is needed here)
      python3 \
 && rm -rf /var/lib/apt/lists/*

# ── Common CLI bins an agent/dev sandbox expects ──────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
      time procps psmisc lsof htop \
      iproute2 iputils-ping bind9-dnsutils netcat-openbsd socat openssh-client rsync \
      curl wget ca-certificates gnupg openssl git \
      file tree less patch gawk nano vim-tiny sudo \
      unzip zip xz-utils bzip2 \
      make tmux bc \
 && rm -rf /var/lib/apt/lists/*

# uv (ultra-fast installer). Pin a version for reproducible builds.
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

COPY requirements.txt /tmp/requirements.txt
# --system-site-packages lets the venv import `uno`; --seed puts pip in the venv.
RUN --mount=type=cache,target=/root/.cache/uv \
    uv venv --seed --system-site-packages /opt/venv \
 && uv pip install --python /opt/venv/bin/python -r /tmp/requirements.txt \
 && rm -f /tmp/requirements.txt

# Bundle the PP-OCRv6 adapter and pre-download the v6 models at build time (offline OCR).
COPY rapidocr_v6_api.py /opt/ocr/rapidocr_v6_api.py
RUN /opt/venv/bin/python -c "from rapidocr import RapidOCR; import numpy as np; RapidOCR()(np.full((64,320,3),255,dtype=np.uint8))"

# ── VM-boot bits: init + kernel + guest agent + confinement + firstboot ───────
RUN apt-get update && apt-get install -y --no-install-recommends \
      systemd systemd-sysv dbus "linux-image-${TARGETARCH}" initramfs-tools \
      qemu-guest-agent bubblewrap \
 && rm -rf /var/lib/apt/lists/*
COPY guest/firstboot.sh      /usr/local/sbin/firstboot.sh
COPY guest/firstboot.service /etc/systemd/system/firstboot.service
# Put the toolbox venv (python/pip/unoserver/…) on PATH for direct login/SSH shells (they
# source /etc/profile.d). Sandbox commands get it from qemu.mjs's bwrap `--setenv PATH`,
# which applies INSIDE the per-command bubblewrap regardless of the inherited env — the
# Dockerfile `ENV PATH` above only affects `docker run`, not the booted VM's command exec.
RUN printf 'export PATH=/opt/venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n' > /etc/profile.d/venv-path.sh

# Enable units, drop the bogus build-time RESUME hint (else boot waits ~30s for a
# non-existent swap device), regenerate a resume-less initramfs (~1s boot). systemd is
# PID 1 in the VM; firstboot.sh mounts the 9p host share + brings up the NIC.
RUN chmod +x /usr/local/sbin/firstboot.sh \
 && systemctl enable firstboot.service qemu-guest-agent.service \
 && systemctl mask systemd-networkd-wait-online.service 2>/dev/null || true \
 && echo 'RESUME=none' > /etc/initramfs-tools/conf.d/resume \
 && KV="$(ls /lib/modules | head -1)" \
 && mkinitramfs -o "/boot/initrd.img-$KV" "$KV"
