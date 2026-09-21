/**
 * The number check. Every number in the model's sentence must occur in a tool
 * result (or in the question itself, which may say "top 5" or "last 90 days").
 * A sentence with any other number is not shown; the tool's template sentence
 * is shown instead. Rupee signs, Indian digit grouping and signs are ignored,
 * so "₹4,32,540", "432540" and "₹4.3L" all match a result holding them.
 *
 * Known limit: numbers written as words are not seen, which is why the prompt
 * asks for digits. Pure.
 */

const NUMBER = /\d[\d,]*(?:\.\d+)?/g;

export function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const match of text.matchAll(NUMBER)) {
    const value = Number.parseFloat(match[0].replace(/,/g, ""));
    if (Number.isFinite(value)) out.push(value);
  }
  return out;
}

export function allowedNumbers(sources: unknown[]): Set<number> {
  const allowed = new Set<number>();
  for (const source of sources) {
    const text = typeof source === "string" ? source : JSON.stringify(source);
    for (const value of numbersIn(text ?? "")) allowed.add(value);
  }
  return allowed;
}

export interface GuardResult {
  ok: boolean;
  /** Numbers in the sentence that no result contains. */
  unsupported: number[];
}

export function checkNumbers(sentence: string, allowed: Set<number>): GuardResult {
  const unsupported = [...new Set(numbersIn(sentence).filter((value) => !allowed.has(value)))];
  return { ok: unsupported.length === 0, unsupported };
}

export function hasDigit(text: string): boolean {
  return /\d/.test(text);
}
