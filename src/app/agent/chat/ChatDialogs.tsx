"use client";

/**
 * The chat page's modal dialogs, grouped in one place: the "local model isn't running" guide, the sandbox
 * startup progress dialog, and conversation rename.
 *
 * They share nothing but their modality — keeping them together is what stops three unrelated overlays from
 * being interleaved with the transcript markup in page.tsx.
 */
import { useRouter } from "next/navigation";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import SandboxStartupDialog from "@/components/ai/SandboxStartupDialog";
import type { SandboxStatus } from "@/lib/ai/sandbox";
import { useImeGuard } from "@/lib/ime";
import { useT } from "@/lib/i18n";
import { selCls } from "./constants";

export function ChatDialogs(props: {
  /** "Local model not started": a modal guide (more prominent than an inline error). */
  localStartOpen: boolean;
  onLocalStartOpenChange: (open: boolean) => void;
  /** Named in the dialog body so the user knows which model needs starting. */
  modelLabel: string | undefined;
  sandboxStatus: SandboxStatus | null;
  /** The active session's secure-environment switch — gates the sandbox startup dialog's auto-open. */
  secureEnv: boolean;
  /** Incremented to (re)open the sandbox dialog — clicking the header badge bumps it. */
  sandboxDialogTick: number;
  /** Rename draft: null when the dialog is closed, the pending title while it is open. */
  renameDraft: string | null;
  onRenameDraftChange: (draft: string | null) => void;
  /** Null before the first message, when there is no record to rename. */
  activeConvId: string | null;
  onRename: (id: string, title: string) => void;
}) {
  const t = useT();
  const router = useRouter();
  const ime = useImeGuard();
  const { renameDraft, activeConvId } = props;

  const commitRename = () => {
    if (renameDraft?.trim() && activeConvId) props.onRename(activeConvId, renameDraft.trim());
    props.onRenameDraftChange(null);
  };

  return (
    <>
      {/* Local model not started: after confirming, it jumps directly to Settings → Local model. */}
      <Dialog open={props.localStartOpen} onOpenChange={props.onLocalStartOpenChange}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("lm.notStartedTitle")}</DialogTitle>
            <DialogDescription>
              {t("lm.notStartedDesc", { label: props.modelLabel ?? "llama.cpp" })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button
              onClick={() => props.onLocalStartOpenChange(false)}
              className="rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-sm text-ink transition hover:bg-surface-muted"
            >
              {t("lm.cancel")}
            </button>
            <button
              onClick={() => {
                props.onLocalStartOpenChange(false);
                router.push("/agent/models");
              }}
              className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-white shadow-sm transition hover:brightness-105"
            >
              {t("lm.goStart")}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Sandbox startup progress (sessions in the secure environment): downloading the runtime environment image / downloaded + startup progress; can also be opened from the header indicator. */}
      <SandboxStartupDialog
        status={props.sandboxStatus}
        secureEnv={props.secureEnv}
        openTick={props.sandboxDialogTick}
      />

      {/* Rename the current conversation (opened from the header title dropdown). */}
      <Dialog
        open={renameDraft !== null}
        onOpenChange={(o) => !o && props.onRenameDraftChange(null)}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("ctx.renameConversation")}</DialogTitle>
          </DialogHeader>
          <input
            autoFocus
            value={renameDraft ?? ""}
            onChange={(e) => props.onRenameDraftChange(e.target.value)}
            {...ime.bind}
            onKeyDown={(e) => {
              // A conversation title is exactly the kind of field typed on an IME; the Enter that
              // commits the composition must not also confirm the rename. See lib/ime.ts.
              if (ime.isImeKey(e)) return;
              if (e.key === "Enter" && renameDraft?.trim() && activeConvId) commitRename();
            }}
            placeholder={t("ctx.renamePlaceholder")}
            className={selCls}
          />
          <DialogFooter>
            <button
              onClick={commitRename}
              disabled={!renameDraft?.trim()}
              className="rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-white transition hover:brightness-105 disabled:opacity-50"
            >
              {t("ctx.save")}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
