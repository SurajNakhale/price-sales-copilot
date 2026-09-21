/**
 * Generates sample supplier price-list files to email to the Gmail account the
 * app is connected to, so Feature 1 can be tried against real messages.
 * See context/mock-data.md and context/features/feature-1-gmail-price-list-ingestion.md.
 *
 *   bun run mock:supplier-files                     create the files (refuses to overwrite)
 *   bun run mock:supplier-files --force             overwrite them
 *   bun run mock:supplier-files --check-downloads   compare what the app downloaded with these
 *                                                   samples, byte for byte; changes nothing
 *
 * The files go to mock-data/sample-supplier-files/, deliberately NOT to
 * mock-data/new-price-lists/. That folder is where the app saves its downloads,
 * and a file put there by this script would make it impossible to tell whether
 * the app downloaded anything.
 *
 * Each supplier file is the current price list for that brand with three price
 * changes, one new product and one product left out, so the same files serve
 * Feature 2. Column headers differ per supplier on purpose, and each supplier
 * spells one changed model its own way so Feature 2's matching is exercised.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import writeExcelFile, { type Cell } from "write-excel-file/node";

type Brand = "Seagate" | "Samsung" | "TP-Link";

interface Product {
  productId: string;
  brand: Brand;
  model: string;
  category: string;
  dealerPrice: number;
  mrp: number;
}

/** One line of a supplier's price list. */
export interface PriceRow {
  /** The model as the supplier writes it. */
  model: string;
  /** The model as the current price list names it (the new product's own name when new). */
  catalogueModel: string;
  category: string;
  dealerPrice: number;
  mrp: number;
}

interface PriceChange {
  model: string;
  dealerPrice: number;
  /** Left out when the supplier changed only the dealer price. */
  mrp?: number;
  /**
   * How this supplier spells the model, when not as the catalogue does. One
   * row per supplier is renamed so Feature 2's matching is exercised: by the
   * matching key (case, punctuation, brand prefix) or by the LLM fallback.
   */
  supplierName?: string;
}

export interface SupplierSpec {
  brand: Brand;
  /** Column headers in this supplier's own words: model, category, dealer price, MRP. */
  headers: [string, string, string, string];
  /** Rows above the header. Suppliers often put a title block there. */
  titleRows: string[][];
  changes: PriceChange[];
  added: Omit<PriceRow, "catalogueModel">;
  /** A model the supplier no longer lists. */
  omitted: string;
}

const ROOT = join(import.meta.dir, "..");
export const SAMPLE_DIR = join(ROOT, "mock-data", "sample-supplier-files");
// The folder the app saves downloads into. Written out here because
// lib/config.ts is server-only and cannot be imported from a script.
export const DOWNLOAD_DIR = join(ROOT, "mock-data", "new-price-lists");
export const PRODUCTS_FILE = join(
  ROOT,
  "mock-data",
  "current-price-lists",
  "current-price-list.json",
);

// ---------------------------------------------------------------- suppliers

export const SUPPLIERS = {
  samsung: {
    brand: "Samsung",
    headers: ["Model", "Type", "Dealer Price (INR)", "MRP (INR)"],
    titleRows: [],
    changes: [
      // Extra words: no matching key can reach it, so the LLM fallback has to.
      { model: "T7 1TB", dealerPrice: 7500, mrp: 10499, supplierName: "Portable SSD T7 1TB" },
      { model: "T7 2TB", dealerPrice: 13000, mrp: 17499 },
      { model: "870 EVO 500GB", dealerPrice: 4500 },
    ],
    added: { model: "T9 1TB", category: "SSD", dealerPrice: 8500, mrp: 11999 },
    omitted: "990 EVO 1TB",
  },
  seagate: {
    brand: "Seagate",
    headers: ["SKU Name", "Segment", "DP", "MRP"],
    titleRows: [
      ["Seagate India - Distributor Price List"],
      ["Valid from 21 Sep 2026"],
      [],
    ],
    changes: [
      // Case, a hyphen and the brand name only: the matching key resolves it.
      { model: "Barracuda 2TB", dealerPrice: 4450, supplierName: "SEAGATE BARRACUDA-2TB" },
      { model: "IronWolf 4TB", dealerPrice: 9200, mrp: 11900 },
      { model: "FireCuda 530 1TB", dealerPrice: 11400, mrp: 14900 },
    ],
    added: { model: "IronWolf 8TB", category: "HDD", dealerPrice: 15400, mrp: 19900 },
    omitted: "One Touch 2TB",
  },
  tplink: {
    brand: "TP-Link",
    headers: ["Model No.", "Category", "Dealer Net (INR)", "Retail Price (INR)"],
    titleRows: [],
    changes: [
      // A marketing suffix: left to the LLM fallback.
      { model: "Archer C6", dealerPrice: 2100, supplierName: "Archer C6 AC1200" },
      { model: "Archer AX55", dealerPrice: 4500, mrp: 6499 },
      { model: "TL-SG108", dealerPrice: 1050, mrp: 1499 },
    ],
    added: { model: "Archer AX53", category: "Router", dealerPrice: 3400, mrp: 4999 },
    omitted: "TL-WR841N",
  },
} satisfies Record<string, SupplierSpec>;

