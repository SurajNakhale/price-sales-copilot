import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { LlmPort, ProductMatchInput } from "@/lib/llm/port";
import type { ColumnMapping, ManifestEntry, PriceReview, Product } from "@/lib/types";
import { SAMPLES, readCatalogue } from "@/scripts/generate-supplier-files";

// ---------------------------------------------------------------------------
// Sandbox.
//
// lib/config.ts fixes its paths from process.cwd() when it is first imported,
// and bun shares one module cache across test files. So the working directory
// moves to a scratch folder before anything is loaded (for a run of this file
// alone), every fixture is written through the config constants (for a run
// after feature-1.test.ts, which loaded config first), and the suite refuses
// to run at all if those constants point inside the project: approval writes
// the current price list, and it must never be the real one.
// ---------------------------------------------------------------------------

const projectRoot = process.cwd();
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "psc-feature2-"));
process.chdir(tempRoot);

// The Gemini SDK is replaced before lib/llm loads it: no network, scripted answers.
const genaiCalls: Record<string, unknown>[] = [];
const genaiOutputs: string[] = [];
class FakeGoogleGenAI {
  interactions = {
    create: async (params: Record<string, unknown>) => {
      genaiCalls.push(params);
      return { id: `fake-${genaiCalls.length}`, status: "completed", output_text: genaiOutputs.shift() };
    },
  };
}
mock.module("@google/genai", () => ({ GoogleGenAI: FakeGoogleGenAI }));

const config = await import("@/lib/config");
const sandboxRoot = path.resolve(config.PRODUCTS_FILE, "..", "..", "..");
const fromProject = path.relative(projectRoot, sandboxRoot);
// On Windows a folder on another drive comes back as an absolute path, not "..".
if (!fromProject.startsWith("..") && !path.isAbsolute(fromProject)) {
  process.chdir(projectRoot);
  await fs.rm(tempRoot, { recursive: true, force: true });
  throw new Error(`Refusing to run: lib/config points at ${sandboxRoot}, inside the project.`);
}

const { productIdFor, generateProductId } = await import("@/lib/product-id");
const { createMatchingKey } = await import("@/lib/matching-key");
const { parseCsv } = await import("@/lib/parse/csv");
const { parseSpreadsheet } = await import("@/lib/parse/spreadsheet");
const { applyMapping, checkMapping, parseRupees } = await import("@/lib/normalize");
const { matchRows } = await import("@/lib/match");
const { describeCounts, findOutdatedItems, summarizeReviews } = await import("@/lib/compare");
const { fileIdFor } = await import("@/lib/file-id");
const { writeManifest } = await import("@/lib/storage/new-price-lists");
const { readNormalized, readReview } = await import("@/lib/storage/price-reviews");
const { readProducts } = await import("@/lib/data/mock-data");
const { analysePriceList } = await import("@/lib/analyse");
const { approveReview } = await import("@/lib/approve");
const { geminiLlm } = await import("@/lib/llm");
const { toGeminiSchema, columnMappingSchema } = await import("@/lib/llm/schemas");
const { BadRequestError, ConflictError, InvalidLlmOutputError, UnusableFileError } = await import(
  "@/lib/errors"
);

afterAll(async () => {
  process.chdir(projectRoot);
  await fs.rm(tempRoot, { recursive: true, force: true });
  // After feature-1.test.ts, config points at its (already removed) folder,
  // which the fixtures below re-created.
  await fs.rm(sandboxRoot, { recursive: true, force: true });
});

// The real baseline, read from the repo rather than through config.
const catalogue: Product[] = readCatalogue();

const APPROVAL_TIME = new Date("2026-09-21T09:30:00Z");

async function resetSandbox(): Promise<void> {
  await fs.rm(config.NEW_PRICE_LIST_DIR, { recursive: true, force: true });
  await fs.rm(config.DATA_DIR, { recursive: true, force: true });
  await fs.mkdir(config.NEW_PRICE_LIST_DIR, { recursive: true });
  await fs.mkdir(path.dirname(config.PRODUCTS_FILE), { recursive: true });
  await fs.writeFile(config.PRODUCTS_FILE, JSON.stringify(catalogue, null, 2));
  await writeManifest([]);
}

