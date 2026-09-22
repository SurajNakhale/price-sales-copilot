import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { askCopilot, NO_TOOL_REFUSAL } from "@/lib/copilot/ask";
import { checkClarification, CLARIFY_TOOL } from "@/lib/copilot/clarify";
import { csvFilename, tableToCsv, tableToTsv } from "@/lib/copilot/export";
import { resolveFilters } from "@/lib/copilot/filters";
import { allowedNumbers, checkNumbers, numbersIn } from "@/lib/copilot/guard";
import { resolvePeriod } from "@/lib/copilot/period";
import { lookupPriceChanges } from "@/lib/copilot/price-changes";
import { lookupProducts } from "@/lib/copilot/products";
import { askBodySchema } from "@/lib/copilot/request";
import { comparePeriods, querySales } from "@/lib/copilot/sales";
import { executeTool, TOOLS, toolDeclarations } from "@/lib/copilot/tools";
import {
  COPILOT_MAX_ROUNDS,
  COPILOT_MAX_TOOL_CALLS,
  type CopilotData,
  ToolArgumentError,
} from "@/lib/copilot/types";
import { CLARIFY_SOURCE_NOTE, clarificationText, historyText, MEASURE_LABELS } from "@/lib/copilot/wording";
import { BadRequestError, InvalidLlmOutputError, LlmUnavailableError } from "@/lib/errors";
import { createGeminiChat, mapGeminiError, parseInteraction } from "@/lib/llm/chat";
import { llmModel } from "@/lib/llm/client";
import type { ChatPort, ChatStep, ChatTurnRequest, ChatTurnResult } from "@/lib/llm/port";
import { toGeminiSchema } from "@/lib/llm/schemas";
import type { Dealer, PriceChangeItem, PriceReview, Product, SalesLine } from "@/lib/types";

// The datasets are read from the repo by path, not through lib/config.ts, whose
// paths follow process.cwd() and are moved to temp folders by other test files.
// The sales and dealers files are never written at runtime; the price list can
// be edited by Feature 2 approvals, so nothing here assumes which products exist
// beyond the brand and category of IDs that are sold.
const mockDir = path.join(import.meta.dir, "..", "mock-data");
const read = <T>(...parts: string[]): T => JSON.parse(fs.readFileSync(path.join(mockDir, ...parts), "utf8")) as T;

const data: CopilotData = {
  sales: read<SalesLine[]>("sales", "sales-data.json"),
  products: read<Product[]>("current-price-lists", "current-price-list.json"),
  dealers: read<Dealer[]>("dealers", "dealers.json"),
};

const TODAY = "2026-09-18";
const DATA_START = "2026-07-02";

// ------------------------------------------------ independent brute force

const brandOf = new Map(data.products.map((product) => [product.productId, product]));
const revenueOf = (lines: SalesLine[]) => lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0);
const unitsOf = (lines: SalesLine[]) => lines.reduce((sum, line) => sum + line.quantity, 0);
const between = (from: string, to: string) => data.sales.filter((line) => line.date >= from && line.date <= to);

function brute(lines: SalesLine[], key: (line: SalesLine) => string) {
  const groups = new Map<string, SalesLine[]>();
  for (const line of lines) groups.set(key(line), [...(groups.get(key(line)) ?? []), line]);
  return [...groups].map(([name, group]) => ({
    name,
    revenue: revenueOf(group),
    units: unitsOf(group),
    invoices: new Set(group.map((line) => line.invoiceNo)).size,
  }));
}

// ------------------------------------------------------------------ periods

describe("periods are resolved by code against today in the data", () => {
  const resolve = (input: Parameters<typeof resolvePeriod>[0]) => resolvePeriod(input, TODAY, DATA_START);

  test("last month is August", () => {
    expect(resolve({ kind: "last_month" })).toMatchObject({ from: "2026-08-01", to: "2026-08-31", days: 31, caveats: [] });
  });

  test("this month runs to the last invoice and says it is not over", () => {
    const p = resolve({ kind: "this_month" });
    expect(p).toMatchObject({ from: "2026-09-01", to: "2026-09-18", days: 18 });
    expect(p.caveats.join(" ")).toContain("not over");
  });

  test("the last 90 days use the same rule as Feature 3 and note where the data starts", () => {
    const p = resolve({ kind: "last_days", days: 90 });
    expect(p).toMatchObject({ from: "2026-06-20", to: TODAY });
    expect(p.caveats.join(" ")).toContain("2 Jul 2026");
  });

  // 1 Jul had no invoice, but it is part of the data; one missing day is no caveat.
  test("July counts all 31 days without a caveat", () => {
    expect(resolve({ kind: "month", month: 7 })).toMatchObject({ from: "2026-07-01", to: "2026-07-31", days: 31, caveats: [] });
  });

  test("this quarter runs from 1 Jul to the last invoice, named in the numbering asked for", () => {
    const p = resolve({ kind: "this_quarter" });
    expect(p).toMatchObject({ from: "2026-07-01", to: TODAY, reading: "calendar Q3 2026" });
    expect(p.caveats.join(" ")).toContain("not over");
    // 1 Jul is one day before the first invoice: within the grace, so no data-start caveat.
    expect(p.caveats.join(" ")).not.toContain("Sales data starts");
    expect(resolve({ kind: "this_quarter", numbering: "financial" })).toMatchObject({
      from: "2026-07-01",
      reading: "Q2 of financial year 2026-27",
    });
  });

  test("last quarter is April to June, before the data", () => {
    const p = resolve({ kind: "last_quarter" });
    expect(p).toMatchObject({ from: "2026-04-01", to: "2026-06-30", reading: "calendar Q2 2026", days: 0 });
    expect(p.caveats.join(" ")).toContain("before the first sale");
  });

  test("a numbered quarter follows its numbering: calendar Q3 and financial Q2 are both Jul–Sep", () => {
    expect(resolve({ kind: "quarter", quarter: 3 })).toMatchObject({ from: "2026-07-01", to: TODAY, reading: "calendar Q3 2026" });
    expect(resolve({ kind: "quarter", quarter: 2, numbering: "financial" })).toMatchObject({
      from: "2026-07-01",
      to: TODAY,
      reading: "Q2 of financial year 2026-27",
    });
    // Calendar Q2 is April to June; financial Q1 of 2026-27 too.
    expect(resolve({ kind: "quarter", quarter: 2 })).toMatchObject({ from: "2026-04-01", to: "2026-06-30" });
    expect(resolve({ kind: "quarter", quarter: 1, numbering: "financial", year: 2026 })).toMatchObject({
      from: "2026-04-01",
      reading: "Q1 of financial year 2026-27",
    });
  });

  test("a quarter with no year is the most recent one begun", () => {
    expect(resolve({ kind: "quarter", quarter: 4 })).toMatchObject({ from: "2025-10-01", to: "2025-12-31", reading: "calendar Q4 2025" });
    expect(resolve({ kind: "quarter", quarter: 4, numbering: "financial" })).toMatchObject({
      from: "2026-01-01",
      to: "2026-03-31",
      reading: "Q4 of financial year 2025-26",
    });
  });

  test("bad quarters are errors the model can correct", () => {
    expect(() => resolve({ kind: "quarter" })).toThrow(ToolArgumentError);
    expect(() => resolve({ kind: "quarter", quarter: 5 })).toThrow(ToolArgumentError);
    expect(() => resolve({ kind: "quarter", quarter: 2, year: 26 })).toThrow(ToolArgumentError);
  });

  test("a month with no year means the most recent one", () => {
    expect(resolve({ kind: "month", month: 10 }).from).toBe("2025-10-01");
  });

  test("periods outside the data say they have none", () => {
    expect(resolve({ kind: "month", month: 10, year: 2025 }).caveats.join(" ")).toContain("before the first sale");
    expect(resolve({ kind: "between", from: "2026-10-01", to: "2026-10-31" }).caveats.join(" ")).toContain("after the last sale");
  });

  test("bad periods are errors the model can correct", () => {
    expect(() => resolve({ kind: "last_days" })).toThrow(ToolArgumentError);
    expect(() => resolve({ kind: "last_days", days: 0 })).toThrow(ToolArgumentError);
    expect(() => resolve({ kind: "month", month: 13 })).toThrow(ToolArgumentError);
    expect(() => resolve({ kind: "between", from: "2026-02-30", to: "2026-03-01" })).toThrow(ToolArgumentError);
    expect(() => resolve({ kind: "between", from: "2026-09-01", to: "2026-08-01" })).toThrow(ToolArgumentError);
  });
});

