import * as z from "zod";

import { formatDate, formatNumber } from "@/lib/format";

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
 * The three tools the model may call, each defined once: the argument schema
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
      .enum(["all", "last_month", "this_month", "last_days", "month", "between"])
      .describe(
        "all = every sale; last_month = the previous calendar month; this_month = the current month so far; " +
          "last_days = the last N days (set days); month = one calendar month (set month, optionally year); " +
          "between = explicit dates (set from and to).",
      ),
    days: z.int().min(1).max(365).describe("For last_days: how many days back from today.").optional(),
    month: z.int().min(1).max(12).describe("For month: 1 = January … 12 = December.").optional(),
    year: z.int().describe("For month: the year. Leave out for the most recent such month.").optional(),
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

// ---------------------------------------------------------- shared wording

const PERIOD_PHRASE: Record<PeriodInput["kind"], string> = {
  all: "all sales",
  last_month: "last month",
  this_month: "this month so far",
  last_days: "the last N days",
  month: "the month asked for",
  between: "the dates asked for",
};

function periodPhrase(period: PeriodInput | undefined, today: string): string {
  const kind = period?.kind ?? "all";
  const phrase = kind === "last_days" ? `the last ${period?.days} days` : PERIOD_PHRASE[kind];
  return `${phrase}; today in the data is ${formatDate(today)}`;
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
    const lines = [`Period: ${r.period.label} (${periodPhrase(args.period, r.today)}).`];
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
    const lines = [
      `Baseline: ${r.baseline.label} (${periodPhrase(args.baseline, r.today)}).`,
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
    "It holds today's prices only: there is no price history.",
  schema: lookupProductsSchema,
  run: (data, args) => lookupProducts(data, args),
  explain(_args, r) {
    const where = r.filters.length === 0 ? "every product" : `products where ${r.filters.join(" and ")}`;
    return [
      `Looked up ${where} in the current price list: ${r.matched} found${r.matched > r.shown ? `, showing ${r.shown}` : ""}.`,
      ...r.notes,
      "Prices are today's. The app keeps no price history.",
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

// ------------------------------------------------------------------ registry

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each entry keeps its own argument and result types
type AnyTool = ToolDefinition<any, any>;

export const TOOLS: AnyTool[] = [querySalesTool, comparePeriodsTool, lookupProductsTool];
const BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

/** What the chat port declares to the model. */
export function toolDeclarations(): { name: string; description: string; parameters: z.ZodType }[] {
  return TOOLS.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.schema }));
}

/** Gemini sometimes sends null for an argument it means to leave out. */
function dropNulls(value: unknown): unknown {
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
