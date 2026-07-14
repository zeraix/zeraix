import { Package } from "lucide-react";
import ModelLibrary from "@/components/ai/ModelLibrary";

export default function AgentModelsPage() {
  return (
    <div className="mx-auto max-w-3xl px-8 py-10">
      <div className="flex items-center gap-3">
        <span className="flex size-9 items-center justify-center rounded-lg bg-accent text-foreground">
          <Package className="size-5" />
        </span>
        <h1 className="text-2xl font-bold tracking-tight text-ink">Model Library</h1>
      </div>
      <div className="mt-6">
        <ModelLibrary />
      </div>
    </div>
  );
}
