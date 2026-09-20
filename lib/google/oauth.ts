import "server-only";

import { google, type Auth } from "googleapis";

import {
  DEFAULT_REDIRECT_URI,
  GMAIL_SCOPES,
  TOKEN_FILE,
} from "@/lib/config";
import { MissingConfigError, NotConnectedError } from "@/lib/errors";
import {
  readJsonFile,
  removeFile,
  writeJsonFileAtomic,
} from "@/lib/storage/json-file";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new MissingConfigError(
      `Missing environment variable ${name}. Copy .env.example to .env.local and fill it in.`,
    );
  }
  return value;
}

export function createOAuthClient(): Auth.OAuth2Client {
  return new google.auth.OAuth2(
    requireEnv("GOOGLE_CLIENT_ID"),
    requireEnv("GOOGLE_CLIENT_SECRET"),
    process.env.GOOGLE_REDIRECT_URI || DEFAULT_REDIRECT_URI,
  );
}

/** Consent URL. `access_type: offline` + `prompt: consent` so a refresh token comes back. */
export function getAuthUrl(state: string): string {
  return createOAuthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: GMAIL_SCOPES,
    state,
  });
}

export async function loadTokens(): Promise<Auth.Credentials | null> {
  return readJsonFile<Auth.Credentials>(TOKEN_FILE);
}

export async function saveTokens(tokens: Auth.Credentials): Promise<void> {
  // 0o600: the file holds a refresh token.
  await writeJsonFileAtomic(TOKEN_FILE, tokens, { mode: 0o600 });
}

export async function clearTokens(): Promise<void> {
  await removeFile(TOKEN_FILE);
}

export async function isConnected(): Promise<boolean> {
  const tokens = await loadTokens();
  return Boolean(tokens?.refresh_token || tokens?.access_token);
}

/** Exchanges the one-time code from the OAuth callback and stores the tokens. */
export async function exchangeCodeForTokens(code: string): Promise<void> {
  const client = createOAuthClient();
  const { tokens } = await client.getToken(code);
  await saveTokens(tokens);
}

/**
 * An OAuth client carrying the stored tokens. Tokens the library refreshes are
 * written back, so a refreshed access token survives a restart.
 */
export async function getAuthorizedClient(): Promise<Auth.OAuth2Client> {
  const stored = await loadTokens();
  if (!stored?.refresh_token && !stored?.access_token) {
    throw new NotConnectedError();
  }

  const client = createOAuthClient();
  client.setCredentials(stored);

  client.on("tokens", (fresh) => {
    // `fresh` is partial: the refresh token only arrives on the first consent.
    void saveTokens({ ...stored, ...fresh }).catch((error: unknown) => {
      console.error("Could not persist refreshed Google tokens:", error);
    });
  });

  return client;
}

/**
 * True when Google rejected the grant (revoked access, expired refresh token —
 * which happens after 7 days while the consent screen is in Testing mode).
 */
export function isInvalidGrant(error: unknown): boolean {
  const candidate = error as {
    message?: string;
    response?: { data?: { error?: string } };
  };
  return (
    candidate?.response?.data?.error === "invalid_grant" ||
    /invalid_grant/i.test(candidate?.message ?? "")
  );
}

/** Turns an expired or revoked grant into the "reconnect" state. */
export function asConnectionError(error: unknown): unknown {
  if (isInvalidGrant(error)) {
    return new NotConnectedError(
      "Gmail access has expired or was revoked. Connect Gmail again.",
    );
  }
  return error;
}
