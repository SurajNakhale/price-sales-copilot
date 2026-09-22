import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  appliedPriceChanges,
  canonicalAddress,
  classifyAddress,
  findAffectedDealers,
  isValidAddress,
  recipientLimitProblem,
  summariseAddresses,
} from "@/lib/affected";
import { GMAIL_COMPOSE_SCOPE, GMAIL_SCOPES } from "@/lib/config";
import { createGmailDraft } from "@/lib/create-draft";
import type { DraftDeps } from "@/lib/drafts/deps";
import { buildEmail, checkDraftProse, formatChangeLine, standardProse } from "@/lib/drafts/message";
import { buildMessageText, buildRawMessage, encodeSubject } from "@/lib/drafts/mime";
import { createBodySchema, messageBodySchema } from "@/lib/drafts/request";
import type { DraftState } from "@/lib/drafts/types";
import { addressNoteText, affectedHeadline, leftOutLines } from "@/lib/drafts/wording";
import {
  ConflictError,
  InvalidLlmOutputError,
  LlmUnavailableError,
  MissingScopeError,
  NotConnectedError,
  NotFoundError,
} from "@/lib/errors";
import { createGmailDraftFromRaw, mapDraftError, openInGmailUrl, type DraftsGmail } from "@/lib/gmail/drafts";
import { getAuthUrl, safeReturnPath, scopesOf } from "@/lib/google/oauth";
import type { DraftPort } from "@/lib/llm/port";
import { prepareDraftMessage } from "@/lib/prepare-draft";
import type { Dealer, PriceChangeItem, PriceReview, Product, ReviewItem, SalesLine } from "@/lib/types";
import { parseGmailBase, rewriteDealerEmails, rewriteDealerFile } from "@/scripts/set-dealer-emails";

// The datasets are read from the repo by path: lib/config.ts follows process.cwd(),
// which other test files move. Sales and dealers are never written at runtime.
const mockDir = path.join(import.meta.dir, "..", "mock-data");
const read = <T>(...parts: string[]): T => JSON.parse(fs.readFileSync(path.join(mockDir, ...parts), "utf8")) as T;

const sales = read<SalesLine[]>("sales", "sales-data.json");
const dealers = read<Dealer[]>("dealers", "dealers.json");
// The price list can be edited by Feature 2 approvals; only brand and model of sold products are used here.
const products = read<Product[]>("current-price-lists", "current-price-list.json");

const TODAY = "2026-09-18";

// ------------------------------------------------------------------ builders

const idOf = (model: string) => products.find((p) => p.model === model)!.productId;

function priceChange(model: string, brand: Product["brand"] = "Samsung"): PriceChangeItem {
  return {
    kind: "price-change",
    itemId: `price-change:${idOf(model)}`,
    productId: idOf(model),
    brand,
    model,
    supplierModel: model,
    match: "key",
    old: { dealerPrice: 7000, mrp: 9999 },
    new: { dealerPrice: 7500, mrp: 10499 },
  } as PriceChangeItem;
}

function review(items: ReviewItem[], applied: string[], status: PriceReview["status"] = "approved"): PriceReview {
  return {
    fileId: "9417520f9a4a",
    sourceFile: "Samsung_Price_List.csv",
    brand: "Samsung",
    status,
    rowsInFile: 10,
    unchanged: 5,
    issues: 0,
    items,
    analysedAt: "2026-09-21T10:00:00.000Z",
    approvedAt: status === "approved" ? "2026-09-21T12:00:00.000Z" : undefined,
    applied,
  };
}

const SAMPLE_SETS = {
  Samsung: ["T7 1TB", "T7 2TB", "870 EVO 500GB"],
  Seagate: ["Barracuda 2TB", "IronWolf 4TB", "FireCuda 530 1TB"],
  "TP-Link": ["Archer C6", "Archer AX55", "TL-SG108"],
} as const;

function approvedFor(brand: keyof typeof SAMPLE_SETS): PriceReview {
  const items = SAMPLE_SETS[brand].map((m) => priceChange(m, brand));
  return review(items, items.map((i) => i.itemId));
}

/** An independent count, straight from the sales lines. */
function bruteForceDealers(models: readonly string[], days = 90): Set<string> {
  const ids = new Set(models.map(idOf));
  const start = new Date(Date.parse(TODAY) - days * 86_400_000).toISOString().slice(0, 10);
  return new Set(sales.filter((l) => ids.has(l.productId) && l.date >= start && l.date <= TODAY).map((l) => l.dealer));
}

// --------------------------------------------------------------- step 4

