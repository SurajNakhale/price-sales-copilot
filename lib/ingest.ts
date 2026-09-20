import "server-only";

import { hasAllowedExtension } from "@/lib/config";
import { NotConnectedError, errorMessage } from "@/lib/errors";
import {
  downloadAttachment,
  extractAttachmentParts,
  findAttachmentPart,
  getMessage,
  gmailClient,
  headerValue,
  messageDate,
  searchPriceListMessages,
} from "@/lib/gmail/price-list-emails";
import { asConnectionError, getAuthorizedClient } from "@/lib/google/oauth";
import {
  findManifestEntry,
  readManifest,
  saveAttachment,
  writeManifest,
} from "@/lib/storage/new-price-lists";
import type {
  Candidate,
  IngestItem,
  IngestReport,
  Selection,
} from "@/lib/types";

/**
 * Reads Gmail and reports what could be downloaded. Saves nothing.
 */
export async function scanPriceLists(): Promise<Candidate[]> {
  const auth = await getAuthorizedClient();
  const gmail = gmailClient(auth);

  try {
    const [messageIds, manifest] = await Promise.all([
      searchPriceListMessages(gmail),
      readManifest(),
    ]);

    const messages = await Promise.all(
      messageIds.map((id) => getMessage(gmail, id)),
    );

    const candidates: Candidate[] = [];
    for (const message of messages) {
      const messageId = message.id;
      if (!messageId) continue;

      const from = headerValue(message, "From");
      const subject = headerValue(message, "Subject");
      const emailDate = messageDate(message);

      for (const part of extractAttachmentParts(message.payload)) {
        const existing = findManifestEntry(manifest, messageId, part.partId);
        candidates.push({
          messageId,
          partId: part.partId,
          filename: part.filename,
          sizeBytes: part.sizeBytes,
          from,
          subject,
          emailDate,
          alreadyDownloaded: Boolean(existing),
          savedAs: existing?.savedAs,
        });
      }
    }

    // Newest email first.
    candidates.sort((a, b) => b.emailDate.localeCompare(a.emailDate));
    return candidates;
  } catch (error) {
    throw asConnectionError(error);
  }
}

/**
 * Downloads the chosen attachments. The client sends only ids, so filenames and
 * metadata are re-derived from Gmail here. One bad attachment never stops the rest.
 */
export async function downloadSelected(
  selection: Selection[],
): Promise<IngestReport> {
  const auth = await getAuthorizedClient();
  const gmail = gmailClient(auth);

  const manifest = await readManifest();
  const manifestLengthBefore = manifest.length;
  const items: IngestItem[] = [];

  for (const { messageId, partId } of selection) {
    try {
      const message = await getMessage(gmail, messageId);
      const part = findAttachmentPart(message.payload, partId);

      if (!part) {
        items.push({
          messageId,
          partId,
          filename: "(unknown)",
          status: "failed",
          message: "That attachment is no longer in the message.",
        });
        continue;
      }

      // Re-checked here too: the scan's filter is never trusted on the way back in.
      if (!hasAllowedExtension(part.filename)) {
        items.push({
          messageId,
          partId,
          filename: part.filename,
          status: "failed",
          message: "Not an .xlsx or .csv file.",
        });
        continue;
      }

      const contents = await downloadAttachment(gmail, messageId, part);
      const result = await saveAttachment({
        manifest,
        messageId,
        partId,
        originalName: part.filename,
        contents,
        from: headerValue(message, "From"),
        subject: headerValue(message, "Subject"),
        emailDate: messageDate(message),
      });

      items.push({
        messageId,
        partId,
        filename: part.filename,
        status: result.status,
        savedAs: result.savedAs,
        message: result.message,
      });
    } catch (error) {
      const mapped = asConnectionError(error);
      // A revoked or expired grant kills the whole run, not just this item.
      if (mapped instanceof NotConnectedError) {
        if (manifest.length > manifestLengthBefore) await writeManifest(manifest);
        throw mapped;
      }
      items.push({
        messageId,
        partId,
        filename: "(unknown)",
        status: "failed",
        message: errorMessage(error),
      });
    }
  }

  if (manifest.length > manifestLengthBefore) {
    await writeManifest(manifest);
  }

  return {
    items,
    downloaded: items.filter((item) => item.status === "downloaded").length,
    skipped: items.filter((item) => item.status === "skipped-duplicate").length,
    failed: items.filter((item) => item.status === "failed").length,
  };
}
