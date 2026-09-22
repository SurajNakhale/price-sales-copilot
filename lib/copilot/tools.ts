import * as z from "zod";

import { formatDate, formatNumber } from "@/lib/format";

import {
  lookupPriceChanges,
  PRICE_CHANGES_DEFAULT_LIMIT,
  type PriceChangeRow,
  type PriceChangesResult,
} from "./price-changes";
import { lookupProducts, type LookupProductsResult } from "./products";
import {
  comparePeriods,
  groupNoun,
  querySales,
  type ComparePeriodsResult,
  type QuerySalesResult,
} from "./sales";
import {
  COPILOT_MAX_ROWS,
  type CopilotData,
  type CopilotStep,
  type PeriodInput,
  type ResultTable,
  type SalesGroupBy,
  ToolArgumentError,
} from "./types";

/**
 * The four data tools the model may call, each defined once: the argument schema
 * (sent to Gemini and used to validate what comes back), the description the
 * model reads, the pure function that runs it, and three views of the result
 * written by code: the readable steps, the table, and a template sentence used
 * when the model's own sentence fails the number check. Pure.
 */

// ------------------------------------------------------------------- schemas

const names = (what: string) =>
  z.array(z.string()).max(20).describe(what).optional();

const filtersSchema = z
  .object({
    brands: names("Brand names, e.g. Samsung. Any one of them matches."),
    categories: names("Product categories, e.g. Router, SSD."),
    models: names('Model names or parts of them; "T7" matches every T7 model.'),
    dealers: names("Dealer names or parts of them."),
    states: names("Indian states the dealers are in."),
  })
  .describe("Optional. Lists are OR within a field and AND across fields. Leave out anything not asked for.")
  .optional();

const productFiltersSchema = z
  .object({
    brands: names("Brand names."),
    categories: names("Product categories."),
    models: names("Model names or parts of them."),
  })
  .describe("Optional. Leave out to list every product.")
  .optional();

const periodSchema = z
  .object({
    kind: z
      .enum(["all", "last_month", "this_month", "last_days", "month", "between", "this_quarter", "last_quarter", "quarter"])
      .describe(
        "all = every sale; last_month = the previous calendar month; this_month = the current month so far; " +
          "last_days = the last N days (set days); month = one calendar month (set month, optionally year); " +
          "between = explicit dates (set from and to); this_quarter = the current quarter so far; " +
          "last_quarter = the previous quarter; quarter = a numbered quarter (set quarter and numbering, " +
          "optionally year).",
      ),
    days: z.int().min(1).max(365).describe("For last_days: how many days back from today.").optional(),
    month: z.int().min(1).max(12).describe("For month: 1 = January … 12 = December.").optional(),
    year: z
      .int()
      .describe(
        "For month or quarter: the year. For a financial-year quarter, the year the financial year starts " +
          "(2026 for 2026-27). Leave out for the most recent one that has begun.",
      )
      .optional(),
    quarter: z.int().min(1).max(4).describe("For quarter: 1 to 4, numbered as numbering says.").optional(),
    numbering: z
      .enum(["calendar", "financial"])
      .describe(
        "For the quarter kinds: calendar (Q1 = Jan–Mar) or financial, the Indian financial year (Q1 = Apr–Jun). " +
          'Use financial when the question says "FY" or "financial year"; otherwise calendar.',
      )
      .optional(),
    from: z.string().describe("For between: first day, YYYY-MM-DD.").optional(),
    to: z.string().describe("For between: last day, YYYY-MM-DD.").optional(),
  })
  .describe("Which invoice dates to count. The tool resolves it against today in the data.");

const order = z
  .enum(["asc", "desc"])
  .describe("desc = highest first (the default for numbers), asc = lowest first.")
  .optional();

const limit = z
  .int()
  .min(1)
  .max(COPILOT_MAX_ROWS)
  .describe(`How many rows to return, 1 to ${COPILOT_MAX_ROWS}. Default 10; use 1 for "which one" questions.`)
  .optional();

export const querySalesSchema = z.object({
  filters: filtersSchema,
  period: periodSchema.optional(),
  groupBy: z
    .enum(["none", "brand", "category", "model", "dealer", "state", "month", "week", "invoice"])
    .describe('What each result row is. "none" gives one total. Default none.')
    .optional(),
  includeZero: z
    .boolean()
    .describe(
      "With groupBy brand, category, model, dealer or state: also include the ones with NO sales. " +
        'Use for "who has not bought", "which products never sold".',
    )
    .optional(),
  sortBy: z
    .enum(["revenue", "units", "invoices", "name", "date"])
    .describe('Ranking measure. Default revenue. For "most units" or "quantity" use units.')
    .optional(),
  order,
  limit,
});

