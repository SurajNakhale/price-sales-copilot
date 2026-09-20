# Price & Sales Copilot

Reads brand price lists from Gmail, shows what changed, drafts an email to affected dealers, and
answers sales questions. Built feature by feature — see [`context/`](context/) for the project
overview, architecture, mock data and per-feature specs.

**Feature 1 (Gmail price list ingestion) is implemented.** Features 2 to 4 are specified but not built.

---

## Quick start

```bash
bun install
cp .env.example .env.local     # then fill in the Google credentials (see below)
bun dev                        # http://localhost:3000
```

Without Google credentials the app still runs; Connect Gmail will report the missing variable.

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

## Troubleshooting

| What you see | Cause and fix |
|---|---|
| `Error 400: redirect_uri_mismatch` | The redirect URI in Google Cloud does not exactly match `GOOGLE_REDIRECT_URI`. Compare them character by character. |
| `Error 403: access_denied` | The Google account you signed in with is not on the **Test users** list, or you dismissed the consent screen. |
| "Missing environment variable GOOGLE_CLIENT_ID" | `.env.local` is missing or the dev server was not restarted after editing it. |
| "Gmail access has expired or was revoked" | Normal after 7 days in Testing mode. Click Connect Gmail again. |
| Scan finds nothing | The query needs an `.xlsx`/`.csv` attachment, "price" in the subject or filename, and an email newer than 90 days. |

## Security notes

This is a local, single-user app: it has no login of its own, and anyone who can reach the server
can trigger ingestion. Run it on `localhost`. `.env.local`, `.data/` and the downloaded price lists
are all gitignored.
