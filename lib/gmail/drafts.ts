import "server-only";

import type { Auth } from "googleapis";

import { MissingScopeError } from "@/lib/errors";
import { asConnectionError, getAuthorizedClient } from "@/lib/google/oauth";

import { gmailClient } from "./price-list-emails";

/**
 * The only Gmail calls Feature 3 makes: who the connected account is, and
 * creating a draft. The interface below has no send method, so sending is not
 * merely avoided: it cannot be written against this type. (The permission
 * itself could send; see GMAIL_COMPOSE_SCOPE in lib/config.ts.)
 */
export interface DraftsGmail {
  users: {
    getProfile(params: { userId: string }): Promise<{ data: { emailAddress?: string | null } }>;
    drafts: {
      create(params: {
        userId: string;
        requestBody: { message: { raw: string } };
      }): Promise<{ data: { id?: string | null; message?: { id?: string | null } | null } }>;
    };
  };
}

export function draftsClient(auth: Auth.OAuth2Client): DraftsGmail {
  return gmailClient(auth) as unknown as DraftsGmail;
}

/** The address of the connected account, lower-cased. */
export async function getConnectedAddress(gmail: DraftsGmail): Promise<string> {
  const { data } = await gmail.users.getProfile({ userId: "me" });
  const address = data.emailAddress?.trim().toLowerCase();
  if (!address) throw new Error("Gmail did not say which account is connected.");
  return address;
}

const CACHE_MS = 10 * 60 * 1000;
const LOOKUP_TIMEOUT_MS = 4000;
let cached: { address: string; at: number } | null = null;

/**
 * The connected address for the page to compare dealer addresses with, or null
 * when Gmail is not connected or cannot be asked. Never throws: the affected
 * dealers are shown either way, only the note about their addresses changes.
 */
export async function connectedAddressOrNull(): Promise<string | null> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.address;
  try {
    const auth = await getAuthorizedClient();
    const address = await Promise.race([
      getConnectedAddress(draftsClient(auth)),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), LOOKUP_TIMEOUT_MS)),
    ]);
    cached = { address, at: Date.now() };
    return address;
  } catch {
    return null;
  }
}

/** Forget the cached address, after Connect or Disconnect. */
export function forgetConnectedAddress(): void {
  cached = null;
}

/** Google answers 403 "insufficient authentication scopes" when the token lacks the draft permission. */
export function mapDraftError(error: unknown): unknown {
  const candidate = error as {
    code?: number | string;
    status?: number;
    message?: string;
    response?: { status?: number };
  };
  const status = Number(candidate?.response?.status ?? candidate?.status ?? candidate?.code);
  if (status === 403 && /insufficient|scope|permission/i.test(candidate?.message ?? "")) {
    return new MissingScopeError();
  }
  return asConnectionError(error);
}

export interface CreatedGmailDraft {
  draftId: string;
  messageId: string;
}

/** Saves a draft. It is never sent: the app has no code that sends. */
export async function createGmailDraftFromRaw(gmail: DraftsGmail, raw: string): Promise<CreatedGmailDraft> {
  let response;
  try {
    response = await gmail.users.drafts.create({ userId: "me", requestBody: { message: { raw } } });
  } catch (error) {
    throw mapDraftError(error);
  }
  const draftId = response.data.id;
  const messageId = response.data.message?.id;
  if (!draftId || !messageId) throw new Error("Gmail created the draft but did not say which one.");
  return { draftId, messageId };
}

/** Opens a draft's compose window in the browser. `authuser` picks the right account when several are signed in. */
export function openInGmailUrl(address: string, messageId: string): string {
  return `https://mail.google.com/mail/?authuser=${encodeURIComponent(address)}#drafts?compose=${encodeURIComponent(messageId)}`;
}