export const comparePeriodsSchema = z.object({
  filters: filtersSchema,
  baseline: periodSchema.describe("The earlier period, compared from."),
  comparison: periodSchema.describe("The later period, compared to."),
  groupBy: z
    .enum(["none", "brand", "category", "model", "dealer", "state"])
    .describe('Compare per group instead of in total. Default none.')
    .optional(),
  sortBy: z
    .enum(["change", "change_pct", "revenue", "name"])
    .describe("Ranking of rows when grouped: change = revenue change in rupees (default).")
    .optional(),
  order,
  limit,
});

export const lookupProductsSchema = z.object({
  filters: productFiltersSchema,
  status: z
    .enum(["active", "discontinued", "any"])
    .describe("Filter by status. Default any.")
    .optional(),
});

export const lookupPriceChangesSchema = z.object({
  direction: z
    .enum(["decrease", "increase", "any"])
    .describe(
      "decrease = got cheaper, increase = got dearer. Judged on the dealer price, or on the MRP when only the MRP " +
        "changed. Default any.",
    )
    .optional(),
  filters: productFiltersSchema,
  salesPeriod: periodSchema
    .describe(
      "Optional. Adds each changed product's units sold and revenue in this period, e.g. last_month for " +
        '"how many did we sell last month". Leave out when sales are not asked about.',
    )
    .optional(),
  limit: z
    .int()
    .min(1)
    .max(COPILOT_MAX_ROWS)
    .describe(`How many changes to return, 1 to ${COPILOT_MAX_ROWS}. Default ${PRICE_CHANGES_DEFAULT_LIMIT}.`)
    .optional(),
});

// ---------------------------------------------------------- shared wording

const PERIOD_PHRASE: Record<PeriodInput["kind"], string> = {
  all: "all sales",
  last_month: "last month",
  this_month: "this month so far",
  last_days: "the last N days",
  month: "the month asked for",
  between: "the dates asked for",
  this_quarter: "this quarter so far",
  last_quarter: "last quarter",
  quarter: "the quarter asked for",
};

/** "this quarter so far, calendar Q3 2026; today in the data is 18 Sep 2026". */
function periodPhrase(period: PeriodInput | undefined, today: string, reading?: string): string {
  const kind = period?.kind ?? "all";
  const phrase = kind === "last_days" ? `the last ${period?.days} days` : PERIOD_PHRASE[kind];
  return `${phrase}${reading ? `, ${reading}` : ""}; today in the data is ${formatDate(today)}`;
}

// ------------------------------------------------------------- "Read as" lines

/**
 * How the model's arguments read, as one line at the top of each query step:
 * the metric, the grouping, the products, the dealers and the period. Written
 * by code from the arguments, so it cannot claim anything the query did not do.
 */
function readAs(parts: string[]): string {
  return `Read as: ${parts.join(" · ")}.`;
}

/** Which products and which dealers the filters kept, from the tool's own filter phrases. */
function scope(filters: string[]): { products: string; dealers: string } {
  const products = filters.filter((f) => /^(brand|category|model) /.test(f));
  const dealers = filters.filter((f) => /^(dealer|state) /.test(f));
  return {
    products: products.length === 0 ? "all products" : `products where ${products.join(" and ")}`,
    dealers: dealers.length === 0 ? "all dealers" : `dealers where ${dealers.join(" and ")}`,
  };
}

/** "this quarter (calendar Q3 2026)", "last month (1 Aug 2026 – 31 Aug 2026)". */
function periodName(input: PeriodInput | undefined, resolved: { label: string; reading?: string }): string {
  const kind = input?.kind ?? "all";
  if (kind === "quarter") return resolved.reading ?? resolved.label;
  if (kind === "this_quarter" || kind === "last_quarter") {
    return `${kind === "this_quarter" ? "this quarter" : "last quarter"} (${resolved.reading ?? resolved.label})`;
  }
  if (kind === "month" || kind === "between") return resolved.label;
  const name =
    kind === "all" ? "all dates" : kind === "last_days" ? `the last ${input?.days} days` : kind === "last_month" ? "last month" : "this month";
  return `${name} (${resolved.label})`;
}

function pctText(value: number | null): string {
  if (value === null) return "no earlier sales to compare with";
  return `${value > 0 ? "+" : ""}${value}%`;
}

