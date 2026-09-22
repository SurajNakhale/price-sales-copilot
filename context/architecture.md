# Architecture

**Status:** All four features built (2026-09-21), each specified in detail in `features/`. Items marked "proposed" are not settled yet (see section 12).

## 1. Overview

One Next.js application (App Router, TypeScript) that runs locally. The browser shows the pages; route handlers do the
server work; everything the app knows lives in local JSON files. Two things leave the machine: calls to the Gmail API and
small prompts to the Gemini API.

```text
Browser ── pages (React, shadcn/ui)
   │ fetch
   ▼
Route handlers ── app/api/**/route.ts        validate input, call one service, map errors
   │
   ▼
Feature services ── lib/ingest, normalize, compare, drafts, copilot
   │                       │                 │                  │
   ▼                       ▼                 ▼                  ▼
Deterministic core      lib/llm          lib/google +        lib/storage
(pure functions)     (Gemini API)         lib/gmail         (local JSON files)
                                        (Gmail API, OAuth)
```

### What the four features do

1. **Feature 1, read price lists from Gmail.** Find the price-list emails in Gmail and download their Excel and CSV
   attachments into `mock-data/new-price-lists/`.
2. **Feature 2, normalize, compare, approve.** Use the LLM to normalize each downloaded file to the standard format; code then compares
   it with the current price list and shows price changes, missing products and new products. Each new product gets a
   generated Product ID that follows the same scheme as the existing ones (brand code plus a 5-character hash), so
   everything downstream stays consistent.
3. **Feature 3, dealer drafts.** Find the dealers who bought the changed models in the last 90 days, use the LLM to write a
   short update, and save it as a real Gmail draft with the dealers in BCC so they cannot see each other's addresses.
4. **Feature 4, sales and price questions.** A question box for plain-English questions about sales and prices. Every answer
   shows the query or steps used to get it, so it can be checked.

## 2. Design principles

1. **One app.** Next.js + TypeScript. No separate backend service, no database, no custom application login (Google OAuth
   only connects Gmail).
2. **The LLM proposes, code decides, the human approves.** The LLM produces column mappings, tool calls and message text.
   Application code does every comparison, filter, aggregation and write. The user approves every business change.
3. **Send the LLM as little as possible.** Headers and a few sample rows, field names, changed products. Never dealer
   email addresses, never whole datasets.
4. **Files are the data store,** and one module owns all file access.
5. **Treat all outside input as untrusted:** emails, attachments, LLM output and browser requests.
6. **Build feature by feature.** Each feature adds routes, a service module and data files without reworking earlier ones.

## 3. Runtime assumptions

- Runs locally (`bun dev`, or `bun run build` then `bun start`) for a single user on a machine with a writable disk.
  It is **not** designed for serverless hosting (read-only or ephemeral filesystem) or multi-user use. There is no per-user
  separation: whoever can reach the server can use it, so it runs on localhost.
- Secrets live in `.env.local` (Next.js also loads `.env`); both are gitignored:
  `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `GEMINI_API_KEY`, `LLM_MODEL`, and per feature
  `ANALYSE_MODEL`, `COPILOT_MODEL`, `DRAFT_MODEL`.
- Server-only modules (Gmail, LLM, storage, config) start with `import 'server-only'`, so they can never be bundled into
  the browser. Nothing secret uses a `NEXT_PUBLIC_` name.
- Package manager: bun.

## 4. Layers and code layout

All four features are laid out as built. File names are exactly those of the feature specs.

```text
app/
  layout.tsx, page.tsx              shell and dashboard
  price-updates/, price-updates/[id]/  the list, and the 5-step workflow for one file (Features 1 → 2 → 3)
  copilot/                          the Sales Copilot page (Feature 4)
  _components/                      feature UI components
  api/
    auth/google/                    connect, callback, disconnect            (Feature 1)
    ingest/scan, ingest/download    scan Gmail, download selected            (Feature 1)
    prices/[id]/file                the downloaded file's original bytes     (step 1)
    prices/[id]/analyse, approve    normalise + compare, approve             (Feature 2)
    prices/[id]/draft, draft/message   create the Gmail draft, write its words   (Feature 3)
    copilot/ask                     question to steps to answer               (Feature 4)
