import "server-only";

import path from "node:path";

import { DRAFTS_DIR } from "@/lib/config";
import type { DraftState } from "@/lib/drafts/types";
import { isFileId } from "@/lib/file-id";

import { readJsonFile, writeJsonFileAtomic } from "./json-file";

/**
 * Feature 3's working state, one file per downloaded price list:
 * `.data/drafts/<fileId>.json` holds the message written for it and the Gmail
 * drafts made from it. The path is built from a validated file ID, never from
 * request input.
 */

function draftPath(fileId: string): string {
  return path.join(/* turbopackIgnore: true */ DRAFTS_DIR, `${fileId}.json`);
}

export async function readDraftState(fileId: string): Promise<DraftState | null> {
  if (!isFileId(fileId)) return null;
  return readJsonFile<DraftState>(draftPath(fileId));
}

export async function writeDraftState(state: DraftState): Promise<void> {
  if (!isFileId(state.fileId)) throw new Error("Not a valid file ID.");
  await writeJsonFileAtomic(draftPath(state.fileId), state);
}