const SORT_WORD: Record<string, string> = {
  revenue: "revenue",
  units: "units",
  invoices: "number of invoices",
  name: "name",
  date: "date",
  change: "revenue change",
  change_pct: "percentage change",
};

/** "1 dealer", "16 dealers". */
function count(n: number, noun: string): string {
  return `${formatNumber(n)} ${noun}${n === 1 ? "" : "s"}`;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const GROUP_LABEL: Record<SalesGroupBy, string> = {
  none: "Total",
  brand: "Brand",
  category: "Category",
  model: "Model",
  dealer: "Dealer",
  state: "State",
  month: "Month",
  week: "Week",
  invoice: "Invoice",
};

function filterPhrase(filters: string[]): string {
  return filters.length === 0 ? "All sales" : `Sales where ${filters.join(" and ")}`;
}

// ----------------------------------------------------------------- the tools

interface ToolDefinition<A, R> {
  name: string;
  title: string;
  description: string;
  schema: z.ZodType<A>;
  run(data: CopilotData, args: A): R;
  explain(args: A, result: R): string[];
  table(result: R): ResultTable;
  summarise(result: R): string;
}

function defineTool<A, R>(tool: ToolDefinition<A, R>): ToolDefinition<A, R> {
  return tool;
}

type QueryArgs = z.infer<typeof querySalesSchema>;
type CompareArgs = z.infer<typeof comparePeriodsSchema>;
type LookupArgs = z.infer<typeof lookupProductsSchema>;
type PriceChangesArgs = z.infer<typeof lookupPriceChangesSchema>;

const querySalesTool = defineTool<QueryArgs, QuerySalesResult>({
  name: "query_sales",
  title: "Query sales",
  description:
    "Totals, rankings and breakdowns of sales from the invoice lines (revenue = quantity × unit price, plus units " +
    "and invoices). Use it for: how much was sold; top or bottom N; sales by brand, category, model, dealer, state, " +
    "month or week; who bought something; who did NOT buy something (set includeZero and read zeroSales); a share " +
    "of revenue (read totals.shareOfAllRevenuePct). It returns every total, share and average, so never calculate " +
    "anything yourself.",
  schema: querySalesSchema,
  run: (data, args) => querySales(data, args),
  explain(args, r) {
    const { products, dealers } = scope(r.filters);
    const ranked = r.sortBy !== "name" && r.sortBy !== "date";
    const metric = r.groupBy === "none" ? "total revenue and units" : ranked ? SORT_WORD[r.sortBy] : "revenue and units";
    const shape =
      r.groupBy === "none"
        ? "one total"
        : `by ${r.groupBy}, ${ranked ? `${r.order === "asc" ? "bottom" : "top"} ${args.limit ?? 10}` : `in ${r.sortBy} order`}` +
          (r.includeZero ? ", with those that had none" : "");
    const lines = [
      readAs([metric, shape, products, dealers, periodName(args.period, r.period)]),
      `Period: ${r.period.label} (${periodPhrase(args.period, r.today, r.period.reading)}).`,
    ];
    lines.push(
      r.filters.length === 0
        ? `No filters: all ${count(r.matched.lines, "invoice line")} in the period.`
        : `Kept lines where ${r.filters.join(" and ")}: ${count(r.matched.lines, "line")}, ` +
            `${count(r.matched.invoices, "invoice")}, ${count(r.matched.products, "product")}, ` +
            `${count(r.matched.dealers, "dealer")}.`,
    );
    lines.push(...r.notes);
    lines.push(
      `Added up quantity × unit price: ${r.totals.revenueText} from ${formatNumber(r.totals.units)} units.`,
    );
    if (r.totals.shareOfAllRevenuePct !== undefined) {
      lines.push(
        `That is ${r.totals.shareOfAllRevenuePct}% of all revenue in the period (${r.totals.allRevenueInPeriodText}).`,
      );
    }
    if (r.groupBy !== "none" && r.groups) {
      const noun = groupNoun(r.groupBy);
      const universe = r.groups.inUniverse !== undefined ? ` (of ${r.groups.inUniverse} in total)` : "";
      const ranking =
        r.sortBy === "date"
          ? `in date order, ${r.order === "asc" ? "earliest" : "latest"} first`
          : r.sortBy === "name"
            ? "in name order"
            : `ranked by ${SORT_WORD[r.sortBy]}, ${r.order === "desc" ? "highest" : "lowest"} first`;
      lines.push(
        `Grouped by ${r.groupBy}, ${ranking}: ${r.groups.withSales} ${noun} had sales${universe}; showing ${r.groups.shown}.`,
      );
      if (r.includeZero && r.zeroSales) {
        lines.push(
          r.zeroSales.count === 0
            ? `Every one of them had sales in the period.`
            : `${r.zeroSales.count} ${noun} had no sales in the period.`,
        );
      }
    }
    return lines.concat(r.caveats.map((caveat) => `Note: ${caveat}`));
  },
  table(r) {
    const footnotes = [...r.caveats];
    if (r.groupBy === "none") {
      const row: Record<string, string> = {
        revenue: r.totals.revenueText,
        units: formatNumber(r.totals.units),
        invoices: formatNumber(r.totals.invoices),
        avg: r.totals.avgInvoiceValueText ?? "—",
      };
      const columns = [
        { key: "revenue", label: "Revenue", numeric: true },
        { key: "units", label: "Units", numeric: true },
        { key: "invoices", label: "Invoices", numeric: true },
        { key: "avg", label: "Avg invoice", numeric: true },
      ];
      if (r.totals.shareOfAllRevenuePct !== undefined) {
        row.share = `${r.totals.shareOfAllRevenuePct}%`;
        columns.push({ key: "share", label: "Share of all revenue", numeric: true });
      }
      return { title: `${filterPhrase(r.filters)}, ${r.period.label}`, columns, rows: [row], footnotes };
    }

    const noun = groupNoun(r.groupBy);
    if (r.groups) {
      const universe = r.groups.inUniverse !== undefined ? ` (${r.groups.inUniverse} in total)` : "";
      footnotes.unshift(
        `Total ${r.totals.revenueText} · ${formatNumber(r.totals.units)} units · ${formatNumber(r.totals.invoices)} ` +
          `invoices. Showing ${r.groups.shown} of ${r.groups.withSales} ${noun} with sales${universe}.`,
      );
    }
    if (r.zeroSales && r.zeroSales.count > 0) {
      footnotes.push(`No sales: ${r.zeroSales.names.join(", ")}${r.zeroSales.count > r.zeroSales.names.length ? " …" : ""}.`);
    }
    return {
      title: `${filterPhrase(r.filters)}, ${r.period.label}, by ${r.groupBy}`,
      columns: [
        { key: "name", label: GROUP_LABEL[r.groupBy] },
        { key: "revenue", label: "Revenue", numeric: true },
        { key: "units", label: "Units", numeric: true },
        { key: "invoices", label: "Invoices", numeric: true },
        { key: "share", label: "Share of revenue", numeric: true },
        { key: "lastSale", label: "Last sale" },
      ],
      rows: r.rows.map((row) => ({
        name: row.partial ? `${row.name} (partial)` : row.name,
        revenue: row.revenueText,
        units: formatNumber(row.units),
        invoices: formatNumber(row.invoices),
        share: `${row.revenueSharePct}%`,
        lastSale: row.lastSale ? formatDate(row.lastSale) : "—",
      })),
      footnotes,
    };
  },
  summarise(r) {
    const where = r.filters.length === 0 ? "" : ` where ${r.filters.join(" and ")}`;
    // A name that matched nothing is the whole story; say so rather than "no sales".
    if (r.matched.lines === 0 && r.notes.length > 0) return r.notes.join(" ");
    if (r.matched.lines === 0 && !(r.zeroSales && r.zeroSales.count > 0)) {
      return `No sales${where}, ${r.period.label}.`;
    }
    if (r.groupBy === "none") {
      const share =
        r.totals.shareOfAllRevenuePct !== undefined
          ? ` That is ${r.totals.shareOfAllRevenuePct}% of all revenue in the period.`
          : "";
      return (
        `${filterPhrase(r.filters)}, ${r.period.label}: ${r.totals.revenueText} from ${formatNumber(r.totals.units)} ` +
        `units across ${formatNumber(r.totals.invoices)} invoices.${share}`
      );
    }
    const noun = groupNoun(r.groupBy);
    if (r.includeZero && r.zeroSales) {
      const total = r.groups?.inUniverse ?? r.zeroSales.count;
      const list = r.zeroSales.names.slice(0, 10).join(", ");
      return r.zeroSales.count === 0
        ? `All ${total} ${noun} had sales${where}, ${r.period.label}.`
        : `${r.zeroSales.count} of ${total} ${noun} had no sales${where}, ${r.period.label}: ${list}.`;
    }
    const top = r.rows[0];
    if (!top) return `No sales${where}, ${r.period.label}.`;
    if (r.sortBy === "name" || r.sortBy === "date") {
      return `${r.rows.length} ${noun} shown for ${r.period.label}; together ${r.totals.revenueText} from ${formatNumber(r.totals.units)} units.`;
    }
    const measure =
      r.sortBy === "units"
        ? `${formatNumber(top.units)} units (${top.revenueText})`
        : r.sortBy === "invoices"
          ? `${formatNumber(top.invoices)} invoices (${top.revenueText})`
          : `${top.revenueText} (${formatNumber(top.units)} units)`;
    const rank = r.order === "desc" ? "highest" : "lowest";
    return `${top.name} is ${rank} by ${SORT_WORD[r.sortBy]} with ${measure}, ${r.period.label}${where}; ${r.groups?.withSales ?? r.rows.length} ${noun} had sales.`;
  },
});

const comparePeriodsTool = defineTool<CompareArgs, ComparePeriodsResult>({
  name: "compare_periods",
  title: "Compare periods",
  description:
    "Compares sales in two periods: revenue, units and invoices in each, the change in rupees and percent, and " +
    "revenue per day (the fair measure when the periods differ in length), in total or per brand, category, model, " +
    'dealer or state. Use it for "compare August with July", "how is this month going", "which dealers grew". ' +
    "Read the caveats: a period that is not over is flagged.",
  schema: comparePeriodsSchema,
  run: (data, args) => comparePeriods(data, args),
  explain(args, r) {
    const { products, dealers } = scope(r.filters);
    const lines = [
      readAs([
        "revenue change",
        r.groupBy === "none" ? "in total" : `per ${r.groupBy}`,
        products,
        dealers,
        `${periodName(args.baseline, r.baseline)} against ${periodName(args.comparison, r.comparison)}`,
      ]),
      `Baseline: ${r.baseline.label} (${periodPhrase(args.baseline, r.today, r.baseline.reading)}).`,
      `Comparison: ${r.comparison.label}.`,
    ];
    if (r.filters.length > 0) lines.push(`Kept lines where ${r.filters.join(" and ")}.`);
    lines.push(...r.notes);
    lines.push(
      `Revenue ${r.baseline.revenueText} → ${r.comparison.revenueText}: ${r.change.revenueText} ` +
        `(${pctText(r.change.revenuePct)}). Units ${formatNumber(r.baseline.units)} → ${formatNumber(r.comparison.units)}.`,
    );
    if (r.groupBy !== "none" && r.groups) {
      lines.push(
        `Compared per ${r.groupBy}, ranked by ${SORT_WORD[args.sortBy ?? "change"]}: showing ${r.groups.shown} of ${r.groups.withSales}.`,
      );
    }
    return lines.concat(r.caveats.map((caveat) => `Note: ${caveat}`));
  },
  table(r) {
    if (r.groupBy === "none") {
      const row = (label: string, s: ComparePeriodsResult["baseline"]) => ({
        name: `${label}: ${s.label}`,
        revenue: s.revenueText,
        units: formatNumber(s.units),
        invoices: formatNumber(s.invoices),
        days: formatNumber(s.days),
        perDay: s.revenuePerDayText ?? "—",
      });
      return {
        title: `${filterPhrase(r.filters)}: ${r.baseline.label} vs ${r.comparison.label}`,
        columns: [
          { key: "name", label: "Period" },
          { key: "revenue", label: "Revenue", numeric: true },
          { key: "units", label: "Units", numeric: true },
          { key: "invoices", label: "Invoices", numeric: true },
          { key: "days", label: "Days with data", numeric: true },
          { key: "perDay", label: "Revenue per day", numeric: true },
        ],
        rows: [
          row("Baseline", r.baseline),
          row("Comparison", r.comparison),
          {
            name: "Change",
            revenue: `${r.change.revenueText} (${pctText(r.change.revenuePct)})`,
            units: `${r.change.units > 0 ? "+" : ""}${formatNumber(r.change.units)}`,
            invoices: "",
            days: "",
            perDay: r.change.revenuePerDayPct === null ? "—" : pctText(r.change.revenuePerDayPct),
          },
        ],
        footnotes: [...r.caveats],
      };
    }
    return {
      title: `${filterPhrase(r.filters)}: ${r.baseline.label} vs ${r.comparison.label}, by ${r.groupBy}`,
      columns: [
        { key: "name", label: GROUP_LABEL[r.groupBy] },
        { key: "before", label: "Baseline", numeric: true },
        { key: "after", label: "Comparison", numeric: true },
        { key: "change", label: "Change", numeric: true },
        { key: "pct", label: "Change %", numeric: true },
        { key: "units", label: "Units", numeric: true },
      ],
      rows: r.rows.map((row) => ({
        name: row.name,
        before: row.baselineRevenueText,
        after: row.comparisonRevenueText,
        change: row.changeRevenueText,
        pct: row.changePct === null ? "new" : pctText(row.changePct),
        units: `${formatNumber(row.baselineUnits)} → ${formatNumber(row.comparisonUnits)}`,
      })),
      footnotes: [
        `Total ${r.baseline.revenueText} → ${r.comparison.revenueText} (${pctText(r.change.revenuePct)}).`,
        ...r.caveats,
      ],
    };
  },
  summarise(r) {
    const days =
      r.baseline.days !== r.comparison.days
        ? ` The periods cover ${r.baseline.days} and ${r.comparison.days} days of data, so compare revenue per day ` +
          `(${pctText(r.change.revenuePerDayPct)}).`
        : "";
    return (
      `${filterPhrase(r.filters)}: revenue went from ${r.baseline.revenueText} (${r.baseline.label}) to ` +
      `${r.comparison.revenueText} (${r.comparison.label}), ${r.change.revenueText} (${pctText(r.change.revenuePct)}).${days}`
    );
  },
});

const lookupProductsTool = defineTool<LookupArgs, LookupProductsResult>({
  name: "lookup_products",
  title: "Look up products",
  description:
    "The current price list: each product's dealer price, MRP, margin (MRP minus dealer price, and as a percent), " +
    "active or discontinued status, units sold and last sale date. Use it for price and product questions. " +
    "It holds today's prices only; for what changed, use lookup_price_changes.",
  schema: lookupProductsSchema,
  run: (data, args) => lookupProducts(data, args),
  explain(args, r) {
    const where = r.filters.length === 0 ? "every product" : `products where ${r.filters.join(" and ")}`;
    const status = args.status ?? "any";
    return [
      readAs([
        "current prices, margins and status",
        scope(r.filters.filter((f) => !f.startsWith("status "))).products,
        status === "any" ? "active and discontinued" : `${status} only`,
        "today's price list",
      ]),
      `Looked up ${where} in the current price list: ${r.matched} found${r.matched > r.shown ? `, showing ${r.shown}` : ""}.`,
      ...r.notes,
      "Prices are today's.",
    ];
  },
  table(r) {
    return {
      title: r.filters.length === 0 ? "Current price list" : `Current price list, ${r.filters.join(" and ")}`,
      columns: [
        { key: "productId", label: "Product ID" },
        { key: "model", label: "Model" },
        { key: "brand", label: "Brand" },
        { key: "category", label: "Category" },
        { key: "dealerPrice", label: "Dealer price", numeric: true },
        { key: "mrp", label: "MRP", numeric: true },
        { key: "margin", label: "Margin", numeric: true },
        { key: "status", label: "Status" },
        { key: "units", label: "Units sold", numeric: true },
      ],
      rows: r.rows.map((row) => ({
        productId: row.productId,
        model: row.model,
        brand: row.brand,
        category: row.category,
        dealerPrice: row.dealerPriceText,
        mrp: row.mrpText,
        margin: `${row.marginText} (${row.marginPct}%)`,
        status: row.status === "discontinued" ? `Discontinued${row.discontinuedOn ? ` ${formatDate(row.discontinuedOn)}` : ""}` : "Active",
        units: formatNumber(row.unitsSold),
      })),
      footnotes: [],
    };
  },
  summarise(r) {
    if (r.matched === 0) return "No product in the current price list matches that.";
    if (r.matched === 1) {
      const p = r.rows[0];
      return (
        `${p.brand} ${p.model} (${p.productId}): dealer price ${p.dealerPriceText}, MRP ${p.mrpText}, ` +
        `margin ${p.marginText} (${p.marginPct}%), ${p.status}.`
      );
    }
    return `${r.matched} products in the current price list match.`;
  },
});

/** "₹7,000 → ₹7,500", or "₹5,999 (unchanged)". */
function fromTo(from: string, to: string, same: boolean): string {
  return same ? `${to} (unchanged)` : `${from} → ${to}`;
}

/** "↑ 7.1%", "↓ 3.4%", or the MRP's change when the dealer price did not move. */
function changeText(row: PriceChangeRow): string {
  const arrow = (value: number) => `${value > 0 ? "↑" : "↓"} ${Math.abs(value)}%`;
  if (row.dealerPriceChangePct !== 0) return arrow(row.dealerPriceChangePct);
  if (row.mrpChangePct !== 0) return `MRP ${arrow(row.mrpChangePct)}`;
  return "—";
}

/** "3 up, 1 down". */
function upDown(r: PriceChangesResult): string {
  return `${r.appliedByDirection.increase} up, ${r.appliedByDirection.decrease} down`;
}

function listNames(lists: { file: string }[]): string {
  return lists.map((list) => list.file).join(", ");
}

const lookupPriceChangesTool = defineTool<PriceChangesArgs, PriceChangesResult>({
  name: "lookup_price_changes",
  title: "Look up price changes",
  description:
    "Price changes from the supplier price lists that were approved: each product's dealer price and MRP before " +
    "and after, the change in percent, which list it came from and when that list was approved. Only changes " +
    "applied on approval count; lists still waiting for review are named, not counted. Set salesPeriod to add " +
    'units sold and revenue per changed product. Use it for "which prices went up or down", "what got cheaper in ' +
    'the new lists", "which products had a price increase".',
  schema: lookupPriceChangesSchema,
  run: (data, args) => lookupPriceChanges(data, args),
  explain(args, r) {
    const lines: string[] = [
      readAs([
        r.direction === "decrease" ? "price cuts" : r.direction === "increase" ? "price rises" : "price changes, up or down",
        scope(r.filters).products,
        "approved lists only",
        r.salesPeriod ? `with units sold in ${periodName(args.salesPeriod, r.salesPeriod)}` : "no sales figures",
      ]),
    ];
    if (r.approvedLists.length === 0) {
      lines.push("No supplier price list has been approved yet.");
    } else {
      const lists = r.approvedLists.map((list) => `${list.file}, approved ${formatDate(list.approvedOn)}`).join("; ");
      lines.push(
        `Read ${count(r.approvedLists.length, "approved price list")} (${lists}): ` +
          `${count(r.appliedPriceChanges, "applied price change")} (${upDown(r)}).`,
      );
      const kept = r.filters.length === 0 ? "Kept every change" : `Kept changes where ${r.filters.join(" and ")}`;
      lines.push(`${kept}: ${r.matched} found${r.matched > r.shown ? `, showing ${r.shown}` : ""}.`);
    }
    if (r.salesPeriod) lines.push(`Added units sold and revenue for each changed product, ${r.salesPeriod.label}.`);
    lines.push(...r.notes, ...r.caveats);
    if (r.waitingForReview.length > 0) {
      lines.push(
        `Not included, still waiting for review: ${r.waitingForReview
          .map((list) => `${list.file} (${count(list.priceChanges, "price change")})`)
          .join(", ")}.`,
      );
    }
    lines.push("Only changes applied when a list was approved count.");
    return lines;
  },
  table(r) {
    const where = r.filters.length === 0 ? "" : `, ${r.filters.join(" and ")}`;
    const sales = r.salesPeriod ? `, with sales ${r.salesPeriod.label}` : "";
    const footnotes: string[] = [];
    if (r.matched > r.shown) footnotes.push(`Showing ${r.shown} of ${r.matched} changes.`);
    if (r.waitingForReview.length > 0) {
      footnotes.push(`Not included, waiting for review: ${listNames(r.waitingForReview)}.`);
    }
    footnotes.push(...r.caveats);
    return {
      title: `Price changes from approved lists${where}${sales}`,
      columns: [
        { key: "model", label: "Model" },
        { key: "brand", label: "Brand" },
        { key: "dealerPrice", label: "Dealer price", numeric: true },
        { key: "change", label: "Change", numeric: true },
        { key: "mrp", label: "MRP", numeric: true },
        { key: "list", label: "List" },
        { key: "approved", label: "Approved" },
        ...(r.salesPeriod
          ? [
              { key: "units", label: "Units sold", numeric: true },
              { key: "revenue", label: "Revenue", numeric: true },
            ]
          : []),
      ],
      rows: r.rows.map((row) => ({
        model: row.model,
        brand: row.brand,
        dealerPrice: fromTo(row.oldDealerPriceText, row.newDealerPriceText, row.oldDealerPrice === row.newDealerPrice),
        change: changeText(row),
        mrp: fromTo(row.oldMrpText, row.newMrpText, row.oldMrp === row.newMrp),
        list: row.list,
        approved: formatDate(row.approvedOn),
        ...(r.salesPeriod ? { units: formatNumber(row.units ?? 0), revenue: row.revenueText ?? "" } : {}),
      })),
      footnotes,
    };
  },
  summarise(r) {
    const waiting =
      r.waitingForReview.length > 0
        ? ` ${count(r.waitingForReview.length, "list")} waiting for review ${r.waitingForReview.length === 1 ? "is" : "are"} not included.`
        : "";
    if (r.approvedLists.length === 0) return `No supplier price list has been approved yet, so no price has changed.${waiting}`;

    // The filters start with the direction ("the price went down") when one was asked for.
    const where = r.filters.length === 0 ? "" : ` where ${r.filters.join(" and ")}`;
    if (r.matched === 0) {
      const others = r.filters.filter((filter) => !filter.startsWith("the price went"));
      const whereOthers = others.length === 0 ? "" : ` where ${others.join(" and ")}`;
      const went = r.direction === "decrease" ? "went down" : r.direction === "increase" ? "went up" : "was found";
      return (
        `No approved price change${whereOthers} ${went}. ` +
        `The approved ${r.approvedLists.length === 1 ? "list" : "lists"} (${listNames(r.approvedLists)}) applied ` +
        `${count(r.appliedPriceChanges, "price change")} (${upDown(r)}).${waiting}`
      );
    }
    const shown = r.rows.slice(0, 5).map((row) => {
      const price =
        row.oldDealerPrice !== row.newDealerPrice
          ? `${row.oldDealerPriceText} → ${row.newDealerPriceText}`
          : `MRP ${row.oldMrpText} → ${row.newMrpText}`;
      const sold = r.salesPeriod ? `, ${formatNumber(row.units ?? 0)} sold` : "";
      return `${row.model} ${price}${sold}`;
    });
    const more = r.matched > shown.length ? ` and ${r.matched - shown.length} more` : "";
    const period = r.salesPeriod ? ` Units sold are for ${r.salesPeriod.label}.` : "";
    return `${count(r.matched, "approved price change")}${where}: ${shown.join("; ")}${more}.${period}${waiting}`;
  },
});

// ------------------------------------------------------------------ registry

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each entry keeps its own argument and result types
type AnyTool = ToolDefinition<any, any>;

export const TOOLS: AnyTool[] = [querySalesTool, comparePeriodsTool, lookupProductsTool, lookupPriceChangesTool];
const BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

/** What the chat port declares to the model. */
export function toolDeclarations(): { name: string; description: string; parameters: z.ZodType }[] {
  return TOOLS.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.schema }));
}

