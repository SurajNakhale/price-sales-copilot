import { NextResponse, type NextRequest } from "next/server";

import { errorResponse } from "@/lib/api-errors";
import { messageBodySchema } from "@/lib/drafts/request";
import { BadRequestError } from "@/lib/errors";
import { prepareDraftMessage } from "@/lib/prepare-draft";

/**
 * Writes (or rewrites) the words of the dealer email for an approved price list.
 * Sends Gemini the brand and the changed products and prices, never a dealer.
 * Takes the file ID from the URL; the body may only say `{ "template": true }`.
 */
export async function POST(request: NextRequest, ctx: RouteContext<"/api/prices/[id]/draft/message">) {
  try {
    const { id } = await ctx.params;
    const json: unknown = await request.json().catch(() => ({}));
    const body = messageBodySchema.safeParse(json);
    if (!body.success) throw new BadRequestError("The body may only be { \"template\": true }.");

    const state = await prepareDraftMessage(id, { template: body.data.template === true });
    return NextResponse.json(state);
  } catch (error) {
    return errorResponse(error);
  }
}
