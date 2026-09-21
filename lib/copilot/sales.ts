import { addDays, earliestInvoiceDate, latestInvoiceDate, lineRevenue, mondayOf } from "@/lib/analytics";
import { formatDate, formatMoney, formatMoneyShort } from "@/lib/format";
import type { Product, SalesLine } from "@/lib/types";

import { lineMatches, resolveFilters, type ResolvedFilters } from "./filters";
import { DATA_START_GRACE_DAYS, daysBefore, inPeriod, resolvePeriod } from "./period";
import {
  COPILOT_MAX_ROWS,
  type CopilotData,
  type Filters,
  type Order,
  type PeriodInput,
  type ResolvedPeriod,
  type SalesGroupBy,
  type SortBy,
  ToolArgumentError,
} from "./types";

/**
 * The two sales tools. Every figure the copilot shows is computed here, from
 * the invoice lines: revenue is quantity × unit price, shares and averages are
 * worked out in code and rounded once, and the model only ever receives the
 * results. Pure.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Groupings that name something in the catalogue or the dealer list, so a zero is meaningful. */
const ENTITY_GROUPS = ["brand", "category", "model", "dealer", "state"] as const;
type EntityGroup = (typeof ENTITY_GROUPS)[number];

function isEntityGroup(groupBy: SalesGroupBy): groupBy is EntityGroup {
  return (ENTITY_GROUPS as readonly string[]).includes(groupBy);
}

const GROUP_NOUN: Record<SalesGroupBy, string> = {
  none: "lines",
  brand: "brands",
  category: "categories",
  model: "models",
  dealer: "dealers",
  state: "states",
  month: "months",
  week: "weeks",
  invoice: "invoices",
};

export function groupNoun(groupBy: SalesGroupBy): string {
  return GROUP_NOUN[groupBy];
}

function pct(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 1000) / 10;
}

function signedMoney(value: number): string {
  return `${value < 0 ? "-" : "+"}${formatMoney(Math.abs(value))}`;
}

function clampLimit(limit: number | undefined, fallback: number): number {
  if (limit === undefined) return fallback;
  if (!Number.isInteger(limit) || limit < 1) throw new ToolArgumentError("limit must be a whole number of at least 1.");
  return Math.min(limit, COPILOT_MAX_ROWS);
}

interface Context {
  today: string;
  dataStart: string;
  byId: Map<string, Product>;
}

function contextOf(data: CopilotData): Context {
  const today = latestInvoiceDate(data.sales);
  const dataStart = earliestInvoiceDate(data.sales);
  if (today === null || dataStart === null) {
    throw new ToolArgumentError("There are no sales in the data at all, so nothing can be computed.");
  }
  return { today, dataStart, byId: new Map(data.products.map((product) => [product.productId, product])) };
}

// ------------------------------------------------------------------ grouping

interface GroupKey {
  key: string;
  name: string;
  /** For ordering time groups; the key itself sorts correctly for those. */
  order: string;
  partial?: boolean;
}

function groupKeyOf(line: SalesLine, groupBy: SalesGroupBy, ctx: Context, period: ResolvedPeriod): GroupKey {
  const product = ctx.byId.get(line.productId);
  switch (groupBy) {
    case "none":
      return { key: "all", name: "All", order: "" };
    case "brand": {
      const name = product?.brand ?? "Unknown brand";
      return { key: name, name, order: name };
    }
    case "category": {
      const name = product?.category ?? "Unknown category";
      return { key: name, name, order: name };
    }
    case "model": {
      const name = product?.model ?? line.model;
      return { key: name, name, order: name };
    }
    case "dealer":
      return { key: line.dealer, name: line.dealer, order: line.dealer };
    case "state":
      return { key: line.state, name: line.state, order: line.state };
    case "month": {
      const ym = line.date.slice(0, 7);
      const [year, month] = ym.split("-").map(Number);
      const start = `${ym}-01`;
      const end = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
      // A day or two without invoices at the start of the data does not make a month partial.
      return {
        key: ym,
        name: `${MONTHS[month - 1]} ${year}`,
        order: ym,
        partial:
          daysBefore(start, period.from > ctx.dataStart ? period.from : ctx.dataStart) > DATA_START_GRACE_DAYS ||
          end > period.to,
      };
    }
    case "week": {
      // Strict, as on the dashboard: three missing days out of seven matter.
      const start = mondayOf(line.date);
      const end = addDays(start, 6);
      const coveredFrom = period.from < ctx.dataStart ? ctx.dataStart : period.from;
      return {
        key: start,
        name: `Week of ${formatDate(start)}`,
        order: start,
        partial: start < coveredFrom || end > period.to,
      };
    }
    case "invoice":
      return {
        key: line.invoiceNo,
        name: `${line.invoiceNo} · ${line.dealer} · ${formatDate(line.date)}`,
        order: line.date,
      };
  }
}