/** Gemini sometimes sends null for an argument it means to leave out. */
export function dropNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropNulls);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== null)
      .map(([key, child]) => [key, dropNulls(child)]),
  );
}

export interface ToolExecution {
  step: CopilotStep;
  /** Sent back to the model: the result, or { error }. */
  modelResult: unknown;
  /** The template sentence for this result, when it ran. */
  template?: string;
}

export function executeTool(name: string, rawArgs: unknown, data: CopilotData): ToolExecution {
  const args = (rawArgs && typeof rawArgs === "object" ? rawArgs : {}) as Record<string, unknown>;
  const tool = BY_NAME.get(name);
  if (!tool) {
    const error = `There is no tool called "${name}". The tools are ${TOOLS.map((t) => t.name).join(", ")}.`;
    return {
      step: { tool: name, title: capitalise(name.replace(/_/g, " ")), lines: [], args, ok: false, error },
      modelResult: { error },
    };
  }

  const parsed = tool.schema.safeParse(dropNulls(args));
  if (!parsed.success) {
    const error = `Invalid arguments: ${parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "arguments"}: ${issue.message}`)
      .join("; ")}`;
    return { step: { tool: name, title: tool.title, lines: [], args, ok: false, error }, modelResult: { error } };
  }

  try {
    const result = tool.run(data, parsed.data);
    return {
      step: {
        tool: name,
        title: tool.title,
        lines: tool.explain(parsed.data, result),
        args,
        ok: true,
        table: tool.table(result),
        result,
      },
      modelResult: result,
      template: tool.summarise(result),
    };
  } catch (error) {
    if (!(error instanceof ToolArgumentError)) throw error;
    return {
      step: { tool: name, title: tool.title, lines: [], args, ok: false, error: error.message },
      modelResult: { error: error.message },
    };
  }
}
