import { formatMoney } from "@/lib/format";
import type { Brand } from "@/lib/types";

import type { DealerEmailProse, EmailText } from "./types";

/**
 * The words and numbers of the dealer email. Gemini writes the words; every
 * figure is written here, from the approved review, so a price can never be
 * misquoted. Pure.
 */

export interface EmailChange {
  model: string;
  old: { dealerPrice: number; mrp: number };
  new: { dealerPrice: number; mrp: number };
}

const LIMITS = { subject: 100, greeting: 60, intro: 400, closing: 300 } as const;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Digits are allowed only inside the exact name of a changed model ("T7 1TB"),
 * because a price or a percentage written by the model is exactly what must
 * not happen. Returns the problem in words, or null when the wording is fine.
 */
export function checkDraftProse(
  prose: DealerEmailProse,
  models: string[],
  brand: Brand,
): string | null {
  // Longest names first, so "T7 Shield 1TB" is masked before "T7".
  const names = [...new Set([...models, brand])].sort((a, b) => b.length - a.length);
  const mask = (text: string) =>
    names.reduce((out, name) => out.replace(new RegExp(escapeRegExp(name), "gi"), " "), text);

  for (const field of ["subject", "greeting", "intro", "closing"] as const) {
    const text = prose[field];
    if (typeof text !== "string" || text.trim() === "") return `${field} is empty.`;
    if (text.length > LIMITS[field]) return `${field} is longer than ${LIMITS[field]} characters.`;
    if (/[\r\n]/.test(text) && (field === "subject" || field === "greeting")) {
      return `${field} must be a single line.`;
    }
    if (/\d/.test(mask(text))) {
      return `${field} contains a number that is not part of a model name. Write no prices, percentages or counts: the app adds every figure.`;
    }
    if (/[<>]|\*\*|^#|^\s*[-*] /m.test(text)) {
      return `${field} contains markdown or HTML. Write plain sentences.`;
    }
  }
  return null;
}

/** The standard message: used when Gemini's wording was unusable twice, or was skipped. */
export function standardProse(brand: Brand): DealerEmailProse {
  return {
    subject: `Price update – ${brand}`,
    greeting: "Hello,",
    intro: `We have updated our dealer prices for the following ${brand} models. The new prices are below.`,
    closing: "Please get in touch if you have any questions.",
  };
}

function percent(from: number, to: number): string {
  const value = Math.round(((to - from) / from) * 1000) / 10;
  return `${value > 0 ? "+" : ""}${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}%`;
}

/** One line per change; the MRP is mentioned only when it moved, and a fall is shown as a fall. */
export function formatChangeLine(change: EmailChange): string {
  const { old: before, new: after } = change;
  const dealer =
    before.dealerPrice === after.dealerPrice
      ? `dealer price unchanged at ${formatMoney(after.dealerPrice)}`
      : `dealer price ${formatMoney(before.dealerPrice)} → ${formatMoney(after.dealerPrice)} (${percent(before.dealerPrice, after.dealerPrice)})`;
  const mrp =
    before.mrp === after.mrp
      ? ""
      : `, MRP ${formatMoney(before.mrp)} → ${formatMoney(after.mrp)}`;
  return `• ${change.model}: ${dealer}${mrp}`;
}

/** The whole email, as the preview shows it and as the draft carries it. */
export function buildEmail(prose: DealerEmailProse, brand: Brand, changes: EmailChange[]): EmailText {
  const body = [
    prose.greeting.trim(),
    "",
    prose.intro.trim(),
    "",
    `${brand} price changes:`,
    ...changes.map(formatChangeLine),
    "",
    prose.closing.trim(),
    "",
    "Regards,",
  ].join("\n");

  return { subject: prose.subject.trim(), body };
}
