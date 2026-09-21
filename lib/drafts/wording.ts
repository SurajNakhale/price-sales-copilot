import { PLACEHOLDER_EMAIL_BASE, type AddressSummary, type AffectedResult } from "@/lib/affected";
import { formatDate, formatNumber } from "@/lib/format";

/**
 * What steps 4 and 5 say about the dealers and their addresses, as plain data
 * the components render. Kept out of the JSX so it can be tested directly.
 * See context/features/feature-3-dealer-drafts.md §5. Pure.
 */

export interface AddressNoteText {
  /** "warning" is the only alarming tone, and only the placeholder earns it. */
  tone: "ok" | "warning" | "info";
  title: string;
  text: string;
  /** What to do about it. Backticks mark a command. */
  hint?: string;
}

function addressesPhrase(n: number): string {
  return `${n} ${n === 1 ? "address" : "addresses"}`;
}

/** "This address" / "These 13 addresses", with the verb to match: is/are, uses/use. */
function these(n: number): { subject: string; be: string; verb: (base: string) => string } {
  return n === 1
    ? { subject: "This address", be: "is", verb: (base) => `${base}s` }
    : { subject: `These ${n} addresses`, be: "are", verb: (base) => base };
}

/**
 * Whose addresses these are, judged against the connected account. The draft
 * can be created in every case. Null when there is nothing to say.
 */
export function addressNoteText(summary: AddressSummary, connected: string | null): AddressNoteText | null {
  if (summary.total === 0) return null;
  const n = summary.total;
  const all = these(n);

  switch (summary.kind) {
    case "own":
      return {
        tone: "ok",
        title: "Your own aliases",
        text:
          `${all.subject} ${all.be} ${n === 1 ? "an alias" : "aliases"} of your own Gmail (${connected}): every copy lands in your inbox, ` +
          "so this is safe to test. The draft is only saved, never sent.",
      };

    case "placeholder": {
      const p = summary.placeholder;
      const who = p === n ? `${all.subject} ${all.verb("use")}` : `${p} of these ${addressesPhrase(n)} ${these(p).verb("use")}`;
      return {
        tone: "warning",
        title: "Test addresses detected",
        text:
          `${who} the placeholder ${PLACEHOLDER_EMAIL_BASE}+dealerN@gmail.com, which is not your account. ` +
          "The draft is only saved, never sent, and you can still create it.",
        hint: "To test with your own inbox, run `bun run mock:dealer-emails <your Gmail address>`.",
      };
    }

    case "external": {
      const e = summary.external;
      const who = e === n ? `${all.subject} ${all.be}` : `${e} of these ${addressesPhrase(n)} ${these(e).be}`;
      return {
        tone: "info",
        title: "Addresses outside your account",
        text: `${who} outside your account. The draft is only saved, never sent; if you send it from Gmail, ${n === 1 ? "this dealer" : "these dealers"} will receive it.`,
      };
    }

    default:
      return {
        tone: "info",
        title: "Addresses not checked",
        text: `Connect Gmail to check ${n === 1 ? "this address" : `these ${addressesPhrase(n)}`} against your account. The draft is only saved, never sent.`,
      };
  }
}

function count(n: number, one: string, many = `${one}s`): string {
  return `${formatNumber(n)} ${n === 1 ? one : many}`;
}

/** "13 dealers of 20 bought T7 1TB, T7 2TB between 20 Jun 2026 and 18 Sep 2026 (the last 90 days)". */
export function affectedHeadline(affected: AffectedResult, dealerCount: number): string {
  const { window, dealers, models } = affected;
  if (window === null) return "";
  return (
    `${count(dealers.length, "dealer")} of ${formatNumber(dealerCount)} bought ${models.map((m) => m.model).join(", ")} ` +
    `between ${formatDate(window.from)} and ${formatDate(window.today)} (the last ${window.days} days)`
  );
}

/** What the approval did that is not a price change, so the screen can say what it does not cover. */
export function leftOutLines(leftOut: AffectedResult["leftOut"]): string[] {
  const lines: string[] = [];
  if (leftOut.newProducts > 0) lines.push(`${count(leftOut.newProducts, "new product")} (no purchase history yet)`);
  if (leftOut.deactivated > 0) lines.push(`${count(leftOut.deactivated, "deactivated product")} (not a price change)`);
  if (leftOut.notApplied > 0) lines.push(`${count(leftOut.notApplied, "item")} you did not approve`);
  return lines;
}
