# Project Overview

## Project Name

Price & Sales Copilot

## Core Goal

A small app that reads brand price lists from Gmail, shows what changed, drafts an email to affected dealers, and
answers sales questions.

At its heart is a human-approved price-update pipeline. The system receives a supplier's price list through Gmail,
extracts the attached Excel/CSV file, converts each supplier's different format into one standard format, compares the
new prices with the existing product data, identifies the changes, and lets a human review and approve them before the
current product data is updated.

## Purpose

Price & Sales Copilot is an AI-assisted system that helps a business manage dealer price lists and sales communication.

The system:
- Reads price-list emails from Gmail.
- Downloads and processes Excel/CSV price-list attachments.
- Uses an LLM to normalize different price-list formats.
- Detects changes against the current product list.
- Allows a human to review and approve changes.
- Identifies dealers affected by price changes.
- Drafts personalized dealer emails in Gmail.
- Answers sales and pricing questions using mock sales data.
- Shows the query/steps used to generate each answer for transparency.

## Tech Stack and Constraints

- **Next.js + TypeScript**, one application. Server logic lives in Next.js route handlers; there is no separate backend service.
- **LLM API (Google Gemini)** for mapping price-list formats (Feature 2), generating dealer email content (Feature 3) and understanding
  natural-language sales questions (Feature 4). **Feature 1 uses no LLM.** See AI / LLM Responsibilities.
- **Gmail API + Google OAuth.** OAuth only connects Gmail; there is no custom application login.
- **No database.** All data lives in local files under `mock-data/`.
- Gmail is the only real data integration. Everything else uses local mock files (see Data Sources).

## Core Features

### Feature 1 — Read Price Lists from Gmail

The system connects to a real Gmail inbox (read-only) and identifies emails containing price lists.

It should:

1. Read incoming Gmail emails.
2. Identify price-list emails.
3. Ignore unrelated emails, and attachments that are not Excel or CSV (such as PDFs and images).
4. Find the Excel (`.xlsx`) or CSV (`.csv`) attachments.
5. Download the attachments.
6. Save the raw files to `mock-data/new-price-lists/` for the next stage.

Feature 1 does not parse, normalize or compare anything. Gmail is only the source; the saved files are the input to
Feature 2. Details: `context/features/feature-1-gmail-price-list-ingestion.md`.

### Feature 2 — Clean Price Lists and Show Changes

Price lists from different brands have different column names, formats and structures.

An LLM is used to map these different formats into one common structure:

| Field | Description |
|---|---|
| Product ID | Stable product identifier, e.g. `SAM-B072D`. Each incoming row is matched to an existing product, so a renamed model keeps its ID |
| Brand | Product brand |
| Model | Product model |
| Category | Product category |
| Dealer Price | Price offered to the dealer |
| MRP | Maximum Retail Price |

The normalized new price list is compared with the current product data. The comparison is done by application code,
not by the LLM.

The system identifies:

- Price increases
- Price decreases
- New models
- Missing models (in the current data but absent from the new list; flagged for human review, not assumed
  discontinued or deleted)
- Unchanged products

The changes are shown to the user. The user must approve the changes before the current product data
(`mock-data/current-price-lists/`) is updated. That includes two explicit decisions: whether each new model is added to
the current price list, and whether each missing model is removed from it. Anything the user has not approved stays
exactly as it is.

### Feature 3 — Draft Dealer Emails

After price changes are approved, the system identifies dealers who purchased the affected models during the last
90 days. "Today" is the latest invoice date in the sales data.

The system:

1. Finds affected models.
2. Finds dealers who purchased those models in the last 90 days.
3. Uses an LLM to generate a short price-update message.
4. Creates a Gmail draft.
5. Adds the identified dealers as BCC recipients.
6. Keeps dealer email addresses hidden from each other.

The system creates the draft but does not automatically send the email. The user can review and send it from Gmail.
This feature needs Gmail draft-creation permission, added when the feature is built (Feature 1 is read-only). Dealer
emails in the mock data are Gmail aliases, so test drafts stay safe.

### Feature 4 — Answer Sales Questions

The system provides a question box where users can ask questions about sales and pricing in natural language.

Example questions:

- "Which models generated the most sales last month?"
- "How much did we sell to ABC Computers in the last 90 days?"
- "Which dealers bought Samsung products?"
- "Which products had a price increase?" (depends on approved changes from Feature 2 being recorded)
- "What is the total sales value for routers?"

The LLM reads the question and decides which data tool to call and with what filters, period and grouping. The tools
are application code: they filter, add up and compare the data, so every number comes from the data and not from the
model. The LLM then words a one-sentence answer from the results, and the app checks every number in it. "Which products
had a price increase?" cannot be answered yet, because no change history is recorded; the copilot says so rather than
guessing. Details: `features/feature-4-sales-copilot.md`.

