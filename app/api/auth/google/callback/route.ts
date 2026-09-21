import { timingSafeEqual } from "node:crypto";

import { NextResponse, type NextRequest } from "next/server";

import { OAUTH_DRAFTS_COOKIE, OAUTH_RETURN_COOKIE, OAUTH_STATE_COOKIE } from "@/lib/config";
import { errorMessage } from "@/lib/errors";
import { forgetConnectedAddress } from "@/lib/gmail/drafts";
import { exchangeCodeForTokens, hasDraftPermission, safeReturnPath } from "@/lib/google/oauth";

function sameState(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Back to where the flow started (the dashboard, or a workflow page), with a result in the query. */
function backTo(request: NextRequest, returnTo: string | null, params: Record<string, string>) {
  const url = new URL(returnTo ?? "/", request.nextUrl.origin);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const response = NextResponse.redirect(url);
  response.cookies.delete(OAUTH_STATE_COOKIE);
  response.cookies.delete(OAUTH_DRAFTS_COOKIE);
  response.cookies.delete(OAUTH_RETURN_COOKIE);
  return response;
}

/** Google sends the user back here with a one-time code. */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;

  const wantedDrafts = request.cookies.get(OAUTH_DRAFTS_COOKIE)?.value === "1";
  const returnTo = safeReturnPath(request.cookies.get(OAUTH_RETURN_COOKIE)?.value);
  // A failure is reported where the user was, under the name that page looks for.
  const failed = (message: string) =>
    backTo(request, returnTo, wantedDrafts ? { drafts: "error", connect_error: message } : { connect_error: message });

  const denied = params.get("error");
  if (denied) return failed(`Google said: ${denied}`);

  const code = params.get("code");
  const state = params.get("state");
  const expectedState = request.cookies.get(OAUTH_STATE_COOKIE)?.value;

  if (!code || !state || !expectedState || !sameState(state, expectedState)) {
    return failed("The sign-in could not be verified. Start again from Connect Gmail.");
  }

  try {
    await exchangeCodeForTokens(code);
    forgetConnectedAddress();

    if (!wantedDrafts) return backTo(request, returnTo, { connected: "1" });

    // Google lets the user untick a permission, so ask the token rather than assume.
    return (await hasDraftPermission())
      ? backTo(request, returnTo, { drafts: "granted" })
      : backTo(request, returnTo, { drafts: "denied" });
  } catch (error) {
    return failed(errorMessage(error));
  }
}
