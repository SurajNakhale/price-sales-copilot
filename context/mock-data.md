# Mock Data

**Status:** Generated and validated (2026-09-20). The three JSON files exist and `bun run mock:generate --check` passes

## 1. Purpose and data sources

The app runs on local mock files, with no database. Later features rely on them: Feature 2 compares new supplier price lists against the **current price list**, Feature 3 finds affected **dealers** from **sales** history, and Feature 4 answers sales questions from all of it.

There are four data sources:

| # | Source | Location | Created by |
|---|---|---|---|
| 1 | Current price list (30 products) | `mock-data/current-price-lists/current-price-list.json` | `scripts/generate-mock-data.ts` |
| 2 | New price lists (3 supplier files) | `mock-data/new-price-lists/` | Arrive through Gmail (Feature 1). **Not** part of this generator |
| 3 | Sales data (200 invoice lines) | `mock-data/sales/sales-data.json` | `scripts/generate-mock-data.ts` |
| 4 | Dealers (20 dealers) | `mock-data/dealers/dealers.json` | `scripts/generate-mock-data.ts` |

```
                    Gmail
                      │
                      ▼
              New Price Lists
                      │
                      ▼
              Normalize + Match
                      │
                      ▼
             Compare with Current
                      │
             ┌────────┼────────┐
             ▼        ▼        ▼
          Changed    New     Missing
           Price    Product  Product
             └────────┼────────┘
                      ▼
               Human Approval
                      ▼
             Current Price Data
                      │
          ┌───────────┴───────────┐
          ▼                       ▼
       Sales Data              Dealers
          │                       │
          └───────────┬───────────┘
                      ▼
                AI Copilot
```

## 2. Decisions

| Decision | Choice |
|---|---|
| File format | JSON for all three datasets. No parser dependency, and Feature 2 can write approved prices straight back to the current price list |
| Product ID | `<3-letter brand code>-<5-char hash>`, e.g. `SAM-9C41B`. Codes: Seagate `SEG`, Samsung `SAM`, TP-Link `TPL` |
| Hash | First 5 uppercase hex characters of `sha256("<brand>|<model>")`, input lowercased. Computed once at generation from the current model name, then stored in the file |
| Product ID stability | Product ID is the stable key. If a supplier later spells the model differently ("Portable SSD T7 1TB"), the ID does not change. It replaces the `SEG-001` sequence style from the original spec |
| Money | Plain integer rupees (`7000`), no `₹` symbol or commas. Formatting is a UI concern |
| Sales lines | Carry both `productId` and `model`, so joins never depend on model-name matching |
| Dealer emails | `yourname+dealer1@gmail.com` … `yourname+dealer20@gmail.com`. Replace `yourname` with your Gmail base name before testing Feature 3 (Gmail aliases keep drafts safe) |
| "Today" | The latest invoice date, `2026-09-18`, is treated as today for relative questions. "Last month" = August 2026 |
| Sales period | Invoice dates fall between `2026-07-01` and `2026-09-18` (July and August in full, September to date). No Sunday invoices. The earliest generated invoice is `2026-07-02` |
| Currency | INR |

## 3. Data shapes

```jsonc
// current-price-list.json (array)
{ "productId": "SAM-9C41B", "brand": "Samsung", "model": "T7 1TB", "category": "SSD", "dealerPrice": 7000, "mrp": 9999 }
// Feature 2 may later add "status": "discontinued" (+ optional "discontinuedOn") to a product the supplier
// has dropped. The generator never writes it, absent means active, and --check ignores it.

// sales-data.json (array, sorted by date)
{ "invoiceNo": "INV-2026-0001", "date": "2026-07-01", "dealer": "ABC Computers", "state": "Maharashtra",
  "productId": "SAM-9C41B", "model": "T7 1TB", "quantity": 5, "unitPrice": 7000 }

// dealers.json (array)
{ "dealer": "ABC Computers", "state": "Maharashtra", "email": "yourname+dealer1@gmail.com" }
```

Two small additions beyond the original spec:

- `invoiceNo` groups the 200 lines into 66 invoices of 1 to 4 lines each (the generator targets about 70), so they really are invoice lines. Lines of one invoice share a dealer and a date.
- `unitPrice` is the original `Price` column. It is per unit (5 × ₹7,000), not a line total.

Joins: sales → products by `productId`; sales → dealers by `dealer` (name is unique) with `state` matching.

## 4. Products

Ten products per brand. "Units sold" is the total quantity across the 3 months of sales data.

