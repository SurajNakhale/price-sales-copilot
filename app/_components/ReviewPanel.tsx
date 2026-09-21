"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { CircleCheck, RefreshCw, TriangleAlert } from "lucide-react";

import { requestAnalysis } from "@/app/_components/AnalyseCard";
import {
  MissingProductsTable,
  NewProductsTable,
  PriceChangesTable,
} from "@/app/_components/ReviewTables";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ProductSales } from "@/lib/analytics";
import { formatDate, formatNumber } from "@/lib/format";
import type {
  ApiError,
  MissingItem,
  NewProductItem,
  OutdatedItem,
  PriceChangeItem,
  PriceReview,
  RowIssue,
} from "@/lib/types";

function plural(count: number, one: string, many = `${one}s`): string {
  return `${formatNumber(count)} ${count === 1 ? one : many}`;
}

/**
 * Workflow step 3, Review & approve (context/ui-design.md §2.5).
 *
 * Approvals arrive unticked, since writing a price is not undoable the way a
 * download is, and there is one commit for everything selected across the
 * three tabs. Missing products default to Keep. Nothing is written until
 * Approve is pressed.
 */
export function ReviewPanel({
  review,
  issues,
  evidence,
  outdated,
}: {
  review: PriceReview;
  issues: RowIssue[];
  evidence: Record<string, ProductSales>;
  outdated: OutdatedItem[];
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deactivate, setDeactivate] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<"approving" | "analysing" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const priceChanges = review.items.filter((item): item is PriceChangeItem => item.kind === "price-change");
  const newProducts = review.items.filter((item): item is NewProductItem => item.kind === "new-product");
  const missing = review.items.filter((item): item is MissingItem => item.kind === "missing");

  const approved = review.status === "approved";
  const editable = review.status === "needs-review";
  const blocked = outdated.length > 0;
  const applied = new Set(review.applied ?? []);

  const chosen = [...selected, ...deactivate];
  const chosenPrices = priceChanges.filter((item) => selected.has(item.itemId)).length;
  const chosenNew = newProducts.filter((item) => selected.has(item.itemId)).length;

  function toggle(itemId: string, checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(itemId);
      else next.delete(itemId);
      return next;
    });
  }

  function toggleAll(items: { itemId: string }[], checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      for (const item of items) {
        if (checked) next.add(item.itemId);
        else next.delete(item.itemId);
      }
      return next;
    });
  }

  function decide(itemId: string, off: boolean) {
    setDeactivate((current) => {
      const next = new Set(current);
      if (off) next.add(itemId);
      else next.delete(itemId);
      return next;
    });
  }

  async function approve() {
    setBusy("approving");
    setError(null);
    try {
      const response = await fetch(`/api/prices/${review.fileId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemIds: chosen }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as ApiError | null;
        setError(body?.message ?? `Request failed (${response.status}).`);
        setBusy(null);
        // A conflict means the price list moved on; the refreshed page shows which items.
        if (response.status === 409) router.refresh();
        return;
      }
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(null);
    }
  }

  async function reanalyse() {
    setBusy("analysing");
    setError(null);
    const problem = await requestAnalysis(review.fileId);
    if (problem) setError(problem);
    setSelected(new Set());
    setDeactivate(new Set());
    setBusy(null);
    router.refresh();
  }

  const selectProps = editable
    ? { selected, disabled: busy !== null || blocked, onToggle: toggle }
    : { applied };

  return (
    <div className="flex flex-col gap-3.5">
      {/* Summary strip */}
      <Card size="sm">
        <CardContent className="flex flex-wrap items-center gap-x-8 gap-y-3">
          <Stat label="Rows in file" value={formatNumber(review.rowsInFile)} />
          <Stat label="Changes" value={formatNumber(review.items.length)} />
          <Stat label="Unchanged" value={formatNumber(review.unchanged)} />
          {review.issues > 0 ? <Stat label="Skipped rows" value={formatNumber(review.issues)} /> : null}
          <p className="min-w-[16rem] flex-1 text-xs text-ink-2">
            Prices are copied from the file&apos;s cells by the app; the LLM only mapped this
            supplier&apos;s column names and suggested matches for renamed models, each checked
            by the app.
          </p>
          {!approved ? (
            <Button variant="outline" size="sm" onClick={reanalyse} disabled={busy !== null}>
              <RefreshCw />
              {busy === "analysing" ? "Analysing…" : "Re-analyse"}
            </Button>
          ) : null}
        </CardContent>
      </Card>

      {approved ? (
        <Alert>
          <CircleCheck />
          <AlertTitle>
            Approved {review.approvedAt ? formatDate(review.approvedAt) : ""}:{" "}
            {formatNumber(applied.size)} of {formatNumber(review.items.length)} applied
          </AlertTitle>
          <AlertDescription>
            {describeApplied(review, applied)} Affected dealers and the draft email (steps 4–5)
            belong to Feature 3, which is not built yet.
          </AlertDescription>
        </Alert>
      ) : null}

      {review.status === "no-changes" ? (
        <Alert>
          <CircleCheck />
          <AlertTitle>No changes</AlertTitle>
          <AlertDescription>
            Every product in this file already has these prices, and no active product of this
            brand is missing from it. There is nothing to approve.
          </AlertDescription>
        </Alert>
      ) : null}

      {editable && blocked ? (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>The current price list changed after this file was analysed</AlertTitle>
          <AlertDescription>
            {outdated.map((item) => item.reason).join(" ")} Analyse the file again to compare it
            with the price list as it is now.
          </AlertDescription>
          <AlertAction>
            <Button size="sm" onClick={reanalyse} disabled={busy !== null}>
              {busy === "analysing" ? "Analysing…" : "Re-analyse"}
            </Button>
          </AlertAction>
        </Alert>
      ) : null}

      {error ? (
        <Alert variant="destructive">
          <AlertTitle>That did not work</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {issues.length > 0 ? (
        <Alert>
          <TriangleAlert />
          <AlertTitle>{plural(issues.length, "row was", "rows were")} skipped</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-4">
              {issues.map((issue) => (
                <li key={issue.rowNumber}>
                  Row {issue.rowNumber}: {issue.reason}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardContent>
          <Tabs defaultValue={priceChanges.length > 0 ? "prices" : newProducts.length > 0 ? "new" : "missing"}>
            <TabsList>
              <TabsTrigger value="prices">Price changes ({priceChanges.length})</TabsTrigger>
              <TabsTrigger value="new">New products ({newProducts.length})</TabsTrigger>
              <TabsTrigger value="missing">Missing products ({missing.length})</TabsTrigger>
            </TabsList>

            <TabsContent value="prices" className="pt-2">
              <PriceChangesTable
                items={priceChanges}
                {...selectProps}
                onToggleAll={(checked) => toggleAll(priceChanges, checked)}
              />
            </TabsContent>

            <TabsContent value="new" className="pt-2">
              <NewProductsTable
                items={newProducts}
                {...selectProps}
                onToggleAll={(checked) => toggleAll(newProducts, checked)}
              />
            </TabsContent>

            <TabsContent value="missing" className="space-y-2 pt-2">
              <p className="max-w-3xl text-xs text-ink-2">
                Nothing is deleted. Keep changes nothing; Deactivate marks the product{" "}
                <code className="font-mono">status: &quot;discontinued&quot;</code> so it leaves the
                catalogue while its sales history still resolves.
              </p>
              <MissingProductsTable
                items={missing}
                evidence={evidence}
                {...(editable
                  ? { deactivate, disabled: busy !== null || blocked, onDecide: decide }
                  : { applied })}
              />
            </TabsContent>
          </Tabs>
        </CardContent>

        {editable ? (
          <CardFooter className="justify-between gap-3 border-t py-3">
            <span className="text-sm text-muted-foreground">
              {chosen.length === 0
                ? "Nothing selected yet"
                : [
                    chosenPrices ? plural(chosenPrices, "price change") : null,
                    chosenNew ? plural(chosenNew, "new product") : null,
                    deactivate.size ? plural(deactivate.size, "deactivation") : null,
                  ]
                    .filter(Boolean)
                    .join(" · ") + " selected"}
            </span>
            <Button size="lg" onClick={approve} disabled={chosen.length === 0 || busy !== null || blocked}>
              {busy === "approving"
                ? "Approving…"
                : chosen.length === 0
                  ? "Approve changes"
                  : `Approve ${plural(chosen.length, "change")}`}
            </Button>
          </CardFooter>
        ) : null}
      </Card>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{label}</p>
      <p className="font-heading text-xl leading-tight tabular-nums">{value}</p>
    </div>
  );
}

/** What the approval did, in product terms. */
function describeApplied(review: PriceReview, applied: ReadonlySet<string>): string {
  const done = review.items.filter((item) => applied.has(item.itemId));
  const prices = done.filter((item) => item.kind === "price-change").length;
  const added = done.filter((item) => item.kind === "new-product").length;
  const off = done.filter((item) => item.kind === "missing").length;
  const parts = [
    prices ? `${plural(prices, "price")} updated` : null,
    added ? `${plural(added, "product")} added` : null,
    off ? `${plural(off, "product")} deactivated` : null,
  ].filter(Boolean);
  return parts.length > 0 ? `${parts.join(", ")} in the current price list.` : "";
}