Each answer should show:

1. The user's question.
2. The query/steps used to answer it.
3. The resulting data.
4. The final answer.

This makes the answer explainable and allows the user to verify the result.

---

## Overall Workflow

```text
                         Gmail
                           │
                    Price-list emails
                           │
                           ▼
                ┌─────────────────────┐
                │ Feature 1           │
                │ Read Attachments    │
                │ Excel / CSV         │
                └──────────┬──────────┘
                           │  raw files
                           ▼
                ┌─────────────────────┐
                │ Feature 2           │
                │ Normalize + Compare │
                │ + Human Approval    │
                └──────────┬──────────┘
                           │
                    Approved Changes
                           │
              ┌────────────┴────────────┐
              ▼                         ▼
       Feature 3                  Product Data
       Dealer Emails                    │
              │                         │
              ▼                         │
       Gmail Draft                      │
                                        ▼
                                Feature 4
                                Sales Q&A
                                        │
                                        ▼
                              Answer + Query/Steps

   Sales Data + Dealers feed Feature 3 (who bought the affected models)
   and Feature 4 (sales questions).
```

## Data Sources

### Real Integration

Only Gmail is connected to a real external data source.

```text
Gmail
 ├── Price-list emails          read by Feature 1
 └── Draft emails to dealers    created by Feature 3, never sent automatically
```

The LLM API is used for language tasks, but it is a tool, not a data source.

### Mock Data

Everything else uses local mock data stored in simple project files, not a database. Details: `context/mock-data.md`.

| Data | Location | Notes |
|---|---|---|
| Current product / price list | `mock-data/current-price-lists/current-price-list.json` | 30 products across Seagate, Samsung and TP-Link, each with a Product ID. Also serves as the product information (ID, brand, model, category, prices) |
| Dealer information | `mock-data/dealers/dealers.json` | 20 dealers with state and email (Gmail aliases, so test drafts stay safe) |
| Sales transactions | `mock-data/sales/sales-data.json` | 200 invoice lines, July to September 2026. Each dealer's purchase history is read from these lines |
| New price lists | `mock-data/new-price-lists/` | Raw supplier files downloaded from Gmail by Feature 1 |
| Normalized price lists | `.data/normalized/<fileId>.json` | The common-format version of each new list, produced by Feature 2 and saved as a temporary local file; the comparison reads it |

The mock data is plain JSON files rather than a database.

## AI / LLM Responsibilities

The LLM is used for tasks where the input is unstructured or natural language.

LLM is responsible for:

- Mapping different price-list formats into the standard schema.
- Understanding natural-language sales questions.
- Generating dealer email content.

LLM is NOT responsible for:

- Being the source of truth for prices.
- Directly modifying product data without approval.
- Inventing sales numbers.
- Sending emails automatically.
- Performing calculations when deterministic code can perform them.

Deterministic operations such as price comparison, filtering, aggregation, and calculations should be performed by
application code.

In practice:

| Feature | LLM | Application code | Human |
|---|---|---|---|
| 2: Clean price lists | Maps each supplier's format into the standard schema | Compares prices and classifies the changes; updates product data only after approval | Reviews and approves the changes |
| 3: Dealer emails | Writes the short price-update message | Finds the affected models and dealers; creates the Gmail draft | Reviews and sends the draft from Gmail |
| 4: Sales questions | Understands the question, chooses which data tools to call and with what arguments, and words the answer | Runs the tools against the data (every number comes from the data) and checks the numbers in the answer | Checks the shown steps and result |

## Human-in-the-Loop

The system should keep humans involved in important business actions.

**Price updates**

```text
Detect changes
      ↓
Show changes to user
      ↓
User reviews
      ↓
Approve
  ├── New product: add it to the current price list? (yes / no)
  └── Missing product: remove it from the current price list? (yes / no)
      ↓
Update current data
```

**Dealer emails**

```text
Generate Gmail draft
      ↓
User reviews draft
      ↓
User sends from Gmail
```

The system should not automatically make these business decisions or send emails without user review.

## Build Approach

The project is built feature by feature, and each feature is fully working before the next one starts. Feature 1 comes
first and needs no LLM. A Change History + Audit Log (what changed, old value to new value, when, source price list,
who approved) is added after the core workflow and before the final build.

## Related Documents

- `context/mock-data.md`: mock data structure, decisions and generator
- `context/features/`: one specification per feature (Features 1 and 2 exist)
- `context/architecture.md`: how the app is put together
- `context/current-state.md`: what is built, what runs, and what comes next
- `context/ui-design.md`: every screen
