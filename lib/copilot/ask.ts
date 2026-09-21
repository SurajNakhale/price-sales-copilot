import "server-only";

import { createHash } from "node:crypto";

import { earliestInvoiceDate, latestInvoiceDate } from "@/lib/analytics";
import { readDealers, readProducts, readSales } from "@/lib/data/mock-data";
import { BadRequestError } from "@/lib/errors";
import { geminiChat } from "@/lib/llm/chat";
import { functionResultStep, userStep, type ChatPort, type ChatStep } from "@/lib/llm/port";
import { copilotInstructions, copilotUserText } from "@/lib/llm/prompts/copilot";

import { vocabularyOf } from "./filters";
import { allowedNumbers, checkNumbers, hasDigit } from "./guard";
import { executeTool, toolDeclarations } from "./tools";
import {
  COPILOT_HISTORY_PAIRS,
  COPILOT_MAX_QUESTION_LENGTH,
  COPILOT_MAX_ROUNDS,
  COPILOT_MAX_TOOL_CALLS,
  type CopilotAnswer,
  type CopilotData,
  type CopilotStep,
  type HistoryPair,
  type SentenceSource,
} from "./types";

/**
 * Feature 4: one question in, one checked answer out.
 *
 *   question → Gemini picks tools → code runs them → Gemini sees the results
 *   → another tool, or a sentence (at most COPILOT_MAX_ROUNDS rounds)
 *   → the number check → steps, tables and a sentence for the page
 *
 * The model never sees the datasets, only tool results, and every number the
 * page shows was computed by the tools.
 */

export const NO_TOOL_REFUSAL =
  "I can only answer from the sales, product and dealer data, and I did not look anything up for that. " +
  "Try asking about sales, products, dealers or states.";

const NO_QUERY =
  "I could not work out a query for that. Try naming what to measure and a brand, dealer, model or period.";

export type SentenceMode = "model" | "template";

export interface AskDeps {
  chat?: ChatPort;
  data?: CopilotData;
  clock?: () => number;
  /** Answers already given; null turns caching off. Defaults to one cache for the process. */
  cache?: Map<string, CopilotAnswer> | null;
  /**
   * "template" is economy mode: once the tools have run, the app writes the sentence and
   * Gemini is not asked again, so a question costs 1 request instead of 2. Defaults to
   * COPILOT_SENTENCE, else "model".
   */
  sentence?: SentenceMode;
}

/**
 * Answers kept for the life of the server process, so asking the same thing twice
 * costs no Gemini request. The key includes a fingerprint of the data, so an approval
 * that changes the price list makes old answers miss.
 */
const answerCache = new Map<string, CopilotAnswer>();
const CACHE_LIMIT = 200;

function sentenceMode(): SentenceMode {
  return process.env.COPILOT_SENTENCE === "template" ? "template" : "model";
}

function cacheKey(
  question: string,
  history: HistoryPair[],
  model: string,
  mode: SentenceMode,
  data: CopilotData,
): string {
  const normalised = question.toLowerCase().replace(/\s+/g, " ").replace(/[?.!\s]+$/, "");
  const fingerprint = createHash("sha256").update(JSON.stringify(data)).digest("hex");
  return JSON.stringify([normalised, history, model, mode, fingerprint]);
}

