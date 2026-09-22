import "server-only";

import { NotFoundError } from "@/lib/errors";
import { buildPreview, type PreviewSheet } from "@/lib/file-preview";
import { parseAllSheets } from "@/lib/parse/spreadsheet";
import { isNotFound } from "@/lib/storage/json-file";
import { findPriceList, readRawPriceList } from "@/lib/storage/price-reviews";
import type { ManifestEntry, NormalizedPriceList } from "@/lib/types";

/**
 * Workflow step 1: a downloaded price list as received. Read-only. The bytes
 * Feature 1 saved are never changed; the viewer reads them and the download
 * returns them untouched.
 */

export type FilePreview =
  | { ok: true; bytes: number; sheets: PreviewSheet[] }
  | { ok: false; problem: "missing" | "unreadable"; reason: string };

export interface FileViewDeps {
  find: (fileId: string) => Promise<ManifestEntry | null>;
  readRaw: (entry: ManifestEntry) => Promise<Buffer>;
}

const defaultDeps: FileViewDeps = { find: findPriceList, readRaw: readRawPriceList };

/**
 * The file laid out for the page. A missing or unreadable file comes back as a
 * problem to show, not an error, so one bad file never breaks the workflow page.
 */
export async function readPriceListPreview(
  entry: ManifestEntry,
  normalized: NormalizedPriceList | null,
  deps: Pick<FileViewDeps, "readRaw"> = defaultDeps,
): Promise<FilePreview> {
  let contents: Buffer;
  try {
    contents = await deps.readRaw(entry);
  } catch (error) {
    if (isNotFound(error)) {
      return {
        ok: false,
        problem: "missing",
        reason: `${entry.savedAs} is in the manifest but no longer in mock-data/new-price-lists/.`,
      };
    }
    throw error;
  }

  try {
    const sheets = await parseAllSheets(entry.savedAs, contents);
    const analysed = normalized
      ? { sheet: normalized.sheet, mapping: normalized.mapping, issues: normalized.issues }
      : null;
    return { ok: true, bytes: contents.length, sheets: buildPreview(sheets, { analysed }) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, problem: "unreadable", reason: `The file could not be read: ${reason}` };
  }
}

export interface PriceListFile {
  bytes: Buffer;
  filename: string;
  contentType: string;
}

/** The original bytes, for "Download original". */
export async function readPriceListFile(fileId: string, deps: FileViewDeps = defaultDeps): Promise<PriceListFile> {
  const entry = await deps.find(fileId);
  if (!entry) throw new NotFoundError("No downloaded price list has that ID.");
  try {
    return { bytes: await deps.readRaw(entry), filename: entry.savedAs, contentType: contentTypeFor(entry.savedAs) };
  } catch (error) {
    if (isNotFound(error)) throw new NotFoundError(`${entry.savedAs} is no longer in mock-data/new-price-lists/.`);
    throw error;
  }
}

export function contentTypeFor(filename: string): string {
  return filename.toLowerCase().endsWith(".csv")
    ? "text/csv; charset=utf-8"
    : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
}

/**
 * `attachment`, so the browser saves the file rather than rendering it. The
 * plain `filename` is an ASCII fallback; `filename*` carries the real name
 * (RFC 6266 / 5987).
 */
export function contentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
