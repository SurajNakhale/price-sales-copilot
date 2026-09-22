# UI Design

**Status:** Built (2026-09-21). The shell, dashboard, data views, Settings, the Feature 1
scan dialog and the Price Updates workflow up to step 3 (Feature 2) exist, and were checked in
headless Chrome at 1440 wide. The Sales Copilot (Feature 4) is built (§2.7). Steps 4–5 (Feature 3)
are built (§2.6) and were checked the same way. Every screen is now built. See `current-state.md`.
**Artboards:** https://claude.ai/artifact/Lkg3pQwdwu91aycaZ3KeTL (private; share it from the page's Share menu if someone else needs it)

This is the plan for the whole interface. It follows `project-overview.md` (what the app does),
`architecture.md` (how it is put together) and `mock-data.md` (where every number comes from).

---

## 1. Information architecture

A sidebar, because the app is two workflows and a set of data views, not one page.

```text
┌───────────────────┬─────────────────────────────────────────────────┐
│ Price & Sales     │  Dashboard                    ● Gmail Connected │
│ Copilot           │                                  [Scan Gmail]   │
│                   ├─────────────────────────────────────────────────┤
│ ▸ Dashboard       │                                                 │
│ ▸ Price Updates ⑨ │   (page content)                                │
│ ▸ Sales Copilot   │                                                 │
│                   │                                                 │
│ DATA              │                                                 │
│ ▸ Products    30  │                                                 │
│ ▸ Dealers     20  │                                                 │
│ ▸ Sales      200  │                                                 │
│                   │                                                 │
│ ● Gmail connected │                                                 │
│   Settings        │                                                 │
└───────────────────┴─────────────────────────────────────────────────┘
```

| Route | Screen | Feature |
|---|---|---|
| `/` | Dashboard — KPIs, trend, brand split, recent price lists | reads all |
| `/price-updates` | Every price list received, with status | 1 → 2 → 3 |
| `/price-updates/[id]` | The 5-step workflow for one file | 1 → 2 → 3 |
| `/copilot` | Question box and answers | 4 |
| `/products`, `/dealers`, `/sales` | Read-only data views | — |
| `/settings` | Gmail connection, disconnect, sender allowlist | 1 |

**Sidebar rules.** The Price Updates badge counts items waiting on a person, and disappears at zero.
Data rows carry a plain count. Gmail status and Settings sit in the footer — the `•••` menu from the brief is
gone, since Disconnect belongs in Settings. Before Gmail is connected, Price Updates is visible but inert,
so the shape of the app is legible from the first screen. Sales Copilot works regardless: it needs Gemini, not Gmail.

### Workflow 1 — Price Updates (Features 1 → 2 → 3)

One file moves through five steps, shown as a stepper across the top of the workflow page:

```text
① Received  →  ② Normalise  →  ③ Review & approve  →  ④ Affected dealers  →  ⑤ Draft email
   Gmail         LLM            you decide              sales, last 90 days    LLM + Gmail draft
```

Steps 3 and 5 belong to a person. Each step names who acts, so it is never unclear whether the app or the
model did something. Steps 4 and 5 unlock only after an approval.

### Workflow 2 — Sales Copilot (Feature 4)

A full page. The dashboard keeps a floating launcher that opens the same thing in a side panel for a quick
question.

---

## 2. Screens

### 2.1 Dashboard (`/`)

Top to bottom: **what is happening** → **how are we selling** → **what arrived from suppliers**.

**KPI row — four tiles.**

| Tile | Value | Sub-line | Source |
|---|---|---|---|
| Total revenue | ₹43.9L | 66 invoices · 2 Jul – 18 Sep 2026 | Σ `quantity × unitPrice` |
| Units sold | 910 | 28 of 30 products sold | Σ `quantity` |
| Price changes | 5 | in 2 analysed files · 5 of the 9 below | comparison results |
| **Needs review** | 9 | 5 price · 2 new · 2 missing — review | items awaiting a decision |

