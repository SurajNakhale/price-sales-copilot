import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import {
  addDays,
  brandTotals,
  daysBetween,
  earliestInvoiceDate,
  invoiceCount,
  latestInvoiceDate,
  lineRevenue,
  mondayOf,
  totalRevenue,
  totalUnits,
  trendSeries,
  weeklyBuckets,
} from "@/lib/analytics";
import { formatDate, formatMoney, formatMoneyShort, formatNumber } from "@/lib/format";
import type { Dealer, Product, SalesLine } from "@/lib/types";

// Read the datasets from the repo directly rather than through lib/config.ts,
// whose paths come from process.cwd(). feature-1.test.ts moves the working
// directory to a temp folder, and these assertions must not depend on which
// test file loaded first.
const mockDataDir = path.join(import.meta.dir, "..", "mock-data");

async function read<T>(...segments: string[]): Promise<T> {
  return JSON.parse(await fs.readFile(path.join(mockDataDir, ...segments), "utf8")) as T;
}

const products = await read<Product[]>("current-price-lists", "current-price-list.json");
const dealers = await read<Dealer[]>("dealers", "dealers.json");
const sales = await read<SalesLine[]>("sales", "sales-data.json");

describe("the mock data these figures are pinned to", () => {
  test("is the pristine baseline", () => {
    expect(products).toHaveLength(30);
    expect(dealers).toHaveLength(20);
    expect(sales).toHaveLength(200);
  });
});

describe("headline totals", () => {
  test("revenue is the sum of quantity x unitPrice", () => {
    expect(totalRevenue(sales)).toBe(4_391_820);
    expect(formatMoney(totalRevenue(sales))).toBe("₹43,91,820");
    expect(formatMoneyShort(totalRevenue(sales))).toBe("₹43.9L");
  });

  test("units and invoices", () => {
    expect(totalUnits(sales)).toBe(910);
    expect(invoiceCount(sales)).toBe(66);
  });

  test("unitPrice is per unit, not a line total", () => {
    expect(lineRevenue({ quantity: 5, unitPrice: 7000 } as SalesLine)).toBe(35_000);
  });

  test("empty input does not throw", () => {
    expect(totalRevenue([])).toBe(0);
    expect(totalUnits([])).toBe(0);
    expect(invoiceCount([])).toBe(0);
    expect(latestInvoiceDate([])).toBeNull();
    expect(weeklyBuckets([])).toEqual([]);
  });
});

describe("today comes from the data, never the clock", () => {
  test("is the latest invoice date", () => {
    expect(latestInvoiceDate(sales)).toBe("2026-09-18");
    expect(earliestInvoiceDate(sales)).toBe("2026-07-02");
  });
});

describe("brand totals", () => {
  test("revenue ranks Samsung first", () => {
    expect(brandTotals(sales, products, "revenue")).toEqual([
      { brand: "Samsung", revenue: 1_958_520, units: 260 },
      { brand: "Seagate", revenue: 1_708_920, units: 324 },
      { brand: "TP-Link", revenue: 724_380, units: 326 },
    ]);
  });

  // The whole reason every chart has to name its measure.
  test("units rank TP-Link first, flipping the order", () => {
    expect(brandTotals(sales, products, "units").map((total) => total.brand)).toEqual([
      "TP-Link",
      "Seagate",
      "Samsung",
    ]);
  });

  test("the three brands account for the whole total", () => {
    const totals = brandTotals(sales, products);
    expect(totals.reduce((sum, total) => sum + total.revenue, 0)).toBe(totalRevenue(sales));
    expect(totals.reduce((sum, total) => sum + total.units, 0)).toBe(totalUnits(sales));
  });

  test("a sale for an unknown product is left out rather than crashing", () => {
    const orphan: SalesLine = { ...sales[0], productId: "ZZZ-00000" };
    const totals = brandTotals([...sales, orphan], products);
    expect(totals.reduce((sum, total) => sum + total.units, 0)).toBe(totalUnits(sales));
  });
});

