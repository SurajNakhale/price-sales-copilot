import "server-only";

import readXlsxFile from "read-excel-file/node";

import type { Cell, ParsedSheet } from "@/lib/types";

import { parseCsv } from "./csv";

/**
 * Raw supplier file → rows of cells. Values only: read-excel-file returns the
 * cached result of a formula and never evaluates one. For a workbook, the
 * first sheet that has any content is used, and its name is recorded.
 */
export async function parseSpreadsheet(filename: string, contents: Buffer): Promise<ParsedSheet> {
  const lower = filename.toLowerCase();

  if (lower.endsWith(".csv")) {
    return { sheet: null, rows: trimTrailingBlankRows(parseCsv(contents.toString("utf8"))) };
  }

  if (lower.endsWith(".xlsx")) {
    const sheets = await readXlsxFile(contents);
    for (const { sheet, data } of sheets) {
      const rows = trimTrailingBlankRows(data.map((row) => row.map(toCell)));
      if (rows.length > 0) return { sheet, rows };
    }
    return { sheet: sheets[0]?.sheet ?? null, rows: [] };
  }

  throw new Error(`"${filename}" is not an .xlsx or .csv file.`);
}

function toCell(value: unknown): Cell {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return String(value);
}

function trimTrailingBlankRows(rows: Cell[][]): Cell[][] {
  let end = rows.length;
  while (end > 0 && rows[end - 1].every((cell) => cell === null || String(cell).trim() === "")) {
    end--;
  }
  return rows.slice(0, end);
}
