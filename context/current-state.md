# Current State

**Last updated:** 2026-09-21

Where the project actually is, what runs, and what to do next. Keep this file honest: it is the
first thing to read when picking the work back up.

---

## 1. Where the project stands

| Feature | State |
|---|---|
| 1 — Gmail price-list ingestion | **Implemented.** Scan, pick, download, dedup, manifest. Has scanned a real mailbox (nothing found) but not yet downloaded a real attachment |
| Feature 1 test kit | **Implemented.** Six sample files to email to the connected account, and a byte-level check of what the app saved. Not yet run against real Gmail |
| App shell and dashboard | **Implemented.** Sidebar, eight routes, KPIs, two charts, data views |
| 2 — Normalise, compare, approve | **Implemented** (2026-09-21). Analyse, review, approve, end to end through the real routes and pages. The Gemini calls are unit-tested with a scripted SDK but **have never run against the live API** (a key was added later, during Feature 4) |
| 3 — Draft dealer emails | **Not started.** Not planned yet either |
| 4 — Sales Copilot | **Implemented** (2026-09-21). Gemini chooses among three read-only tools; code computes every number and checks the model's sentence. **16 of 16 live eval questions pass** on `gemini-3.5-flash-lite`; the default `gemini-3.8-flash` ran one question end to end before its free-tier daily quota ran out |

The specs are settled and live in this folder: `project-overview.md` (what the app is for),
`architecture.md` (how it is put together), `mock-data.md` (what the data is and how to regenerate it),
`ui-design.md` (every screen), `features/feature-1-gmail-price-list-ingestion.md`,
`features/feature-2-normalise-compare-approve.md` and `features/feature-4-sales-copilot.md`.

---

## 2. What runs today

| Command | What it reports |
|---|---|
| `bun run dev` | The app on http://localhost:3000 |
| `bun run test` | 171 passing tests, 0 failing (Feature 1, Feature 2, Feature 4, analytics, sample files) |
| `bun run lint` | Clean, no errors or warnings |
| `bun run build` | Succeeds, no Turbopack warnings |
| `bunx tsc --noEmit` | Clean |
| `bun run mock:generate --check` | `OK: 30 products, 20 dealers, 200 sales lines in 66 invoices` |
| `bun run mock:supplier-files` | Writes six sample files to `mock-data/sample-supplier-files/` and prints the email checklist. Refuses to overwrite without `--force` |
| `bun run mock:supplier-files --check-downloads` | Compares what the app saved in `mock-data/new-price-lists/` with those samples, by checksum. Before any download: `0 of 4 expected files downloaded`, `No problems found` |
| `bun run copilot:eval` | Asks Gemini 16 real questions and checks the figures the chosen tools returned against values computed from the files. Needs `GEMINI_API_KEY`; 2–3 Gemini calls a question. Last run: 16 of 16 on `gemini-3.5-flash-lite` |

Nothing works against Gmail until `.env.local` has a Google OAuth client, and Analyse and the Sales Copilot
need `GEMINI_API_KEY` — see `README.md`. The copilot does not need Gmail.

---

## 3. What is built

