"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { enabledSkills, loadInstalled } from "@/lib/ai/skills/store";
import { loadPluginSkills } from "@/lib/plugins/skills";
import { pluginBridge } from "@/lib/plugins/bridge";
import { loadEnabledProjectSkills } from "@/lib/ai/skills/project";
import type { InstalledSkill } from "@/lib/ai/skills/types";
import { toInstalledProjectSkill } from "../context/wireHelpers";

export interface ChatSkills {
  /** The installed list (including enabled state), for the skills panel. */
  installedSkills: InstalledSkill[];
  /** Replace the installed list — the skills panel's onChange. Stable. */
  setInstalledSkillsBoth: (list: InstalledSkill[]) => void;
  /** Re-read the installed list from storage. Stable, so the page's mount effect can list it. */
  reloadInstalledSkills: () => void;
  /** Re-read the enabled project skills, after the user decided on a discovered one. */
  reloadProjectSkills: () => Promise<void>;
  /** The skill set a turn runs with (see the declaration). */
  runtimeSkills: () => InstalledSkill[];
  skillsOpen: boolean;
  /** Open the skills panel, re-reading the installed list first. */
  openSkills: () => void;
  closeSkills: () => void;
}

/**
 * Owns the three skill sources a turn draws from — installed, project and plugin — and the skills panel.
 *
 * Each source is held in a ref as well as (for the installed list) in state: the send loop is async and must read
 * the list as it is now, not as its render captured it.
 */
export function useChatSkills({
  onChatRoute,
  workdir,
  toolsReady,
}: {
  onChatRoute: boolean;
  /** Project skills are reloaded when the working directory changes. */
  workdir: string;
  toolsReady: boolean;
}): ChatSkills {
  // Skills: the installed list (including enabled state) + the panel toggle. installedRef lets the async send loop read the latest value.
  const [installedSkills, setInstalledSkills] = useState<InstalledSkill[]>([]);
  const installedSkillsRef = useRef<InstalledSkill[]>([]);
  // Enabled "project skills" (from .claude/.cursor/.zeraix, see ProjectSkillsPrompt / config.json) —
  // mapped to the InstalledSkill shape and merged into the runtime skill set, so they too can be progressively disclosed by load_skill.
  const projectSkillsRef = useRef<InstalledSkill[]>([]);
  const reloadProjectSkills = async () => {
    projectSkillsRef.current = (await loadEnabledProjectSkills()).map(toInstalledProjectSkill);
  };
  // Skills provided by installed plugins (the marketplace, /agent/plugins). Same treatment as project
  // skills: mapped to InstalledSkill and merged into the runtime set, so load_skill discloses them
  // progressively like any other. Enablement and revocation are decided by the plugin store, so
  // there is no separate toggle here.
  const pluginSkillsRef = useRef<InstalledSkill[]>([]);
  const setInstalledSkillsBoth = useCallback((list: InstalledSkill[]) => {
    installedSkillsRef.current = list;
    setInstalledSkills(list);
  }, []);
  const reloadInstalledSkills = useCallback(
    () => setInstalledSkillsBoth(loadInstalled()), // Restore installed skills (including enabled state)
    [setInstalledSkillsBoth],
  );
  const [skillsOpen, setSkillsOpen] = useState(false);

  // Installed skills are re-read from storage on every return to this route. The page's mount effect reads them once,
  // and this component never remounts (AgentShell hosts it permanently), so a skill installed on /agent/skills and
  // then brought here used to be invisible until the app was reloaded. The skills page writes to storage and emits
  // nothing — the `storage` event fires only in OTHER windows — so the reader has to re-read at the moments the list
  // can have changed: coming back to the chat, and opening the panel (see openSkills).
  useEffect(() => {
    if (!onChatRoute) return;
    // Deferred a tick, as the page's mount effect defers its own restore: a synchronous setState in an effect body is
    // what this file's lint forbids, and a re-read of storage is nothing the route's first paint has to wait for.
    void Promise.resolve().then(() => setInstalledSkillsBoth(loadInstalled()));
  }, [onChatRoute, setInstalledSkillsBoth]);

  // Runtime skills = the installed skills the user enabled + conditionally-equipped built-in skills: when commands actually run in the sandbox,
  // the "document / media processing toolbox" is automatically attached (so the model directly uses the tools preinstalled in the image, rather than suggesting a pip/apt install).
  // Built-in skills are not persisted to storage and do not appear in the skills panel; they are rebuilt on every send based on the sandbox status, taking effect immediately on ready/downgrade.
  const runtimeSkills = () => {
    // The installed skills the user enabled (loadInstalled() already merges the built-in document skills, enabled unless switched off) + the enabled project skills (.claude/.cursor/.zeraix) + skills from installed plugins.
    const list = [...enabledSkills(installedSkillsRef.current), ...projectSkillsRef.current, ...pluginSkillsRef.current];
    // The built-in toolbox is NOT added here. messages[0] lists it unconditionally, so including it would list it twice — and
    // worse, the list would change whenever the VM came up or fell back, which is exactly the churn the skills change event
    // exists to avoid. Whether it is usable right now is carried by the environment event instead.
    const withBuiltin = list;
    // Stable order (sorted by id): the catalog now travels as the skills change event, and diffReminder compares arrays
    // order-sensitively — an insertion-order flip would re-emit the whole menu even though nothing changed.
    return [...withBuiltin].sort((a, b) => a.id.localeCompare(b.id));
  };

  // Load / refresh the enabled project skills (reloaded when switching the working directory); an empty set when not Electron or there is no directory.
  useEffect(() => {
    if (!toolsReady) {
      projectSkillsRef.current = [];
      return;
    }
    let active = true;
    void loadEnabledProjectSkills().then((loaded) => {
      if (active) projectSkillsRef.current = loaded.map(toInstalledProjectSkill);
    });
    return () => {
      active = false;
    };
  }, [workdir, toolsReady]);

  // Load / refresh skills from installed plugins, and follow the plugin store's own changes. The
  // subscription matters as much as the initial load: a plugin withdrawn by the registry is disabled
  // in the main process, and without this the conversation would keep offering its skill until the
  // next reload — which is precisely the window revocation exists to close.
  useEffect(() => {
    let active = true;
    const refresh = () => void loadPluginSkills().then((list) => {
      if (active) pluginSkillsRef.current = list;
    });
    refresh();
    const off = pluginBridge()?.onChanged(refresh);
    return () => {
      active = false;
      off?.();
    };
  }, []);

  return {
    installedSkills,
    setInstalledSkillsBoth,
    reloadInstalledSkills,
    reloadProjectSkills,
    runtimeSkills,
    skillsOpen,
    openSkills: () => {
      // Re-read on open as well: the user may have installed a skill on /agent/skills in a way that did not pass
      // through a route change here (the chat stays mounted underneath every /agent route).
      setInstalledSkillsBoth(loadInstalled());
      setSkillsOpen(true);
    },
    closeSkills: () => setSkillsOpen(false),
  };
}
