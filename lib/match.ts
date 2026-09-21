import type { LlmPort } from "./llm/port";
import { buildIdentityMap, createMatchingKey } from "./matching-key";
import { generateProductId } from "./product-id";
import type { Brand, MappedRow, NormalizedRow, Product } from "./types";

/**
 * Gives every mapped row a Product ID:
 *
 *   1. matching key → identity map built from the current list   (code)
 *   2. rows still unplaced → the LLM, with the brand's unclaimed products
 *   3. an LLM answer counts only if its ID is one of those candidates and no
 *      earlier row has taken it                                    (code)
 *   4. anything left is a new product with a generated ID          (code)
 *
 * Pure apart from the LLM port.
 */
export async function matchRows(
  brand: Brand,
  rows: MappedRow[],
  products: Product[],
  llm: LlmPort,
): Promise<NormalizedRow[]> {
  const byId = new Map(products.map((product) => [product.productId, product]));
  const identity = buildIdentityMap(products);

  const claimed = new Map<number, string>(); // rowNumber → productId
  const claimedIds = new Set<string>();

  for (const row of rows) {
    const productId = identity.get(createMatchingKey(brand, row.supplierModel));
    if (productId && !claimedIds.has(productId)) {
      claimed.set(row.rowNumber, productId);
      claimedIds.add(productId);
    }
  }

  const unplaced = rows.filter((row) => !claimed.has(row.rowNumber));
  const candidates = products.filter(
    (product) => product.brand === brand && !claimedIds.has(product.productId),
  );

  const byLlm = new Set<number>();
  if (unplaced.length > 0 && candidates.length > 0) {
    const proposals = await llm.proposeProductMatches({
      brand,
      rows: unplaced.map((row) => ({
        rowNumber: row.rowNumber,
        model: row.supplierModel,
        category: row.category,
      })),
      candidates: candidates.map(({ productId, model, category }) => ({ productId, model, category })),
    });

    const allowed = new Set(candidates.map((product) => product.productId));
    const unplacedRows = new Set(unplaced.map((row) => row.rowNumber));
    for (const proposal of [...proposals].sort((a, b) => a.rowNumber - b.rowNumber)) {
      const { rowNumber, productId } = proposal;
      if (productId === null || !unplacedRows.has(rowNumber) || claimed.has(rowNumber)) continue;
      if (!allowed.has(productId) || claimedIds.has(productId)) continue;
      claimed.set(rowNumber, productId);
      claimedIds.add(productId);
      byLlm.add(rowNumber);
    }
  }

  const takenIds = new Set(products.map((product) => product.productId));
  return rows.map((row): NormalizedRow => {
    const productId = claimed.get(row.rowNumber);
    const existing = productId ? byId.get(productId) : undefined;

    if (existing) {
      const fileCategory =
        row.category && row.category !== existing.category ? row.category : undefined;
      return {
        rowNumber: row.rowNumber,
        productId: existing.productId,
        match: byLlm.has(row.rowNumber) ? "llm" : "key",
        supplierModel: row.supplierModel,
        brand,
        model: existing.model,
        category: existing.category,
        dealerPrice: row.dealerPrice,
        mrp: row.mrp,
        ...(fileCategory ? { fileCategory } : {}),
      };
    }

    const newId = generateProductId(brand, row.supplierModel, takenIds);
    takenIds.add(newId);
    return {
      rowNumber: row.rowNumber,
      productId: newId,
      match: "new",
      supplierModel: row.supplierModel,
      brand,
      model: row.supplierModel,
      category: row.category ?? "",
      dealerPrice: row.dealerPrice,
      mrp: row.mrp,
    };
  });
}
