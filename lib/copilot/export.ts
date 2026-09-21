import type { ResultTable } from "./types";

/**
 * A result table as CSV (for Download) or tab-separated text (for Copy, which
 * pastes into a spreadsheet as cells). Values are the formatted strings the
 * page shows. Pure.
 */

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function matrix(table: ResultTable): string[][] {
  return [
    table.columns.map((column) => column.label),
    ...table.rows.map((row) => table.columns.map((column) => row[column.key] ?? "")),
  ];
}

export function tableToCsv(table: ResultTable): string {
  return `${matrix(table).map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

export function tableToTsv(table: ResultTable): string {
  return matrix(table)
    .map((row) => row.map((cell) => cell.replace(/[\t\r\n]+/g, " ")).join("\t"))
    .join("\n");
}

/** "sales-by-dealer.csv" from the table title. */
export function csvFilename(table: ResultTable): string {
  const slug = table.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${slug || "copilot-result"}.csv`;
}
