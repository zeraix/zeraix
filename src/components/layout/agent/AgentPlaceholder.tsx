import type { LucideIcon } from "lucide-react";

/**
 * 次级页面通用脚手架：标题 + 描述 + 空状态卡片。
 * 供 技能 / 自动化 / 模型库 等尚未填充内容的页面复用，保持视觉一致。
 */
export default function AgentPlaceholder({
  icon: Icon,
  title,
  description,
  emptyText = "暂无内容",
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  emptyText?: string;
}) {
  return (
    <div className="mx-auto max-w-4xl px-8 py-10">
      <div className="flex items-center gap-3">
        <span className="flex size-9 items-center justify-center rounded-lg bg-accent text-foreground">
          <Icon className="size-5" />
        </span>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">{title}</h1>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">{description}</p>

      <div className="mt-8 flex h-64 flex-col items-center justify-center rounded-2xl border border-dashed border-line text-center">
        <Icon className="size-8 text-muted-foreground/60" />
        <p className="mt-3 text-sm text-muted-foreground">{emptyText}</p>
      </div>
    </div>
  );
}
