/**
 * Live evaluation of the Sales Copilot against the real Gemini API.
 *
 *   bun run copilot:eval            every question
 *   bun run copilot:eval 3 7        only questions 3 and 7
 *
 * Needs GEMINI_API_KEY. Each question costs two or three Gemini calls.
 *
 * It does not grade wording. It checks what the model chose to run: the tool
 * results its calls produced are compared with values computed here,
 * independently, straight from the JSON files. A question passes when the
 * right figures were retrieved and the sentence shown obeys the rules.
 * See context/features/feature-4-sales-copilot.md §9.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { askCopilot } from "@/lib/copilot/ask";
import type { CopilotAnswer, HistoryPair } from "@/lib/copilot/types";
import { clarificationText, MEASURE_LABELS } from "@/lib/copilot/wording";
import { LlmUnavailableError } from "@/lib/errors";
import type { PriceChangeItem, PriceReview, Product, SalesLine } from "@/lib/types";

// ------------------------------------------------ independent expectations

const root = join(import.meta.dir, "..", "mock-data");
const sales = JSON.parse(readFileSync(join(root, "sales", "sales-data.json"), "utf8")) as SalesLine[];
const products = JSON.parse(
  readFileSync(join(root, "current-price-lists", "current-price-list.json"), "utf8"),
) as Product[];
const byId = new Map(products.map((p) => [p.productId, p]));
const rev = (lines: SalesLine[]) => lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
const inRange = (from: string, to: string) => sales.filter((l) => l.date >= from && l.date <= to);
const top = (lines: SalesLine[], key: (l: SalesLine) => string, measure: "revenue" | "units") => {
  const m = new Map<string, number>();
  for (const l of lines) m.set(key(l), (m.get(key(l)) ?? 0) + (measure === "units" ? l.quantity : l.quantity * l.unitPrice));
  return [...m].sort((a, b) => b[1] - a[1]).map(([name]) => name);
};
const brandLines = (brand: string, lines = sales) => lines.filter((l) => byId.get(l.productId)?.brand === brand);

const AUG = ["2026-08-01", "2026-08-31"] as const;
const SEP = ["2026-09-01", "2026-09-18"] as const;
const t7 = products.find((p) => p.model === "T7 1TB");

// Price changes applied from approved lists, read straight from Feature 2's reviews,
// so the expectations follow whatever has been approved on this machine.
const reviewsDir = join(import.meta.dir, "..", ".data", "reviews");
const reviews: PriceReview[] = existsSync(reviewsDir)
  ? readdirSync(reviewsDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(reviewsDir, f), "utf8")) as PriceReview)
  : [];
const appliedChanges = reviews
  .filter((r) => r.status === "approved")
  .flatMap((r) => r.items.filter((i): i is PriceChangeItem => i.kind === "price-change" && (r.applied ?? []).includes(i.itemId)));
const went = (i: PriceChangeItem) => Math.sign(i.new.dealerPrice - i.old.dealerPrice || i.new.mrp - i.old.mrp);
const increases = appliedChanges.filter((i) => went(i) > 0).map((i) => i.productId).sort();
const decreases = appliedChanges.filter((i) => went(i) < 0).map((i) => i.productId).sort();
const augustUnits = (productId: string) =>
  inRange(...AUG).filter((l) => l.productId === productId).reduce((s, l) => s + l.quantity, 0);

/** The lookup_price_changes result lists exactly these products, with August units when asked. */
const priceChanges = (a: CopilotAnswer, expected: string[], withUnits: boolean): string[] =>
  some(
    a,
    "lookup_price_changes",
    (r) =>
      JSON.stringify(r.rows.map((row: Result) => row.productId).sort()) === JSON.stringify(expected) &&
      (!withUnits ||
        (r.salesPeriod?.from === AUG[0] && r.rows.every((row: Result) => row.units === augustUnits(row.productId)))),
    `listing exactly the ${expected.length} applied change(s)${withUnits ? " with August units" : ""}`,
  );

// ------------------------------------------------------------------ helpers

type Result = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- tool results are checked loosely here

const results = (a: CopilotAnswer, tool?: string): Result[] =>
  a.steps.filter((s) => s.ok && (!tool || s.tool === tool)).map((s) => s.result as Result);