/** The names a grouping could take, so "who did not buy" has a list to subtract from. */
function universeOf(groupBy: EntityGroup, data: CopilotData, filters: ResolvedFilters): string[] {
  const products = filters.productIds
    ? data.products.filter((product) => filters.productIds!.has(product.productId))
    : data.products;
  const dealers = data.dealers.filter(
    (dealer) =>
      (!filters.dealers || filters.dealers.has(dealer.dealer)) &&
      (!filters.states || filters.states.has(dealer.state)),
  );
  const names: Record<EntityGroup, () => string[]> = {
    brand: () => products.map((product) => product.brand),
    category: () => products.map((product) => product.category),
    model: () => products.map((product) => product.model),
    dealer: () => dealers.map((dealer) => dealer.dealer),
    state: () => dealers.map((dealer) => dealer.state),
  };
  return [...new Set(names[groupBy]())].sort((a, b) => a.localeCompare(b));
}

interface Accumulator {
  group: GroupKey;
  revenue: number;
  units: number;
  invoices: Set<string>;
  lastSale: string | null;
}

function accumulate(
  lines: SalesLine[],
  groupBy: SalesGroupBy,
  ctx: Context,
  period: ResolvedPeriod,
): Map<string, Accumulator> {
  const groups = new Map<string, Accumulator>();
  for (const line of lines) {
    const group = groupKeyOf(line, groupBy, ctx, period);
    const entry = groups.get(group.key) ?? {
      group,
      revenue: 0,
      units: 0,
      invoices: new Set<string>(),
      lastSale: null,
    };
    entry.revenue += lineRevenue(line);
    entry.units += line.quantity;
    entry.invoices.add(line.invoiceNo);
    if (entry.lastSale === null || line.date > entry.lastSale) entry.lastSale = line.date;
    groups.set(group.key, entry);
  }
  return groups;
}

// ---------------------------------------------------------------- query_sales

export interface QuerySalesArgs {
  filters?: Filters;
  period?: PeriodInput;
  groupBy?: SalesGroupBy;
  includeZero?: boolean;
  sortBy?: SortBy;
  order?: Order;
  limit?: number;
}

export interface SalesRow {
  name: string;
  revenue: number;
  revenueText: string;
  revenueShort: string;
  units: number;
  invoices: number;
  /** Share of this query's total revenue, in percent. */
  revenueSharePct: number;
  unitsSharePct: number;
  avgInvoiceValueText: string | null;
  lastSale: string | null;
  partial?: boolean;
}

export interface QuerySalesResult {
  tool: "query_sales";
  today: string;
  period: { from: string; to: string; label: string; days: number };
  filters: string[];
  groupBy: SalesGroupBy;
  sortBy: SortBy;
  order: Order;
  /** Whether groups with no sales were asked for. */
  includeZero: boolean;
  matched: { lines: number; invoices: number; products: number; dealers: number };
  totals: {
    revenue: number;
    revenueText: string;
    revenueShort: string;
    units: number;
    invoices: number;
    avgInvoiceValueText: string | null;
    /** This query's revenue as a share of all sales in the same period; only when filtered. */
    shareOfAllRevenuePct?: number;
    shareOfAllUnitsPct?: number;
    allRevenueInPeriodText?: string;
  };
  groups?: { withSales: number; inUniverse?: number; shown: number };
  rows: SalesRow[];
  /** Names in the grouping with no sales at all in the period, for entity groupings. */
  zeroSales?: { count: number; names: string[] };
  notes: string[];
  caveats: string[];
}