describe("affected dealers", () => {
  for (const [brand, expected] of [["Samsung", 13], ["Seagate", 15], ["TP-Link", 14]] as const) {
    test(`${brand}'s three sample changes affect ${expected} of 20 dealers`, () => {
      const result = findAffectedDealers({ review: approvedFor(brand), sales, dealers });
      expect(result.dealers).toHaveLength(expected);
      expect(new Set(result.dealers.map((d) => d.dealer))).toEqual(bruteForceDealers(SAMPLE_SETS[brand]));
      expect(result.window).toEqual({ today: TODAY, from: "2026-06-20", days: 90 });
    });
  }

  test("each dealer's models and units come from the lines in the window", () => {
    const result = findAffectedDealers({ review: approvedFor("Samsung"), sales, dealers });
    const xyz = result.dealers.find((d) => d.dealer === "XYZ Electronics")!;
    const lines = sales.filter((l) => l.dealer === "XYZ Electronics" && SAMPLE_SETS.Samsung.some((m) => idOf(m) === l.productId));
    expect(xyz.units).toBe(lines.reduce((s, l) => s + l.quantity, 0));
    expect(xyz.units).toBe(27);
    expect(xyz.models.map((m) => m.model).sort()).toEqual([...new Set(lines.map((l) => l.model))].sort());
    expect(xyz.lastOrder).toBe(lines.map((l) => l.date).sort().at(-1) as string);
    expect(result.dealers[0].units).toBeGreaterThanOrEqual(result.dealers[1].units);
  });

  // Open decision 7: every real sale is inside the window, so the filter is proven here instead.
  describe("the 90-day window, with sales of its own", () => {
    const item = priceChange("T7 1TB");
    const line = (dealer: string, date: string, invoiceNo = `INV-${dealer}-${date}`): SalesLine => ({
      invoiceNo, date, dealer, state: "Gujarat", productId: item.productId, model: "T7 1TB", quantity: 2, unitPrice: 7000,
    });
    const listed: Dealer[] = ["A", "B", "C"].map((n) => ({ dealer: n, state: "Gujarat", email: `${n.toLowerCase()}@example.com` }));
    const fixture: SalesLine[] = [
      line("A", "2026-06-20"), // exactly 90 days before 2026-09-18: in
      line("B", "2026-06-19"), // 91 days: out
      line("C", "2026-06-01"), // only an old purchase: dropped
      line("C", "2026-06-15"),
      line("A", "2026-09-18"), // today: in
      { ...line("A", "2026-09-19"), invoiceNo: "INV-future" }, // after today: cannot exist, but is not counted
    ];
    const run = () => findAffectedDealers({ review: review([item], [item.itemId]), sales: fixture, dealers: listed, today: TODAY });

    test("a purchase exactly 90 days back is in, 91 days is out", () => {
      const names = run().dealers.map((d) => d.dealer);
      expect(names).toContain("A");
      expect(names).not.toContain("B");
    });

    test("a dealer whose only purchases are older is dropped", () => {
      expect(run().dealers.map((d) => d.dealer)).toEqual(["A"]);
    });

    test("only lines in the window are counted", () => {
      const a = run().dealers[0];
      expect(a.units).toBe(4); // 20 Jun and 18 Sep, not the 19th
      expect(a.invoices).toBe(2);
    });

    test("the window length can change", () => {
      const wide = findAffectedDealers({ review: review([item], [item.itemId]), sales: fixture, dealers: listed, today: TODAY, days: 120 });
      expect(wide.dealers.map((d) => d.dealer).sort()).toEqual(["A", "B", "C"]);
    });
  });

  describe("what counts as affected", () => {
    const t7 = priceChange("T7 1TB");
    const t72 = priceChange("T7 2TB");
    const newProduct: ReviewItem = { kind: "new-product", itemId: "new-product:SAM-1578F", productId: "SAM-1578F", brand: "Samsung", model: "T9 1TB", category: "SSD", dealerPrice: 8500, mrp: 11999, reactivates: false };
    const missing: ReviewItem = { kind: "missing", itemId: `missing:${idOf("990 EVO 1TB")}`, productId: idOf("990 EVO 1TB"), brand: "Samsung", model: "990 EVO 1TB", category: "SSD", dealerPrice: 7600, mrp: 10499 };

    test("only applied price changes count", () => {
      const r = review([t7, t72, newProduct, missing], [t7.itemId, newProduct.itemId, missing.itemId]);
      expect(appliedPriceChanges(r).map((c) => c.model)).toEqual(["T7 1TB"]);
      const result = findAffectedDealers({ review: r, sales, dealers });
      expect(result.models.map((m) => m.model)).toEqual(["T7 1TB"]);
      expect(new Set(result.dealers.map((d) => d.dealer))).toEqual(bruteForceDealers(["T7 1TB"]));
    });

    test("what was left out is counted, so the screen can say so", () => {
      const r = review([t7, t72, newProduct, missing], [t7.itemId, newProduct.itemId, missing.itemId]);
      expect(findAffectedDealers({ review: r, sales, dealers }).leftOut).toEqual({ newProducts: 1, deactivated: 1, notApplied: 1 });
    });

    test("a review that is not approved affects nobody", () => {
      const r = review([t7], [t7.itemId], "needs-review");
      const result = findAffectedDealers({ review: r, sales, dealers });
      expect(result.dealers).toEqual([]);
      expect(result.models).toEqual([]);
    });

    test("approving only a new product leaves nobody to notify", () => {
      const r = review([newProduct], [newProduct.itemId]);
      expect(findAffectedDealers({ review: r, sales, dealers }).recipients).toEqual([]);
    });
  });

  describe("addresses", () => {
    const item = priceChange("T7 1TB");
    const mk = (dealer: string, date = "2026-09-01"): SalesLine => ({
      invoiceNo: `INV-${dealer}`, date, dealer, state: "Goa", productId: item.productId, model: "T7 1TB", quantity: 1, unitPrice: 7000,
    });
    const run = (list: Dealer[], names: string[]) =>
      findAffectedDealers({ review: review([item], [item.itemId]), sales: names.map((n) => mk(n)), dealers: list, today: TODAY });

    test("a dealer with no valid address is listed as skipped, never dropped", () => {
      const result = run(
        [{ dealer: "Good", state: "Goa", email: "good@example.com" }, { dealer: "Bad", state: "Goa", email: "not an address" }, { dealer: "Empty", state: "Goa", email: "" }],
        ["Good", "Bad", "Empty", "Ghost"],
      );
      expect(result.dealers.map((d) => d.dealer).sort()).toEqual(["Bad", "Empty", "Ghost", "Good"]);
      expect(result.skipped.map((s) => s.dealer)).toEqual(["Bad", "Empty", "Ghost"]);
      expect(result.skipped.find((s) => s.dealer === "Ghost")?.reason).toContain("Not in the dealer list");
      expect(result.recipients).toEqual(["good@example.com"]);
    });

    test("identical addresses collapse to one Bcc entry while every dealer is still listed", () => {
      const same = ["A", "B", "C"].map((d) => ({ dealer: d, state: "Goa", email: "Me@Example.com" }));
      const result = run(same, ["A", "B", "C"]);
      expect(result.dealers).toHaveLength(3);
      expect(result.recipients).toEqual(["me@example.com"]);
    });

    test("distinct aliases stay distinct", () => {
      const aliases = [1, 2, 3].map((n) => ({ dealer: `D${n}`, state: "Goa", email: `you+dealer${n}@gmail.com` }));
      expect(run(aliases, ["D1", "D2", "D3"]).recipients).toHaveLength(3);
    });

    test("a line break in an address makes it invalid", () => {
      expect(isValidAddress("a@b.com\r\nBcc: x@y.com")).toBe(false);
      expect(isValidAddress("a@b.com, c@d.com")).toBe(false);
      expect(isValidAddress("a b@c.com")).toBe(false);
      expect(isValidAddress("you+dealer1@gmail.com")).toBe(true);
    });

    test("more than 100 recipients is refused", () => {
      const many = Array.from({ length: 101 }, (_, i) => `a${i}@example.com`);
      expect(recipientLimitProblem(many)).toContain("101");
      expect(recipientLimitProblem(many.slice(0, 100))).toBeNull();
    });
  });
});

