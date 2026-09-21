import "server-only";

import * as z from "zod";

import { generateStructured } from "./client";
import type { DraftPort } from "./port";
import { DEALER_EMAIL_INSTRUCTIONS, dealerEmailInput } from "./prompts/dealer-email";

/**
 * The Gemini implementation of Feature 3's one LLM need: the words of the
 * dealer email. One request (two if the first wording breaks the rules).
 */

const dealerEmailSchema = z.object({
  subject: z.string().describe("The subject line, one line, plain text"),
  greeting: z.string().describe("A brief greeting for many recipients, such as Hello,"),
  intro: z.string().describe("One or two sentences saying dealer prices were updated. No prices or counts"),
  closing: z.string().describe("One sentence inviting questions"),
});

export const geminiDrafts: DraftPort = {
  async draftDealerMessage(input, check) {
    return generateStructured({
      feature: "draft",
      instructions: DEALER_EMAIL_INSTRUCTIONS,
      input: dealerEmailInput({
        brand: input.brand,
        changes: input.changes.map((c) => ({
          model: c.model,
          oldDealerPrice: c.old.dealerPrice,
          newDealerPrice: c.new.dealerPrice,
          oldMrp: c.old.mrp,
          newMrp: c.new.mrp,
        })),
      }),
      schema: dealerEmailSchema,
      check,
    });
  },
};
