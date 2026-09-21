/**
 * Generates the mock datasets the app runs on. See context/mock-data.md.
 *
 *   bun run mock:generate            create the files (refuses to overwrite)
 *   bun run mock:generate --force    overwrite with a fresh baseline
 *   bun run mock:generate --check    validate existing files, change nothing
 *
 * Output is deterministic: a seeded PRNG means reruns produce identical files.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// The one Product ID rule, shared with the app (context/architecture.md §6.2).
import { BRAND_CODES, productIdFor } from "../lib/product-id";

type Brand = "Seagate" | "Samsung" | "TP-Link";

interface Product {
  productId: string;
  brand: Brand;
  model: string;
  category: string;
  dealerPrice: number;
  mrp: number;
}

interface Dealer {
  dealer: string;
  state: string;
  email: string;
}

interface SalesLine {
  invoiceNo: string;
  date: string;
  dealer: string;
  state: string;
  productId: string;
  model: string;
  quantity: number;
  unitPrice: number;
}

const ROOT = process.cwd();
const FILES = {
  products: join(ROOT, "mock-data", "current-price-lists", "current-price-list.json"),
  dealers: join(ROOT, "mock-data", "dealers", "dealers.json"),
  sales: join(ROOT, "mock-data", "sales", "sales-data.json"),
};

const SEED = 20260918;
const MAX_ATTEMPTS = 2000;
const START_DATE = "2026-07-01";
const END_DATE = "2026-09-18"; // latest invoice date = "today" for relative questions
const LINE_COUNT = 200;
// The base the generated dealer addresses start with. Put your own Gmail name in with
// `bun run mock:dealer-emails you@gmail.com` (which keeps your approvals), not by editing this and
// regenerating, which would reset them. --check accepts any Gmail base; see validate().
const EMAIL_BASE = "yourname";

// brand, model, category, dealer price (INR), MRP (INR)
const CATALOG: ReadonlyArray<readonly [Brand, string, string, number, number]> = [
  ["Seagate", "Barracuda 1TB", "HDD", 3200, 4500],
  ["Seagate", "Barracuda 2TB", "HDD", 4300, 5800],
  ["Seagate", "Barracuda 4TB", "HDD", 7200, 9400],
  ["Seagate", "IronWolf 4TB", "HDD", 8900, 11500],
  ["Seagate", "SkyHawk 2TB", "HDD", 4800, 6300],
  ["Seagate", "Expansion Portable 1TB", "External HDD", 3900, 5200],
  ["Seagate", "Expansion Portable 2TB", "External HDD", 5600, 7400],
  ["Seagate", "One Touch 2TB", "External HDD", 6300, 8200],
  ["Seagate", "Barracuda SSD 500GB", "SSD", 3400, 4700],
  ["Seagate", "FireCuda 530 1TB", "SSD", 11800, 15500],

  ["Samsung", "T7 1TB", "SSD", 7000, 9999],
  ["Samsung", "T7 2TB", "SSD", 12500, 16999],
  ["Samsung", "T7 Shield 1TB", "SSD", 8200, 11499],
  ["Samsung", "870 EVO 500GB", "SSD", 4300, 5999],
  ["Samsung", "870 EVO 1TB", "SSD", 6800, 9299],
  ["Samsung", "990 EVO 1TB", "SSD", 7600, 10499],
  ["Samsung", "990 PRO 1TB", "SSD", 11500, 15499],
  ["Samsung", "990 PRO 2TB", "SSD", 19800, 25999],
  ["Samsung", "EVO Plus 128GB", "Memory Card", 850, 1299],
  ["Samsung", "EVO Plus 256GB", "Memory Card", 1550, 2299],

  ["TP-Link", "Archer C6", "Router", 2000, 2799],
  ["TP-Link", "Archer C54", "Router", 1500, 2199],
  ["TP-Link", "Archer AX23", "Router", 2900, 4199],
  ["TP-Link", "Archer AX55", "Router", 4300, 6199],
  ["TP-Link", "Archer AX73", "Router", 7600, 10499],
  ["TP-Link", "Archer C80", "Router", 3100, 4399],
  ["TP-Link", "TL-WR841N", "Router", 750, 1099],
  ["TP-Link", "RE305", "Range Extender", 1600, 2299],
  ["TP-Link", "TL-SG108", "Switch", 1100, 1599],
  ["TP-Link", "TL-SG1016D", "Switch", 3900, 5499],
];

// dealer, state, sales weight (bigger = more invoices)
const DEALER_CATALOG: ReadonlyArray<readonly [string, string, number]> = [
  ["ABC Computers", "Maharashtra", 10],
  ["XYZ Electronics", "Gujarat", 8],
  ["Tech World", "Karnataka", 9],
  ["Sai Infotech", "Maharashtra", 5],
  ["Patel Digital Hub", "Gujarat", 5],
  ["Bengaluru Byte Store", "Karnataka", 4],
  ["Chennai Compu Care", "Tamil Nadu", 7],
  ["Madras Micro Systems", "Tamil Nadu", 3],
  ["Delhi Tech Mart", "Delhi", 8],
  ["Capital IT Solutions", "Delhi", 4],
  ["Hyderabad Hardware Hub", "Telangana", 6],
  ["Charminar Computers", "Telangana", 3],
  ["Kolkata Cyber Point", "West Bengal", 4],
  ["Jaipur Digital Zone", "Rajasthan", 3],
  ["Lucknow IT Bazaar", "Uttar Pradesh", 3],
  ["Kochi Compu Store", "Kerala", 3],
  ["Indore Infotech", "Madhya Pradesh", 2],
  ["Punjab Peripherals", "Punjab", 2],
  ["Pune Pixel Traders", "Maharashtra", 4],
  ["Ahmedabad Tech Depot", "Gujarat", 3],
];

// Sales popularity by model. Anything not listed gets DEFAULT_SALES_WEIGHT.
const DEFAULT_SALES_WEIGHT = 2;
const SLOW_MOVERS = ["One Touch 2TB", "TL-SG1016D"]; // zero sales on purpose
const SALES_WEIGHT: Record<string, number> = {
  "Barracuda 1TB": 10,
  "T7 1TB": 10,
  "Archer C6": 10,
  "EVO Plus 128GB": 8,
  "EVO Plus 256GB": 6,
  "Barracuda 2TB": 7,
  "Expansion Portable 1TB": 6,
  "870 EVO 500GB": 5,
  "Archer C54": 5,
  "TL-WR841N": 5,
  "990 EVO 1TB": 5,
  "T7 2TB": 4,
  "Archer AX23": 4,
  "Barracuda SSD 500GB": 4,
  "TL-SG108": 3,
  "RE305": 3,
  "Archer C80": 3,
};
for (const model of SLOW_MOVERS) SALES_WEIGHT[model] = 0;

// Models that must have wide sales coverage (Features 3 and 4 test against them).
const KEY_MODELS = ["T7 1TB", "990 EVO 1TB", "Archer C6", "Barracuda 1TB"];

// Invoice size 1..4 lines; index = size - 1.
const INVOICE_SIZE_WEIGHTS = [1, 3, 4, 4];

// ---------------------------------------------------------------- helpers

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Index of a weighted random pick. Zero-weight entries are never chosen. */
function pickWeighted(rng: () => number, weights: readonly number[]): number {
  const total = weights.reduce((sum, w) => sum + w, 0);
  let r = rng() * total;
  let last = -1;
  for (let i = 0; i < weights.length; i++) {
    if (weights[i] <= 0) continue;
    last = i;
    if (r < weights[i]) return i;
    r -= weights[i];
  }
  return last;
}

