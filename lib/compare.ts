import { createMatchingKey } from "./matching-key";
import type {
  NormalizedPriceList,
  OutdatedItem,
  PriceReview,
  Product,
  ReviewItem,
} from "./types";

/**
 * The deterministic half of Feature 2. It reads the normalised file and the
 * current price list and nothing else, and no LLM is involved. Pure.
 */

export interface Comparison {
  items: ReviewItem[];
  unchanged: number;
}

export function comparePriceList(normalized: NormalizedPriceList, products: Product[]): Comparison {
  const byId = new Map(products.map((product) => [product.productId, product]));
  const priceChanges: ReviewItem[] = [];
  const newProducts: ReviewItem[] = [];
  const seen = new Set<string>();
  let unchanged = 0;

  for (const row of normalized.rows) {
    seen.add(row.productId);
    const current = row.match === "new" ? undefined : byId.get(row.productId);

    if (!current || current.status) {
      newProducts.push({
        kind: "new-product",
        itemId: `new-product:${row.productId}`,
        productId: row.productId,
        brand: row.brand,
        model: current ? current.model : row.model,
        category: current ? current.category : row.category,
        dealerPrice: row.dealerPrice,
        mrp: row.mrp,
        reactivates: Boolean(current),
      });
      continue;
    }

    if (current.dealerPrice === row.dealerPrice && current.mrp === row.mrp) {
      unchanged++;
      continue;
    }

    priceChanges.push({
      kind: "price-change",
      itemId: `price-change:${row.productId}`,
      productId: row.productId,
      brand: row.brand,
      model: current.model,
      supplierModel: row.supplierModel,
      match: row.match,
      old: { dealerPrice: current.dealerPrice, mrp: current.mrp },
      new: { dealerPrice: row.dealerPrice, mrp: row.mrp },
      ...(row.fileCategory ? { fileCategory: row.fileCategory } : {}),
    });
  }

  // Missing: active products of this file's brand that no row matched.
  const missing: ReviewItem[] = products
    .filter(
      (product) =>
        product.brand === normalized.brand && !product.status && !seen.has(product.productId),
    )
    .map((product) => ({
      kind: "missing",
      itemId: `missing:${product.productId}`,
      productId: product.productId,
      brand: product.brand,
      model: product.model,
      category: product.category,
      dealerPrice: product.dealerPrice,
      mrp: product.mrp,
    }));

  return { items: [...priceChanges, ...newProducts, ...missing], unchanged };
}

/**
 * Items whose premise no longer holds against the current price list: another
 * approval changed a price, added the product or deactivated it. Approval
 * refuses to write anything while one of the selected items is outdated, and
 * the review page runs the same check to warn before anyone clicks.
 */
export function findOutdatedItems(items: ReviewItem[], products: Product[]): OutdatedItem[] {
  const byId = new Map(products.map((product) => [product.productId, product]));
  const activeKeys = new Set(
    products
      .filter((product) => !product.status)
      .map((product) => createMatchingKey(product.brand, product.model)),
  );
  const outdated: OutdatedItem[] = [];

  for (const item of items) {
    const current = byId.get(item.productId);

    if (item.kind === "price-change") {
      if (!current) {
        outdated.push({ itemId: item.itemId, reason: `${item.model} is no longer in the price list.` });
      } else if (current.status) {
        outdated.push({ itemId: item.itemId, reason: `${item.model} has been deactivated since.` });
      } else if (current.dealerPrice !== item.old.dealerPrice || current.mrp !== item.old.mrp) {
        outdated.push({
          itemId: item.itemId,
          reason: `${item.model} has been repriced since this file was analysed.`,
        });
      }
    } else if (item.kind === "new-product") {
      if (item.reactivates) {
        if (!current || !current.status) {
          outdated.push({ itemId: item.itemId, reason: `${item.model} is already active again.` });
        }
      } else if (current || activeKeys.has(createMatchingKey(item.brand, item.model))) {
        outdated.push({ itemId: item.itemId, reason: `${item.model} has been added since.` });
      }
    } else if (!current || current.status) {
      outdated.push({ itemId: item.itemId, reason: `${item.model} has been deactivated since.` });
    }
  }

  return outdated;
}

export interface ReviewCounts {
  priceChanges: number;
  newProducts: number;
  missing: number;
}

export function countItems(items: ReviewItem[]): ReviewCounts {
  return {
    priceChanges: items.filter((item) => item.kind === "price-change").length,
    newProducts: items.filter((item) => item.kind === "new-product").length,
    missing: items.filter((item) => item.kind === "missing").length,
  };
}

/** "3 price · 1 new · 1 missing", leaving out the parts that are zero. */
export function describeCounts(counts: ReviewCounts): string {
  const parts = [
    counts.priceChanges ? `${counts.priceChanges} price` : null,
    counts.newProducts ? `${counts.newProducts} new` : null,
    counts.missing ? `${counts.missing} missing` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "No changes";
}

export interface ReviewTotals {
  /** Files analysed successfully, whatever their status since. */
  analysedFiles: number;
  /** Price changes found across every analysed file. */
  priceChanges: number;
  /** Items in files still waiting on a decision. */
  needsReview: ReviewCounts & { total: number };
}

/** Dashboard and sidebar figures. Null until a file has been analysed, so they show — not 0. */
export function summarizeReviews(reviews: PriceReview[]): ReviewTotals | null {
  const analysed = reviews.filter((review) => review.status !== "failed");
  if (analysed.length === 0) return null;

  const waiting = countItems(
    analysed.filter((review) => review.status === "needs-review").flatMap((review) => review.items),
  );

  return {
    analysedFiles: analysed.length,
    priceChanges: analysed.reduce((sum, review) => sum + countItems(review.items).priceChanges, 0),
    needsReview: {
      ...waiting,
      total: waiting.priceChanges + waiting.newProducts + waiting.missing,
    },
  };
}
