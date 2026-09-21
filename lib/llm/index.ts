import "server-only";

import { LLM_MAX_CELL_LENGTH } from "@/lib/config";
import { UnusableFileError } from "@/lib/errors";
import { isBrand } from "@/lib/product-id";
import type { Cell, ColumnMapping } from "@/lib/types";

import { generateStructured } from "./client";
import type { LlmPort } from "./port";
import { COLUMN_MAPPING_INSTRUCTIONS, columnMappingInput } from "./prompts/column-mapping";
import { PRODUCT_MATCH_INSTRUCTIONS, productMatchInput } from "./prompts/product-match";
import { columnMappingSchema, productMatchSchema, type ColumnMappingAnswer } from "./schemas";

export type { LlmPort } from "./port";

function clip(cell: Cell): Cell {
  return typeof cell === "string" && cell.length > LLM_MAX_CELL_LENGTH
    ? `${cell.slice(0, LLM_MAX_CELL_LENGTH)}…`
    : cell;
}

function toMapping(answer: ColumnMappingAnswer): ColumnMapping {
  if (!isBrand(answer.brand)) {
    throw new UnusableFileError(
      "This file is not for a brand the app knows. Add the brand and its 3-letter code to " +
        "BRAND_CODES in lib/product-id.ts, then analyse it again.",
    );
  }
  return {
    headerRow: answer.headerRow,
    brand: answer.brand,
    columns: {
      model: answer.model,
      category: answer.category.trim() === "" ? null : answer.category,
      dealerPrice: answer.dealerPrice,
      mrp: answer.mrp,
    },
  };
}

/** The Gemini implementation of the features' LLM needs. */
export const geminiLlm: LlmPort = {
  async proposeColumnMapping(input, check) {
    const answer = await generateStructured({
      instructions: COLUMN_MAPPING_INSTRUCTIONS,
      input: columnMappingInput({
        email: { filename: input.filename, from: input.from, subject: input.subject },
        sheet: input.sheet,
        rows: input.rows.map((row) => ({ row: row.rowNumber, cells: row.cells.map(clip) })),
      }),
      schema: columnMappingSchema,
      // An unknown brand is a real answer, not a mistake to retry.
      check: (value) => (isBrand(value.brand) ? check(toMapping(value)) : null),
    });
    return toMapping(answer);
  },

  async proposeProductMatches(input) {
    if (input.rows.length === 0) return [];

    const answer = await generateStructured({
      instructions: PRODUCT_MATCH_INSTRUCTIONS,
      input: productMatchInput(input),
      schema: productMatchSchema,
    });
    return answer.matches.map((match) => ({
      rowNumber: match.rowNumber,
      productId: match.productId.trim() === "" ? null : match.productId.trim(),
    }));
  },
};
