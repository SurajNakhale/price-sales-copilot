import type { ReactNode } from "react";

import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";

/**
 * The 64px bar every page opens with: the title on the left, and whatever
 * the page's primary action is on the right.
 */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="flex h-16 shrink-0 items-center gap-3 border-b bg-background px-7">
      <SidebarTrigger className="-ml-1.5" />
      <Separator orientation="vertical" className="mr-1 !h-5" />
      <div className="min-w-0 flex-1">
        <h1 className="truncate font-heading text-[22px] leading-tight font-medium">
          {title}
        </h1>
        {description ? (
          <p className="truncate text-xs text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </header>
  );
}
