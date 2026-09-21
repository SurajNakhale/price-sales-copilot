# Feature 3 — Affected Dealers and a Gmail Draft

**Status:** Implemented (2026-09-21). Planned with the user on 2026-09-21. Verified live up to the draft itself:
affected dealers, a Gemini message and the permission redirect. Creating a real Gmail draft needs the user's consent
click and has not been run yet (§11).

## 1. Purpose and boundary

Feature 2 leaves an approved review (`.data/reviews/<fileId>.json`) with the IDs of the items that were applied to the
current price list. Feature 3 is steps 4 and 5 of that file's workflow: find the dealers who bought the repriced models
in the last 90 days, have the LLM write a short update, and save it as a **Gmail draft with those dealers in BCC**, so
they cannot see each other's addresses. The user reviews and sends the draft from Gmail.

**Feature 3 does:**

- Find the affected dealers from the applied price changes and the sales file (code only).
- Have Gemini write the words of a short update; code writes every number in it.
- Create one Gmail draft per approved price list: To is the connected account, Bcc is the dealers.
- Say whose addresses the dealers' are, so a test draft is recognisable as one.

**Feature 3 does not:**

- **Send anything.** No `messages.send` or `drafts.send` call exists in the code, and a test fails if one appears.
- Edit or delete a draft. The user may have changed it in Gmail.
- Cover new products (no purchase history), deactivated products or items the reviewer did not apply.
- Send Gemini any dealer name or address.

## 2. Decisions

| Decision | Choice |
|---|---|
| One draft or several (open decision 4) | One draft per approved price list, all its affected dealers in Bcc. A dealer who buys two brands gets two emails |
| The 90-day filter (open decision 7) | Proven with test data that includes old sales. The mock data is unchanged, so every existing figure stands |
| Dealer addresses that are placeholders | Warn, but allow. The draft is created whatever the addresses are (§5) |
| Who writes the numbers | Code. Gemini writes `subject`, `greeting`, `intro` and `closing`, and digits are allowed only inside the changed models' names |
| The Gmail permission | `gmail.compose`, requested only when the user first presses Create draft, together with `gmail.readonly`, and kept across reconnects with `include_granted_scopes` |
| To | The connected account's own address, from `users.getProfile` |
| Trust | The route takes only the file ID. The message is stored server-side and the recipients are recomputed when the draft is created |

## 3. Flow

```text
approved review (applied price-change items)
   ▼
④ Affected dealers      code only. Needs no key and no Gmail permission
   ▼
⑤ Write the message     Gemini, one request (or a standard message with no Gemini at all)
   │ code adds one line per change from the review
   ▼
   preview → Rewrite    another request
   ▼
   Create Gmail draft   To = you, Bcc = the dealers. Nothing is sent
   ▼
   Open in Gmail        the user reviews, edits and sends
```

## 4. Step 4 — who is affected

- **Input:** the review's `applied` item IDs that are `price-change` items, and only when the review is `approved`.
- **Window:** `date >= today − 90 days`, with today the latest invoice date: the same rule as the copilot's `last_days` and
  the analytics tests. Shown as dates.
- **Per dealer:** name, state, the repriced models they bought and how many units, last order date.
- **Recipients:** dealers joined to `dealers.json` by name. A dealer with no valid address, or missing from the list, is
  listed as skipped with the reason. Identical addresses collapse to one Bcc entry, and the screen says so. More than
  100 recipients is refused.
- **Left out, stated on screen:** applied new products, applied deactivations, and items the reviewer did not apply.
- On the mock data every sale is inside the window: Samsung's three sample changes affect 13 of 20 dealers, Seagate's 15,
  TP-Link's 14.

## 5. Dealer addresses

The app asks Gmail who the connected account is and compares each address with it, treating `you+dealer1@gmail.com`,
`Y.ou@gmail.com` and `you@googlemail.com` as `you@gmail.com` (Gmail ignores `+tags` and dots).

| The addresses are | The screen says |
|---|---|
| Aliases of the connected account | A plain note: every copy lands in your inbox, so it is safe to test. Never sent |
| The placeholder `yourname+dealerN@gmail.com` | ⚠ Test addresses detected: they use the placeholder `yourname`, which is not your account. Never sent. Run `bun run mock:dealer-emails <your Gmail address>` to use your own |
| Anything else (a real dealer) | A neutral note: these are outside your account; if you send the draft, these dealers receive it |
| Gmail not connected | "Connect Gmail to check these addresses against your account" |

`bun run mock:dealer-emails you@gmail.com` rewrites only each dealer's `email` to `you+dealerN@gmail.com`. The data check
(`mock:generate --check`) accepts any Gmail base with a `+dealerN` alias, still unique, and `mock:generate --force` is
not needed, which matters because it would reset the approvals.

## 6. Step 5 — the message and the draft

- **Gemini's answer:** `{ subject, greeting, intro, closing }`. Any digit outside the exact name of a changed model is
  rejected and retried once with the reason. A second failure shows a standard message, labelled as such. The user can
  also choose the standard message directly, for example when the free-tier quota is spent.
