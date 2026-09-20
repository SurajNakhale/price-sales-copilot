import { timingSafeEqual } from "node:crypto";

import { NextResponse, type NextRequest } from "next/server";

import { OAUTH_STATE_COOKIE } from "@/lib/config";
import { errorMessage } from "@/lib/errors";
import { exchangeCodeForTokens } from "@/lib/google/oauth";

function sameState(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function backToHome(request: NextRequest, params: Record<string, string>) {
  const url = new URL("/", request.nextUrl.origin);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const response = NextResponse.redirect(url);
  response.cookies.delete(OAUTH_STATE_COOKIE);
  return response;
}

/** Google sends the user back here with a one-time code. */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;

  const denied = params.get("error");
  if (denied) {
    return backToHome(request, { connect_error: `Google said: ${denied}` });
  }

  const code = params.get("code");
  const state = params.get("state");
  const expectedState = request.cookies.get(OAUTH_STATE_COOKIE)?.value;

  if (!code || !state || !expectedState || !sameState(state, expectedState)) {
    return backToHome(request, {
      connect_error:
        "The sign-in could not be verified. Start from Connect Gmail again.",
    });
  }

  try {
    await exchangeCodeForTokens(code);
    return backToHome(request, { connected: "1" });
  } catch (error) {
    return backToHome(request, { connect_error: errorMessage(error) });
  }
}
