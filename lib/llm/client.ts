import "server-only";

import { GoogleGenAI } from "@google/genai";
import type * as z from "zod";

import { DEFAULT_LLM_MODEL } from "@/lib/config";
import { InvalidLlmOutputError, MissingConfigError } from "@/lib/errors";

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

export type LlmFeature = "analyse" | "copilot";

const FEATURE_MODEL_ENV: Record<LlmFeature, string> = {
  analyse: "ANALYSE_MODEL",
  copilot: "COPILOT_MODEL",
};

/**
 * The model for a feature: its own variable (ANALYSE_MODEL, COPILOT_MODEL), then
 * LLM_MODEL, then the default. Free-tier limits are per model, so giving the two
 * features different models stops them sharing one daily allowance.
 */
export function llmModel(feature?: LlmFeature): string {
  const own = feature ? process.env[FEATURE_MODEL_ENV[feature]] : undefined;
  return own || process.env.LLM_MODEL || DEFAULT_LLM_MODEL;
}

export interface StructuredRequest<T> {
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

    const interaction = await ai.interactions.create({
      // Only Feature 2 uses structured single-turn calls.
      model: llmModel("analyse"),
      system_instruction: request.instructions,
      input,
      response_format: responseFormat,
      store: false,
    });
    const text: string | undefined = interaction.output_text;

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
