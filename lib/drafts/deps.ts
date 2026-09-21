import "server-only";

import { readDealers, readSales } from "@/lib/data/mock-data";
import { readDraftState, writeDraftState } from "@/lib/storage/drafts";
import { readReview } from "@/lib/storage/price-reviews";
import type { Dealer, PriceReview, SalesLine } from "@/lib/types";

import type { DraftState } from "./types";

/**
 * What the two draft services read and write, gathered in one place so tests
 * can hand them in-memory versions. The defaults are the real files.
 */
export interface DraftDeps {
  readReview(fileId: string): Promise<PriceReview | null>;
  readData(): Promise<{ sales: SalesLine[]; dealers: Dealer[] }>;
  readState(fileId: string): Promise<DraftState | null>;
  writeState(state: DraftState): Promise<void>;
  now(): Date;
}

export function defaultDraftDeps(): DraftDeps {
  return {
    readReview,
    readData: async () => {
      const [sales, dealers] = await Promise.all([readSales(), readDealers()]);
      return { sales, dealers };
    },
    readState: readDraftState,
    writeState: writeDraftState,
    now: () => new Date(),
  };
}
