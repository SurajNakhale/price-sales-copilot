"use client";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ProductSales } from "@/lib/analytics";
import { EM_DASH, formatDate, formatMoney, formatNumber } from "@/lib/format";
import type { MissingItem, NewProductItem, PriceChangeItem } from "@/lib/types";

/**
 * The three tables of workflow step 3 (context/ui-design.md §2.5). Selection
 * state lives in ReviewPanel; `selected === undefined` means read-only, after
 * approval, where each row says whether it was applied.
 */

interface Selectable {
  selected?: ReadonlySet<string>;
  applied?: ReadonlySet<string>;
  disabled?: boolean;
  onToggle?: (itemId: string, checked: boolean) => void;
  onToggleAll?: (checked: boolean) => void;
}

function SelectHeader({ items, selected, disabled, onToggleAll }: Selectable & { items: { itemId: string }[] }) {
  if (!selected) return <TableHead>Applied</TableHead>;
  const count = items.filter((item) => selected.has(item.itemId)).length;
  return (
    <TableHead className="w-10">
      <Checkbox
        aria-label="Select all"
        checked={items.length > 0 && count === items.length}
        indeterminate={count > 0 && count < items.length}
        disabled={disabled || items.length === 0}
        onCheckedChange={(checked) => onToggleAll?.(checked)}
      />
    </TableHead>
  );
}

function SelectCell({
  itemId,
  label,
  selected,
  applied,
  disabled,
  onToggle,
}: Selectable & { itemId: string; label: string }) {
  if (!selected) {
    return (
      <TableCell>
        <AppliedMark applied={applied?.has(itemId) ?? false} />
      </TableCell>
    );
  }
  return (
    <TableCell>
      <Checkbox
        aria-label={`Select ${label}`}
        checked={selected.has(itemId)}
        disabled={disabled}
        onCheckedChange={(checked) => onToggle?.(itemId, checked)}
      />
    </TableCell>
  );
}

function AppliedMark({ applied, yes = "Applied", no = "Not applied" }: { applied: boolean; yes?: string; no?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs whitespace-nowrap">
      <span
        aria-hidden
        className="size-1.5 rounded-full"
        style={{ backgroundColor: applied ? "var(--status-ok)" : "var(--status-neutral)" }}
      />
      {applied ? yes : no}
    </span>
  );
}