The fourth tile is the only one with colour (amber ground, amber border): it is the one that asks for
something. Its sub-line breaks the number down, which is what stops it reading as a duplicate of tile 3.

**Charts.** Sales trend (2/3 width) and Sales by brand (1/3). Both name their measure and share one
Revenue/Units toggle. Section 4 covers the chart rules.

**New price lists.** The three most recent files, each with brand, filename, received time, change count and
status, and a single action per row. "View all" goes to `/price-updates`. The brief's Refresh is gone, since
Scan Gmail in the header does that job.

**Copilot launcher.** Bottom right, opens the copilot panel. It never covers the price-list table's actions.

### 2.2 Dashboard — first run

The state you will demo from, so it is designed, not left to fall out of empty data.

- A connect card at the top: what read-only access means, what the app looks for, and that you choose what
  gets downloaded.
- Revenue and Units still show real numbers at reduced emphasis — they come from the sales file and need no
  Gmail. Price changes and Needs review show **—** on a dashed border, with "Needs a price list from Gmail".
- The trend and brand charts render greyed, because the data exists.
- The price-list section becomes an empty state, not an empty table.

**Rule:** a number that cannot exist yet shows **—**, never 0. Zero is a fact; — is an absence.

### 2.3 Scan results dialog (Feature 1)

Opens from Scan Gmail. This is the step the original brief skipped, and it already exists in code.

- One row per `.xlsx`/`.csv` attachment: checkbox, file, from, subject, size.
- New rows arrive ticked. Rows already downloaded are unticked, disabled, and badged "already downloaded".
- Footer states the rule — only `.xlsx` and `.csv` are listed — and the button counts: **Download selected (3)**.
- Nothing is written until that button is pressed.

### 2.4 Price Updates list (`/price-updates`)

The stepper legend, then every file received with brand, filename, received time, changes and status.
The change count is broken down inline ("3 price · 1 new · 1 missing") so the number means something.

As built: the filename links to the workflow page, and the last column holds the row's one action —
**Analyse**, **Review** (filled, the only primary button in the table), **View** or **Retry**. The
dashboard's "New price lists" card is the same component, limited to five rows.

**Stepper labels as built** (`WorkflowStepper`), naming who acts in each step. Step 2 reads
"LLM maps · app copies" rather than just "LLM", because the model only names the columns and the app
copies every price. Steps 4–5 show a lock and "After approval" until the file is approved. Step 1 has its
own card on the workflow page (§2.4a).

### 2.4a Workflow step 1 — The file as received

The downloaded `.csv` or `.xlsx` exactly as Feature 1 saved it, so the reviewer can see what the supplier
sent. It is a card on the workflow page, directly under the stepper, not a drawer (decision 2), and it stays
there at every step. It is **collapsed by default**, so the review below stays in view. It is not on the Price
Updates list, where each row keeps its one action (§2.4).

