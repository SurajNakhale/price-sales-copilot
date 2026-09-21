import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { hasAllowedExtension } from "@/lib/config";
import {
  EMAILS,
  SAMPLES,
  SAMSUNG_REVISED,
  SUPPLIERS,
  type SupplierSpec,
  buildSupplierRows,
  checkDownloads,
  formatChecklist,
  formatDownloadCheck,
  readCatalogue,
  toCsv,
} from "@/scripts/generate-supplier-files";

// readCatalogue() resolves the repo's mock-data from this file's location, not
// from process.cwd(), which feature-1.test.ts moves to a temp folder.
const catalogue = readCatalogue();

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "psc-samples-"));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

/** Writes the real samples into a fresh folder, as the generator would. */
async function writeSamples(name: string): Promise<string> {
  const dir = path.join(scratch, name);
  for (const sample of SAMPLES) {
    const file = path.join(dir, sample.path);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, await sample.build(catalogue));
  }
  return dir;
}

/** A download folder holding the given files and a manifest describing them. */
function downloadFolder(
  name: string,
  files: Record<string, Buffer | string>,
  manifest: { savedAs: string; from?: string }[],
): string {
  const dir = path.join(scratch, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, file), contents);
  }
  const entries = manifest.map((entry, index) => ({
    messageId: `msg${index}`,
    partId: "1",
    savedAs: entry.savedAs,
    sha256: sha(fs.readFileSync(path.join(dir, entry.savedAs))),
  }));
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(entries));
  return dir;
}

const sampleBytes = (dir: string, samplePath: string) => fs.readFileSync(path.join(dir, samplePath));

// ---------------------------------------------------------------------------

describe("each supplier file differs from the current price list as documented", () => {
  const cases: [string, SupplierSpec][] = [
    ["Samsung", SUPPLIERS.samsung],
    ["Seagate", SUPPLIERS.seagate],
    ["TP-Link", SUPPLIERS.tplink],
  ];

  for (const [label, spec] of cases) {
    test(`${label}: 3 price changes, 1 new product, 1 left out, nothing else`, () => {
      const rows = buildSupplierRows(catalogue, spec);
      const own = catalogue.filter((product) => product.brand === spec.brand);
      const before = new Map(own.map((product) => [product.model, product]));
      const after = new Map(rows.map((row) => [row.catalogueModel, row]));

      // Worked out here from the two lists, independently of how the rows were built.
      const changed = [...after.values()]
        .filter((row) => {
          const old = before.get(row.catalogueModel);
          return old && (old.dealerPrice !== row.dealerPrice || old.mrp !== row.mrp);
        })
        .map((row) => row.catalogueModel);
      const added = [...after.keys()].filter((model) => !before.has(model));
      const omitted = [...before.keys()].filter((model) => !after.has(model));

      expect(changed.sort()).toEqual(spec.changes.map((change) => change.model).sort());
      expect(changed).toHaveLength(3);
      expect(added).toEqual([spec.added.model]);
      expect(omitted).toEqual([spec.omitted]);
      expect(rows).toHaveLength(own.length); // one out, one in
    });

    test(`${label}: exactly one row is spelled differently from the catalogue`, () => {
      const renamed = buildSupplierRows(catalogue, spec).filter(
        (row) => row.model !== row.catalogueModel,
      );
      expect(renamed).toHaveLength(1);
      // Renamed rows are price changes, so a matching mistake shows up as a wrong change.
      expect(spec.changes.map((change) => change.model)).toContain(renamed[0].catalogueModel);
    });
  }

  test("the renamed rows are the ones mock-data.md and the Feature 2 spec quote", () => {
    const renamed = [SUPPLIERS.samsung, SUPPLIERS.seagate, SUPPLIERS.tplink].flatMap((spec) =>
      buildSupplierRows(catalogue, spec)
        .filter((row) => row.model !== row.catalogueModel)
        .map((row) => [row.catalogueModel, row.model]),
    );
    expect(renamed).toEqual([
      ["T7 1TB", "Portable SSD T7 1TB"],
      ["Barracuda 2TB", "SEAGATE BARRACUDA-2TB"],
      ["Archer C6", "Archer C6 AC1200"],
    ]);
  });

  test("Samsung carries the figures the design and docs quote", () => {
    const rows = new Map(
      buildSupplierRows(catalogue, SUPPLIERS.samsung).map((row) => [row.catalogueModel, row]),
    );
    expect(rows.get("T7 1TB")).toMatchObject({ dealerPrice: 7500, mrp: 10499 });
    expect(rows.get("T7 2TB")).toMatchObject({ dealerPrice: 13000, mrp: 17499 });
    // A dealer-price-only change leaves MRP as it was.
    expect(rows.get("870 EVO 500GB")).toMatchObject({ dealerPrice: 4500, mrp: 5999 });
    expect(rows.get("T9 1TB")).toMatchObject({ category: "SSD", dealerPrice: 8500, mrp: 11999 });
    expect(rows.has("990 EVO 1TB")).toBe(false);
  });

  test("the revised Samsung list differs from the first by exactly one price", () => {
    const first = buildSupplierRows(catalogue, SUPPLIERS.samsung);
    const revised = buildSupplierRows(catalogue, SAMSUNG_REVISED);
    const differing = revised.filter((row, i) => JSON.stringify(row) !== JSON.stringify(first[i]));
    expect(differing).toEqual([
      {
        model: "Portable SSD T7 1TB",
        catalogueModel: "T7 1TB",
        category: "SSD",
        dealerPrice: 7450,
        mrp: 10499,
      },
    ]);
  });

  test("Seagate keeps its supplier-style title block above the header", () => {
    expect(SUPPLIERS.seagate.titleRows).toHaveLength(3);
  });

  test("a spec naming a model the catalogue lacks is rejected, not silently skipped", () => {
    const bad: SupplierSpec = { ...SUPPLIERS.samsung, omitted: "No Such Drive 9TB" };
    expect(() => buildSupplierRows(catalogue, bad)).toThrow(/not in the current price list/);
  });

  test("a change that changes nothing is rejected", () => {
    const bad: SupplierSpec = {
      ...SUPPLIERS.samsung,
      changes: [{ model: "T7 1TB", dealerPrice: 7000 }], // the current price
    };
    expect(() => buildSupplierRows(catalogue, bad)).toThrow(/prices are identical/);
  });

  test("a 'new' product that already exists is rejected", () => {
    const bad: SupplierSpec = {
      ...SUPPLIERS.samsung,
      added: { model: "T7 1TB", category: "SSD", dealerPrice: 1, mrp: 2 },
    };
    expect(() => buildSupplierRows(catalogue, bad)).toThrow(/already in the current price list/);
  });
});

