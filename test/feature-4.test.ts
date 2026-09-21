import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { askCopilot, NO_TOOL_REFUSAL } from "@/lib/copilot/ask";
import { csvFilename, tableToCsv, tableToTsv } from "@/lib/copilot/export";
import { resolveFilters } from "@/lib/copilot/filters";
import { allowedNumbers, checkNumbers, numbersIn } from "@/lib/copilot/guard";
import { resolvePeriod } from "@/lib/copilot/period";
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
import { BadRequestError, InvalidLlmOutputError, LlmUnavailableError } from "@/lib/errors";
import { createGeminiChat, mapGeminiError, parseInteraction } from "@/lib/llm/chat";
import { llmModel } from "@/lib/llm/client";
import type { ChatPort, ChatStep, ChatTurnRequest, ChatTurnResult } from "@/lib/llm/port";
import { toGeminiSchema } from "@/lib/llm/schemas";
import type { Dealer, Product, SalesLine } from "@/lib/types";

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
    expect(TOOLS.map((tool) => tool.name)).toEqual(["query_sales", "compare_periods", "lookup_products"]);
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
    expect(tools.map((tool) => tool.name)).toEqual(["query_sales", "compare_periods", "lookup_products"]);
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
