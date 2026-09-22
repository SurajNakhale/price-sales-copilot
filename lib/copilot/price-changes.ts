import { earliestInvoiceDate, latestInvoiceDate, lineRevenue } from "@/lib/analytics";
import { formatMoney } from "@/lib/format";
import type { PriceChangeItem, PriceReview } from "@/lib/types";

import { resolveFilters } from "./filters";
import { inPeriod, resolvePeriod } from "./period";
import { COPILOT_MAX_ROWS, type CopilotData, type Filters, type PeriodInput, ToolArgumentError } from "./types";

/**
 * The price-change tool: which prices the approved supplier price lists
 * changed, old to new, read from Feature 2's reviews (.data/reviews/). Only
 * items applied to the current price list count; lists still waiting for
 * review are named but not counted. Optionally adds each changed product's
 * units and revenue in a sales period, joined by Product ID. Pure.
 *
 * This is not the audit log of open decision 6: a re-analysed list replaces
 * its review, and nothing records who approved.
 */

export const PRICE_CHANGES_DEFAULT_LIMIT = 20;

export type ChangeDirection = "increase" | "decrease";

export interface PriceChangesArgs {
  direction?: ChangeDirection | "any";
  filters?: Pick<Filters, "brands" | "categories" | "models">;
  salesPeriod?: PeriodInput;
  limit?: number;
}

export interface PriceChangeRow {
  productId: string;
  model: string;
  brand: string;
  category: string | null;
  oldDealerPrice: number;
  newDealerPrice: number;
  oldDealerPriceText: string;
  newDealerPriceText: string;
  /** New minus old, in percent of old, one decimal. 0 when the dealer price did not change. */
  dealerPriceChangePct: number;
  oldMrp: number;
  newMrp: number;
  oldMrpText: string;
  newMrpText: string;
  mrpChangePct: number;
  /** Judged on the dealer price; on the MRP when only the MRP changed. */
  direction: ChangeDirection | null;
  /** The supplier file whose approval applied this change. */
  list: string;
  /** YYYY-MM-DD. */
  approvedOn: string;
  units?: number;
  revenue?: number;
  revenueText?: string;
}

export interface PriceChangesResult {
  tool: "lookup_price_changes";
  source: "approved supplier price lists";
  direction: ChangeDirection | "any";
  filters: string[];
  approvedLists: { file: string; brand: string | null; approvedOn: string; appliedPriceChanges: number }[];
  /** Applied price changes across the approved lists, before the direction and filters. */
  appliedPriceChanges: number;
  /** The same, split by direction, so "none went down" can be read off without another query. */
  appliedByDirection: { increase: number; decrease: number };
  matched: number;
  shown: number;
  rows: PriceChangeRow[];
  salesPeriod: { from: string; to: string; label: string; reading?: string; days: number } | null;
  /** Analysed but not approved: not counted, but named so the answer can say so. */
  waitingForReview: { file: string; brand: string | null; priceChanges: number }[];
  notes: string[];
  caveats: string[];
}

function pct(from: number, to: number): number {
  return from === 0 ? 0 : Math.round(((to - from) / from) * 1000) / 10;
}

function directionOf(item: PriceChangeItem): ChangeDirection | null {
  const dealer = item.new.dealerPrice - item.old.dealerPrice;
  const mrp = item.new.mrp - item.old.mrp;
  const basis = dealer !== 0 ? dealer : mrp;
  return basis > 0 ? "increase" : basis < 0 ? "decrease" : null;
}

/** The percentage the direction was judged on, for ordering rows. */
function basisPct(row: PriceChangeRow): number {
  return row.dealerPriceChangePct !== 0 ? row.dealerPriceChangePct : row.mrpChangePct;
}