| Area | Files | Notes |
|---|---|---|
| OAuth and Gmail | `lib/google/oauth.ts`, `lib/gmail/price-list-emails.ts` | Read-only scope. Tokens in the gitignored `.data/` |
| Ingestion | `lib/ingest.ts`, `lib/storage/new-price-lists.ts` | Scan saves nothing; download writes only what was ticked |
| Routes | `app/api/auth/google/**`, `app/api/ingest/**`, `app/api/prices/[id]/**` | Seven handlers, typed errors mapped to status codes in `lib/api-errors.ts` |
| Feature 2 core | `lib/product-id.ts`, `matching-key.ts`, `parse/`, `normalize.ts`, `match.ts`, `compare.ts`, `file-id.ts` | Pure apart from `parse/spreadsheet.ts` (reads xlsx) and `match.ts` (calls the LLM through a port). `BRAND_CODES` lives in `product-id.ts`, which the mock-data script imports |
| Feature 2 services | `lib/analyse.ts`, `lib/approve.ts`, `lib/storage/price-reviews.ts` | Normalised files in `.data/normalized/`, reviews in `.data/reviews/`. Approval is all or nothing and re-checks every item against the current list |
| LLM | `lib/llm/` | The only `@google/genai` importer. Interactions API, `store: false`, Zod-derived schema, one retry with the reason. `LlmPort` lets tests and scripts pass a fake |
| Feature 2 UI | `app/price-updates/[id]/page.tsx`, `AnalyseCard.tsx`, `ReviewPanel.tsx`, `ReviewTables.tsx`, `WorkflowStepper.tsx`, `PriceListStatus.tsx` | Steps 2–3 of the workflow. The list, dashboard tiles and sidebar badge read the same reviews |
| Data layer | `lib/data/mock-data.ts` | Reads the three datasets; a missing file is an empty list |
| Analytics | `lib/analytics.ts` | Pure. Totals, brand splits, weekly buckets, the trend's solid/dashed split |
| Formatting | `lib/format.ts` | ₹43.9L on tiles, ₹43,91,820 in tables; months from a fixed table |
| Shell | `app/layout.tsx`, `app/_components/AppSidebar.tsx`, `PageHeader.tsx` | Sidebar counts and Gmail status come from the server layout |
| Dashboard | `app/page.tsx`, `KpiCards.tsx`, `SalesCharts.tsx`, `PriceListsCard.tsx` | Real figures, no placeholders |
| Feature 1 UI | `app/_components/ScanDialog.tsx`, `GmailSettings.tsx` | Scan is a dialog off the header; connection lives in Settings |
| Data views | `app/products`, `app/dealers`, `app/sales` | Read-only tables. Sales paginates 50 a page |
| Feature 4 core | `lib/copilot/period.ts`, `filters.ts`, `sales.ts`, `products.ts`, `tools.ts`, `guard.ts`, `export.ts` | Pure. The three tools (`query_sales`, `compare_periods`, `lookup_products`), date and name resolution, the readable steps and template sentences, and the number check |
| Feature 4 service | `lib/copilot/ask.ts`, `lib/llm/chat.ts`, `lib/llm/prompts/copilot.ts`, `app/api/copilot/ask/route.ts` | The tool-calling loop (4 rounds, 6 calls). `chat.ts` replays the model's steps verbatim, as the live API requires. Rate limits and a spent daily quota become a 503 with a readable message |
| Feature 4 UI | `app/copilot/page.tsx`, `CopilotChat.tsx`, `CopilotAnswer.tsx` | Steps, table, checked sentence, Copy table and Download CSV. Nothing is stored; reloading starts a new thread |
| Locked steps | `WorkflowStepper.tsx` | Steps 4–5 of the workflow are shown locked, marked Feature 3 |
| Sample supplier files | `scripts/generate-supplier-files.ts`, `test/sample-files.test.ts` | Six files (`.csv`, `.xlsx`, one to ignore, one unrelated, one same-name-different-content). Each supplier file is the current list with 3 changes, 1 new, 1 left out, and one changed model spelled the supplier's way (two resolved by the LLM, one by the matching key). `write-excel-file` is a dev dependency, writer only |

### Routes

`/` dashboard · `/price-updates` files received · `/price-updates/[id]` the workflow for one file
(steps 2–3 built) · `/copilot` · `/products` · `/dealers` · `/sales` · `/settings`.

### How Feature 2 was verified (2026-09-21)

- **Unit tests** (`test/feature-2.test.ts`, 32 tests): product IDs, matching keys, the csv parser, mapping checks,
  every sample file through the real analysis service with a scripted LLM, bad LLM matches, approval, outdated
  items, reactivation, and the Gemini wrapper against a mocked SDK (schema sent, `store: false`, retry, unknown brand).
- **End to end on the dev server.** The new sample files were placed in `new-price-lists/`. A real Analyse with no key
  was checked: 500 `missing_config`, recorded as Failed with Retry. Reviews were then produced with a scripted LLM, and
  approvals went through the real route. Checked results:
  - The price-list diff held exactly the three approved changes.
  - Mixed outdated selections returned 409 with nothing written.
  - Approving a file twice returned 409.
  - Walked in headless Chrome (puppeteer-core from the session scratchpad, not a project dependency), with no browser
    console errors.
  - Everything was then removed, and the price list was restored from git.

### How Feature 4 was verified (2026-09-21)

- **Unit tests** (`test/feature-4.test.ts`, 59 tests, no network): every §5 answer in the spec recomputed by brute force
  and compared with the tools; periods, filters, the number check, the loop with a scripted model, the Gemini request
  shape and error mapping. Disabling the number check or the zero-sales lookup fails them.
- **Live API spike** on `gemini-3.8-flash`: confirmed the response shape and that the model's thought signatures must
  be replayed unchanged (dropping one gets a 400). Recorded in `architecture.md` §7.
- **Live eval, 16 of 16** on `gemini-3.5-flash-lite`, then through the real route and page in headless Chrome. The
  screenshot caught a "not bought" table led by the biggest buyers; fixed. Details in the spec, §9.

---

## 4. Known gaps

These are all deliberate, not oversights.

- **Feature 2's live Gemini call is unverified.** A key is now in `.env`, and Feature 4's tool calls have run against
  the live API, but Feature 2's structured-output call has not. The call shape follows Google's structured-output
  docs and the SDK's types, and a mocked SDK tests the wrapper. If Gemini rejects the derived schema, `toGeminiSchema`
  in `lib/llm/schemas.ts` is where to adjust it. Use a paid-tier key before real supplier files (`architecture.md`
  §12, decision 8).
- **The free-tier key allows `gemini-3.8-flash` 20 requests a day.** A copilot question uses 2–3, so about 7–10 a
  day, shared with Analyse. It ran out on 2026-09-21. `LLM_MODEL=gemini-3.5-flash-lite` has its own quota and passed
  the whole eval; a paid-tier key removes the limit. The default model is unchanged. To stretch the free tier:
  `ANALYSE_MODEL` / `COPILOT_MODEL` give each feature its own model and allowance; repeated copilot questions are
  cached in memory (free until restart); `COPILOT_SENTENCE=template` halves the copilot's requests. README, "Using
  the Gemini free tier", is the guide.