const some = (a: CopilotAnswer, tool: string, ok: (r: Result) => boolean, what: string): string[] =>
  results(a, tool).some(ok) ? [] : [`no ${tool} result ${what}`];

const noDigitsUnlessChecked = (a: CopilotAnswer): string[] =>
  a.sentenceSource === "model" || a.sentenceSource === "template" || !/\d/.test(a.sentence)
    ? []
    : ["the sentence has numbers but was not checked"];

interface Case {
  question: string;
  history?: HistoryPair[];
  /** A vague question: it must get a clarification. Every other case fails if it gets one. */
  clarify?: boolean;
  check: (a: CopilotAnswer) => string[];
}

/** A clarification with 2–4 readings, whose subject is in the question (spec §10). */
const clarified = (a: CopilotAnswer, subject: RegExp, notOffered: string[] = []): string[] => {
  const c = a.clarification;
  if (a.sentenceSource !== "clarify" || !c) return ["did not ask what the question means"];
  return [
    ...(subject.test(c.subject) ? [] : [`subject "${c.subject}"`]),
    ...(c.options.length >= 2 && c.options.length <= 4 ? [] : [`${c.options.length} options`]),
    ...c.options.filter((o) => notOffered.includes(o.measure)).map((o) => `offered ${o.measure}, which does not fit`),
    ...(a.steps.some((s) => s.ok) ? ["ran a query as well"] : []),
  ];
};

const SSD_CLARIFICATION = clarificationText({
  subject: "SSDs",
  options: [
    { measure: "units", label: MEASURE_LABELS.units, question: "How many SSDs did we sell last month?" },
    { measure: "revenue", label: MEASURE_LABELS.revenue, question: "What was our SSD revenue last month?" },
    { measure: "dealers", label: MEASURE_LABELS.dealers, question: "How many dealers bought SSDs in the last 90 days?" },
    { measure: "prices", label: MEASURE_LABELS.prices, question: "What are the current SSD prices?" },
  ],
});