| Product ID | Brand | Model | Category | Dealer Price | MRP | Units sold |
|---|---|---|---|---:|---:|---:|
| SEG-AF1A9 | Seagate | Barracuda 1TB | HDD | ₹3,200 | ₹4,500 | 67 |
| SEG-C78E0 | Seagate | Barracuda 2TB | HDD | ₹4,300 | ₹5,800 | 70 |
| SEG-3B757 | Seagate | Barracuda 4TB | HDD | ₹7,200 | ₹9,400 | 29 |
| SEG-A7C3F | Seagate | IronWolf 4TB | HDD | ₹8,900 | ₹11,500 | 10 |
| SEG-661A8 | Seagate | SkyHawk 2TB | HDD | ₹4,800 | ₹6,300 | 33 |
| SEG-C9EB8 | Seagate | Expansion Portable 1TB | External HDD | ₹3,900 | ₹5,200 | 33 |
| SEG-30382 | Seagate | Expansion Portable 2TB | External HDD | ₹5,600 | ₹7,400 | 4 |
| SEG-477B0 | Seagate | One Touch 2TB | External HDD | ₹6,300 | ₹8,200 | 0 |
| SEG-B4DA0 | Seagate | Barracuda SSD 500GB | SSD | ₹3,400 | ₹4,700 | 38 |
| SEG-6DB56 | Seagate | FireCuda 530 1TB | SSD | ₹11,800 | ₹15,500 | 40 |
| SAM-B072D | Samsung | T7 1TB | SSD | ₹7,000 | ₹9,999 | 55 |
| SAM-F202D | Samsung | T7 2TB | SSD | ₹12,500 | ₹16,999 | 34 |
| SAM-4999E | Samsung | T7 Shield 1TB | SSD | ₹8,200 | ₹11,499 | 23 |
| SAM-BDAA4 | Samsung | 870 EVO 500GB | SSD | ₹4,300 | ₹5,999 | 32 |
| SAM-1808F | Samsung | 870 EVO 1TB | SSD | ₹6,800 | ₹9,299 | 3 |
| SAM-72942 | Samsung | 990 EVO 1TB | SSD | ₹7,600 | ₹10,499 | 35 |
| SAM-BFB95 | Samsung | 990 PRO 1TB | SSD | ₹11,500 | ₹15,499 | 13 |
| SAM-6F25C | Samsung | 990 PRO 2TB | SSD | ₹19,800 | ₹25,999 | 17 |
| SAM-A72BE | Samsung | EVO Plus 128GB | Memory Card | ₹850 | ₹1,299 | 17 |
| SAM-6A9D9 | Samsung | EVO Plus 256GB | Memory Card | ₹1,550 | ₹2,299 | 31 |
| TPL-A3F12 | TP-Link | Archer C6 | Router | ₹2,000 | ₹2,799 | 115 |
| TPL-22E74 | TP-Link | Archer C54 | Router | ₹1,500 | ₹2,199 | 34 |
| TPL-A54E2 | TP-Link | Archer AX23 | Router | ₹2,900 | ₹4,199 | 54 |
| TPL-653E4 | TP-Link | Archer AX55 | Router | ₹4,300 | ₹6,199 | 7 |
| TPL-166EB | TP-Link | Archer AX73 | Router | ₹7,600 | ₹10,499 | 16 |
| TPL-42D07 | TP-Link | Archer C80 | Router | ₹3,100 | ₹4,399 | 13 |
| TPL-89AA1 | TP-Link | TL-WR841N | Router | ₹750 | ₹1,099 | 39 |
| TPL-0A14F | TP-Link | RE305 | Range Extender | ₹1,600 | ₹2,299 | 29 |
| TPL-EB8CE | TP-Link | TL-SG108 | Switch | ₹1,100 | ₹1,599 | 19 |
| TPL-9A86E | TP-Link | TL-SG1016D | Switch | ₹3,900 | ₹5,499 | 0 |

## 5. Dealers

| # | Dealer | State | Email | Invoices |
|---:|---|---|---|---:|
| 1 | ABC Computers | Maharashtra | yourname+dealer1@gmail.com | 5 |
| 2 | XYZ Electronics | Gujarat | yourname+dealer2@gmail.com | 10 |
| 3 | Tech World | Karnataka | yourname+dealer3@gmail.com | 7 |
| 4 | Sai Infotech | Maharashtra | yourname+dealer4@gmail.com | 3 |
| 5 | Patel Digital Hub | Gujarat | yourname+dealer5@gmail.com | 4 |
| 6 | Bengaluru Byte Store | Karnataka | yourname+dealer6@gmail.com | 1 |
| 7 | Chennai Compu Care | Tamil Nadu | yourname+dealer7@gmail.com | 4 |
| 8 | Madras Micro Systems | Tamil Nadu | yourname+dealer8@gmail.com | 2 |
| 9 | Delhi Tech Mart | Delhi | yourname+dealer9@gmail.com | 10 |
| 10 | Capital IT Solutions | Delhi | yourname+dealer10@gmail.com | 1 |
| 11 | Hyderabad Hardware Hub | Telangana | yourname+dealer11@gmail.com | 3 |
| 12 | Charminar Computers | Telangana | yourname+dealer12@gmail.com | 3 |
| 13 | Kolkata Cyber Point | West Bengal | yourname+dealer13@gmail.com | 1 |
| 14 | Jaipur Digital Zone | Rajasthan | yourname+dealer14@gmail.com | 2 |
| 15 | Lucknow IT Bazaar | Uttar Pradesh | yourname+dealer15@gmail.com | 3 |
| 16 | Kochi Compu Store | Kerala | yourname+dealer16@gmail.com | 2 |
| 17 | Indore Infotech | Madhya Pradesh | yourname+dealer17@gmail.com | 1 |
| 18 | Punjab Peripherals | Punjab | yourname+dealer18@gmail.com | 1 |
| 19 | Pune Pixel Traders | Maharashtra | yourname+dealer19@gmail.com | 1 |
| 20 | Ahmedabad Tech Depot | Gujarat | yourname+dealer20@gmail.com | 2 |

