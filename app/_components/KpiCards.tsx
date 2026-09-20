import { Card, CardContent } from "@/components/ui/card";
import { EM_DASH, formatDate, formatMoneyShort, formatNumber } from "@/lib/format";

export interface Kpi {
  label: string;
  value: string;
  /** What the number is, or what has to happen before there is one. */
  note: string;
  /** Draws attention: this one is waiting on a person. */
  attention?: boolean;
}

export function buildKpis(input: {
  revenue: number;
  units: number;
  invoices: number;
  productsSold: number;
  productsTotal: number;
  from: string | null;
  to: string | null;
  /** Null until Feature 2 has analysed a file. */
  priceChanges: number | null;
  needsReview: number | null;
}): Kpi[] {
  const period =
    input.from && input.to
      ? `${formatDate(input.from)} to ${formatDate(input.to)}`
      : "no sales recorded";

  return [
    {
      label: "Total revenue",
      value: formatMoneyShort(input.revenue),
      note: `${formatNumber(input.invoices)} invoices · ${period}`,
    },
    {
      label: "Units sold",
      value: formatNumber(input.units),
      note: `${input.productsSold} of ${input.productsTotal} products sold`,
    },
    {
      label: "Price changes",
      value: input.priceChanges === null ? EM_DASH : formatNumber(input.priceChanges),
      note:
        input.priceChanges === null
          ? "Detected in the latest batch, once a file is analysed"
          : "Detected in the latest analysed batch",
    },
    {
      label: "Needs review",
      value: input.needsReview === null ? EM_DASH : formatNumber(input.needsReview),
      note:
        input.needsReview === null
          ? "Items awaiting your decision. None yet"
          : "Items awaiting your decision",
      attention: (input.needsReview ?? 0) > 0,
    },
  ];
}

export function KpiCards({ items }: { items: Kpi[] }) {
  return (
    <section className="grid gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
      {items.map((item) => (
        <Card
          key={item.label}
          className={item.attention ? "ring-2 ring-[var(--status-warn)]" : undefined}
        >
          <CardContent className="space-y-1">
            <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              {item.label}
            </p>
            <p className="font-heading text-[28px] leading-none tabular-nums">
              {item.value}
            </p>
            <p className="text-xs text-muted-foreground">{item.note}</p>
          </CardContent>
        </Card>
      ))}
    </section>
  );
}
