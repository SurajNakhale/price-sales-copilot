import "server-only";

import { findAffectedDealers, recipientLimitProblem } from "@/lib/affected";
import { defaultDraftDeps, type DraftDeps } from "@/lib/drafts/deps";
import { buildEmail } from "@/lib/drafts/message";
import { buildRawMessage } from "@/lib/drafts/mime";
import type { CreatedDraft, DraftState } from "@/lib/drafts/types";
import { ConflictError, MissingScopeError, NotFoundError } from "@/lib/errors";
import {
  createGmailDraftFromRaw,
  draftsClient,
  getConnectedAddress,
  mapDraftError,
  openInGmailUrl,
  type DraftsGmail,
} from "@/lib/gmail/drafts";
import { getAuthorizedClient, hasDraftPermission } from "@/lib/google/oauth";

/**
 * Feature 3, step 5, second half: save the email as a Gmail draft.
 *
 * To is the connected account, Bcc is every affected dealer, so they cannot see
 * one another. The app never sends: the draft is left in Gmail for the user to
 * review, edit and send. Nothing from the browser is trusted beyond the file ID:
 * the message comes from what was stored, and the recipients are recomputed here.
 */

export interface CreateOptions {
  /** Confirms a second draft when one already exists. */
  another?: boolean;
  deps?: DraftDeps;
  /** A Gmail client, in tests. Defaults to the connected account's. */
  gmail?: DraftsGmail;
  /** Whether the token may create drafts. Defaults to asking the stored token. */
  hasPermission?: () => Promise<boolean>;
}

export interface CreateResult {
  state: DraftState;
  draft: CreatedDraft;
  /** Opens the draft in Gmail. */
  openUrl: string;
}

export async function createGmailDraft(fileId: string, options: CreateOptions = {}): Promise<CreateResult> {
  const deps = options.deps ?? defaultDraftDeps();

  const review = await deps.readReview(fileId);
  if (!review) throw new NotFoundError("No analysed price list has that ID.");
  if (review.status !== "approved") {
    throw new ConflictError("This price list has not been approved yet, so there is nobody to notify.");
  }

  const state = await deps.readState(fileId);
  if (!state?.message) throw new ConflictError("Write the message first, then create the draft.");
  if (state.drafts.length > 0 && !options.another) {
    throw new ConflictError("A draft was already created for this price list. Confirm to create another.");
  }

  const { sales, dealers } = await deps.readData();
  const affected = findAffectedDealers({ review, sales, dealers });
  if (affected.models.length === 0) {
    throw new ConflictError("None of the approved changes was a price change, so there is nobody to notify.");
  }
  if (affected.recipients.length === 0) {
    throw new ConflictError("No affected dealer has a valid email address, so there is nobody to put in Bcc.");
  }
  const tooMany = recipientLimitProblem(affected.recipients);
  if (tooMany) throw new ConflictError(tooMany);

  let gmail: DraftsGmail;
  if (options.gmail) {
    gmail = options.gmail;
    if (!(await (options.hasPermission ?? (async () => true))())) throw new MissingScopeError();
  } else {
    // Not connected is reported first; only then is the missing permission.
    gmail = draftsClient(await getAuthorizedClient());
    if (!(await (options.hasPermission ?? hasDraftPermission)())) throw new MissingScopeError();
  }

  let to: string;
  try {
    to = await getConnectedAddress(gmail);
  } catch (error) {
    throw mapDraftError(error);
  }

  const brand = review.brand ?? affected.models[0].brand;
  const email = buildEmail(state.message, brand, affected.models);
  const raw = buildRawMessage({ to, bcc: affected.recipients, subject: email.subject, body: email.body });
  const created = await createGmailDraftFromRaw(gmail, raw);

  const draft: CreatedDraft = {
    draftId: created.draftId,
    messageId: created.messageId,
    createdAt: deps.now().toISOString(),
    to,
    recipients: affected.dealers.filter((dealer) => dealer.email !== null).length,
    addresses: affected.recipients.length,
    subject: email.subject,
  };

  const next: DraftState = { ...state, drafts: [...state.drafts, draft] };
  await deps.writeState(next);

  return { state: next, draft, openUrl: openInGmailUrl(to, created.messageId) };
}
