import "server-only";

import { findOutdatedItems } from "@/lib/compare";
import { readProducts, writeProducts } from "@/lib/data/mock-data";
import { BadRequestError, ConflictError, NotFoundError } from "@/lib/errors";
import { readReview, writeReview } from "@/lib/storage/price-reviews";
import type { PriceReview, Product } from "@/lib/types";

/**
 * Feature 2, step 3: writes the items the user approved, and only those, to
 * the current price list in one atomic write.
 *
 * All or nothing. If any selected item no longer matches the current price
 * list, because another file's approval got there first, nothing is written
 * and the file has to be analysed again. A review is approved once; its
 * `applied` list is what Feature 3 reads.
 */
export async function approveReview(
  fileId: string,
  itemIds: string[],
  now: Date = new Date(),
): Promise<PriceReview> {
  const review = await readReview(fileId);
  if (!review) throw new NotFoundError("This price list has not been analysed yet.");
  if (review.status === "approved") throw new ConflictError("This price list has already been approved.");
  if (review.status !== "needs-review") {
    throw new ConflictError("This price list has nothing waiting for approval.");
  }

  const wanted = new Set(itemIds);
  if (wanted.size === 0) throw new BadRequestError("Select at least one change to approve.");
  const selected = review.items.filter((item) => wanted.has(item.itemId));
  if (selected.length !== wanted.size) {
    throw new BadRequestError("Some of the selected changes are not in this price list.");
  }

  const products = await readProducts();
  const outdated = findOutdatedItems(selected, products);
  if (outdated.length > 0) {
    throw new ConflictError(
      `The current price list changed after this file was analysed: ${outdated
        .map((item) => item.reason)
        .join(" ")} Analyse the file again, then approve.`,
    );
  }

  const today = now.toISOString().slice(0, 10);
  const byId = new Map(products.map((product) => [product.productId, product]));
  const added: Product[] = [];

  for (const item of selected) {
    const current = byId.get(item.productId);

    if (item.kind === "price-change" && current) {
      current.dealerPrice = item.new.dealerPrice;
      current.mrp = item.new.mrp;
    } else if (item.kind === "new-product" && item.reactivates && current) {
      delete current.status;
      delete current.discontinuedOn;
      current.dealerPrice = item.dealerPrice;
      current.mrp = item.mrp;
    } else if (item.kind === "new-product") {
      added.push({
        productId: item.productId,
        brand: item.brand,
        model: item.model,
        category: item.category,
        dealerPrice: item.dealerPrice,
        mrp: item.mrp,
      });
    } else if (item.kind === "missing" && current) {
      current.status = "discontinued";
      current.discontinuedOn = today;
    }
  }

  await writeProducts([...products, ...added]);

  const approved: PriceReview = {
    ...review,
    status: "approved",
    approvedAt: now.toISOString(),
    applied: selected.map((item) => item.itemId),
  };
  await writeReview(approved);
  return approved;
}