```text
┌ The file as received ─────────────────────────── [⤓ Download original] [⌄ Show file] ┐
│ Step 1 · Gmail · saved unchanged in mock-data/new-price-lists/                       │
│ CSV · 11 rows · 4 columns · 330 B                                                    │
│                                                                                      │
│ (Show file)                                                                          │
│ The analysis read this sheet. Row 1 is the header, and the labels under the letters   │
│ show the columns the LLM mapped. The app copied each price from its cell.            │
│       A            B                     C                  D                        │
│       (Model)      (Category)     (Dealer price)          (MRP)                      │
│   1   Model        Type        Dealer Price (INR)      MRP (INR)    ← plane ground    │
│   2   T7 1TB       SSD                       7500          10499                     │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

As built (`ReceivedFileCard`):

- **Header:** card title, a description beginning "Step 1 · Gmail", and two outline `sm` buttons. **Download
  original** is a link (`nativeButton={false}`, §6) to `GET /api/prices/[id]/file`, which returns the saved bytes
  untouched as an attachment. **Show file** / **Hide file** toggles the table.
- **Summary line** (caption): the type, then rows, columns and size; for a workbook, the sheet name, or the number
  of sheets with content. Sizes are formatted as in the scan dialog (`formatSize`).
- **The table:** column letters A, B, C… in the label style and row numbers in a muted gutter, like a spreadsheet.
  Cells are shown exactly as stored, with no ₹ formatting, because this is the raw file. A column whose filled
  cells are mostly figures aligns right with `tabular-nums`, as every other number in the app does. A csv's
  "7500" is text but counts as a figure. Long cells are cut at 320px, with the full text on hover. The table's own
  container scrolls both ways inside a 480px height, so the letters stay in view.
- **Once analysed**, from the stored column mapping, with no colour, since colour is kept for data and status (§5):
  - The header row gets the plane ground.
  - Each mapped column gets a neutral outline badge under its letter: Model, Category, Dealer price or MRP.
  - A row the analysis skipped shows the word "skipped" in the gutter, with the reason in a tooltip.
  - A line above the table repeats the §2.5 point that the LLM mapped the columns and the app copied the prices.
- **Workbooks** with more than one sheet with content get `Tabs`, one per sheet. The sheet the analysis read says
  "used for analysis" in words and opens first.
- **Limits:** the first 500 rows of a sheet, then "Showing 500 of 1,832 rows · download the original to see all".

### 2.5 Workflow step 3 — Review & approve

The heart of the app.

- **Header:** breadcrumb, file name, status, received time and sender.
- **Stepper:** steps 1–2 done, 3 current, 4–5 ahead. The step 1 card (§2.4a) sits between the stepper and the review.
- **Summary strip:** rows in file, changes, unchanged — plus the sentence that matters:
  *prices are copied from the file's cells by the app; the LLM only mapped this supplier's column names.*
- **Tabs:** Price changes (3) · New products (1) · Missing products (1).
- **Price changes table:** checkbox, product (with how it was matched — the T7 1TB row shows the supplier
  called it "Portable SSD T7 1TB"), Product ID, dealer price old → new, MRP old → new, and a % delta.
- **New products:** the generated Product ID is shown before approval, e.g. `SAM-1578F`, with "Generated from
  brand + model, like every other ID".
- **Missing products:** a Keep / Deactivate choice, defaulting to **Keep**, with the last-sold date and unit
  count as evidence. The copy says plainly that nothing is deleted — Keep changes nothing, Deactivate marks
  the product `status: "discontinued"` so it leaves the catalogue while its sales history still resolves.
- **Footer:** what is selected, then one commit — **Approve 4 changes**. Disabled at zero.

**Selection defaults.** Scan results arrive **ticked** (downloading a file is cheap and reversible — delete it).
Approvals arrive **unticked** (writing a price is neither). That asymmetry is deliberate.

**One commit, not two.** The brief had a per-row `[Approve]` button *and* a footer `[Approve Selected]`, which
leaves it ambiguous whether the row button writes immediately. Checkboxes plus one commit matches the rule that
nothing is written until you approve, and makes a partial approval ("these three, not that one") the normal case.

**As built (Feature 2).** Details the build added:

- **Step 2 comes first.** Before analysis, the page shows a card with an explicit **Analyse** button. The card says
  what goes to Gemini (the first 15 rows, the filename and the sender) and that the LLM never types a number.
- **Header.** The file name is the title. The sub-line reads "From Samsung India · received 20 Sep 2026 · Samsung ·
  sheet …", and the status sits on the right. A ghost "‹ Price Updates" link above the stepper does the job of the
  breadcrumb.
- **Summary strip.** Ends with **Re-analyse** (outline, small). It is also how an out-of-date review is refreshed.
- **Match note.** Sits under the model: *Supplier wrote "Portable SSD T7 1TB" · matched by the LLM, checked by the
  app*, or "· matched by name" when the matching key found it. Nothing is shown when the names are identical.
- **Change column.** The dealer-price delta. When only the MRP moved, the pill is prefixed "MRP".
- **Keep / Deactivate.** A two-option control styled like the tab list, with the chosen option raised on a muted
  track. Plain ghost buttons were too faint to tell apart.
- **Footer.** Reads "Nothing selected yet" and a disabled **Approve changes** at zero, then "1 price change · 1 new
  product · 1 deactivation selected" and **Approve 3 changes**. Selections survive switching tabs.
- **Skipped rows.** Rows the app could not use are listed in an alert, with row number and reason, above the tabs.
- **Out of date.** When another approval changed a product this file also changes, a destructive alert names each
  item ("T7 1TB has been repriced since this file was analysed.") and offers **Re-analyse**. Selection and Approve
  are disabled until then.
- **After approval.** An alert reads "Approved 21 Sep 2026: 3 of 5 applied", with what that did in product terms.
  The tables turn read-only: the checkbox column becomes **Applied** / **Not applied**, and the decision column
  **Deactivated** / **Kept**.

### 2.6 Workflow steps 4–5 — Affected dealers & draft email

- **Success banner:** what the approval actually did, in product terms.
- **Affected dealers:** dealer, state, which repriced models they bought, units, last order date, with the
  window stated — "between 20 Jun and 18 Sep 2026 (the last 90 days)".
- **Draft panel:** To *me*; Bcc a single **13 dealers** pill with "hidden from each other"; subject; the
  LLM-written body with the price table; then **Create Gmail draft** and a line saying nothing is sent.
- A **Rewrite** button, because the first draft will not always be right.

The LLM is given the changed products and prices only — never dealer names or addresses. The message is
therefore general, and the app does the targeting.

**As built** (`AffectedDealers`, `DraftPanel`, `AddressNote`), below the approved review:

- **Step 4** lists every affected dealer, biggest buyers first: a ✓ for a dealer who will be in the Bcc, or a
  "no address" badge; state; the repriced models bought with units; total units; last order. Footnotes give the
  Bcc address count (and say so when dealers share one), any skipped dealer and why, and what the approval did
  that is not covered (new products, deactivations, items not approved).
- **Step 5** shows the envelope: To is the connected account, Bcc the **13 dealers · hidden from each other** pill
  with the address count, then the subject and the full body as it will be drafted. A line under the body says
  who wrote the words (Gemini and its model, or the standard message) and that every price came from the review.
- **Write message / Rewrite** asks Gemini; **Use the standard message (no Gemini)** works without a key or quota.
- **Allow Gmail drafts** appears until the permission is granted, with Google's own wording of it and the line
  that the app only ever saves. After consent the page shows granted, denied (the box was unticked) or the error.
- **Create Gmail draft**, then a "Draft created" note with **Open in Gmail**. **Create another draft** asks first.
- **The address note** sits in step 5, where you act: your own aliases get a plain note; the `yourname`
  placeholder gets the one warning, with the `mock:dealer-emails` command; real dealer addresses get a neutral
  note. It moves to step 4 only when no dealer has an address, so there is no step 5.
- The stepper unlocks steps 4–5 on approval, and ticks step 5 once a draft exists.

### 2.7 Sales Copilot (`/copilot`)

Every answer has four parts, in this order:

1. **Steps used to answer** — a collapsible block, open by default, listing the plan in plain sentences
   ("Keep lines whose product has brand = Samsung — 10 of your 30 products, 55 lines").
2. **The rows** — a small table.
3. **The sentence** — which may only restate the computed numbers.
4. **Copy table / Download CSV**, plus the standing line: every number was computed from your files.

Suggested questions sit above the thread. The input is pinned at the bottom. A pending question shows
"Working out the steps…", not a spinner alone.

**As built** (`CopilotChat`, `CopilotAnswer`):

- **Steps** is a native `<details open>`, one entry per tool call. Each opens with a "Read as" line (metric ·
  grouping · products · dealers · period, for example "this quarter (calendar Q3 2026)"), then lists the sentences
  code wrote from the arguments and the result ("Kept lines where brand is Samsung: 65 lines, 46 invoices, 10 products, 16 dealers"), and
  a closed "Arguments the model sent" block with the raw JSON. A call the app rejected is badged **rejected** with the
  reason; the model was told and may have corrected itself in the next step.
- **Tables**: one per successful call, titled in words ("Sales where brand is Samsung, 2 Jul 2026 – 18 Sep 2026, by
  dealer"), with footnotes for totals, "showing 5 of 16", groups with no sales, and caveats such as a partial month.
- **The sentence** is followed by where it came from: written by Gemini and checked, written by the app from the
  results (with the reason when the model's own sentence failed the number check), or "no query was run".
- **Copy table** copies the last table as tab-separated text, so it pastes into a spreadsheet as cells; **Download
  CSV** saves it. A meta line gives the model, rounds, queries and time.
- A line under the input says what goes to Gemini: the question and the query results, never dealer emails or the
  raw files. The thread is not stored; reloading starts a new one. Follow-ups carry the last 3 answered pairs.
- The copilot needs Gemini, not Gmail. Without `GEMINI_API_KEY` the page shows a setup notice and the input is
  disabled. The dashboard's floating button is a link to this page, not a side panel.
- **Price changes** ("Which models got cheaper in the new lists?") come back as a table: model, brand, dealer price old
  → new, the change with an arrow (↓ 3.4%, or "MRP ↑ 3.5%" when only the MRP moved), MRP, the list and its approval
  date, plus units sold and revenue when the question asks about sales. A footnote names lists still waiting for review,
  which are not counted.
- **A query that finds nothing** shows its title and "Nothing matches." in place of the table, for every tool, rather
  than column headings with nothing under them.
- **A vague question** ("How are SSDs doing?") gets a clarification in place of the sentence, with no steps and no table.
  The box keeps the sentence box's style and holds:
  - "I'm not sure what you'd like to know about SSDs.", then "Would you like to see:";
  - one row per reading: an outline `sm` button with the label (Sales quantity, Revenue, Number of dealers, Current
    prices, Price changes, Growth vs the previous period) and its example question beside it in muted text. Clicking the button asks
    that question, and it is disabled while another is pending, like the suggestions;
  - "Or ask it your own way, for example: …", then the source line "No query was run: the question did not say what to
    measure.".

  A typed reply such as "revenue" works, because the clarification goes into the follow-up history with its options.
  The feature spec, §10, has the rules.

---

## 3. States

| State | Where | What is shown |
|---|---|---|
| Not connected | everywhere | Connect card; Price Updates inert. The Copilot still works: it needs Gemini, not Gmail |
| No Gemini key | Copilot | Setup notice naming `GEMINI_API_KEY`; input disabled |
| Connecting / consent | — | Browser is at Google; app shows nothing |
| Connect failed | Dashboard | Alert with the reason from the callback |
| Connected, no files | Price Updates | Empty state, Scan Gmail offered |
| Scanning | Dialog | Button shows "Scanning…", table skeleton |
| Scan found nothing | Dialog | "No price lists found" and what the search looks for |
| Downloaded | list row | Status `Downloaded`, changes **—**, action **Analyse** |
| Analysing | workflow page | Status `Analysing` (blue) on the Analyse card, button reads "Analysing…" and is disabled. It lasts only as long as the request, so the list never shows it |
| Needs review | list row, badge | Status `Needs review`, action **Review** |
| Approved | list row | Status `Approved`, breakdown of what was applied |
| Partly approved | list row | `Approved` plus "3 of 5 applied" |
| No changes | list row, workflow page | Status `No changes` (grey), action **View**; the page says there is nothing to approve |
| Out of date | workflow page | Destructive alert naming each outdated item, **Re-analyse**; Approve disabled |
| Failed | list row, workflow page | Status `Failed` with the reason inline, action **Retry**; the page shows the full reason above the Retry button |
| File missing | workflow page, step 1 | The manifest names a file that is not on disk. Destructive alert "File not found" in the step 1 card; Show file and Download original disabled |
| Unreadable file | workflow page, step 1 | A file the parser cannot read, such as a corrupt `.xlsx`. Alert "This file cannot be shown" with the reason; Download original stays available |
| Token expired | any API call | Alert: access expired, reconnect (7-day Testing-mode expiry) |
| Nothing selected | Review footer | Summary reads "Nothing selected yet"; commit disabled |
| Copilot thinking | Copilot | "Working out the steps…" |
| Copilot cannot answer | Copilot | Says what it could not map, suggests a rephrase — never a guess |
| Copilot needs clarification | Copilot | A vague question: "I'm not sure what you'd like to know about …", 2–4 readings as buttons that ask an example question, "No query was run" |

---

## 4. Charts

Both charts follow the validated palette; the three brand colours were checked for colour-vision separation
against the card surface rather than picked by eye.

| Concern | Decision |
|---|---|
| Trend granularity | **12 weekly buckets**, not 3 monthly points. Three points is not a trend |
| Partial period | **Both ends** are dashed with a hollow marker and a footnote. The first week opens on 29 Jun but sales start on 2 Jul; the last opens on 14 Sep and sales stop on the 18th. Only the last was noted when this was designed |
| Growth badges | Only against a like-for-like period, with the comparison named. No badge on a partial month |
| Brand colours | Samsung `#2a78d6` · Seagate `#eb6834` · TP-Link `#1baf7a`, fixed per brand everywhere |
| Measure | Named on every chart. Revenue and Units rank brands differently — by revenue Samsung ₹19.6L > Seagate ₹17.1L > TP-Link ₹7.2L; **by units TP-Link 326 > Seagate 324 > Samsung 260** |
| Direct labels | Brand bars always carry their value, since the green sits just under 3:1 on white |
| Axes | Recessive gridlines, one axis, no dual scales |

