import * as z from "zod";

/** Bodies of the two draft routes. Both are optional: the file ID in the URL is the real input. Pure. */
export const messageBodySchema = z.object({
  /** Use the standard message and do not ask Gemini. */
  template: z.boolean().optional(),
});

export const createBodySchema = z.object({
  /** Confirms that a second draft is wanted when one already exists. */
  another: z.boolean().optional(),
});
