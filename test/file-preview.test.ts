import { describe, expect, test } from "bun:test";
import writeExcelFile from "write-excel-file/node";

import { NotFoundError } from "@/lib/errors";
import { buildPreview, columnLetter, displayCell, looksNumeric } from "@/lib/file-preview";
import { contentDisposition, contentTypeFor, readPriceListFile, readPriceListPreview } from "@/lib/file-view";
import { parseAllSheets, parseSpreadsheet } from "@/lib/parse/spreadsheet";
import type { ColumnMapping, ManifestEntry, NormalizedPriceList, ParsedSheet } from "@/lib/types";

/**
 * Viewing a downloaded price list as received (workflow step 1,
 * context/ui-design.md §2.4a). No network; files are built in memory, not
 * from the sample generator, which reads the live price list.
 */

/** Laid out like the Seagate sample: a title block, a blank row, then the header on row 4. */
async function seagateWorkbook(): Promise<Buffer> {
  return writeExcelFile(
    [
      ["Seagate India - Distributor Price List"],
      ["Valid from 21 Sep 2026"],
      [],
      ["SKU Name", "Segment", "DP", "MRP"],
      ["SEAGATE BARRACUDA-2TB", "HDD", 4450, 5499],
      ["IronWolf 4TB", "HDD", 9200, 11900],
      ["IronWolf 8TB", "HDD", 15400, 19900],
    ],
    { sheet: "Price List" },
  ).toBuffer();
}

/** A quoted comma, CRLF line ends and a trailing blank row, as a supplier's csv may have. */
const SAMSUNG_CSV = Buffer.from(
  ["Model,Category,Dealer Price,MRP", "T7 1TB,SSD,7500,10499", '"990 PRO, 2TB",SSD,15000,19999', "", ""].join("\r\n"),
  "utf8",
);

const SEAGATE_MAPPING: ColumnMapping = {
  headerRow: 4,
  brand: "Seagate",
  columns: { model: "SKU Name", category: "Segment", dealerPrice: "DP", mrp: "MRP" },
};

function entry(savedAs: string): ManifestEntry {
  return { savedAs } as ManifestEntry;
}

function normalized(sheet: string | null, mapping: ColumnMapping, issues = [] as NormalizedPriceList["issues"]) {
  return { sheet, mapping, issues } as NormalizedPriceList;
}

const enoent = () => Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });

async function twoSheetWorkbook(): Promise<Buffer> {
  return writeExcelFile([
    { sheet: "Price List", data: [["Model", "DP", "MRP"], ["T7 1TB", 7500, 10499], ["T7 2TB", 12000, 15999]] },
    { sheet: "Blank", data: [] },
    { sheet: "Notes", data: [["Prices are ex-GST"]] },
  ]).toBuffer();
}

describe("column letters", () => {
  test("name columns as a spreadsheet does", () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702].map(columnLetter)).toEqual([
      "A", "B", "Z", "AA", "AB", "AZ", "BA", "ZZ", "AAA",
    ]);
  });
});

