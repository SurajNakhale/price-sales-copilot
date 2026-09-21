import { NextResponse, type NextRequest } from "next/server";

import { errorResponse } from "@/lib/api-errors";
import { createGmailDraft } from "@/lib/create-draft";
import { createBodySchema } from "@/lib/drafts/request";
import { BadRequestError } from "@/lib/errors";

/**
 * Saves the dealer email as a Gmail draft: To is the connected account, Bcc is
 * the affected dealers. It never sends. Takes the file ID from the URL; the body
 * may only say `{ "another": true }` to confirm a second draft.
 */
export async function POST(request: NextRequest, ctx: RouteContext<"/api/prices/[id]/draft">) {
  try {
    const { id } = await ctx.params;
    const json: unknown = await request.json().catch(() => ({}));
    const body = createBodySchema.safeParse(json);
    if (!body.success) throw new BadRequestError("The body may only be { \"another\": true }.");

    const result = await createGmailDraft(id, { another: body.data.another === true });
    return NextResponse.json({ draft: result.draft, openUrl: result.openUrl });
  } catch (error) {
    return errorResponse(error);
  }
}