// ------------------------------------------------------------------ filters

describe("filters match the names in the data", () => {
  const models = (value: string) => resolveFilters({ models: [value] }, data).models;

  test("models match whole words, so T7 finds the T7 family", () => {
    expect(models("T7")).toEqual(["T7 1TB", "T7 2TB", "T7 Shield 1TB"]);
    expect(models("t7 1 tb")).toEqual(["T7 1TB"]);
    expect(models("Samsung T7 1TB")).toEqual(["T7 1TB"]);
    expect(models("990 PRO")).toEqual(["990 PRO 1TB", "990 PRO 2TB"]);
  });

  test("brands, categories and states ignore case, punctuation and a plural", () => {
    expect(resolveFilters({ brands: ["tplink"] }, data).brands).toEqual(["TP-Link"]);
    expect(resolveFilters({ categories: ["routers"] }, data).categories).toEqual(["Router"]);
    expect(resolveFilters({ states: ["gujarat"] }, data).states?.has("Gujarat")).toBe(true);
    expect(resolveFilters({ dealers: ["abc"] }, data).dealers?.has("ABC Computers")).toBe(true);
  });

  test("a name that matches nothing is a note, never a guess", () => {
    const filters = resolveFilters({ brands: ["Sony"] }, data);
    expect(filters.productIds?.size).toBe(0);
    expect(filters.notes[0]).toContain('No brand matches "Sony"');
  });
});

// ----------------------------------------------------- the answers, checked

describe("query_sales matches an independent calculation", () => {
  test("models with the most sales last month", () => {
    const r = querySales(data, { period: { kind: "last_month" }, groupBy: "model", limit: 3 });
    const expected = brute(between("2026-08-01", "2026-08-31"), (l) => brandOf.get(l.productId)?.model ?? l.model)
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 3);
    expect(r.rows.map((row) => [row.name, row.revenue, row.units])).toEqual(
      expected.map((row) => [row.name, row.revenue, row.units]),
    );
    expect(r.rows[0]).toMatchObject({ name: "990 PRO 2TB", revenue: 308_460, units: 16, revenueText: "₹3,08,460" });
    expect(r.totals).toMatchObject({ revenue: 1_865_150, units: 314 });
  });

  test("top 5 dealers this quarter, with the reading stated first", () => {
    const run = executeTool("query_sales", { period: { kind: "this_quarter" }, groupBy: "dealer", sortBy: "revenue", limit: 5 }, data);
    expect(run.step.lines[0]).toBe(
      "Read as: revenue · by dealer, top 5 · all products · all dealers · this quarter (calendar Q3 2026).",
    );
    expect(run.step.lines[1]).toBe(
      "Period: 1 Jul 2026 – 18 Sep 2026 (this quarter so far, calendar Q3 2026; today in the data is 18 Sep 2026).",
    );
    const expected = brute(between("2026-07-01", TODAY), (l) => l.dealer)
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5);
    const r = run.step.result as { rows: { name: string; revenue: number }[]; period: { reading?: string } };
    expect(r.rows.map((row) => [row.name, row.revenue])).toEqual(expected.map((row) => [row.name, row.revenue]));
    expect(r.period.reading).toBe("calendar Q3 2026");
  });

  test("the Read-as line is written from the arguments for every data tool", () => {
    const first = (name: string, args: Record<string, unknown>, d: CopilotData = data) => executeTool(name, args, d).step.lines[0];
    expect(first("query_sales", { filters: { brands: ["samsung"], states: ["gujarat"] }, period: { kind: "quarter", quarter: 2, numbering: "financial" } })).toBe(
      "Read as: total revenue and units · one total · products where brand is Samsung · dealers where state is Gujarat · Q2 of financial year 2026-27.",
    );
    expect(first("query_sales", { groupBy: "dealer", includeZero: true, sortBy: "units", order: "asc", limit: 3, period: { kind: "last_days", days: 90 } })).toBe(
      "Read as: units · by dealer, bottom 3, with those that had none · all products · all dealers · the last 90 days (20 Jun 2026 – 18 Sep 2026).",
    );
    expect(first("compare_periods", { baseline: { kind: "last_quarter" }, comparison: { kind: "this_quarter" }, groupBy: "brand" })).toBe(
      "Read as: revenue change · per brand · all products · all dealers · last quarter (calendar Q2 2026) against this quarter (calendar Q3 2026).",
    );
    expect(first("lookup_products", { filters: { categories: ["SSD"] }, status: "active" })).toBe(
      "Read as: current prices, margins and status · products where category is SSD · active only · today's price list.",
    );
    expect(first("lookup_price_changes", {})).toBe(
      "Read as: price changes, up or down · all products · approved lists only · no sales figures.",
    );
  });

  test("ABC Computers in the last 90 days", () => {
    const r = querySales(data, { filters: { dealers: ["ABC Computers"] }, period: { kind: "last_days", days: 90 } });
    const lines = between("2026-06-20", TODAY).filter((l) => l.dealer === "ABC Computers");
    expect(r.totals).toMatchObject({ revenue: revenueOf(lines), units: unitsOf(lines), invoices: 5 });
    expect(r.totals.revenueText).toBe("₹3,06,760");
    expect(r.totals.units).toBe(61);
  });

  test("the dealer who bought the most Samsung, by units", () => {
    const r = querySales(data, { filters: { brands: ["Samsung"] }, groupBy: "dealer", sortBy: "units", limit: 1 });
    expect(r.rows[0]).toMatchObject({ name: "XYZ Electronics", units: 39, revenue: 432_540, revenueSharePct: 22.1 });
    expect(r.groups).toEqual({ withSales: 16, inUniverse: 20, shown: 1 });
    expect(r.totals.shareOfAllRevenuePct).toBe(44.6);
  });

  test("dealers who have not bought Samsung", () => {
    const r = querySales(data, { filters: { brands: ["Samsung"] }, groupBy: "dealer", includeZero: true });
    const bought = new Set(data.sales.filter((l) => brandOf.get(l.productId)?.brand === "Samsung").map((l) => l.dealer));
    const expected = data.dealers.map((d) => d.dealer).filter((name) => !bought.has(name)).sort();
    expect(r.zeroSales).toEqual({ count: 4, names: expected });
    // They are the answer, so they lead the table even when ranked by revenue.
    expect(r.rows.slice(0, 4).map((row) => row.name)).toEqual(expected);
    expect(r.rows[4].name).toBe("XYZ Electronics");
  });

  test("dealers who have not bought Seagate: none, said plainly", () => {
    const tool = executeTool("query_sales", { filters: { brands: ["Seagate"] }, groupBy: "dealer", includeZero: true }, data);
    expect((tool.modelResult as { zeroSales: unknown }).zeroSales).toEqual({ count: 0, names: [] });
    expect(tool.template).toBe("All 20 dealers had sales where brand is Seagate, 2 Jul 2026 – 18 Sep 2026.");
  });

  test("total sales value for routers", () => {
    const r = querySales(data, { filters: { categories: ["Router"] } });
    const lines = data.sales.filter((l) => brandOf.get(l.productId)?.category === "Router");
    expect(r.totals).toMatchObject({ revenue: revenueOf(lines), units: unitsOf(lines) });
    expect(r.totals.revenueText).toBe("₹6,57,200");
  });

  test("who bought T7 1TB in the last 90 days", () => {
    const r = querySales(data, { filters: { models: ["T7 1TB"] }, period: { kind: "last_days", days: 90 }, groupBy: "dealer" });
    expect(r.groups?.withSales).toBe(10);
    expect(r.totals.units).toBe(55);
  });

  test("revenue by state", () => {
    const r = querySales(data, { groupBy: "state", limit: 1 });
    expect(r.groups?.withSales).toBe(12);
    expect(r.rows[0]).toMatchObject({ name: "Gujarat", revenue: 1_153_300, units: 259 });
  });

  test("months are grouped in date order and September is marked partial", () => {
    const r = querySales(data, { groupBy: "month" });
    expect(r.rows.map((row) => [row.name, row.revenue, Boolean(row.partial)])).toEqual([
      ["Jul 2026", revenueOf(between("2026-07-01", "2026-07-31")), false],
      ["Aug 2026", 1_865_150, false],
      ["Sep 2026", 891_380, true],
    ]);
  });

  test("groups with no sales are listed from a catalogue, whatever it holds", () => {
    // A catalogue of its own, so Feature 2 approvals to the real one cannot move this.
    const catalogue: Product[] = [
      { productId: "SAM-B072D", brand: "Samsung", model: "T7 1TB", category: "SSD", dealerPrice: 7000, mrp: 9999 },
      { productId: "SAM-00000", brand: "Samsung", model: "Unsold Drive", category: "SSD", dealerPrice: 1, mrp: 2 },
    ];
    const r = querySales({ ...data, products: catalogue }, { filters: { brands: ["Samsung"] }, groupBy: "model", includeZero: true });
    expect(r.zeroSales).toEqual({ count: 1, names: ["Unsold Drive"] });
    expect(r.rows.find((row) => row.name === "Unsold Drive")?.units).toBe(0);
  });
});

