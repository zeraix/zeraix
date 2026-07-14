"use client";

/**
 * 工作目录选择行（首页 /agent 用）：运行环境（本地）+ 选择文件夹。
 * 在进入对话「前一阶段」选定工作目录：
 *   - 开发模式：必须选择一个文件夹，否则向上汇报 blocking=true（首页据此禁用发送）；
 *   - 日常模式：可选；不选则由对话页回退到默认目录（userData/agent 下，与数据存储位置一致）。
 * 选定后即设为 Electron 工作目录并持久化（AGENT_WORKDIR_KEY），对话页 /agent/chat 会沿用。
 */
import { useEffect, useRef, useState } from "react";
import { ChevronDown, FolderSymlink, Monitor } from "lucide-react";
import { getStorage } from "@zzcpt/zztool";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  chooseWorkingDir,
  getWorkingDir,
  isToolkitAvailable,
  setWorkingDir,
} from "@/lib/ai/toolkit";
import {
  AGENT_MODE_KEY,
  AGENT_WORKDIR_KEY,
  MODE_CHANGE_EVENT,
  WORKDIR_CLEAR_EVENT,
  WORKDIR_SET_EVENT,
  type AgentMode,
} from "@/constants/Agent";
import { putStorage } from "@/lib/ai/agentStorage";
import { useT } from "@/lib/i18n";

/** 取路径最后一段作为文件夹名（兼容 Windows \ 与 POSIX /）。 */
function folderName(p: string): string {
  const segs = p.split(/[\\/]/).filter(Boolean);
  return segs[segs.length - 1] || p;
}

export default function WorkdirSelector({
  onBlockingChange,
}: {
  /** blocking=true 表示「开发模式且未选目录」，调用方据此禁用发送。 */
  onBlockingChange?: (blocking: boolean) => void;
}) {
  const t = useT();
  const [toolsReady, setToolsReady] = useState(false);
  const [mode, setMode] = useState<AgentMode>("daily");
  const [workdir, setWorkdir] = useState("");
  const [chosen, setChosen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // 挂载：探测工具 + 回填已持久化的工作目录（并同步到主进程）。
  useEffect(() => {
    const ready = isToolkitAvailable();
    setToolsReady(ready);
    const saved = getStorage(AGENT_WORKDIR_KEY);
    if (typeof saved === "string" && saved) {
      setWorkdir(saved);
      setChosen(true);
      if (ready) void setWorkingDir(saved).catch(() => {});
    } else if (ready) {
      void getWorkingDir().then(setWorkdir).catch(() => {});
    }
  }, []);

  // 同步侧边栏的「日常 / 开发」模式（同标签自定义事件）。
  useEffect(() => {
    const read = () => {
      const v = getStorage(AGENT_MODE_KEY);
      if (v === "daily" || v === "dev") setMode(v);
    };
    read();
    const onCustom = (e: Event) => {
      const v = (e as CustomEvent).detail;
      if (v === "daily" || v === "dev") setMode(v);
    };
    // 切换模式 / 新建对话会清空已选目录 → 重置本组件的选择状态。
    const onClear = () => {
      setChosen(false);
      setWorkdir("");
      setMsg(null);
    };
    // 侧栏「点击项目」/ 右键「在项目内新建对话」会广播已选目录 → 本组件回填并解除开发模式阻塞。
    // 关键：从日常切到开发（未选项目）会先经 onClear 清空并阻塞，随后右键项目「新建对话」时若已在
    // /agent 首页，router.push("/agent") 是空跳转、本组件不会重挂载去重读 storage；不监听此事件就会一直
    // 停在「需先选择文件夹」的阻塞态，导致输入框禁用、无法发送。
    const onSet = (e: Event) => {
      const dir = (e as CustomEvent).detail;
      if (typeof dir !== "string" || !dir) return;
      setWorkdir(dir);
      setChosen(true);
      setMsg(null);
      if (isToolkitAvailable()) void setWorkingDir(dir).catch(() => {});
    };
    window.addEventListener(MODE_CHANGE_EVENT, onCustom);
    window.addEventListener(WORKDIR_CLEAR_EVENT, onClear);
    window.addEventListener(WORKDIR_SET_EVENT, onSet);
    return () => {
      window.removeEventListener(MODE_CHANGE_EVENT, onCustom);
      window.removeEventListener(WORKDIR_CLEAR_EVENT, onClear);
      window.removeEventListener(WORKDIR_SET_EVENT, onSet);
    };
  }, []);

  // 向上汇报「是否阻塞发送」（用 ref 持有回调，避免其引用变化触发额外 effect）。
  const blocking = toolsReady && mode === "dev" && !chosen;
  const cbRef = useRef(onBlockingChange);
  cbRef.current = onBlockingChange;
  useEffect(() => {
    cbRef.current?.(blocking);
  }, [blocking]);

  const browse = async () => {
    if (!toolsReady) return;
    setMsg(null);
    try {
      const dir = await chooseWorkingDir();
      if (!dir) return; // 用户取消
      setWorkdir(dir);
      setChosen(true);
      putStorage(AGENT_WORKDIR_KEY, dir); // 持久化，供对话页沿用
      // 广播已选目录：对话页据此把 workdirChosen 置真并应用到工具沙箱。缺此事件时，即使这里选了目录，
      // 常驻挂载的对话页仍不知情（storage 变更不跨组件通知），开发模式发送会误报「需先选择工作目录」。
      window.dispatchEvent(new CustomEvent(WORKDIR_SET_EVENT, { detail: dir }));
    } catch (e) {
      setMsg(`选择失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <div className="mt-2">
      <div className="flex items-center gap-1.5">
        {/* 运行环境：本地（占位下拉，后续可扩展云端等） */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex shrink-0 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs font-medium text-foreground transition hover:bg-accent"
            >
              <Monitor className="size-3.5 text-muted-foreground" />
              {t("env.local")}
              <ChevronDown className="size-3 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-36">
            <DropdownMenuItem>
              <Monitor className="size-3.5" /> {t("env.local")}
            </DropdownMenuItem>
            <DropdownMenuItem>
              <Monitor className="size-3.5 disabled" /> {t("env.cloud")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* 选择文件夹：日常可选 / 开发必选；已选则显示文件夹名 */}
        <button
          type="button"
          onClick={() => void browse()}
          disabled={!toolsReady}
          title={!toolsReady ? t("workdir.needDesktop") : chosen ? workdir : undefined}
          className={`flex min-w-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50 ${
            blocking ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"
          }`}
        >
          <FolderSymlink className="size-3.5 shrink-0" />
          <span className="truncate">
            {chosen ? (
              <span className="text-foreground">{folderName(workdir)}</span>
            ) : mode === "dev" ? (
              t("workdir.required")
            ) : (
              t("workdir.optional")
            )}
          </span>
        </button>
      </div>
      {/* {blocking && (
        <p className="mt-1 px-0.5 text-[11px] text-amber-600 dark:text-amber-400">
          开发模式：请先选择一个文件夹，再开始对话。
        </p>
      )} */}
      {msg && <p className="mt-1 px-0.5 text-[11px] text-amber-600 dark:text-amber-400">{msg}</p>}
    </div>
  );
}