describe("buildPreview", () => {
  const ragged: ParsedSheet = { sheet: null, rows: [["a"], ["b", 2, true], [], ["c", null]] };

  test("pads ragged rows to the widest and keeps values as stored", () => {
    const [sheet] = buildPreview([ragged]);
    expect(sheet.columnCount).toBe(3);
    expect(sheet.rows).toEqual([
      ["a", null, null],
      ["b", 2, true],
      [null, null, null],
      ["c", null, null],
    ]);
    expect(sheet.truncated).toBe(false);
    expect(sheet.used).toBe(false);
    expect(sheet.headerRow).toBeNull();
    expect(sheet.columnRoles).toEqual([null, null, null]);
  });

  test("cuts at the row limit and says how many there are", () => {
    const rows = Array.from({ length: 1832 }, (_, i) => [`row ${i + 1}`]);
    const [sheet] = buildPreview([{ sheet: null, rows }]);
    expect(sheet.rows).toHaveLength(500);
    expect(sheet.totalRows).toBe(1832);
    expect(sheet.truncated).toBe(true);
    expect(sheet.rows.at(-1)).toEqual(["row 500"]);
    expect(buildPreview([{ sheet: null, rows }], { maxRows: 10 })[0].rows).toHaveLength(10);
  });

  test("an empty sheet has no rows and no columns", () => {
    expect(buildPreview([{ sheet: "Blank", rows: [] }])[0]).toMatchObject({ totalRows: 0, columnCount: 0, rows: [] });
  });

  test("marks the analysed sheet: header row, mapped columns, skipped rows", async () => {
    const sheets = await parseAllSheets("Seagate_Price_List.xlsx", await seagateWorkbook());
    const issues = [{ rowNumber: 7, reason: "Barracuda 2TB: dealer price is above MRP." }];
    const [preview] = buildPreview(sheets, { analysed: { sheet: "Price List", mapping: SEAGATE_MAPPING, issues } });

    expect(preview.used).toBe(true);
    expect(preview.headerRow).toBe(4);
    expect(preview.rows[3]).toEqual(["SKU Name", "Segment", "DP", "MRP"]);
    expect(preview.columnRoles).toEqual(["Model", "Category", "Dealer price", "MRP"]);
    expect(preview.issues).toEqual(issues);
    // The title block and header row do not stop the price columns aligning right.
    expect(preview.numericColumns).toEqual([false, false, true, true]);
  });

  test("a mapped name missing from the header row labels nothing, and no category column is fine", () => {
    const sheet: ParsedSheet = { sheet: null, rows: [["Model", " DP ", "MRP", "Notes"], ["T7 1TB", 7500, 10499, ""]] };
    const mapping: ColumnMapping = {
      headerRow: 1,
      brand: "Samsung",
      columns: { model: "Model", category: null, dealerPrice: "DP ", mrp: "Retail" },
    };
    const [preview] = buildPreview([sheet], { analysed: { sheet: null, mapping, issues: [] } });
    // Both sides are trimmed, as applyMapping does: header " DP " matches the mapped name "DP ".
    expect(preview.columnRoles).toEqual(["Model", "Dealer price", null, null]);
  });

  test("only the sheet the analysis read is marked", async () => {
    const sheets = await parseAllSheets("Book.xlsx", await twoSheetWorkbook());
    const mapping: ColumnMapping = {
      headerRow: 1,
      brand: "Samsung",
      columns: { model: "Model", category: null, dealerPrice: "DP", mrp: "MRP" },
    };
    const preview = buildPreview(sheets, { analysed: { sheet: "Price List", mapping, issues: [] } });
    expect(preview.map((s) => [s.name, s.used, s.headerRow])).toEqual([
      ["Price List", true, 1],
      ["Notes", false, null],
    ]);
    expect(preview[1].columnRoles).toEqual([null]);
  });

  test("before analysis nothing is marked", async () => {
    const sheets = await parseAllSheets("Book.xlsx", await twoSheetWorkbook());
    expect(buildPreview(sheets).every((s) => !s.used && s.headerRow === null && s.issues.length === 0)).toBe(true);
  });

  test("figures line up on the right, including a csv's text numbers", () => {
    const figures = [7500, "7500", " 10,499 ", "₹7,500", "Rs. 850", "INR 1299", "-3.5", "0"];
    const words = [null, "", "T7 1TB", "990 PRO", "7500 approx", "1.2.3", true, "₹"];
    expect(figures.map(looksNumeric)).toEqual(figures.map(() => true));
    expect(words.map(looksNumeric)).toEqual(words.map(() => false));
    const [csv] = buildPreview([
      { sheet: null, rows: [["Model", "DP", "Note"], ["T7 1TB", "7500", "new"], ["T7 2TB", "", "12"], ["T9", "8500", null]] },
    ]);
    expect(csv.numericColumns).toEqual([false, true, false]);
  });

  test("cells show as stored: untrimmed, blank for empty", () => {
    expect([displayCell(null), displayCell("  T7 1TB "), displayCell(7500), displayCell(false)]).toEqual([
      "", "  T7 1TB ", "7500", "false",
    ]);
  });
});