describe("compare_periods", () => {
  test("August against July", () => {
    const r = comparePeriods(data, { baseline: { kind: "month", month: 7 }, comparison: { kind: "month", month: 8 } });
    expect(r.baseline.revenue).toBe(1_635_290);
    expect(r.comparison.revenue).toBe(1_865_150);
    expect(r.change).toMatchObject({ revenuePct: 14.1, revenueText: "+₹2,29,860" });
    expect(r.caveats).toEqual([]);
  });

  test("September so far against August is flagged as unequal", () => {
    const r = comparePeriods(data, { baseline: { kind: "last_month" }, comparison: { kind: "this_month" } });
    const caveats = r.caveats.join(" ");
    expect(caveats).toContain("not over");
    expect(caveats).toContain("31 and 18");
    expect(r.change.revenuePerDayPct).not.toBeNull();
  });

  test("per brand, the rows add up to the totals", () => {
    const r = comparePeriods(data, {
      baseline: { kind: "month", month: 7 },
      comparison: { kind: "month", month: 8 },
      groupBy: "brand",
    });
    expect(r.rows.reduce((sum, row) => sum + row.changeRevenue, 0)).toBe(r.change.revenue);
  });
});

describe("lookup_products", () => {
  test("prices come straight from the current price list", () => {
    const t7 = data.products.find((p) => p.model === "T7 1TB")!;
    const r = lookupProducts(data, { filters: { models: ["T7 1TB"] } });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ productId: t7.productId, dealerPrice: t7.dealerPrice, mrp: t7.mrp });
  });
});

// -------------------------------------------------------------------- tools

describe("tool registry", () => {
  test("every tool converts to a JSON schema Gemini accepts, with a description", () => {
    for (const declaration of toolDeclarations()) {
      const schema = toGeminiSchema(declaration.parameters);
      expect(schema.type).toBe("object");
      expect(JSON.stringify(schema)).not.toContain("additionalProperties");
      expect(JSON.stringify(schema)).not.toContain("$schema");
      expect(declaration.description.length).toBeGreaterThan(50);
    }
    expect(TOOLS.map((tool) => tool.name)).toEqual([
      "query_sales",
      "compare_periods",
      "lookup_products",
      "lookup_price_changes",
    ]);
  });

  test("invalid arguments come back as an error the model can read", () => {
    const run = executeTool("query_sales", { limit: 500 }, data);
    expect(run.step.ok).toBe(false);
    expect((run.modelResult as { error: string }).error).toContain("limit");
  });

  test("nulls are treated as left out", () => {
    const run = executeTool("query_sales", { filters: null, period: { kind: "all", days: null }, groupBy: "brand" }, data);
    expect(run.step.ok).toBe(true);
  });

  test("an unknown tool is an error, not a crash", () => {
    expect(executeTool("delete_everything", {}, data).step.error).toContain("no tool called");
  });

  test("steps are written by code from the arguments", () => {
    const run = executeTool("query_sales", { filters: { brands: ["Samsung"] }, groupBy: "dealer", sortBy: "units", limit: 5 }, data);
    expect(run.step.lines.join("\n")).toContain("Kept lines where brand is Samsung: 65 lines, 46 invoices");
    expect(run.step.table?.rows[0].name).toBe("XYZ Electronics");
  });

  test("no result ever carries an email address", () => {
    const calls: [string, Record<string, unknown>][] = [
      ["query_sales", { groupBy: "dealer", includeZero: true, limit: 50 }],
      ["query_sales", { groupBy: "invoice", limit: 50 }],
      ["query_sales", { filters: { states: ["Gujarat"] }, groupBy: "dealer" }],
      ["compare_periods", { baseline: { kind: "month", month: 7 }, comparison: { kind: "month", month: 8 }, groupBy: "dealer" }],
      ["lookup_products", {}],
    ];
    for (const [name, args] of calls) {
      const run = executeTool(name, args, data);
      expect(run.step.ok).toBe(true);
      expect(JSON.stringify(run.modelResult)).not.toContain("@");
      expect(JSON.stringify(run.step)).not.toContain("@");
    }
  });
});

// -------------------------------------------------------------------- guard

describe("the number check", () => {
  const allowed = allowedNumbers([{ revenueText: "₹4,32,540", revenue: 432540, short: "₹4.3L", share: 22.1 }]);

  test("reads rupees, grouping, decimals and dates", () => {
    expect(numbersIn("₹4,32,540 is 22.1% on 2026-08-01")).toEqual([432540, 22.1, 2026, 8, 1]);
  });

  test("accepts numbers the results hold, in any of their forms", () => {
    expect(checkNumbers("XYZ bought ₹4,32,540 of Samsung.", allowed).ok).toBe(true);
    expect(checkNumbers("That is 432540 rupees, or ₹4.3L, 22.1% of it.", allowed).ok).toBe(true);
  });

  test("rejects a number the results do not hold", () => {
    expect(checkNumbers("XYZ bought ₹4,50,000.", allowed)).toEqual({ ok: false, unsupported: [450000] });
    // Rounding is recomputing: 22% is not in the results.
    expect(checkNumbers("about 22% of it", allowed).ok).toBe(false);
  });
});

// ---------------------------------------------------------------- the loop

