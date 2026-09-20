# Feature 1 — Gmail Price List Ingestion

**Status:** Implemented (2026-09-20). Lint, type-check, build and `bun test` pass. The end-to-end run
against a real mailbox needs Google credentials — see the setup steps in `README.md`.

## 1. Purpose and boundary

Feature 1 is the "receiving department". It connects to Gmail, finds price-list emails, downloads their Excel/CSV attachments, and saves the **raw files** into `mock-data/new-price-lists/`.

> Gmail is only the source. The downloaded attachment becomes the input for the next stage.

**Feature 1 does:**

- Connect to Gmail through Google OAuth (read-only).
- Find likely price-list emails.
- Keep only `.xlsx` and `.csv` attachments.
- Download them and save the raw files, plus a small `manifest.json`.

**Feature 1 does NOT:**

- Parse spreadsheet contents.
- Use an LLM (none is needed here).
- Normalize, compare, or approve anything (Feature 2).
- Draft dealer emails (Feature 3) or answer sales questions (Feature 4).

Constraints for the whole app: Next.js + TypeScript, no database, no custom app login, no separate backend service (Next.js route handlers only).

## 2. Decisions

| Decision | Choice |
|---|---|
| Attachment types | `.xlsx` and `.csv` only (PDFs, images and anything else are ignored) |
| Output folder | `mock-data/new-price-lists/` (plural). Defined in one constant in `lib/config.ts` |
| Gmail scope | `gmail.readonly` only. Feature 3 will need a compose scope and a fresh consent |
| OAuth token storage | Local gitignored file `.data/google-tokens.json` (single-user local app) |
| Review step | **Pre-ticked review.** Scan lists every match with all new rows ticked. Nothing is saved until "Download selected" is clicked. Unticking a false match is optional |
| Manifest | `mock-data/new-price-lists/manifest.json` records where each file came from. It is the dedup index and gives Feature 2 sender, subject and date |
| UI library | shadcn/ui (`bunx --bun shadcn@latest init`) |
| Google client library | `googleapis` |

## 3. User flow

```
[Connect Gmail] → /api/auth/google → Google consent → /api/auth/google/callback → .data/google-tokens.json

[Scan Gmail] → GET /api/ingest/scan            (read-only, saves nothing)
   → Gmail search (query) → for each message: walk MIME parts
   → keep parts whose filename ends .xlsx / .csv
   → return candidates: sender, subject, date, filename, size, messageId, partId,
     and alreadyDownloaded (looked up in manifest)
   → UI table: new rows pre-ticked, already-downloaded rows unticked + disabled

[Download selected] → POST /api/ingest/download   body: [{ messageId, partId }, ...]
   → server RE-FETCHES each message, finds the part by partId, re-checks the extension
     (never trusts filenames or paths from the client)
   → download attachment → sanitize name → write file + manifest entry
   → return report (downloaded / skipped-duplicate / failed, per attachment)
```

### Stage 1: Connect Gmail (once)

1. User clicks **Connect Gmail**; the browser goes to `/api/auth/google`.
2. The server creates a random `state`, stores it in a short-lived httpOnly cookie, and redirects to Google's consent screen (`access_type=offline`, `prompt=consent`).
3. User approves read-only access. Google redirects to `/api/auth/google/callback` with a one-time code.
4. The server verifies the `state` cookie, exchanges the code for tokens, saves them to `.data/google-tokens.json`, and redirects to `/`, which now shows "Connected".

Later requests reuse the saved token. Refreshed tokens are persisted automatically. A **Disconnect** action (`POST /api/auth/google/disconnect`) deletes the token file.

### Stage 2: Scan Gmail (nothing saved)

1. User clicks **Scan Gmail**; the page calls `GET /api/ingest/scan`.
2. The server searches Gmail with the price-list query (section 4).
3. For each message it walks the MIME parts recursively and keeps only `.xlsx` and `.csv` attachments.
4. It checks `manifest.json` to mark attachments already downloaded.
5. The UI shows a table (sender, subject, date, filename, size). New rows are pre-ticked; already-downloaded rows are unticked and disabled.

### Stage 3: Download selected

1. User optionally unticks false matches and clicks **Download selected (N)**.
2. The page sends only `{ messageId, partId }` per ticked row to `POST /api/ingest/download`.
3. For each item the server re-fetches the message, locates the part, re-checks the extension, downloads it, sanitizes the filename, and skips or renames on duplicates and collisions (section 7).
4. It writes the raw file to `mock-data/new-price-lists/` and appends a manifest entry.
5. One failing attachment does not stop the others. The UI shows a per-attachment result: downloaded, skipped duplicate, or failed.