describe("weekly buckets", () => {
  const buckets = weeklyBuckets(sales);

  test("cover the period in 12 Monday-to-Sunday weeks", () => {
    expect(buckets).toHaveLength(12);
    expect(buckets[0].weekStart).toBe("2026-06-29");
    expect(buckets.at(-1)?.weekStart).toBe("2026-09-14");
    expect(buckets.at(-1)?.weekEnd).toBe("2026-09-20");
  });

  test("both ends are partial, which the design has to draw as such", () => {
    // The first week opens on 29 Jun but sales start on 2 Jul; the last closes
    // on 20 Sep but sales stop on 18 Sep. Neither total is comparable.
    expect(buckets[0].partial).toBe(true);
    expect(buckets.at(-1)?.partial).toBe(true);
    expect(buckets.slice(1, -1).every((bucket) => !bucket.partial)).toBe(true);
  });

  test("lose nothing: the buckets sum to the totals", () => {
    expect(buckets.reduce((sum, bucket) => sum + bucket.revenue, 0)).toBe(totalRevenue(sales));
    expect(buckets.reduce((sum, bucket) => sum + bucket.units, 0)).toBe(totalUnits(sales));
  });

  test("are in ascending date order with no gaps", () => {
    for (let i = 1; i < buckets.length; i += 1) {
      expect(buckets[i].weekStart).toBe(addDays(buckets[i - 1].weekStart, 7));
    }
  });
});

describe("the trend line's solid and dashed split", () => {
  const weeks = weeklyBuckets(sales);
  const points = trendSeries(weeks, "revenue");

  test("dashes exactly the partial weeks at either end", () => {
    expect(points[0].dashed).not.toBeNull();
    expect(points[0].solid).toBeNull();
    expect(points.at(-1)?.dashed).not.toBeNull();
    expect(points.at(-1)?.solid).toBeNull();
  });

  test("keeps the whole weeks in the middle solid", () => {
    expect(points.slice(2, -2).every((point) => point.solid !== null)).toBe(true);
    expect(points.slice(2, -2).every((point) => point.dashed === null)).toBe(true);
  });

  // Where the dashed end meets the solid middle both series carry a value, so
  // the two lines join instead of leaving a gap.
  test("shares the boundary points between the two series", () => {
    expect(points[1].solid).not.toBeNull();
    expect(points[1].dashed).not.toBeNull();
    expect(points.at(-2)?.solid).not.toBeNull();
    expect(points.at(-2)?.dashed).not.toBeNull();
  });

  test("plots the measure asked for", () => {
    expect(trendSeries(weeks, "units")[0].value).toBe(weeks[0].units);
    expect(points[0].value).toBe(weeks[0].revenue);
  });

  test("dashes everything when no week is whole", () => {
    const allPartial = weeks.slice(0, 1);
    const drawn = trendSeries(allPartial, "revenue");
    expect(drawn.every((point) => point.dashed !== null && point.solid === null)).toBe(true);
  });
});

describe("date helpers work in UTC", () => {
  test("mondayOf snaps back to Monday and is idempotent", () => {
    expect(mondayOf("2026-09-18")).toBe("2026-09-14"); // a Friday
    expect(mondayOf("2026-09-14")).toBe("2026-09-14"); // the Monday itself
    expect(mondayOf("2026-09-20")).toBe("2026-09-14"); // the Sunday that ends it
  });

  test("addDays crosses month and year boundaries", () => {
    expect(addDays("2026-09-18", 1)).toBe("2026-09-19");
    expect(addDays("2026-08-31", 1)).toBe("2026-09-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-07-02", -1)).toBe("2026-07-01");
  });

  test("daysBetween measures back from today", () => {
    expect(daysBetween("2026-09-18", "2026-06-20")).toBe(90);
    expect(daysBetween("2026-09-18", "2026-09-18")).toBe(0);
  });

  // Every sale sits inside 90 days of the data's today, so Feature 3's window
  // cannot currently exclude any dealer. Recorded as an open point in the docs.
  test("the whole sales file falls within 90 days of today", () => {
    const today = latestInvoiceDate(sales) as string;
    expect(sales.every((line) => daysBetween(today, line.date) <= 90)).toBe(true);
  });
});

describe("formatting", () => {
  test("money groups Indian-style", () => {
    expect(formatMoney(7500)).toBe("₹7,500");
    expect(formatMoney(1_958_520)).toBe("₹19,58,520");
  });

  test("short money drops a trailing zero decimal", () => {
    expect(formatMoneyShort(1_958_520)).toBe("₹19.6L");
    expect(formatMoneyShort(700_000)).toBe("₹7L");
    expect(formatMoneyShort(12_500_000)).toBe("₹1.3Cr");
    expect(formatMoneyShort(7_500)).toBe("₹7.5K");
  });

  test("numbers and dates", () => {
    expect(formatNumber(910)).toBe("910");
    expect(formatNumber(1_248)).toBe("1,248");
    expect(formatDate("2026-09-18")).toBe("18 Sep 2026");
  });
});
