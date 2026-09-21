import { salesByProduct } from "@/lib/analytics";
import { formatMoney } from "@/lib/format";

import { resolveFilters } from "./filters";
import { COPILOT_MAX_ROWS, type CopilotData, type Filters } from "./types";

/**
 * The product tool: prices, margin and status from the current price list,
 * with units sold from the sales file. Pure.
 */

export interface LookupProductsArgs {
  filters?: Pick<Filters, "brands" | "categories" | "models">;
  status?: "active" | "discontinued" | "any";
}

export interface ProductRow {
  productId: string;
  brand: string;
  model: string;
  category: string;
  dealerPrice: number;
  dealerPriceText: string;
  mrp: number;
  mrpText: string;
  /** MRP minus dealer price. */
  marginText: string;
  /** Margin as a share of MRP, in percent. */
  marginPct: number;
  status: "active" | "discontinued";
  discontinuedOn: string | null;
  unitsSold: number;
  lastSold: string | null;
}

export interface LookupProductsResult {
  tool: "lookup_products";
  /** Prices are as they stand now; there is no price history. */
  asOf: "the current price list";
  filters: string[];
  matched: number;
  shown: number;
  rows: ProductRow[];
  notes: string[];
}

export function lookupProducts(data: CopilotData, args: LookupProductsArgs): LookupProductsResult {
  const filters = resolveFilters(
    { brands: args.filters?.brands, categories: args.filters?.categories, models: args.filters?.models },
    data,
  );
  const status = args.status ?? "any";
  const sold = salesByProduct(data.sales);

  const matches = data.products
    .filter((product) => !filters.productIds || filters.productIds.has(product.productId))
    .filter((product) =>
      status === "any" ? true : status === "discontinued" ? Boolean(product.status) : !product.status,
    )
    .sort((a, b) => a.brand.localeCompare(b.brand) || a.model.localeCompare(b.model));

  const rows = matches.slice(0, COPILOT_MAX_ROWS).map(
    (product): ProductRow => ({
      productId: product.productId,
      brand: product.brand,
      model: product.model,
      category: product.category,
      dealerPrice: product.dealerPrice,
      dealerPriceText: formatMoney(product.dealerPrice),
      mrp: product.mrp,
      mrpText: formatMoney(product.mrp),
      marginText: formatMoney(product.mrp - product.dealerPrice),
      marginPct:
        product.mrp === 0 ? 0 : Math.round(((product.mrp - product.dealerPrice) / product.mrp) * 1000) / 10,
      status: product.status ? "discontinued" : "active",
      discontinuedOn: product.discontinuedOn ?? null,
      unitsSold: sold[product.productId]?.units ?? 0,
      lastSold: sold[product.productId]?.lastSold ?? null,
    }),
  );

  const applied = [...filters.applied];
  if (status !== "any") applied.push(`status is ${status}`);

  return {
    tool: "lookup_products",
    asOf: "the current price list",
    filters: applied,
    matched: matches.length,
    shown: rows.length,
    rows,
    notes: filters.notes,
  };
}
