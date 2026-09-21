import { createHash } from "node:crypto";

import type { Brand } from "./types";

/**
 * The one Product ID rule, shared by the app and scripts/generate-mock-data.ts
 * so generated and mock IDs cannot drift. Pure, and deliberately not
 * `server-only`: a plain `bun scripts/...` run has to be able to import it.
 * See context/architecture.md section 6.2.
 */

/** Three-letter code per brand. A brand missing here cannot get Product IDs. */
export const BRAND_CODES: Record<Brand, string> = {
  Seagate: "SEG",
  Samsung: "SAM",
  "TP-Link": "TPL",
};

export const BRANDS = Object.keys(BRAND_CODES) as Brand[];

export function isBrand(value: string): value is Brand {
  return (BRANDS as string[]).includes(value);
}

function hash5(input: string): string {
  return createHash("sha256").update(input.toLowerCase()).digest("hex").slice(0, 5).toUpperCase();
}

/** `SAM-B072D`: the brand code, then the first 5 hex of sha256("brand|model"), lowercased. */
export function productIdFor(brand: Brand, model: string): string {
  return `${BRAND_CODES[brand]}-${hash5(`${brand}|${model}`)}`;
}

/**
 * The ID for a new product. Deterministic; if the plain ID is already taken it
 * is re-hashed with a counter until it is free.
 */
export function generateProductId(
  brand: Brand,
  model: string,
  takenIds: ReadonlySet<string>,
): string {
  const plain = productIdFor(brand, model);
  if (!takenIds.has(plain)) return plain;

  for (let counter = 2; counter < 10_000; counter++) {
    const candidate = `${BRAND_CODES[brand]}-${hash5(`${brand}|${model}|${counter}`)}`;
    if (!takenIds.has(candidate)) return candidate;
  }
  throw new Error(`Could not find a free Product ID for ${brand} ${model}.`);
}
