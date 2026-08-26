/**
 * Opening the Files sidebar: land the right working directory first.
 *
 * The file tree reads the main process's cwd, but selecting a project only dispatches WORKDIR_SET_EVENT — which the
 * conversation page is the only listener for. On any other page the cwd is never updated, which used to produce
 * "clicked a project, then clicked Files, and the tree showed the previous project". So the caller awaits this first:
 * it sets the cwd directly, and by the time the tree mounts it already points at the target project.
 *
 * Lives here rather than in a component because the entry point moved: it used to be the sidebar's Files row and is
 * now the conversation header's Files button, and both are just callers of this.
 */
import { useAgentChatStore } from "@/store/agentChatStore";
import { clearAgentWorkdir, putStorage } from "@/lib/ai/agentStorage";
import { AGENT_WORKDIR_KEY, WORKDIR_SET_EVENT } from "@/constants/Agent";
import { isToolkitAvailable, setWorkingDir } from "@/lib/ai/toolkit";

/**
 * Point the working directory at the project whose files should be shown: the active project, else the first one.
 * A project with no folder of its own (the default project) falls back to its most recent conversation's directory,
 * and clears the selection when there is none.
 */
export async function prepareFilesWorkdir(): Promise<void> {
  const store = useAgentChatStore.getState();
  const { projects, conversations, activeProjectId } = store;
  const target =
    (activeProjectId ? projects.find((p) => p.id === activeProjectId) : undefined) ?? projects[0] ?? null;
  if (!target) return;
  if (target.id !== activeProjectId) store.setActiveProject(target.id);
  const dir =
    target.workdir || conversations.find((c) => c.projectId === target.id && c.workdir)?.workdir || "";
  if (!dir) {
    clearAgentWorkdir();
    return;
  }
  putStorage(AGENT_WORKDIR_KEY, dir);
  window.dispatchEvent(new CustomEvent(WORKDIR_SET_EVENT, { detail: dir }));
  if (isToolkitAvailable()) await setWorkingDir(dir).catch(() => {});
}
