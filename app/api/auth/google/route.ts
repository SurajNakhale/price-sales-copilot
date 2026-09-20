import { randomBytes } from "node:crypto";

import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/api-errors";
import { OAUTH_STATE_COOKIE } from "@/lib/config";
import { getAuthUrl } from "@/lib/google/oauth";

/** Starts the OAuth flow: sets a one-time state cookie, then hands over to Google. */
export async function GET() {
  try {
    const state = randomBytes(16).toString("hex");
    const response = NextResponse.redirect(getAuthUrl(state));

    response.cookies.set(OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 600,
      secure: process.env.NODE_ENV === "production",
    });

    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
