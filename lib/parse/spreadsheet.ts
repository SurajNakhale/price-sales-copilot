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
  const sheets = await parseAllSheets(filename, contents);
  return sheets.find((sheet) => sheet.rows.length > 0) ?? sheets[0] ?? { sheet: null, rows: [] };
}

/**
 * Every sheet of a supplier file, for viewing it as received. A csv is one
 * sheet with no name. A workbook's sheets with content come in their order;
 * when none has any, the first empty one stands in, so the name still shows.
 */
export async function parseAllSheets(filename: string, contents: Buffer): Promise<ParsedSheet[]> {
  const lower = filename.toLowerCase();

  if (lower.endsWith(".csv")) {
    return [{ sheet: null, rows: trimTrailingBlankRows(parseCsv(contents.toString("utf8"))) }];
  }

  if (lower.endsWith(".xlsx")) {
    const sheets = (await readXlsxFile(contents)).map(({ sheet, data }) => ({
      sheet,
      rows: trimTrailingBlankRows(data.map((row) => row.map(toCell))),
    }));
    const withContent = sheets.filter((sheet) => sheet.rows.length > 0);
    return withContent.length > 0 ? withContent : sheets.slice(0, 1);
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
