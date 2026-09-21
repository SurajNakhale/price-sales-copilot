# Feature 4 — Sales Copilot

**Status:** Implemented (2026-09-21). Planned with the user on 2026-09-21. 16 of 16 live eval questions pass on
`gemini-3.5-flash-lite`; the default `gemini-3.8-flash` was verified end to end on one question before its free-tier
daily quota ran out (§9).

## 1. Purpose and boundary

A question box for plain-English questions about sales, products and dealers. The LLM decides **which tool to call and
with what arguments**. The tools are ordinary code that read the mock files and do every filter, sum, share and
comparison, so every number comes from the data and the same question always gets the same figures.

**Feature 4 does:**

- Answer questions about the sales, current price list and dealers files.
- Show, for every answer, the steps used (written by code from the tool arguments), the result table, and one sentence.
- Check every number in the model's sentence against the tool results, and replace a sentence that fails.

**Feature 4 does not:**

- Let the LLM calculate, filter or rank anything, or write code or SQL.
- Write any file. Every tool is read-only.
- Send whole datasets or any dealer email address to Gemini.
- Answer price-history questions ("which products had a price increase?"): no change history is recorded yet.
- Store conversations, on the server or at Google (`store: false`).

## 2. Decisions

| Decision | Choice |
|---|---|
| How the LLM takes part | Function calling through the Interactions API. It may call tools over up to 4 rounds, then writes one sentence. This replaces the single-turn "query plan" in the original `architecture.md` §6.4; the vocabulary (filter, group, aggregate, sort, limit, date range) is the same |
| Tools | Three general tools, not one per question type: `query_sales`, `compare_periods`, `lookup_products` (§4). New question types need no new code |
| Who writes the sentence (open decision 5) | The LLM, from the tool results. Code checks that every number in it occurs in a result; if one does not, a template sentence for that tool replaces it and the UI says so |
| Today | The latest invoice date (2026-09-18), never the clock. Resolved by code; the model is told the date so it can phrase relative periods |
| State | Stateless. Each round resends the full history (`user_input`, the model's steps exactly as returned, and `function_result`s), because `store: false` rules out `previous_interaction_id` |
| Follow-ups | The last 3 question/answer pairs are sent as plain text with a new question, so "and Seagate?" works |
| Limits | 4 rounds, 6 tool calls, 500-character question, 50 rows per result. Enforced in code (`lib/copilot/types.ts`) |
| Free-tier savers | Answers are cached in memory for the life of the server, keyed by the question (case and trailing punctuation ignored), the history sent, the model, the sentence mode and a hash of the data, so a repeat costs no request and an approval invalidates it. `COPILOT_SENTENCE=template` (economy mode, off by default) stops after the tools run and shows the template sentence: 1 request per question instead of 2, no chained queries. `COPILOT_MODEL` picks the copilot's model apart from Analyse's |

## 3. Flow

```text
question (+ last 3 Q/A pairs)
   ▼
Gemini: tool declarations + today + the brand / category / model / dealer / state vocabulary
   │ returns function_call steps                        ← the only thing the model decides
   ▼
code: validate arguments (Zod) → run the tool → JSON result          invalid arguments go back as an error result
   ▼
Gemini: another tool call, or one sentence (max 4 rounds)
   ▼
code: number check on the sentence → template sentence if it fails
   ▼
UI: steps → result table → sentence → "computed from your files"
```

## 4. Tools

| Tool | Answers | Arguments |
|---|---|---|
| `query_sales` | totals, rankings, breakdowns, who did / did not buy | `filters`, `period`, `groupBy` (brand, category, model, dealer, state, month, week, invoice), `includeZero`, `sortBy` (revenue, units, invoices, name, date), `order`, `limit` 1–50 |
| `compare_periods` | change between two periods | `filters`, `baseline`, `comparison`, `groupBy` (brand, category, model, dealer, state), `sortBy`, `limit` |
| `lookup_products` | dealer price, MRP, margin, status, units sold | `filters` (brands, categories, models), `status` (active, discontinued, any) |

- **filters** — `brands`, `categories`, `models`, `dealers`, `states`, each a list. OR within a field, AND across fields.
  Matching ignores case and punctuation. Models and dealers match whole words anywhere in the name, so "T7" finds
  T7 1TB, T7 2TB and T7 Shield 1TB. A value that matches nothing is reported as a note, not an error.
- **period** — `kind`: `all`, `last_month`, `this_month`, `last_days` (+`days`), `month` (+`month`, optional `year`),
  `between` (+`from`, `to`). `last_days: 90` means on or after today minus 90 days, the same rule Feature 3 uses.
  A period reaching past the data is cut at the data's edge and a caveat says so.
- **includeZero** — also counts the groups with no sales, and lists them in `zeroSales`. That is how "which dealers have
  not bought Samsung" and "which products never sold" are answered. The groups with no sales lead the table whatever
  the ranking, because they are the answer.
- **Every result** carries the resolved dates, matched counts, totals, `groups` (`withSales`, `inUniverse`, `shown`),
  rows with revenue, units, invoices and shares, money as display text (`₹4,32,540` and `₹4.3L`), notes and caveats.
  Shares, averages, growth and margin are computed here so the model never does arithmetic.

## 5. What it can answer

Figures computed from `mock-data/` on 2026-09-21.

| Question | Tool | Answer |
|---|---|---|
| Which models sold most last month? | `query_sales`, last_month, by model | 990 PRO 2TB ₹3,08,460 (16 units) |
| How much did we sell to ABC Computers in the last 90 days? | `query_sales`, dealer | ₹3,06,760 · 61 units · 5 invoices |
| Which dealer bought the most Samsung? | `query_sales`, brand, by dealer | XYZ Electronics, 39 units, ₹4,32,540; 16 of 20 dealers bought Samsung |
| Which dealers have not bought Samsung? | same, `includeZero` | 4 of 20 |
| Total sales value for routers? | `query_sales`, category | ₹6,57,200 · 278 units |
| Which state buys the most? | `query_sales`, by state | Gujarat ₹11,53,300 (12 states) |
| What share of revenue is Samsung? | `query_sales`, brand | ₹19,58,520 = 44.6% |
| Compare August with July | `compare_periods` | ₹16,35,290 → ₹18,65,150, +14.1% |
| How is September going vs August? | `compare_periods` | with the caveat that September has data to 18 Sep only |
| Dealer price of T7 1TB? | `lookup_products` | today's price list |

"Most" and "best" are ranked by one measure, and the sentence names it; the table always shows revenue and units.

## 6. Guards

| Risk | Control |
|---|---|
| The model invents or recomputes a number | Every number in the sentence must occur in a tool result or the question; otherwise the template sentence is shown. Numbers in words are not checked, so the prompt requires digits |
| The model answers without a tool | If the reply has no tool call and contains a digit, it is replaced with "I can only answer from the sales, product and dealer data" |
| Bad arguments | Zod rejects them; the error goes back as the tool's result so the model can correct itself |
| Runaway loop | Round and call limits (§2) |
| Injection through names in the data | Tools are read-only, results are data, and the number check still applies |
| Data sent to Gemini | The question, recent text turns and tool results (aggregates and names, never emails), `store: false` |
| Rate limit or outage | `LlmUnavailableError` → 503 with a readable message. A spent daily quota says so, rather than "wait a minute" |

## 7. Routes and modules

| Route | Service | Errors |
|---|---|---|
| `POST /api/copilot/ask` | `askCopilot` (`lib/copilot/ask.ts`) | 400 bad body · 500 missing `GEMINI_API_KEY` · 502 unusable LLM output · 503 Gemini unavailable |

| Module | Job | Pure |
|---|---|---|
| `lib/copilot/types.ts` | Shared types and limits | yes |
| `lib/copilot/period.ts` | Periods, resolved against today | yes |
| `lib/copilot/filters.ts` | Name matching and filter resolution | yes |
| `lib/copilot/sales.ts`, `products.ts` | The three tools | yes |
| `lib/copilot/tools.ts` | Zod schemas, descriptions, readable steps, template sentences, result tables | yes |
| `lib/copilot/guard.ts` | The number check | yes |
| `lib/copilot/request.ts`, `export.ts` | The route's body schema; Copy table and Download CSV | yes |
| `lib/copilot/ask.ts` | The loop | no |
| `lib/llm/chat.ts` | `ChatPort` over the Interactions API; the only new `@google/genai` user | no |
| `lib/llm/prompts/copilot.ts` | The instructions | yes |

## 8. UI

`/copilot`, per `ui-design.md` §2.7: suggested questions, the thread, and the input pinned at the bottom. A pending
question shows "Working out the steps…". Each answer shows the steps (open by default, with the raw arguments for
checking), the table, the sentence with where it came from, and Copy table / Download CSV. The copilot needs Gemini,
not Gmail, so it works before Gmail is connected.

## 9. Verification

- `bun run test` (no key, no network, 59 tests in `test/feature-4.test.ts`): period resolution; filter matching; each
  §5 answer recomputed by brute force and compared with the tool; the tool schemas convert to Gemini JSON; the number
  check; the loop with a fake model (tool then sentence, invented number, no tool, bad arguments, parallel calls,
  round limit, verbatim replay); the Gemini request shape and error mapping; the route's body schema; CSV and copy
  output. Disabling the number check, or the zero-sales lookup, fails tests.
- `bun run copilot:eval` with `GEMINI_API_KEY`: 16 real questions. It checks the tool results the model's calls
  produced against values it computes from the files, not the wording, and prints the tools, rounds and time.
  `bun run copilot:eval 3 7` runs only those. A spent daily quota stops the run at once.
- `bun run lint`, `bunx tsc --noEmit`, `bun run build`.

### Live results, 2026-09-21

- **Spike on `gemini-3.8-flash`**: the API shape in `architecture.md` §7 was confirmed, including that dropping a
  thought signature is rejected with a 400. One question ran end to end with a checked sentence.
- **Free-tier quota.** That key's free tier allows `gemini-3.8-flash` **20 requests a day**, and each question uses 2
  or 3, so about 7–10 questions a day, shared with Feature 2's Analyse. It ran out during the first eval.
- **Eval on `gemini-3.5-flash-lite`** (`LLM_MODEL`, separate quota): **16 of 16 passed**, 30 Gemini calls, about 4 s a
  question. 14 sentences were the model's own and passed the number check; 2 were tool-free replies (the greeting and
  the email request). None needed the template. The model used `includeZero` for both "not bought" questions, read the
  partial-September caveat back, resolved "And Seagate?" from history, and declined price history and emails.
- **Through the route and page** (headless Chrome): a real question produced steps, a table and a checked sentence;
  the spent quota on the default model returned the 503 daily-limit message; a blank key returned 500
  `missing_config` and showed the setup notice. The screenshot found "not bought" tables led by the biggest buyers,
  since fixed (§4, includeZero).

### Not verified

The full eval on the default `gemini-3.8-flash`: rerun `bun run copilot:eval` once its quota resets, or with a paid key.