describe("the samples agree with the app's own rules", () => {
  test("downloadable samples have an extension the app accepts", () => {
    for (const sample of SAMPLES.filter((s) => s.expectDownload)) {
      expect(hasAllowedExtension(path.basename(sample.path))).toBe(true);
    }
  });

  test("a sample ignored for its extension is one the app rejects", () => {
    for (const sample of SAMPLES.filter((s) => s.whyIgnored === "extension")) {
      expect(hasAllowedExtension(path.basename(sample.path))).toBe(false);
    }
  });

  // The lunch menu is a valid .xlsx. It is skipped because its email does not
  // look like a price list, which only means anything if the extension passes.
  test("a sample ignored as an unrelated email does have an acceptable extension", () => {
    for (const sample of SAMPLES.filter((s) => s.whyIgnored === "unrelated email")) {
      expect(hasAllowedExtension(path.basename(sample.path))).toBe(true);
    }
  });

  test("every ignored sample says why", () => {
    for (const sample of SAMPLES.filter((s) => !s.expectDownload)) {
      expect(sample.whyIgnored).toBeDefined();
    }
  });
});

describe("the email checklist", () => {
  const byPath = new Map(SAMPLES.map((sample) => [sample.path, sample]));

  test("has unique ids and puts Stage A before Stage B", () => {
    const ids = EMAILS.map((email) => email.id);
    expect(new Set(ids).size).toBe(ids.length);
    const firstB = EMAILS.findIndex((email) => email.stage === "B");
    expect(EMAILS.slice(firstB).every((email) => email.stage === "B")).toBe(true);
  });

  test("attaches only files that exist in the sample set", () => {
    for (const email of EMAILS) {
      for (const attachment of email.attachments) expect(byPath.has(attachment)).toBe(true);
    }
  });

  test("uses every sample file at least once", () => {
    const used = new Set(EMAILS.flatMap((email) => email.attachments));
    for (const sample of SAMPLES) expect(used.has(sample.path)).toBe(true);
  });

  // buildGmailQuery() requires "price" or "pricing" in the subject, or "price"
  // in a filename. Emails meant to be found must satisfy that; the one meant
  // to be missed must not.
  test("subjects are written to match, or deliberately miss, the Gmail query", () => {
    const looksLikePriceList = (email: (typeof EMAILS)[number]) =>
      /\bpric(e|ing)\b/i.test(email.subject) ||
      email.attachments.some((file) => /price/i.test(path.basename(file)));

    for (const email of EMAILS) {
      const meantToBeFound = email.attachments.some((file) => byPath.get(file)?.expectDownload);
      expect(looksLikePriceList(email)).toBe(meantToBeFound);
    }
  });

  test("prints every email with its subject and attachments", () => {
    const text = formatChecklist("C:\\samples").join("\n");
    for (const email of EMAILS) {
      expect(text).toContain(email.id);
      expect(text).toContain(`"${email.subject}"`);
    }
    expect(text).toContain("C:\\samples");
    expect(text).toContain("--check-downloads");
  });
});

