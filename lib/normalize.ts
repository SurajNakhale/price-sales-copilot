import { createMatchingKey } from "./matching-key";
import type { Brand, Cell, ColumnMapping, MappedRow, ParsedSheet, RowIssue } from "./types";

/**
 * Applies the LLM's column mapping to every row of a supplier file. Prices are
 * copied from the cells here, by code; the LLM only said which column is
 * which. Pure.
 */

/** A cell as trimmed text. */
export function cellText(cell: Cell | undefined): string {
  if (cell === null || cell === undefined) return "";
  return String(cell).trim();
}

export function isBlankRow(row: Cell[]): boolean {
  return row.every((cell) => cellText(cell) === "");
}

/** The header row's cells as text, or null if the row does not exist. */
export function headerCells(sheet: ParsedSheet, headerRow: number): string[] | null {
  const row = sheet.rows[headerRow - 1];
  return row ? row.map(cellText) : null;
}

/**
 * Checks a proposed mapping against the file itself. Returns the problem in
 * words, which goes back to the LLM once, or null when it is usable.
 */
export function checkMapping(sheet: ParsedSheet, mapping: ColumnMapping): string | null {
  const { headerRow, columns } = mapping;
  if (!Number.isInteger(headerRow) || headerRow < 1 || headerRow > sheet.rows.length) {
    return `Header row ${headerRow} does not exist; the sheet has ${sheet.rows.length} rows.`;
  }

  const header = headerCells(sheet, headerRow) ?? [];
  const named: [string, string | null][] = [
    ["model", columns.model],
    ["category", columns.category],
    ["dealerPrice", columns.dealerPrice],
    ["mrp", columns.mrp],
  ];

  const seen = new Map<number, string>();
  for (const [field, name] of named) {
    if (name === null) {
      if (field === "category") continue;
      return `No column was given for ${field}.`;
    }
    const index = header.indexOf(name.trim());
    if (index === -1) {
      return `Column "${name}" for ${field} is not in header row ${headerRow} (${JSON.stringify(header)}).`;
    }
    const other = seen.get(index);
    if (other) return `Column "${name}" is used for both ${other} and ${field}.`;
    seen.set(index, field);
  }

  return null;
}

/**
 * A positive whole number of rupees, from a number cell or from text such as
 * "₹7,500" or "7500 INR". Null when it is anything else.
 */
export function parseRupees(cell: Cell | undefined): number | null {
  let value: number;
  if (typeof cell === "number") {
    value = cell;
  } else if (typeof cell === "string") {
    const cleaned = cell.replace(/₹|inr|rs\.?|,|\s/gi, "");
    if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
    value = Number(cleaned);
  } else {
    return null;
  }
  return Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * Every non-blank row below the header, mapped to model, category and prices.
 * A row that cannot be used becomes an issue with a reason, never a silent
 * drop, and a second row for the same product is an issue too.
 */
export function applyMapping(
  sheet: ParsedSheet,
  mapping: ColumnMapping,
  brand: Brand,
): { rows: MappedRow[]; issues: RowIssue[] } {
  const header = headerCells(sheet, mapping.headerRow) ?? [];
  const column = (name: string | null) => (name === null ? -1 : header.indexOf(name.trim()));

  const modelAt = column(mapping.columns.model);
  const categoryAt = column(mapping.columns.category);
  const dealerAt = column(mapping.columns.dealerPrice);
  const mrpAt = column(mapping.columns.mrp);

  const rows: MappedRow[] = [];
  const issues: RowIssue[] = [];
  const firstRowForKey = new Map<string, number>();

  for (let index = mapping.headerRow; index < sheet.rows.length; index++) {
    const cells = sheet.rows[index];
    const rowNumber = index + 1;
    if (isBlankRow(cells)) continue;

    const supplierModel = cellText(cells[modelAt]);
    if (!supplierModel) {
      issues.push({ rowNumber, reason: "No model name." });
      continue;
    }

    const dealerPrice = parseRupees(cells[dealerAt]);
    if (dealerPrice === null) {
      issues.push({
        rowNumber,
        reason: `${supplierModel}: dealer price "${cellText(cells[dealerAt])}" is not a whole number of rupees.`,
      });
      continue;
    }

    const mrp = parseRupees(cells[mrpAt]);
    if (mrp === null) {
      issues.push({
        rowNumber,
        reason: `${supplierModel}: MRP "${cellText(cells[mrpAt])}" is not a whole number of rupees.`,
      });
      continue;
    }

    if (dealerPrice > mrp) {
      issues.push({ rowNumber, reason: `${supplierModel}: dealer price is above MRP.` });
      continue;
    }

    const key = createMatchingKey(brand, supplierModel);
    const earlier = firstRowForKey.get(key);
    if (earlier !== undefined) {
      issues.push({ rowNumber, reason: `${supplierModel}: same product as row ${earlier}.` });
      continue;
    }
    firstRowForKey.set(key, rowNumber);

    const category = categoryAt === -1 ? "" : cellText(cells[categoryAt]);
    rows.push({ rowNumber, supplierModel, category: category || null, dealerPrice, mrp });
  }

  return { rows, issues };
}
