/**
 * The active project follows the active conversation.
 *
 * The bug (docs/TODO): pick project A in the sidebar, then click a conversation that lives under B. The app
 * shows B's conversation while every project-scoped thing — the highlighted folder, the secure-environment
 * default, the file tree — still answers for A. Nothing errors. It just quietly acts on the wrong project,
 * which is the kind of desync a user only notices after the agent has written somewhere unexpected.
 *
 * Pinned in the store rather than at a call site because that is where the fix belongs: a rule enforced by
 * whichever caller remembers it is a rule that will be half-applied.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./helpers/srcResolve.mjs", import.meta.url);
const { useAgentChatStore } = await import("../src/store/agentChatStore.ts");

const store = () => useAgentChatStore.getState();

/** Two projects, one conversation in each — the minimum that can desync. */
function seed() {
  useAgentChatStore.setState({
    projects: [
      { id: "A", name: "Folder A", workdir: "/tmp/a" },
      { id: "B", name: "Folder B", workdir: "/tmp/b" },
    ],
    conversations: [
      { id: "convA", projectId: "A", title: "in A", messages: [] },
      { id: "convB", projectId: "B", title: "in B", messages: [] },
    ],
    activeProjectId: "A",
    activeConversationId: "convA",
    unread: {},
    loadedProjectIds: new Set(["A", "B"]),
  });
}

test("opening a conversation in another project moves the active project with it", () => {
  seed();
  store().setActiveConversation("convB");
  assert.equal(store().activeConversationId, "convB");
  assert.equal(store().activeProjectId, "B", "the active project stayed on the previous folder");
});

test("opening a conversation in the SAME project leaves the active project alone", () => {
  seed();
  store().setActiveConversation("convA");
  assert.equal(store().activeProjectId, "A");
});

test("a conversation whose project is not loaded does not clear the active project", () => {
  // Half-known state must not become worse-known state: an unresolvable conversation leaves the current
  // project in place rather than blanking it, because blank is not a project the UI can render.
  seed();
  store().setActiveConversation("conv-never-loaded");
  assert.equal(store().activeProjectId, "A", "an unknown conversation must not blank the project");
});

test("closing the conversation keeps the project", () => {
  // The sidebar still has a folder selected after the conversation pane is emptied.
  seed();
  store().setActiveConversation(null);
  assert.equal(store().activeConversationId, null);
  assert.equal(store().activeProjectId, "A");
});

test("opening a conversation still clears its unread dot", () => {
  // The behaviour that already lived here, which the change had to leave intact.
  seed();
  useAgentChatStore.setState({ unread: { convB: true } });
  store().setActiveConversation("convB");
  assert.equal(store().unread.convB, undefined, "opening a conversation is what reads it");
  assert.equal(store().activeProjectId, "B");
});