let manifest: ManifestEntry[] = [];

/** Saves a file as Feature 1 would and returns its file ID. */
async function receive(savedAs: string, contents: Buffer | string): Promise<string> {
  await fs.writeFile(path.join(config.NEW_PRICE_LIST_DIR, savedAs), contents);
  const entry: ManifestEntry = {
    messageId: `msg-${manifest.length + 1}`,
    partId: "1",
    savedAs,
    originalName: savedAs,
    from: "Supplier <prices@example.com>",
    subject: "Price list",
    emailDate: "2026-09-20T10:00:00.000Z",
    sha256: "0".repeat(64),
    downloadedAt: "2026-09-21T08:00:00.000Z",
  };
  manifest = [...manifest, entry];
  await writeManifest(manifest);
  return fileIdFor(entry);
}

async function sample(samplePath: string): Promise<Buffer> {
  const found = SAMPLES.find((candidate) => candidate.path === samplePath);
  if (!found) throw new Error(`No sample ${samplePath}`);
  return found.build(catalogue);
}

// ---------------------------------------------------------------------------
// A fake LLM that answers the way a good model would for the sample files.
// ---------------------------------------------------------------------------

const MAPPINGS: Record<string, ColumnMapping> = {
  "Samsung_Price_List.csv": {
    headerRow: 1,
    brand: "Samsung",
    columns: { model: "Model", category: "Type", dealerPrice: "Dealer Price (INR)", mrp: "MRP (INR)" },
  },
  "Seagate_Price_List.xlsx": {
    headerRow: 4,
    brand: "Seagate",
    columns: { model: "SKU Name", category: "Segment", dealerPrice: "DP", mrp: "MRP" },
  },
  "TPLink_Price_List.xlsx": {
    headerRow: 1,
    brand: "TP-Link",
    columns: {
      model: "Model No.",
      category: "Category",
      dealerPrice: "Dealer Net (INR)",
      mrp: "Retail Price (INR)",
    },
  },
};

const SAME_PRODUCT: Record<string, string> = {
  "Portable SSD T7 1TB": "T7 1TB",
  "Archer C6 AC1200": "Archer C6",
  "SEAGATE BARRACUDA-2TB": "Barracuda 2TB",
};

function fakeLlm(overrides: Partial<LlmPort> = {}) {
  const matchCalls: ProductMatchInput[] = [];
  const llm: LlmPort = {
    async proposeColumnMapping(input, check) {
      const key = Object.keys(MAPPINGS).find((name) => input.filename.includes(name.split("_")[0]));
      if (!key) throw new Error(`The fake LLM has no mapping for ${input.filename}`);
      const mapping = MAPPINGS[key];
      const problem = check(mapping);
      if (problem) throw new InvalidLlmOutputError(problem);
      return mapping;
    },
    async proposeProductMatches(input) {
      matchCalls.push(input);
      return input.rows.map((row) => ({
        rowNumber: row.rowNumber,
        productId:
          input.candidates.find((candidate) => candidate.model === SAME_PRODUCT[row.model])
            ?.productId ?? null,
      }));
    },
    ...overrides,
  };
  return { llm, matchCalls };
}

const byModel = (model: string) => {
  const product = catalogue.find((candidate) => candidate.model === model);
  if (!product) throw new Error(`No ${model} in the catalogue`);
  return product;
};

// ---------------------------------------------------------------------------

describe("Product IDs", () => {
  test("productIdFor reproduces every ID in the current price list", () => {
    for (const product of catalogue) {
      expect(productIdFor(product.brand, product.model)).toBe(product.productId);
    }
  });

  test("a new model gets the plain ID when it is free", () => {
    const ids = new Set(catalogue.map((product) => product.productId));
    expect(generateProductId("Samsung", "T9 1TB", ids)).toBe(productIdFor("Samsung", "T9 1TB"));
  });

  test("a taken ID is re-hashed, deterministically, keeping the brand code", () => {
    const plain = productIdFor("Samsung", "T9 1TB");
    const taken = new Set([plain]);
    const next = generateProductId("Samsung", "T9 1TB", taken);
    expect(next).not.toBe(plain);
    expect(next).toMatch(/^SAM-[0-9A-F]{5}$/);
    expect(generateProductId("Samsung", "T9 1TB", taken)).toBe(next);
  });
});