function defaultSort(groupBy: SalesGroupBy): { sortBy: SortBy; order: Order } {
  if (groupBy === "month" || groupBy === "week") return { sortBy: "date", order: "asc" };
  if (groupBy === "invoice") return { sortBy: "date", order: "desc" };
  return { sortBy: "revenue", order: "desc" };
}

export function querySales(data: CopilotData, args: QuerySalesArgs): QuerySalesResult {
  const ctx = contextOf(data);
  const period = resolvePeriod(args.period, ctx.today, ctx.dataStart);
  const filters = resolveFilters(args.filters, data);
  const groupBy = args.groupBy ?? "none";
  const defaults = defaultSort(groupBy);
  const sortBy = args.sortBy ?? defaults.sortBy;
  const order = args.order ?? (args.sortBy === "name" ? "asc" : args.sortBy ? "desc" : defaults.order);
  const timeGroup = groupBy === "month" || groupBy === "week";
  const limit = clampLimit(args.limit, timeGroup ? COPILOT_MAX_ROWS : 10);

  const notes = [...filters.notes];
  const inWindow = data.sales.filter((line) => inPeriod(line.date, period));
  const lines = inWindow.filter((line) => lineMatches(line, filters));

  const revenue = lines.reduce((sum, line) => sum + lineRevenue(line), 0);
  const units = lines.reduce((sum, line) => sum + line.quantity, 0);
  const invoiceCount = new Set(lines.map((line) => line.invoiceNo)).size;

  const totals: QuerySalesResult["totals"] = {
    revenue,
    revenueText: formatMoney(revenue),
    revenueShort: formatMoneyShort(revenue),
    units,
    invoices: invoiceCount,
    avgInvoiceValueText: invoiceCount === 0 ? null : formatMoney(Math.round(revenue / invoiceCount)),
  };
  if (filters.applied.length > 0) {
    const allRevenue = inWindow.reduce((sum, line) => sum + lineRevenue(line), 0);
    const allUnits = inWindow.reduce((sum, line) => sum + line.quantity, 0);
    totals.shareOfAllRevenuePct = pct(revenue, allRevenue);
    totals.shareOfAllUnitsPct = pct(units, allUnits);
    totals.allRevenueInPeriodText = formatMoney(allRevenue);
  }

  const result: QuerySalesResult = {
    tool: "query_sales",
    today: ctx.today,
    period: { from: period.from, to: period.to, label: period.label, days: period.days },
    filters: filters.applied,
    groupBy,
    sortBy,
    order,
    includeZero: Boolean(args.includeZero) && isEntityGroup(groupBy),
    matched: {
      lines: lines.length,
      invoices: invoiceCount,
      products: new Set(lines.map((line) => line.productId)).size,
      dealers: new Set(lines.map((line) => line.dealer)).size,
    },
    totals,
    rows: [],
    notes,
    caveats: [...period.caveats],
  };

  if (groupBy === "none") {
    if (args.includeZero) notes.push("includeZero needs a groupBy of brand, category, model, dealer or state.");
    return result;
  }

  const groups = accumulate(lines, groupBy, ctx, period);
  const toRow = (entry: Accumulator): SalesRow => ({
    name: entry.group.name,
    revenue: entry.revenue,
    revenueText: formatMoney(entry.revenue),
    revenueShort: formatMoneyShort(entry.revenue),
    units: entry.units,
    invoices: entry.invoices.size,
    revenueSharePct: pct(entry.revenue, revenue),
    unitsSharePct: pct(entry.units, units),
    avgInvoiceValueText:
      entry.invoices.size === 0 ? null : formatMoney(Math.round(entry.revenue / entry.invoices.size)),
    lastSale: entry.lastSale,
    ...(entry.group.partial !== undefined ? { partial: entry.group.partial } : {}),
  });

  const rows = [...groups.values()].map(toRow);
  const orderOf = new Map([...groups.values()].map((entry) => [entry.group.name, entry.group.order]));

  let inUniverse: number | undefined;
  if (isEntityGroup(groupBy)) {
    const universe = universeOf(groupBy, data, filters);
    const zero = universe.filter((name) => !groups.has(name));
    inUniverse = new Set([...universe, ...groups.keys()]).size;
    result.zeroSales = { count: zero.length, names: zero.slice(0, COPILOT_MAX_ROWS) };
    if (args.includeZero) {
      for (const name of zero) {
        rows.push({
          name,
          revenue: 0,
          revenueText: formatMoney(0),
          revenueShort: formatMoneyShort(0),
          units: 0,
          invoices: 0,
          revenueSharePct: 0,
          unitsSharePct: 0,
          avgInvoiceValueText: null,
          lastSale: null,
        });
      }
    }
  } else if (args.includeZero) {
    notes.push("includeZero applies to brand, category, model, dealer and state groupings only.");
  }

  const direction = order === "asc" ? 1 : -1;
  rows.sort((a, b) => {
    let diff = 0;
    if (sortBy === "name") diff = a.name.localeCompare(b.name);
    else if (sortBy === "date") {
      const left = timeGroup || groupBy === "invoice" ? (orderOf.get(a.name) ?? "") : (a.lastSale ?? "");
      const right = timeGroup || groupBy === "invoice" ? (orderOf.get(b.name) ?? "") : (b.lastSale ?? "");
      diff = left.localeCompare(right);
    } else diff = a[sortBy] - b[sortBy];
    return diff * direction || a.name.localeCompare(b.name);
  });

  // Asking for groups with no sales means those are the answer, so they lead the
  // table whatever the ranking; otherwise a "who has not bought" table would open
  // with the ten biggest buyers.
  if (result.includeZero) {
    const zero = rows.filter((row) => row.units === 0 && row.revenue === 0 && row.invoices === 0);
    rows.splice(0, rows.length, ...zero, ...rows.filter((row) => !zero.includes(row)));
  }

  result.rows = rows.slice(0, limit);
  result.groups = { withSales: groups.size, ...(inUniverse !== undefined ? { inUniverse } : {}), shown: result.rows.length };

  const partial = result.rows.filter((row) => row.partial).map((row) => row.name);
  if (partial.length > 0) {
    result.caveats.push(
      `${partial.join(" and ")} ${partial.length === 1 ? "is" : "are"} only partly covered by the data or the period, so ${partial.length === 1 ? "its total is" : "their totals are"} lower for that reason alone.`,
    );
  }
  return result;
}

