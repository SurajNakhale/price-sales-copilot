# Feature 4 — Sales Copilot

**Status:** Implemented (2026-09-21). Planned with the user on 2026-09-21. 16 of 16 live eval questions pass on
`gemini-3.5-flash-lite`; the default `gemini-3.8-flash` was verified end to end on one question before its free-tier
daily quota ran out (§9). **Vague-question handling** (§10), **price changes from approved lists** (§11) and **quarters with a
"Read as" line** (§12) were added on 2026-09-22.

## 1. Purpose and boundary

A question box for plain-English questions about sales, products and dealers. The LLM decides **which tool to call and
with what arguments**. The tools are ordinary code that read the mock files and do every filter, sum, share and
comparison, so every number comes from the data and the same question always gets the same figures.

**Feature 4 does:**

- Answer questions about the sales, current price list and dealers files.
- Show, for every answer, the steps used (written by code from the tool arguments), the result table, and one sentence.
- Check every number in the model's sentence against the tool results, and replace a sentence that fails.
- Ask what a vague question means, before any query, instead of guessing (§10).
- Answer which prices the approved supplier lists changed, with units sold if asked (§11).

**Feature 4 does not:**

- Let the LLM calculate, filter or rank anything, or write code or SQL.
- Write any file. Every tool is read-only.
- Send whole datasets or any dealer email address to Gemini.
- Count price changes from lists still waiting for review, or forecast anything. Price changes come only from
  approved lists (§11), and there is still no audit log of who approved what (decision 6).
- Store conversations, on the server or at Google (`store: false`).

## 2. Decisions

