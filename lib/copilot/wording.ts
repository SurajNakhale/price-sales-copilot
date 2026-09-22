import type { Clarification, ClarifyMeasure, CopilotAnswer } from "./types";

/**
 * What the copilot says when a question is too vague to query (spec §10).
 * Every word here is written by code; only the example questions come from
 * the model. Pure and free of zod, so the chat page can import it.
 */

export const MEASURE_LABELS: Record<ClarifyMeasure, string> = {
  units: "Sales quantity",
  revenue: "Revenue",
  dealers: "Number of dealers",
  prices: "Current prices",
  price_changes: "Price changes",
  growth: "Growth vs the previous period",
};

export const CLARIFY_SOURCE_NOTE = "No query was run: the question did not say what to measure.";

/** "I'm not sure what you'd like to know about SSDs." */
export function clarificationSentence(subject: string): string {
  return `I'm not sure what you'd like to know about ${subject}.`;
}

/**
 * The whole clarification as plain text. It is what the next question carries
 * as history, so a typed reply such as "revenue" is read against these options.
 */
export function clarificationText(clarification: Clarification): string {
  const options = clarification.options.map((option) => option.label).join(", ");
  return (
    `${clarificationSentence(clarification.subject)} Would you like to see: ${options}? ` +
    `For example: "${clarification.options[0].question}"`
  );
}

/** The text an answer leaves in the follow-up history. */
export function historyText(answer: Pick<CopilotAnswer, "sentence" | "clarification">): string {
  return answer.clarification ? clarificationText(answer.clarification) : answer.sentence;
}