// ------------------------------------------------------------ compare_periods

export type CompareGroupBy = "none" | EntityGroup;
export type CompareSortBy = "change" | "change_pct" | "revenue" | "name";

export interface ComparePeriodsArgs {
  filters?: Filters;
  baseline: PeriodInput;
  comparison: PeriodInput;
  groupBy?: CompareGroupBy;
  sortBy?: CompareSortBy;
  order?: Order;
  limit?: number;
}

export interface PeriodSummary {
  from: string;
  to: string;
  label: string;
  days: number;
  revenue: number;
  revenueText: string;
  revenueShort: string;
  units: number;
  invoices: number;
  revenuePerDayText: string | null;
}

export interface CompareRow {
  name: string;
  baselineRevenueText: string;
  comparisonRevenueText: string;
  changeRevenue: number;
  changeRevenueText: string;
  /** Null when the baseline had no sales, so a percentage means nothing. */
  changePct: number | null;
  baselineUnits: number;
  comparisonUnits: number;
  changeUnits: number;
  comparisonRevenue: number;
}

export interface ComparePeriodsResult {
  tool: "compare_periods";
  today: string;
  filters: string[];
  baseline: PeriodSummary;
  comparison: PeriodSummary;
  change: {
    revenue: number;
    revenueText: string;
    revenuePct: number | null;
    units: number;
    unitsPct: number | null;
    /** Change in revenue per day of data, the fair measure when the periods differ in length. */
    revenuePerDayPct: number | null;
  };
  groupBy: CompareGroupBy;
  groups?: { withSales: number; shown: number };
  rows: CompareRow[];
  notes: string[];
  caveats: string[];
}

function changePct(from: number, to: number): number | null {
  return from === 0 ? null : Math.round(((to - from) / from) * 1000) / 10;
}

function summarise(lines: SalesLine[], period: ResolvedPeriod): PeriodSummary {
  const revenue = lines.reduce((sum, line) => sum + lineRevenue(line), 0);
  return {
    from: period.from,
    to: period.to,
    label: period.label,
    days: period.days,
    revenue,
    revenueText: formatMoney(revenue),
    revenueShort: formatMoneyShort(revenue),
    units: lines.reduce((sum, line) => sum + line.quantity, 0),
    invoices: new Set(lines.map((line) => line.invoiceNo)).size,
    revenuePerDayText: period.days === 0 ? null : formatMoney(Math.round(revenue / period.days)),
  };
}

