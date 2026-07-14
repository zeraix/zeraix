"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronRight, Folder, FolderOpen, File as FileIcon, Loader2 } from "lucide-react";
import { wsReadDir, type WsEntry } from "@/lib/ai/toolkit";
import { requestOpenFile } from "@/lib/fileViewer";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { WORKDIR_SET_EVENT, WORKDIR_CLEAR_EVENT } from "@/constants/Agent";

// 子路径拼接（相对工作目录，统一用 /；主进程 resolveInside 会归一化，Windows 也可）。
const join = (parent: string, name: string) => (parent ? `${parent}/${name}` : name);

/** 单个树节点：文件夹点击展开 / 收起（按需拉子项），文件点击在右侧面板打开。 */
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

/** 工作目录文件树（侧栏「文件」分区）。根为当前工作目录；切换项目 / 目录时重挂并重载根。 */
export default function FilesTree() {
  const t = useT();
  const [root, setRoot] = useState<WsEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [remountKey, setRemountKey] = useState(0); // 变更时强制重挂子树，收起所有展开态

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
    // 切项目 / 目录 → 工作目录变了，重载根（稍延后，等主进程 setWorkingDir 落地）。
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