Monthly figures, for reference: Jul ₹16.4L / 411 units · Aug ₹18.7L / 314 · Sep (to the 18th) ₹8.9L / 185.
Plotted monthly without a marker, September looks like a collapse. That is the whole reason for the rule above.

---

## 5. Visual language

| Token | Value | Use |
|---|---|---|
| Plane | `#F7F6F2` | Page ground (warm, not grey) |
| Card | `#FFFFFF` | Panels |
| Ink / primary | `#171613` | Text, primary buttons |
| Ink 2 | `#56544D` | Secondary text |
| Muted | `#8A877E` | Labels, captions |
| Border | `#E5E3DB` | Card borders; `#F2F0E9` for table rules |

No coloured brand accent in the chrome. Colour is reserved for data and status, so a red row means something.

**Status** always pairs a dot or icon with a word — never colour alone:
Downloaded (grey) · Analysing (blue) · Needs review (amber) · Approved (green) · Failed (red).
Price deltas pair colour with an arrow: ↑ 7.1% on `#FBEAEA`/`#A62B2B`, ↓ 3.5% on `#E8F3E8`/`#1B5E20`.
A supplier price rise is a cost rise, so up is red.

**Type.** Newsreader for the wordmark and page titles; IBM Plex Sans for everything else;
`tabular-nums` in every money column. Sizes: page title 22 · card title 14.5 · body 13 · caption 12 ·
label 11 uppercase. Money is lakh on tiles (₹43.9L) and full in tables (₹7,500).