## 4. Price-list email detection (no LLM)

Gmail query, built in `lib/config.ts`:

```
has:attachment (filename:xlsx OR filename:csv) (subject:(price OR pricing OR "price list") OR filename:price) newer_than:90d
```

- Optionally AND-ed with a sender allowlist (`SENDER_ALLOWLIST`, empty = any sender).
- The extension is **re-checked in code**, because Gmail's `filename:` matching is loose and xlsx files often arrive with MIME type `application/octet-stream`.
- Only `.xlsx` and `.csv` are kept. In an email with `Price_List.xlsx`, `terms.pdf` and `logo.png`, only `Price_List.xlsx` is downloaded.
- `MAX_MESSAGES` caps how many emails one scan looks at.

| Email subject | Attachment | Shown in scan? |
|---|---|---|
| September Price List | `Seagate_Price_List.xlsx` | Yes |
| Updated Price List | `Samsung_Price_List.csv` | Yes |
| New Price List | `TPLink_Price_List.xlsx` | Yes |
| Meeting tomorrow | `meeting.pdf` | No |

## 5. Manifest format

`mock-data/new-price-lists/manifest.json` holds one entry per downloaded attachment:

```json
{
  "messageId": "18c2f...",
  "partId": "1",
  "savedAs": "Seagate_Price_List.xlsx",
  "originalName": "Seagate_Price_List.xlsx",
  "from": "Seagate Distributor <sales@seagate-dist.com>",
  "subject": "September Price List",
  "emailDate": "2026-09-03T09:12:00Z",
  "sha256": "ab12...",
  "downloadedAt": "2026-09-20T18:05:00Z"
}
```

What it is used for:

1. **Duplicate detection:** entries are keyed by `messageId + partId`. Re-scans mark them "already downloaded" and the download step skips them.
2. **Safe filename clashes:** `sha256` tells whether a same-named file is identical (skip) or different (save under a new name).
3. **Context for Feature 2:** sender, subject and date tell Feature 2 which brand a file belongs to and which list is newer, without calling Gmail again.

The raw spreadsheet files are never modified.

## 6. Planned file map

**Library code**

| Path | Purpose |
|---|---|
| `lib/config.ts` | Env reads and constants: `NEW_PRICE_LIST_DIR`, `TOKEN_FILE`, `ALLOWED_EXTENSIONS`, Gmail query, `MAX_MESSAGES`, optional `SENDER_ALLOWLIST` |
| `lib/google/oauth.ts` | OAuth client, auth URL, token load/save/clear, authorized client (persists refreshed tokens; maps `invalid_grant` to "reconnect") |
| `lib/gmail/price-list-emails.ts` | Search messages, recursive attachment extraction with extension filter, attachment download (base64url to Buffer, also handles inline `body.data`) |
| `lib/storage/new-price-lists.ts` | `sanitizeFilename()`, manifest read/write, `saveAttachment()` with dedup and collision handling |
| `lib/ingest.ts` | `scanPriceLists()` returns candidates; `downloadSelected(selection)` returns a report |
| `lib/types.ts` | `Candidate`, `Selection`, `ManifestEntry`, `IngestReport`, `IngestItem` |

**Routes (Next.js route handlers)**

| Path | Purpose |
|---|---|
| `app/api/auth/google/route.ts` | GET: start OAuth with `state` cookie |
| `app/api/auth/google/callback/route.ts` | GET: verify `state`, exchange code, save tokens, redirect to `/` |
| `app/api/auth/google/disconnect/route.ts` | POST: delete the token file |
| `app/api/ingest/scan/route.ts` | GET: scan and return candidates |
| `app/api/ingest/download/route.ts` | POST: download the selected attachments |

**UI**

| Path | Purpose |
|---|---|
| `app/page.tsx`, `app/price-updates/page.tsx` | Server components: connection status and the manifest of saved files |
| `app/_components/ScanDialog.tsx` | Client component: the scan-results dialog off the page header — candidate table with checkboxes, download, result summary |
| `app/_components/GmailSettings.tsx` | Client component on `/settings`: connect, disconnect, scopes and token location |
| `app/_components/PriceListsCard.tsx` | The files already saved |
| `components/ui/*`, `components.json`, `lib/utils.ts` | Generated by the shadcn CLI |

> Originally one `app/_components/IngestPanel.tsx` on a single page. When the app shell was built it
> was split into the three components above, following `ui-design.md`. No route handler or anything
> under `lib/` changed, and the tests were untouched.

**Config and housekeeping**

