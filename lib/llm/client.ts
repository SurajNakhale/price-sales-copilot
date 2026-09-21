import "server-only";

import { GoogleGenAI } from "@google/genai";
import type * as z from "zod";

import { DEFAULT_LLM_MODEL } from "@/lib/config";
import { InvalidLlmOutputError, LlmUnavailableError, MissingConfigError } from "@/lib/errors";

import { toGeminiSchema } from "./schemas";

/**
 * The only module that talks to Gemini. Stateless single-turn calls through
 * the Interactions API with `store: false`, answers constrained to a JSON
 * schema and validated again with Zod. See context/architecture.md section 7.
 */

let client: GoogleGenAI | null = null;

export function getClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new MissingConfigError(
      "Missing environment variable GEMINI_API_KEY. Add a Gemini API key to .env.local and restart the app.",
    );
  }
  client ??= new GoogleGenAI({ apiKey });
  return client;
}

export type LlmFeature = "analyse" | "copilot" | "draft";

const FEATURE_MODEL_ENV: Record<LlmFeature, string> = {
  analyse: "ANALYSE_MODEL",
  copilot: "COPILOT_MODEL",
  draft: "DRAFT_MODEL",
};

/**
 * The model for a feature: its own variable (ANALYSE_MODEL, COPILOT_MODEL,
 * DRAFT_MODEL), then LLM_MODEL, then the default. Free-tier limits are per
 * model, so giving the features different models stops them sharing one daily
 * allowance.
 */
export function llmModel(feature?: LlmFeature): string {
  const own = feature ? process.env[FEATURE_MODEL_ENV[feature]] : undefined;
  return own || process.env.LLM_MODEL || DEFAULT_LLM_MODEL;
}

/** Rate limits and outages become LlmUnavailableError (503); anything else is rethrown. */
export function mapGeminiError(error: unknown): unknown {
  const status = (error as { status?: unknown })?.status;
  const detail = error instanceof Error ? error.message : String((error as { message?: unknown })?.message ?? "");
  if (status === 429 && /per day/i.test(detail)) {
    // Waiting a minute does not help here; say what does. Seen live: the free tier allows
    // gemini-3.8-flash 20 requests a day, and a copilot question uses two or three.
    const limit = /limit: ([^)]+)\)/i.exec(detail)?.[1];
    return new LlmUnavailableError(
      `The Gemini key has used up its daily request limit${limit ? ` (${limit})` : ""}. It resets daily; ` +
        "a paid-tier key, or another model (LLM_MODEL, or ANALYSE_MODEL, COPILOT_MODEL or DRAFT_MODEL for one feature), avoids it.",
    );
  }
  if (status === 429) {
    return new LlmUnavailableError("Gemini is rate-limiting requests right now. Wait a minute and try again.");
  }
  if (typeof status === "number" && status >= 500) {
    return new LlmUnavailableError(`Gemini is unavailable right now (status ${status}). Try again shortly.`);
  }
  const message = error instanceof Error ? error.message : "";
  if (error instanceof TypeError && /fetch|network|ECONN|ENOTFOUND/i.test(message)) {
    return new LlmUnavailableError("Could not reach Gemini. Check the internet connection and try again.");
  }
  return error;
}

export interface StructuredRequest<T> {
  /** Picks the model (ANALYSE_MODEL, DRAFT_MODEL…). Defaults to "analyse", the first user. */
  feature?: LlmFeature;
  instructions: string;
  input: string;
  schema: z.ZodType<T>;
  /** Extra checks against the real data; returns the problem in words, or null. */
  check?: (value: T) => string | null;
}

/**
 * One call, and at most one retry that tells the model what was wrong with its
 * first answer. A second invalid answer is an error, never accepted.
 */
export async function generateStructured<T>(request: StructuredRequest<T>): Promise<T> {
  const ai = getClient();
  const responseFormat = {
    type: "text" as const,
    mime_type: "application/json" as const,
    schema: toGeminiSchema(request.schema),
  };

  let problem: string | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const input: string =
      problem === null
        ? request.input
        : `${request.input}\n\nYour previous answer was rejected: ${problem}\nAnswer again, fixing that.`;

    let text: string | undefined;
    try {
      const interaction = await ai.interactions.create({
        model: llmModel(request.feature ?? "analyse"),
        system_instruction: request.instructions,
        input,
        response_format: responseFormat,
        store: false,
      });
      text = interaction.output_text;
    } catch (error) {
      throw mapGeminiError(error);
    }

    problem = validate(text, request);
    if (problem === null) {
      return request.schema.parse(JSON.parse(text as string));
    }
  }

  throw new InvalidLlmOutputError(`The LLM's answer was not usable twice in a row: ${problem}`);
}

function validate<T>(text: string | undefined, request: StructuredRequest<T>): string | null {
  if (!text) return "The answer was empty.";

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return "The answer was not valid JSON.";
  }

  const parsed = request.schema.safeParse(json);
  if (!parsed.success) {
    return parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "answer"}: ${issue.message}`)
      .join("; ");
  }

  return request.check?.(parsed.data) ?? null;
}