function shuffle<T>(rng: () => number, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Every date from start to end inclusive, skipping Sundays. */
function invoiceDays(start: string, end: string): string[] {
  const days: string[] = [];
  const last = new Date(`${end}T00:00:00Z`);
  for (
    const d = new Date(`${start}T00:00:00Z`);
    d <= last;
    d.setUTCDate(d.getUTCDate() + 1)
  ) {
    if (d.getUTCDay() !== 0) days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

// ------------------------------------------------------------- generation

function buildProducts(): Product[] {
  return CATALOG.map(([brand, model, category, dealerPrice, mrp]) => ({
    productId: productIdFor(brand, model),
    brand,
    model,
    category,
    dealerPrice,
    mrp,
  }));
}

function buildDealers(): Dealer[] {
  return DEALER_CATALOG.map(([dealer, state], i) => ({
    dealer,
    state,
    email: `${EMAIL_BASE}+dealer${i + 1}@gmail.com`,
  }));
}

function buildSales(products: Product[], dealers: Dealer[], seed: number): SalesLine[] {
  const rng = mulberry32(seed);
  const days = invoiceDays(START_DATE, END_DATE);
  const productWeights = products.map((p) => SALES_WEIGHT[p.model] ?? DEFAULT_SALES_WEIGHT);
  const dealerWeights = DEALER_CATALOG.map(([, , weight]) => weight);

  // Invoice sizes (1..4 lines) until we hit exactly LINE_COUNT lines.
  const sizes: number[] = [];
  for (let total = 0; total < LINE_COUNT; ) {
    const size = Math.min(1 + pickWeighted(rng, INVOICE_SIZE_WEIGHTS), LINE_COUNT - total);
    sizes.push(size);
    total += size;
  }

  // The first invoices cover every dealer once (shuffled); the rest are weighted.
  const firstRound = shuffle(rng, dealers.map((_, i) => i));
  const invoices = sizes.map((size, i) => ({
    size,
    dealer: dealers[i < dealers.length ? firstRound[i] : pickWeighted(rng, dealerWeights)],
    date: days[Math.floor(rng() * days.length)],
  }));

  // Chronological order (sort is stable), then pin the last invoice to "today".
  invoices.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  invoices[invoices.length - 1].date = END_DATE;

  const lines: SalesLine[] = [];
  invoices.forEach((invoice, n) => {
    const invoiceNo = `INV-2026-${String(n + 1).padStart(4, "0")}`;
    const weights = [...productWeights];
    for (let k = 0; k < invoice.size; k++) {
      const idx = pickWeighted(rng, weights);
      weights[idx] = 0; // distinct products within one invoice
      const product = products[idx];

      const maxQty = product.dealerPrice >= 10000 ? 8 : 20;
      const quantity = Math.min(maxQty, 1 + Math.floor(-Math.log(1 - rng()) * 4));

      let unitPrice = product.dealerPrice;
      if (rng() < 0.2) {
        const discount = 0.01 + rng() * 0.04;
        unitPrice = Math.round((product.dealerPrice * (1 - discount)) / 10) * 10;
      }

      lines.push({
        invoiceNo,
        date: invoice.date,
        dealer: invoice.dealer.dealer,
        state: invoice.dealer.state,
        productId: product.productId,
        model: product.model,
        quantity,
        unitPrice,
      });
    }
  });
  return lines;
}

/** Retry with successive seeds (deterministic) until the coverage guarantees hold. */
function generateSales(products: Product[], dealers: Dealer[]): SalesLine[] {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const sales = buildSales(products, dealers, SEED + attempt);
    if (coverageErrors(products, dealers, sales).length === 0) return sales;
  }
  throw new Error(`No seed satisfied the coverage guarantees in ${MAX_ATTEMPTS} attempts`);
}

// ------------------------------------------------------------- validation

function coverageErrors(products: Product[], dealers: Dealer[], sales: SalesLine[]): string[] {
  const errors: string[] = [];
  const dealersByProduct = new Map<string, Set<string>>();
  const statesByProduct = new Map<string, Set<string>>();
  const activeDealers = new Set<string>();

  for (const line of sales) {
    activeDealers.add(line.dealer);
    if (!dealersByProduct.has(line.productId)) {
      dealersByProduct.set(line.productId, new Set());
      statesByProduct.set(line.productId, new Set());
    }
    dealersByProduct.get(line.productId)?.add(line.dealer);
    statesByProduct.get(line.productId)?.add(line.state);
  }

  for (const product of products) {
    const sold = dealersByProduct.has(product.productId);
    if (SLOW_MOVERS.includes(product.model)) {
      if (sold) errors.push(`${product.model} should have zero sales`);
    } else if (!sold) {
      errors.push(`${product.model} has no sales`);
    }
  }

  for (const model of KEY_MODELS) {
    const product = products.find((p) => p.model === model);
    if (!product) {
      errors.push(`key model ${model} missing from the price list`);
      continue;
    }
    const dealerCount = dealersByProduct.get(product.productId)?.size ?? 0;
    const stateCount = statesByProduct.get(product.productId)?.size ?? 0;
    if (dealerCount < 3) errors.push(`${model} sold to ${dealerCount} dealers, need at least 3`);
    if (stateCount < 2) errors.push(`${model} sold in ${stateCount} states, need at least 2`);
  }

  for (const d of dealers) {
    if (!activeDealers.has(d.dealer)) errors.push(`dealer ${d.dealer} has no invoices`);
  }
  return errors;
}

function validate(products: Product[], dealers: Dealer[], sales: SalesLine[]): string[] {
  const errors: string[] = [];

  // --- products
  if (products.length !== 30) errors.push(`expected 30 products, found ${products.length}`);
  for (const brand of Object.keys(BRAND_CODES) as Brand[]) {
    const count = products.filter((p) => p.brand === brand).length;
    if (count !== 10) errors.push(`expected 10 ${brand} products, found ${count}`);
  }
  const idPattern = /^(SEG|SAM|TPL)-[0-9A-F]{5}$/;
  const seenIds = new Set<string>();
  const seenModels = new Set<string>();
  for (const p of products) {
    if (!idPattern.test(p.productId)) errors.push(`bad productId format: ${p.productId}`);
    else if (!p.productId.startsWith(`${BRAND_CODES[p.brand]}-`)) {
      errors.push(`${p.productId} prefix does not match brand ${p.brand}`);
    }
    if (seenIds.has(p.productId)) errors.push(`duplicate productId: ${p.productId}`);
    if (seenModels.has(p.model)) errors.push(`duplicate model: ${p.model}`);
    seenIds.add(p.productId);
    seenModels.add(p.model);
    if (!Number.isInteger(p.dealerPrice) || !Number.isInteger(p.mrp)) {
      errors.push(`${p.model}: prices must be integers`);
    }
    if (!(p.dealerPrice > 0 && p.dealerPrice < p.mrp)) {
      errors.push(`${p.model}: dealerPrice ${p.dealerPrice} must be > 0 and < mrp ${p.mrp}`);
    }
  }

  // --- dealers
  if (dealers.length !== 20) errors.push(`expected 20 dealers, found ${dealers.length}`);
  // Any Gmail name with a +dealerN alias: "yourname" as generated, or your own after mock:dealer-emails.
  const emailPattern = /^[a-z0-9][a-z0-9.]*\+dealer\d+@gmail\.com$/i;
  if (new Set(dealers.map((d) => d.dealer)).size !== dealers.length) {
    errors.push("dealer names are not unique");
  }
  if (new Set(dealers.map((d) => d.email)).size !== dealers.length) {
    errors.push("dealer emails are not unique");
  }
  for (const d of dealers) {
    if (!emailPattern.test(d.email)) errors.push(`unexpected email format: ${d.email}`);
  }

  // --- sales
  if (sales.length !== LINE_COUNT) errors.push(`expected ${LINE_COUNT} sales lines, found ${sales.length}`);
  const productById = new Map(products.map((p) => [p.productId, p]));
  const dealerByName = new Map(dealers.map((d) => [d.dealer, d]));
  const invoices = new Map<string, { dealer: string; date: string; ids: Set<string> }>();

  sales.forEach((line, i) => {
    const where = `sales[${i}] (${line.invoiceNo})`;
    const product = productById.get(line.productId);
    if (!product) errors.push(`${where}: unknown productId ${line.productId}`);
    else if (product.model !== line.model) {
      errors.push(`${where}: model "${line.model}" does not match ${line.productId} ("${product.model}")`);
    }
    const dealer = dealerByName.get(line.dealer);
    if (!dealer) errors.push(`${where}: unknown dealer ${line.dealer}`);
    else if (dealer.state !== line.state) {
      errors.push(`${where}: state ${line.state} does not match dealer ${line.dealer} (${dealer.state})`);
    }
    if (!(line.date >= START_DATE && line.date <= END_DATE)) errors.push(`${where}: date ${line.date} out of range`);
    if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 20) {
      errors.push(`${where}: bad quantity ${line.quantity}`);
    }
    if (product) {
      if (!Number.isInteger(line.unitPrice) || line.unitPrice > product.dealerPrice || line.unitPrice < product.dealerPrice * 0.94) {
        errors.push(`${where}: unitPrice ${line.unitPrice} not within 6% below dealer price ${product.dealerPrice}`);
      }
    }
    const invoice = invoices.get(line.invoiceNo) ?? { dealer: line.dealer, date: line.date, ids: new Set<string>() };
    if (invoice.dealer !== line.dealer || invoice.date !== line.date) {
      errors.push(`${where}: lines of one invoice must share dealer and date`);
    }
    if (invoice.ids.has(line.productId)) errors.push(`${where}: product repeated within invoice`);
    invoice.ids.add(line.productId);
    invoices.set(line.invoiceNo, invoice);
  });

  if (invoices.size < 60 || invoices.size > 80) errors.push(`expected about 70 invoices, found ${invoices.size}`);
  const dates = sales.map((s) => s.date);
  if (dates.length > 0) {
    if (dates.reduce((a, b) => (a > b ? a : b)) !== END_DATE) errors.push(`latest invoice date must be ${END_DATE}`);
    if (!dates.every((d, i) => i === 0 || dates[i - 1] <= d)) errors.push("sales are not sorted by date");
  }

  return [...errors, ...coverageErrors(products, dealers, sales)];
}

// -------------------------------------------------------------------- I/O

function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function check(): boolean {
  const missing = Object.values(FILES).filter((path) => !existsSync(path));
  if (missing.length > 0) {
    console.error(`Cannot check, missing files:\n${missing.map((m) => `  ${m}`).join("\n")}`);
    return false;
  }
  const products = readJson<Product[]>(FILES.products);
  const dealers = readJson<Dealer[]>(FILES.dealers);
  const sales = readJson<SalesLine[]>(FILES.sales);
  const errors = validate(products, dealers, sales);
  if (errors.length > 0) {
    console.error(`Validation failed with ${errors.length} problem(s):`);
    for (const e of errors) console.error(`  - ${e}`);
    return false;
  }
  const invoiceCount = new Set(sales.map((s) => s.invoiceNo)).size;
  const dates = sales.map((s) => s.date).sort();
  console.log(
    `OK: ${products.length} products, ${dealers.length} dealers, ${sales.length} sales lines ` +
      `in ${invoiceCount} invoices (${dates[0]} to ${dates[dates.length - 1]})`,
  );
  return true;
}

function main(): void {
  const args = new Set(process.argv.slice(2));

  if (args.has("--check")) {
    process.exit(check() ? 0 : 1);
  }

  const existing = Object.values(FILES).filter((path) => existsSync(path));
  if (existing.length > 0 && !args.has("--force")) {
    console.error(
      `Refusing to overwrite existing files (approved changes could be lost):\n` +
        `${existing.map((f) => `  ${f}`).join("\n")}\nRe-run with --force to reset to the baseline.`,
    );
    process.exit(1);
  }

  const products = buildProducts();
  const dealers = buildDealers();
  const sales = generateSales(products, dealers);

  const errors = validate(products, dealers, sales);
  if (errors.length > 0) {
    console.error(`Generated data is invalid:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
    process.exit(1);
  }

  writeJson(FILES.products, products);
  writeJson(FILES.dealers, dealers);
  writeJson(FILES.sales, sales);
  console.log("Wrote:");
  for (const path of Object.values(FILES)) console.log(`  ${path}`);
  process.exit(check() ? 0 : 1);
}

main();
