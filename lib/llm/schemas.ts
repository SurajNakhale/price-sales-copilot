import * as z from "zod";

import { BRANDS } from "@/lib/product-id";

/**
 * The shapes the LLM must answer in. Each is defined once, here: the JSON
 * schema sent to Gemini is derived from it, and the answer is validated
 * against it again, since a schema-constrained answer is valid JSON but not
 * necessarily correct. Kept small and flat, as Google recommends.
 */

export const columnMappingSchema = z.object({
  headerRow: z.int().min(1).describe("1-based row number of the row that holds the column headers"),
  brand: z
    .enum([...BRANDS, "unknown"])
    .describe('The brand the whole file is for, or "unknown" if it is none of the listed brands'),
  model: z.string().describe("Header text of the model / product name column, copied exactly"),
  category: z
    .string()
    .describe('Header text of the category / type column, copied exactly, or "" if there is none'),
  dealerPrice: z
    .string()
    .describe("Header text of the dealer price column (the price to the dealer, not retail), copied exactly"),
  mrp: z.string().describe("Header text of the MRP / retail price column, copied exactly"),
});

export type ColumnMappingAnswer = z.infer<typeof columnMappingSchema>;

export const productMatchSchema = z.object({
  matches: z.array(
    z.object({
      rowNumber: z.int().describe("The row number from the input"),
      productId: z
        .string()
        .describe('The Product ID of the same product from the catalogue, or "" if none is the same product'),
    }),
  ),
});

export type ProductMatchAnswer = z.infer<typeof productMatchSchema>;

/**
 * A JSON schema Gemini accepts: Zod's output without the keywords the Gemini
 * docs do not list (`$schema`, `additionalProperties`) and without Zod's
 * safe-integer bounds, which only add noise. Zod still enforces everything.
 */
export function toGeminiSchema(schema: z.ZodType): Record<string, unknown> {
  return strip(z.toJSONSchema(schema)) as Record<string, unknown>;
}

function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip);
  if (value === null || typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "$schema" || key === "additionalProperties") continue;
    if ((key === "minimum" || key === "maximum") && Math.abs(child as number) === Number.MAX_SAFE_INTEGER) {
      continue;
    }
    out[key] = strip(child);
  }
  return out;
}
