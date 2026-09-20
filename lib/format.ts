/**
 * Display formatting. Pure, so server and client components format alike.
 *
 * Money appears two ways: short on KPI tiles (₹43.9L) and in full in tables
 * (₹43,91,820), both with Indian digit grouping.
 */

const inr = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
const plain = new Intl.NumberFormat("en-IN");

/** ₹43,91,820 */
export function formatMoney(value: number): string {
  return `₹${inr.format(Math.round(value))}`;
}

/** ₹43.9L, or ₹1.2Cr above a crore. Used on tiles, never in a table. */
export function formatMoneyShort(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 10_000_000) return `₹${trim(value / 10_000_000)}Cr`;
  if (abs >= 100_000) return `₹${trim(value / 100_000)}L`;
  if (abs >= 1_000) return `₹${trim(value / 1_000)}K`;
  return `₹${inr.format(Math.round(value))}`;
}

/** 1,248 */
export function formatNumber(value: number): string {
  return plain.format(value);
}

// Written out rather than taken from Intl, which abbreviates September to
// "Sept" in current CLDR for every English locale. A fixed table keeps the
// column three letters wide and stops the output changing under us when ICU
// is updated.
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/** "18 Sep 2026". Dates in the data are ISO strings, always read as UTC. */
export function formatDate(isoDate: string): string {
  const date = toUtcDate(isoDate);
  if (date === null) return isoDate;
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** "18 Sep" — for axis ticks, where the year is already implied. */
export function formatDateShort(isoDate: string): string {
  const date = toUtcDate(isoDate);
  if (date === null) return isoDate;
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

function toUtcDate(isoDate: string): Date | null {
  const date = new Date(isoDate.length === 10 ? `${isoDate}T00:00:00Z` : isoDate);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Nothing to show yet, as opposed to a real zero. */
export const EM_DASH = "—";

function trim(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}