components/ui/                      shadcn/ui primitives (generated)
lib/
  config.ts                         env and constants (paths, Gmail query, model)
  types.ts                          shared types
  product-id.ts                     the ONE Product ID rule and the brand codes (pure; also used by the mock data script)
  matching-key.ts  file-id.ts       pure helpers for matching rows and naming price lists (Feature 2)
  parse/                            csv and xlsx to rows of cells (Feature 2; every sheet, for the step 1 viewer)
  file-preview.ts  file-view.ts     step 1: a downloaded file laid out for viewing (pure), and reading it (service)
  google/oauth.ts                   OAuth client and token file
  gmail/                            search and attachments (Feature 1), drafts (Feature 3)
  llm/                              Gemini client, prompts, Zod output schemas, the LlmPort and ChatPort interfaces
  copilot/                          Feature 4: the three read-only tools, periods and filters (pure), the number check,
                                    and the tool-calling loop (ask.ts)
  storage/                          the ONLY code that reads or writes data files
  normalize.ts  match.ts  compare.ts   Feature 2's deterministic core (pure; match.ts calls the LLM through a port)
  affected.ts  drafts/              Feature 3's pure core: affected dealers and addresses; the email text and MIME message
  ingest.ts  analyse.ts  approve.ts  prepare-draft.ts  create-draft.ts  copilot/ask.ts     feature services
scripts/generate-mock-data.ts       mock data generator and reset
scripts/generate-supplier-files.ts  sample supplier files to email to yourself
scripts/set-dealer-emails.ts        point the mock dealers' addresses at your own Gmail (mock:dealer-emails)
mock-data/                          inputs and source-of-truth data files
.data/                              gitignored runtime state
context/                            project documentation
```

| Layer | Job | May call | Must not |
|---|---|---|---|
| Pages and components | Render, collect input, call the API | Route handlers via `fetch` | Touch files, Gmail or the LLM |
| Route handlers | Validate input, call one service, map errors to HTTP | Feature services | Contain business logic |
| Feature services | Orchestrate one feature | Core, integrations, storage | Be imported by other features' services |
| Deterministic core | Compare prices, find affected dealers, aggregate, run the copilot's tools, sanitize filenames | Nothing external (pure functions) | Do I/O |
| Integrations (`google`, `gmail`, `llm`) | The only code that talks to external services | Their own SDKs | Know about pages or routes |
| Storage | The only code that reads and writes data files | The filesystem | Contain business rules |

## 5. Data architecture (no database)

| Data | Location | Written by | Notes |
|---|---|---|---|
| Current price list (source of truth for prices) | `mock-data/current-price-lists/current-price-list.json` | Feature 2 approval only | Products carry an optional `status: "discontinued"`; absent means active. Reset with `bun run mock:generate --force` |
| Dealers | `mock-data/dealers/dealers.json` | Nothing at runtime | Read-only |
| Sales transactions | `mock-data/sales/sales-data.json` | Nothing at runtime | Read-only. "Today" is its latest invoice date |
| Raw new price lists and `manifest.json` | `mock-data/new-price-lists/` | Feature 1 | Downloaded files are gitignored |
| Normalized price lists | `.data/normalized/<fileId>.json`, one per downloaded file | Feature 2 analysis | The separate normalised object the comparison reads. Temporary working state, gitignored; overwritten by Re-analyse |
| Reviews: pending changes, then what was approved | `.data/reviews/<fileId>.json`, one per downloaded file | Feature 2 analysis and approval | Items with old and new values; once approved, the applied item IDs, which Feature 3 reads. Gitignored |
| Dealer email messages and created drafts | `.data/drafts/<fileId>.json`, one per approved price list | Feature 3 | The words written for the email and a record of each Gmail draft made. Gitignored |
| Change history and audit log | Later addition. Proposed: `.data/change-history.json`, append-only | Feature 2 approval | What changed, old to new value, when, source list, who approved |
| Google tokens | `.data/google-tokens.json` | OAuth callback | Gitignored |
| Secrets | `.env.local` | You | Gitignored |

Storage rules:

- All file access goes through `lib/storage`. `readJson` validates against a Zod schema on read. `writeJsonAtomic` writes a
  temporary file and renames it, so a crash can never leave half-written JSON in the price list.
- Single user means a single writer, so there is no locking. If concurrency ever appears, add an in-process write queue.
- The current price list changes only through the Feature 2 approval service. Sales and dealers are never written.

## 6. Feature flows

### 6.1 Feature 1: read price lists from Gmail

```text
Connect Gmail (once)              Google OAuth, read-only scope; token saved to .data/google-tokens.json
   ▼