const CASES: Case[] = [
  {
    question: "Which models generated the most sales last month?",
    check: (a) =>
      some(
        a,
        "query_sales",
        (r) => r.period.from === AUG[0] && r.period.to === AUG[1] && r.groupBy === "model" &&
          r.rows[0]?.name === top(inRange(...AUG), (l) => byId.get(l.productId)?.model ?? l.model, r.sortBy === "units" ? "units" : "revenue")[0],
        "ranks August's models correctly",
      ),
  },
  {
    question: "How much did we sell to ABC Computers in the last 90 days?",
    check: (a) =>
      some(a, "query_sales", (r) => r.totals.revenue === rev(inRange("2026-06-20", "2026-09-18").filter((l) => l.dealer === "ABC Computers")), "with ABC's 90-day total"),
  },
  {
    question: "Which dealer bought the most Samsung products?",
    check: (a) =>
      some(a, "query_sales", (r) => r.groupBy === "dealer" && r.rows[0]?.name === top(brandLines("Samsung"), (l) => l.dealer, r.sortBy === "units" ? "units" : "revenue")[0], "with the top Samsung dealer"),
  },
  {
    question: "Which dealers have not bought any Samsung products?",
    check: (a) => some(a, "query_sales", (r) => r.includeZero === true && r.zeroSales?.count === 4, "listing the 4 dealers with no Samsung sales"),
  },
  {
    question: "Are there dealers who never bought Seagate?",
    check: (a) => [
      ...some(a, "query_sales", (r) => r.groupBy === "dealer" && r.zeroSales?.count === 0, "showing every dealer bought Seagate"),
      ...(/\b(no|none|all|every)\b/i.test(a.sentence) ? [] : ["the sentence does not say that none are missing"]),
    ],
  },
  {
    question: "What is the total sales value for routers?",
    check: (a) => some(a, "query_sales", (r) => r.totals.revenue === rev(sales.filter((l) => byId.get(l.productId)?.category === "Router")), "with the router total"),
  },
  {
    question: "Which state buys the most?",
    check: (a) => some(a, "query_sales", (r) => r.groupBy === "state" && r.rows[0]?.name === top(sales, (l) => l.state, r.sortBy === "units" ? "units" : "revenue")[0], "with the top state"),
  },
  {
    question: "What share of our revenue comes from Samsung?",
    check: (a) =>
      some(
        a,
        "query_sales",
        (r) => r.totals.shareOfAllRevenuePct === 44.6 || r.rows?.some((row: Result) => row.name === "Samsung" && row.revenueSharePct === 44.6),
        "with Samsung's 44.6% share",
      ),
  },
  {
    question: "Compare August with July",
    check: (a) =>
      some(a, "compare_periods", (r) => r.baseline.revenue === rev(inRange("2026-07-01", "2026-07-31")) && r.comparison.revenue === rev(inRange(...AUG)), "with July then August"),
  },
  {
    question: "How is September going compared with August?",
    check: (a) =>
      some(a, "compare_periods", (r) => r.comparison.to === SEP[1] && r.caveats.join(" ").includes("not over"), "that flags September as unfinished"),
  },
  {
    question: "What's the dealer price of T7 1TB?",
    check: (a) => some(a, "lookup_products", (r) => r.rows.some((row: Result) => row.model === "T7 1TB" && row.dealerPrice === t7?.dealerPrice), "with T7 1TB's price"),
  },
  {
    question: "Which products had a price increase?",
    check: (a) => priceChanges(a, increases, false),
  },
  {
    question: "hello",
    check: (a) => [...(a.steps.length === 0 ? [] : ["called a tool for a greeting"]), ...(/\d/.test(a.sentence) ? ["numbers in a greeting"] : [])],
  },
  {
    question: "Give me the email addresses of the dealers in Gujarat",
    check: (a) => (JSON.stringify(a).includes("@") ? ["an email address appeared"] : []),
  },
  {
    question: "Top 3 dealers by units in September",
    check: (a) =>
      some(a, "query_sales", (r) => r.period.from === SEP[0] && r.rows.length === 3 && r.rows[0].name === top(inRange(...SEP), (l) => l.dealer, "units")[0], "with September's top 3 by units"),
  },
  {
    question: "And Seagate?",
    history: [{ question: "What was Samsung's revenue last month?", answer: `Samsung's revenue in August 2026 was ₹${rev(brandLines("Samsung", inRange(...AUG))).toLocaleString("en-IN")}.` }],
    check: (a) => some(a, "query_sales", (r) => r.totals.revenue === rev(brandLines("Seagate", inRange(...AUG))), "with Seagate's August revenue (a follow-up)"),
  },
  // Quarters: the model reads the period; code works out the dates (one query, no trying periods).
  {
    question: "Who are the top 5 dealers by sales value this quarter?",
    check: (a) => [
      ...some(
        a,
        "query_sales",
        (r) =>
          r.period.from === "2026-07-01" && r.period.to === SEP[1] && r.groupBy === "dealer" && r.rows.length === 5 &&
          JSON.stringify(r.rows.map((row: Result) => row.name)) === JSON.stringify(top(inRange("2026-07-01", SEP[1]), (l) => l.dealer, "revenue").slice(0, 5)),
        "with this quarter's top 5 dealers by revenue",
      ),
      ...(a.meta.toolCalls === 1 ? [] : [`${a.meta.toolCalls} queries instead of 1`]),
    ],
  },
  {
    question: "What were our sales in Q2 of this financial year?",
    check: (a) =>
      some(
        a,
        "query_sales",
        (r) => r.period.from === "2026-07-01" && r.period.reading === "Q2 of financial year 2026-27" && r.totals.revenue === rev(inRange("2026-07-01", SEP[1])),
        "for Q2 of financial year 2026-27 (1 Jul – 18 Sep)",
      ),
  },
  {
    question: "Compare this quarter with last quarter",
    check: (a) =>
      some(
        a,
        "compare_periods",
        (r) => r.baseline.from === "2026-04-01" && r.comparison.from === "2026-07-01" && r.caveats.some((c: string) => /before the first sale/.test(c)),
        "comparing Apr–Jun with Jul–Sep, noting there are no sales before July",
      ),
  },
  // Price changes from approved lists (read from .data/reviews/).
  {
    question: "Which models got cheaper in the new lists, and how many of each did we sell last month?",
    check: (a) => priceChanges(a, decreases, decreases.length > 0),
  },
  {
    question: "Which models got more expensive, and how many of each did we sell last month?",
    check: (a) => priceChanges(a, increases, true),
  },
  // Vague questions (spec §10): ask, do not guess.
  {
    question: "How are SSDs doing?",
    clarify: true,
    check: (a) => clarified(a, /ssd/i),
  },
  {
    question: "What about Samsung?",
    clarify: true,
    check: (a) => clarified(a, /samsung/i),
  },
  {
    question: "Tell me about ABC Computers",
    clarify: true,
    check: (a) => clarified(a, /abc computers/i, ["prices", "dealers"]),
  },
  {
    question: "Revenue",
    history: [{ question: "How are SSDs doing?", answer: SSD_CLARIFICATION }],
    check: (a) =>
      some(
        a,
        "query_sales",
        (r) => r.totals.revenue === rev(inRange(r.period.from, r.period.to).filter((l) => byId.get(l.productId)?.category === "SSD")),
        "with SSD revenue for the period it chose (a reply to the clarification)",
      ),
  },
];

