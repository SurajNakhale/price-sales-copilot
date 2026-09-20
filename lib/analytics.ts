import type { Brand, Product, SalesLine } from "@/lib/types";

/**
 * Every number the dashboard and the Sales Copilot show is computed here.
 *
 * These are pure functions over arrays with no file access, so they can be
 * unit-tested directly against the mock data and reused on the client.
 *
 * Dates are handled in UTC throughout. The files hold plain "YYYY-MM-DD"
 * strings, and parsing them in local time would shift a sale across a day
 * boundary depending on where the app runs.
 */

export interface BrandTotal {
  brand: Brand;
  revenue: number;
  units: number;
}

export interface WeekBucket {
  /** ISO date of the Monday the week starts on. */
  weekStart: string;
  /** ISO date of the Sunday it ends on. */
  weekEnd: string;
  revenue: number;
  units: number;
  /**
   * The week reaches outside the period the data covers, so its total is
   * lower for that reason alone and must not be read as a fall.
   */
  partial: boolean;
}

export type Measure = "revenue" | "units";

/** `unitPrice` is per unit, not a line total. */
export function lineRevenue(line: SalesLine): number {
  return line.quantity * line.unitPrice;
}

export function totalRevenue(sales: SalesLine[]): number {
  return sales.reduce((sum, line) => sum + lineRevenue(line), 0);
}

export function totalUnits(sales: SalesLine[]): number {
  return sales.reduce((sum, line) => sum + line.quantity, 0);
}

/** Lines are grouped into invoices by `invoiceNo`. */
export function invoiceCount(sales: SalesLine[]): number {
  return new Set(sales.map((line) => line.invoiceNo)).size;
}

/**
 * "Today" for every relative question, never the wall clock. The mock data
 * ends on a fixed date, so using the real date would silently empty any
 * "last 90 days" filter once enough time passes.
 */
export function latestInvoiceDate(sales: SalesLine[]): string | null {
  return sales.reduce<string | null>(
    (latest, line) => (latest === null || line.date > latest ? line.date : latest),
    null,
  );
}

export function earliestInvoiceDate(sales: SalesLine[]): string | null {
  return sales.reduce<string | null>(
    (earliest, line) => (earliest === null || line.date < earliest ? line.date : earliest),
    null,
  );
}

/**
 * Revenue and units per brand, biggest first by the measure given.
 *
 * The order differs between the two: by revenue Samsung leads, by units
 * TP-Link does. Any chart built on this has to name which one it is showing.
 */
export function brandTotals(
  sales: SalesLine[],
  products: Product[],
  sortBy: Measure = "revenue",
): BrandTotal[] {
  const brandOf = new Map(products.map((product) => [product.productId, product.brand]));
  const totals = new Map<Brand, BrandTotal>();

  for (const line of sales) {
    const brand = brandOf.get(line.productId);
    if (brand === undefined) continue; // a sale for an unknown product is not attributed
    const entry = totals.get(brand) ?? { brand, revenue: 0, units: 0 };
    entry.revenue += lineRevenue(line);
    entry.units += line.quantity;
    totals.set(brand, entry);
  }

  return [...totals.values()].sort((a, b) => b[sortBy] - a[sortBy]);
}

/**
 * Sales bucketed into whole Monday-to-Sunday weeks covering the data.
 *
 * Weekly, because three monthly points is not a trend and the last month is
 * incomplete. Buckets at either end that reach past the first or last invoice
 * are flagged `partial` so the chart can draw them as such.
 */
export function weeklyBuckets(sales: SalesLine[]): WeekBucket[] {
  const first = earliestInvoiceDate(sales);
  const last = latestInvoiceDate(sales);
  if (first === null || last === null) return [];

  const buckets = new Map<string, WeekBucket>();

  for (
    let cursor = mondayOf(first);
    cursor <= last;
    cursor = addDays(cursor, 7)
  ) {
    const weekEnd = addDays(cursor, 6);
    buckets.set(cursor, {
      weekStart: cursor,
      weekEnd,
      revenue: 0,
      units: 0,
      partial: cursor < first || weekEnd > last,
    });
  }

  for (const line of sales) {
    const bucket = buckets.get(mondayOf(line.date));
    if (bucket === undefined) continue;
    bucket.revenue += lineRevenue(line);
    bucket.units += line.quantity;
  }

  return [...buckets.values()];
}

export interface TrendPoint {
  weekStart: string;
  weekEnd: string;
  partial: boolean;
  value: number;
  /** The measure on the stretch between the first and last whole week, else null. */
  solid: number | null;
  /** The measure on the partial stretch at either end, else null. */
  dashed: number | null;
}

/**
 * The trend line, split into a solid middle and dashed ends.
 *
 * Recharts cannot dash part of one line, so the chart draws two: the ends that
 * reach outside the data are dashed, the whole weeks between them are solid.
 * The two series share their boundary points, so the line has no gap.
 */
export function trendSeries(weeks: WeekBucket[], measure: Measure): TrendPoint[] {
  const firstWhole = weeks.findIndex((week) => !week.partial);
  const lastWhole = weeks.reduce(
    (last, week, index) => (week.partial ? last : index),
    -1,
  );

  return weeks.map((week, index) => {
    const value = week[measure];
    // With no whole week anywhere, the entire line is uncertain, so it is all
    // dashed rather than half-drawn.
    const allPartial = firstWhole === -1;
    return {
      weekStart: week.weekStart,
      weekEnd: week.weekEnd,
      partial: week.partial,
      value,
      solid: !allPartial && index >= firstWhole && index <= lastWhole ? value : null,
      dashed:
        allPartial || index <= firstWhole || index >= lastWhole ? value : null,
    };
  });
}

/** The Monday on or before the given ISO date. */
export function mondayOf(isoDate: string): string {
  const date = parseUtc(isoDate);
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - daysSinceMonday);
  return toIso(date);
}

export function addDays(isoDate: string, days: number): string {
  const date = parseUtc(isoDate);
  date.setUTCDate(date.getUTCDate() + days);
  return toIso(date);
}

/** How many days back `isoDate` is from `from`, both ISO dates. */
export function daysBetween(from: string, isoDate: string): number {
  const ms = parseUtc(from).getTime() - parseUtc(isoDate).getTime();
  return Math.round(ms / 86_400_000);
}

function parseUtc(isoDate: string): Date {
  return new Date(`${isoDate}T00:00:00Z`);
}

function toIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}
