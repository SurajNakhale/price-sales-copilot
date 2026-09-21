# Feature 2 — Normalise, Compare, Approve

**Status:** Implemented (2026-09-21). Planned with the user and built the same day. Tests, lint, type-check and build
pass, and the workflow was run end to end on the dev server with a scripted LLM. The live Gemini call has not run yet:
no key was configured. See `current-state.md`.

## 1. Purpose and boundary

Feature 1 leaves raw supplier files in `mock-data/new-price-lists/`. Every supplier names and lays out its columns
differently. Feature 2 turns one raw file into the standard price-list shape, compares it with the current catalogue,
and lets a person approve each change before `current-price-list.json` is written.

**Feature 2 does:**

- Parse one downloaded `.xlsx` or `.csv` file (values only).
- Ask the LLM **which column is which**: a column mapping, never rows or prices.
- Apply that mapping in code to every row, producing a separate normalised object saved as a temporary file.
- Match each normalised row to an existing product: code first, then the LLM for rows code cannot resolve.
- Compare the normalised file with the current price list in code. This step is deterministic and uses no LLM.
- Show price changes, new products and missing products, and write only what the user approves.

**Feature 2 does NOT:**

- Let the LLM type, change or invent a price. Prices are copied from the cells by code.
- Delete a product. A missing product is kept or deactivated.
- Find affected dealers or draft email (Feature 3, workflow steps 4–5). Feature 2 hands over the approved changes.

## 2. Decisions

| Decision | Choice |
|---|---|
| What the LLM returns | A column mapping: header row, brand, and which header is model / category / dealer price / MRP. Code applies it to every row (`architecture.md` §6.2) |
| Matching (open decision 1) | Code first: `createMatchingKey(brand, model)` against an identity map built from the current list. Rows it misses go to the LLM with that brand's unclaimed catalogue rows. Code checks every proposed Product ID. Anything still unmatched is a new product |
| Where files live (open decision 2) | Normalised file: `.data/normalized/<fileId>.json`. Review (pending changes and decisions): `.data/reviews/<fileId>.json`. Both are gitignored, temporary working state |
| `.xlsx` parser (open decision 3) | `read-excel-file` 9.x (`read-excel-file/node`). Reads cached cell values, never evaluates formulas. `.csv` uses a small in-house parser |
| LLM | Gemini through `@google/genai`, Interactions API, `store: false`, JSON constrained by a schema derived from Zod and re-validated with Zod |
| File ID | First 12 hex characters of `sha256(messageId + "\0" + partId)`. Routes take this ID, never a path |
| Brand codes | `BRAND_CODES` lives in `lib/product-id.ts`, not `lib/config.ts`. The mock-data script imports it, and `config.ts` is `server-only`, which a plain `bun scripts/…` run cannot import |
| Approval | One commit per file. All or nothing: if any selected item no longer matches the current price list, nothing is written |

## 3. Pipeline

```text
mock-data/new-price-lists/<file>        raw, never modified
  │ parse (code)                        csv: in-house parser · xlsx: first non-empty sheet, values only
  ▼
LLM: proposeColumnMapping               input: filename, sender, subject, sheet name, first 15 rows
  │                                     (cells cut to 80 characters)
  │ validate (Zod + code)               header row exists; each named column is in that row; columns are
  │                                     distinct; brand is known. A failure is sent back to the LLM once,
  │                                     then the analysis fails with the reason
  ▼
normalise (code)                        every non-blank row below the header: model text, category,
  │                                     dealer price and MRP parsed as whole rupees. Bad rows become
  │                                     issues shown to the reviewer, never silently dropped
  ▼
match (code → LLM → code)               matching key → LLM for unresolved rows → ID must be one of the
  │                                     candidates and not already claimed → otherwise a new product with
  │                                     a generated ID
  ▼
.data/normalized/<fileId>.json          NormalizedPriceList: the separate normalised object
  ▼
compare (code, pure)                    price change · new · missing · unchanged
  ▼
.data/reviews/<fileId>.json             PriceReview: every item with old and new values
  ▼
Review & approve (person)               ticks price changes and new products; Keep / Deactivate per missing product
  ▼
approve (code)                          re-checks against the current list, one atomic write
```

## 4. Parsing and normalising

- **Sheet.** The first sheet with at least one non-empty cell. Its name is recorded and shown.
- **Size cap.** More than 2,000 rows stops the analysis with a message.
- **Header row.** Chosen by the LLM as a 1-based row number, so title rows above the header (Seagate) are skipped.
- **Model.** Cell text, trimmed. An empty model is an issue.
- **Category.** Optional in the file. When absent, a matched product keeps its catalogue category and a new product
  gets an empty category. A different category from the file on an existing product is shown to the reviewer but not
  applied, because only prices are compared.
