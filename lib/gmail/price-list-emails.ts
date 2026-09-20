import "server-only";

import { google, type Auth, type gmail_v1 } from "googleapis";

import { MAX_MESSAGES, buildGmailQuery, hasAllowedExtension } from "@/lib/config";

/** One attachment worth downloading, located inside a message's MIME tree. */
export interface AttachmentPart {
  partId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /** Set for normal attachments; fetched separately. */
  attachmentId?: string;
  /** Gmail inlines very small bodies instead of giving an attachmentId. */
  inlineData?: string;
}

export function gmailClient(auth: Auth.OAuth2Client): gmail_v1.Gmail {
  return google.gmail({ version: "v1", auth });
}

/**
 * Walks the MIME tree and returns only the parts whose filename ends in an
 * allowed extension, so a `terms.pdf` or `logo.png` beside a price list is
 * ignored. Pure: it takes a payload and returns rows, which keeps it testable.
 */
export function extractAttachmentParts(
  payload: gmail_v1.Schema$MessagePart | undefined | null,
): AttachmentPart[] {
  if (!payload) return [];

  const found: AttachmentPart[] = [];

  const walk = (part: gmail_v1.Schema$MessagePart, fallbackId: string): void => {
    // Gmail normally supplies partId ("0", "1", "1.1"); fall back to a path.
    const partId = part.partId ? part.partId : fallbackId;
    const filename = part.filename ?? "";

    if (filename && hasAllowedExtension(filename)) {
      found.push({
        partId,
        filename,
        mimeType: part.mimeType ?? "application/octet-stream",
        sizeBytes: part.body?.size ?? 0,
        attachmentId: part.body?.attachmentId ?? undefined,
        inlineData: part.body?.data ?? undefined,
      });
    }

    part.parts?.forEach((child, index) => {
      walk(child, partId === "" ? String(index) : `${partId}.${index}`);
    });
  };

  walk(payload, "root");
  return found;
}

export function findAttachmentPart(
  payload: gmail_v1.Schema$MessagePart | undefined | null,
  partId: string,
): AttachmentPart | undefined {
  return extractAttachmentParts(payload).find((part) => part.partId === partId);
}

export async function searchPriceListMessages(
  gmail: gmail_v1.Gmail,
): Promise<string[]> {
  const response = await gmail.users.messages.list({
    userId: "me",
    q: buildGmailQuery(),
    maxResults: MAX_MESSAGES,
  });

  return (response.data.messages ?? [])
    .map((message) => message.id)
    .filter((id): id is string => Boolean(id));
}

export async function getMessage(
  gmail: gmail_v1.Gmail,
  messageId: string,
): Promise<gmail_v1.Schema$Message> {
  const response = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "full",
  });
  return response.data;
}

export function headerValue(
  message: gmail_v1.Schema$Message,
  name: string,
): string {
  const header = message.payload?.headers?.find(
    (entry) => entry.name?.toLowerCase() === name.toLowerCase(),
  );
  return header?.value ?? "";
}

/** ISO 8601. `internalDate` is Gmail's own timestamp and beats the Date header. */
export function messageDate(message: gmail_v1.Schema$Message): string {
  if (message.internalDate) {
    const millis = Number(message.internalDate);
    if (Number.isFinite(millis)) return new Date(millis).toISOString();
  }

  const headerDate = headerValue(message, "Date");
  const parsed = headerDate ? new Date(headerDate) : null;
  if (parsed && !Number.isNaN(parsed.getTime())) return parsed.toISOString();

  return new Date(0).toISOString();
}

export async function downloadAttachment(
  gmail: gmail_v1.Gmail,
  messageId: string,
  part: AttachmentPart,
): Promise<Buffer> {
  if (part.inlineData) {
    return Buffer.from(part.inlineData, "base64url");
  }

  if (!part.attachmentId) {
    throw new Error(`Gmail gave no attachment data for "${part.filename}".`);
  }

  const response = await gmail.users.messages.attachments.get({
    userId: "me",
    messageId,
    id: part.attachmentId,
  });

  const data = response.data.data;
  if (!data) {
    throw new Error(`Gmail returned an empty body for "${part.filename}".`);
  }

  return Buffer.from(data, "base64url");
}