const THOUGHT: ChatStep = { type: "thought", signature: "opaque-signature-that-must-come-back" };

function call(id: string, name: string, args: Record<string, unknown>): ChatTurnResult {
  return {
    steps: [THOUGHT, { type: "function_call", id, name, arguments: args }],
    calls: [{ id, name, arguments: args }],
    text: "",
    usage: { inputTokens: 100, outputTokens: 10 },
  };
}

function say(text: string): ChatTurnResult {
  return { steps: [{ type: "model_output", content: [{ type: "text", text }] }], calls: [], text, usage: {} };
}

/** A scripted model that records every request it receives. */
function fakeChat(script: (turn: number, request: ChatTurnRequest) => ChatTurnResult) {
  const requests: ChatTurnRequest[] = [];
  const chat: ChatPort = {
    model: "fake-model",
    async turn(request) {
      // A copy, because the service keeps appending to the same array.
      requests.push({ ...request, history: structuredClone(request.history) });
      return script(requests.length, request);
    },
  };
  return { chat, requests };
}

const SAMSUNG_BY_DEALER = { filters: { brands: ["Samsung"] }, groupBy: "dealer", sortBy: "units", limit: 5 };

describe("askCopilot", () => {
  test("a tool call, then a sentence whose numbers check out", async () => {
    const { chat, requests } = fakeChat((turn) =>
      turn === 1 ? call("c1", "query_sales", SAMSUNG_BY_DEALER) : say("XYZ Electronics bought the most: 39 units (₹4,32,540)."),
    );
    const answer = await askCopilot("Which dealer bought the most Samsung?", [], { chat, data, cache: null });

    expect(answer.sentenceSource).toBe("model");
    expect(answer.sentence).toContain("39 units");
    expect(answer.steps).toHaveLength(1);
    expect(answer.steps[0].table?.rows[0].name).toBe("XYZ Electronics");
    expect(answer.meta).toMatchObject({ model: "fake-model", rounds: 2, toolCalls: 1 });

    // The second request replays everything: the question, the model's steps
    // exactly as returned (the thought signature must survive), and the result.
    const history = requests[1].history;
    expect(history[0].type).toBe("user_input");
    expect(history[1]).toEqual(THOUGHT);
    expect(history[2]).toMatchObject({ type: "function_call", id: "c1" });
    expect(history[3]).toMatchObject({ type: "function_result", call_id: "c1", name: "query_sales" });
    const sent = JSON.parse((history[3].result as { text: string }[])[0].text);
    expect(sent.rows[0].name).toBe("XYZ Electronics");
  });

  test("the instructions give today and the real names, never an email", async () => {
    const { chat, requests } = fakeChat(() => say("Hello."));
    await askCopilot("hi", [], { chat, data, cache: null });
    const { instructions, tools } = requests[0];
    expect(instructions).toContain(TODAY);
    expect(instructions).toContain("ABC Computers");
    expect(instructions).not.toContain("@");
    expect(tools.map((tool) => tool.name)).toEqual([
      "query_sales",
      "compare_periods",
      "lookup_products",
      "lookup_price_changes",
      CLARIFY_TOOL,
    ]);
  });

  test("a sentence with an invented number is replaced by one written from the results", async () => {
    const { chat } = fakeChat((turn) =>
      turn === 1 ? call("c1", "query_sales", SAMSUNG_BY_DEALER) : say("XYZ Electronics bought ₹4,50,000 of Samsung."),
    );
    const answer = await askCopilot("Which dealer bought the most Samsung?", [], { chat, data, cache: null });
    expect(answer.sentenceSource).toBe("template");
    expect(answer.sentence).toContain("XYZ Electronics is highest by units with 39 units");
    expect(answer.guardNote).toContain("450000");
  });

  test("numbers without a tool call are refused", async () => {
    const { chat } = fakeChat(() => say("You sold about ₹50,00,000 last month."));
    const answer = await askCopilot("How much did we sell last month?", [], { chat, data, cache: null });
    expect(answer).toMatchObject({ sentence: NO_TOOL_REFUSAL, sentenceSource: "refusal" });
    expect(answer.steps).toHaveLength(0);
  });

  test("a reply without numbers or tools is passed through", async () => {
    const { chat } = fakeChat(() => say("This data cannot say which prices went up: there is no price history."));
    const answer = await askCopilot("Which products had a price increase?", [], { chat, data, cache: null });
    expect(answer.sentenceSource).toBe("no_tool");
  });

  test("bad arguments go back to the model, which can correct them", async () => {
    const { chat, requests } = fakeChat((turn) =>
      turn === 1
        ? call("bad", "query_sales", { limit: 500 })
        : turn === 2
          ? call("good", "query_sales", { groupBy: "state", limit: 1 })
          : say("Gujarat is highest by revenue with ₹11,53,300."),
    );
    const answer = await askCopilot("Which state buys the most?", [], { chat, data, cache: null });
    expect(answer.steps.map((step) => step.ok)).toEqual([false, true]);
    expect(answer.sentenceSource).toBe("model");
    const errorResult = requests[1].history.find((step) => step.type === "function_result")!;
    expect((errorResult.result as { text: string }[])[0].text).toContain("limit");
  });

  test("parallel calls each get their own result, in order", async () => {
    const { chat, requests } = fakeChat((turn) =>
      turn === 1
        ? {
            steps: [
              { type: "function_call", id: "a", name: "query_sales", arguments: { filters: { brands: ["Samsung"] } } },
              { type: "function_call", id: "b", name: "query_sales", arguments: { filters: { brands: ["Seagate"] } } },
            ],
            calls: [
              { id: "a", name: "query_sales", arguments: { filters: { brands: ["Samsung"] } } },
              { id: "b", name: "query_sales", arguments: { filters: { brands: ["Seagate"] } } },
            ],
            text: "",
            usage: {},
          }
        : say("Samsung ₹19,58,520, Seagate ₹17,08,920."),
    );
    const answer = await askCopilot("Samsung or Seagate?", [], { chat, data, cache: null });
    const results = requests[1].history.filter((step) => step.type === "function_result");
    expect(results.map((step) => step.call_id)).toEqual(["a", "b"]);
    expect(answer.sentenceSource).toBe("model");
  });

  test("the round and call limits hold, and a template closes the answer", async () => {
    const twoCalls: ChatTurnResult = {
      steps: [],
      calls: [
        { id: "x", name: "query_sales", arguments: {} },
        { id: "y", name: "query_sales", arguments: {} },
      ],
      text: "",
      usage: {},
    };
    const { chat, requests } = fakeChat(() => twoCalls);
    const answer = await askCopilot("Loop forever", [], { chat, data, cache: null });
    expect(requests).toHaveLength(COPILOT_MAX_ROUNDS);
    expect(answer.meta.toolCalls).toBe(COPILOT_MAX_TOOL_CALLS);
    expect(answer.steps).toHaveLength(COPILOT_MAX_TOOL_CALLS);
    expect(answer.sentenceSource).toBe("template");
    expect(answer.guardNote).toContain("still querying");
  });

  test("only the last 3 question and answer pairs are sent", async () => {
    const { chat, requests } = fakeChat(() => say("Fine."));
    const history = [1, 2, 4, 5].map((n) => ({ question: `question ${n}`, answer: `answer ${n}` }));
    await askCopilot("and Seagate?", history, { chat, data, cache: null });
    const text = (requests[0].history[0].content as { text: string }[])[0].text;
    expect(text).not.toContain("question 1");
    expect(text).toContain("question 5");
    expect(text).toContain("Question: and Seagate?");
  });

  test("an empty or overlong question is a bad request", async () => {
    const { chat } = fakeChat(() => say("x"));
    await expect(askCopilot("   ", [], { chat, data, cache: null })).rejects.toBeInstanceOf(BadRequestError);
    await expect(askCopilot("x".repeat(501), [], { chat, data, cache: null })).rejects.toBeInstanceOf(BadRequestError);
  });
});

