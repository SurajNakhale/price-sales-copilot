import { addDays, latestInvoiceDate } from "@/lib/analytics";
import type { Brand, Dealer, PriceChangeItem, PriceReview, SalesLine } from "@/lib/types";

/**
 * Feature 3, step 4: the dealers who bought a repriced model in the last 90
 * days, and whose address each one has. Pure: it reads the approved review,
 * the sales lines and the dealer list, and nothing else.
 *
 * "Affected" means the price change was approved AND applied. New products
 * have no purchase history, deactivations are not price changes, and items the
 * reviewer left out changed nothing, so none of those count.
 */

/** The placeholder base the mock data ships with (scripts/generate-mock-data.ts). */
export const PLACEHOLDER_EMAIL_BASE = "yourname";

/**
 * Sales this many days back from the latest invoice date count as recent (the
 * copilot's last_days uses the same rule). Kept here, not in lib/config.ts,
 * because this module is pure and the page's client components import it.
 */
export const AFFECTED_WINDOW_DAYS = 90;

/** A draft with more Bcc addresses than this is refused. Far above the mock data's 20 dealers. */
export const MAX_DRAFT_RECIPIENTS = 100;

export interface AffectedModel {
  itemId: string;
  productId: string;
  brand: Brand;
  model: string;
  old: { dealerPrice: number; mrp: number };
  new: { dealerPrice: number; mrp: number };
}

export interface AffectedDealer {
  dealer: string;
  state: string;
  /** Null when the dealer has no usable address. */
  email: string | null;
  models: { model: string; units: number }[];
  units: number;
  invoices: number;
  /** ISO date of the latest purchase of a repriced model. */
  lastOrder: string;
}

export interface SkippedDealer {
  dealer: string;
  reason: string;
}

export interface AffectedResult {
  /** Empty unless the review is approved. */
  models: AffectedModel[];
  window: { today: string; from: string; days: number } | null;
  /** Every affected dealer, with or without an address, biggest buyers first. */
  dealers: AffectedDealer[];
  skipped: SkippedDealer[];
  /** Unique, lower-cased, sorted addresses of the dealers that have one: the Bcc. */
  recipients: string[];
  /** Applied items that are not price changes, and items the reviewer did not apply. */
  leftOut: { newProducts: number; deactivated: number; notApplied: number };
}