// --------------------------------------------------- whose addresses these are

describe("dealer addresses against the connected account", () => {
  const me = "you@gmail.com";

  test("plus tags, dots and googlemail.com all reach the same inbox", () => {
    for (const same of ["you+dealer3@gmail.com", "Y.ou@gmail.com", "you@googlemail.com", "YOU+x@GMAIL.COM", "y.o.u+a.b@googlemail.com"]) {
      expect(canonicalAddress(same)).toBe("you@gmail.com");
      expect(classifyAddress(same, me)).toBe("own");
    }
  });

  test("the placeholder is not the connected account", () => {
    expect(classifyAddress("yourname+dealer3@gmail.com", me)).toBe("placeholder");
    expect(classifyAddress("YourName+dealer3@gmail.com", me)).toBe("placeholder");
  });

  test("but it is treated as your own if you really are yourname@gmail.com", () => {
    expect(classifyAddress("yourname+dealer3@gmail.com", "yourname@gmail.com")).toBe("own");
  });

  test("a real dealer is external, and other providers keep their +tags", () => {
    expect(classifyAddress("accounts@abccomputers.in", me)).toBe("external");
    expect(canonicalAddress("Sales+west@Example.com")).toBe("sales+west@example.com");
    expect(classifyAddress("you+dealer1@example.com", me)).toBe("external");
  });

  test("the verdict for a set: the most cautionary kind wins", () => {
    const aliases = ["you+dealer1@gmail.com", "you+dealer2@gmail.com"];
    expect(summariseAddresses(aliases, me)).toMatchObject({ kind: "own", total: 2, own: 2 });
    expect(summariseAddresses([...aliases, "accounts@abc.in"], me)).toMatchObject({ kind: "external", external: 1 });
    expect(summariseAddresses([...aliases, "yourname+dealer9@gmail.com"], me)).toMatchObject({ kind: "placeholder", placeholder: 1 });
    expect(summariseAddresses(aliases, null).kind).toBe("unknown");
    expect(summariseAddresses([], me).kind).toBe("unknown");
  });

  test("the shipped mock data is all placeholder, which is what the demo warns about", () => {
    const everyone = findAffectedDealers({ review: approvedFor("Samsung"), sales, dealers }).recipients;
    expect(summariseAddresses(everyone, "you@gmail.com")).toMatchObject({ kind: "placeholder", total: 13, placeholder: 13 });
  });
});

// ------------------------------------------------------------ the message

describe("the wording the model may write", () => {
  const models = ["T7 1TB", "T7 2TB", "870 EVO 500GB"];
  const good = { subject: "Price Update – Samsung T7 1TB", greeting: "Hi,", intro: "Please note that the dealer prices for T7 1TB and T7 2TB have been updated.", closing: "Do get in touch with any questions." };

  test("your example subject passes: digits are fine inside a model name", () => {
    expect(checkDraftProse(good, models, "Samsung")).toBeNull();
  });

  test("model names are masked longest first, so a longer name is not half-masked", () => {
    const prose = { ...good, intro: "The T7 Shield 1TB is also affected." };
    expect(checkDraftProse(prose, [...models, "T7 Shield 1TB"], "Samsung")).toBeNull();
  });

  test("a price, a percentage or a count is rejected", () => {
    for (const intro of ["Prices rise by 7% this month.", "T7 1TB is now ₹7,500.", "3 models changed."]) {
      expect(checkDraftProse({ ...good, intro }, models, "Samsung")).toContain("number");
    }
    expect(checkDraftProse({ ...good, subject: "Prices up 7%" }, models, "Samsung")).toContain("subject");
  });

  test("a number that only looks like part of a model name is still rejected", () => {
    expect(checkDraftProse({ ...good, intro: "T7 1TB now costs 7500." }, models, "Samsung")).toContain("number");
  });

  test("empty, over-long, multi-line and markdown wording is rejected", () => {
    expect(checkDraftProse({ ...good, greeting: "  " }, models, "Samsung")).toContain("empty");
    expect(checkDraftProse({ ...good, subject: "x".repeat(101) }, models, "Samsung")).toContain("longer");
    expect(checkDraftProse({ ...good, subject: "Line one\nBcc: evil@x.com" }, models, "Samsung")).toContain("single line");
    expect(checkDraftProse({ ...good, intro: "**Important**: prices changed" }, models, "Samsung")).toContain("markdown");
  });

  test("the standard message passes its own check", () => {
    for (const brand of ["Samsung", "Seagate", "TP-Link"] as const) {
      expect(checkDraftProse(standardProse(brand), models, brand)).toBeNull();
    }
  });
});

describe("the numbers come from the review", () => {
  const up = { model: "T7 1TB", old: { dealerPrice: 7000, mrp: 9999 }, new: { dealerPrice: 7500, mrp: 10499 } };

  test("a line shows the old and new price, the percentage and the MRP", () => {
    expect(formatChangeLine(up)).toBe("• T7 1TB: dealer price ₹7,000 → ₹7,500 (+7.1%), MRP ₹9,999 → ₹10,499");
  });

  test("an unchanged MRP is left out, and a whole-number percentage has no decimal", () => {
    const line = formatChangeLine({ model: "T7 2TB", old: { dealerPrice: 12500, mrp: 16999 }, new: { dealerPrice: 13000, mrp: 16999 } });
    expect(line).toBe("• T7 2TB: dealer price ₹12,500 → ₹13,000 (+4%)");
  });

  test("a decrease is shown as one", () => {
    const line = formatChangeLine({ model: "FireCuda 530 1TB", old: { dealerPrice: 11800, mrp: 15500 }, new: { dealerPrice: 11400, mrp: 14900 } });
    expect(line).toBe("• FireCuda 530 1TB: dealer price ₹11,800 → ₹11,400 (-3.4%), MRP ₹15,500 → ₹14,900");
  });

  test("an MRP-only change says the dealer price did not move", () => {
    expect(formatChangeLine({ model: "X", old: { dealerPrice: 100, mrp: 150 }, new: { dealerPrice: 100, mrp: 160 } })).toBe(
      "• X: dealer price unchanged at ₹100, MRP ₹150 → ₹160",
    );
  });

  test("the email is the prose around one line per change, and every figure is the review's", () => {
    const email = buildEmail(standardProse("Samsung"), "Samsung", [up, { model: "T7 2TB", old: { dealerPrice: 12500, mrp: 16999 }, new: { dealerPrice: 13000, mrp: 17499 } }]);
    expect(email.subject).toBe("Price update – Samsung");
    expect(email.body.split("\n")).toEqual([
      "Hello,",
      "",
      "We have updated our dealer prices for the following Samsung models. The new prices are below.",
      "",
      "Samsung price changes:",
      "• T7 1TB: dealer price ₹7,000 → ₹7,500 (+7.1%), MRP ₹9,999 → ₹10,499",
      "• T7 2TB: dealer price ₹12,500 → ₹13,000 (+4%), MRP ₹16,999 → ₹17,499",
      "",
      "Please get in touch if you have any questions.",
      "",
      "Regards,",
    ]);
  });
});

