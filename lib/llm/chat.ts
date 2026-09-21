import "server-only";

import { InvalidLlmOutputError, LlmUnavailableError } from "@/lib/errors";

import { getClient, llmModel } from "./client";
import type { ChatFunctionCall, ChatPort, ChatStep, ChatTurnRequest, ChatTurnResult } from "./port";
import { toGeminiSchema } from "./schemas";

/**
 * Function calling through the Gemini Interactions API, for Feature 4.
 *
 * Stateless: `store: false` rules out `previous_interaction_id`, so every turn
 * sends the whole conversation as `input` — the user's step, every step the
 * model returned exactly as it came back (thought steps carry signatures that
 * must be returned unchanged), and one `function_result` per tool call. See
 * context/features/feature-4-sales-copilot.md.
 */

/** The one SDK method used. The real client, or a fake in tests. */
export interface InteractionsClient {
  interactions: { create(params: Record<string, unknown>): Promise<unknown> };
}

interface RawInteraction {
  status?: string;
  steps?: unknown;
  output_text?: unknown;
  usage?: { total_input_tokens?: number; total_output_tokens?: number };
}

function isStep(value: unknown): value is ChatStep {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

function toCall(step: ChatStep): ChatFunctionCall | null {
  const { id, name } = step as { id?: unknown; name?: unknown };
  if (typeof id !== "string" || typeof name !== "string") return null;
  let args: unknown = (step as { arguments?: unknown }).arguments;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      args = {};
    }
  }
  return {
    id,
    name,
    arguments: args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {},
  };
}

function textOf(steps: ChatStep[]): string {
  const parts: string[] = [];
  for (const step of steps) {
    if (step.type !== "model_output" || !Array.isArray(step.content)) continue;
    for (const item of step.content as { type?: unknown; text?: unknown }[]) {
      if (item?.type === "text" && typeof item.text === "string") parts.push(item.text);
    }
  }
  return parts.join("");
}

export function parseInteraction(raw: unknown): ChatTurnResult {
  const interaction = (raw ?? {}) as RawInteraction;
  if (interaction.status === "failed" || interaction.status === "cancelled") {
    throw new InvalidLlmOutputError(`Gemini did not finish the answer (status "${interaction.status}").`);
  }

  // Keep only what the model produced; our own input steps are already in the history.
  const steps = (Array.isArray(interaction.steps) ? interaction.steps : [])
    .filter(isStep)
    .filter((step) => step.type !== "user_input" && step.type !== "function_result");

  const calls = steps
    .filter((step) => step.type === "function_call")
    .map(toCall)
    .filter((call): call is ChatFunctionCall => call !== null);

  const text = typeof interaction.output_text === "string" ? interaction.output_text : textOf(steps);

  return {
    steps,
    calls,
    text: text.trim(),
    usage: {
      inputTokens: interaction.usage?.total_input_tokens,
      outputTokens: interaction.usage?.total_output_tokens,
    },
  };
}

/** Rate limits and outages become LlmUnavailableError (503); anything else is rethrown. */
export function mapGeminiError(error: unknown): unknown {
  const status = (error as { status?: unknown })?.status;
  const detail = error instanceof Error ? error.message : String((error as { message?: unknown })?.message ?? "");
  if (status === 429 && /per day/i.test(detail)) {
    // Waiting a minute does not help here; say what does. Seen live: the free tier allows
    // gemini-3.8-flash 20 requests a day, and each question uses two or three.
    const limit = /limit: ([^)]+)\)/i.exec(detail)?.[1];
    return new LlmUnavailableError(
      `The Gemini key has used up its daily request limit${limit ? ` (${limit})` : ""}. It resets daily; ` +
        "a paid-tier key, or another model set in COPILOT_MODEL or LLM_MODEL, avoids it.",
    );
  }
  if (status === 429) {
    return new LlmUnavailableError("Gemini is rate-limiting requests right now. Wait a minute and ask again.");
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

export function createGeminiChat(
  options: { client?: () => InteractionsClient; model?: () => string } = {},
): ChatPort {
  // Resolved on each call, so a missing key is reported when a question is asked, not at import.
  const client = options.client ?? (() => getClient() as unknown as InteractionsClient);
  const model = options.model ?? (() => llmModel("copilot"));

  return {
    get model() {
      return model();
    },

    async turn(request: ChatTurnRequest): Promise<ChatTurnResult> {
      const params = {
        model: model(),
        system_instruction: request.instructions,
        input: request.history,
        tools: request.tools.map((tool) => ({
          type: "function",
          name: tool.name,
          description: tool.description,
          parameters: toGeminiSchema(tool.parameters),
        })),
        store: false,
      };

      let raw: unknown;
      try {
        raw = await client().interactions.create(params);
      } catch (error) {
        throw mapGeminiError(error);
      }
      return parseInteraction(raw);
    },
  };
}

export const geminiChat: ChatPort = createGeminiChat();