// --------------------------------------------------------------------- run

async function withRetry(question: string, history: HistoryPair[]): Promise<CopilotAnswer> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await askCopilot(question, history);
    } catch (error) {
      if (!(error instanceof LlmUnavailableError) || attempt >= 4) throw error;
      if (/daily/i.test(error.message)) {
        console.log(`\nStopping: ${error.message}`);
        process.exit(2);
      }
      const wait = 20 * attempt;
      console.log(`   ${error.message} Waiting ${wait}s (attempt ${attempt} of 3)…`);
      await new Promise((resolve) => setTimeout(resolve, wait * 1000));
    }
  }
}

const only = process.argv.slice(2).map(Number).filter(Boolean);
const selected = CASES.map((c, i) => ({ ...c, n: i + 1 })).filter((c) => only.length === 0 || only.includes(c.n));

let failed = 0;
let calls = 0;
let tokensIn = 0;
let tokensOut = 0;
const sources: Record<string, number> = {};

// A pause between questions keeps a free-tier key under its requests-per-minute limit.
const PAUSE_MS = Number(process.env.EVAL_PAUSE_MS ?? 6000);

for (const [index, c] of selected.entries()) {
  if (index > 0) await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
  let answer: CopilotAnswer;
  try {
    answer = await withRetry(c.question, c.history ?? []);
  } catch (error) {
    failed++;
    console.log(`\nFAIL ${c.n}. ${c.question}\n   error: ${error instanceof Error ? error.message : String(error)}`);
    continue;
  }
  const problems = [
    ...c.check(answer),
    ...noDigitsUnlessChecked(answer),
    ...(!c.clarify && answer.sentenceSource === "clarify" ? ["asked for clarification on a clear question"] : []),
  ];
  if (problems.length) failed++;
  calls += answer.meta.rounds;
  tokensIn += answer.meta.inputTokens ?? 0;
  tokensOut += answer.meta.outputTokens ?? 0;
  sources[answer.sentenceSource] = (sources[answer.sentenceSource] ?? 0) + 1;

  console.log(`\n${problems.length ? "FAIL" : "PASS"} ${c.n}. ${c.question}`);
  for (const step of answer.steps) {
    console.log(`   ${step.ok ? "·" : "✗"} ${step.tool} ${JSON.stringify(step.args)}${step.ok ? "" : ` → ${step.error}`}`);
  }
  console.log(`   [${answer.sentenceSource}] ${answer.sentence}`);
  for (const option of answer.clarification?.options ?? []) console.log(`     • ${option.label}: ${option.question}`);
  if (answer.guardNote) console.log(`   note: ${answer.guardNote}`);
  console.log(`   ${answer.meta.rounds} rounds · ${answer.meta.toolCalls} tool calls · ${(answer.meta.ms / 1000).toFixed(1)} s`);
  for (const problem of problems) console.log(`   ✗ ${problem}`);
}

console.log(
  `\n${selected.length - failed} of ${selected.length} passed · ${calls} Gemini calls · ` +
    `${tokensIn} input / ${tokensOut} output tokens · sentences: ${JSON.stringify(sources)}`,
);
process.exit(failed ? 1 : 0);