// -------------------------------------------------------------------- MIME

/** A small parser, so the tests read the message back the way a mail client would. */
function parse(text: string) {
  const [head, ...rest] = text.split("\r\n\r\n");
  const unfolded = head.replace(/\r\n[ \t]+/g, " ");
  const headers = new Map<string, string>();
  for (const line of unfolded.split("\r\n")) {
    const at = line.indexOf(":");
    headers.set(line.slice(0, at).toLowerCase(), line.slice(at + 1).trim());
  }
  return { headers, body: rest.join("\r\n\r\n") };
}

describe("the raw message for Gmail", () => {
  const input = {
    to: "you@gmail.com",
    bcc: Array.from({ length: 13 }, (_, i) => `you+dealer${i + 1}@gmail.com`),
    subject: "Price Update – Samsung T7 1TB",
    body: "Hello,\n\n• T7 1TB: dealer price ₹7,000 → ₹7,500 (+7.1%)\n\nRegards,",
  };

  test("To is you and Bcc holds every dealer, with no dealer in To or Cc", () => {
    const { headers } = parse(buildMessageText(input));
    expect(headers.get("to")).toBe("you@gmail.com");
    expect(headers.get("bcc")?.split(/,\s*/)).toEqual(input.bcc);
    expect(headers.has("cc")).toBe(false);
    expect(headers.get("to")).not.toContain("dealer");
  });

  test("the subject, ₹, → and • survive a round trip", () => {
    const { headers, body } = parse(buildMessageText(input));
    const subject = /^=\?UTF-8\?B\?(.+)\?=$/.exec(headers.get("subject") ?? "");
    expect(Buffer.from(subject![1], "base64").toString("utf8")).toBe(input.subject);
    expect(Buffer.from(body.replaceAll("\r\n", ""), "base64").toString("utf8").replaceAll("\r\n", "\n")).toBe(input.body);
  });

  test("the raw form is base64url of exactly that text", () => {
    const raw = buildRawMessage(input);
    expect(raw).not.toMatch(/[+/=]/);
    expect(Buffer.from(raw, "base64url").toString("utf8")).toBe(buildMessageText(input));
  });

  test("a hundred addresses fold onto short lines instead of one enormous header", () => {
    const many = Array.from({ length: 100 }, (_, i) => `dealer.number.${i}@a-long-domain-name.example.com`);
    const text = buildMessageText({ ...input, bcc: many });
    expect(Math.max(...text.split("\r\n").map((l) => l.length))).toBeLessThan(998);
    expect(parse(text).headers.get("bcc")?.split(/,\s*/)).toEqual(many);
  });

  test("an ASCII subject is left alone and an empty Bcc is refused", () => {
    expect(encodeSubject("Price update")).toBe("Price update");
    expect(() => buildMessageText({ ...input, bcc: [] })).toThrow(/at least one/);
  });

  test("a line break anywhere near a header is refused", () => {
    expect(() => buildMessageText({ ...input, subject: "Hi\r\nBcc: evil@x.com" })).toThrow(/line break/);
    expect(() => buildMessageText({ ...input, to: "you@gmail.com\r\nBcc: evil@x.com" })).toThrow(/line break/);
    expect(() => buildMessageText({ ...input, bcc: ["ok@x.com", "bad@x.com\nX-Evil: 1"] })).toThrow(/line break/);
    expect(() => buildMessageText({ ...input, bcc: ["not an address"] })).toThrow(/not a valid/);
  });
});

// ------------------------------------------------------ preparing the message

/** In-memory stand-ins for the files the services read and write. */
function memoryDeps(input: { review: PriceReview | null; state?: DraftState | null; dealers?: Dealer[] }) {
  let state: DraftState | null = input.state ?? null;
  const writes: DraftState[] = [];
  const deps: DraftDeps = {
    readReview: async () => input.review,
    readData: async () => ({ sales, dealers: input.dealers ?? dealers }),
    readState: async () => state,
    writeState: async (next) => {
      state = next;
      writes.push(next);
    },
    now: () => new Date("2026-09-21T12:30:00.000Z"),
  };
  return { deps, writes, current: () => state };
}

const samsung = () => approvedFor("Samsung");
const goodProse = {
  subject: "Price Update – Samsung T7 1TB",
  greeting: "Hi,",
  intro: "Please note that the dealer prices for T7 1TB, T7 2TB and 870 EVO 500GB have been updated.",
  closing: "Get in touch if you have any questions.",
};

/** A Gemini stand-in that also applies the same check the real one is given. */
function fakeDrafts(answer: () => typeof goodProse) {
  const seen: { input: unknown; check: string | null }[] = [];
  const llm: DraftPort = {
    async draftDealerMessage(input, check) {
      const prose = answer();
      seen.push({ input, check: check(prose) });
      return prose;
    },
  };
  return { llm, seen };
}

