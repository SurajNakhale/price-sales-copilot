import { createHash } from "node:crypto";

/**
 * The stable ID of one downloaded price list: the first 12 hex characters of
 * sha256(messageId + NUL + partId), the same pair that identifies it in the
 * manifest. Routes and URLs carry this, never a filename or path.
 */
export function fileIdFor(entry: { messageId: string; partId: string }): string {
  return createHash("sha256")
    .update(`${entry.messageId}\u0000${entry.partId}`)
    .digest("hex")
    .slice(0, 12);
}

export function isFileId(value: string): boolean {
  return /^[0-9a-f]{12}$/.test(value);
}