**Layout.** 248px sidebar · 64px header · 28px page padding · 14px between cards · 12px card radius ·
8px control radius · 36px default control height.

---

## 6. shadcn components

Installed: `alert`, `badge`, `button`, `card`, `chart`, `checkbox`, `dialog`, `input`, `separator`,
`sheet`, `sidebar`, `skeleton`, `table`, `tabs`, `tooltip`. Adding `sidebar` brought `sheet`, `input` and
`skeleton` with it; `chart` brought `recharts`. `tabs` came with Feature 2 (the three change types).

Still to add, when the feature that needs them is built: `dropdown-menu` (filters), `sonner`
(draft-created toast, Feature 3).

```bash
bunx --bun shadcn@latest add dropdown-menu sonner
```

The install uses Base UI, not Radix, which changes three things in practice:

- **`Checkbox`** takes `onCheckedChange(checked: boolean)`, a plain boolean rather than Radix's
  `boolean | "indeterminate"`, with `indeterminate` as its own prop.
- **Composition** uses `render={<Link href="…" />}` rather than `asChild`.
- **A `Button` rendered as a link needs `nativeButton={false}`**, as in
  `<Button nativeButton={false} render={<Link href="…" />}>`. Without it, Base UI logs an error in the browser and
  the Next dev overlay shows "1 Issue". `SidebarMenuButton` is built on `useRender` and does not need it.
