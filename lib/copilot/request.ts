import * as z from "zod";

import { COPILOT_HISTORY_PAIRS, COPILOT_MAX_QUESTION_LENGTH } from "./types";

/** The body of POST /api/copilot/ask. Only the last few history pairs are kept. Pure. */
export const askBodySchema = z.object({
  question: z.string().trim().min(1, "Ask a question first.").max(COPILOT_MAX_QUESTION_LENGTH),
  history: z
    .array(z.object({ question: z.string().max(2000), answer: z.string().max(2000) }))
    .max(20)
    .optional()
    .transform((pairs) => (pairs ?? []).slice(-COPILOT_HISTORY_PAIRS)),
});

export type AskBody = z.infer<typeof askBodySchema>;
