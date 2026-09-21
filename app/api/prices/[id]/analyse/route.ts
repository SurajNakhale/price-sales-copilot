import { NextResponse, type NextRequest } from "next/server";

import { analysePriceList } from "@/lib/analyse";
import { errorResponse } from "@/lib/api-errors";

/**
 * Normalises one downloaded price list and compares it with the current one.
 * Sends the file's top rows to Gemini, so the page only calls this when the
 * user presses Analyse. Takes the file ID from the URL; nothing else.
 */
export async function POST(_request: NextRequest, ctx: RouteContext<"/api/prices/[id]/analyse">) {
  try {
    const { id } = await ctx.params;
    const review = await analysePriceList(id);
    return NextResponse.json(review);
  } catch (error) {
    return errorResponse(error);
  }
}
