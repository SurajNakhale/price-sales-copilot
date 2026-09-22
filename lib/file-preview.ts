import { headerCells } from "./normalize";
import type { Cell, ColumnMapping, ParsedSheet, RowIssue } from "./types";

/**
 * A downloaded price list laid out for viewing as received (workflow step 1,
 * context/ui-design.md §2.4a): cells exactly as stored, cut to a readable
 * number of rows. Once the file is analysed, the sheet it read is marked with
 * its header row, which column became which field, and the rows it skipped.
 * Pure, and safe to import in the browser.
 */

/** Rows shown per sheet; the rest are one download away. */
export const PREVIEW_MAX_ROWS = 500;

export type ColumnRole = "Model" | "Category" | "Dealer price" | "MRP";

export interface PreviewSheet {
  /** The workbook's sheet name; null for a csv. */
  name: string | null;
  /** Rows in the sheet, after trailing blank rows are dropped. */
  totalRows: number;
  columnCount: number;
  /** The first rows, each padded to `columnCount` with nulls. */
  rows: Cell[][];
  truncated: boolean;
  /** Whether Feature 2's analysis read this sheet. */
  used: boolean;
  /** 1-based header row, from the analysis; null before it. */
  headerRow: number | null;
  /** Per column, the field the analysis mapped it to, or null. */
  columnRoles: (ColumnRole | null)[];
  /** Per column, whether most of its filled cells are figures, so the column aligns right. */
  numericColumns: boolean[];
  /** Rows the analysis could not use, by 1-based row number. */
  issues: RowIssue[];
}

/** What the analysis recorded about the file, when it has been analysed. */
export interface AnalysedSheet {
  sheet: string | null;
  mapping: ColumnMapping;
  issues: RowIssue[];
}

/** 0 → A, 25 → Z, 26 → AA, as a spreadsheet names its columns. */
export function columnLetter(index: number): string {
  let letters = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  }
  return letters;
}

export function buildPreview(
  sheets: ParsedSheet[],
  { maxRows = PREVIEW_MAX_ROWS, analysed = null }: { maxRows?: number; analysed?: AnalysedSheet | null } = {},
): PreviewSheet[] {
  // The analysis read the first sheet with content, and recorded its name (null for a csv).
  const usedIndex = analysed ? sheets.findIndex((sheet) => sheet.sheet === analysed.sheet) : -1;

  return sheets.map((sheet, index) => {
    const columnCount = Math.max(0, ...sheet.rows.map((row) => row.length));
    const rows = sheet.rows
      .slice(0, maxRows)
      .map((row) => Array.from({ length: columnCount }, (_, column) => row[column] ?? null));
    const used = index === usedIndex;
    const mapping = used && analysed ? analysed.mapping : null;

    return {
      name: sheet.sheet,
      totalRows: sheet.rows.length,
      columnCount,
      rows,
      truncated: sheet.rows.length > rows.length,
      used,
      headerRow: mapping ? mapping.headerRow : null,
      columnRoles: mapping ? columnRoles(sheet, mapping, columnCount) : Array(columnCount).fill(null),
      numericColumns: Array.from({ length: columnCount }, (_, column) => isNumericColumn(rows, column)),
      issues: used && analysed ? analysed.issues : [],
    };
  });
}

/** At least half the filled cells in the shown rows read as figures; a header or title row does not tip it. */
function isNumericColumn(rows: Cell[][], column: number): boolean {
  const filled = rows.map((row) => row[column]).filter((cell) => cell !== null && String(cell).trim() !== "");
  return filled.length > 0 && filled.filter(looksNumeric).length * 2 >= filled.length;
}

/** The same lookup `applyMapping` uses: a mapped name is found by its trimmed header text. */
function columnRoles(sheet: ParsedSheet, mapping: ColumnMapping, columnCount: number): (ColumnRole | null)[] {
  const roles: (ColumnRole | null)[] = Array(columnCount).fill(null);
  const header = headerCells(sheet, mapping.headerRow) ?? [];
  const mark = (name: string | null, role: ColumnRole) => {
    if (name === null) return;
    const at = header.indexOf(name.trim());
    if (at >= 0) roles[at] = role;
  };
  mark(mapping.columns.model, "Model");
  mark(mapping.columns.category, "Category");
  mark(mapping.columns.dealerPrice, "Dealer price");
  mark(mapping.columns.mrp, "MRP");
  return roles;
}

/**
 * Whether a cell reads as a figure, so it lines up on the right like every
 * other number in the app. A csv stores "7500" as text, hence the pattern.
 */
export function looksNumeric(cell: Cell): boolean {
  if (typeof cell === "number") return true;
  return typeof cell === "string" && /^\s*(₹|Rs\.?|INR)?\s*-?\d[\d,]*(\.\d+)?\s*$/i.test(cell);
}

/** A cell as the viewer shows it: the stored value as text, untrimmed, blank for empty. */
export function displayCell(cell: Cell): string {
  return cell === null ? "" : String(cell);
}