- **`Tabs`** only renders the active panel, so client state that must survive a tab switch (the review's
  selections) lives above the tabs.

`hooks/use-mobile.ts` was rewritten after generation: the generated version set state inside an
effect, which fails `react-hooks/set-state-in-effect`. It now uses `useSyncExternalStore`.

---

## 7. Where every number comes from

| Shown | Computed from |
|---|---|
| Total revenue, Units sold | `mock-data/sales/sales-data.json` |
| 30 products, price columns | `mock-data/current-price-lists/current-price-list.json` |
| Dealers, states, emails | `mock-data/dealers/dealers.json` |
| Received / sender / filename per file | `mock-data/new-price-lists/manifest.json` (written by Feature 1 on the first download; absent until then). It records **no brand**, so that column shows `—` until Feature 2 analyses the file |
| Brand, changes, new, missing, status per file | `.data/reviews/<fileId>.json`, written by Feature 2's analysis and approval |
| Price changes and Needs review tiles, sidebar badge | Every review: price changes across analysed files; items in files still needing review |
| Last sold, units sold (missing products) | `mock-data/sales/sales-data.json`, per Product ID |
| Affected dealers | sales lines for the changed products, last 90 days from the latest invoice date |
| "Today" | the latest invoice date, `2026-09-18` — never the wall clock |

