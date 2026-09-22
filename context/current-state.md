# Current State

**Last updated:** 2026-09-22

Where the project actually is, what runs, and what to do next. Keep this file honest: it is the
first thing to read when picking the work back up.

---

## 1. Where the project stands

| Feature | State |
|---|---|
| 1 — Gmail price-list ingestion | **Implemented.** Scan, pick, download, dedup, manifest. A real attachment has been downloaded (`Samsung_Price_List.csv`, 21 Sep) |
| Viewing a downloaded file | **Implemented** (2026-09-22). Step 1 card on the workflow page: the cells as received, the analysis's mapping marked, and Download original. Checked in headless Chrome on the real Samsung file |
| Feature 1 test kit | **Implemented.** Six sample files to email to the connected account, and a byte-level check of what the app saved. Not yet run against real Gmail |
| App shell and dashboard | **Implemented.** Sidebar, eight routes, KPIs, two charts, data views |
| 2 — Normalise, compare, approve | **Implemented** (2026-09-21). Analyse, review, approve, end to end through the real routes and pages. Ran live once, on 21 Sep: the Samsung csv downloaded from Gmail was analysed through the app (live Gemini mapping, header row 1, four columns found) and approved. The matching fallback has not yet run live |
| 3 — Affected dealers and a Gmail draft | **Implemented** (2026-09-21). Steps 4–5 of the workflow. Verified live end to end: affected dealers, Gemini's wording (no numbers), the consent, and **a real Gmail draft created on 21 Sep with 13 recipients** |
| 4 — Sales Copilot | **Implemented** (2026-09-21). Gemini chooses among three read-only tools; code computes every number and checks the model's sentence. Since 2026-09-22 a vague question ("How are SSDs doing?") gets a clarification with clickable readings instead of a guess, price-change questions ("Which models got cheaper in the new lists…?") are answered from approved lists, and quarters ("this quarter", "Q2 of FY") are read by Gemini and resolved by code, with a "Read as" line leading every step. **25 of 25 live eval questions pass** on `gemini-3.5-flash-lite`; the default `gemini-3.8-flash` ran one question end to end before its free-tier daily quota ran out |

The specs are settled and live in this folder: `project-overview.md` (what the app is for),
`architecture.md` (how it is put together), `mock-data.md` (what the data is and how to regenerate it),
`ui-design.md` (every screen), `features/feature-1-gmail-price-list-ingestion.md`,
`features/feature-2-normalise-compare-approve.md`, `features/feature-3-dealer-drafts.md` and
`features/feature-4-sales-copilot.md`.

---

## 2. What runs today

| Command | What it reports |
|---|---|
| `bun run dev` | The app on http://localhost:3000 |
| `bun run test` | 304 passing tests, 0 failing (Features 1–4, the file viewer, analytics, sample files) **on the committed price list**. On a tree where approvals have edited it, Feature 2's and the sample-file tests fail by design: they pin the pristine catalogue (see Known gaps) |
| `bun run lint` | Clean, no errors or warnings |
| `bun run build` | Succeeds, no Turbopack warnings |
| `bunx tsc --noEmit` | Clean |
| `bun run mock:generate --check` | `OK: 30 products, 20 dealers, 200 sales lines in 66 invoices` on the committed data. On this working tree it fails with "T9 1TB has no sales", because approving the Samsung list added T9 1TB: expected after approvals (`mock-data.md` §8). Dealer addresses from `mock:dealer-emails` pass |
| `bun run mock:supplier-files` | Writes six sample files to `mock-data/sample-supplier-files/` and prints the email checklist. Refuses to overwrite without `--force` |
| `bun run mock:supplier-files --check-downloads` | Compares what the app saved in `mock-data/new-price-lists/` with those samples, by checksum. Before any download: `0 of 4 expected files downloaded`, `No problems found` |
| `bun run mock:dealer-emails you@gmail.com` | Rewrites only the dealers' email field to `you+dealerN@gmail.com`, so a draft's Bcc is aliases of your own inbox. Keeps approvals |
| `bun run copilot:eval` | Asks Gemini 16 real questions and checks the figures the chosen tools returned against values computed from the files. Needs `GEMINI_API_KEY`; 1–3 Gemini calls a question. Last run (2026-09-22): 25 of 25 on `gemini-3.5-flash-lite`, including vague questions that must clarify, price-change questions checked against `.data/reviews/`, and quarter questions (this quarter in exactly one query) |

Nothing works against Gmail until `.env.local` has a Google OAuth client, and Analyse and the Sales Copilot
need `GEMINI_API_KEY` — see `README.md`. The copilot does not need Gmail.

---

## 3. What is built