export function lookupPriceChanges(data: CopilotData, args: PriceChangesArgs): PriceChangesResult {
  const direction = args.direction ?? "any";
  const reviews: PriceReview[] = data.reviews ?? [];
  const filters = resolveFilters(
    { brands: args.filters?.brands, categories: args.filters?.categories, models: args.filters?.models },
    data,
  );
  const byId = new Map(data.products.map((product) => [product.productId, product]));

  const approved = reviews
    .filter((review) => review.status === "approved")
    .sort((a, b) => (a.approvedAt ?? "").localeCompare(b.approvedAt ?? "") || a.sourceFile.localeCompare(b.sourceFile));

  const all: PriceChangeRow[] = [];
  const approvedLists: PriceChangesResult["approvedLists"] = [];
  for (const review of approved) {
    const applied = new Set(review.applied ?? []);
    const approvedOn = (review.approvedAt ?? review.analysedAt).slice(0, 10);
    const items = review.items.filter(
      (item): item is PriceChangeItem => item.kind === "price-change" && applied.has(item.itemId),
    );
    approvedLists.push({ file: review.sourceFile, brand: review.brand, approvedOn, appliedPriceChanges: items.length });
    for (const item of items) {
      all.push({
        productId: item.productId,
        model: item.model,
        brand: item.brand,
        category: byId.get(item.productId)?.category ?? item.fileCategory ?? null,
        oldDealerPrice: item.old.dealerPrice,
        newDealerPrice: item.new.dealerPrice,
        oldDealerPriceText: formatMoney(item.old.dealerPrice),
        newDealerPriceText: formatMoney(item.new.dealerPrice),
        dealerPriceChangePct: pct(item.old.dealerPrice, item.new.dealerPrice),
        oldMrp: item.old.mrp,
        newMrp: item.new.mrp,
        oldMrpText: formatMoney(item.old.mrp),
        newMrpText: formatMoney(item.new.mrp),
        mrpChangePct: pct(item.old.mrp, item.new.mrp),
        direction: directionOf(item),
        list: review.sourceFile,
        approvedOn,
      });
    }
  }

  const matching = all
    .filter((row) => direction === "any" || row.direction === direction)
    .filter((row) => !filters.productIds || filters.productIds.has(row.productId))
    .sort((a, b) => {
      const order =
        direction === "decrease"
          ? basisPct(a) - basisPct(b)
          : direction === "increase"
            ? basisPct(b) - basisPct(a)
            : Math.abs(basisPct(b)) - Math.abs(basisPct(a));
      return order || a.model.localeCompare(b.model) || a.approvedOn.localeCompare(b.approvedOn);
    });

  const rows = matching.slice(0, args.limit ?? PRICE_CHANGES_DEFAULT_LIMIT).slice(0, COPILOT_MAX_ROWS);

  let salesPeriod: PriceChangesResult["salesPeriod"] = null;
  const caveats: string[] = [];
  if (args.salesPeriod) {
    const today = latestInvoiceDate(data.sales);
    const dataStart = earliestInvoiceDate(data.sales);
    if (today === null || dataStart === null) {
      throw new ToolArgumentError("There are no sales in the data at all, so units sold cannot be added.");
    }
    const period = resolvePeriod(args.salesPeriod, today, dataStart);
    salesPeriod = {
      from: period.from,
      to: period.to,
      label: period.label,
      ...(period.reading ? { reading: period.reading } : {}),
      days: period.days,
    };
    caveats.push(...period.caveats);
    const inWindow = data.sales.filter((line) => inPeriod(line.date, period));
    for (const row of rows) {
      const lines = inWindow.filter((line) => line.productId === row.productId);
      row.units = lines.reduce((sum, line) => sum + line.quantity, 0);
      row.revenue = lines.reduce((sum, line) => sum + lineRevenue(line), 0);
      row.revenueText = formatMoney(row.revenue);
    }
  }

  const waitingForReview = reviews
    .filter((review) => review.status === "needs-review")
    .map((review) => ({
      file: review.sourceFile,
      brand: review.brand,
      priceChanges: review.items.filter((item) => item.kind === "price-change").length,
    }))
    .sort((a, b) => a.file.localeCompare(b.file));

  const notes = [...filters.notes];
  if (approved.length === 0) notes.push("No supplier price list has been approved yet, so no price has changed.");

  const applied = [...filters.applied];
  if (direction !== "any") applied.unshift(`the price went ${direction === "decrease" ? "down" : "up"}`);

  return {
    tool: "lookup_price_changes",
    source: "approved supplier price lists",
    direction,
    filters: applied,
    approvedLists,
    appliedPriceChanges: all.length,
    appliedByDirection: {
      increase: all.filter((row) => row.direction === "increase").length,
      decrease: all.filter((row) => row.direction === "decrease").length,
    },
    matched: matching.length,
    shown: rows.length,
    rows,
    salesPeriod,
    waitingForReview,
    notes,
    caveats,
  };
}
