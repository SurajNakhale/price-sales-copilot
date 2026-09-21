import "server-only";

import { comparePriceList } from "@/lib/compare";
import { LLM_SAMPLE_ROWS, MAX_PRICE_LIST_ROWS } from "@/lib/config";
import { readProducts } from "@/lib/data/mock-data";
import { ConflictError, NotFoundError, UnusableFileError, errorMessage } from "@/lib/errors";
import { geminiLlm, type LlmPort } from "@/lib/llm";
import { matchRows } from "@/lib/match";
import { applyMapping, checkMapping } from "@/lib/normalize";
import { parseSpreadsheet } from "@/lib/parse/spreadsheet";
import {
  findPriceList,
  readRawPriceList,
  readReview,
  writeNormalized,
  writeReview,
} from "@/lib/storage/price-reviews";
import type { NormalizedPriceList, PriceReview } from "@/lib/types";

/**
 * Feature 2, steps 1–2 for one downloaded file:
 *
 *   parse → LLM column mapping → normalise (code) → match (code, then LLM)
 *   → .data/normalized/<fileId>.json → compare (code) → .data/reviews/<fileId>.json
 *
 * A failure is recorded as a failed review with the reason, so the list and
 * the workflow page can show it and offer Retry, and is then rethrown.
 */
export async function analysePriceList(
  fileId: string,
  llm: LlmPort = geminiLlm,
): Promise<PriceReview> {
  const entry = await findPriceList(fileId);
  if (!entry) throw new NotFoundError("No downloaded price list has that ID.");

  const previous = await readReview(fileId);
  if (previous?.status === "approved") {
    throw new ConflictError("This price list has already been approved, so it cannot be analysed again.");
  }

  try {
    const sheet = await parseSpreadsheet(entry.savedAs, await readRawPriceList(entry));
    if (sheet.rows.length === 0) throw new UnusableFileError("The file has no rows.");
    if (sheet.rows.length > MAX_PRICE_LIST_ROWS) {
      throw new UnusableFileError(
        `The file has ${sheet.rows.length} rows; at most ${MAX_PRICE_LIST_ROWS} can be analysed.`,
      );
    }

    const mapping = await llm.proposeColumnMapping(
      {
        filename: entry.originalName,
        from: entry.from,
        subject: entry.subject,
        sheet: sheet.sheet,
        rows: sheet.rows
          .slice(0, LLM_SAMPLE_ROWS)
          .map((cells, index) => ({ rowNumber: index + 1, cells })),
      },
      (proposal) => checkMapping(sheet, proposal),
    );

    const { rows: mapped, issues } = applyMapping(sheet, mapping, mapping.brand);
    if (mapped.length === 0) {
      throw new UnusableFileError(
        issues.length > 0
          ? `No usable rows: ${issues.length} rows had problems, for example row ${issues[0].rowNumber}: ${issues[0].reason}`
          : "No product rows were found below the header row.",
      );
    }

    const products = await readProducts();
    const normalized: NormalizedPriceList = {
      fileId,
      sourceFile: entry.savedAs,
      sheet: sheet.sheet,
      brand: mapping.brand,
      mapping,
      rows: await matchRows(mapping.brand, mapped, products, llm),
      issues,
      normalizedAt: new Date().toISOString(),
    };
    await writeNormalized(normalized);

    const { items, unchanged } = comparePriceList(normalized, products);
    const review: PriceReview = {
      fileId,
      sourceFile: entry.savedAs,
      brand: normalized.brand,
      status: items.length > 0 ? "needs-review" : "no-changes",
      rowsInFile: normalized.rows.length + issues.length,
      unchanged,
      issues: issues.length,
      items,
      analysedAt: normalized.normalizedAt,
    };
    await writeReview(review);
    return review;
  } catch (error) {
    await writeReview({
      fileId,
      sourceFile: entry.savedAs,
      brand: null,
      status: "failed",
      rowsInFile: 0,
      unchanged: 0,
      issues: 0,
      items: [],
      analysedAt: new Date().toISOString(),
      error: errorMessage(error),
    });
    throw error;
  }
}