function remember(cache: Map<string, CopilotAnswer>, key: string, answer: CopilotAnswer): void {
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  cache.set(key, answer);
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** The page shows plain sentences; stray markdown emphasis is removed. */
function plain(text: string): string {
  return text.replace(/\*\*|__|`/g, "").trim();
}

export async function askCopilot(
  question: string,
  history: HistoryPair[] = [],
  deps: AskDeps = {},
): Promise<CopilotAnswer> {
  const q = question.trim();
  if (!q) throw new BadRequestError("Ask a question first.");
  if (q.length > COPILOT_MAX_QUESTION_LENGTH) {
    throw new BadRequestError(`Questions can be at most ${COPILOT_MAX_QUESTION_LENGTH} characters.`);
  }

  const clock = deps.clock ?? Date.now;
  const started = clock();
  const chat = deps.chat ?? geminiChat;
  const data: CopilotData =
    deps.data ??
    (await Promise.all([readSales(), readProducts(), readDealers()]).then(([sales, products, dealers]) => ({
      sales,
      products,
      dealers,
    })));

  const today = latestInvoiceDate(data.sales);
  const dataStart = earliestInvoiceDate(data.sales);
  if (today === null || dataStart === null) {
    return {
      question: q,
      steps: [],
      sentence: "There are no sales in the data yet, so there is nothing to answer from.",
      sentenceSource: "template",
      meta: { model: chat.model, rounds: 0, toolCalls: 0, ms: clock() - started },
    };
  }

  const instructions = copilotInstructions({ today, dataStart, vocabulary: vocabularyOf(data) });
  const tools = toolDeclarations();
  const earlier = history
    .slice(-COPILOT_HISTORY_PAIRS)
    .map((pair) => ({ question: clip(pair.question, COPILOT_MAX_QUESTION_LENGTH), answer: clip(pair.answer, 1000) }));

  const mode = deps.sentence ?? sentenceMode();
  const cache = deps.cache === undefined ? answerCache : deps.cache;
  const key = cache ? cacheKey(q, earlier, chat.model, mode, data) : "";
  const hit = cache?.get(key);
  if (hit) {
    return { ...hit, question: q, meta: { ...hit.meta, ms: clock() - started, cached: true } };
  }

  const conversation: ChatStep[] = [userStep(copilotUserText(q, earlier))];
  const steps: CopilotStep[] = [];
  const results: unknown[] = [];
  const templates: string[] = [];
  let text = "";
  let rounds = 0;
  let toolCalls = 0;
  let answered = false;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;

  while (rounds < COPILOT_MAX_ROUNDS) {
    rounds += 1;
    const turn = await chat.turn({ instructions, tools, history: conversation });
    if (turn.usage.inputTokens !== undefined) inputTokens = (inputTokens ?? 0) + turn.usage.inputTokens;
    if (turn.usage.outputTokens !== undefined) outputTokens = (outputTokens ?? 0) + turn.usage.outputTokens;
    conversation.push(...turn.steps);

    if (turn.calls.length === 0) {
      text = plain(turn.text);
      answered = true;
      break;
    }

    // Every call gets a result, even over the limit, because the model expects one per call.
    for (const call of turn.calls) {
      if (toolCalls >= COPILOT_MAX_TOOL_CALLS) {
        conversation.push(
          functionResultStep(call, {
            error: `The limit of ${COPILOT_MAX_TOOL_CALLS} tool calls is reached. Answer from the results you have.`,
          }),
        );
        continue;
      }
      toolCalls += 1;
      const execution = executeTool(call.name, call.arguments, data);
      steps.push(execution.step);
      if (execution.step.ok) {
        results.push(execution.modelResult);
        if (execution.template) templates.push(execution.template);
      }
      conversation.push(functionResultStep(call, execution.modelResult));
    }

    // Economy mode: the tools have answered, so the app writes the sentence.
    if (mode === "template" && results.length > 0) break;
  }

  let sentence: string;
  let sentenceSource: SentenceSource;
  let guardNote: string | undefined;

  if (results.length === 0) {
    if (!text) {
      sentence = NO_QUERY;
      sentenceSource = "refusal";
    } else if (hasDigit(text)) {
      sentence = NO_TOOL_REFUSAL;
      sentenceSource = "refusal";
      guardNote = "The model answered with numbers without running a query, so its answer is not shown.";
    } else {
      sentence = text;
      sentenceSource = "no_tool";
    }
  } else {
    const template = templates[templates.length - 1];
    const check = text ? checkNumbers(text, allowedNumbers([...results, q])) : null;
    if (check?.ok) {
      sentence = text;
      sentenceSource = "model";
    } else if (mode === "template" && !text) {
      sentence = template;
      sentenceSource = "template";
    } else {
      sentence = template;
      sentenceSource = "template";
      guardNote = !text
        ? answered
          ? "The model did not write a sentence, so one written from the results is shown."
          : `The model was still querying after ${COPILOT_MAX_ROUNDS} rounds, so a sentence written from the results is shown.`
        : `The model's sentence had ${check!.unsupported.join(", ")}, which is not in the results, so a sentence written from the results is shown instead.`;
    }
  }

  const answer: CopilotAnswer = {
    question: q,
    steps,
    sentence,
    sentenceSource,
    ...(guardNote ? { guardNote } : {}),
    meta: {
      model: chat.model,
      rounds,
      toolCalls,
      ms: clock() - started,
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
    },
  };
  if (cache) remember(cache, key, answer);
  return answer;
}
