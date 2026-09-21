# Price & Sales Copilot

Reads brand price lists from Gmail, shows what changed, drafts an email to affected dealers, and
answers sales questions. Built feature by feature — see [`context/`](context/) for the project
overview, architecture, mock data and per-feature specs.

**Features 1 (Gmail price list ingestion), 2 (normalise, compare, approve) and 4 (Sales Copilot) are
implemented.** Feature 3 (dealer email drafts) is specified but not built.

---

## Quick start

```bash
bun install
cp .env.example .env.local     # then fill in the Google credentials and the Gemini key (see below)
bun dev                        # http://localhost:3000
```

Without Google credentials the app still runs; Connect Gmail will report the missing variable.
Without `GEMINI_API_KEY`, Analyse reports the missing variable and the Sales Copilot shows a setup
notice; nothing else is affected.

| Command | What it does |
|---|---|
| `bun dev` | Run the app locally |
| `bun run build` | Production build |
| `bun test` | Unit tests for the deterministic parts (no network, no credentials) |
| `bun run lint` | ESLint |
| `bun run mock:generate --check` | Validate the mock datasets |

---

## Setting up the Gmail API, step by step

This is a one-time setup in the [Google Cloud Console](https://console.cloud.google.com/). It takes
about 10 minutes. You need a Google account; a personal Gmail account is fine.

### 1. Create a project

1. Open <https://console.cloud.google.com/>.
2. Click the project dropdown in the top bar, then **New project**.
3. Name it (for example `price-sales-copilot`) and click **Create**.
4. Make sure the new project is selected in the top bar before continuing.

### 2. Enable the Gmail API

1. Go to **APIs & Services → Library** (or <https://console.cloud.google.com/apis/library>).
2. Search for **Gmail API** and open it.
3. Click **Enable**.

### 3. Configure the OAuth consent screen

1. Go to **APIs & Services → OAuth consent screen**.
2. Choose **External** and click **Create**. (**Internal** only exists for Google Workspace
   organisations; with a personal account you will only see External.)
3. Fill in the required fields: app name, user support email, developer contact email. Everything
   else can stay empty. Click **Save and continue**.
4. On the **Scopes** step you can click **Save and continue** without adding anything — this app
   requests its scope at sign-in time.
5. On the **Test users** step, click **Add users** and enter **the Gmail address you will read price
   lists from**. This is required: while the app is unverified, only listed test users can sign in.
6. Click **Save and continue**, then **Back to dashboard**. Leave the publishing status as
   **Testing**.

### 4. Create the OAuth client

1. Go to **APIs & Services → Credentials**.
2. Click **Create credentials → OAuth client ID**.
3. Application type: **Web application**.
4. Give it a name (for example `price-sales-copilot local`).
5. Under **Authorized redirect URIs**, click **Add URI** and paste exactly:

   ```text
   http://localhost:3000/api/auth/google/callback
   ```

   It must match character for character — no trailing slash, `http` not `https`.
6. Click **Create**. A dialog shows your **Client ID** and **Client secret**; keep it open for the
   next step (you can also copy them later from the credentials list).

### 5. Put the credentials in `.env.local`

```bash
cp .env.example .env.local
```

Then edit `.env.local`:

```bash
GOOGLE_CLIENT_ID=<the client ID>
GOOGLE_CLIENT_SECRET=<the client secret>
GOOGLE_REDIRECT_URI=http://localhost:3000/api/auth/google/callback
```

`.env.local` is gitignored, so the secret stays out of version control. Restart `bun dev` after
editing it — environment variables are read at startup.

### 6. Connect the app

1. Run `bun dev` and open <http://localhost:3000>.
2. Click **Connect Gmail**.
3. Choose the Google account you added as a test user.
4. You will see **"Google hasn't verified this app"**. That is expected for an unverified app in
   Testing mode: click **Advanced**, then **Continue to &lt;app name&gt; (unsafe)**.
5. Approve the request to **view your email messages and settings** (read-only).
6. You land back on the app, which now shows **Connected**.

The tokens are written to `.data/google-tokens.json` (gitignored). **Disconnect** deletes that file.

> **Testing mode expires refresh tokens after 7 days.** When that happens, scanning reports that
> access expired — click Connect Gmail again. To remove the app's access entirely, use
> <https://myaccount.google.com/permissions>.

### 7. Send yourself something to find

The scan looks for emails from the last 90 days that have an `.xlsx` or `.csv` attachment and
"price" in the subject or the filename. To try it, email yourself:

- **Subject:** `September Price List` — **attach** a `.xlsx` or `.csv` file
- **Subject:** `Meeting tomorrow` — attach a `.pdf` (this one should *not* show up)

Then click **Scan Gmail**, check the list, and click **Download selected**.

Prefer ready-made files? `bun run mock:supplier-files` writes sample price lists (`.csv` and `.xlsx`, plus a
`.txt` and an unrelated spreadsheet that should be ignored) to `mock-data/sample-supplier-files/` and prints which
subject line to send each with. Afterwards, `bun run mock:supplier-files --check-downloads` compares what the app
saved with what you sent, byte for byte. The full procedure is in
[`context/features/feature-1-gmail-price-list-ingestion.md`](context/features/feature-1-gmail-price-list-ingestion.md) §10.

---

## What Feature 1 does

```text
Connect Gmail (read-only OAuth)
   ▼
Scan Gmail            finds price-list emails, keeps only .xlsx and .csv attachments,
   │                  marks the ones already downloaded. Saves nothing.
   ▼
Review                new attachments are pre-ticked; untick anything that is not a price list
   ▼
Download selected     re-fetches each attachment from Gmail and writes the raw file
   ▼
mock-data/new-price-lists/    raw files + manifest.json (sender, subject, date, checksum)
```

- Only `.xlsx` and `.csv` are ever saved; PDFs and images in the same email are ignored.
- Files are never modified, never overwritten, and re-running never creates duplicates.
- No LLM is involved in Feature 1.
- Downloaded price lists are gitignored — real supplier pricing stays out of the repository.

The Gmail search, the allowed extensions and the message cap live in [`lib/config.ts`](lib/config.ts).
You can narrow the search to specific senders with `SENDER_ALLOWLIST` in `.env.local`.

## What Feature 2 does

```text
Analyse (a button, per file)
   ▼
LLM: column mapping    Gemini sees the first 15 rows and says which column is model, category,
   │                   dealer price and MRP. It never outputs a price.
   ▼
Normalise (code)       every row is read and each price copied from its cell → .data/normalized/<id>.json
   ▼
Match (code, then LLM) matching key first; renamed models go to Gemini, and the app checks every answer
   ▼
Compare (code)         price changes, new products, missing products → .data/reviews/<id>.json
   ▼
Review & approve       you tick what to apply; missing products are kept or deactivated, never deleted
   ▼
current-price-list.json   written once, atomically, with only what you approved
```

Put a Gemini API key in `.env.local` as `GEMINI_API_KEY` (from <https://aistudio.google.com/apikey>) and
restart `bun dev`. It is a separate credential from the Gmail OAuth client. **Use a paid-tier key before
analysing real supplier price lists**: on the free tier Google may use the content to improve its products.
The mock sample files are fine on the free tier.

`bun run mock:generate --force` resets the current price list after trying approvals. The full spec is in
[`context/features/feature-2-normalise-compare-approve.md`](context/features/feature-2-normalise-compare-approve.md).

## What Feature 4 does

Open **Sales Copilot** and ask in plain English: "Which dealer bought the most Samsung products?", "Compare August
with July", "Which dealers have not bought Samsung?".

```text
your question
   ▼
Gemini chooses a tool     query_sales, compare_periods or lookup_products, and their filters, period and grouping
   ▼
the app runs it           filters, adds up and compares the mock data; every number comes from here
   ▼
Gemini words the answer   one sentence from the results, or another query first (at most 4 rounds)
   ▼
the app checks it         every number in the sentence must be in the results, or a plain sentence replaces it
   ▼
you see                   the steps used, the result table, the sentence, and Copy / Download CSV
```

It uses the same `GEMINI_API_KEY` and needs no Gmail connection. Gemini sees your question and the query results,
never the raw files or any dealer email address. "Today" is the last invoice date in the data (18 Sep 2026), so
"last month" means August 2026. It cannot answer price-history questions yet: no change history is recorded.

`bun run copilot:eval` asks Gemini about 16 real questions and checks the figures the chosen tools returned against
values computed independently from the files. It needs the key and makes two or three Gemini calls per question. The
full spec is in [`context/features/feature-4-sales-copilot.md`](context/features/feature-4-sales-copilot.md).

## Using the Gemini free tier

The free tier is enough for this app if you spend requests deliberately.

**How the limits work.** Each model has its own daily allowance, counted **per Google Cloud project** (every key in a
project shares it). It resets at **midnight Pacific time: 12:30 pm IST** (1:30 pm IST from November). Google no longer
publishes the numbers; see yours at <https://aistudio.google.com/rate-limit>. On 2026-09-21 this project's key allowed
`gemini-3.8-flash` **20 requests a day**; `gemini-3.5-flash-lite` has a separate allowance.

**What things cost.**

| Action | Gemini requests |
|---|---|
| One copilot question | usually 2 (choose the query, write the sentence); 1 in economy mode; 0 if asked before |
| Analyse one price list | 1–3 (column mapping, a retry if rejected, matching renamed rows) |
| `bun run copilot:eval`, all 16 questions | about 30 |
| `bun run test` | 0: every test uses a fake model |

**How to make it last.**

1. **Use Flash-Lite for everyday work.** It passed all 16 copilot eval questions. Keep Flash for Analyse on messy
   files, and give each feature its own model so they don't share one allowance:
   ```bash
   ANALYSE_MODEL=gemini-3.8-flash
   COPILOT_MODEL=gemini-3.5-flash-lite
   ```
2. **Repeat questions are free.** The copilot remembers answers until the server restarts, so a repeated question or
   suggestion costs nothing ("cached, no Gemini request" under the answer). Changing the data files starts afresh.
3. **Economy mode** halves the copilot's cost: `COPILOT_SENTENCE=template` has the app write the sentence from the
   results instead of asking Gemini a second time. The wording is plainer, and a question that needs two chained
   queries gets only the first.
4. **Test without the API.** `bun run test` covers the logic for free. Go live only to check the model itself, and run
   eval subsets: `bun run copilot:eval 3 9` costs about 4 requests.
5. **Plan live sessions for after 12:30 pm IST**, and check the AI Studio page before a demo.
6. **A 503 "used up its daily request limit" will not clear by retrying.** Switch model, or wait for the reset.
7. **Don't create extra projects to multiply the quota**: that breaks Google's terms and risks the key. If you need
   more, enable billing on the project for a paid key, which also stops Google using your prompts.

The free tier lets Google use prompts to improve its products, which is fine for the mock data. Use a paid key before
analysing real supplier price lists.

## Troubleshooting

| What you see | Cause and fix |
|---|---|
| `Error 400: redirect_uri_mismatch` | The redirect URI in Google Cloud does not exactly match `GOOGLE_REDIRECT_URI`. Compare them character by character. |
| `Error 403: access_denied` | The Google account you signed in with is not on the **Test users** list, or you dismissed the consent screen. |
| "Missing environment variable GOOGLE_CLIENT_ID" | `.env.local` is missing or the dev server was not restarted after editing it. |
| "Gmail access has expired or was revoked" | Normal after 7 days in Testing mode. Click Connect Gmail again. |
| Scan finds nothing | The query needs an `.xlsx`/`.csv` attachment, "price" in the subject or filename, and an email newer than 90 days. |
| "Missing environment variable GEMINI_API_KEY" | Add the key to `.env.local` and restart `bun dev`, then press Retry. |
| "The current price list changed after this file was analysed" | Another file's approval changed the same products first. Press Re-analyse, then approve. |
| Copilot: "Gemini is rate-limiting requests right now" | A short-term limit. Wait a minute and ask again. |
| "The Gemini key has used up its daily request limit" | The free tier's daily allowance for that model is spent. Set another model (`COPILOT_MODEL`, `ANALYSE_MODEL` or `LLM_MODEL`) or wait until 12:30 pm IST. See "Using the Gemini free tier". |

## Security notes

This is a local, single-user app: it has no login of its own, and anyone who can reach the server
can trigger ingestion. Run it on `localhost`. `.env.local`, `.data/` and the downloaded price lists
are all gitignored.