describe("CSV output", () => {
  test("quotes cells holding commas, quotes or newlines and doubles embedded quotes", () => {
    expect(toCsv([["a,b", 'say "hi"', "two\nlines", 5]])).toBe('"a,b","say ""hi""","two\nlines",5\r\n');
  });

  test("leaves plain cells bare and ends every row with CRLF", () => {
    expect(toCsv([["Model", "MRP"], ["T7 1TB", 9999]])).toBe("Model,MRP\r\nT7 1TB,9999\r\n");
  });

  test("the Samsung sample is a header plus ten rows, with numbers unquoted", async () => {
    const sample = SAMPLES.find((s) => s.path === "Samsung_Price_List.csv");
    const lines = (await sample!.build(catalogue)).toString("utf8").trimEnd().split("\r\n");
    expect(lines[0]).toBe("Model,Type,Dealer Price (INR),MRP (INR)");
    expect(lines).toHaveLength(11);
    expect(lines).toContain("Portable SSD T7 1TB,SSD,7500,10499");
  });
});

describe("generated files", () => {
  test("xlsx samples are zip archives", async () => {
    for (const sample of SAMPLES.filter((s) => s.path.endsWith(".xlsx"))) {
      const bytes = await sample.build(catalogue);
      expect([...bytes.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04"
    }
  });

  test("the two Samsung files share a name but not their contents", async () => {
    const dir = await writeSamples("names");
    const first = sampleBytes(dir, "Samsung_Price_List.csv");
    const revised = sampleBytes(dir, "revised/Samsung_Price_List.csv");
    expect(path.basename("revised/Samsung_Price_List.csv")).toBe("Samsung_Price_List.csv");
    expect(sha(first)).not.toBe(sha(revised));
  });
});

describe("checkDownloads", () => {
  test("nothing downloaded yet is not a failure, just pending", async () => {
    const samples = await writeSamples("s-empty");
    const empty = path.join(scratch, "d-empty");
    fs.mkdirSync(empty);

    const check = checkDownloads(samples, empty);
    expect(check.problems).toEqual([]);
    expect(check.samples.every((sample) => sample.savedAs.length === 0)).toBe(true);
    expect(formatDownloadCheck(check).join("\n")).toContain("0 of 4 expected files downloaded");
  });

  test("a folder that does not exist yet behaves like an empty one", async () => {
    const samples = await writeSamples("s-nofolder");
    const check = checkDownloads(samples, path.join(scratch, "does-not-exist"));
    expect(check.problems).toEqual([]);
  });

  // What the app leaves behind after Stage A and Stage B: the resend adds a
  // manifest entry but no file, and the revised list gets the message-id suffix.
  test("the full Stage A and B outcome passes", async () => {
    const samples = await writeSamples("s-full");
    const dir = downloadFolder(
      "d-full",
      {
        "Samsung_Price_List.csv": sampleBytes(samples, "Samsung_Price_List.csv"),
        "Seagate_Price_List.xlsx": sampleBytes(samples, "Seagate_Price_List.xlsx"),
        "TPLink_Price_List.xlsx": sampleBytes(samples, "TPLink_Price_List.xlsx"),
        "Samsung_Price_List__18a3f2c1.csv": sampleBytes(samples, "revised/Samsung_Price_List.csv"),
      },
      [
        { savedAs: "Samsung_Price_List.csv" },
        { savedAs: "Seagate_Price_List.xlsx" },
        { savedAs: "TPLink_Price_List.xlsx" },
        { savedAs: "Samsung_Price_List.csv" }, // B1: the resend
        { savedAs: "Samsung_Price_List__18a3f2c1.csv" }, // B2: the revised list
      ],
    );

    const check = checkDownloads(samples, dir);
    expect(check.problems).toEqual([]);
    expect(check.manifestEntries).toBe(5);
    expect(check.distinctFiles).toBe(4);

    const result = (name: string) => check.samples.find((sample) => sample.path === name)!;
    expect(result("Samsung_Price_List.csv")).toMatchObject({
      savedAs: ["Samsung_Price_List.csv"],
      emails: 2,
    });
    expect(result("revised/Samsung_Price_List.csv").savedAs).toEqual(["Samsung_Price_List__18a3f2c1.csv"]);
    expect(result("Dealer_Terms.txt").savedAs).toEqual([]);
    expect(result("Lunch_Menu.xlsx").savedAs).toEqual([]);

    const report = formatDownloadCheck(check).join("\n");
    expect(report).toContain("4 of 4 expected files downloaded");
    expect(report).toContain("(from 2 emails)");
    expect(report).toContain("No problems found.");
  });

  test("fails when a file that must be ignored was saved", async () => {
    const samples = await writeSamples("s-excluded");
    const dir = downloadFolder(
      "d-excluded",
      { "Dealer_Terms.txt": sampleBytes(samples, "Dealer_Terms.txt") },
      [{ savedAs: "Dealer_Terms.txt" }],
    );
    const check = checkDownloads(samples, dir);
    expect(check.problems.join("\n")).toContain("Dealer_Terms.txt should have been ignored");
  });

  test("fails when the unrelated spreadsheet was saved", async () => {
    const samples = await writeSamples("s-lunch");
    const dir = downloadFolder(
      "d-lunch",
      { "Lunch_Menu.xlsx": sampleBytes(samples, "Lunch_Menu.xlsx") },
      [{ savedAs: "Lunch_Menu.xlsx" }],
    );
    expect(checkDownloads(samples, dir).problems.join("\n")).toContain("Lunch_Menu.xlsx should have been ignored");
  });

  test("fails when a saved file was altered after download", async () => {
    const samples = await writeSamples("s-altered");
    const dir = downloadFolder(
      "d-altered",
      { "Samsung_Price_List.csv": sampleBytes(samples, "Samsung_Price_List.csv") },
      [{ savedAs: "Samsung_Price_List.csv" }],
    );
    fs.appendFileSync(path.join(dir, "Samsung_Price_List.csv"), "tampered\r\n");
    expect(checkDownloads(samples, dir).problems.join("\n")).toContain("changed after download");
  });

  test("fails when the manifest lists a file that is not there", async () => {
    const samples = await writeSamples("s-gone");
    const dir = downloadFolder(
      "d-gone",
      { "Seagate_Price_List.xlsx": sampleBytes(samples, "Seagate_Price_List.xlsx") },
      [{ savedAs: "Seagate_Price_List.xlsx" }],
    );
    fs.rmSync(path.join(dir, "Seagate_Price_List.xlsx"));
    expect(checkDownloads(samples, dir).problems.join("\n")).toContain("which is not in the folder");
  });

  // The confusion this guards against: copying a sample into the folder by hand
  // has the right bytes but is not the app's work.
  test("a sample copied in by hand does not count as downloaded, and is flagged", async () => {
    const samples = await writeSamples("s-byhand");
    const dir = path.join(scratch, "d-byhand");
    fs.mkdirSync(dir);
    fs.copyFileSync(path.join(samples, "Samsung_Price_List.csv"), path.join(dir, "Samsung_Price_List.csv"));

    const check = checkDownloads(samples, dir);
    expect(check.problems.join("\n")).toContain("not in manifest.json");
    expect(check.samples.find((sample) => sample.path === "Samsung_Price_List.csv")!.savedAs).toEqual([]);
  });

  test("an unrelated file in the folder is noted, not failed", async () => {
    const samples = await writeSamples("s-other");
    const dir = downloadFolder("d-other", { "Real_Supplier_Sheet.xlsx": "not one of ours" }, []);
    const check = checkDownloads(samples, dir);
    expect(check.problems).toEqual([]);
    expect(check.unrecognised).toEqual(["Real_Supplier_Sheet.xlsx"]);
  });

  test("a corrupt manifest is reported instead of throwing", async () => {
    const samples = await writeSamples("s-badmanifest");
    const dir = path.join(scratch, "d-badmanifest");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "manifest.json"), "{ not json");
    expect(checkDownloads(samples, dir).problems.join("\n")).toContain("manifest.json could not be read");
  });

  test("a missing sample folder says to run the generator", () => {
    const check = checkDownloads(path.join(scratch, "no-samples"), path.join(scratch, "no-downloads"));
    expect(check.problems.join("\n")).toContain("bun run mock:supplier-files");
  });
});