- **The body:** greeting, intro, one line per change, closing, `Regards,`. A line reads
  `T7 1TB: dealer price ₹7,000 → ₹7,500 (+7.1%), MRP ₹9,999 → ₹10,499`, with the MRP shown only when it changed and
  decreases shown as decreases. Plain text, UTF-8.
- **The draft:** an RFC 2822 message, base64url in `drafts.create`. The `Bcc` header is folded over lines, every address is
  validated, and anything containing a line break is refused, so a bad value cannot inject a header. The subject is
  RFC 2047 encoded when it is not ASCII.
- **After creating:** the record (draft and message IDs, time, recipient count) and an Open in Gmail link. Creating
  another draft asks for confirmation.

## 7. The Gmail permission

`gmail.compose` is described by Google as "Manage drafts and send emails" and is classified Restricted; no narrower
permission creates drafts. So "never sends" is enforced by this code and its test, not by the permission.

Connect stays read-only. **Allow Gmail drafts** (`GET /api/auth/google?drafts=1&returnTo=/price-updates/<id>`) asks for
both scopes with `include_granted_scopes`. The return path must match `^/price-updates/[0-9a-f]{12}$`, so it cannot become an
open redirect. The callback checks the returned `scope` contains compose, because Google lets the user untick it. A
missing permission is a `MissingScopeError` (403); the panel then shows the Allow button. Settings lists the permissions
actually granted.

## 8. Data shapes

```jsonc
// .data/drafts/<fileId>.json  (gitignored working state)
{
  "fileId": "9417520f9a4a",
  "message": { "subject": "Price Update – Samsung T7 1TB", "greeting": "Hello,", "intro": "…", "closing": "…",
               "source": "model", "model": "gemini-3.5-flash-lite", "note": "only for a standard message",
               "generatedAt": "2026-09-21T12:20:00.000Z" },
  "drafts": [ { "draftId": "r-123", "messageId": "18f…", "createdAt": "…", "to": "you@gmail.com",
                "recipients": 13, "addresses": 13, "subject": "…" } ]
}
```

## 9. Routes and modules

| Route | Service | Errors |
|---|---|---|
| `POST /api/prices/[id]/draft/message` | `prepareDraftMessage` (`lib/prepare-draft.ts`), body `{ template?: true }` | 404 unknown file · 409 not approved or no price change applied · 503 Gemini unavailable · 500 missing key |
| `POST /api/prices/[id]/draft` | `createGmailDraft` (`lib/create-draft.ts`), body `{ another?: true }` | 409 no message yet, nobody to notify, or a draft exists · 403 permission missing · 401 not connected |

| Module | Job | Pure |
|---|---|---|
| `lib/affected.ts` | Affected dealers, address checks and classification | yes |
| `lib/drafts/message.ts` | Prose check, standard message, the email text | yes |
| `lib/drafts/wording.ts` | What the page says about addresses and coverage | yes |
| `lib/drafts/mime.ts` | The RFC 2822 message and its encoding | yes |
| `lib/drafts/deps.ts` | The real readers and writers the services default to | no |
| `lib/gmail/drafts.ts` | Connected address, `drafts.create`, the Open in Gmail link | no |
| `lib/storage/drafts.ts` | `.data/drafts/<fileId>.json` | no |
| `lib/llm/drafts.ts`, `prompts/dealer-email.ts` | The `DraftPort` over Gemini | no |

## 10. UI

`ui-design.md` §2.6, in `AffectedDealers` and `DraftPanel` on `/price-updates/[id]`, below the review once it is approved.
The stepper unlocks steps 4 and 5.

## 11. Verification

- `bun run test` (no network, no key): affected dealers recomputed by brute force (13, 15, 14); the window edge (a line
  exactly 90 days back is in, 91 is out, and a dealer with only older purchases is dropped); address handling; the
  standard and model messages; the MIME message parsed back; the service with a fake Gmail; the OAuth pieces; the script;
  and a scan proving no send call exists.
- `bun run lint`, `bunx tsc --noEmit`, `bun run build`.
- Live: one message from Gemini, then the consent and the draft in Gmail, with the user (§7 needs an interactive click).

### Live results, 2026-09-21

- **The approved Samsung list** (3 price changes applied, plus a new product that is correctly not covered): the page
  showed 13 of 20 dealers between 20 Jun and 18 Sep 2026, the placeholder warning, and the envelope with To = the
  connected account and the 13-dealer Bcc. Headless Chrome, no browser errors.
- **Gemini** (`gemini-3.5-flash-lite`, one request): "Price Update – Samsung", "Dear partner,", an intro saying prices
  were raised on selected models, a closing. No digit anywhere, so the check passed first time.
- **Routes:** a bad body gave 400, an unknown file 404, and creating a draft without the permission 403
  `gmail_scope_missing`. The permission redirect asked for `gmail.readonly` + `gmail.compose` with
  `include_granted_scopes`; plain Connect asked for read-only only; a return path of `https://evil.com` was dropped;
  a declined consent and a forged callback came back to the workflow page with the reason.
- **Found by the build, not the tests:** the draft panel pulled server-only code into the browser. Fixed, and a test
  now follows the imports of the browser components.
- **Not run:** the consent click and a real draft. Unverified until then: that Gmail keeps the Bcc on an
  API-created draft, and the Open in Gmail link format.