- `.env.example`: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` (default `http://localhost:3000/api/auth/google/callback`).
- `.gitignore`: add `/.data/`, `mock-data/new-price-lists/*` (keep `.gitkeep`), and `!.env.example`.
- `package.json`: add `googleapis`.
- `README.md`: Google Cloud setup steps and how to run Feature 1.

## 7. Edge cases and error handling

- **Re-running:** dedup by `messageId + partId`. Scan shows those rows as already downloaded; the download step skips them even if a stale client sends them.
- **Client input is untrusted:** the download route accepts only `{ messageId, partId }` and re-derives filename and metadata from Gmail. Gmail attachment IDs can change between fetches, so `partId` is used instead.
- **Same filename from two brands:** same content is skipped; different content is saved as `name__<msgId8>.ext`. Existing files are never overwritten.
- **Path traversal and odd names:** filenames are sanitized (`path.basename`, unsafe characters stripped) before writing.
- **Not connected, revoked or expired token:** API returns 401 `{ "error": "not_connected" }` and the UI shows a "Connect Gmail" alert. In Google's "Testing" consent mode, refresh tokens expire after 7 days.
- **Missing env vars:** a clear error that names the missing variable.
- **Empty scan or nothing selected:** the UI shows "No new price lists found" and the Download button is disabled at 0 selected.
- **OAuth CSRF:** `state` is kept in an httpOnly cookie and verified in the callback.
- **Trust model:** whoever can reach the server can trigger ingestion. This is fine for single-user local use and not suitable for public deployment.

## 8. Setup prerequisites (done by the user)

1. In Google Cloud Console, create a project and enable the **Gmail API**.
2. Configure the OAuth consent screen (External) and add your Gmail address as a **test user**.
3. Create an OAuth client of type **Web application** with redirect URI `http://localhost:3000/api/auth/google/callback`.
4. Copy the client ID and secret into `.env.local`:
   ```
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   GOOGLE_REDIRECT_URI=http://localhost:3000/api/auth/google/callback
   ```
5. Note: while the consent screen is in "Testing" mode, refresh tokens expire after 7 days, so you will need to reconnect weekly.

## 9. Implementation order

1. Run `bunx --bun shadcn@latest init`, then add `button card table checkbox badge alert`. Check the generated `components.json` and `app/globals.css`.
2. `bun add googleapis`; update `.gitignore`; add `.env.example`.
3. `lib/config.ts` and `lib/types.ts`.
4. `lib/google/oauth.ts` and the three `app/api/auth/google/*` routes.
5. `lib/gmail/price-list-emails.ts` and `lib/storage/new-price-lists.ts`.
6. `lib/ingest.ts` and the two `app/api/ingest/*` routes.
7. `app/page.tsx` and the UI components (originally one `IngestPanel.tsx`; see the note above).
8. README, then verification.

## 10. Verification and acceptance criteria

**Automated / local checks (no Google credentials needed):**

- `bun run lint`, `bunx tsc --noEmit` and `bun run build` pass.
- Helper checks with fixtures: attachment extraction on nested MIME (xlsx + pdf + png keeps only xlsx); `sanitizeFilename` on `../../x.xlsx` and `a:b*.csv`; dedup and collision logic against a temp directory.
- The app boots and routes respond (unauthenticated scan returns the "not connected" state).

**End-to-end (needs the user's Google credentials and consent):**

1. `bun dev` → Connect Gmail → consent → home page shows "Connected".
2. Send yourself 2–3 matching emails (xlsx/csv price lists) plus one "Meeting tomorrow" email with a PDF.
3. Scan Gmail: only the price-list `.xlsx`/`.csv` rows appear, all pre-ticked. The PDF email does not appear.
4. Untick one row and click Download selected: only the ticked files land in `mock-data/new-price-lists/`, with `manifest.json`.
5. Scan again: downloaded rows show as already downloaded; the unticked one is still selectable.
6. Disconnect: Scan returns the reconnect state.

**Acceptance criteria:**

- Raw `.xlsx`/`.csv` files from price-list emails are saved unmodified in `mock-data/new-price-lists/`.
- No non-price-list email and no non-xlsx/csv attachment is ever saved.
- Re-running never creates duplicates and never overwrites a different file.
- No parsing, LLM call, or price comparison exists anywhere in Feature 1.

## 11. Handoff to Feature 2

Feature 2 can rely on:

- `mock-data/new-price-lists/` containing raw `.xlsx` and `.csv` files, exactly as sent.
- `mock-data/new-price-lists/manifest.json` mapping each saved file (`savedAs`) to its sender, subject, email date and content hash.

Feature 2 starts from those files: parse, LLM normalization, compare with `mock-data/current-price-lists/`, and human approval.
