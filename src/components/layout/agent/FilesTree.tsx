"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronRight, Folder, FolderOpen, File as FileIcon, Loader2 } from "lucide-react";
import { wsReadDir, type WsEntry } from "@/lib/ai/toolkit";
import { requestOpenFile } from "@/lib/fileViewer";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { WORKDIR_SET_EVENT, WORKDIR_CLEAR_EVENT } from "@/constants/Agent";

// Join a subpath (relative to the working directory, always using /; the main process's resolveInside normalizes it, works on Windows too).
const join = (parent: string, name: string) => (parent ? `${parent}/${name}` : name);

/** A single tree node: clicking a folder expands / collapses it (lazily fetching children); clicking a file opens it in the right-side panel. */
function TreeNode({ path, name, isDir, depth }: { path: string; name: string; isDir: boolean; depth: number }) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<WsEntry[] | null>(null);
  const [loading, setLoading] = useState(false);

  const toggle = () => {
    if (!isDir) {
      requestOpenFile(path);
      return;
    }
    const next = !expanded;
    setExpanded(next);
    if (next && children === null) {
      setLoading(true);
      void wsReadDir(path)
        .then(setChildren)
        .finally(() => setLoading(false));
    }
  };

  return (
    <div>
      <button
        type="button"
        onClick={toggle}
        title={name}
        style={{ paddingLeft: 6 + depth * 12 }}
        className="flex w-full items-center gap-1 rounded-md py-1 pr-2 text-left text-[13px] text-foreground/80 transition-colors hover:bg-accent dark:hover:bg-white/[0.04]"
      >
        {isDir ? (
          <ChevronRight
            className={cn("size-3 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-90")}
          />
        ) : (
          <span className="size-3 shrink-0" />
        )}
        {isDir ? (
          expanded ? (
            <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <Folder className="size-3.5 shrink-0 text-muted-foreground" />
          )
        ) : (
          <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate">{name}</span>
        {loading && <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />}
      </button>
      {isDir && expanded && children && (
        <div>
          {children.length === 0 ? (
            <p className="py-0.5 text-[11px] text-muted-foreground" style={{ paddingLeft: 6 + (depth + 1) * 12 }}>
              {t("files.empty")}
            </p>
          ) : (
            children.map((c) => (
              <TreeNode key={c.name} path={join(path, c.name)} name={c.name} isDir={c.isDir} depth={depth + 1} />
            ))
          )}
        </div>
      )}
    </div>
  );
}

/** Working-directory file tree (the sidebar's "Files" section). The root is the current working directory; switching project / directory remounts and reloads the root. */
export default function FilesTree() {
  const t = useT();
  const [root, setRoot] = useState<WsEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [remountKey, setRemountKey] = useState(0); // On change, force-remount the subtree, collapsing all expanded state

  const loadRoot = useCallback(async () => {
    setLoading(true);
    try {
      setRoot(await wsReadDir(""));
    } finally {
      setLoading(false);
    }
    setRemountKey((k) => k + 1);
  }, []);

  useEffect(() => {
    void loadRoot();
    // Switch project / directory -> the working directory changed, reload the root (with a small delay, waiting for the main process's setWorkingDir to take effect).
    const onChange = () => window.setTimeout(() => void loadRoot(), 60);
    window.addEventListener(WORKDIR_SET_EVENT, onChange);
    window.addEventListener(WORKDIR_CLEAR_EVENT, onChange);
    return () => {
      window.removeEventListener(WORKDIR_SET_EVENT, onChange);
      window.removeEventListener(WORKDIR_CLEAR_EVENT, onChange);
    };
  }, [loadRoot]);

  if (loading && root === null) {
    return <p className="px-2 py-1 text-xs text-muted-foreground">{t("files.loading")}</p>;
  }
  if (!root || root.length === 0) {
    return <p className="px-2 py-1 text-xs text-muted-foreground">{t("files.noFiles")}</p>;
  }
  return (
    <div key={remountKey}>
      {root.map((e) => (
        <TreeNode key={e.name} path={e.name} name={e.name} isDir={e.isDir} depth={0} />
      ))}
    </div>
  );
}
