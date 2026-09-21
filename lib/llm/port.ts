import type { Brand, Cell, ColumnMapping } from "@/lib/types";

/**
 * What the features need from an LLM, and nothing more. Services take an
 * LlmPort, so tests pass a fake and a provider change stays inside lib/llm.
 */

export interface ColumnMappingInput {
  filename: string;
  from: string;
  subject: string;
  sheet: string | null;
  /** The first rows of the file, each with its 1-based row number. */
  rows: { rowNumber: number; cells: Cell[] }[];
}

export interface ProductMatchInput {
  brand: Brand;
  /** Rows the matching key could not place. */
  rows: { rowNumber: number; model: string; category: string | null }[];
  /** The brand's products no row has claimed yet. */
  candidates: { productId: string; model: string; category: string }[];
}

/** A proposed match; null productId means "no existing product". */
export interface ProductMatchProposal {
  rowNumber: number;
  productId: string | null;
}

export interface LlmPort {
  /**
   * `check` validates the proposal against the file itself. A problem is sent
   * back to the model once; a second failure throws InvalidLlmOutputError.
   */
  proposeColumnMapping(
    input: ColumnMappingInput,
    check: (mapping: ColumnMapping) => string | null,
  ): Promise<ColumnMapping>;

  proposeProductMatches(input: ProductMatchInput): Promise<ProductMatchProposal[]>;
}
