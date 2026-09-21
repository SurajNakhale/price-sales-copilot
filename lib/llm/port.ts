import type * as z from "zod";

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

// ------------------------------------------------ tool calling (Feature 4)

/**
 * One step of a tool-calling conversation. Steps the model produced are kept
 * exactly as they came back, because they can carry thought signatures that
 * must be returned unchanged; nothing outside lib/llm looks inside them.
 */
export type ChatStep = { type: string } & Record<string, unknown>;

export interface ChatFunctionCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatToolDeclaration {
  name: string;
  description: string;
  /** Converted to the provider's schema format inside lib/llm. */
  parameters: z.ZodType;
}

export interface ChatTurnRequest {
  instructions: string;
  tools: ChatToolDeclaration[];
  /** The whole conversation so far: calls are stateless, so every turn resends it. */
  history: ChatStep[];
}

export interface ChatTurnResult {
  /** The steps the model produced this turn, verbatim, to append to the history. */
  steps: ChatStep[];
  calls: ChatFunctionCall[];
  /** The model's text, when it answered instead of (or as well as) calling a tool. */
  text: string;
  usage: { inputTokens?: number; outputTokens?: number };
}

export interface ChatPort {
  readonly model: string;
  turn(request: ChatTurnRequest): Promise<ChatTurnResult>;
}

/** The step that carries the user's words. */
export function userStep(text: string): ChatStep {
  return { type: "user_input", content: [{ type: "text", text }] };
}

/** The step that carries a tool's result back to the model. */
export function functionResultStep(call: ChatFunctionCall, result: unknown): ChatStep {
  return {
    type: "function_result",
    call_id: call.id,
    name: call.name,
    result: [{ type: "text", text: JSON.stringify(result) }],
  };
}
