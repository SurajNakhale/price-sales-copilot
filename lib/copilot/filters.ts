import type { SalesLine } from "@/lib/types";

import type { CopilotData, Filters } from "./types";

/**
 * Resolves the model's filter words against the real names in the data.
 *
 * Brands, categories and states match exactly, ignoring case and punctuation
 * ("tplink", "TP Link" and "TP-Link" are the same; a trailing plural "s" is
 * forgiven). Models and dealers match whole words anywhere in the name, so
 * "T7" finds T7 1TB, T7 2TB and T7 Shield 1TB, and "ABC" finds ABC Computers.
 * A value that matches nothing becomes a note in the result, never a guess.
 * Pure.
 */

const UNITS = "tb|gb|mb";

export function normaliseName(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .replace(new RegExp(`(\\d) (${UNITS})\\b`, "g"), "$1$2");
}

function compact(text: string): string {
  return normaliseName(text).replace(/ /g, "");
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

/** Exact match, ignoring case, punctuation and a trailing plural "s". */
function matchExact(wanted: string, vocabulary: string[]): string[] {
  const key = compact(wanted);
  if (!key) return [];
  const exact = vocabulary.filter((entry) => compact(entry) === key);
  if (exact.length > 0 || !key.endsWith("s")) return exact;
  return vocabulary.filter((entry) => compact(entry) === key.slice(0, -1));
}

/** Whole words anywhere in the name; failing that, the letters run together. */
function matchWords(wanted: string, vocabulary: string[]): string[] {
  const words = normaliseName(wanted);
  if (!words) return [];
  const byWords = vocabulary.filter((entry) => ` ${normaliseName(entry)} `.includes(` ${words} `));
  if (byWords.length > 0) return byWords;
  const letters = compact(wanted);
  return letters.length >= 3 ? vocabulary.filter((entry) => compact(entry).includes(letters)) : [];
}

/** "Samsung T7" should find the T7 models, so a leading brand name is dropped. */
function dropBrand(model: string, brands: string[]): string {
  const words = normaliseName(model);
  for (const brand of brands) {
    for (const prefix of [normaliseName(brand), compact(brand)]) {
      if (words.startsWith(`${prefix} `)) return words.slice(prefix.length + 1);
    }
  }
  return model;
}

function listOr(values: string[]): string {
  if (values.length <= 1) return values.join("");
  return `${values.slice(0, -1).join(", ")} or ${values[values.length - 1]}`;
}

export interface Vocabulary {
  brands: string[];
  categories: string[];
  models: string[];
  dealers: string[];
  states: string[];
}

/** Every name the model may filter on. Dealer emails are deliberately absent. */
export function vocabularyOf(data: CopilotData): Vocabulary {
  return {
    brands: unique(data.products.map((product) => product.brand)),
    categories: unique(data.products.map((product) => product.category)),
    models: unique(data.products.map((product) => product.model)),
    dealers: unique([...data.dealers.map((d) => d.dealer), ...data.sales.map((l) => l.dealer)]),
    states: unique([...data.dealers.map((d) => d.state), ...data.sales.map((l) => l.state)]),
  };
}

export interface ResolvedFilters {
  /** Product IDs allowed by the brand, category and model filters; null when none were given. */
  productIds: Set<string> | null;
  dealers: Set<string> | null;
  states: Set<string> | null;
  brands: string[] | null;
  categories: string[] | null;
  models: string[] | null;
  /** "brand is Samsung". */
  applied: string[];
  /** Values that matched nothing. */
  notes: string[];
}

function resolveField(
  label: string,
  plural: string,
  wanted: string[] | undefined,
  vocabulary: string[],
  match: (value: string) => string[],
  notes: string[],
): string[] | null {
  const values = (wanted ?? []).map((value) => value.trim()).filter(Boolean);
  if (values.length === 0) return null;

  const found: string[] = [];
  for (const value of values) {
    const hits = match(value);
    if (hits.length === 0) {
      const hint = vocabulary.length <= 12 ? ` The ${plural} are ${vocabulary.join(", ")}.` : "";
      notes.push(`No ${label} matches "${value}".${hint}`);
    }
    found.push(...hits);
  }
  return unique(found);
}

export function resolveFilters(filters: Filters | undefined, data: CopilotData): ResolvedFilters {
  const vocab = vocabularyOf(data);
  const notes: string[] = [];

  const brands = resolveField("brand", "brands", filters?.brands, vocab.brands, (v) => matchExact(v, vocab.brands), notes);
  const categories = resolveField(
    "category", "categories", filters?.categories, vocab.categories,
    (v) => matchExact(v, vocab.categories), notes,
  );
  const models = resolveField(
    "model", "models", filters?.models, vocab.models,
    (v) => matchWords(dropBrand(v, vocab.brands), vocab.models), notes,
  );
  const dealers = resolveField("dealer", "dealers", filters?.dealers, vocab.dealers, (v) => matchWords(v, vocab.dealers), notes);
  const states = resolveField("state", "states", filters?.states, vocab.states, (v) => matchExact(v, vocab.states), notes);

  let productIds: Set<string> | null = null;
  if (brands || categories || models) {
    productIds = new Set(
      data.products
        .filter(
          (product) =>
            (!brands || brands.includes(product.brand)) &&
            (!categories || categories.includes(product.category)) &&
            (!models || models.includes(product.model)),
        )
        .map((product) => product.productId),
    );
  }

  const applied: string[] = [];
  const describe = (field: string, values: string[] | null) => {
    if (values === null) return;
    applied.push(values.length === 0 ? `${field} matches nothing` : `${field} is ${listOr(values)}`);
  };
  describe("brand", brands);
  describe("category", categories);
  describe("model", models);
  describe("dealer", dealers);
  describe("state", states);

  return {
    productIds,
    dealers: dealers ? new Set(dealers) : null,
    states: states ? new Set(states) : null,
    brands,
    categories,
    models,
    applied,
    notes,
  };
}

export function lineMatches(line: SalesLine, filters: ResolvedFilters): boolean {
  return (
    (!filters.productIds || filters.productIds.has(line.productId)) &&
    (!filters.dealers || filters.dealers.has(line.dealer)) &&
    (!filters.states || filters.states.has(line.state))
  );
}