/** True for a plain single address with no whitespace, comma, angle bracket or line break. */
export function isValidAddress(value: string): boolean {
  return (
    value.length <= 254 &&
    /^[^\s<>,;"()[\]\\@]+@[^\s<>,;"()[\]\\@]+\.[^\s<>,;"()[\]\\@]+$/.test(value)
  );
}

/**
 * The mailbox an address delivers to. Gmail ignores everything after a "+" and
 * every dot in the part before the "@", and googlemail.com is gmail.com, so
 * `Y.ou+dealer3@googlemail.com` and `you@gmail.com` are the same inbox. Other
 * providers are only lower-cased, since they may treat "+" and dots differently.
 */
export function canonicalAddress(address: string): string {
  const [local = "", domain = ""] = address.trim().toLowerCase().split("@");
  if (domain === "gmail.com" || domain === "googlemail.com") {
    return `${local.split("+")[0].replaceAll(".", "")}@gmail.com`;
  }
  return `${local}@${domain}`;
}

export type AddressKind = "own" | "placeholder" | "external";

/** Whose address this is, judged against the connected account. */
export function classifyAddress(address: string, connected: string | null): AddressKind {
  if (connected && canonicalAddress(address) === canonicalAddress(connected)) return "own";
  const base = address.split("@")[0].split("+")[0].toLowerCase();
  return base === PLACEHOLDER_EMAIL_BASE ? "placeholder" : "external";
}

export interface AddressSummary {
  /** "unknown" when Gmail is not connected, so there is nothing to compare with. */
  kind: AddressKind | "unknown";
  total: number;
  own: number;
  placeholder: number;
  external: number;
}

/** One verdict for a set of recipients: the most cautionary kind present wins. */
export function summariseAddresses(recipients: string[], connected: string | null): AddressSummary {
  const counts = { own: 0, placeholder: 0, external: 0 };
  for (const address of recipients) counts[classifyAddress(address, connected)] += 1;

  let kind: AddressSummary["kind"];
  if (recipients.length === 0) kind = "unknown";
  else if (counts.placeholder > 0) kind = "placeholder";
  else if (connected === null) kind = "unknown";
  else if (counts.external > 0) kind = "external";
  else kind = "own";

  return { kind, total: recipients.length, ...counts };
}

/** The price changes an approval applied. Empty for a review that is not approved. */
export function appliedPriceChanges(review: PriceReview): PriceChangeItem[] {
  if (review.status !== "approved" || !review.applied) return [];
  const applied = new Set(review.applied);
  return review.items.filter(
    (item): item is PriceChangeItem => item.kind === "price-change" && applied.has(item.itemId),
  );
}

export function findAffectedDealers(input: {
  review: PriceReview;
  sales: SalesLine[];
  dealers: Dealer[];
  /** Defaults to the latest invoice date, never the clock. */
  today?: string;
  days?: number;
}): AffectedResult {
  const { review, sales, dealers } = input;
  const days = input.days ?? AFFECTED_WINDOW_DAYS;
  const changes = appliedPriceChanges(review);

  const applied = new Set(review.applied ?? []);
  const leftOut = {
    newProducts: review.items.filter((i) => i.kind === "new-product" && applied.has(i.itemId)).length,
    deactivated: review.items.filter((i) => i.kind === "missing" && applied.has(i.itemId)).length,
    notApplied:
      review.status === "approved" ? review.items.filter((i) => !applied.has(i.itemId)).length : 0,
  };

  const models: AffectedModel[] = changes.map((c) => ({
    itemId: c.itemId,
    productId: c.productId,
    brand: c.brand,
    model: c.model,
    old: c.old,
    new: c.new,
  }));

  const today = input.today ?? latestInvoiceDate(sales);
  if (changes.length === 0 || today === null) {
    return { models, window: null, dealers: [], skipped: [], recipients: [], leftOut };
  }

  const from = addDays(today, -days);
  const changed = new Map(changes.map((c) => [c.productId, c.model]));

  interface Tally {
    models: Map<string, number>;
    invoices: Set<string>;
    units: number;
    lastOrder: string;
    state: string;
  }
  const tallies = new Map<string, Tally>();
  for (const line of sales) {
    if (line.date < from || line.date > today) continue;
    const model = changed.get(line.productId);
    if (model === undefined) continue;

    const tally = tallies.get(line.dealer) ?? {
      models: new Map<string, number>(),
      invoices: new Set<string>(),
      units: 0,
      lastOrder: "",
      state: line.state,
    };
    tally.models.set(model, (tally.models.get(model) ?? 0) + line.quantity);
    tally.invoices.add(line.invoiceNo);
    tally.units += line.quantity;
    if (line.date > tally.lastOrder) tally.lastOrder = line.date;
    tallies.set(line.dealer, tally);
  }

  const byName = new Map(dealers.map((d) => [d.dealer, d]));
  const found: AffectedDealer[] = [];
  const skipped: SkippedDealer[] = [];

  for (const [name, tally] of tallies) {
    const listed = byName.get(name);
    const email = listed?.email?.trim() ?? "";
    const usable = listed !== undefined && isValidAddress(email);

    found.push({
      dealer: name,
      state: listed?.state ?? tally.state,
      email: usable ? email : null,
      models: [...tally.models].map(([model, units]) => ({ model, units })).sort((a, b) => b.units - a.units),
      units: tally.units,
      invoices: tally.invoices.size,
      lastOrder: tally.lastOrder,
    });
    if (!usable) {
      skipped.push({
        dealer: name,
        reason: listed === undefined ? "Not in the dealer list, so there is no address." : "No valid email address.",
      });
    }
  }

  found.sort((a, b) => b.units - a.units || a.dealer.localeCompare(b.dealer));
  skipped.sort((a, b) => a.dealer.localeCompare(b.dealer));

  const recipients = [
    ...new Set(found.filter((d) => d.email !== null).map((d) => (d.email as string).toLowerCase())),
  ].sort();

  return { models, window: { today, from, days }, dealers: found, skipped, recipients, leftOut };
}

/** Throws-free check used by the draft service: the Bcc must fit the cap. */
export function recipientLimitProblem(recipients: string[]): string | null {
  return recipients.length > MAX_DRAFT_RECIPIENTS
    ? `${recipients.length} recipients is more than the ${MAX_DRAFT_RECIPIENTS} a draft may have. Split this one in Gmail.`
    : null;
}