// ------------------------------------------------------ free-tier savers

// ------------------------------------------------ price changes from approved lists

/** A price-change item for a product in the data, with its current prices as the "old" ones. */
function change(itemId: string, model: string, to: { dealerPrice?: number; mrp?: number }): PriceChangeItem {
  const product = data.products.find((p) => p.model === model);
  if (!product) throw new Error(`no product ${model}`);
  const old = { dealerPrice: product.dealerPrice, mrp: product.mrp };
  return {
    kind: "price-change",
    itemId,
    productId: product.productId,
    brand: product.brand,
    model: product.model,
    supplierModel: product.model,
    match: "key",
    old,
    new: { dealerPrice: to.dealerPrice ?? old.dealerPrice, mrp: to.mrp ?? old.mrp },
  } as PriceChangeItem;
}

function review(file: string, status: PriceReview["status"], items: PriceChangeItem[], applied?: string[], approvedAt?: string): PriceReview {
  return {
    fileId: file.slice(0, 12).padEnd(12, "0"),
    sourceFile: file,
    brand: items[0]?.brand ?? null,
    status,
    rowsInFile: 10,
    unchanged: 5,
    issues: 0,
    items,
    analysedAt: "2026-09-20T09:00:00.000Z",
    ...(approvedAt ? { approvedAt } : {}),
    ...(applied ? { applied } : {}),
  };
}

// Seagate (approved): a cut, a rise, an MRP-only rise, and a cut the reviewer did not apply.
// TP-Link (approved): a cut. Samsung (waiting for review) and a failed analysis are not counted.
const REVIEWS: PriceReview[] = [
  review(
    "Seagate_Price_List.xlsx",
    "approved",
    [
      change("s1", "FireCuda 530 1TB", { dealerPrice: 11400, mrp: 14900 }),
      change("s2", "Barracuda 2TB", { dealerPrice: 4450 }),
      change("s3", "IronWolf 4TB", { mrp: 11900 }),
      change("s4", "One Touch 2TB", { dealerPrice: 5900 }),
    ],
    ["s1", "s2", "s3"],
    "2026-09-20T10:00:00.000Z",
  ),
  review("TPLink_Price_List.xlsx", "approved", [change("t1", "TL-SG108", { dealerPrice: 1050, mrp: 1499 })], ["t1"], "2026-09-21T10:00:00.000Z"),
  review("Samsung_Price_List.csv", "needs-review", [change("m1", "T7 1TB", { dealerPrice: 7000 }), change("m2", "T7 2TB", { dealerPrice: 12000 })]),
  { ...review("Broken.xlsx", "failed", []), error: "unreadable" },
];
const withReviews: CopilotData = { ...data, reviews: REVIEWS };
const augustUnits = (productId: string) => unitsOf(between("2026-08-01", "2026-08-31").filter((l) => l.productId === productId));
const augustRevenue = (productId: string) => revenueOf(between("2026-08-01", "2026-08-31").filter((l) => l.productId === productId));

describe("lookup_price_changes reads approved lists only", () => {
  test("only changes applied from approved lists count; lists waiting for review are named", () => {
    const r = lookupPriceChanges(withReviews, {});
    expect(r.rows.map((row) => row.model).sort()).toEqual(["Barracuda 2TB", "FireCuda 530 1TB", "IronWolf 4TB", "TL-SG108"]);
    expect(r.appliedPriceChanges).toBe(4);
    expect(r.appliedByDirection).toEqual({ increase: 2, decrease: 2 });
    expect(r.approvedLists).toEqual([
      { file: "Seagate_Price_List.xlsx", brand: "Seagate", approvedOn: "2026-09-20", appliedPriceChanges: 3 },
      { file: "TPLink_Price_List.xlsx", brand: "TP-Link", approvedOn: "2026-09-21", appliedPriceChanges: 1 },
    ]);
    expect(r.waitingForReview).toEqual([{ file: "Samsung_Price_List.csv", brand: "Samsung", priceChanges: 2 }]);
    expect(r.salesPeriod).toBeNull();
  });

  test("cheaper means a lower dealer price, biggest cut first; an MRP-only change counts by the MRP", () => {
    const down = lookupPriceChanges(withReviews, { direction: "decrease" });
    expect(down.rows.map((row) => [row.model, row.dealerPriceChangePct])).toEqual([
      ["TL-SG108", -4.5],
      ["FireCuda 530 1TB", -3.4],
    ]);
    const up = lookupPriceChanges(withReviews, { direction: "increase" });
    expect(up.rows.map((row) => [row.model, row.dealerPriceChangePct, row.mrpChangePct])).toEqual([
      ["Barracuda 2TB", 3.5, 0],
      ["IronWolf 4TB", 0, 3.5],
    ]);
    expect(up.rows[1].direction).toBe("increase");
  });

  test("brand, category and model filters use the same matching as the other tools", () => {
    expect(lookupPriceChanges(withReviews, { filters: { brands: ["tplink"] } }).rows.map((r) => r.model)).toEqual(["TL-SG108"]);
    expect(lookupPriceChanges(withReviews, { filters: { categories: ["HDD"] } }).rows.map((r) => r.model).sort()).toEqual([
      "Barracuda 2TB",
      "IronWolf 4TB",
    ]);
    expect(lookupPriceChanges(withReviews, { filters: { models: ["FireCuda"] } }).rows).toHaveLength(1);
    const none = lookupPriceChanges(withReviews, { filters: { brands: ["Sony"] } });
    expect(none.rows).toHaveLength(0);
    expect(none.notes[0]).toContain('No brand matches "Sony"');
  });

  test("units and revenue for a period are joined by Product ID and match a brute-force sum", () => {
    const r = lookupPriceChanges(withReviews, { direction: "decrease", salesPeriod: { kind: "last_month" } });
    expect(r.salesPeriod).toMatchObject({ from: "2026-08-01", to: "2026-08-31" });
    for (const row of r.rows) {
      expect(row.units).toBe(augustUnits(row.productId));
      expect(row.revenue).toBe(augustRevenue(row.productId));
    }
    expect(r.rows.every((row) => row.units !== undefined)).toBe(true);
  });

  test("with no reviews there is no change, and the result says no list has been approved", () => {
    const r = lookupPriceChanges(data, { direction: "decrease" });
    expect(r).toMatchObject({ matched: 0, appliedPriceChanges: 0, approvedLists: [], waitingForReview: [] });
    expect(r.notes).toContain("No supplier price list has been approved yet, so no price has changed.");
    expect(executeTool("lookup_price_changes", {}, data).template).toBe(
      "No supplier price list has been approved yet, so no price has changed.",
    );
  });

  test("steps, table and template sentence are written by code", () => {
    const run = executeTool("lookup_price_changes", { direction: "decrease", salesPeriod: { kind: "last_month" } }, withReviews);
    expect(run.step.ok).toBe(true);
    expect(run.step.lines[0]).toBe(
      "Read as: price cuts · all products · approved lists only · with units sold in last month (1 Aug 2026 – 31 Aug 2026).",
    );
    expect(run.step.lines[1]).toBe(
      "Read 2 approved price lists (Seagate_Price_List.xlsx, approved 20 Sep 2026; TPLink_Price_List.xlsx, approved 21 Sep 2026): 4 applied price changes (2 up, 2 down).",
    );
    expect(run.step.lines).toContain("Kept changes where the price went down: 2 found.");
    expect(run.step.lines).toContain("Not included, still waiting for review: Samsung_Price_List.csv (2 price changes).");
    const table = run.step.table!;
    expect(table.columns.map((c) => c.label)).toEqual([
      "Model", "Brand", "Dealer price", "Change", "MRP", "List", "Approved", "Units sold", "Revenue",
    ]);
    expect(table.rows[0]).toMatchObject({ model: "TL-SG108", dealerPrice: "₹1,100 → ₹1,050", change: "↓ 4.5%", approved: "21 Sep 2026" });
    expect(table.footnotes).toContain("Not included, waiting for review: Samsung_Price_List.csv.");
    const tl = data.products.find((p) => p.model === "TL-SG108")!;
    expect(run.template).toContain(`TL-SG108 ₹1,100 → ₹1,050, ${augustUnits(tl.productId)} sold`);
    expect(run.template).toContain("1 list waiting for review is not included.");

    const mrpOnly = executeTool("lookup_price_changes", { filters: { models: ["IronWolf 4TB"] } }, withReviews).step.table!;
    expect(mrpOnly.rows[0]).toMatchObject({ dealerPrice: "₹8,900 (unchanged)", change: "MRP ↑ 3.5%", mrp: "₹11,500 → ₹11,900" });

    // Only rises approved: asking for cuts says none went down.
    const onlyUp: CopilotData = { ...data, reviews: [REVIEWS[0]] };
    const cuts = executeTool("lookup_price_changes", { direction: "decrease", filters: { categories: ["HDD"] } }, onlyUp);
    expect(cuts.template).toBe(
      "No approved price change where category is HDD went down. The approved list (Seagate_Price_List.xlsx) applied 3 price changes (2 up, 1 down).",
    );
  });

  test("no result carries an email address", () => {
    const result = executeTool("lookup_price_changes", { salesPeriod: { kind: "all" } }, withReviews).modelResult;
    expect(JSON.stringify(result)).not.toContain("@");
  });

  test("askCopilot reads the reviews it is given, and a changed review misses the cache", async () => {
    const script = (turn: number) =>
      turn % 2 === 1
        ? call(`p${turn}`, "lookup_price_changes", { direction: "decrease", salesPeriod: { kind: "last_month" } })
        : say("TL-SG108 went from ₹1,100 to ₹1,050.");
    const { chat, requests } = fakeChat(script);
    const cache = new Map();
    const answer = await askCopilot("Which models got cheaper, and how many did we sell last month?", [], {
      chat,
      data: withReviews,
      cache,
    });
    expect(answer.steps[0]).toMatchObject({ tool: "lookup_price_changes", ok: true });
    expect(answer.sentenceSource).toBe("model");
    await askCopilot("Which models got cheaper, and how many did we sell last month?", [], {
      chat,
      data: { ...withReviews, reviews: REVIEWS.slice(1) },
      cache,
    });
    expect(requests).toHaveLength(4);
  });

  test("the instructions send price-change questions to the tool, not to 'cannot answer'", async () => {
    const { chat, requests } = fakeChat(() => say("Hello."));
    await askCopilot("hi", [], { chat, data, cache: null });
    expect(requests[0].instructions).toContain("use lookup_price_changes");
    expect(requests[0].instructions).toContain('"This quarter" is this_quarter');
    expect(requests[0].instructions).toContain("make one query for the question as read");
    expect(requests[0].instructions).not.toContain("There is no price history");
  });
});

