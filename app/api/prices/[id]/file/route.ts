import type { NextRequest } from "next/server";

import { errorResponse } from "@/lib/api-errors";
import { contentDisposition, readPriceListFile } from "@/lib/file-view";

/**
 * The downloaded price list exactly as Feature 1 saved it, for "Download
 * original". Takes the file ID from the URL; the path comes from the manifest.
 */
export async function GET(_request: NextRequest, ctx: RouteContext<"/api/prices/[id]/file">) {
  try {
    const { id } = await ctx.params;
    const file = await readPriceListFile(id);
    return new Response(new Uint8Array(file.bytes), {
      headers: {
        "Content-Type": file.contentType,
        "Content-Disposition": contentDisposition(file.filename),
        "Content-Length": String(file.bytes.length),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
