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
| 2 — Normalise, compare, approve | **Implemented** (2026-09-21). Analyse, review, approve, end to end through the real routes and pages. The Gemini calls are unit-tested with a scripted SDK but **have never run against the live API**: no key is configured |
| 3 — Draft dealer emails | **Not started.** Not planned yet either |
| 4 — Sales Copilot | **Not started.** Not planned yet either |

The specs are settled and live in this folder: `project-overview.md` (what the app is for),
`architecture.md` (how it is put together), `mock-data.md` (what the data is and how to regenerate it),
`ui-design.md` (every screen), `features/feature-1-gmail-price-list-ingestion.md` and
`features/feature-2-normalise-compare-approve.md`.

---

## 2. What runs today

| Command | What it reports |
|---|---|
| `bun run dev` | The app on http://localhost:3000 |
| `bun run test` | 112 passing tests, 0 failing (Feature 1, Feature 2, analytics, sample files) |
| `bun run lint` | Clean, no errors or warnings |
| `bun run build` | Succeeds, no Turbopack warnings |
| `bunx tsc --noEmit` | Clean |
| `bun run mock:generate --check` | `OK: 30 products, 20 dealers, 200 sales lines in 66 invoices` |
| `bun run mock:supplier-files` | Writes six sample files to `mock-data/sample-supplier-files/` and prints the email checklist. Refuses to overwrite without `--force` |
| `bun run mock:supplier-files --check-downloads` | Compares what the app saved in `mock-data/new-price-lists/` with those samples, by checksum. Before any download: `0 of 4 expected files downloaded`, `No problems found` |

Nothing works against Gmail until `.env.local` has a Google OAuth client, and Analyse needs
`GEMINI_API_KEY` — see `README.md`.

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
| Placeholders | `app/copilot` | Says which feature it belongs to rather than showing fake data. Steps 4–5 of the workflow are shown locked, marked Feature 3 |
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

---

## 4. Known gaps

These are all deliberate, not oversights.

- **The live Gemini call is unverified.** `.env` has the Google OAuth variables only. The call shape follows
  Google's structured-output docs and the SDK's types, and a mocked SDK tests the wrapper, but the first real
  Analyse is the first real call. If Gemini rejects the derived schema, `toGeminiSchema` in `lib/llm/schemas.ts`
  is where to adjust it. Use a paid-tier key before real supplier files (`architecture.md` §12, decision 8).
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

Features 1 and 2 are built. When work resumes, the order that costs least rework:

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
4. **Feature 4** on `/copilot`. Reuse `lib/analytics.ts`; the LLM plans the steps, the app runs them.

---

## 6. Later, to be planned separately

Each of these gets its own plan and its own file in `context/features/` before any code.

- **Feature 3 — draft dealer emails.** Find dealers who bought the changed models in the last 90 days,
  LLM writes a short update, saved as a Gmail draft with dealers in BCC. Never sent by the app.
  *Not planned yet.*
- **Feature 4 — Sales Copilot.** Plain-English questions, answered with the steps shown. *Not planned yet.*

---

## 7. Open decisions

Five remain (4–8), listed in `architecture.md` §12 with where each one should be decided. They are not
duplicated here so there is only one list to keep current.

Settled recently:

- A missing product is **deactivated, never deleted**, by an optional `status: "discontinued"` field. The
  reasoning is in `architecture.md` §6.2.
- Decisions 1–3 were settled with Feature 2 (2026-09-21):
  - Matching: code first by matching key, then an LLM fallback that code validates.
  - Where files live: `.data/normalized/` and `.data/reviews/`.
  - The `.xlsx` parser: `read-excel-file`.
