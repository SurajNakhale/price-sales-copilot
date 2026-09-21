import type { Brand, Product } from "./types";

/**
 * Code-first product matching. Two spellings of the same model produce the
 * same key when they differ only in case, punctuation, spacing, a leading
 * brand name or a gap between a number and its unit:
 *
 *   "SEAGATE BARRACUDA-2TB"  →  seagate:barracuda 2tb
 *   "Barracuda 2TB"          →  seagate:barracuda 2tb
 *
 * Anything more (a different word order, an added "Portable SSD") is left to
 * the LLM fallback in lib/match.ts. Pure.
 */

const UNITS = "tb|gb|mb|mbps|gbps|w|mm|inch|in";

function simplify(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function createMatchingKey(brand: Brand, model: string): string {
  const brandWords = simplify(brand); // "tp link"
  const brandCompact = brandWords.replace(/ /g, ""); // "tplink"

  let key = simplify(model);
  for (const prefix of [brandWords, brandCompact]) {
    if (key.startsWith(`${prefix} `)) {
      key = key.slice(prefix.length + 1);
      break;
    }
  }
  key = key.replace(new RegExp(`(\\d) (${UNITS})\\b`, "g"), "$1$2");

  return `${brandCompact}:${key}`;
}

/**
 * Matching key → Product ID for every product, discontinued ones included, so
 * a product the supplier lists again is recognised rather than duplicated.
 */
export function buildIdentityMap(products: Product[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const product of products) {
    map.set(createMatchingKey(product.brand, product.model), product.productId);
  }
  return map;
}