All fictional. Dealer names are unique, and sales lines use these exact names and states.

## 6. How the sales data is generated

The generator uses a seeded random number generator, so reruns produce identical files.

- 66 invoices with the current seed (the generator targets about 70), 1 to 4 distinct products each, totalling exactly 200 lines. Invoice numbers are sequential and chronological.
- Dealers are weighted (a few large, several small) so "top dealer" questions have clear answers. Every dealer has at least one invoice.
- Products are weighted by popularity: Barracuda 1TB, T7 1TB, Archer C6 and EVO Plus microSD cards sell most.
- Quantities run 1 to 20, skewed small (capped at 8 for items priced ₹10,000 or more).
- 80% of lines are at the current dealer price. 20% carry a 1–5% negotiated discount, rounded to ₹10.
- The last invoice is dated exactly `2026-09-18`.

**Coverage guarantees** (so Features 3 and 4 have something to find):

- `T7 1TB`, `990 EVO 1TB`, `Archer C6` and `Barracuda 1TB` were each sold to at least 3 different dealers in at least 2 states.
- Two slow movers, `One Touch 2TB` (Seagate) and `TL-SG1016D` (TP-Link), have zero sales, for "which products had no sales" questions.
- Every other product has at least one sale.

**Reference facts for the baseline data** (revenue = quantity × unit price; useful for checking Feature 4 answers):

- Revenue by month: July ₹16,35,290 · August ₹18,65,150 · September to the 18th ₹8,91,380.
- Top dealer: XYZ Electronics (₹8,16,450, 170 units). Top state: Gujarat (₹11,53,300).
- Top product by units: Archer C6 (115). Products with no sales: One Touch 2TB, TL-SG1016D.

## 7. How the data supports later features

The supplier-file scenarios from the original spec map onto this data like this:

| Scenario | Current data provides |
|---|---|
| **Renamed model + price change**: new file says "Portable SSD T7 1TB" at ₹7,500 | `T7 1TB` exists at ₹7,000. Normalization must map it back to the same Product ID. Sales history shows which dealers bought it, i.e. the affected dealers for Feature 3 |
| **New product**: `T9 1TB` | Deliberately absent from the current list |
| **Missing product**: `990 EVO 1TB` | Exists in the current list and has sales. If the supplier file omits it, it is flagged for human review. **Missing does not mean deleted** |
| **Seagate and TP-Link changes** | Each brand has 10 products, so each supplier file can include at least one price change, one new model and one missing model |

The supplier files themselves (`Seagate_Price_List.xlsx`, `Samsung_Price_List.csv`, `TPLink_Price_List.xlsx`) are a separate step. They deliberately use different column names and model spellings.

## 8. Regenerating and validating

Run from the project root:

| Command | What it does |
|---|---|
| `bun run mock:generate` | Creates the three JSON files. Refuses to overwrite existing files |
| `bun run mock:generate --force` | Overwrites the files with a fresh, identical baseline. This resets any price changes approved in Feature 2 |
| `bun run mock:generate --check` | Validates the existing files and changes nothing |

`--check` verifies the pristine baseline:

- 30 products, 10 per brand; unique Product IDs matching `^(SEG|SAM|TPL)-[0-9A-F]{5}$`; prefix matches brand; `dealerPrice < mrp`.
- 200 sales lines; every sales `productId` and `model` pair exists in the current list; every `dealer` and `state` pair exists in the dealers file.
- Latest date is `2026-09-18` and earliest is on or after `2026-07-01`.
- 20 dealers with unique names and emails; the coverage guarantees above hold.

After Feature 2 approves changes (for example adds `T9 1TB`), `--check` is expected to report differences from the baseline. That is normal. Use `--force` to reset.

## 9. Later addition (not now)

A separate **Change History + Audit Log** entry will record what changed, old value → new value, when it changed, the source price list, and who approved it. It is added after the core workflow is implemented and before the final build. It is not part of this mock data.