export function comparePeriods(data: CopilotData, args: ComparePeriodsArgs): ComparePeriodsResult {
  if (!args.baseline || !args.comparison) {
    throw new ToolArgumentError("compare_periods needs both a baseline and a comparison period.");
  }
  const ctx = contextOf(data);
  const baseline = resolvePeriod(args.baseline, ctx.today, ctx.dataStart);
  const comparison = resolvePeriod(args.comparison, ctx.today, ctx.dataStart);
  const filters = resolveFilters(args.filters, data);
  const groupBy = args.groupBy ?? "none";
  const sortBy = args.sortBy ?? "change";
  const order = args.order ?? (sortBy === "name" ? "asc" : "desc");
  const limit = clampLimit(args.limit, 10);

  const matching = data.sales.filter((line) => lineMatches(line, filters));
  const before = matching.filter((line) => inPeriod(line.date, baseline));
  const after = matching.filter((line) => inPeriod(line.date, comparison));
  const b = summarise(before, baseline);
  const c = summarise(after, comparison);

  const caveats = [
    ...baseline.caveats.map((caveat) => `Baseline: ${caveat}`),
    ...comparison.caveats.map((caveat) => `Comparison: ${caveat}`),
  ];
  if (baseline.days !== comparison.days) {
    caveats.push(
      `The periods cover different numbers of days with data (${b.days} and ${c.days}), so the totals are not like for like. Revenue per day is the fair comparison.`,
    );
  }
  if (baseline.from <= comparison.to && comparison.from <= baseline.to) {
    caveats.push("The two periods overlap, so some sales are counted in both.");
  }

  const perDay = (summary: PeriodSummary) => (summary.days === 0 ? 0 : summary.revenue / summary.days);

  const result: ComparePeriodsResult = {
    tool: "compare_periods",
    today: ctx.today,
    filters: filters.applied,
    baseline: b,
    comparison: c,
    change: {
      revenue: c.revenue - b.revenue,
      revenueText: signedMoney(c.revenue - b.revenue),
      revenuePct: changePct(b.revenue, c.revenue),
      units: c.units - b.units,
      unitsPct: changePct(b.units, c.units),
      revenuePerDayPct: b.days === 0 || c.days === 0 ? null : changePct(perDay(b), perDay(c)),
    },
    groupBy,
    rows: [],
    notes: [...filters.notes],
    caveats,
  };

  if (groupBy === "none") return result;

  const beforeGroups = accumulate(before, groupBy, ctx, baseline);
  const afterGroups = accumulate(after, groupBy, ctx, comparison);
  const names = [...new Set([...beforeGroups.keys(), ...afterGroups.keys()])];

  const rows: CompareRow[] = names.map((name) => {
    const x = beforeGroups.get(name);
    const y = afterGroups.get(name);
    const bRevenue = x?.revenue ?? 0;
    const cRevenue = y?.revenue ?? 0;
    return {
      name,
      baselineRevenueText: formatMoney(bRevenue),
      comparisonRevenueText: formatMoney(cRevenue),
      comparisonRevenue: cRevenue,
      changeRevenue: cRevenue - bRevenue,
      changeRevenueText: signedMoney(cRevenue - bRevenue),
      changePct: changePct(bRevenue, cRevenue),
      baselineUnits: x?.units ?? 0,
      comparisonUnits: y?.units ?? 0,
      changeUnits: (y?.units ?? 0) - (x?.units ?? 0),
    };
  });

  const direction = order === "asc" ? 1 : -1;
  rows.sort((l, r) => {
    let diff: number;
    if (sortBy === "name") diff = l.name.localeCompare(r.name);
    else if (sortBy === "revenue") diff = l.comparisonRevenue - r.comparisonRevenue;
    else if (sortBy === "change_pct") diff = (l.changePct ?? Infinity) - (r.changePct ?? Infinity);
    else diff = l.changeRevenue - r.changeRevenue;
    return diff * direction || l.name.localeCompare(r.name);
  });

  result.rows = rows.slice(0, limit);
  result.groups = { withSales: names.length, shown: result.rows.length };
  return result;
}
