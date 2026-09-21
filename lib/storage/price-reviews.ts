import "server-only";

import fs from "node:fs/promises";
import path from "node:path";

import { NEW_PRICE_LIST_DIR, NORMALIZED_DIR, REVIEWS_DIR } from "@/lib/config";
import { fileIdFor, isFileId } from "@/lib/file-id";
import type { ManifestEntry, NormalizedPriceList, PriceReview } from "@/lib/types";

import { isNotFound, readJsonFile, writeJsonFileAtomic } from "./json-file";
import { readManifest } from "./new-price-lists";

/**
 * Feature 2's working state, one pair of files per downloaded price list:
 *
 *   .data/normalized/<fileId>.json   the normalised object the comparison reads
 *   .data/reviews/<fileId>.json      the pending changes, then what was applied
 *
 * Every path is built from a validated file ID, never from request input.
 */

/** The manifest entry behind a file ID, or null if there is none. */
export async function findPriceList(fileId: string): Promise<ManifestEntry | null> {
  if (!isFileId(fileId)) return null;
  const manifest = await readManifest();
  return manifest.find((entry) => fileIdFor(entry) === fileId) ?? null;
}

/** The raw file as Feature 1 saved it. */
export async function readRawPriceList(entry: ManifestEntry): Promise<Buffer> {
  // savedAs comes from our own manifest, and the folder is fixed.
  return fs.readFile(path.join(/* turbopackIgnore: true */ NEW_PRICE_LIST_DIR, entry.savedAs));
}

function normalizedPath(fileId: string): string {
  return path.join(/* turbopackIgnore: true */ NORMALIZED_DIR, `${fileId}.json`);
}

function reviewPath(fileId: string): string {
  return path.join(/* turbopackIgnore: true */ REVIEWS_DIR, `${fileId}.json`);
}

export async function readNormalized(fileId: string): Promise<NormalizedPriceList | null> {
  if (!isFileId(fileId)) return null;
  return readJsonFile<NormalizedPriceList>(normalizedPath(fileId));
}

export async function writeNormalized(normalized: NormalizedPriceList): Promise<void> {
  await writeJsonFileAtomic(normalizedPath(normalized.fileId), normalized);
}

export async function readReview(fileId: string): Promise<PriceReview | null> {
  if (!isFileId(fileId)) return null;
  return readJsonFile<PriceReview>(reviewPath(fileId));
}

export async function writeReview(review: PriceReview): Promise<void> {
  await writeJsonFileAtomic(reviewPath(review.fileId), review);
}

/** Every review on disk. A missing folder means nothing has been analysed yet. */
export async function listReviews(): Promise<PriceReview[]> {
  let names: string[];
  try {
    names = await fs.readdir(REVIEWS_DIR);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }

  const reviews = await Promise.all(
    names
      .filter((name) => isFileId(name.replace(/\.json$/, "")) && name.endsWith(".json"))
      .map((name) => readReview(name.replace(/\.json$/, ""))),
  );
  return reviews.filter((review): review is PriceReview => review !== null);
}
