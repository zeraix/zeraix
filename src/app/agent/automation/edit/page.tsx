"use client";

import { useSearchParams } from "next/navigation";
import WorkflowEditor from "../WorkflowEditor";

/**
 * Route wrapper: the editor is a full page (see AGENT_FULLSCREEN_PATHS), reached by navigation.
 *
 * The workflow id travels as a query param (`?id=`) rather than a path segment: this app is a static
 * export (`output: "export"`), and a dynamic `[id]` segment would demand `generateStaticParams()` —
 * impossible here since workflow ids are runtime user data, not known at build time.
 */
export default function WorkflowEditPage() {
  const search = useSearchParams();
  const id = search.get("id") ?? "";
  return <WorkflowEditor id={id} />;
}