Scan Gmail (read-only)            search for price-list emails, keep only .xlsx and .csv attachments,
   │                              mark the ones already downloaded (manifest.json)
   ▼
Review list                       every new match is pre-ticked; the user can untick false matches
   ▼
Download selected                 the server re-fetches each attachment from Gmail by message and part ID
   ▼
mock-data/new-price-lists/        raw files, unmodified, plus manifest.json (sender, subject, date, hash)
   ▼
View (workflow step 1)            the cells as received, with the analysis's mapping marked once it exists;
                                  Download original returns the saved bytes untouched
```

No LLM is used. Full detail, including the search rule, duplicate handling and edge cases, is in
`features/feature-1-gmail-price-list-ingestion.md`.

### 6.2 Feature 2: normalize, compare, approve

```text
mock-data/new-price-lists/<file>.xlsx or .csv
   │ parse (code)                     rows of cells; values only, formulas are never evaluated (read-excel-file)
   ▼
LLM: propose a column mapping         input: the first 15 rows, filename, sender; output: header row, brand,
   │                                  and which header is model / category / dealer price / MRP
   │ validate (Zod + code)            columns must exist in the header row and be distinct; one retry with the reason
   ▼
normalize (code)                      apply the mapping, parse numbers, copy prices verbatim from the cells;
   │                                  unusable rows become issues shown to the reviewer
   ▼
match rows to current products        matching key (case, punctuation, brand prefix, unit spacing) in code first;
   │                                  unresolved rows: LLM proposes a match, code checks the ID is an unclaimed
   │                                  product of that brand; still unresolved: a new model with a generated ID
   ▼
.data/normalized/<fileId>.json        the separate normalised object
   ▼
compare (code)                        price change (up or down), new, missing, unchanged
   ▼
.data/reviews/<fileId>.json  ──►  Review UI: the user decides each item
                                      price change: apply?   new model: add?   missing model: keep or deactivate?
   ▼
approve (code)                        re-check against the current list; apply ONLY the approved items in one
                                      atomic write, or nothing if any of them is out of date
