import { NextResponse, type NextRequest } from "next/server";

import { errorResponse } from "@/lib/api-errors";
import { BadRequestError } from "@/lib/errors";
import { downloadSelected } from "@/lib/ingest";
import type { Selection } from "@/lib/types";

const MAX_SELECTION = 100;

/** Accepts ids only; filenames and metadata are re-read from Gmail server-side. */
function parseSelection(body: unknown): Selection[] {
  const rows = (body as { selection?: unknown })?.selection;
  if (!Array.isArray(rows)) {
    throw new BadRequestError("Expected a JSON body of { selection: [...] }.");
  }
  if (rows.length > MAX_SELECTION) {
    throw new BadRequestError(`Select at most ${MAX_SELECTION} attachments at once.`);
  }

  return rows.map((row, index) => {
    const { messageId, partId } = (row ?? {}) as Record<string, unknown>;
    if (typeof messageId !== "string" || !messageId) {
      throw new BadRequestError(`selection[${index}] has no messageId.`);
    }
    if (typeof partId !== "string") {
      throw new BadRequestError(`selection[${index}] has no partId.`);
    }
    return { messageId, partId };
  });
}

export async function POST(request: NextRequest) {
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new BadRequestError("Expected a JSON body of { selection: [...] }.");
    }

    const report = await downloadSelected(parseSelection(body));
    return NextResponse.json(report);
  } catch (error) {
    return errorResponse(error);
  }
}