/** ↑ 7.1% in red (a supplier price rise is a cost rise), ↓ 3.5% in green. Arrow and colour, never colour alone. */
function Delta({ from, to, label }: { from: number; to: number; label?: string }) {
  const change = ((to - from) / from) * 100;
  const up = change > 0;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium tabular-nums whitespace-nowrap ${
        up ? "bg-rise-bg text-rise" : "bg-fall-bg text-fall"
      }`}
    >
      {label ? <span className="font-normal">{label}</span> : null}
      {up ? "↑" : "↓"} {Math.abs(change).toFixed(1)}%
    </span>
  );
}

function OldToNew({ from, to }: { from: number; to: number }) {
  if (from === to) return <span className="text-muted-foreground">{formatMoney(to)}</span>;
  return (
    <span className="whitespace-nowrap">
      <span className="text-muted-foreground">{formatMoney(from)}</span>
      <span className="px-1 text-muted-foreground">→</span>
      <span className="font-medium">{formatMoney(to)}</span>
    </span>
  );
}

function matchNote(item: PriceChangeItem): string | null {
  const notes: string[] = [];
  if (item.supplierModel !== item.model) {
    notes.push(
      item.match === "llm"
        ? `Supplier wrote "${item.supplierModel}" · matched by the LLM, checked by the app`
        : `Supplier wrote "${item.supplierModel}" · matched by name`,
    );
  }
  if (item.fileCategory) notes.push(`File says category "${item.fileCategory}", not applied`);
  return notes.length > 0 ? notes.join(" · ") : null;
}

function Empty({ columns, children }: { columns: number; children: React.ReactNode }) {
  return (
    <TableRow>
      <TableCell colSpan={columns} className="py-6 text-center text-muted-foreground">
        {children}
      </TableCell>
    </TableRow>
  );
}

export function PriceChangesTable({ items, ...select }: Selectable & { items: PriceChangeItem[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <SelectHeader items={items} {...select} />
          <TableHead>Product</TableHead>
          <TableHead>Product ID</TableHead>
          <TableHead data-numeric>Dealer price</TableHead>
          <TableHead data-numeric>MRP</TableHead>
          <TableHead data-numeric>Change</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.length === 0 ? <Empty columns={6}>No price changes in this file.</Empty> : null}
        {items.map((item) => {
          const note = matchNote(item);
          const dealerChanged = item.old.dealerPrice !== item.new.dealerPrice;
          return (
            <TableRow key={item.itemId}>
              <SelectCell itemId={item.itemId} label={item.model} {...select} />
              <TableCell className="whitespace-normal">
                <p className="font-medium">{item.model}</p>
                {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
              </TableCell>
              <TableCell className="font-mono text-xs">{item.productId}</TableCell>
              <TableCell data-numeric>
                <OldToNew from={item.old.dealerPrice} to={item.new.dealerPrice} />
              </TableCell>
              <TableCell data-numeric>
                <OldToNew from={item.old.mrp} to={item.new.mrp} />
              </TableCell>
              <TableCell data-numeric>
                {dealerChanged ? (
                  <Delta from={item.old.dealerPrice} to={item.new.dealerPrice} />
                ) : (
                  <Delta from={item.old.mrp} to={item.new.mrp} label="MRP" />
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

export function NewProductsTable({ items, ...select }: Selectable & { items: NewProductItem[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <SelectHeader items={items} {...select} />
          <TableHead>Product ID</TableHead>
          <TableHead>Model</TableHead>
          <TableHead>Category</TableHead>
          <TableHead data-numeric>Dealer price</TableHead>
          <TableHead data-numeric>MRP</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.length === 0 ? <Empty columns={6}>No new products in this file.</Empty> : null}
        {items.map((item) => (
          <TableRow key={item.itemId}>
            <SelectCell itemId={item.itemId} label={item.model} {...select} />
            <TableCell className="whitespace-normal">
              <p className="font-mono text-xs">{item.productId}</p>
              <p className="text-xs text-muted-foreground">
                {item.reactivates
                  ? "Its existing ID: this product was discontinued, adding it reactivates it"
                  : "Generated from brand + model, like every other ID"}
              </p>
            </TableCell>
            <TableCell className="font-medium">{item.model}</TableCell>
            <TableCell>{item.category || EM_DASH}</TableCell>
            <TableCell data-numeric>{formatMoney(item.dealerPrice)}</TableCell>
            <TableCell data-numeric>{formatMoney(item.mrp)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function MissingProductsTable({
  items,
  evidence,
  deactivate,
  applied,
  disabled,
  onDecide,
}: {
  items: MissingItem[];
  evidence: Record<string, ProductSales>;
  /** Undefined after approval: rows then say what was done. */
  deactivate?: ReadonlySet<string>;
  applied?: ReadonlySet<string>;
  disabled?: boolean;
  onDecide?: (itemId: string, deactivate: boolean) => void;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Product ID</TableHead>
          <TableHead>Model</TableHead>
          <TableHead>Category</TableHead>
          <TableHead data-numeric>Dealer price</TableHead>
          <TableHead>Last sold</TableHead>
          <TableHead data-numeric>Units sold</TableHead>
          <TableHead>Decision</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.length === 0 ? (
          <Empty columns={7}>Every active product of this brand is in the file.</Empty>
        ) : null}
        {items.map((item) => {
          const sold = evidence[item.productId];
          const off = deactivate?.has(item.itemId) ?? false;
          return (
            <TableRow key={item.itemId}>
              <TableCell className="font-mono text-xs">{item.productId}</TableCell>
              <TableCell className="font-medium">{item.model}</TableCell>
              <TableCell>{item.category || EM_DASH}</TableCell>
              <TableCell data-numeric>{formatMoney(item.dealerPrice)}</TableCell>
              <TableCell>{sold?.lastSold ? formatDate(sold.lastSold) : "Never sold"}</TableCell>
              <TableCell data-numeric>{formatNumber(sold?.units ?? 0)}</TableCell>
              <TableCell>
                {deactivate ? (
                  // Styled like the tab list: the chosen option is the raised one.
                  <div
                    className="inline-flex rounded-lg bg-muted p-[3px]"
                    role="group"
                    aria-label={`Decision for ${item.model}`}
                  >
                    {[
                      { label: "Keep", value: false },
                      { label: "Deactivate", value: true },
                    ].map((option) => (
                      <Button
                        key={option.label}
                        size="xs"
                        variant="ghost"
                        aria-pressed={off === option.value}
                        disabled={disabled}
                        onClick={() => onDecide?.(item.itemId, option.value)}
                        className={
                          off === option.value
                            ? "bg-background text-foreground shadow-sm hover:bg-background"
                            : "text-foreground/60 hover:bg-transparent hover:text-foreground"
                        }
                      >
                        {option.label}
                      </Button>
                    ))}
                  </div>
                ) : (
                  <AppliedMark applied={applied?.has(item.itemId) ?? false} yes="Deactivated" no="Kept" />
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
