import { Badge } from "@/components/ui/badge";
import type { ReviewStatus } from "@/lib/types";

/**
 * Every status a price list can show. `downloaded` means not analysed yet;
 * `analysing` exists only while the request is running in this browser.
 */
export type PriceListState = ReviewStatus | "downloaded" | "analysing";

// context/ui-design.md section 5: status always pairs a dot with a word.
const STATES: Record<PriceListState, { label: string; color: string }> = {
  downloaded: { label: "Downloaded", color: "var(--status-neutral)" },
  analysing: { label: "Analysing", color: "var(--status-info)" },
  "needs-review": { label: "Needs review", color: "var(--status-warn)" },
  approved: { label: "Approved", color: "var(--status-ok)" },
  "no-changes": { label: "No changes", color: "var(--status-neutral)" },
  failed: { label: "Failed", color: "var(--status-bad)" },
};

export function PriceListStatus({ state }: { state: PriceListState }) {
  const { label, color } = STATES[state];
  return (
    <Badge variant="outline" className="gap-1.5 font-normal">
      <span aria-hidden className="size-1.5 rounded-full" style={{ backgroundColor: color }} />
      {label}
    </Badge>
  );
}
