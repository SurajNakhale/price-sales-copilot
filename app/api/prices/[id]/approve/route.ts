import { NextResponse, type NextRequest } from "next/server";

import { errorResponse } from "@/lib/api-errors";
import { approveReview } from "@/lib/approve";
import { BadRequestError } from "@/lib/errors";

const MAX_ITEMS = 500;

/** Accepts item IDs only; what they mean is re-read from the stored review. */
function parseItemIds(body: unknown): string[] {
  const itemIds = (body as { itemIds?: unknown })?.itemIds;
  if (!Array.isArray(itemIds) || !itemIds.every((id) => typeof id === "string" && id)) {
    throw new BadRequestError("Expected a JSON body of { itemIds: string[] }.");
  }
  if (itemIds.length > MAX_ITEMS) {
    throw new BadRequestError(`Approve at most ${MAX_ITEMS} changes at once.`);
  }
  return itemIds as string[];
}

export async function POST(request: NextRequest, ctx: RouteContext<"/api/prices/[id]/approve">) {
  try {
    const { id } = await ctx.params;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new BadRequestError("Expected a JSON body of { itemIds: string[] }.");
    }

    const review = await approveReview(id, parseItemIds(body));
    return NextResponse.json(review);
  } catch (error) {
    return errorResponse(error);
  }
}
