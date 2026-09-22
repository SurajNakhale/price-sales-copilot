import type { Dealer, PriceReview, Product, SalesLine } from "@/lib/types";

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
  /** Feature 2's reviews, for price changes from approved lists. Absent means none. */
  reviews?: PriceReview[];
}

export interface Filters {
  brands?: string[];
  categories?: string[];
  models?: string[];
  dealers?: string[];
  states?: string[];
}

export type PeriodKind =
  | "all"
  | "last_month"
  | "this_month"
  | "last_days"
  | "month"
  | "between"
  | "this_quarter"
  | "last_quarter"
  | "quarter";

/** How quarters are numbered: calendar (Q1 = Jan–Mar) or the Indian financial year (Q1 = Apr–Jun). */
export type QuarterNumbering = "calendar" | "financial";

export interface PeriodInput {
  kind: PeriodKind;
  days?: number;
  year?: number;
  month?: number;
  /** For kind quarter: 1–4, numbered as `numbering` says. */
  quarter?: number;
  /** For the quarter kinds. The model decides from the question; default calendar. */
  numbering?: QuarterNumbering;
  from?: string;
  to?: string;
}

export interface ResolvedPeriod {
  from: string;
  to: string;
  /** "1 Aug 2026 – 31 Aug 2026". */
  label: string;
  /** How a quarter was read, e.g. "calendar Q3 2026". Only for the quarter kinds. */
  reading?: string;
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

export type SentenceSource = "model" | "template" | "refusal" | "no_tool" | "clarify";

/** The readings a vague question can be given (spec §10). Labels are written by code, in wording.ts. */
export const CLARIFY_MEASURES = ["units", "revenue", "dealers", "prices", "price_changes", "growth"] as const;
export type ClarifyMeasure = (typeof CLARIFY_MEASURES)[number];

/** The copilot asking what a vague question means, instead of querying. */
export interface Clarification {
  /** What the question is about, in the question's own words ("SSDs"). */
  subject: string;
  /** 2–4 readings, each with a complete question the user can ask by clicking it. */
  options: { measure: ClarifyMeasure; label: string; question: string }[];
}

export interface CopilotAnswer {
  question: string;
  steps: CopilotStep[];
  sentence: string;
  sentenceSource: SentenceSource;
  /** Why the model's own sentence was not used, when it was not. */
  guardNote?: string;
  /** Set when the question was too vague to query; `sentence` is then its first line. */
  clarification?: Clarification;
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