// ------------------------------------------------------------ vague questions (spec §10)

const SSD_OPTIONS = [
  { measure: "units", question: "How many SSDs did we sell last month?" },
  { measure: "revenue", question: "What was our SSD revenue last month?" },
  { measure: "dealers", question: "How many dealers bought SSDs in the last 90 days?" },
  { measure: "prices", question: "What are the current SSD prices?" },
];
const SSD_CLARIFY = { subject: "SSDs", options: SSD_OPTIONS };

function turnOf(...calls: { id: string; name: string; arguments: Record<string, unknown> }[]): ChatTurnResult {
  return { steps: calls.map((c) => ({ type: "function_call", ...c })), calls, text: "", usage: {} };
}

describe("vague questions", () => {
  test("a clarification runs no query, and every word but the examples is the app's", async () => {
    const { chat, requests } = fakeChat(() => call("q1", CLARIFY_TOOL, SSD_CLARIFY));
    const answer = await askCopilot("How are SSDs doing?", [], { chat, data, cache: null });

    expect(requests).toHaveLength(1);
    expect(answer.sentenceSource).toBe("clarify");
    expect(answer.sentence).toBe("I'm not sure what you'd like to know about SSDs.");
    expect(answer.steps).toEqual([]);
    expect(answer.meta).toMatchObject({ rounds: 1, toolCalls: 0 });
    expect(answer.clarification).toEqual({
      subject: "SSDs",
      options: [
        { measure: "units", label: "Sales quantity", question: SSD_OPTIONS[0].question },
        { measure: "revenue", label: "Revenue", question: SSD_OPTIONS[1].question },
        { measure: "dealers", label: "Number of dealers", question: SSD_OPTIONS[2].question },
        { measure: "prices", label: "Current prices", question: SSD_OPTIONS[3].question },
      ],
    });
  });

  test("the text left in the history carries the options, so a typed reply has context", async () => {
    const { chat } = fakeChat(() => call("q1", CLARIFY_TOOL, SSD_CLARIFY));
    const answer = await askCopilot("How are SSDs doing?", [], { chat, data, cache: null });
    const text = historyText(answer);
    expect(text).toBe(clarificationText(answer.clarification!));
    expect(text).toBe(
      "I'm not sure what you'd like to know about SSDs. Would you like to see: Sales quantity, Revenue, " +
        'Number of dealers, Current prices? For example: "How many SSDs did we sell last month?"',
    );
    expect(historyText({ sentence: "Plain answer." })).toBe("Plain answer.");

    // That text is what the next request sends as the earlier turn.
    const next = fakeChat(() => say("Fine."));
    await askCopilot("revenue", [{ question: "How are SSDs doing?", answer: text }], { chat: next.chat, data, cache: null });
    expect(JSON.stringify(next.requests[0].history[0])).toContain("Would you like to see: Sales quantity, Revenue");
  });

  test("a clarification is cached like any answer", async () => {
    const { chat, requests } = fakeChat(() => call("q1", CLARIFY_TOOL, SSD_CLARIFY));
    const cache = new Map();
    await askCopilot("How are SSDs doing?", [], { chat, data, cache });
    const again = await askCopilot("how are SSDs doing", [], { chat, data, cache });
    expect(requests).toHaveLength(1);
    expect(again).toMatchObject({ sentenceSource: "clarify", meta: { cached: true } });
    expect(again.clarification?.options).toHaveLength(4);
  });

  test("a subject that is not in the question goes back to the model, whose next turn is used", async () => {
    const { chat, requests } = fakeChat((turn) =>
      turn === 1
        ? call("q1", CLARIFY_TOOL, { ...SSD_CLARIFY, subject: "Click here to win" })
        : call("q2", CLARIFY_TOOL, SSD_CLARIFY),
    );
    const answer = await askCopilot("How are SSDs doing?", [], { chat, data, cache: null });
    expect(JSON.stringify(requests[1].history.at(-1))).toContain("subject must be words from the question");
    expect(answer.sentenceSource).toBe("clarify");
    expect(answer.steps).toHaveLength(1);
    expect(answer.steps[0]).toMatchObject({ tool: CLARIFY_TOOL, ok: false });
    expect(answer.meta.rounds).toBe(2);
  });

  test("a clarification next to a query is rejected, and the query still runs", async () => {
    const { chat, requests } = fakeChat((turn) =>
      turn === 1
        ? turnOf(
            { id: "q", name: "query_sales", arguments: SAMSUNG_BY_DEALER },
            { id: "c", name: CLARIFY_TOOL, arguments: SSD_CLARIFY },
          )
        : say("XYZ Electronics bought the most: 39 units."),
    );
    const answer = await askCopilot("How are SSDs doing?", [], { chat, data, cache: null });
    expect(answer.clarification).toBeUndefined();
    expect(answer.sentenceSource).toBe("model");
    expect(answer.steps.map((step) => [step.tool, step.ok])).toEqual([
      ["query_sales", true],
      [CLARIFY_TOOL, false],
    ]);
    const results = requests[1].history.filter((step) => step.type === "function_result");
    expect(results.map((step) => step.call_id)).toEqual(["q", "c"]);
    expect(JSON.stringify(results[1])).toContain("must be the only call, made before any query");
    expect(answer.meta.toolCalls).toBe(1);
  });

  test("a clarification after a query is rejected", async () => {
    const { chat } = fakeChat((turn) =>
      turn === 1
        ? call("q1", "query_sales", SAMSUNG_BY_DEALER)
        : turn === 2
          ? call("q2", CLARIFY_TOOL, SSD_CLARIFY)
          : say("XYZ Electronics bought the most: 39 units."),
    );
    const answer = await askCopilot("How are SSDs doing?", [], { chat, data, cache: null });
    expect(answer.clarification).toBeUndefined();
    expect(answer.steps.map((step) => [step.tool, step.ok])).toEqual([
      ["query_sales", true],
      [CLARIFY_TOOL, false],
    ]);
    expect(answer.sentenceSource).toBe("model");
  });

  test("a clarification that keeps failing ends as 'could not work out a query', not a guess", async () => {
    const bad = { subject: "SSDs", options: [SSD_OPTIONS[0]] };
    const { chat, requests } = fakeChat(() => call("q", CLARIFY_TOOL, bad));
    const answer = await askCopilot("How are SSDs doing?", [], { chat, data, cache: null });
    expect(requests).toHaveLength(COPILOT_MAX_ROUNDS);
    expect(answer.sentenceSource).toBe("refusal");
    expect(answer.clarification).toBeUndefined();
    expect(answer.meta.toolCalls).toBe(0);
  });

  test("the checks: options, measures and example questions", () => {
    const q = "How are SSDs doing?";
    const check = (options: unknown[], subject = "SSDs") => checkClarification({ subject, options }, q);
    const growth = { measure: "growth", question: "How did SSD sales change against the month before?" };
    expect(typeof check(SSD_OPTIONS)).toBe("object");
    expect(check([SSD_OPTIONS[0]])).toContain("options");
    expect(check([...SSD_OPTIONS, growth])).toContain("options");
    expect(check([SSD_OPTIONS[0], { measure: "stock", question: "How many SSDs are in stock right now?" }])).toContain(
      "measure",
    );
    expect(check([SSD_OPTIONS[0], { measure: "units", question: "How many SSDs did we sell last week?" }])).toContain(
      "appears twice",
    );
    expect(check([SSD_OPTIONS[0], { measure: "revenue", question: "What was SSD revenue\nlast month?" }])).toContain(
      "one line",
    );
    expect(check([SSD_OPTIONS[0], { measure: "revenue", question: "Show SSD revenue for last month" }])).toContain(
      'end with "?"',
    );
    expect(check([SSD_OPTIONS[0], { measure: "revenue", question: "What was **SSD** revenue last month?" }])).toContain(
      "markdown",
    );
    // Whole words, any case: "ssds" is in the question; "SD" is only part of a word.
    expect(typeof check(SSD_OPTIONS, "ssds")).toBe("object");
    expect(check(SSD_OPTIONS, "SD")).toContain("subject must be words from the question");
    expect(
      typeof checkClarification({ subject: "abc  computers", options: SSD_OPTIONS }, "Tell me about ABC Computers"),
    ).toBe("object");
    // Gemini's nulls count as left out, as for the other tools.
    expect(typeof checkClarification({ subject: "SSDs", options: SSD_OPTIONS, extra: null }, q)).toBe("object");
  });

  test("with the data, readings that cannot fit the subject go back to the model", () => {
    const pick = (...measures: string[]) =>
      measures.map((measure) => ({ measure, question: `What about the ${measure.replace("_", " ")} last month?` }));
    const abc = (options: unknown[]) =>
      checkClarification({ subject: "ABC Computers", options }, "Tell me about ABC Computers", data);
    expect(abc(pick("revenue", "dealers"))).toBe(
      '"ABC Computers" is a dealer, so dealers does not fit. Readings for a dealer: units, revenue, growth.',
    );
    expect(abc(pick("units", "price_changes"))).toContain("price_changes does not fit");
    expect(typeof abc(pick("units", "revenue", "growth"))).toBe("object");
    const state = checkClarification({ subject: "Gujarat", options: pick("revenue", "prices") }, "What about Gujarat?", data);
    expect(state).toContain('"Gujarat" is a state, so prices does not fit');
    const product = pick("dealers", "prices", "price_changes");
    expect(typeof checkClarification({ subject: "SSDs", options: product }, "How are SSDs doing?", data)).toBe("object");
    expect(typeof checkClarification({ subject: "Samsung", options: product }, "What about Samsung?", data)).toBe("object");
    // A subject the data does not know is not restricted; without the data nothing is checked.
    expect(typeof checkClarification({ subject: "gadgets", options: product }, "How are gadgets doing?", data)).toBe("object");
    expect(
      typeof checkClarification({ subject: "ABC Computers", options: pick("dealers", "units") }, "Tell me about ABC Computers"),
    ).toBe("object");
  });

  test("the labels are the app's, one per measure, including price changes", () => {
    expect(Object.keys(MEASURE_LABELS)).toEqual(["units", "revenue", "dealers", "prices", "price_changes", "growth"]);
    expect(MEASURE_LABELS.price_changes).toBe("Price changes");
    const withChanges = checkClarification(
      { subject: "Samsung", options: [SSD_OPTIONS[1], { measure: "price_changes", question: "Which Samsung prices went up?" }] },
      "What about Samsung?",
    );
    expect(typeof withChanges === "object" && withChanges.options[1].label).toBe("Price changes");
    expect(CLARIFY_SOURCE_NOTE).toBe("No query was run: the question did not say what to measure.");
  });

  test("the instructions tell the model when to ask and when not to, and the tool converts for Gemini", async () => {
    const { chat, requests } = fakeChat(() => say("Hello."));
    await askCopilot("hi", [], { chat, data, cache: null });
    const { instructions, tools } = requests[0];
    expect(instructions).toContain("call ask_clarification, alone, instead of any query");
    expect(instructions).toContain("How are SSDs doing?");
    expect(instructions).toMatch(/Never call it when the question has a measure/);
    const declared = tools.find((tool) => tool.name === CLARIFY_TOOL)!;
    const schema = JSON.stringify(toGeminiSchema(declared.parameters));
    expect(schema).toContain('"units"');
    expect(schema).toContain('"prices"');
  });
});

