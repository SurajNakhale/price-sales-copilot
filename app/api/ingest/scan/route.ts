import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/api-errors";
import { scanPriceLists } from "@/lib/ingest";

/** Read-only: lists the price-list attachments in Gmail. Saves nothing. */
export async function GET() {
  try {
    const candidates = await scanPriceLists();
    return NextResponse.json({ candidates });
  } catch (error) {
    return errorResponse(error);
  }
}
