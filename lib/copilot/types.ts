import type { Dealer, Product, SalesLine } from "@/lib/types";

/**
 * Shared types and limits for Feature 4. Pure, so the chat page can import the
 * limits too. See context/features/feature-4-sales-copilot.md.
 */

/** Model rounds per question: tool calls, then a sentence. */
export const COPILOT_MAX_ROUNDS = 4;
/** Tool calls per question, across all rounds. */
export const COPILOT_MAX_TOOL_CALLS = 6;
export const COPILOT_MAX_QUESTION_LENGTH = 500;
/** Earlier question/answer pairs sent with a new question. */
export const COPILOT_HISTORY_PAIRS = 3;
/** Rows one tool result may hold. */
export const COPILOT_MAX_ROWS = 50;

export interface CopilotData {
  sales: SalesLine[];
  products: Product[];
  dealers: Dealer[];
}

export interface Filters {
  brands?: string[];
  categories?: string[];
  models?: string[];
  dealers?: string[];
  states?: string[];
}

export type PeriodKind = "all" | "last_month" | "this_month" | "last_days" | "month" | "between";

export interface PeriodInput {
  kind: PeriodKind;
  days?: number;
  year?: number;
  month?: number;
  from?: string;
  to?: string;
}

export interface ResolvedPeriod {
  from: string;
  to: string;
  /** "1 Aug 2026 – 31 Aug 2026". */
  label: string;
  days: number;
  caveats: string[];
}

export type SalesGroupBy =
  | "none"
  | "brand"
  | "category"
  | "model"
  | "dealer"
  | "state"
  | "month"
  | "week"
  | "invoice";

export type SortBy = "revenue" | "units" | "invoices" | "name" | "date";
export type Order = "asc" | "desc";

/** Arguments the model got wrong. The message goes back to it as the tool's result. */
export class ToolArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolArgumentError";
  }
}

// ------------------------------------------------------------ what the page gets

export interface TableColumn {
  key: string;
  label: string;
  numeric?: boolean;
}

export interface ResultTable {
  title: string;
  columns: TableColumn[];
  rows: Record<string, string>[];
  /** Shown under the table: totals, "5 of 16 shown", caveats. */
  footnotes: string[];
}

export interface CopilotStep {
  tool: string;
  /** "Query sales". */
  title: string;
  /** Plain sentences written by code from the arguments and the result. */
  lines: string[];
  /** The arguments exactly as the model sent them, for checking. */
  args: Record<string, unknown>;
  ok: boolean;
  error?: string;
  table?: ResultTable;
  /** The JSON the model saw. */
  result?: unknown;
}

export type SentenceSource = "model" | "template" | "refusal" | "no_tool";

export interface CopilotAnswer {
  question: string;
  steps: CopilotStep[];
  sentence: string;
  sentenceSource: SentenceSource;
  /** Why the model's own sentence was not used, when it was not. */
  guardNote?: string;
  meta: {
    model: string;
    rounds: number;
    toolCalls: number;
    ms: number;
    inputTokens?: number;
    outputTokens?: number;
    /** Served from the answer cache: no Gemini request was made. */
    cached?: boolean;
  };
}

export interface HistoryPair {
  question: string;
  answer: string;
}
