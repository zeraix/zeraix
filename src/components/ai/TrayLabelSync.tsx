"use client";

/**
 * Global: hand the main process its translated tray-menu labels.
 *
 * The main process has no i18n runtime (like OS notifications, translated strings are produced here
 * and pushed down). The tray has a harder constraint though: on an autostart `--background` launch it
 * renders before any renderer exists, so the labels are persisted on the main side and reused on the
 * next headless start. That makes this component's job "keep the cache fresh", not "provide the text
 * on demand" — hence it re-pushes whenever the language changes.
 *
 * Mounted inside AgentShell (layout level, persists across /agent subpages) so the labels are synced
 * regardless of which page the user happens to open.
 */
import { useEffect } from "react";
import { useT } from "@/lib/i18n";
import { syncTrayLabels } from "@/lib/background";

export default function TrayLabelSync() {
  const t = useT();
  const open = t("tray.open");
  const pause = t("tray.pause");
  const quit = t("tray.quit");
  const running = t("tray.running");

  useEffect(() => {
    syncTrayLabels({ open, pause, quit, running }); // no-op outside Electron
  }, [open, pause, quit, running]);

  return null;
}
