import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/api-errors";
import { forgetConnectedAddress } from "@/lib/gmail/drafts";
import { clearTokens } from "@/lib/google/oauth";

/** Forgets the stored tokens. Access can also be revoked from the Google account page. */
export async function POST() {
  try {
    await clearTokens();
    forgetConnectedAddress();
    return NextResponse.json({ connected: false });
  } catch (error) {
    return errorResponse(error);
  }
}