describe("parseAllSheets", () => {
  test("a csv is one unnamed sheet, the same as parseSpreadsheet reads", async () => {
    const sheets = await parseAllSheets("Samsung_Price_List.csv", SAMSUNG_CSV);
    expect(sheets).toEqual([
      {
        sheet: null,
        rows: [
          ["Model", "Category", "Dealer Price", "MRP"],
          ["T7 1TB", "SSD", "7500", "10499"],
          ["990 PRO, 2TB", "SSD", "15000", "19999"],
        ],
      },
    ]);
    expect(sheets[0]).toEqual(await parseSpreadsheet("Samsung_Price_List.csv", SAMSUNG_CSV));
  });

  test("a workbook gives every sheet with content, in order, and drops empty ones", async () => {
    const sheets = await parseAllSheets("Book.xlsx", await twoSheetWorkbook());
    expect(sheets.map((s) => s.sheet)).toEqual(["Price List", "Notes"]);
    expect(sheets[0].rows).toEqual([["Model", "DP", "MRP"], ["T7 1TB", 7500, 10499], ["T7 2TB", 12000, 15999]]);
  });

  test("parseSpreadsheet still reads the first sheet with content", async () => {
    const leadingBlank = await writeExcelFile([
      { sheet: "Cover", data: [] },
      { sheet: "Rates", data: [["Model", "DP"], ["T7 1TB", 7500]] },
    ]).toBuffer();
    expect(await parseSpreadsheet("Book.xlsx", leadingBlank)).toEqual({
      sheet: "Rates",
      rows: [["Model", "DP"], ["T7 1TB", 7500]],
    });
    const seagate = await seagateWorkbook();
    expect(await parseSpreadsheet("Seagate.xlsx", seagate)).toEqual((await parseAllSheets("Seagate.xlsx", seagate))[0]);
  });

  test("a workbook with no content keeps its first sheet's name", async () => {
    const empty = await writeExcelFile([{ sheet: "Only", data: [] }]).toBuffer();
    expect(await parseAllSheets("Book.xlsx", empty)).toEqual([{ sheet: "Only", rows: [] }]);
    expect(await parseSpreadsheet("Book.xlsx", empty)).toEqual({ sheet: "Only", rows: [] });
  });
});

describe("readPriceListPreview", () => {
  test("lays out the file with its size, marked when analysed", async () => {
    const bytes = await seagateWorkbook();
    const preview = await readPriceListPreview(
      entry("Seagate_Price_List.xlsx"),
      normalized("Price List", SEAGATE_MAPPING),
      { readRaw: async () => bytes },
    );
    if (!preview.ok) throw new Error(preview.reason);
    expect(preview.bytes).toBe(bytes.length);
    expect(preview.sheets).toHaveLength(1);
    expect(preview.sheets[0]).toMatchObject({ name: "Price List", used: true, headerRow: 4 });
  });

  test("a file gone from disk is a problem to show, not an error", async () => {
    const preview = await readPriceListPreview(entry("Gone.csv"), null, { readRaw: async () => { throw enoent(); } });
    expect(preview).toEqual({
      ok: false,
      problem: "missing",
      reason: "Gone.csv is in the manifest but no longer in mock-data/new-price-lists/.",
    });
  });

  test("an unreadable workbook is a problem to show, with the reason", async () => {
    const preview = await readPriceListPreview(entry("Broken.xlsx"), null, {
      readRaw: async () => Buffer.from("this is not a zip archive"),
    });
    expect(preview.ok).toBe(false);
    if (preview.ok) return;
    expect(preview.problem).toBe("unreadable");
    expect(preview.reason).toStartWith("The file could not be read: ");
  });

  test("any other read failure is not hidden", async () => {
    const failing = readPriceListPreview(entry("X.csv"), null, {
      readRaw: async () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); },
    });
    await expect(failing).rejects.toThrow("EACCES");
  });
});

describe("the download", () => {
  const bytes = Buffer.from("Model,DP\r\nT7 1TB,7500\r\n", "utf8");
  const found: ManifestEntry = entry("Samsung_Price_List.csv");

  test("returns the saved bytes untouched, with its type", async () => {
    const file = await readPriceListFile("9417520f9a4a", {
      find: async (id) => (id === "9417520f9a4a" ? found : null),
      readRaw: async () => bytes,
    });
    expect(file.bytes.equals(bytes)).toBe(true);
    expect(file.filename).toBe("Samsung_Price_List.csv");
    expect(file.contentType).toBe("text/csv; charset=utf-8");
  });

  test("an unknown ID or a missing file is not found", async () => {
    const readRaw = async () => bytes;
    await expect(readPriceListFile("000000000000", { find: async () => null, readRaw })).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      readPriceListFile("9417520f9a4a", { find: async () => found, readRaw: async () => { throw enoent(); } }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("content types", () => {
    expect(contentTypeFor("a.CSV")).toBe("text/csv; charset=utf-8");
    expect(contentTypeFor("a.xlsx")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  });

  test("is always an attachment, with a safe fallback name and the real one encoded", () => {
    expect(contentDisposition("Samsung_Price_List.csv")).toBe(
      `attachment; filename="Samsung_Price_List.csv"; filename*=UTF-8''Samsung_Price_List.csv`,
    );
    expect(contentDisposition('Prix "été".xlsx')).toBe(
      `attachment; filename="Prix __t__.xlsx"; filename*=UTF-8''Prix%20%22%C3%A9t%C3%A9%22.xlsx`,
    );
    expect(contentDisposition("a\r\nSet-Cookie: x.csv")).not.toMatch(/[\r\n]/);
  });
});