describe("preparing the message", () => {
  test("Gemini's wording is stored, with the model and the time, and earlier drafts are kept", async () => {
    const earlier = { draftId: "d0", messageId: "m0", createdAt: "2026-09-20T00:00:00.000Z", to: "you@gmail.com", recipients: 1, addresses: 1, subject: "old" };
    const mem = memoryDeps({ review: samsung(), state: { fileId: "9417520f9a4a", message: null, drafts: [earlier] } });
    const { llm } = fakeDrafts(() => goodProse);

    const state = await prepareDraftMessage("9417520f9a4a", { llm, deps: mem.deps, model: () => "test-model" });
    expect(state.message).toMatchObject({ ...goodProse, source: "model", model: "test-model", generatedAt: "2026-09-21T12:30:00.000Z" });
    expect(state.drafts).toEqual([earlier]);
    expect(mem.writes).toHaveLength(1);
  });

  test("Gemini is told the brand, the models and the prices, and nothing about any dealer", async () => {
    const mem = memoryDeps({ review: samsung() });
    const { llm, seen } = fakeDrafts(() => goodProse);
    await prepareDraftMessage("9417520f9a4a", { llm, deps: mem.deps });

    const sent = JSON.stringify(seen[0].input);
    expect(sent).toContain("T7 1TB");
    expect(sent).toContain("7500");
    expect(sent).toContain("Samsung");
    for (const dealer of dealers) {
      expect(sent).not.toContain(dealer.dealer);
      expect(sent).not.toContain(dealer.email);
    }
    expect(sent).not.toContain("@");
    expect(seen[0].check).toBeNull(); // the wording it returned passes the app's own check
  });

  test("the check it is given rejects a typed price", async () => {
    const mem = memoryDeps({ review: samsung() });
    const { llm, seen } = fakeDrafts(() => ({ ...goodProse, intro: "Prices rise by 7% from today." }));
    await prepareDraftMessage("9417520f9a4a", { llm, deps: mem.deps });
    expect(seen[0].check).toContain("number");
  });

  test("wording that broke the rules twice becomes the standard message, not an error", async () => {
    const mem = memoryDeps({ review: samsung() });
    const llm: DraftPort = {
      draftDealerMessage: async () => {
        throw new InvalidLlmOutputError("not usable twice in a row");
      },
    };
    const state = await prepareDraftMessage("9417520f9a4a", { llm, deps: mem.deps });
    expect(state.message).toMatchObject({ source: "template", subject: "Price update – Samsung" });
    expect(state.message?.note).toContain("wrote a number");
  });

  test("an outage is an outage: it is not hidden behind the standard message", async () => {
    const mem = memoryDeps({ review: samsung() });
    const llm: DraftPort = {
      draftDealerMessage: async () => {
        throw new LlmUnavailableError("quota");
      },
    };
    await expect(prepareDraftMessage("9417520f9a4a", { llm, deps: mem.deps })).rejects.toBeInstanceOf(LlmUnavailableError);
    expect(mem.writes).toHaveLength(0);
  });

  test("choosing the standard message never calls Gemini", async () => {
    const mem = memoryDeps({ review: samsung() });
    const { llm, seen } = fakeDrafts(() => goodProse);
    const state = await prepareDraftMessage("9417520f9a4a", { llm, deps: mem.deps, template: true });
    expect(seen).toHaveLength(0);
    expect(state.message).toMatchObject({ source: "template", note: "You chose the standard message." });
  });

  test("an unknown or unapproved price list is refused, and so is one with no price change", async () => {
    const { llm } = fakeDrafts(() => goodProse);
    await expect(prepareDraftMessage("9417520f9a4a", { llm, deps: memoryDeps({ review: null }).deps })).rejects.toBeInstanceOf(NotFoundError);

    const pending = review([priceChange("T7 1TB")], [], "needs-review");
    await expect(prepareDraftMessage("9417520f9a4a", { llm, deps: memoryDeps({ review: pending }).deps })).rejects.toBeInstanceOf(ConflictError);

    const onlyNew = review(
      [{ kind: "new-product", itemId: "new-product:SAM-1578F", productId: "SAM-1578F", brand: "Samsung", model: "T9 1TB", category: "SSD", dealerPrice: 8500, mrp: 11999, reactivates: false }],
      ["new-product:SAM-1578F"],
    );
    await expect(prepareDraftMessage("9417520f9a4a", { llm, deps: memoryDeps({ review: onlyNew }).deps })).rejects.toThrow(/none of the approved changes/i);
  });
});

// -------------------------------------------------------------- the draft

function fakeGmail(options: { address?: string; createFails?: unknown } = {}) {
  const calls: { profile: number; create: { userId: string; requestBody: { message: { raw: string } } }[] } = { profile: 0, create: [] };
  const gmail: DraftsGmail = {
    users: {
      getProfile: async () => {
        calls.profile += 1;
        return { data: { emailAddress: options.address ?? "You@Gmail.com" } };
      },
      drafts: {
        create: async (params) => {
          if (options.createFails) throw options.createFails;
          calls.create.push(params);
          return { data: { id: "r-100", message: { id: "18f2a" } } };
        },
      },
    },
  };
  return { gmail, calls };
}

const withMessage = (extra: Partial<DraftState> = {}): DraftState => ({
  fileId: "9417520f9a4a",
  message: { ...goodProse, source: "model", model: "m", generatedAt: "2026-09-21T12:00:00.000Z" },
  drafts: [],
  ...extra,
});