```

The details, edge cases and data shapes are in `features/feature-2-normalise-compare-approve.md`.

The LLM never types a price. Numbers come from the spreadsheet cells and are copied by code. A wrong or malicious LLM answer
can at worst propose a bad mapping or match, which schema validation or the reviewer catches before anything is written.

**Product IDs for new models.** IDs keep the existing scheme: a 3-letter brand code, a dash, and the first 5 uppercase hex
characters of `sha256("<brand>|<model>")` (input lowercased), for example `SAM-B072D`. Code generates them, never the LLM.
The rule lives in one pure module, `lib/product-id.ts`, shared with the mock data script, so generated and mock IDs cannot
drift. Generation is deterministic; if an ID already exists, it is re-hashed with a counter until it is unique. The reviewer
sees the new ID in the review table, and it is written to the current price list only if the user approves adding the
product. Brand codes come from a small table, `BRAND_CODES` in `lib/product-id.ts` (Seagate `SEG`, Samsung `SAM`,
TP-Link `TPL`); it sits there rather than in `lib/config.ts` because `config.ts` is `server-only` and the mock-data script
cannot import it. A file for a brand without a code stops the run with a message asking for one to be added. Features 3 and 4 then join sales and products on
the Product ID as usual.

**Missing products are deactivated, never deleted.** A product that the supplier's file no longer lists is not removed from
`current-price-list.json`, because `sales-data.json` references it by Product ID and deleting the row would orphan that
history. Instead, an approved deactivation writes one optional field:

```jsonc
{
  "productId": "SAM-72942",
  "brand": "Samsung",
  "model": "990 EVO 1TB",
  "category": "SSD",
  "dealerPrice": 8200,
  "mrp": 10999,
  "status": "discontinued",       // only ever this one value; absent means active
  "discontinuedOn": "2026-09-20"  // optional; the date of the approval
}
```

Presence in the file already means "we stock this", so the schema stays as it is and only deactivated products grow the
field. Existing records, `scripts/generate-mock-data.ts` and the mock data on disk are unchanged. Code that means "the
current catalogue" filters on `!product.status`; the missing-products review, the Products page and the copilot show
discontinued items explicitly, and the alternative — a separate `discontinued.json` — was rejected because it splits one
fact across two files.

### 6.3 Feature 3: draft dealer emails

```text
approved changes + sales-data.json + dealers.json
   │ code: affected models, then dealers who bought them in the last 90 days (today = latest invoice date)
   ▼
LLM: write the short price-update message     input: changed products and prices only
   ▼                                          no dealer names or email addresses are sent to the LLM
code: build the email, add the dealers as BCC, create the Gmail draft
   ▼
the user reviews and sends from Gmail         the app never sends
```

Built 2026-09-21; the full spec is `features/feature-3-dealer-drafts.md`. "Affected models" are the models whose price change
was approved **and applied**; new products (no history), deactivations and unapplied items are not covered, and the page says
so. One draft per approved price list (decision 4). Gemini writes only `subject`, `greeting`, `intro` and `closing`, and a
digit outside a changed model's name is rejected; code adds one line per change from the review. To is the connected
account (`users.getProfile`), Bcc the dealers.

**The Gmail permission.** Drafts need `gmail.compose`, which Google describes as "Manage drafts and send emails": there is no
narrower scope that creates drafts. So "never sends" is enforced by the code, whose Gmail client type (`DraftsGmail`) has no
send method, and by a test that scans `lib`, `app` and `scripts` for any send call. The permission is asked for only when
the user presses **Allow Gmail drafts**, alongside read-only access, with `include_granted_scopes`; Connect stays read-only.
The callback checks the granted `scope`, because Google lets the user untick it.

### 6.4 Feature 4: answer sales questions

Built as a tool-calling loop (2026-09-21); the full spec is `features/feature-4-sales-copilot.md`.

```text
question (+ the last 3 question/answer pairs, for follow-ups)
   ▼
LLM: choose a tool and its arguments       input: the question, today's date, the names in the data, 5 tool declarations
   │ tools: query_sales, compare_periods, lookup_products, lookup_price_changes — read-only, from a fixed vocabulary:
   │ filter, group, sort, limit, period (all, last_month, this_month, last_days, month, between, this_quarter,
   │ last_quarter, quarter with calendar or financial-year numbering)
   │
   ├─ a vague question ("How are SSDs doing?"): ask_clarification, alone, before any query
   │     → code checks it and writes the clarification from fixed readings; nothing is queried
   ▼
code: validate the arguments (Zod)         an invalid call goes back to the model as an error it can correct
   ▼
code: run the tool on sales, products, dealers, and the approved reviews for price changes
   │ relative dates are resolved by code against today = latest invoice date; every total, share, average and change is
   │ computed here
   ▼
LLM: sees the results → another tool call, or one sentence (at most 4 rounds, 6 tool calls)
   ▼
code: every number in the sentence must occur in a result, else a template sentence replaces it
   ▼
UI shows: question, steps (written by code from the arguments, each opening with "Read as"), result tables, the
          sentence and where it came from
