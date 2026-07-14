#!/bin/sh
# Guest boot hook (run by firstboot.service): bring up the SLIRP NIC, then mount the broad host
# share. The NIC comes FIRST and unconditionally, so networking is up regardless of the host-share
# transport — virtio-9p on macOS/Linux, or 9p-over-tcp driven from the host on Windows (where qemu
# has no virtio-9p device). The share mount must never be able to fail this unit or the NIC.
set -eu

# ── SLIRP NIC + DNS ───────────────────────────────────────────────────────────
# QEMU user-net is always 10.0.2.0/24 (host gw .2, guest .15, DNS .3). Static (no DHCP client
# dependency); matches hostfwd's default guest target 10.0.2.15.
IFACE=$(for i in /sys/class/net/*; do n=${i##*/}; [ "$n" != lo ] && echo "$n" && break; done)
if [ -n "${IFACE:-}" ]; then
  ip link set "$IFACE" up
  ip addr add 10.0.2.15/24 dev "$IFACE" 2>/dev/null || true
  ip route replace default via 10.0.2.2 dev "$IFACE" 2>/dev/null || true
fi
printf 'nameserver 10.0.2.3\n' > /etc/resolv.conf

# ── Broad host share ──────────────────────────────────────────────────────────
# qemu.mjs adds `zeraix.share=tcp` to the kernel cmdline on Windows, where qemu has no virtio-9p
# device — the host mounts the share over 9p-over-tcp after boot. Detect that via /proc/cmdline and
# skip the virtio mount cleanly (no failed mount, no 9pnet_virtio kernel warning). Otherwise
# (macOS/Linux) mount the virtio-9p share (mount_tag=hostfs), matching -device virtio-9p-pci.
mkdir -p /mnt/hostfs
if ! grep -qF zeraix.share=tcp /proc/cmdline; then
  mountpoint -q /mnt/hostfs || \
    mount -t 9p -o trans=virtio,version=9p2000.L,msize=262144 hostfs /mnt/hostfs
fi

# Per-command, qemu.mjs runs the UNTRUSTED workload under bubblewrap, binding only the session's
# mount set off /mnt/hostfs into the guest at the same absolute path — so the workload sees exactly
# those folders + a read-only toolbox, never the rest of /mnt/hostfs.