describe("matching key", () => {
  test("case, punctuation, a brand prefix and unit spacing do not matter", () => {
    expect(createMatchingKey("Seagate", "SEAGATE BARRACUDA-2TB")).toBe(
      createMatchingKey("Seagate", "Barracuda 2TB"),
    );
    expect(createMatchingKey("TP-Link", "TP-Link Archer C6")).toBe(
      createMatchingKey("TP-Link", "Archer C6"),
    );
    expect(createMatchingKey("TP-Link", "tplink archer c6")).toBe(
      createMatchingKey("TP-Link", "Archer C6"),
    );
    expect(createMatchingKey("Samsung", "Samsung T7 1 TB")).toBe(createMatchingKey("Samsung", "T7 1TB"));
  });

  test("different products, extra words and other brands stay different", () => {
    expect(createMatchingKey("Samsung", "T7 2TB")).not.toBe(createMatchingKey("Samsung", "T7 1TB"));
    expect(createMatchingKey("Samsung", "Portable SSD T7 1TB")).not.toBe(
      createMatchingKey("Samsung", "T7 1TB"),
    );
    expect(createMatchingKey("Seagate", "T7 1TB")).not.toBe(createMatchingKey("Samsung", "T7 1TB"));
    // Only a leading brand name is dropped.
    expect(createMatchingKey("Samsung", "T7 Samsung 1TB")).not.toBe(
      createMatchingKey("Samsung", "T7 1TB"),
    );
  });
});