describe("saving Gemini requests", () => {
  const script = (turn: number) =>
    turn % 2 === 1 ? call(`c${turn}`, "query_sales", SAMSUNG_BY_DEALER) : say("XYZ Electronics bought 39 units.");

  test("asking the same question again makes no model call", async () => {
    const { chat, requests } = fakeChat(script);
    const cache = new Map();
    const first = await askCopilot("Which dealer bought the most Samsung?", [], { chat, data, cache });
    const again = await askCopilot("  which dealer bought the most samsung  ", [], { chat, data, cache });
    expect(requests).toHaveLength(2);
    expect(again.sentence).toBe(first.sentence);
    expect(again.meta.cached).toBe(true);
    expect(first.meta.cached).toBeUndefined();
  });

  test("different history or changed data misses the cache", async () => {
    const { chat, requests } = fakeChat(script);
    const cache = new Map();
    await askCopilot("Top dealer?", [], { chat, data, cache });
    await askCopilot("Top dealer?", [{ question: "q", answer: "a" }], { chat, data, cache });
    const changed = { ...data, sales: data.sales.slice(1) };
    await askCopilot("Top dealer?", [], { chat, data: changed, cache });
    expect(requests).toHaveLength(6);
  });

  test("economy mode asks Gemini once and lets the app write the sentence", async () => {
    const { chat, requests } = fakeChat(script);
    const answer = await askCopilot("Which dealer bought the most Samsung?", [], {
      chat,
      data,
      cache: null,
      sentence: "template",
    });
    expect(requests).toHaveLength(1);
    expect(answer.sentenceSource).toBe("template");
    expect(answer.sentence).toContain("XYZ Electronics is highest by units with 39 units");
    expect(answer.guardNote).toBeUndefined();
  });

  test("economy mode still passes a tool-free reply through", async () => {
    const { chat } = fakeChat(() => say("Hello, ask me about sales."));
    const answer = await askCopilot("hello", [], { chat, data, cache: null, sentence: "template" });
    expect(answer.sentenceSource).toBe("no_tool");
  });

  test("each feature can have its own model", () => {
    const saved = { ...process.env };
    try {
      process.env.LLM_MODEL = "shared-model";
      delete process.env.COPILOT_MODEL;
      delete process.env.ANALYSE_MODEL;
      expect(llmModel("copilot")).toBe("shared-model");
      process.env.COPILOT_MODEL = "lite-model";
      expect(llmModel("copilot")).toBe("lite-model");
      expect(llmModel("analyse")).toBe("shared-model");
      process.env.ANALYSE_MODEL = "flash-model";
      expect(llmModel("analyse")).toBe("flash-model");
      delete process.env.LLM_MODEL;
      delete process.env.COPILOT_MODEL;
      delete process.env.ANALYSE_MODEL;
      expect(llmModel("copilot")).toBe("gemini-3.8-flash");
    } finally {
      for (const name of ["LLM_MODEL", "COPILOT_MODEL", "ANALYSE_MODEL"]) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
    }
  });
});