| Area | Files | Notes |
|---|---|---|
| OAuth and Gmail | `lib/google/oauth.ts`, `lib/gmail/price-list-emails.ts` | Read-only scope. Tokens in the gitignored `.data/` |
| Ingestion | `lib/ingest.ts`, `lib/storage/new-price-lists.ts` | Scan saves nothing; download writes only what was ticked |
| Routes | `app/api/auth/google/**`, `app/api/ingest/**`, `app/api/prices/[id]/**` | Ten handlers, typed errors mapped to status codes in `lib/api-errors.ts` |
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
| Feature 4 core | `lib/copilot/period.ts`, `filters.ts`, `sales.ts`, `products.ts`, `tools.ts`, `guard.ts`, `export.ts`, `clarify.ts`, `wording.ts`, `price-changes.ts` | Pure. The four data tools (`query_sales`, `compare_periods`, `lookup_products`, `lookup_price_changes`, which reads approved reviews), date and name resolution, the readable steps and template sentences, and the number check. `ask_clarification` (checked arguments, labels written by code) for vague questions |
| Feature 4 service | `lib/copilot/ask.ts`, `lib/llm/chat.ts`, `lib/llm/prompts/copilot.ts`, `app/api/copilot/ask/route.ts` | The tool-calling loop (4 rounds, 6 calls). `chat.ts` replays the model's steps verbatim, as the live API requires. Rate limits and a spent daily quota become a 503 with a readable message |
| Feature 4 UI | `app/copilot/page.tsx`, `CopilotChat.tsx`, `CopilotAnswer.tsx` | Steps, table, checked sentence, Copy table and Download CSV. A clarification shows its readings as buttons that ask an example question. Nothing is stored; reloading starts a new thread |
| Feature 3 core | `lib/affected.ts`, `lib/drafts/{message,mime,wording,types}.ts` | Pure. Affected dealers in the 90-day window, address checks (Gmail `+tags` and dots), the email text with every price from the review, the RFC 2822 message |
| Feature 3 services | `lib/prepare-draft.ts`, `lib/create-draft.ts`, `lib/gmail/drafts.ts`, `lib/llm/drafts.ts`, `lib/storage/drafts.ts`, `app/api/prices/[id]/draft/**` | Gemini writes the words (one retry, then the standard message); `drafts.create` with To = you, Bcc = dealers. The Gmail client type has no send method. `.data/drafts/` |
| File viewer (step 1) | `lib/file-preview.ts`, `lib/file-view.ts`, `lib/parse/spreadsheet.ts` (`parseAllSheets`), `app/api/prices/[id]/file/route.ts`, `ReceivedFileCard.tsx` | Pure layout (column letters, first 500 rows, mapped columns, skipped rows, numeric columns) and a service that turns a missing or unreadable file into a message rather than an error. The download returns the saved bytes untouched, as an attachment. `test/file-preview.test.ts`, 22 tests |
| Feature 3 UI | `AffectedDealers.tsx`, `DraftPanel.tsx`, `AddressNote.tsx`, `WorkflowStepper.tsx` | Steps 4–5 below the approved review; Allow Gmail drafts asks for `gmail.compose` on first use; Settings lists the permissions actually granted |
| Sample supplier files | `scripts/generate-supplier-files.ts`, `test/sample-files.test.ts` | Six files (`.csv`, `.xlsx`, one to ignore, one unrelated, one same-name-different-content). Each supplier file is the current list with 3 changes, 1 new, 1 left out, and one changed model spelled the supplier's way (two resolved by the LLM, one by the matching key). `write-excel-file` is a dev dependency, writer only |

### Routes

`/` dashboard · `/price-updates` files received · `/price-updates/[id]` the workflow for one file
(all five steps, plus the step 1 file viewer) · `/copilot` · `/products` · `/dealers` · `/sales` · `/settings`.

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

- **Feature 2 has run live on one file only.** The Samsung csv's column mapping came back from Gemini and passed the
  checks. The Samsung sample needs no LLM matching, so the matching fallback (Seagate's and TP-Link's renamed rows) is
  still untested live; if Gemini rejects its derived schema, `toGeminiSchema` in `lib/llm/schemas.ts` is where to
  adjust it. Use a paid-tier key before real supplier files (`architecture.md` §12, decision 8).
- **The free-tier key allows `gemini-3.8-flash` 20 requests a day.** A copilot question uses 2–3, so about 7–10 a
  day, shared with Analyse. It ran out on 2026-09-21. `LLM_MODEL=gemini-3.5-flash-lite` has its own quota and passed
  the whole eval; a paid-tier key removes the limit. The default model is unchanged. To stretch the free tier:
  `ANALYSE_MODEL` / `COPILOT_MODEL` give each feature its own model and allowance; repeated copilot questions are
  cached in memory (free until restart); `COPILOT_SENTENCE=template` halves the copilot's requests. README, "Using
  the Gemini free tier", is the guide.
- **The copilot's full eval has not run on the default model.** Only one question has, in the spike. Rerun
  `bun run copilot:eval` once the quota resets.
- **Price changes come only from approved lists, read from the reviews**, not from an audit log (decision 6). A
  re-analysed list replaces its review, nothing records who approved, and `mock:generate --force` resets the price list
  but leaves the reviews, which would then describe changes no longer in it. Lists waiting for review are named, not
  counted.
- **Gemini's tool choices can still vary between runs** of a question that is open to several readings. An identical
  question with identical history comes from the cache, steps included; a clear question now takes one query, and its
  "Read as" line shows how it was read.