describe("creating the Gmail draft", () => {
  test("saves one draft: To is you, Bcc is every affected dealer, and the message is what was written", async () => {
    const mem = memoryDeps({ review: samsung(), state: withMessage() });
    const { gmail, calls } = fakeGmail();

    const result = await createGmailDraft("9417520f9a4a", { deps: mem.deps, gmail });

    expect(calls.create).toHaveLength(1);
    expect(calls.create[0].userId).toBe("me");
    const raw = Buffer.from(calls.create[0].requestBody.message.raw, "base64url").toString("utf8");
    const { headers, body } = parse(raw);
    expect(headers.get("to")).toBe("you@gmail.com");
    const expected = findAffectedDealers({ review: samsung(), sales, dealers }).recipients;
    expect(expected).toHaveLength(13);
    expect(headers.get("bcc")?.split(/,\s*/)).toEqual(expected);
    expect(headers.get("to")).not.toContain("dealer");
    const text = Buffer.from(body.replaceAll("\r\n", ""), "base64").toString("utf8");
    expect(text).toContain("• T7 1TB: dealer price ₹7,000 → ₹7,500 (+7.1%), MRP ₹9,999 → ₹10,499");
    expect(text).toContain(goodProse.intro);

    expect(result.draft).toMatchObject({ draftId: "r-100", messageId: "18f2a", to: "you@gmail.com", recipients: 13, addresses: 13, subject: goodProse.subject });
    expect(result.openUrl).toBe(openInGmailUrl("you@gmail.com", "18f2a"));
    expect(mem.current()?.drafts).toHaveLength(1);
  });

  test("Gmail is asked for the profile and for the draft, and nothing else", async () => {
    const mem = memoryDeps({ review: samsung(), state: withMessage() });
    const { gmail, calls } = fakeGmail();
    await createGmailDraft("9417520f9a4a", { deps: mem.deps, gmail });
    expect(calls.profile).toBe(1);
    expect(calls.create).toHaveLength(1);
    // The client type has no send method to call; this checks the fake exposes only what the service may use.
    expect(Object.keys(gmail.users).sort()).toEqual(["drafts", "getProfile"]);
    expect(Object.keys(gmail.users.drafts)).toEqual(["create"]);
  });

  test("the recipients are recomputed when the draft is made, not read from anywhere stored", async () => {
    const other: Dealer[] = dealers.map((d, i) => ({ ...d, email: `changed${i}@example.com` }));
    const mem = memoryDeps({ review: samsung(), state: withMessage(), dealers: other });
    const { gmail, calls } = fakeGmail();
    await createGmailDraft("9417520f9a4a", { deps: mem.deps, gmail });
    const bcc = parse(Buffer.from(calls.create[0].requestBody.message.raw, "base64url").toString("utf8")).headers.get("bcc") ?? "";
    expect(bcc).toContain("@example.com");
    expect(bcc).not.toContain("yourname");
  });

  test("a message must be written first", async () => {
    const mem = memoryDeps({ review: samsung(), state: null });
    await expect(createGmailDraft("9417520f9a4a", { deps: mem.deps, gmail: fakeGmail().gmail })).rejects.toThrow(/write the message first/i);
    const empty = memoryDeps({ review: samsung(), state: { fileId: "9417520f9a4a", message: null, drafts: [] } });
    await expect(createGmailDraft("9417520f9a4a", { deps: empty.deps, gmail: fakeGmail().gmail })).rejects.toBeInstanceOf(ConflictError);
  });

  test("a second draft needs confirming, and then both are recorded", async () => {
    const first = { draftId: "d1", messageId: "m1", createdAt: "2026-09-21T11:00:00.000Z", to: "you@gmail.com", recipients: 13, addresses: 13, subject: "s" };
    const mem = memoryDeps({ review: samsung(), state: withMessage({ drafts: [first] }) });
    const { gmail, calls } = fakeGmail();

    await expect(createGmailDraft("9417520f9a4a", { deps: mem.deps, gmail })).rejects.toThrow(/already created/i);
    expect(calls.create).toHaveLength(0);

    const result = await createGmailDraft("9417520f9a4a", { deps: mem.deps, gmail, another: true });
    expect(result.state.drafts.map((d) => d.draftId)).toEqual(["d1", "r-100"]);
  });

  test("an unapproved or unknown price list is refused before Gmail is touched", async () => {
    const { gmail, calls } = fakeGmail();
    await expect(createGmailDraft("9417520f9a4a", { deps: memoryDeps({ review: null }).deps, gmail })).rejects.toBeInstanceOf(NotFoundError);
    const pending = review([priceChange("T7 1TB")], [], "needs-review");
    await expect(createGmailDraft("9417520f9a4a", { deps: memoryDeps({ review: pending, state: withMessage() }).deps, gmail })).rejects.toBeInstanceOf(ConflictError);
    expect(calls.profile).toBe(0);
    expect(calls.create).toHaveLength(0);
  });

  test("without the draft permission nothing is created", async () => {
    const mem = memoryDeps({ review: samsung(), state: withMessage() });
    const { gmail, calls } = fakeGmail();
    await expect(createGmailDraft("9417520f9a4a", { deps: mem.deps, gmail, hasPermission: async () => false })).rejects.toBeInstanceOf(MissingScopeError);
    expect(calls.create).toHaveLength(0);
  });

  test("no dealer with a valid address means nobody to put in Bcc", async () => {
    const blank = dealers.map((d) => ({ ...d, email: "" }));
    const mem = memoryDeps({ review: samsung(), state: withMessage(), dealers: blank });
    await expect(createGmailDraft("9417520f9a4a", { deps: mem.deps, gmail: fakeGmail().gmail })).rejects.toThrow(/nobody to put in Bcc/i);
  });

  test("Google's permission and grant errors are translated", async () => {
    expect(mapDraftError({ code: 403, message: "Request had insufficient authentication scopes." })).toBeInstanceOf(MissingScopeError);
    expect(mapDraftError({ response: { status: 403 }, message: "Insufficient Permission" })).toBeInstanceOf(MissingScopeError);
    expect(mapDraftError({ message: "invalid_grant" })).toBeInstanceOf(NotConnectedError);
    const other = { code: 500, message: "boom" };
    expect(mapDraftError(other)).toBe(other);

    const mem = memoryDeps({ review: samsung(), state: withMessage() });
    const { gmail } = fakeGmail({ createFails: { code: 403, message: "insufficient scopes" } });
    await expect(createGmailDraft("9417520f9a4a", { deps: mem.deps, gmail })).rejects.toBeInstanceOf(MissingScopeError);
    expect(mem.current()?.drafts).toEqual([]); // a failed draft is not recorded
  });

  test("a response with no draft id is an error, not a recorded draft", async () => {
    const empty: DraftsGmail = {
      users: { getProfile: async () => ({ data: { emailAddress: "you@gmail.com" } }), drafts: { create: async () => ({ data: {} }) } },
    };
    await expect(createGmailDraftFromRaw(empty, "raw")).rejects.toThrow(/did not say which/);
  });

  test("the Open in Gmail link names the account and the draft's message", () => {
    expect(openInGmailUrl("you@gmail.com", "18f2a")).toBe("https://mail.google.com/mail/?authuser=you%40gmail.com#drafts?compose=18f2a");
  });
});

// ----------------------------------------------------------- never sends

