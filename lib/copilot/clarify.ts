import * as z from "zod";

import { resolveFilters } from "./filters";
import { dropNulls } from "./tools";
import { CLARIFY_MEASURES, type Clarification, type ClarifyMeasure, type CopilotData } from "./types";
import { MEASURE_LABELS } from "./wording";

/**
 * The fourth tool, `ask_clarification` (spec §10). It reads no data: the model
 * calls it instead of a query when a question names what to look at but not
 * what to measure. The model only picks readings from a fixed list and writes
 * an example question for each; the app writes everything else the user sees.
 * Pure.
 */

export const CLARIFY_TOOL = "ask_clarification";

const clarifySchema = z.object({
  subject: z
    .string()
    .min(1)
    .max(60)
    .describe('What the question is about, copied from its own words, e.g. "SSDs" or "ABC Computers".'),
  options: z
    .array(
      z.object({
        measure: z.enum(CLARIFY_MEASURES).describe(
          "units = sales quantity; revenue; dealers = how many dealers bought (products and states only); " +
            "prices = current dealer price and MRP (brands, categories and models only); " +
            "price_changes = price changes from approved supplier price lists (brands, categories and models only); " +
            "growth = change against the previous period.",
        ),
        question: z
          .string()
          .min(10)
          .max(150)
          .describe(
            'One complete question for that reading, which the tools can answer, with a period, e.g. "How many SSDs did we sell last month?".',
          ),
      }),
    )
    .min(2)
    .max(4)
    .describe("2 to 4 readings that fit the subject, most likely first."),
});

export function clarifyDeclaration(): { name: string; description: string; parameters: z.ZodType } {
  return {
    name: CLARIFY_TOOL,
    description:
      "Ask the user what they want to know, instead of guessing, when the question names what to look at but not " +
      'what to measure ("How are SSDs doing?", "What about Samsung?", "Tell me about ABC Computers"). Reads no ' +
      "data. Call it alone and before any query. Do not call it when the question has a measure, a ranking, a " +
      "comparison, or an earlier turn that makes the measure clear.",
    parameters: clarifySchema,
  };
}

type SubjectKind = "product" | "dealer" | "state" | "unknown";

/** Readings that cannot apply to a subject of that kind (spec §10, "Fits"). */
const DOES_NOT_FIT: Record<SubjectKind, ClarifyMeasure[]> = {
  product: [],
  dealer: ["dealers", "prices", "price_changes"],
  state: ["prices", "price_changes"],
  unknown: [],
};

/** What the subject names in the data, by the same matching the tools use. */
function subjectKind(subject: string, data: CopilotData): SubjectKind {
  const r = (filters: Parameters<typeof resolveFilters>[0]) => resolveFilters(filters, data);
  if (r({ brands: [subject] }).brands?.length || r({ categories: [subject] }).categories?.length) return "product";
  if (r({ models: [subject] }).models?.length) return "product";
  if (r({ dealers: [subject] }).dealers?.size) return "dealer";
  if (r({ states: [subject] }).states?.size) return "state";
  return "unknown";
}

/** Lower case, punctuation as spaces, single spaces, padded: for whole-word containment. */
function words(text: string): string {
  return ` ${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
}

/**
 * Checks the model's arguments. Returns the clarification to show, or the
 * problem in words, which goes back to the model as the tool's result. With
 * the data, a reading that cannot apply to the subject (the number of dealers
 * for a dealer, prices for a state) is refused too.
 */
export function checkClarification(rawArgs: unknown, question: string, data?: CopilotData): Clarification | string {
  const parsed = clarifySchema.safeParse(dropNulls(rawArgs ?? {}));
  if (!parsed.success) {
    return `Invalid arguments: ${parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "arguments"}: ${issue.message}`)
      .join("; ")}`;
  }

  const subject = parsed.data.subject.trim().replace(/\s+/g, " ");
  if (words(subject).trim() === "" || !words(question).includes(words(subject))) {
    return `subject must be words from the question ("${question}"), not "${subject}".`;
  }

  if (data) {
    const kind = subjectKind(subject, data);
    const unfit = parsed.data.options.map((option) => option.measure).filter((m) => DOES_NOT_FIT[kind].includes(m));
    if (unfit.length > 0) {
      const fits = CLARIFY_MEASURES.filter((m) => !DOES_NOT_FIT[kind].includes(m)).join(", ");
      return `"${subject}" is a ${kind}, so ${unfit.join(" and ")} does not fit. Readings for a ${kind}: ${fits}.`;
    }
  }

  const seen = new Set<string>();
  for (const option of parsed.data.options) {
    if (seen.has(option.measure)) return `Each measure may be offered once; "${option.measure}" appears twice.`;
    seen.add(option.measure);
    const text = option.question.trim();
    if (/[\r\n]/.test(text)) return "Each example question must be one line.";
    if (!text.endsWith("?")) return `Each example question must end with "?": "${text}".`;
    if (/[*_`#<>[\]]/.test(text)) return `Example questions are plain text, without markdown: "${text}".`;
  }

  return {
    subject,
    options: parsed.data.options.map((option) => ({
      measure: option.measure,
      label: MEASURE_LABELS[option.measure],
      question: option.question.trim(),
    })),
  };
}
