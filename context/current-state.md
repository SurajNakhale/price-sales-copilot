# Current State

**Last updated:** 2026-09-21

Where the project actually is, what runs, and what to do next. Keep this file honest: it is the
first thing to read when picking the work back up.

---

## 1. Where the project stands

| Feature | State |
|---|---|
| 1 — Gmail price-list ingestion | **Implemented.** Scan, pick, download, dedup, manifest |
| App shell and dashboard | **Implemented.** Sidebar, seven routes, KPIs, two charts, data views |
| 2 — Normalise, compare, approve | **Not started.** Not planned yet either |
| 3 — Draft dealer emails | **Not started.** Not planned yet either |
| 4 — Sales Copilot | **Not started.** Not planned yet either |

The specs are settled and live in this folder: `project-overview.md` (what the app is for),
`architecture.md` (how it is put together), `mock-data.md` (what the data is and how to regenerate it),
`ui-design.md` (every screen), and `features/feature-1-gmail-price-list-ingestion.md`.

---

## 2. What runs today

| Command | What it reports |
|---|---|
| `bun run dev` | The app on http://localhost:3000 |
| `bun run test` | 42 passing tests, 0 failing |
| `bun run lint` | Clean, no errors or warnings |
| `bun run build` | Succeeds, no Turbopack warnings |
| `bunx tsc --noEmit` | Clean |
| `bun run mock:generate --check` | `OK: 30 products, 20 dealers, 200 sales lines in 66 invoices` |

Nothing works against Gmail until `.env.local` has a Google OAuth client — see `README.md`.

---

## 3. What is built

| Area | Files | Notes |
|---|---|---|
| OAuth and Gmail | `lib/google/oauth.ts`, `lib/gmail/price-list-emails.ts` | Read-only scope. Tokens in the gitignored `.data/` |
| Ingestion | `lib/ingest.ts`, `lib/storage/new-price-lists.ts` | Scan saves nothing; download writes only what was ticked |
| Routes | `app/api/auth/google/**`, `app/api/ingest/**` | Five handlers, typed errors mapped to status codes |
| Data layer | `lib/data/mock-data.ts` | Reads the three datasets; a missing file is an empty list |
| Analytics | `lib/analytics.ts` | Pure. Totals, brand splits, weekly buckets, the trend's solid/dashed split |
| Formatting | `lib/format.ts` | ₹43.9L on tiles, ₹43,91,820 in tables; months from a fixed table |
| Shell | `app/layout.tsx`, `app/_components/AppSidebar.tsx`, `PageHeader.tsx` | Sidebar counts and Gmail status come from the server layout |
| Dashboard | `app/page.tsx`, `KpiCards.tsx`, `SalesCharts.tsx`, `PriceListsCard.tsx` | Real figures, no placeholders |
| Feature 1 UI | `app/_components/ScanDialog.tsx`, `GmailSettings.tsx` | Scan is a dialog off the header; connection lives in Settings |
| Data views | `app/products`, `app/dealers`, `app/sales` | Read-only tables. Sales paginates 50 a page |
| Placeholders | `app/price-updates`, `app/copilot` | Say which feature they belong to rather than showing fake data |

### Routes

`/` dashboard · `/price-updates` files received · `/copilot` · `/products` · `/dealers` · `/sales` ·
`/settings`. `/price-updates/[id]`, the five-step workflow, belongs to Feature 2 and does not exist.

---

## 4. Known gaps

These are all deliberate, not oversights.

- **`lib/product-id.ts` does not exist.** `architecture.md` §6.2 says the Product ID rule must live in
  one pure module shared with the mock-data script. It is still only in
  `scripts/generate-mock-data.ts`, and `lib/config.ts` has no brand-code table. **Feature 2 needs both.**
- **No Gemini key.** `.env` has the Google OAuth variables only. Nothing calls an LLM yet.
- **`mock-data/new-price-lists/` is empty**, so there is no supplier file to parse. Feature 2 will
  need sample files — generated fixtures, real emailed attachments, or both. Not decided.
- **The manifest records no brand.** `ManifestEntry` has sender, subject, filename and dates. Brand is
  only knowable once a file is normalised, so the price-list table shows `—` for Brand and Changes.
- **KPI 3 and KPI 4 show `—`.** Price changes and Needs review both come from Feature 2.
- **The 90-day window cannot exclude anyone.** Every sale falls within 90 days of the data's "today"
  (2026-09-18), so Feature 3's filter is untestable until the sales history reaches back to about May.
  A test in `test/analytics.test.ts` asserts this, so it will fail loudly when the data changes.
- **No dark mode.** The light tokens were chosen with one in mind, but `.dark` in `app/globals.css` is
  still stock neutral grey and nothing switches it on.
- **Charts are not visually verified.** Their inputs are unit-tested and the pages were fetched and
  checked, but recharts only draws in the browser and no headless browser is installed here.

---

## 5. Next steps

Nothing is queued. The shell-and-dashboard chunk is finished. When work resumes, the order that
costs least rework:

1. **Plan Feature 2** — normalise, compare, approve. Decide first: where sample supplier files come
   from, the `.xlsx` parser, where normalised output and pending changes live, and how incoming rows
   match existing products (`architecture.md` §12, open decisions 1–3).
2. **Extract `lib/product-id.ts`** and the brand-code table into `lib/config.ts`, with the mock-data
   script importing them. Small, and it unblocks generating IDs for new products.
3. **Build Feature 2** into `/price-updates/[id]` as steps 1–3 of the workflow, replacing that route's
   placeholder. Add the `tabs` shadcn component.
4. **Feature 3** as steps 4–5 of the same workflow. Needs a Gmail compose scope, so the OAuth consent
   has to be re-granted.
5. **Feature 4** on `/copilot`. Reuse `lib/analytics.ts`; the LLM plans the steps, the app runs them.

---

## 6. Later, to be planned separately

Each of these gets its own plan and its own file in `context/features/` before any code.

- **Feature 2 — normalise, compare, approve.** LLM maps a supplier's columns to the standard format;
  code compares against the current price list; a person approves each change. *Not planned yet.*
- **Feature 3 — draft dealer emails.** Find dealers who bought the changed models in the last 90 days,
  LLM writes a short update, saved as a Gmail draft with dealers in BCC. Never sent by the app.
  *Not planned yet.*
- **Feature 4 — Sales Copilot.** Plain-English questions, answered with the steps shown. *Not planned yet.*

---

## 7. Open decisions

Eight remain, listed in `architecture.md` §12 with where each one should be decided. They are not
duplicated here so there is only one list to keep current.

Settled recently: a missing product is **deactivated, never deleted**, by an optional
`status: "discontinued"` field. The reasoning is in `architecture.md` §6.2.
