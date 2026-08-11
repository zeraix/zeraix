"use client";

/**
 * Announce workflow runs in the global notification bar.
 *
 * Automation runs happen off-screen. Once a schedule can fire on its own, a run can start while the
 * user is in the chat, the model library, anywhere — and until now the only place that said so was
 * the automation page itself, which is precisely the page they are not on. A background system that
 * gives no sign it is working is indistinguishable from one that is broken.
 *
 * Deliberately silent on `/agent/automation`: that page already shows the run, its timeline and its
 * state, and a card repeating it would just cover them up.
 *
 * Mounted from GlobalNotifications, so it inherits that component's gating — the notification bar
 * only renders for a signed-in user, and pushing to a surface that is not on screen would be a lie
 * of omission rather than a notification.
 */
import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { useT } from "@/lib/i18n";
import { notify } from "@/store/notificationStore";
import {
  isWorkflowsAvailable,
  subscribeToRunState,
  listWorkflows,
  getRunDetail,
  isTerminal,
  type RunState,
} from "@/lib/workflows";

/** One card per run, replaced in place as the run progresses. */
const cardId = (runId: string) => `wf-run:${runId}`;

/** The page that already shows all of this; announcing there would be noise on top of the real thing. */
const SILENT_ON = "/agent/automation";

export function useWorkflowRunNotifications() {
  const t = useT();
  const pathname = usePathname();

  // Read through refs inside the subscription: it is installed once, and re-subscribing on every
  // route change would drop events in the gap between teardown and re-attach. Seeded with the first
  // render's values and updated in an effect — writing a ref during render is what the React
  // Compiler forbids, and it is the same mutation-during-render hazard whether or not it is caught.
  const pathRef = useRef(pathname);
  const tRef = useRef(t);
  useEffect(() => {
    pathRef.current = pathname;
  }, [pathname]);
  useEffect(() => {
    tRef.current = t;
  }, [t]);

  useEffect(() => {
    if (!isWorkflowsAvailable()) return;

    /** runId -> the workflow's display name, resolved once per run. */
    const names = new Map<string, string>();
    /** Runs this hook has already announced, so a terminal state cannot resurrect a card. */
    const announced = new Set<string>();
    let workflowNames: Map<string, string> | null = null;
    let stopped = false;

    /**
     * The name to put in the card.
     *
     * The state event carries only `{ runId, state, error }` — it cannot say which workflow it is
     * about — so the first sighting of a run costs one lookup, cached from then on. Falls back to the
     * id rather than skipping the notification: "wf-7 is running" is still useful, and silence is not.
     */
    const nameFor = async (runId: string): Promise<string> => {
      const cached = names.get(runId);
      if (cached) return cached;

      // A huge `sinceSeq` asks for the run row without dragging its event log along with it.
      const detail = await getRunDetail(runId, Number.MAX_SAFE_INTEGER);
      const workflowId = detail?.run?.workflow_id;
      if (!workflowId) return runId;

      // Refresh the id -> name map on a miss, so a workflow created after this hook mounted still
      // resolves instead of being stuck showing its id forever.
      if (!workflowNames?.has(workflowId)) {
        workflowNames = new Map((await listWorkflows()).map((w) => [w.id, w.name]));
      }
      const name = workflowNames.get(workflowId) ?? workflowId;
      names.set(runId, name);
      return name;
    };

    const onState = async ({ runId, state, error }: { runId: string; state: RunState; error: string | null }) => {
      const known = announced.has(runId);

      // Terminal states close out a card this hook opened. A run that started while the user was on
      // the automation page has no card, and must not sprout one at the finish line.
      if (isTerminal(state)) {
        if (!known) return;
        announced.delete(runId);
        const name = names.get(runId) ?? runId;
        names.delete(runId);

        if (state === "SUCCEEDED") {
          notify.push({ id: cardId(runId), kind: "success", title: tRef.current("auto.notify.succeeded", { name }) });
        } else if (state === "CANCELLED") {
          // The user stopped it themselves; reporting back what they just did is noise.
          notify.dismiss(cardId(runId));
        } else {
          // FAILED / TIMED_OUT: kind "error" does not auto-dismiss, so a failure that happened while
          // the user was elsewhere is still there when they look.
          notify.push({
            id: cardId(runId),
            kind: "error",
            title: tRef.current("auto.notify.failed", { name }),
            message: error ?? undefined,
          });
        }
        return;
      }

      if (state !== "RUNNING") {
        // AWAITING_APPROVAL / AWAITING_EVENT / AWAITING_RETRY / INTERRUPTED: the run is suspended, so
        // leaving a card that says "running" would be false. Approvals have their own surface (a
        // pinned list on the automation page plus an OS notification), which is the right place for a
        // question; this bar only reports work in progress.
        if (known) {
          announced.delete(runId);
          notify.dismiss(cardId(runId));
        }
        return;
      }

      // RUNNING. Suppressed on the automation page, which already shows it.
      if (pathRef.current?.startsWith(SILENT_ON)) return;
      if (known) return;
      announced.add(runId);

      const name = await nameFor(runId);
      // The run may have finished while the name was being looked up; a card pushed now would never
      // be closed, because its terminal event has already been and gone.
      if (stopped || !announced.has(runId)) return;
      notify.push({ id: cardId(runId), kind: "progress", title: tRef.current("auto.notify.running", { name }) });
    };

    const off = subscribeToRunState((s) => void onState(s));
    return () => {
      stopped = true;
      off();
      // Cards outlive their subscription otherwise: nothing else would ever close one, and a
      // permanent spinner reads as a run that hung.
      for (const runId of announced) notify.dismiss(cardId(runId));
      announced.clear();
    };
  }, []);
}
