import { Package } from "lucide-react";
import ModelLibrary from "@/components/ai/ModelLibrary";
import CustomScrollbar, { PAGE_SCROLLBAR } from "@/components/CustomScrollbar";

export default function AgentModelsPage() {
  return (
    <CustomScrollbar className="h-full" config={PAGE_SCROLLBAR}>
      <div className="mx-auto max-w-4xl px-8 py-10">
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
    </CustomScrollbar>
  );
}