- **Money.** A number cell is used as it is. A text cell has `₹`, `INR`, `Rs`, commas and spaces removed. Either way
  the value must be a positive whole number of rupees, otherwise the row is an issue.
- **Sanity.** A dealer price above MRP is an issue. A second row whose matching key repeats an earlier one is an issue
  ("same product as row N").

## 5. Matching

`createMatchingKey(brand, model)`:

1. NFKC normalisation, lower case.
2. Everything other than letters and digits becomes a space.
3. A leading brand name is removed (`seagate`, `samsung`, `tp link`, `tplink`).
4. A number followed by a unit is joined (`1 tb` becomes `1tb`).
5. Spaces are collapsed, and the key is prefixed with the brand (`seagate:barracuda 2tb`).

The identity map is built from **every** product in the current list, discontinued ones included.

Rows with no key match are sent to the LLM in one call per file. The call carries the rows' supplier model and
category, plus the brand's products that no key match has claimed. An LLM answer is accepted only if its Product ID
is one of those candidates and no earlier row has claimed it. Otherwise the row is new. The LLM is told never to
match a different capacity, size or variant.

A new product gets `generateProductId(brand, model, takenIds)`: the existing rule
(`<code>-<first 5 hex of sha256("brand|model") lowercased>`), re-hashed with a counter until the ID is unused.

## 6. Comparison

| Outcome | Rule |
|---|---|
| Price change | Matched to an active product and the dealer price or MRP differs |
| Unchanged | Matched to an active product and both prices are equal |
| New product | No match. Or matched to a **discontinued** product, which is shown as new and reuses its old ID ("adding it back reactivates it") |
| Missing | An **active** product of the **file's brand** that no row matched |

Each item carries an `itemId` (`<kind>:<productId>`) and the old values it was compared with. A file whose comparison
finds nothing gets the status **No changes**.

## 7. Approval

`POST /api/prices/<fileId>/approve` with `{ itemIds: string[] }` (at least one):

- **Price change.** The product must still be active and still carry the old dealer price and MRP. Writes the new
  prices.
- **New product.** The ID must still be free and no active product may have the same matching key. Appends the
  product. For a reactivation, the product must still be discontinued; `status` and `discontinuedOn` are removed and
  the prices written.
- **Missing, when Deactivate is chosen.** The product must still exist and be active. Writes
  `status: "discontinued"` and `discontinuedOn` (the approval date). Keep sends nothing.

If any selected item fails its check, the request returns **409** and nothing is written. The same check runs when the
review page loads, which then says the price list changed after the analysis and offers **Re-analyse** in place of
Approve. Otherwise all selected items are written in one atomic write. The review becomes `approved` with the applied
item IDs and a timestamp. That record is what Feature 3 reads. A review is approved once; a second request returns 409.
Re-analysing an approved file is refused.

## 8. Data shapes

```jsonc
// .data/normalized/<fileId>.json
{
  "fileId": "3f1c9a0b2d4e", "sourceFile": "Samsung_Price_List.csv", "sheet": null, "brand": "Samsung",
  "mapping": { "headerRow": 1, "brand": "Samsung",
               "columns": { "model": "Model", "category": "Type", "dealerPrice": "Dealer Price (INR)", "mrp": "MRP (INR)" } },
  "rows": [
    { "rowNumber": 2, "productId": "SAM-B072D", "match": "llm", "supplierModel": "Portable SSD T7 1TB",
      "brand": "Samsung", "model": "T7 1TB", "category": "SSD", "dealerPrice": 7500, "mrp": 10499 }
  ],
  "issues": [ { "rowNumber": 9, "reason": "Dealer price \"—\" is not a whole number of rupees." } ],
  "normalizedAt": "2026-09-21T10:00:00.000Z"
}

// .data/reviews/<fileId>.json
{
  "fileId": "3f1c9a0b2d4e", "sourceFile": "Samsung_Price_List.csv", "brand": "Samsung",
  "status": "needs-review",            // needs-review | approved | no-changes | failed
  "rowsInFile": 10, "unchanged": 5, "issues": 0,
  "items": [
    { "kind": "price-change", "itemId": "price-change:SAM-B072D", "productId": "SAM-B072D", "model": "T7 1TB",
      "supplierModel": "Portable SSD T7 1TB", "match": "llm",
      "old": { "dealerPrice": 7000, "mrp": 9999 }, "new": { "dealerPrice": 7500, "mrp": 10499 } },
    { "kind": "new-product", "itemId": "new-product:SAM-…", "productId": "SAM-…", "model": "T9 1TB",
      "category": "SSD", "dealerPrice": 8500, "mrp": 11999, "reactivates": false },
    { "kind": "missing", "itemId": "missing:SAM-72942", "productId": "SAM-72942", "model": "990 EVO 1TB",
      "category": "SSD", "dealerPrice": 7600, "mrp": 10499 }
  ],
  "analysedAt": "…", "approvedAt": "…", "applied": ["price-change:SAM-B072D"], "error": "only when failed"
}
```