describe("the app never sends", () => {
  function sourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === ".next" ? [] : sourceFiles(full);
      return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
    });
  }
  const root = path.join(import.meta.dir, "..");
  const files = ["lib", "app", "scripts"].flatMap((dir) => sourceFiles(path.join(root, dir)));

  test("no code anywhere calls a Gmail send method", () => {
    expect(files.length).toBeGreaterThan(50);
    const offenders = files.filter((file) =>
      /\b(messages|drafts)\s*\.\s*send\s*\(|\.users\.(messages|drafts)\.send|gmail\.users\.messages\.send/.test(fs.readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  test("the app never asks for the send or full-access permissions", () => {
    const offenders = files.filter((file) => /auth\/gmail\.(send|modify)\b/.test(fs.readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });

  test("Connect stays read-only; only the draft permission is added on request", () => {
    expect([...GMAIL_SCOPES]).toEqual(["https://www.googleapis.com/auth/gmail.readonly"]);
    expect(GMAIL_COMPOSE_SCOPE).toBe("https://www.googleapis.com/auth/gmail.compose");
  });
});

// ------------------------------------------------------------- the permission

describe("asking Google for the draft permission", () => {
  function withEnv<T>(run: () => T): T {
    const saved = { id: process.env.GOOGLE_CLIENT_ID, secret: process.env.GOOGLE_CLIENT_SECRET };
    process.env.GOOGLE_CLIENT_ID = "test-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
    try {
      return run();
    } finally {
      if (saved.id === undefined) delete process.env.GOOGLE_CLIENT_ID;
      else process.env.GOOGLE_CLIENT_ID = saved.id;
      if (saved.secret === undefined) delete process.env.GOOGLE_CLIENT_SECRET;
      else process.env.GOOGLE_CLIENT_SECRET = saved.secret;
    }
  }
  const query = (url: string) => new URL(url).searchParams;

  test("Connect asks for read-only, and every request keeps what was granted before", () => {
    const params = query(withEnv(() => getAuthUrl("state1")));
    expect(params.get("scope")?.split(" ")).toEqual(["https://www.googleapis.com/auth/gmail.readonly"]);
    expect(params.get("include_granted_scopes")).toBe("true");
    expect(params.get("access_type")).toBe("offline");
    expect(params.get("prompt")).toBe("consent");
  });

  test("Allow Gmail drafts adds the compose permission", () => {
    const params = query(withEnv(() => getAuthUrl("state1", { drafts: true })));
    expect(params.get("scope")?.split(" ").sort()).toEqual([
      "https://www.googleapis.com/auth/gmail.compose",
      "https://www.googleapis.com/auth/gmail.readonly",
    ]);
    expect(params.get("include_granted_scopes")).toBe("true");
  });

  test("what a token covers is read from its scope string", () => {
    expect(scopesOf({ scope: "a b  c" })).toEqual(["a", "b", "c"]);
    expect(scopesOf({})).toEqual([]);
    expect(scopesOf(null)).toEqual([]);
  });

  test("the way back is only ever a price-list workflow page", () => {
    expect(safeReturnPath("/price-updates/9417520f9a4a")).toBe("/price-updates/9417520f9a4a");
    for (const bad of [
      "//evil.com/price-updates/9417520f9a4a",
      "https://evil.com",
      "/price-updates/9417520f9a4a?next=https://evil.com",
      "/price-updates/9417520f9a4a/../../x",
      "/price-updates/9417520F9A4A",
      "/price-updates/9417520f9a4",
      "/settings",
      "",
      null,
      undefined,
    ]) {
      expect(safeReturnPath(bad as string | null | undefined)).toBeNull();
    }
  });

  test("the route bodies accept only what they name", () => {
    expect(messageBodySchema.safeParse({}).success).toBe(true);
    expect(messageBodySchema.safeParse({ template: true }).success).toBe(true);
    expect(messageBodySchema.safeParse({ template: "yes" }).success).toBe(false);
    expect(createBodySchema.safeParse({ another: true }).success).toBe(true);
    expect(createBodySchema.safeParse({ another: 1 }).success).toBe(false);
  });
});

// ------------------------------------------------------------ dealer emails

describe("mock:dealer-emails", () => {
  const baseline: Dealer[] = dealers.map((d) => ({ ...d }));

  test("the address may be any spelling of a Gmail address", () => {
    expect(parseGmailBase("you@gmail.com")).toBe("you");
    expect(parseGmailBase("  You+dealer1@Gmail.com ")).toBe("you");
    expect(parseGmailBase("y.ou@googlemail.com")).toBe("y.ou");
  });

  test("anything that is not Gmail is refused, because plus-aliases are a Gmail feature", () => {
    expect(() => parseGmailBase("me@outlook.com")).toThrow(/not a Gmail address/);
    expect(() => parseGmailBase("not an address")).toThrow();
    expect(() => parseGmailBase("+x@gmail.com")).toThrow(/does not look like/);
  });

  test("only the email changes, in the same order, numbered by position", () => {
    const out = rewriteDealerEmails(baseline, "you@gmail.com");
    expect(out).toHaveLength(20);
    expect(out.map((d) => d.email)).toEqual(Array.from({ length: 20 }, (_, i) => `you+dealer${i + 1}@gmail.com`));
    expect(out.map(({ dealer, state }) => ({ dealer, state }))).toEqual(baseline.map(({ dealer, state }) => ({ dealer, state })));
    expect(new Set(out.map((d) => d.email)).size).toBe(20);
  });

  test("running it again, with the same or another address, gives the same shape", () => {
    const once = rewriteDealerEmails(baseline, "you@gmail.com");
    expect(rewriteDealerEmails(once, "you@gmail.com")).toEqual(once);
    expect(rewriteDealerEmails(once, "other@gmail.com")[0].email).toBe("other+dealer1@gmail.com");
  });

  test("the file is rewritten in the generator's format", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psc-dealers-"));
    try {
      const file = path.join(dir, "dealers.json");
      fs.writeFileSync(file, `${JSON.stringify(baseline, null, 2)}\n`);
      rewriteDealerFile(file, "you@gmail.com");
      const text = fs.readFileSync(file, "utf8");
      expect(text.endsWith("]\n")).toBe(true);
      expect(text).toContain('  {\n    "dealer": "ABC Computers",');
      expect(text).toContain('"email": "you+dealer1@gmail.com"');
      expect(JSON.parse(text).map((d: Dealer) => d.dealer)).toEqual(baseline.map((d) => d.dealer));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // The data check must accept your own name and still reject a wrong shape or a repeat.
  test("mock:generate --check accepts your own Gmail name, and still rejects a wrong shape or a duplicate", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psc-check-"));
    try {
      const generator = path.join(import.meta.dir, "..", "scripts", "generate-mock-data.ts");
      const run = (...args: string[]) => Bun.spawnSync(["bun", generator, ...args], { cwd: dir });
      expect(run().exitCode).toBe(0); // a fresh, pristine baseline in the temp folder
      const file = path.join(dir, "mock-data", "dealers", "dealers.json");

      expect(run("--check").exitCode).toBe(0);
      rewriteDealerFile(file, "you@gmail.com");
      expect(run("--check").exitCode).toBe(0);

      const list = JSON.parse(fs.readFileSync(file, "utf8")) as Dealer[];
      const write = (next: Dealer[]) => fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);

      write(list.map((d, i) => (i === 0 ? { ...d, email: "you+dealer1@example.com" } : d)));
      const wrongShape = run("--check");
      expect(wrongShape.exitCode).toBe(1);
      expect(wrongShape.stderr.toString()).toContain("unexpected email format");

      write(list.map((d, i) => (i === 1 ? { ...d, email: list[0].email } : d)));
      const duplicate = run("--check");
      expect(duplicate.exitCode).toBe(1);
      expect(duplicate.stderr.toString()).toContain("not unique");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------------------ what the page says

describe("what the page says about the addresses", () => {
  const note = (recipients: string[], connected: string | null) =>
    addressNoteText(summariseAddresses(recipients, connected), connected);
  const aliases = Array.from({ length: 13 }, (_, i) => `you+dealer${i + 1}@gmail.com`);
  const placeholders = aliases.map((a) => a.replace("you+", "yourname+"));
  const all = (n: NonNullable<ReturnType<typeof note>>) => `${n.title} ${n.text} ${n.hint ?? ""}`;

  test("your own aliases get a reassuring note, not a warning", () => {
    const n = note(aliases, "you@gmail.com")!;
    expect(n.tone).toBe("ok");
    expect(n.title).toBe("Your own aliases");
    expect(n.text).toContain("These 13 addresses are aliases of your own Gmail (you@gmail.com)");
    expect(n.text).toContain("safe to test");
    expect(n.text).toContain("never sent");
    expect(all(n)).not.toContain("Test addresses detected");
  });

  test("the placeholder is a warning that says how to fix it, and does not claim who owns the address", () => {
    const n = note(placeholders, "you@gmail.com")!;
    expect(n.tone).toBe("warning");
    expect(n.title).toBe("Test addresses detected");
    expect(n.text).toContain("These 13 addresses use the placeholder yourname+dealerN@gmail.com, which is not your account");
    expect(n.text).toContain("never sent");
    expect(n.text).toContain("you can still create it");
    expect(n.hint).toContain("`bun run mock:dealer-emails <your Gmail address>`");
    expect(all(n)).not.toMatch(/stranger|someone else|belongs to/i);
  });

  test("a real dealer is not called a test address", () => {
    const n = note(["accounts@abccomputers.in", "sales@xyz.in"], "you@gmail.com")!;
    expect(n.tone).toBe("info");
    expect(n.title).toBe("Addresses outside your account");
    expect(n.text).toContain("these dealers will receive it");
    expect(all(n)).not.toContain("Test addresses");
  });

  test("with Gmail not connected it asks to connect, and says nothing for no recipients", () => {
    expect(note(aliases, null)?.text).toContain("Connect Gmail to check these 13 addresses");
    expect(note([], "you@gmail.com")).toBeNull();
  });

  test("a single address is worded in the singular", () => {
    expect(note(["you+dealer1@gmail.com"], "you@gmail.com")?.text).toContain("This address is an alias of your own Gmail");
    expect(note(["yourname+dealer1@gmail.com"], "you@gmail.com")?.text).toContain("This address uses the placeholder");
    expect(note(["accounts@abc.in"], "you@gmail.com")?.text).toContain("This address is outside your account");
    expect(note(["accounts@abc.in"], "you@gmail.com")?.text).toContain("this dealer will receive it");
    expect(note(["you+dealer1@gmail.com"], null)?.text).toContain("Connect Gmail to check this address");
  });

  test("a mixed set names how many are placeholders", () => {
    expect(note([...aliases.slice(0, 3), "yourname+dealer9@gmail.com"], "you@gmail.com")?.text).toContain("1 of these 4 addresses uses the placeholder");
    expect(note([...aliases.slice(0, 2), "yourname+dealer8@gmail.com", "yourname+dealer9@gmail.com"], "you@gmail.com")?.text).toContain("2 of these 4 addresses use the placeholder");
  });

  test("the headline says how many dealers, which models, and the window in dates", () => {
    const affected = findAffectedDealers({ review: approvedFor("Samsung"), sales, dealers });
    expect(affectedHeadline(affected, 20)).toBe(
      "13 dealers of 20 bought T7 1TB, T7 2TB, 870 EVO 500GB between 20 Jun 2026 and 18 Sep 2026 (the last 90 days)",
    );
    expect(affectedHeadline(findAffectedDealers({ review: review([], []), sales, dealers }), 20)).toBe("");
  });

  test("what the approval did not cover is listed, so the screen can say so", () => {
    expect(leftOutLines({ newProducts: 1, deactivated: 1, notApplied: 2 })).toEqual([
      "1 new product (no purchase history yet)",
      "1 deactivated product (not a price change)",
      "2 items you did not approve",
    ]);
    expect(leftOutLines({ newProducts: 0, deactivated: 0, notApplied: 0 })).toEqual([]);
  });
});

// The build, not the tests, first caught this: the draft panel runs in the browser,
// so nothing it imports may reach server-only code such as lib/config.ts.
describe("what the browser loads", () => {
  const root = path.join(import.meta.dir, "..");
  const resolve = (spec: string, from: string): string | null => {
    const base = spec.startsWith("@/") ? path.join(root, spec.slice(2)) : spec.startsWith(".") ? path.resolve(path.dirname(from), spec) : null;
    if (base === null) return null;
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
    return null;
  };

  function reach(entry: string): Set<string> {
    const seen = new Set<string>();
    const stack = [entry];
    while (stack.length) {
      const file = stack.pop() as string;
      if (seen.has(file)) continue;
      seen.add(file);
      const text = fs.readFileSync(file, "utf8");
      // Type-only imports are erased before the browser sees them.
      for (const m of text.matchAll(/^import\s+(?!type\b)[^;]*?from\s+"([^"]+)"/gm)) {
        const next = resolve(m[1], file);
        if (next) stack.push(next);
      }
    }
    return seen;
  }

  for (const component of [
    "app/_components/DraftPanel.tsx",
    "app/_components/AddressNote.tsx",
    "app/_components/ReceivedFileCard.tsx",
    "app/_components/CopilotChat.tsx",
  ]) {
    test(`${component} reaches no server-only module`, () => {
      const files = [...reach(path.join(root, component))];
      const serverOnly = files.filter((file) => /^import "server-only";/m.test(fs.readFileSync(file, "utf8")));
      expect(serverOnly.map((file) => path.relative(root, file))).toEqual([]);
      expect(files.length).toBeGreaterThan(3);
    });
  }
});