- **The copilot's full eval has not run on the default model.** Only one question has, in the spike. Rerun
  `bun run copilot:eval` once the quota resets.
- **The copilot cannot answer price-history questions** ("which products had a price increase?"). There is no change
  history yet (decision 6); it says so instead of guessing.
- **The sample files on disk predate the renamed rows.** `mock-data/sample-supplier-files/` was generated before
  Feature 2. Run `bun run mock:supplier-files --force` before emailing them, or the matching fallback is never
  exercised. The old files still analyse correctly.
- **`mock-data/new-price-lists/` is empty until the email test is run.** Encodings and multi-sheet layouts (only the
  first sheet with content is read) are not covered by the samples.
- **Feature 1 has never downloaded a real attachment.** It has connected and scanned a real mailbox,
  which found nothing. Its save logic was rehearsed offline with the real `saveAttachment` and every
  documented outcome held, but Gmail's search matching and real MIME structures are untested until the
  emails in `features/feature-1-gmail-price-list-ingestion.md` §10 are sent.
- **An identical resend shows as a second dashboard row.** The manifest gains an entry for it (by design),
  and "New price lists" lists one row per email. Whether to show one row per file is undecided.
- **Brand shows only after analysis.** `ManifestEntry` has no brand, so the price-list table shows `—` for
  Brand and Changes until a file is analysed; the review supplies both. KPI 3 and 4 show `—` until the first
  analysis, as the design asks.
- **No change history yet.** An approval records its applied items and time in the review file, but there is
  no append-only audit log (`architecture.md` §12, decision 6). Nothing records *who* approved; the app has one
  user.
- **The "Analysing" status lives only in the browser that pressed Analyse.** The request runs synchronously,
  so the list never shows a file as Analysing.
- **The 90-day window cannot exclude anyone.** Every sale falls within 90 days of the data's "today"
  (2026-09-18), so Feature 3's filter is untestable until the sales history reaches back to about May.
  A test in `test/analytics.test.ts` asserts this, so it will fail loudly when the data changes.
- **No dark mode.** The light tokens were chosen with one in mind, but `.dark` in `app/globals.css` is
  still stock neutral grey and nothing switches it on.
- **Charts were checked once, by eye.** Chrome is installed on this machine, and a headless screenshot on
  2026-09-21 showed both charts drawing with the design's figures (brand bars ₹19.6L / ₹17.1L / ₹7.2L). There
  is no automated visual test.

---

## 5. Next steps

Features 1, 2 and 4 are built. When work resumes, the order that costs least rework:

1. **Run the Feature 1 email test with the new samples.** `bun run mock:supplier-files --force` (the files
   on disk predate the renamed rows), send the six emails as the checklist says
   (`features/feature-1-gmail-price-list-ingestion.md` §10), scan and download, then
   `bun run mock:supplier-files --check-downloads`. This is the first time Feature 1 downloads a real
   attachment.
2. **Run Feature 2 against the live Gemini API.** Add `GEMINI_API_KEY` to `.env.local`, analyse each
   downloaded file and check the tabs against `mock-data.md` §9 (the renamed rows included). Approve a
   few items, check `current-price-list.json`, then reset with `bun run mock:generate --force`.
   Anything it turns up is a Feature 2 fix, ahead of Feature 3.
3. **Plan Feature 3** as steps 4–5 of the same workflow: its own spec in `context/features/` first.
   It reads the approved review's `applied` items. Decide open decisions 4 and 7 (one draft or several;
   extending the sales history so the 90-day filter can exclude anyone). Needs a Gmail compose scope,
   so the OAuth consent has to be re-granted.
4. **Rerun the copilot eval on the default model** (`bun run copilot:eval`) once the daily quota resets, or with a
   paid key, and decide whether the default should stay `gemini-3.8-flash` or move to `gemini-3.5-flash-lite`.

---

## 6. Later, to be planned separately

Each of these gets its own plan and its own file in `context/features/` before any code.

- **Feature 3 — draft dealer emails.** Find dealers who bought the changed models in the last 90 days,
  LLM writes a short update, saved as a Gmail draft with dealers in BCC. Never sent by the app.
  *Not planned yet.*

---

## 7. Open decisions

Four remain (4, 6, 7 and 8), listed in `architecture.md` §12 with where each one should be decided. They are
not duplicated here so there is only one list to keep current.

Settled recently:

- A missing product is **deactivated, never deleted**, by an optional `status: "discontinued"` field. The
  reasoning is in `architecture.md` §6.2.
- Decisions 1–3 were settled with Feature 2 (2026-09-21):
  - Matching: code first by matching key, then an LLM fallback that code validates.
  - Where files live: `.data/normalized/` and `.data/reviews/`.
  - The `.xlsx` parser: `read-excel-file`.
- Decision 5 was settled with Feature 4 (2026-09-21): the LLM writes the copilot's sentence, and code checks every
  number in it against the tool results.
