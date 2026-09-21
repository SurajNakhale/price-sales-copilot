import { randomBytes } from "node:crypto";

import { NextResponse, type NextRequest } from "next/server";

import { errorResponse } from "@/lib/api-errors";
import { OAUTH_DRAFTS_COOKIE, OAUTH_RETURN_COOKIE, OAUTH_STATE_COOKIE } from "@/lib/config";
import { getAuthUrl, safeReturnPath } from "@/lib/google/oauth";

/**
 * Starts the OAuth flow: sets a one-time state cookie, then hands over to Google.
 *
 * `?drafts=1` asks for the draft permission as well as read-only access, and
 * `?returnTo=/price-updates/<id>` (checked, and ignored if it is anything else)
 * brings the user back to that workflow page instead of the dashboard.
 */
export async function GET(request: NextRequest) {
  try {
    const drafts = request.nextUrl.searchParams.get("drafts") === "1";
    const returnTo = safeReturnPath(request.nextUrl.searchParams.get("returnTo"));

    const state = randomBytes(16).toString("hex");
    const response = NextResponse.redirect(getAuthUrl(state, { drafts }));

    const cookie = {
      httpOnly: true,
      sameSite: "lax" as const,
      path: "/",
      maxAge: 600,
      secure: process.env.NODE_ENV === "production",
    };
    response.cookies.set(OAUTH_STATE_COOKIE, state, cookie);
    if (drafts) response.cookies.set(OAUTH_DRAFTS_COOKIE, "1", cookie);
    if (returnTo) response.cookies.set(OAUTH_RETURN_COOKIE, returnTo, cookie);

    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