/** The same Samsung list with one price corrected, for the filename-collision test. */
export const SAMSUNG_REVISED: SupplierSpec = {
  ...SUPPLIERS.samsung,
  changes: SUPPLIERS.samsung.changes.map((change) =>
    change.model === "T7 1TB" ? { ...change, dealerPrice: 7450 } : change,
  ),
};

/**
 * The supplier's price list: every product of the brand except the omitted
 * one, with the changes applied, and the new product last. Throws if the spec
 * refers to a model the catalogue does not have, so a catalogue edit cannot
 * silently turn a sample into something other than what it claims to be.
 */
export function buildSupplierRows(catalogue: Product[], spec: SupplierSpec): PriceRow[] {
  const own = catalogue.filter((product) => product.brand === spec.brand);
  const byModel = new Map(own.map((product) => [product.model, product]));

  const find = (model: string, role: string): Product => {
    const product = byModel.get(model);
    if (!product) {
      throw new Error(`${spec.brand}: ${role} "${model}" is not in the current price list.`);
    }
    return product;
  };

  find(spec.omitted, "omitted model");
  if (byModel.has(spec.added.model)) {
    throw new Error(
      `${spec.brand}: "${spec.added.model}" is already in the current price list, so it is not new.`,
    );
  }
  for (const change of spec.changes) {
    const product = find(change.model, "changed model");
    const samePrice =
      change.dealerPrice === product.dealerPrice &&
      (change.mrp === undefined || change.mrp === product.mrp);
    if (samePrice) {
      throw new Error(`${spec.brand}: "${change.model}" is listed as changed but its prices are identical.`);
    }
  }

  const changeFor = new Map(spec.changes.map((change) => [change.model, change]));
  const rows = own
    .filter((product) => product.model !== spec.omitted)
    .map((product) => {
      const change = changeFor.get(product.model);
      return {
        model: change?.supplierName ?? product.model,
        catalogueModel: product.model,
        category: product.category,
        dealerPrice: change?.dealerPrice ?? product.dealerPrice,
        mrp: change?.mrp ?? product.mrp,
      };
    });

  rows.push({ ...spec.added, catalogueModel: spec.added.model });
  return rows;
}

// ------------------------------------------------------------------ formats

type Matrix = (string | number)[][];

