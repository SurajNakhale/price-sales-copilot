import "server-only";

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { MANIFEST_FILE, NEW_PRICE_LIST_DIR } from "@/lib/config";
import type { ManifestEntry } from "@/lib/types";

import { isNotFound, readJsonFile, writeJsonFileAtomic } from "./json-file";

const MAX_FILENAME_LENGTH = 120;
const MAX_COLLISION_ATTEMPTS = 50;

/**
 * Reduces a filename from an email to something safe to write into one folder:
 * directories are stripped, so `../../x.xlsx` becomes `x.xlsx`, and characters
 * that are unsafe on Windows or in shells are replaced.
 */
export function sanitizeFilename(input: string): string {
  const base = input.split(/[\\/]/).pop() ?? "";

  const cleaned = base
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "");

  if (!cleaned) return "attachment";
  if (cleaned.length <= MAX_FILENAME_LENGTH) return cleaned;

  const extension = path.extname(cleaned);
  return cleaned.slice(0, MAX_FILENAME_LENGTH - extension.length) + extension;
}

export function manifestKey(messageId: string, partId: string): string {
  return `${messageId}\u0000${partId}`;
}

export function findManifestEntry(
  manifest: ManifestEntry[],
  messageId: string,
  partId: string,
): ManifestEntry | undefined {
  const key = manifestKey(messageId, partId);
  return manifest.find((entry) => manifestKey(entry.messageId, entry.partId) === key);
}

export async function readManifest(): Promise<ManifestEntry[]> {
  const entries = await readJsonFile<ManifestEntry[]>(MANIFEST_FILE);
  return Array.isArray(entries) ? entries : [];
}

export async function writeManifest(entries: ManifestEntry[]): Promise<void> {
  await writeJsonFileAtomic(MANIFEST_FILE, entries);
}

function sha256(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

async function sha256OfFile(filePath: string): Promise<string | null> {
  try {
    return sha256(await fs.readFile(filePath));
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/**
 * Picks the name to save under. The first free name wins; if a name is taken by
 * a file with identical contents we stop there and report it, so the same
 * attachment is never stored twice and a different file is never overwritten.
 */
async function resolveTarget(
  directory: string,
  safeName: string,
  digest: string,
  messageId: string,
): Promise<{ savedAs: string; identical: boolean }> {
  const extension = path.extname(safeName);
  const stem = safeName.slice(0, safeName.length - extension.length);
  const suffix = messageId.slice(0, 8);

  const names = [safeName, `${stem}__${suffix}${extension}`];
  for (let attempt = 2; attempt <= MAX_COLLISION_ATTEMPTS; attempt++) {
    names.push(`${stem}__${suffix}-${attempt}${extension}`);
  }

  for (const name of names) {
    const existing = await sha256OfFile(path.join(directory, name));
    if (existing === null) return { savedAs: name, identical: false };
    if (existing === digest) return { savedAs: name, identical: true };
  }

  throw new Error(`Too many filename collisions for "${safeName}".`);
}

export interface SaveAttachmentInput {
  /** Read once by the caller and appended to here; written back in one go. */
  manifest: ManifestEntry[];
  messageId: string;
  partId: string;
  originalName: string;
  contents: Buffer;
  from: string;
  subject: string;
  emailDate: string;
}

export interface SaveAttachmentResult {
  status: "downloaded" | "skipped-duplicate";
  savedAs: string;
  message?: string;
  /** Set when the manifest gained an entry and needs writing. */
  entry?: ManifestEntry;
}

export async function saveAttachment(
  input: SaveAttachmentInput,
): Promise<SaveAttachmentResult> {
  const alreadyDownloaded = findManifestEntry(
    input.manifest,
    input.messageId,
    input.partId,
  );
  if (alreadyDownloaded) {
    return {
      status: "skipped-duplicate",
      savedAs: alreadyDownloaded.savedAs,
      message: "Already downloaded earlier.",
    };
  }

  const digest = sha256(input.contents);
  const safeName = sanitizeFilename(input.originalName);

  await fs.mkdir(NEW_PRICE_LIST_DIR, { recursive: true });
  const { savedAs, identical } = await resolveTarget(
    NEW_PRICE_LIST_DIR,
    safeName,
    digest,
    input.messageId,
  );

  if (!identical) {
    // "wx" fails instead of overwriting, whatever the checks above concluded.
    // The folder is fixed; only the filename varies, so there is nothing for
    // the bundler to trace (it cannot see that through the imported constant).
    const filePath = path.join(/* turbopackIgnore: true */ NEW_PRICE_LIST_DIR, savedAs);
    await fs.writeFile(filePath, input.contents, { flag: "wx" });
  }

  const entry: ManifestEntry = {
    messageId: input.messageId,
    partId: input.partId,
    savedAs,
    originalName: input.originalName,
    from: input.from,
    subject: input.subject,
    emailDate: input.emailDate,
    sha256: digest,
    downloadedAt: new Date().toISOString(),
  };
  input.manifest.push(entry);

  return identical
    ? {
        status: "skipped-duplicate",
        savedAs,
        message: `Identical file already saved as ${savedAs}.`,
        entry,
      }
    : { status: "downloaded", savedAs, entry };
}