```

This replaces the single-turn "query plan" first proposed here: the vocabulary is the same, delivered as function calls,
which lets the model chain a second query off the first and write the sentence from real results. The properties hold:
nothing the LLM writes is executed as code or SQL, every tool is read-only, the arguments are validated, and the steps are
shown so the result can be checked. The LLM now sees tool results (aggregates and names, capped at 50 rows) but never a
whole dataset, and never a dealer email address, which no tool returns.

A question that names a subject but no measure is not guessed at (added 2026-09-22, spec §10). The model calls
`ask_clarification` instead of a query and picks 2–4 readings from a fixed list, each with an example question. The app
writes the reply, and each reading becomes a button that asks its example question.

## 7. LLM integration (Google Gemini)

- **One wrapper.** Only `lib/llm/` imports the Gemini SDK. Features call typed functions such as `proposeColumnMapping`,
  `proposeProductMatches`, `draftDealerMessage`, and Feature 4's `ChatPort.turn` for tool calling. Changing provider means
  changing that folder only.
- **SDK and model.** Official `@google/genai`; key in `GEMINI_API_KEY`; model name in `LLM_MODEL`, default `gemini-3.8-flash`
  (the stable Flash model Google's docs recommend for structured tasks). `gemini-3.5-flash-lite` is the cheaper alternative.
  `ANALYSE_MODEL` and `COPILOT_MODEL` override it per feature (`llmModel(feature)` in `lib/llm/client.ts`).
- **Free-tier limits** are per Google Cloud project and per model, and reset at midnight Pacific time. Google no longer
  publishes the numbers; on 2026-09-21 this project's key allowed `gemini-3.8-flash` 20 requests a day. A copilot
  question costs 2 requests (1 in economy mode, 0 when cached), an Analyse 1–3. See README, "Using the Gemini free tier".
- **API.** Google recommends the Interactions API for new projects; `generateContent` is legacy but still supported. Every
  call uses `store=false`; by default interactions are stored (1 day on the free tier, 55 days on paid). Features 2 and 3
  make single-turn requests. Feature 4 is multi-turn but still stateless: `store=false` rules out
  `previous_interaction_id`, so each turn resends the whole conversation.
- **Structured output.** Every call asks for JSON constrained by a schema, and our code validates it again with Zod.
  Google says the constraint guarantees valid JSON, not correct values, and that not every JSON Schema feature is
  supported, so keep schemas small and flat. Define each schema once in Zod and derive the JSON schema from it where the
  library allows.
- **Invalid output** gets one retry that includes the validation error, then a clear error for the user. It is never
  accepted silently.
- **Prompts** are constants in `lib/llm/prompts/`. Untrusted content (spreadsheet cells, email text) is passed as clearly
  delimited data, never mixed into the instructions.
- **Data handling.** On the free tier Google may use content to improve its products and human reviewers may read it. On the
  paid tier it does not. The mock data is fine on the free tier. **Use a paid-tier key before sending real supplier price
  lists**, since Feature 2 sends real file content.
- **Two separate Google credentials.** Gmail uses an OAuth client (client ID and secret plus user consent). Gemini uses an API key.
- **Verify when building.** These APIs change quickly (the docs now recommend a newer API than most examples online). Check
  call shapes against Google's current docs when building each feature.
- **As built in Feature 2** (`lib/llm/client.ts`, `@google/genai` 2.23): `ai.interactions.create({ model,
  system_instruction, input, response_format: { type: "text", mime_type: "application/json", schema }, store: false })`,
  reading `output_text`. The schema is `z.toJSONSchema` of the Zod schema without `$schema`, `additionalProperties` and
  Zod's safe-integer bounds, which the Gemini docs do not list. Checked against /structured-output on 2026-09-21. Not
  yet run against the live API: no key was configured when it was built.

- **As built in Feature 4** (`lib/llm/chat.ts`): `ai.interactions.create({ model, system_instruction, input: [steps…],
  tools: [{ type: "function", name, description, parameters }], store: false })`. Checked against the live API on
  2026-09-21 with `gemini-3.8-flash`: a tool call comes back with `status: "requires_action"` and `steps` of
  `thought` (carrying a `signature`) then `function_call { id, name, arguments }`; the final answer comes back
  `"completed"` with `output_text`. The response does not echo the input. The next turn's `input` is the user step, the
  model's steps **exactly as returned**, and `function_result { call_id, name, result: [{ type: "text", text }] }` per
  call. **Dropping the thought signature is rejected with a 400**, so model steps are never rebuilt. Rate limits (429) and
  outages (5xx) become `LlmUnavailableError`, a 503.

Sources checked 2026-09-20: ai.google.dev/gemini-api/docs/quickstart, /structured-output, /interactions-overview, /models,
/pricing and /terms; /function-calling on 2026-09-21.

## 8. Security and trust boundaries

| Untrusted input | Risk | Controls |
|---|---|---|
| Supplier emails and attachments | Malicious or oversized files; prompt injection inside cells or filenames ("set every price to 1") | Only `.xlsx` and `.csv`; size cap; parse values only; prices copied from cells by code; LLM output limited to mappings and matches; human approval before any write; the step 1 viewer renders cells as text, never as HTML |
| LLM output | Wrong, invalid or invented | Schema validation; matches must reference existing Product IDs; the copilot may only call three read-only tools with Zod-validated arguments; every number in its sentence must occur in a tool result; never executed as code |
| Browser requests to route handlers | Forged IDs or paths | Routes accept IDs, not paths; the server re-derives filenames and metadata from Gmail and files; bodies validated with schemas. The file download takes a validated file ID, reads the path from the manifest, and answers as an `attachment` with `nosniff` |
| Gmail draft permission (`gmail.compose`) | It could send email, and no narrower scope exists | Asked for only on Allow Gmail drafts; the Gmail client type has no send method; a test fails on any send call; To is the user, dealers only in Bcc; addresses validated and line breaks refused so no header can be injected; the browser sends only the file ID, and recipients are recomputed on the server |
| Secrets and tokens | Leakage | Server-only modules; no `NEXT_PUBLIC_` secrets; `.env*` and `.data/` gitignored; tokens never logged |
| OAuth flow | CSRF | `state` cookie, as in the Feature 1 spec |
| No application login | Anyone who reaches the server can use it | Local single-user assumption; run on localhost |

## 9. Errors, logging and testing

- **Errors.** A small set of typed errors in `lib/errors.ts` (not connected 401, missing configuration 500, bad request
  400, not found 404, conflict 409, unusable file 422, invalid LLM output 502, LLM unavailable 503) that route handlers map to an HTTP status
  and `{ error, message }` through `lib/api-errors.ts`. The UI turns each into an actionable state. Logs go to the
  server console; there is no external telemetry.
- **Testing.** Unit-test the deterministic core (comparison, plan execution, date resolution, filename sanitizing, dedup)
  with `bun test`, which needs no extra dependency. LLM calls sit behind `lib/llm`, so tests use fakes.
  `bun run mock:generate --check` validates the baseline data. Gmail and Gemini end-to-end runs are manual. A feature is
  done only when `bunx tsc --noEmit`, `bun run lint` and `bun run build` pass.
- **Test isolation.** `bun test` shares one module cache across test files, so `lib/config.ts` keeps the paths of whichever
  file imported it first. Tests that write data files move `process.cwd()` to a temp folder before importing anything,
  write fixtures through the config constants, and refuse to run if those point inside the project
  (`test/feature-2.test.ts`).

## 10. Feature-to-module map

| Feature | Page | Routes | Modules | Data | External |
|---|---|---|---|---|---|
| 1 Read Gmail | `/`, `/price-updates` | `auth/google/*`, `ingest/scan`, `ingest/download` | ingest, gmail, google, storage | new-price-lists, manifest | Gmail (read) |
| Step 1 viewer | `/price-updates/[id]` (step 1) | `prices/[id]/file` | file-view, file-preview, parse, storage | new-price-lists, manifest, normalized files | — |
| 2 Clean, compare, approve | `/price-updates/[id]` (steps 2–3) | `prices/[id]/analyse`, `prices/[id]/approve` | analyse, approve, normalize, match, compare, llm, storage | current price list, normalized files, reviews | Gemini |
| 3 Dealer drafts | `/price-updates/[id]` (steps 4–5) | `prices/[id]/draft`, `prices/[id]/draft/message` | affected, drafts, prepare-draft, create-draft, gmail/drafts, llm (drafts) | reviews (applied items), sales, dealers, `.data/drafts/` | Gemini, Gmail (compose) |
| 4 Sales Q&A | `/copilot` | `copilot/ask` | copilot (tools, number check, loop), llm (chat) | sales, dealers, current price list | Gemini |

## 11. Key decisions

| Decision | Why | Trade-off |
|---|---|---|
| One Next.js app with route handlers | Simplest thing that works: UI and server in one project, no backend service | Local files make it unsuitable for serverless hosting |
| JSON files instead of a database | Small data, easy to inspect and reset | No concurrency control or query engine; fine for one user |
| LLM output is a proposal (mapping, plan, text) | Keeps prices and numbers deterministic and matches "the LLM is not the source of truth" | Extra validation code |
| Three general read-only tools the LLM calls, instead of LLM-written code, SQL or one tool per question | Safe, explainable, and the steps can be shown; new question types need no new code | A question outside the tools' vocabulary cannot be answered, and the model must pick arguments well |
| The LLM writes the copilot's sentence; code checks its numbers | Reads naturally and can use the results of a chained query; an invented number is caught and replaced by a template | Results go to Gemini (aggregates and names, never emails); a correct but rounded number also triggers the template |
| OAuth tokens in a local gitignored file | No database or login needed; survives restarts | Local single-user only |
| Atomic JSON writes | Protects the price list from partial writes | A small helper to maintain |
| Missing products are deactivated with an optional `status` field, never deleted | Sales history keeps resolving, and the reviewer's decision sticks instead of the same row returning on every analysis | One more state for every "current catalogue" read to filter out |
| Gemini behind one wrapper | A provider change stays inside `lib/llm` | Only features common to providers are used |
| shadcn/ui | Fits Next.js and Tailwind; components live in the repo | Generated code to keep tidy |

## 12. Open decisions

| # | Question | Decide in |
|---|---|---|
| 6 | Where the audit log lives and its format. Meanwhile the copilot reads price changes from the approved reviews (Feature 4 spec §11) | After the core workflow |
| 8 | Move to a paid Gemini key before using real supplier files | Before Feature 2 on real data |

Closed:

- What "remove a missing product" means is decided in 6.2: deactivate with an optional `status` field, never delete.
- Decisions 4 and 7 were settled with Feature 3 on 2026-09-21: one Gmail draft per approved price list, all its affected dealers
  in Bcc; and the 90-day filter is proven by tests with their own older sales, leaving the mock data unchanged.
- Decision 5 was settled with Feature 4 on 2026-09-21: the LLM writes the answer sentence from the tool results, and code
  checks that every number in it occurs in a result, showing a template sentence when one does not (section 6.4).
- Decisions 1–3 were settled with Feature 2 on 2026-09-21 (details in its spec, §2):
  - **Matching:** code first by matching key, then an LLM fallback whose answers code validates.
  - **Where files live:** normalised files and reviews go in `.data/normalized/` and `.data/reviews/`.
  - **`.xlsx` parser:** `read-excel-file`. It is the only actively maintained candidate among those checked: 9.3.10 was
    released 2026-08-10, with 37 releases since 2025-09. By contrast `exceljs` 4.4.0 dates from 2023-10, SheetJS `xlsx` on
    npm 0.18.5 from 2022-03 and `xlsx-populate` from 2020, and the `@e965/xlsx` fork has had no release since 2024-07.
    It reads cached formula values, never evaluating them, and returns every sheet. Feature 2 uses the first sheet with
    content. `write-excel-file` stays a dev dependency that only writes the sample files.