function matrixFor(spec: SupplierSpec, rows: PriceRow[]): Matrix {
  return [
    ...spec.titleRows,
    [...spec.headers],
    ...rows.map((row) => [row.model, row.category, row.dealerPrice, row.mrp]),
  ];
}

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** RFC 4180: CRLF line ends, and quotes around any cell holding a comma, quote or newline. */
export function toCsv(matrix: Matrix): string {
  return `${matrix.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

async function toXlsx(
  matrix: Matrix,
  sheet: string,
  boldRows: number[],
  widths: number[],
): Promise<Buffer> {
  const rows: Cell[][] = matrix.map((row, index) =>
    row.map((value) =>
      boldRows.includes(index) ? { value, fontWeight: "bold" as const } : value,
    ),
  );
  return writeExcelFile(rows, {
    sheet,
    columns: widths.map((width) => ({ width })),
  }).toBuffer();
}

/** Bold the title block's first line and the header row. */
function boldRowsFor(spec: SupplierSpec): number[] {
  return spec.titleRows.length > 0 ? [0, spec.titleRows.length] : [0];
}

// ------------------------------------------------------------------ samples

export interface SampleFile {
  /** Path inside the output folder, with forward slashes. */
  path: string;
  /** Whether the app should download it. */
  expectDownload: boolean;
  /** Why the app should ignore it, when it should. */
  whyIgnored?: "extension" | "unrelated email";
  build: (catalogue: Product[]) => Promise<Buffer>;
}

const LUNCH_MENU: Matrix = [
  ["Item", "Quantity", "Note"],
  ["Veg thali", 12, "No onion"],
  ["Paneer wrap", 8, "Extra sauce"],
  ["Cold coffee", 20, "Regular"],
];

const DEALER_TERMS = [
  "Dealer terms (sample)",
  "",
  "Payment: 30 days from the invoice date.",
  "Prices are ex-GST and hold until a newer price list replaces them.",
  "Freight: at actuals, paid by the dealer.",
  "",
].join("\r\n");

export const SAMPLES: SampleFile[] = [
  {
    path: "Samsung_Price_List.csv",
    expectDownload: true,
    build: async (catalogue) =>
      Buffer.from(
        toCsv(matrixFor(SUPPLIERS.samsung, buildSupplierRows(catalogue, SUPPLIERS.samsung))),
        "utf8",
      ),
  },
  {
    path: "Seagate_Price_List.xlsx",
    expectDownload: true,
    build: (catalogue) =>
      toXlsx(
        matrixFor(SUPPLIERS.seagate, buildSupplierRows(catalogue, SUPPLIERS.seagate)),
        "Price List",
        boldRowsFor(SUPPLIERS.seagate),
        [34, 16, 12, 12],
      ),
  },
  {
    path: "TPLink_Price_List.xlsx",
    expectDownload: true,
    build: (catalogue) =>
      toXlsx(
        matrixFor(SUPPLIERS.tplink, buildSupplierRows(catalogue, SUPPLIERS.tplink)),
        "Dealer Rates",
        boldRowsFor(SUPPLIERS.tplink),
        [20, 18, 20, 22],
      ),
  },
  {
    path: "Dealer_Terms.txt",
    expectDownload: false,
    whyIgnored: "extension",
    build: async () => Buffer.from(DEALER_TERMS, "utf8"),
  },
  {
    path: "Lunch_Menu.xlsx",
    expectDownload: false,
    whyIgnored: "unrelated email",
    build: () => toXlsx(LUNCH_MENU, "Menu", [0], [24, 12, 20]),
  },
  {
    path: "revised/Samsung_Price_List.csv",
    expectDownload: true,
    build: async (catalogue) =>
      Buffer.from(
        toCsv(matrixFor(SAMSUNG_REVISED, buildSupplierRows(catalogue, SAMSUNG_REVISED))),
        "utf8",
      ),
  },
];

// ------------------------------------------------------------------- emails

export interface EmailScenario {
  id: string;
  stage: "A" | "B";
  subject: string;
  /** Sample paths to attach. */
  attachments: string[];
  /** What the app should do with it. */
  expect: string;
}

export const EMAILS: EmailScenario[] = [
  {
    id: "A1",
    stage: "A",
    subject: "Samsung price list - September 2026",
    attachments: ["Samsung_Price_List.csv"],
    expect: "listed and ticked; saved as Samsung_Price_List.csv",
  },
  {
    id: "A2",
    stage: "A",
    subject: "Seagate pricing update",
    attachments: ["Seagate_Price_List.xlsx"],
    expect:
      "listed and ticked. Untick it for the first download and check it did not land, " +
      "scan again and check it is still selectable, then download it",
  },
  {
    id: "A3",
    stage: "A",
    subject: "TP-Link price list and terms",
    attachments: ["TPLink_Price_List.xlsx", "Dealer_Terms.txt"],
    expect: "only the .xlsx is listed and saved; the .txt is ignored",
  },
  {
    id: "A4",
    stage: "A",
    subject: "Team lunch on Friday",
    attachments: ["Lunch_Menu.xlsx"],
    expect: "NOT listed, and nothing saved",
  },
  {
    id: "B1",
    stage: "B",
    subject: "Samsung price list - resend",
    attachments: ["Samsung_Price_List.csv"],
    expect:
      "listed as new; download reports it skipped as an identical file; the folder is unchanged " +
      "and manifest.json gains one entry",
  },
  {
    id: "B2",
    stage: "B",
    subject: "Samsung price list - revised",
    attachments: ["revised/Samsung_Price_List.csv"],
    expect:
      "listed as new; saved as Samsung_Price_List__<8 characters>.csv; " +
      "the first Samsung file is untouched",
  },
];

const STAGE_INTRO: Record<EmailScenario["stage"], string> = {
  A: "STAGE A  send these four, then click Scan Gmail",
  B: "STAGE B  once Stage A is downloaded, send these two, then scan and download",
};

export function formatChecklist(sampleDir: string): string[] {
  const lines = [
    "Send each email below to the Gmail account the app is connected to.",
    `Attach the files from: ${sampleDir}`,
  ];
  for (const stage of ["A", "B"] as const) {
    lines.push("", STAGE_INTRO[stage]);
    for (const email of EMAILS.filter((candidate) => candidate.stage === stage)) {
      lines.push(
        `  ${email.id}  Subject: "${email.subject}"`,
        `      Attach:  ${email.attachments.join(" and ")}`,
        `      Expect:  ${email.expect}`,
      );
    }
  }
  lines.push(
    "",
    "Afterwards: bun run mock:supplier-files --check-downloads",
    "That compares what the app saved with these files, byte for byte.",
  );
  return lines;
}

// -------------------------------------------------------- download checking

interface ManifestEntry {
  messageId: string;
  savedAs: string;
  sha256: string;
}

export interface SampleResult {
  path: string;
  expectDownload: boolean;
  /** Names it was saved under. More than one only if identical bytes were saved twice. */
  savedAs: string[];
  /** How many emails' attachments the manifest ties to this content. */
  emails: number;
}

export interface DownloadCheck {
  samples: SampleResult[];
  /** Things that are wrong. Any of these fails the check. */
  problems: string[];
  /** Files in the download folder that match no sample. Informational. */
  unrecognised: string[];
  manifestEntries: number;
  distinctFiles: number;
}

function sha256(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

/**
 * Compares what the app saved with the sample files, by content.
 *
 * A sample counts as downloaded only when the manifest ties a saved file with
 * identical bytes to it. That matters: a copy dropped into the folder by hand
 * has the right bytes but no manifest entry, and is reported as a problem
 * instead of passing for the app's work.
 *
 * A sample that was expected but has not been downloaded is not a problem; it
 * may simply not have been emailed yet.
 */
export function checkDownloads(
  sampleDir: string,
  downloadDir: string,
  samples: Pick<SampleFile, "path" | "expectDownload">[] = SAMPLES,
): DownloadCheck {
  const problems: string[] = [];

  const sampleHash = new Map<string, string>();
  for (const sample of samples) {
    const file = join(sampleDir, sample.path);
    if (existsSync(file)) sampleHash.set(sample.path, sha256(readFileSync(file)));
    else problems.push(`Sample file missing: ${sample.path}. Run bun run mock:supplier-files first.`);
  }

  let entries: ManifestEntry[] = [];
  const manifestFile = join(downloadDir, "manifest.json");
  if (existsSync(manifestFile)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(manifestFile, "utf8"));
      if (!Array.isArray(parsed)) throw new Error("it is not a list");
      entries = parsed as ManifestEntry[];
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      problems.push(`manifest.json could not be read: ${reason}`);
    }
  }

  const referenced = new Set<string>();
  for (const entry of entries) {
    referenced.add(entry.savedAs);
    const file = join(downloadDir, entry.savedAs);
    if (!existsSync(file)) {
      problems.push(`manifest.json lists ${entry.savedAs}, which is not in the folder.`);
    } else if (sha256(readFileSync(file)) !== entry.sha256) {
      problems.push(
        `${entry.savedAs} does not match the checksum manifest.json recorded, so it changed after download.`,
      );
    }
  }

  const unrecognised: string[] = [];
  const onDisk = existsSync(downloadDir)
    ? readdirSync(downloadDir).filter(
        (name) =>
          !name.startsWith(".") &&
          name !== "manifest.json" &&
          statSync(join(downloadDir, name)).isFile(),
      )
    : [];
  for (const name of onDisk) {
    if (referenced.has(name)) continue;
    const hash = sha256(readFileSync(join(downloadDir, name)));
    const twin = [...sampleHash].find(([, sampleSha]) => sampleSha === hash);
    if (twin) {
      problems.push(
        `${name} is identical to the sample ${twin[0]} but is not in manifest.json, ` +
          "so the app did not put it there.",
      );
    } else {
      unrecognised.push(name);
    }
  }

  const results = samples.map((sample): SampleResult => {
    const hash = sampleHash.get(sample.path);
    const matches = hash
      ? entries.filter(
          (entry) => entry.sha256 === hash && existsSync(join(downloadDir, entry.savedAs)),
        )
      : [];
    const savedAs = [...new Set(matches.map((entry) => entry.savedAs))];
    if (!sample.expectDownload && savedAs.length > 0) {
      problems.push(`${sample.path} should have been ignored but was saved as ${savedAs.join(", ")}.`);
    }
    return { path: sample.path, expectDownload: sample.expectDownload, savedAs, emails: matches.length };
  });

  return {
    samples: results,
    problems,
    unrecognised,
    manifestEntries: entries.length,
    distinctFiles: referenced.size,
  };
}

export function formatDownloadCheck(check: DownloadCheck): string[] {
  const lines = ["Sample file                      Result"];
  for (const sample of check.samples) {
    const saved = sample.savedAs.join(", ");
    let result: string;
    if (sample.expectDownload) {
      result =
        sample.savedAs.length === 0
          ? "not downloaded yet"
          : `downloaded as ${saved}${sample.emails > 1 ? ` (from ${sample.emails} emails)` : ""}`;
    } else {
      result =
        sample.savedAs.length === 0
          ? "not in the folder (correct; it must never be saved)"
          : `SAVED as ${saved}, but it must be ignored`;
    }
    lines.push(`${sample.path.padEnd(32)} ${result}`);
  }

  const expected = check.samples.filter((sample) => sample.expectDownload);
  const done = expected.filter((sample) => sample.savedAs.length > 0).length;
  lines.push(
    "",
    `${done} of ${expected.length} expected files downloaded.`,
    `manifest.json: ${check.manifestEntries} entries covering ${check.distinctFiles} files.`,
  );
  if (check.unrecognised.length > 0) {
    lines.push(`Other files in the folder (not one of these samples): ${check.unrecognised.join(", ")}`);
  }
  if (check.problems.length > 0) {
    lines.push("", `${check.problems.length} problem(s):`, ...check.problems.map((p) => `  - ${p}`));
  } else {
    lines.push("", "No problems found.");
  }
  return lines;
}

// --------------------------------------------------------------------- main

export function readCatalogue(file: string = PRODUCTS_FILE): Product[] {
  if (!existsSync(file)) {
    throw new Error(`${file} is missing. Run bun run mock:generate first.`);
  }
  return JSON.parse(readFileSync(file, "utf8")) as Product[];
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));

  if (args.has("--check-downloads")) {
    const check = checkDownloads(SAMPLE_DIR, DOWNLOAD_DIR);
    console.log(formatDownloadCheck(check).join("\n"));
    process.exit(check.problems.length > 0 ? 1 : 0);
  }

  const targets = SAMPLES.map((sample) => join(SAMPLE_DIR, sample.path));
  const existing = targets.filter((file) => existsSync(file));
  if (existing.length > 0 && !args.has("--force")) {
    console.error(
      "Refusing to overwrite existing sample files. Regenerating changes their bytes, which " +
        "would make files you already emailed look different from the ones on disk:\n" +
        `${existing.map((file) => `  ${file}`).join("\n")}\nRe-run with --force to replace them.`,
    );
    process.exit(1);
  }

  const catalogue = readCatalogue();
  for (const sample of SAMPLES) {
    const file = join(SAMPLE_DIR, sample.path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, await sample.build(catalogue));
  }

  console.log(`Wrote ${SAMPLES.length} files to ${SAMPLE_DIR}:`);
  for (const sample of SAMPLES) console.log(`  ${sample.path}`);
  console.log(`\n${formatChecklist(SAMPLE_DIR).join("\n")}`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