describe("CSV parser", () => {
  test("handles quotes, escaped quotes, commas inside quotes, CRLF and a BOM", () => {
    const text = '﻿Model,Note\r\n"T7, 1TB","say ""hi"""\r\nplain,\r\n';
    expect(parseCsv(text)).toEqual([
      ["Model", "Note"],
      ["T7, 1TB", 'say "hi"'],
      ["plain", ""],
    ]);
  });

  test("reads a last line with no newline, and LF endings", () => {
    expect(parseCsv("a,b\nc,d")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });
});

describe("normalising", () => {
  test("money: numbers and rupee text become whole rupees; anything else is refused", () => {
    expect(parseRupees(7500)).toBe(7500);
    expect(parseRupees("₹7,500")).toBe(7500);
    expect(parseRupees("7500 INR")).toBe(7500);
    expect(parseRupees("Rs. 7,500.00")).toBe(7500);
    expect(parseRupees(7500.5)).toBeNull();
    expect(parseRupees("0")).toBeNull();
    expect(parseRupees("call us")).toBeNull();
    expect(parseRupees(null)).toBeNull();
  });

  test("Seagate's title rows are skipped by the header row, and every product row is read", async () => {
    const sheet = await parseSpreadsheet("Seagate_Price_List.xlsx", await sample("Seagate_Price_List.xlsx"));
    expect(sheet.sheet).toBe("Price List");
    const mapping = MAPPINGS["Seagate_Price_List.xlsx"];
    expect(checkMapping(sheet, mapping)).toBeNull();

    const { rows, issues } = applyMapping(sheet, mapping, "Seagate");
    expect(issues).toEqual([]);
    expect(rows).toHaveLength(10);
    expect(rows[0]).toEqual({
      rowNumber: 5,
      supplierModel: "Barracuda 1TB",
      category: "HDD",
      dealerPrice: 3200,
      mrp: 4500,
    });
  });

  test("a mapping naming a column that is not in the header row is rejected with the reason", async () => {
    const sheet = await parseSpreadsheet("Samsung_Price_List.csv", await sample("Samsung_Price_List.csv"));
    const good = MAPPINGS["Samsung_Price_List.csv"];
    expect(checkMapping(sheet, good)).toBeNull();
    expect(checkMapping(sheet, { ...good, columns: { ...good.columns, mrp: "Retail" } })).toMatch(
      /"Retail" for mrp is not in header row 1/,
    );
    expect(checkMapping(sheet, { ...good, columns: { ...good.columns, mrp: "Dealer Price (INR)" } })).toMatch(
      /used for both dealerPrice and mrp/,
    );
    expect(checkMapping(sheet, { ...good, headerRow: 40 })).toMatch(/does not exist/);
  });

  test("unusable rows become issues with reasons, never silent drops", () => {
    const sheet = {
      sheet: null,
      rows: [
        ["Model", "DP", "MRP"],
        ["T7 1TB", "7,500", "10499"],
        ["", "", ""],
        ["", "100", "200"],
        ["T7 2TB", "TBA", "17499"],
        ["T9 1TB", "12000", "11999"],
        ["t7-1tb", "7400", "10499"],
      ],
    };
    const mapping: ColumnMapping = {
      headerRow: 1,
      brand: "Samsung",
      columns: { model: "Model", category: null, dealerPrice: "DP", mrp: "MRP" },
    };
    const { rows, issues } = applyMapping(sheet, mapping, "Samsung");

    expect(rows).toEqual([
      { rowNumber: 2, supplierModel: "T7 1TB", category: null, dealerPrice: 7500, mrp: 10499 },
    ]);
    expect(issues.map((issue) => issue.rowNumber)).toEqual([4, 5, 6, 7]);
    expect(issues[0].reason).toMatch(/No model/);
    expect(issues[1].reason).toMatch(/dealer price "TBA"/);
    expect(issues[2].reason).toMatch(/above MRP/);
    expect(issues[3].reason).toMatch(/same product as row 2/);
  });
});

describe("matching", () => {
  const mapped = [
    { rowNumber: 2, supplierModel: "SAMSUNG T7 1TB", category: "SSD", dealerPrice: 7500, mrp: 10499 },
    { rowNumber: 3, supplierModel: "Portable T7 2TB", category: "SSD", dealerPrice: 13000, mrp: 17499 },
    { rowNumber: 4, supplierModel: "Mystery Drive", category: "SSD", dealerPrice: 100, mrp: 200 },
    { rowNumber: 5, supplierModel: "Another Mystery", category: "SSD", dealerPrice: 100, mrp: 200 },
  ];

  test("an LLM answer outside the candidates, or already taken, becomes a new product", async () => {
    const t7 = byModel("T7 1TB").productId;
    const t72 = byModel("T7 2TB").productId;
    const seagateId = byModel("Barracuda 1TB").productId;

    let seen: ProductMatchInput | null = null;
    const llm: LlmPort = {
      proposeColumnMapping: async () => {
        throw new Error("not used");
      },
      proposeProductMatches: async (input) => {
        seen = input;
        return [
          { rowNumber: 3, productId: t72 }, // fine
          { rowNumber: 4, productId: t7 }, // already claimed by the key match on row 2
          { rowNumber: 5, productId: seagateId }, // another brand: not a candidate
        ];
      },
    };

    const rows = await matchRows("Samsung", mapped, catalogue, llm);

    // Only the rows the key could not place went to the LLM, with unclaimed candidates only.
    expect(seen!.rows.map((row) => row.rowNumber)).toEqual([3, 4, 5]);
    expect(seen!.candidates.some((candidate) => candidate.productId === t7)).toBe(false);
    expect(seen!.candidates.every((candidate) => candidate.productId.startsWith("SAM-"))).toBe(true);

    expect(rows.map((row) => [row.rowNumber, row.match])).toEqual([
      [2, "key"],
      [3, "llm"],
      [4, "new"],
      [5, "new"],
    ]);
    expect(rows[0]).toMatchObject({ productId: t7, model: "T7 1TB", supplierModel: "SAMSUNG T7 1TB" });
    expect(rows[1]).toMatchObject({ productId: t72, model: "T7 2TB" });
    expect(rows[2].productId).toBe(productIdFor("Samsung", "Mystery Drive"));
    expect(new Set(rows.map((row) => row.productId)).size).toBe(4);
  });

  test("the LLM is not called when the key places every row", async () => {
    const llm: LlmPort = {
      proposeColumnMapping: async () => {
        throw new Error("not used");
      },
      proposeProductMatches: async () => {
        throw new Error("should not be called");
      },
    };
    const rows = await matchRows("Samsung", mapped.slice(0, 1), catalogue, llm);
    expect(rows[0].match).toBe("key");
  });
});

describe("analysing the sample supplier files", () => {
  beforeEach(async () => {
    manifest = [];
    await resetSandbox();
  });

  const cases = [
    {
      file: "Samsung_Price_List.csv",
      brand: "Samsung",
      changed: ["T7 1TB", "T7 2TB", "870 EVO 500GB"],
      added: "T9 1TB",
      missing: "990 EVO 1TB",
      renamed: { model: "T7 1TB", supplierModel: "Portable SSD T7 1TB", match: "llm" },
    },
    {
      file: "Seagate_Price_List.xlsx",
      brand: "Seagate",
      changed: ["Barracuda 2TB", "IronWolf 4TB", "FireCuda 530 1TB"],
      added: "IronWolf 8TB",
      missing: "One Touch 2TB",
      renamed: { model: "Barracuda 2TB", supplierModel: "SEAGATE BARRACUDA-2TB", match: "key" },
    },
    {
      file: "TPLink_Price_List.xlsx",
      brand: "TP-Link",
      changed: ["Archer C6", "Archer AX55", "TL-SG108"],
      added: "Archer AX53",
      missing: "TL-WR841N",
      renamed: { model: "Archer C6", supplierModel: "Archer C6 AC1200", match: "llm" },
    },
  ] as const;

  for (const expected of cases) {
    test(`${expected.brand}: 3 price changes, 1 new, 1 missing, renamed row matched by ${expected.renamed.match}`, async () => {
      const fileId = await receive(expected.file, await sample(expected.file));
      const { llm, matchCalls } = fakeLlm();

      const review = await analysePriceList(fileId, llm);

      expect(review.status).toBe("needs-review");
      expect(review.brand).toBe(expected.brand);
      expect(review.rowsInFile).toBe(10);
      expect(review.unchanged).toBe(6);
      expect(review.issues).toBe(0);

      const kinds = (kind: string) => review.items.filter((item) => item.kind === kind);
      expect(kinds("price-change").map((item) => item.model).sort()).toEqual([...expected.changed].sort());
      expect(kinds("new-product").map((item) => item.model)).toEqual([expected.added]);
      expect(kinds("new-product")[0].productId).toBe(productIdFor(expected.brand, expected.added));
      expect(kinds("missing").map((item) => item.model)).toEqual([expected.missing]);

      const renamed = review.items.find((item) => item.model === expected.renamed.model);
      expect(renamed).toMatchObject({
        kind: "price-change",
        productId: byModel(expected.renamed.model).productId,
        supplierModel: expected.renamed.supplierModel,
        match: expected.renamed.match,
      });

      // Rows the key resolved never reach the LLM.
      const sentToLlm = matchCalls.flatMap((call) => call.rows.map((row) => row.model));
      expect(sentToLlm).toContain(expected.added);
      if (expected.renamed.match === "key") {
        expect(sentToLlm).not.toContain(expected.renamed.supplierModel);
      }

      // The separate normalised object was saved, in the standard shape.
      const normalized = await readNormalized(fileId);
      expect(normalized?.rows).toHaveLength(10);
      expect(normalized?.brand).toBe(expected.brand);
      expect(Object.keys(normalized!.rows[0]).sort()).toEqual(
        ["brand", "category", "dealerPrice", "match", "model", "mrp", "productId", "rowNumber", "supplierModel"].sort(),
      );
    });
  }

  test("prices in the review are the file's cells, old values are the catalogue's", async () => {
    const fileId = await receive("Samsung_Price_List.csv", await sample("Samsung_Price_List.csv"));
    const review = await analysePriceList(fileId, fakeLlm().llm);
    const t7 = review.items.find((item) => item.model === "T7 1TB");
    expect(t7).toMatchObject({
      old: { dealerPrice: 7000, mrp: 9999 },
      new: { dealerPrice: 7500, mrp: 10499 },
    });
  });

  test("a file identical to the catalogue has no changes", async () => {
    const rows = catalogue
      .filter((product) => product.brand === "TP-Link")
      .map((product) => `${product.model},${product.category},${product.dealerPrice},${product.mrp}`);
    const csv = `Model No.,Category,Dealer Net (INR),Retail Price (INR)\n${rows.join("\n")}\n`;
    const fileId = await receive("TPLink_Price_List.csv", csv);

    const review = await analysePriceList(fileId, fakeLlm().llm);
    expect(review.status).toBe("no-changes");
    expect(review.items).toEqual([]);
    expect(review.unchanged).toBe(10);
  });

  test("a failed analysis is recorded with its reason, and Retry replaces it", async () => {
    const fileId = await receive("Samsung_Price_List.csv", await sample("Samsung_Price_List.csv"));
    const broken = fakeLlm({
      async proposeColumnMapping(_input, check) {
        const mapping = MAPPINGS["Samsung_Price_List.csv"];
        const problem = check({ ...mapping, columns: { ...mapping.columns, mrp: "Retail" } });
        throw new InvalidLlmOutputError(problem ?? "unexpected");
      },
    });

    await expect(analysePriceList(fileId, broken.llm)).rejects.toBeInstanceOf(InvalidLlmOutputError);
    const failed = await readReview(fileId);
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toMatch(/"Retail" for mrp is not in header row/);

    const retried = await analysePriceList(fileId, fakeLlm().llm);
    expect(retried.status).toBe("needs-review");
  });

  test("an unknown file ID is not found", async () => {
    await expect(analysePriceList("0123456789ab", fakeLlm().llm)).rejects.toThrow(/No downloaded price list/);
  });
});

describe("approving", () => {
  let samsung: string;
  let revised: string;
  let review: PriceReview;

  beforeEach(async () => {
    manifest = [];
    await resetSandbox();
    samsung = await receive("Samsung_Price_List.csv", await sample("Samsung_Price_List.csv"));
    revised = await receive(
      "Samsung_Price_List__rev.csv",
      await sample("revised/Samsung_Price_List.csv"),
    );
    review = await analysePriceList(samsung, fakeLlm().llm);
  });

  const itemId = (model: string, kind: string) => {
    const item = review.items.find((candidate) => candidate.model === model && candidate.kind === kind);
    if (!item) throw new Error(`No ${kind} item for ${model}`);
    return item.itemId;
  };

  test("writes only the selected items, and records them as applied", async () => {
    const selected = [
      itemId("T7 1TB", "price-change"),
      itemId("T9 1TB", "new-product"),
      itemId("990 EVO 1TB", "missing"),
    ];
    const approved = await approveReview(samsung, selected, APPROVAL_TIME);

    expect(approved.status).toBe("approved");
    expect(approved.applied).toEqual(selected);
    expect(approved.approvedAt).toBe(APPROVAL_TIME.toISOString());

    const products = await readProducts();
    const find = (model: string) => products.find((product) => product.model === model);

    expect(find("T7 1TB")).toMatchObject({ dealerPrice: 7500, mrp: 10499 });
    expect(find("T7 2TB")).toMatchObject({ dealerPrice: 12500, mrp: 16999 }); // not selected
    expect(find("870 EVO 500GB")?.dealerPrice).toBe(4300); // not selected
    expect(find("T9 1TB")).toEqual({
      productId: productIdFor("Samsung", "T9 1TB"),
      brand: "Samsung",
      model: "T9 1TB",
      category: "SSD",
      dealerPrice: 8500,
      mrp: 11999,
    });
    // Deactivated, never deleted: its sales history still resolves.
    expect(find("990 EVO 1TB")).toMatchObject({ status: "discontinued", discontinuedOn: "2026-09-21" });
    expect(products).toHaveLength(catalogue.length + 1);
    // Everything else is untouched.
    const untouched = products.filter(
      (product) => !["T7 1TB", "T9 1TB", "990 EVO 1TB"].includes(product.model),
    );
    expect(untouched).toEqual(
      catalogue.filter((product) => !["T7 1TB", "990 EVO 1TB"].includes(product.model)),
    );
  });

  test("a review is approved once, and an approved file cannot be re-analysed", async () => {
    await approveReview(samsung, [itemId("T7 2TB", "price-change")], APPROVAL_TIME);
    await expect(approveReview(samsung, [itemId("T7 1TB", "price-change")])).rejects.toBeInstanceOf(
      ConflictError,
    );
    await expect(analysePriceList(samsung, fakeLlm().llm)).rejects.toBeInstanceOf(ConflictError);
  });

  test("nothing selected, or an item from elsewhere, is a bad request", async () => {
    await expect(approveReview(samsung, [])).rejects.toBeInstanceOf(BadRequestError);
    await expect(approveReview(samsung, ["price-change:SAM-00000"])).rejects.toBeInstanceOf(
      BadRequestError,
    );
    expect(await readProducts()).toEqual(catalogue);
  });

  test("an item made out of date by another file's approval blocks the whole approval", async () => {
    const other = await analysePriceList(revised, fakeLlm().llm);
    await approveReview(
      samsung,
      [itemId("T7 1TB", "price-change"), itemId("T9 1TB", "new-product"), itemId("990 EVO 1TB", "missing")],
      APPROVAL_TIME,
    );
    const afterFirst = await readProducts();

    const otherItem = (model: string, kind: string) =>
      other.items.find((item) => item.model === model && item.kind === kind)!;

    // The page warns before anyone clicks: all three premises are gone.
    expect(
      findOutdatedItems(
        [otherItem("T7 1TB", "price-change"), otherItem("T9 1TB", "new-product"), otherItem("990 EVO 1TB", "missing")],
        afterFirst,
      ).map((item) => item.itemId),
    ).toEqual([
      otherItem("T7 1TB", "price-change").itemId,
      otherItem("T9 1TB", "new-product").itemId,
      otherItem("990 EVO 1TB", "missing").itemId,
    ]);

    // One outdated item among good ones: nothing is written.
    await expect(
      approveReview(revised, [otherItem("T7 2TB", "price-change").itemId, otherItem("T7 1TB", "price-change").itemId]),
    ).rejects.toThrow(/Analyse the file again/);
    expect(await readProducts()).toEqual(afterFirst);

    // The untouched item alone still goes through.
    await approveReview(revised, [otherItem("T7 2TB", "price-change").itemId], APPROVAL_TIME);
    expect((await readProducts()).find((product) => product.model === "T7 2TB")?.dealerPrice).toBe(13000);
  });

  test("a supplier listing a discontinued product again reactivates it, keeping its ID", async () => {
    await approveReview(samsung, [itemId("990 EVO 1TB", "missing")], APPROVAL_TIME);

    const evo = byModel("990 EVO 1TB");
    const csv = `Model,Type,Dealer Price (INR),MRP (INR)\n990 EVO 1TB,SSD,7400,10299\n`;
    const back = await receive("Samsung_Price_List__back.csv", csv);
    const again = await analysePriceList(back, fakeLlm().llm);
    const item = again.items.find((candidate) => candidate.productId === evo.productId);
    expect(item).toMatchObject({ kind: "new-product", reactivates: true, model: "990 EVO 1TB" });

    await approveReview(back, [item!.itemId], APPROVAL_TIME);
    const product = (await readProducts()).find((candidate) => candidate.productId === evo.productId);
    expect(product).toEqual({ ...evo, dealerPrice: 7400, mrp: 10299 });
  });
});

describe("review summaries", () => {
  test("— until something is analysed, then counts per kind", () => {
    expect(summarizeReviews([])).toBeNull();

    const base = {
      sourceFile: "x.csv",
      brand: "Samsung" as const,
      rowsInFile: 10,
      unchanged: 5,
      issues: 0,
      analysedAt: "2026-09-21T00:00:00Z",
    };
    const item = (kind: "price-change" | "new-product" | "missing", n: number) =>
      ({ kind, itemId: `${kind}:${n}` }) as unknown as PriceReview["items"][number];

    const totals = summarizeReviews([
      {
        ...base,
        fileId: "a",
        status: "needs-review",
        items: [item("price-change", 1), item("price-change", 2), item("new-product", 3), item("missing", 4)],
      },
      { ...base, fileId: "b", status: "approved", items: [item("price-change", 5)], applied: ["price-change:5"] },
      { ...base, fileId: "c", status: "failed", items: [], error: "x" },
    ]);

    expect(totals).toEqual({
      analysedFiles: 2,
      priceChanges: 3,
      needsReview: { priceChanges: 2, newProducts: 1, missing: 1, total: 4 },
    });
    expect(describeCounts({ priceChanges: 3, newProducts: 1, missing: 0 })).toBe("3 price · 1 new");
    expect(describeCounts({ priceChanges: 0, newProducts: 0, missing: 0 })).toBe("No changes");
  });
});

describe("Gemini wrapper", () => {
  const mappingAnswer = {
    headerRow: 1,
    brand: "Samsung",
    model: "Model",
    category: "Type",
    dealerPrice: "Dealer Price (INR)",
    mrp: "MRP (INR)",
  };
  const input = {
    filename: "Samsung_Price_List.csv",
    from: "x",
    subject: "y",
    sheet: null,
    rows: [{ rowNumber: 1, cells: ["Model", "Type", "Dealer Price (INR)", "MRP (INR)"] }],
  };
  const check = (mapping: ColumnMapping) =>
    mapping.columns.mrp === "MRP (INR)" ? null : `Column "${mapping.columns.mrp}" is not in the header.`;

  beforeEach(() => {
    genaiCalls.length = 0;
    genaiOutputs.length = 0;
    process.env.GEMINI_API_KEY = "test-key";
  });
  afterAll(() => {
    delete process.env.GEMINI_API_KEY;
  });

  test("sends a Gemini-safe schema, does not store the interaction, and parses the answer", async () => {
    genaiOutputs.push(JSON.stringify(mappingAnswer));
    const mapping = await geminiLlm.proposeColumnMapping(input, check);

    expect(mapping).toEqual({
      headerRow: 1,
      brand: "Samsung",
      columns: { model: "Model", category: "Type", dealerPrice: "Dealer Price (INR)", mrp: "MRP (INR)" },
    });
    const call = genaiCalls[0] as { store: boolean; input: string; response_format: { schema: object } };
    expect(call.store).toBe(false);
    expect(call.input).toContain("<file>");
    expect(JSON.stringify(call.response_format.schema)).not.toMatch(/\$schema|additionalProperties/);
  });

  test("one retry that names the problem, then success", async () => {
    genaiOutputs.push(JSON.stringify({ ...mappingAnswer, mrp: "Retail" }), JSON.stringify(mappingAnswer));
    const mapping = await geminiLlm.proposeColumnMapping(input, check);
    expect(mapping.columns.mrp).toBe("MRP (INR)");
    expect(genaiCalls).toHaveLength(2);
    expect((genaiCalls[1] as { input: string }).input).toMatch(/rejected: Column "Retail"/);
  });

  test("two bad answers are an error, never accepted", async () => {
    genaiOutputs.push("not json", JSON.stringify({ ...mappingAnswer, headerRow: 0 }));
    await expect(geminiLlm.proposeColumnMapping(input, check)).rejects.toBeInstanceOf(InvalidLlmOutputError);
  });

  test("an unknown brand stops the analysis without a retry", async () => {
    genaiOutputs.push(JSON.stringify({ ...mappingAnswer, brand: "unknown" }));
    await expect(geminiLlm.proposeColumnMapping(input, check)).rejects.toBeInstanceOf(UnusableFileError);
    expect(genaiCalls).toHaveLength(1);
  });

  test("an empty product ID means no match", async () => {
    genaiOutputs.push(JSON.stringify({ matches: [{ rowNumber: 3, productId: "" }] }));
    const proposals = await geminiLlm.proposeProductMatches({
      brand: "Samsung",
      rows: [{ rowNumber: 3, model: "X", category: null }],
      candidates: [{ productId: "SAM-B072D", model: "T7 1TB", category: "SSD" }],
    });
    expect(proposals).toEqual([{ rowNumber: 3, productId: null }]);
  });

  test("the derived schema keeps the fields and the brand enum", () => {
    const schema = toGeminiSchema(columnMappingSchema) as {
      properties: Record<string, { enum?: string[] }>;
    };
    expect(Object.keys(schema.properties)).toEqual([
      "headerRow",
      "brand",
      "model",
      "category",
      "dealerPrice",
      "mrp",
    ]);
    expect(schema.properties.brand.enum).toEqual(["Seagate", "Samsung", "TP-Link", "unknown"]);
  });
});
