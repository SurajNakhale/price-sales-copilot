import "server-only";

import { appliedPriceChanges } from "@/lib/affected";
import { defaultDraftDeps, type DraftDeps } from "@/lib/drafts/deps";
import { checkDraftProse, standardProse } from "@/lib/drafts/message";
import type { DraftMessage, DraftState } from "@/lib/drafts/types";
import { ConflictError, InvalidLlmOutputError, NotFoundError } from "@/lib/errors";
import { llmModel } from "@/lib/llm/client";
import type { DraftPort } from "@/lib/llm/port";

/**
 * Feature 3, step 5, first half: write (or rewrite) the words of the email for
 * an approved price list and keep them for the review. Gemini is asked once,
 * twice if its wording typed a number; if it fails twice, or the user chose it,
 * the standard message is used instead. Nothing goes to Gmail here.
 *
 * Gemini sees the brand and the changed products and prices, and nothing about
 * any dealer.
 */

export interface PrepareOptions {
  /** Use the standard message and do not ask Gemini. */
  template?: boolean;
  llm?: DraftPort;
  deps?: DraftDeps;
  /** The model name to record. */
  model?: () => string;
}

export async function prepareDraftMessage(
  fileId: string,
  options: PrepareOptions = {},
): Promise<DraftState> {
  const deps = options.deps ?? defaultDraftDeps();

  const review = await deps.readReview(fileId);
  if (!review) throw new NotFoundError("No analysed price list has that ID.");
  if (review.status !== "approved") {
    throw new ConflictError("This price list has not been approved yet, so there is nobody to notify.");
  }

  const changes = appliedPriceChanges(review);
  if (changes.length === 0) {
    throw new ConflictError("None of the approved changes was a price change, so there is nobody to notify.");
  }
  const brand = review.brand ?? changes[0].brand;
  const models = changes.map((change) => change.model);
  const generatedAt = deps.now().toISOString();

  let message: DraftMessage;
  if (options.template) {
    message = { ...standardProse(brand), source: "template", note: "You chose the standard message.", generatedAt };
  } else {
    const llm = options.llm ?? (await import("@/lib/llm/drafts")).geminiDrafts;
    try {
      const prose = await llm.draftDealerMessage(
        {
          brand,
          changes: changes.map((c) => ({ model: c.model, old: c.old, new: c.new })),
        },
        (candidate) => checkDraftProse(candidate, models, brand),
      );
      message = {
        subject: prose.subject.trim(),
        greeting: prose.greeting.trim(),
        intro: prose.intro.trim(),
        closing: prose.closing.trim(),
        source: "model",
        model: (options.model ?? (() => llmModel("draft")))(),
        generatedAt,
      };
    } catch (error) {
      // Wording that broke the rules twice is not an outage: fall back to a message that cannot.
      if (!(error instanceof InvalidLlmOutputError)) throw error;
      message = {
        ...standardProse(brand),
        source: "template",
        note: "Gemini's wording broke the rules twice (it wrote a number), so the standard message is shown. Press Rewrite to try again.",
        generatedAt,
      };
    }
  }

  const previous = await deps.readState(fileId);
  const state: DraftState = { fileId, message, drafts: previous?.drafts ?? [] };
  await deps.writeState(state);
  return state;
}