Regenerate the baseline with `bun run mock:generate --force`; check it with `--check`.

---

## 8. Decisions this design makes

1. **Sidebar navigation**, because the app is two workflows plus data views.
2. **A workflow page, not a drawer**, for the five steps. A drawer stays for a quick peek at changes from the
   dashboard; approving and drafting happen on the page.
3. **Analysis is explicit.** "Analyse" is a button. It costs an LLM call and sends supplier content to Gemini,
   so it is not automatic.
4. **Checkboxes plus one commit** for approvals; per-row approve buttons are gone.
5. **Product IDs keep the real format** — `SAM-B072D`, not `SAM-011`. New products show their generated ID
   before approval.
6. **Missing products are kept or deactivated, never deleted.** Deleting would orphan sales history, which
   references products by ID. Deactivating writes one **optional** field — `status: "discontinued"`, absent
   meaning active — so the 30 existing records, the mock-data generator and the files on disk are all
   unchanged, and "the current catalogue" is `!product.status`. This closes the `architecture.md` question
   about what removing a missing product means; the reasoning is in its section 6.2.
7. **Scan defaults to ticked, approval defaults to unticked.**
8. **— rather than 0** for counts that cannot exist yet.
9. **Charts always name their measure**, and a partial period is drawn as partial.

## 9. Still open

- One draft for all dealers, or one per group who bought the same models (the design shows one).
- Where the change history lives, and what the "View change history" link opens.
- The 90-day window covers the whole sales file, so the filter cannot currently exclude anyone. Extending the
  sales history back to ~May would make it testable.
- Dark mode: tokens are chosen with it in mind, but `.dark` in `app/globals.css` is still the stock
  neutral grey, and no dark artboards exist yet.
- Mobile: designed at 1440. The sidebar collapses to a sheet and tables scroll horizontally, but no phone
  artboards exist yet.
- The brand column shows the brand once a file is analysed (it comes from the review). Before that it is
  `—`; showing it earlier would need a brand on `ManifestEntry`, or a guess from the sender and filename.
- The Needs review tile is drawn with an amber ring, not the amber ground and border §2.1 describes.
  Unchanged since the dashboard was built; reconcile one way or the other.