| Decision | Choice |
|---|---|
| How the LLM takes part | Function calling through the Interactions API. It may call tools over up to 4 rounds, then writes one sentence. This replaces the single-turn "query plan" in the original `architecture.md` §6.4; the vocabulary (filter, group, aggregate, sort, limit, date range) is the same |
| Tools | Four general data tools, not one per question type: `query_sales`, `compare_periods`, `lookup_products`, `lookup_price_changes` (§4). New question types need no new code. A fifth, `ask_clarification`, reads no data: it asks the user what a vague question means (§10) |
| Who writes the sentence (open decision 5) | The LLM, from the tool results. Code checks that every number in it occurs in a result; if one does not, a template sentence for that tool replaces it and the UI says so |
| Quarters | The model reads "this quarter", "last quarter" or "Q1"–"Q4" and picks the numbering: calendar, or the Indian financial year when the question says FY or financial year. Code works out the dates, and every step opens with a "Read as" line stating how the question was read. Decided with the user, 2026-09-22 (§12) |
| Today | The latest invoice date (2026-09-18), never the clock. Resolved by code; the model is told the date so it can phrase relative periods |
| State | Stateless. Each round resends the full history (`user_input`, the model's steps exactly as returned, and `function_result`s), because `store: false` rules out `previous_interaction_id` |
| Follow-ups | The last 3 question/answer pairs are sent as plain text with a new question, so "and Seagate?" works |
| Limits | 4 rounds, 6 tool calls, 500-character question, 50 rows per result. Enforced in code (`lib/copilot/types.ts`) |
| Vague questions | Gemini decides a question is vague and calls a fourth tool, `ask_clarification`, instead of a query. It may choose only from six fixed readings (sales quantity, revenue, number of dealers, current prices, price changes, growth) and suggests one example question for each. The app writes every word shown. It costs the same single request. Decided with the user, 2026-09-22 (§10) |
| Price changes | Read from Feature 2's reviews (`.data/reviews/`) by `lookup_price_changes`. **Only changes applied from approved lists count**; lists waiting for review are named, not counted. This is not the audit log of decision 6, which stays open: a re-analysed list replaces its review, and nothing records who approved. Decided with the user, 2026-09-22 (§11) |
| Free-tier savers | Answers are cached in memory for the life of the server, keyed by the question (case and trailing punctuation ignored), the history sent, the model, the sentence mode and a hash of the data, so a repeat costs no request and an approval invalidates it. `COPILOT_SENTENCE=template` (economy mode, off by default) stops after the tools run and shows the template sentence: 1 request per question instead of 2, no chained queries. `COPILOT_MODEL` picks the copilot's model apart from Analyse's |

## 3. Flow

```text
question (+ last 3 Q/A pairs)
   ▼
Gemini: tool declarations + today + the brand / category / model / dealer / state vocabulary
   │ reads the question: metric, products, dealers, period ("this quarter" → this_quarter, and which numbering)
   │ returns function_call steps                        ← the only thing the model decides
   │
   ├─ ask_clarification, alone, before any query (§10)
   │     → code checks it and writes the clarification; no query runs and the loop stops
   ▼
code: validate arguments (Zod) → run the tool → JSON result          invalid arguments go back as an error result
   ▼
Gemini: another tool call, or one sentence (max 4 rounds)
   ▼
code: number check on the sentence → template sentence if it fails
   ▼
UI: steps (each opens with "Read as: metric · grouping · products · dealers · period") → result table → sentence →
    "computed from your files"
```

## 4. Tools

| Tool | Answers | Arguments |
|---|---|---|
| `query_sales` | totals, rankings, breakdowns, who did / did not buy | `filters`, `period`, `groupBy` (brand, category, model, dealer, state, month, week, invoice), `includeZero`, `sortBy` (revenue, units, invoices, name, date), `order`, `limit` 1–50 |
| `compare_periods` | change between two periods | `filters`, `baseline`, `comparison`, `groupBy` (brand, category, model, dealer, state), `sortBy`, `limit` |
| `lookup_products` | dealer price, MRP, margin, status, units sold | `filters` (brands, categories, models), `status` (active, discontinued, any) |
| `lookup_price_changes` | which prices the approved lists changed, old → new, and optionally units and revenue in a period (§11) | `direction` (decrease, increase, any), `filters` (brands, categories, models), `salesPeriod`, `limit` 1–50 |
| `ask_clarification` | nothing: it asks the user what a vague question means and reads no data (§10) | `subject` (words from the question), `options`: 2–4 of `units`, `revenue`, `dealers`, `prices`, `price_changes`, `growth`, each with an example `question` |

- **filters** — `brands`, `categories`, `models`, `dealers`, `states`, each a list. OR within a field, AND across fields.
  Matching ignores case and punctuation. Models and dealers match whole words anywhere in the name, so "T7" finds
  T7 1TB, T7 2TB and T7 Shield 1TB. A value that matches nothing is reported as a note, not an error.
- **period** — `kind`: `all`, `last_month`, `this_month`, `last_days` (+`days`), `month` (+`month`, optional `year`),
  `between` (+`from`, `to`), `this_quarter`, `last_quarter`, `quarter` (+`quarter` 1–4, optional `year`). The quarter kinds
  take `numbering`: `calendar` (Q1 = Jan–Mar, the default) or `financial` (Q1 = Apr–Jun; `year` is the year the financial
  year starts). The resolved period carries `reading`, such as "calendar Q3 2026" or "Q2 of financial year 2026-27". `last_days: 90` means on or after today minus 90 days, the same rule Feature 3 uses.
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
| Who are the top 5 dealers by sales value this quarter? | `query_sales`, this_quarter, by dealer, limit 5 | 1 Jul – 18 Sep 2026: XYZ Electronics ₹8,16,450, Tech World ₹5,73,670, Delhi Tech Mart ₹4,73,540, ABC Computers ₹3,06,760, Hyderabad Hardware Hub ₹2,80,100 |
| What were our sales in Q2 of this financial year? | `query_sales`, quarter 2, financial | Q2 of financial year 2026-27 = 1 Jul – 18 Sep 2026, the whole data |
| Which models got cheaper in the new lists, and how many of each did we sell last month? | `lookup_price_changes`, decrease, last month | none: the one approved list (Samsung, 21 Sep) raised 3 prices and lowered none |
| Which models got more expensive, and how many of each did we sell last month? | `lookup_price_changes`, increase, last month | T7 1TB ₹7,000 → ₹7,500 (31 sold in August), T7 2TB ₹12,500 → ₹13,000 (13), 870 EVO 500GB ₹4,300 → ₹4,500 (12) |
| How are SSDs doing? | `ask_clarification` | no query: "I'm not sure what you'd like to know about SSDs", offering Sales quantity, Revenue, Number of dealers, Current prices (§10) |

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
| Rate limit or outage | `mapGeminiError` in `lib/llm/client.ts`, shared with Analyse and the dealer email, turns these into `LlmUnavailableError` → 503 with a readable message. A spent daily quota says so, rather than "wait a minute" |
| A price change that was never approved is reported as real | `lookup_price_changes` reads only items applied from approved reviews; pending lists are named in a separate `waitingForReview` field and the steps say they are not included. Reviews are read, never written |
| The model asks instead of answering, or puts its own text in front of the user | A clarification is honoured only as the turn's only call before any query; otherwise it goes back to the model as an error. Its subject must be words from the question. The labels and the framing sentence are written by code. The eval fails any clear question that gets a clarification (§10) |

## 7. Routes and modules

| Route | Service | Errors |
|---|---|---|
| `POST /api/copilot/ask` | `askCopilot` (`lib/copilot/ask.ts`) | 400 bad body · 500 missing `GEMINI_API_KEY` · 502 unusable LLM output · 503 Gemini unavailable |

| Module | Job | Pure |
|---|---|---|
| `lib/copilot/types.ts` | Shared types and limits; `Clarification` and the `clarify` sentence source | yes |
| `lib/copilot/period.ts` | Periods, resolved against today | yes |
| `lib/copilot/filters.ts` | Name matching and filter resolution | yes |
| `lib/copilot/sales.ts`, `products.ts`, `price-changes.ts` | The four data tools | yes |
| `lib/copilot/tools.ts` | Zod schemas, descriptions, readable steps, template sentences, result tables | yes |
| `lib/copilot/guard.ts` | The number check | yes |
| `lib/copilot/clarify.ts` | `ask_clarification`'s declaration, schema and checks | yes |
| `lib/copilot/wording.ts` | The option labels, the clarification sentence, and the text a clarification leaves in the follow-up history. No zod, so the chat page can import it | yes |
| `lib/copilot/request.ts`, `export.ts` | The route's body schema; Copy table and Download CSV | yes |
| `lib/copilot/ask.ts` | The loop; loads sales, products, dealers and the reviews | no |
| `lib/llm/chat.ts` | `ChatPort` over the Interactions API, through the shared client | no |
| `lib/llm/client.ts` | The Gemini client (the only `@google/genai` importer), the model per feature, and `mapGeminiError` | no |
| `lib/llm/prompts/copilot.ts` | The instructions | yes |

## 8. UI

`/copilot`, per `ui-design.md` §2.7: suggested questions, the thread, and the input pinned at the bottom. A pending
question shows "Working out the steps…". Each answer shows the steps (open by default, with the raw arguments for
checking), the table, the sentence with where it came from, and Copy table / Download CSV. The copilot needs Gemini,
not Gmail, so it works before Gmail is connected.

A clarification replaces the sentence box. It shows the sentence, then "Would you like to see:", then one
row per option: an outline button with the label and its example question beside it. Clicking a button asks that
question. Below the rows come the "for example" line and the source line "No query was run: the question did not say
what to measure." There are no steps and no table. A typed reply such as "revenue" works through the follow-up history
(§10).

## 9. Verification

- `bun run test` (no key, no network, 86 tests in `test/feature-4.test.ts`): period resolution; filter matching; each
  §5 answer recomputed by brute force and compared with the tool; the tool schemas convert to Gemini JSON; the number
  check; the loop with a fake model (tool then sentence, invented number, no tool, bad arguments, parallel calls,
  round limit, verbatim replay); the Gemini request shape and error mapping; the route's body schema; CSV and copy
  output. Disabling the number check, or the zero-sales lookup, fails tests.
  For vague questions (§10):
  - A clarification gives the `clarify` source, no steps, one round, labels from code, and is cached.
  - Rejected, with the next turn used: a subject not in the question, a clarification mixed with a query or after one,
    a bad or repeated measure, fewer than 2 or more than 4 options, and a multi-line example question.
  - The instructions contain the rule, and the history text carries the options.
  - With the data, a reading that cannot fit the subject is rejected: the number of dealers, prices or price changes for
    a dealer; prices or price changes for a state.

  For price changes (§11), with fixture reviews: only applied items from approved lists count; direction, including an
  MRP-only change; the filters; units and revenue against a brute-force sum; pending lists named; no reviews; the steps,
  table and fallback sentence; no email in a result; the cache missing when a review changes. Counting unapplied items or
  pending lists, or ignoring the sales period, fails tests.
- `bun run copilot:eval` with `GEMINI_API_KEY`: 16 real questions. It checks the tool results the model's calls
  produced against values it computes from the files, not the wording, and prints the tools, rounds and time.
  `bun run copilot:eval 3 7` runs only those. A spent daily quota stops the run at once. It has 25 questions. Three are about quarters: "this quarter" must be
  answered in exactly one query, "Q2 of this financial year" must read as 1 Jul – 18 Sep, and "this quarter with last
  quarter" must note there are no sales before July. The price-change questions (#12, "Which products had a
  price increase?", and two new ones) are checked against changes read straight from `.data/reviews/`, so they follow
  whatever has been approved on the machine. The vague questions:
  - "How are SSDs doing?", "What about Samsung?" and "Tell me about ABC Computers" must clarify with valid options;
  - "Revenue", asked after the SSD clarification, must query SSD revenue;
  - any other case that clarifies fails, so the 16 clear questions must still be answered.
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

### Live results, 2026-09-22 (vague questions)

- **Eval on `gemini-3.5-flash-lite`: 20 of 20 passed**, 35 Gemini calls. The 16 clear questions were all answered, none
  held for clarification, including "How is September going compared with August?", "hello" and "And Seagate?".
- **The three vague questions** each got a clarification in one request with no query. The readings Gemini picked
  fitted each subject:
  - SSDs: revenue, sales quantity, current prices, growth;
  - Samsung: revenue, sales quantity, current prices;
  - ABC Computers: revenue, sales quantity, growth, with no prices and no dealer count, as §10 asks for a dealer.
- **"Revenue"**, asked after the SSD clarification, queried SSD revenue (₹24,93,200 over the whole data).
- **On the page** (headless Chrome, the running dev server): "How are SSDs doing?" showed the block with three buttons,
  the example line, "No query was run" and "1 Gemini request · 0 queries". Clicking **Revenue** asked "How much revenue
  did SSDs generate last month?", which was answered with its steps: ₹11,84,860 from 118 units in August. No browser
  errors.
- **Wording.** The example questions are the model's, so their English varies. "How many units did ABC Computers
  sell last month?" reads as if the dealer sells; the answer is still the dealer's purchases, because the tool filters
  by dealer.

### Live results, 2026-09-22 (price changes)

- **All 22 eval questions passed** across the runs, on `gemini-3.5-flash-lite`. The questions touched by each fix were
  rerun after it.
- **The user's question**, "Which models got cheaper in the new lists, and how many of each did we sell last month?",
  gets `lookup_price_changes` (decrease, last month) and "none went down": the one approved list, Samsung, raised all 3.
  - The first run took 4 requests: Gemini re-queried to confirm the empty result.
  - After the up/down counts were added to the result, and a line to rule 6, it takes 1 query and 2 requests.
- **"Which models got more expensive…"** returns T7 1TB, T7 2TB and 870 EVO 500GB with 31, 13 and 12 units sold in
  August. Gemini first wrote "last month, … got more expensive". Rule 6 now says a price changed when its list was
  approved, and the sentence now reads "following the approved Samsung price list".
- **"Which products had a price increase?"** used to be answered "cannot answer". It now lists the three increases.
- **A clarification for a dealer** ("Tell me about ABC Computers") once offered "Number of dealers", with an unrelated
  example question. Code now rejects readings that cannot fit the subject; live, Gemini offered it again, was told, and
  replaced it with growth.
- **On the page** (headless Chrome): the table shows old → new, the change with an arrow, and units and revenue. A query
  with no rows shows "Nothing matches." instead of bare column headings. There were no browser errors.

### Live results, 2026-09-22 (quarters)

- **25 of 25 passed** on `gemini-3.5-flash-lite` in one full run (46 Gemini calls).
- **"Who are the top 5 dealers by sales value this quarter?"** took 1 query (`this_quarter`, by dealer, top 5) and 2
  requests. The sentence names the period: "this quarter, 1 Jul 2026 – 18 Sep 2026". Asked twice in the browser, it
  gave the same step both times, opening "Read as: revenue · by dealer, top 5 · all products · all dealers · this
  quarter (calendar Q3 2026)". Before, the same question took 2 or 4 queries and different steps each time.
- **"Q2 of this financial year"** was read as `quarter 2, financial` and answered for 1 Jul – 18 Sep 2026.
- **"Compare this quarter with last quarter"** compared Apr–Jun with Jul–Sep and said last quarter had no sales, since it
  ended before the first sale on 2 Jul.

### Not verified

The full eval on the default `gemini-3.8-flash`: rerun `bun run copilot:eval` once its quota resets, or with a paid key.

## 10. Vague questions

Specified with the user and built on 2026-09-22. The copilot asks instead of guessing, and nothing is queried until
the question is clear.

**When the model asks.** The question names what to look at but not what to measure. Examples:
- "How are SSDs doing?"
- "What about Samsung?"
- "Tell me about ABC Computers"

**Which readings fit is checked by code**, not only asked for in the prompt. The app looks the subject up with the same
matching the tools use, then rejects a reading that does not fit it: the number of dealers, prices or price changes for
a dealer, and prices or price changes for a state. The model is told which readings fit and tries again. A subject the
data does not know is not restricted.

**When it must not ask:**

| The question has | Handled by |
|---|---|
| A measure: sales, revenue, units, price, share, dealers | a query, as today |
| A ranking: "most", "top", "best" | rule 4, ranked by revenue |
| A comparison: "compared with", "vs" | `compare_periods` ("How is September going compared with August?") |
| An earlier turn that makes the measure clear | the follow-up history ("and Seagate?") |
| A greeting, or a request unrelated to the data | a short reply with no tool |
| A price-change question | `lookup_price_changes` (rule 6, §11) |

**The options.** Fixed in code; the model picks 2–4 that fit the subject and writes one example question for each. The
examples must be questions the tools can answer, with a period such as "last month".

| Measure | Label (written by code) | Fits | Answered by |
|---|---|---|---|
| `units` | Sales quantity | any subject | `query_sales` |
| `revenue` | Revenue | any subject | `query_sales` |
| `dealers` | Number of dealers | brands, categories, models, states | `query_sales` (its result counts the dealers who bought) |
| `prices` | Current prices | brands, categories, models | `lookup_products` |
| `price_changes` | Price changes | brands, categories, models | `lookup_price_changes` |
| `growth` | Growth vs the previous period | any subject | `compare_periods` |

"Price changes" was added with §11; until then the copilot could not answer it.

**The reply**, for "How are SSDs doing?":

```text
I'm not sure what you'd like to know about SSDs.

Would you like to see:
• Sales quantity      How many SSDs did we sell last month?
• Revenue             What was our SSD revenue last month?
• Number of dealers   How many dealers bought SSDs in the last 90 days?
• Current prices      What are the current SSD prices?

For example: "How many SSDs did we sell last month?"
```

- **Who writes what.** The first line and the labels come from code; the subject is inserted by code. Only the example
  questions come from the model.
- **The subject is checked.** It must be words that appear in the question, compared without case or extra spaces, so
  the model cannot put arbitrary text in front of the user.
- **Each example question** must be one line ending in "?", with no markdown.
- **The buttons.** On the page each option is a button that asks its example question (§8).
- **Typing a reply.** The clarification is kept in the follow-up history with its options, so typing "revenue" is
  answered as SSD revenue.

**How the loop treats the call:**

- **Honoured** only when it is the turn's only call and no query has run yet. The answer then has source `clarify`, no
  steps, and the normal meta line ("1 Gemini request · 0 queries"). The loop stops.
- **Rejected** in every other case: mixed with queries, after a query, or failing the checks above. The model gets an
  error result, as with bad arguments, and the page shows a **rejected** step. Queries in the same turn still run.
- **Limits.** It counts toward the 4-round limit, not the 6-call query limit.
- **Caching.** A clarification is cached like any answer, so asking the same vague question again costs nothing.
- **Economy mode** (`COPILOT_SENTENCE=template`) is unchanged; a clarification never needs a second request.

## 11. Price changes from approved lists

Added with the user on 2026-09-22, after "Which models got cheaper in the new lists, and how many of each did we sell
last month?" got no answer: no tool could see a price change, and rule 6 said price history was unavailable.

**The source.** Feature 2 saves each analysed list in `.data/reviews/<fileId>.json`: every price change, old → new, and
on approval the IDs of the items applied. `lookup_price_changes` reads those files and nothing else.

- **Only applied items from approved lists count.** A change the reviewer did not tick, and every change in a list still
  waiting for review, is left out.
- **Waiting lists are named.** The result's `waitingForReview` lists them with their change counts, the steps say they
  are not included, and the prompt asks the model to say so too.
- **Direction.** Judged on the dealer price; when only the MRP changed, on the MRP. "Cheaper" means a decrease.
- **Sales in the same call.** `salesPeriod` (the same period input as `query_sales`) adds each changed product's units
  and revenue, joined by Product ID in code, so "how many did we sell last month" needs no second query and no name
  matching.
- **Rows.** One per applied change, so a product changed by two approved lists appears twice, with each list and date.
  Sorted by the size of the change: biggest cut first for decreases, biggest rise first for increases.
- **Not the audit log.** Decision 6 stays open: a re-analysed list replaces its review, nothing records who approved,
  and `mock:generate --force` resets the price list but not the reviews.

**Today's data** (one approved list, Samsung, 21 Sep): three increases and no decrease, so "which got cheaper" is
answered "none", and "which got more expensive" lists T7 1TB, T7 2TB and 870 EVO 500GB with their August units.

## 12. Quarters and the "Read as" line

Added with the user on 2026-09-22, after "Who are the top 5 dealers by sales value this quarter?", asked twice, gave
the same answer with different steps.

**Why it happened.** No period kind meant a quarter, so Gemini tried periods until one looked right. One run tried this
month, then a comparison, then the last 90 days, then all sales, and hit the round limit. The other tried this month,
then all sales. Both answers came from "all sales", 2 Jul – 18 Sep, which equals this quarter only because the data
starts on 2 Jul. The second run also missed the answer cache, because it carried the first as history.

**The flow now**, as the user set it out:

```text
question → Gemini reads it: metric · products · dealers · period
            "this quarter" → this_quarter; "Q2 of FY" → quarter 2, financial      ← Gemini interprets
         → one structured query (the tool call)
         → code resolves the dates and calculates from the mock data            ← the app calculates
         → answer + steps, each step opening with "Read as: …"                   ← written by code
```

- **Quarters.** `this_quarter` (to today), `last_quarter` and `quarter` 1–4. The months of this and last quarter are the
  same in both numberings; only the name differs ("calendar Q3 2026" or "Q2 of financial year 2026-27"). For a numbered
  quarter the numbering changes the months, so the reading is always stated. A quarter with no year is the most recent
  one begun.
- **Read as.** The first line of every query step, written by code from the arguments and the tool's resolved filters:
  metric, grouping, products, dealers, period. For example: "Read as: revenue · by dealer, top 5 · all products · all
  dealers · this quarter (calendar Q3 2026)". It cannot claim anything the query did not do.
- **One query.** Rule 9 of the instructions: read the question first, make one query for it, and more only when the
  question asks for more than one thing. Never try periods to see what fits; if no period kind fits the words, say which
  ones can be used.
- **What stays variable.** Gemini's choices can still differ between runs of a question open to several readings. An
  identical question with identical history is answered from the cache, steps included.