// ---------------------------------------------------------- Gemini wrapper

describe("Gemini chat wrapper", () => {
  test("sends a stateless request with function tools and the whole history", async () => {
    const seen: Record<string, unknown>[] = [];
    const chat = createGeminiChat({
      model: () => "test-model",
      client: () => ({
        interactions: {
          create: async (params) => {
            seen.push(params);
            return { status: "completed", output_text: "Done.", steps: [] };
          },
        },
      }),
    });
    const history: ChatStep[] = [{ type: "user_input", content: [{ type: "text", text: "hi" }] }];
    const result = await chat.turn({ instructions: "be brief", tools: toolDeclarations(), history });

    expect(result.text).toBe("Done.");
    expect(seen[0]).toMatchObject({ model: "test-model", system_instruction: "be brief", store: false, input: history });
    const tools = seen[0].tools as { type: string; name: string; parameters: { type: string } }[];
    expect(tools.map((tool) => [tool.type, tool.name, tool.parameters.type])).toEqual([
      ["function", "query_sales", "object"],
      ["function", "compare_periods", "object"],
      ["function", "lookup_products", "object"],
      ["function", "lookup_price_changes", "object"],
    ]);
  });

  // The shape the live API returned in the spike on 2026-09-21.
  test("reads a function call and keeps the thought step verbatim", () => {
    const result = parseInteraction({
      status: "requires_action",
      steps: [
        { type: "thought", signature: "sig" },
        { type: "function_call", id: "call_1", name: "query_sales", arguments: { groupBy: "dealer" } },
      ],
      usage: { total_input_tokens: 2334, total_output_tokens: 48 },
    });
    expect(result.steps[0]).toEqual({ type: "thought", signature: "sig" });
    expect(result.calls).toEqual([{ id: "call_1", name: "query_sales", arguments: { groupBy: "dealer" } }]);
    expect(result.usage).toEqual({ inputTokens: 2334, outputTokens: 48 });
  });

  test("falls back to the model_output text when output_text is absent", () => {
    const result = parseInteraction({ status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: "Hi." }] }] });
    expect(result.text).toBe("Hi.");
  });

  test("a failed interaction is an LLM error", () => {
    expect(() => parseInteraction({ status: "failed" })).toThrow(InvalidLlmOutputError);
  });

  // The message Google sent live on 2026-09-21 once the free tier's daily quota was spent.
  test("a spent daily quota says so, instead of 'wait a minute'", () => {
    const error = Object.assign(
      new Error(
        "429 Rate limit exceeded for model gemini-3.8-flash (limit: 20 requests per day on Free Tier). " +
          "Please retry in 12s or upgrade your tier at https://ai.dev/rate-limit.",
      ),
      { status: 429 },
    );
    const mapped = mapGeminiError(error) as LlmUnavailableError;
    expect(mapped).toBeInstanceOf(LlmUnavailableError);
    expect(mapped.message).toContain("daily request limit (20 requests per day on Free Tier)");
    expect(mapped.message).not.toContain("Wait a minute");
  });

  test("rate limits and outages become LlmUnavailableError; a bad request does not", () => {
    expect(mapGeminiError({ status: 429, message: "quota" })).toBeInstanceOf(LlmUnavailableError);
    expect(mapGeminiError({ status: 503 })).toBeInstanceOf(LlmUnavailableError);
    const bad = { status: 400 };
    expect(mapGeminiError(bad)).toBe(bad);
  });
});

describe("Copy table and Download CSV", () => {
  const table = {
    title: "Sales where brand is Samsung, by dealer",
    columns: [
      { key: "name", label: "Dealer" },
      { key: "revenue", label: "Revenue", numeric: true },
    ],
    rows: [{ name: 'XYZ "Electronics"', revenue: "₹4,32,540" }],
    footnotes: [],
  };

  test("CSV quotes commas and quotes, and keeps the shown formatting", () => {
    expect(tableToCsv(table)).toBe('Dealer,Revenue\r\n"XYZ ""Electronics""","₹4,32,540"\r\n');
  });

  test("the copied text is tab-separated so it pastes as cells", () => {
    expect(tableToTsv(table)).toBe('Dealer\tRevenue\nXYZ "Electronics"\t₹4,32,540');
  });

  test("the file is named after the table", () => {
    expect(csvFilename(table)).toBe("sales-where-brand-is-samsung-by-dealer.csv");
  });
});

describe("request body", () => {
  test("trims the question and keeps the last 3 history pairs", () => {
    const pairs = Array.from({ length: 5 }, (_, i) => ({ question: `q${i}`, answer: `a${i}` }));
    const parsed = askBodySchema.parse({ question: "  hello  ", history: pairs });
    expect(parsed.question).toBe("hello");
    expect(parsed.history.map((pair) => pair.question)).toEqual(["q2", "q3", "q4"]);
  });

  test("rejects an empty or overlong question", () => {
    expect(askBodySchema.safeParse({ question: "   " }).success).toBe(false);
    expect(askBodySchema.safeParse({ question: "x".repeat(501) }).success).toBe(false);
  });
});
