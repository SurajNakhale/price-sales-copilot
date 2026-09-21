import { NextResponse, type NextRequest } from "next/server";

import { errorResponse } from "@/lib/api-errors";
import { askCopilot } from "@/lib/copilot/ask";
import { askBodySchema } from "@/lib/copilot/request";
import { BadRequestError } from "@/lib/errors";

/**
 * Answers one Sales Copilot question. Sends the question and tool results to
 * Gemini (never the datasets or any email address) and returns the steps, the
 * tables and a checked sentence.
 */
export async function POST(request: NextRequest) {
  try {
    const json: unknown = await request.json().catch(() => {
      throw new BadRequestError("The request body must be JSON.");
    });
    const parsed = askBodySchema.safeParse(json);
    if (!parsed.success) {
      throw new BadRequestError(
        parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; "),
      );
    }
    const answer = await askCopilot(parsed.data.question, parsed.data.history);
    return NextResponse.json(answer);
  } catch (error) {
    return errorResponse(error);
  }
}