- **The example questions in a clarification are Gemini's wording**, so their English varies (one read "How many units
  did ABC Computers sell"). The labels and the first line are the app's, and the subject must come from the question.
- **The sample files on disk predate the renamed rows.** `mock-data/sample-supplier-files/` was generated before
  Feature 2. Run `bun run mock:supplier-files --force` before emailing them, or the matching fallback is never
  exercised. The old files still analyse correctly.
- **`mock-data/new-price-lists/` holds one real download**, `Samsung_Price_List.csv`. Encodings and multi-sheet
  layouts (Analyse reads only the first sheet with content; the viewer shows them all) are not covered by the samples.
- **Feature 1 has downloaded one real attachment**, the Samsung csv on 21 Sep. The other five sample emails
  (`features/feature-1-gmail-price-list-ingestion.md` §10), including the `.xlsx` files and the ones that must be
  ignored, have not been sent.
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
- **The 90-day window excludes nobody on the mock data.** Every sale is inside 90 days of the data's "today"
  (2026-09-18). The filter is proven in `test/feature-3.test.ts` with sales of its own (decision 7), and
  `test/analytics.test.ts` fails loudly if the data changes.
- **The first real Gmail draft exists (21 Sep, 13 recipients); its Bcc has not been checked from here.** Look at it in
  Gmail to confirm the Bcc and that Open in Gmail opened it. The connection now holds only the read-only permission
  again (after a reconnect), so step 5 offers Allow Gmail drafts once more before another draft.
- **The file viewer was checked live on one file only**, the approved Samsung csv. Workbooks, several sheets,
  a missing file and an unreadable file are covered by unit tests, not by a browser check. Adding test files to
  your real downloads folder was declined, rightly: it would have edited your manifest.
- **The dealer addresses are still the `yourname` placeholder**, so the page shows "Test addresses detected". Run
  `bun run mock:dealer-emails <your Gmail>` first to test with your own inbox.
- **The Gmail draft permission could send.** `gmail.compose` is the narrowest scope that creates drafts. "Never
  sends" rests on the code and a test that fails on any send call.
- **`bun run test` on this working tree** reports 29 failures in Feature 2's and the sample-file tests, because
  the Samsung approval edited `current-price-list.json` and those tests pin the pristine catalogue. They pass on the
  committed file. `bun run mock:generate --force` resets it, but also undoes the approval Feature 3 is demoed from.
- **No dark mode.** The light tokens were chosen with one in mind, but `.dark` in `app/globals.css` is
  still stock neutral grey and nothing switches it on.
- **Charts were checked once, by eye.** Chrome is installed on this machine, and a headless screenshot on
  2026-09-21 showed both charts drawing with the design's figures (brand bars ₹19.6L / ₹17.1L / ₹7.2L). There
  is no automated visual test.

---

## 5. Next steps

All four features are built. When work resumes, the order that costs least rework:

1. **Finish the Feature 1 email test.** `bun run mock:supplier-files --force` (the files on disk predate the
   renamed rows), send the rest of the six emails as the checklist says
   (`features/feature-1-gmail-price-list-ingestion.md` §10), scan and download, then
   `bun run mock:supplier-files --check-downloads`. Open each download's step 1 card to see it as received.
2. **Run Feature 2's matching fallback live.** Analyse the Seagate and TP-Link downloads and check the tabs against
   `mock-data.md` §9 (the renamed rows included). Approve a
   few items, check `current-price-list.json`, then reset with `bun run mock:generate --force`.
   Anything it turns up is a Feature 2 fix, ahead of Feature 3.
3. **Check the Gmail draft from 21 Sep in Gmail:** To is you, Bcc holds the 13 addresses, the Sent folder is empty
   (`features/feature-3-dealer-drafts.md` §11). Do not send it while the addresses are the `yourname` placeholder.
4. **Rerun the copilot eval on the default model** (`bun run copilot:eval`) once the daily quota resets, or with a
   paid key, and decide whether the default should stay `gemini-3.8-flash` or move to `gemini-3.5-flash-lite`.

---

## 6. Later, to be planned separately

Nothing is queued. The audit log (decision 6) is the next thing the specs name.

---

## 7. Open decisions

Two remain (6 and 8), listed in `architecture.md` §12 with where each one should be decided. They are
not duplicated here so there is only one list to keep current.

Settled recently:

- A missing product is **deactivated, never deleted**, by an optional `status: "discontinued"` field. The
  reasoning is in `architecture.md` §6.2.
- Decisions 1–3 were settled with Feature 2 (2026-09-21):
  - Matching: code first by matching key, then an LLM fallback that code validates.
  - Where files live: `.data/normalized/` and `.data/reviews/`.
  - The `.xlsx` parser: `read-excel-file`.
- Decisions 4 and 7 were settled with Feature 3 (2026-09-21): one draft per approved price list; the 90-day filter
  proven with test data, mock data unchanged.
- Decision 5 was settled with Feature 4 (2026-09-21): the LLM writes the copilot's sentence, and code checks every
  number in it against the tool results.