## 9. Routes and modules

| Route | Service | Errors |
|---|---|---|
| `POST /api/prices/[id]/analyse` | `analysePriceList` (`lib/analyse.ts`) | 404 unknown file · 409 already approved · 422 unusable file (empty, over 2,000 rows, no usable rows, unknown brand) · 502 invalid LLM output · 500 missing `GEMINI_API_KEY` |
| `POST /api/prices/[id]/approve` | `approveReview` (`lib/approve.ts`) | 400 bad body · 404 no review · 409 already approved or outdated |

| Module | Job | Pure |
|---|---|---|
| `lib/product-id.ts` | Brand codes, `productIdFor`, `generateProductId`. Shared with `scripts/` | yes |
| `lib/matching-key.ts` | `createMatchingKey`, `buildIdentityMap` | yes |
| `lib/parse/csv.ts`, `lib/parse/spreadsheet.ts` | Raw file to rows of cells | csv yes |
| `lib/normalize.ts` | Mapping checks, `applyMapping`, money parsing | yes |
| `lib/match.ts` | Code-first matching with the LLM fallback behind `LlmPort` | yes, apart from the port |
| `lib/compare.ts` | `comparePriceList`, `findOutdatedItems`, review summaries | yes |
| `lib/llm/` | The only `@google/genai` importer: client, prompts, schemas, `LlmPort` | no |
| `lib/storage/price-reviews.ts` | File IDs, normalised and review files | no |
| `lib/analyse.ts`, `lib/approve.ts` | The two services | no |

## 10. UI

Follows `ui-design.md` §2.4, §2.5, §3 and §5 to §8.

- **`/price-updates`.** The stepper legend, then every file, with brand, the "3 price · 1 new · 1 missing" breakdown,
  status and one action (Analyse / Review / View / Retry). The dashboard's list and KPI tiles 3–4 and the sidebar
  badge read the same reviews.
- **`/price-updates/[id]`.** Header with the file, sender and received date. A five-step stepper that names who acts.
  - Before analysis: step 2, with an explicit **Analyse** button that says exactly what is sent to Gemini.
  - After analysis: step 3, Review & approve. A summary strip, tabs for price changes, new products and missing
    products, checkboxes that start unticked, Keep / Deactivate defaulting to Keep, and one **Approve N changes**
    commit.
  - After approval: what was applied, and steps 4–5 marked as Feature 3.

## 11. Edge cases

| Case | Behaviour |
|---|---|
| File for an unknown brand | The LLM answers `unknown`; the analysis fails asking for the brand's code in `BRAND_CODES` |
| Header not found, or a named column missing from it | Sent back to the LLM once with the reason, then fails with it |
| Formula cells | Their cached values are read; nothing is evaluated |
| Two files change the same product (`revised/Samsung_Price_List.csv`) | The second file's review goes out of date after the first approval; it must be re-analysed |
| LLM proposes an unknown or already-claimed ID | Ignored; the row becomes a new product and the reviewer sees both it and the missing original |
| No `GEMINI_API_KEY` | The analysis fails with a message naming the variable |
| Every row unchanged | Status **No changes**, nothing to approve |

## 12. Sample files

Each generated supplier file renames one model so both matching paths run:

| Supplier | Renamed row | Resolved by |
|---|---|---|
| Samsung | `Portable SSD T7 1TB` (also a price change) | LLM |
| Seagate | `SEAGATE BARRACUDA-2TB` (also a price change) | Matching key |
| TP-Link | `Archer C6 AC1200` (also a price change) | LLM |

Regenerate with `bun run mock:supplier-files --force` and email them again.

## 13. Verification

- `bun run test`: product IDs reproduce all 30 existing ones; matching keys; the CSV parser; mapping validation; each
  sample file yields the `mock-data.md` §9 outcome through a fake LLM; bad LLM matches become new products; approval
  writes only the selected items, refuses outdated ones and writes `discontinued`.
- `bun run lint`, `bunx tsc --noEmit` and `bun run build` are clean.
- Manual: with `GEMINI_API_KEY` set, download the sample files, analyse each, compare with §9, approve some items,
  inspect `current-price-list.json`, then reset with `bun run mock:generate --force`.
