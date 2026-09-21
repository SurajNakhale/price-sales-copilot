import "server-only";

import path from "node:path";

/** Where Feature 1 saves the raw supplier files, and the manifest beside them. */
export const NEW_PRICE_LIST_DIR = path.join(
  process.cwd(),
  "mock-data",
  "new-price-lists",
);
export const MANIFEST_FILE = path.join(NEW_PRICE_LIST_DIR, "manifest.json");

/** The three datasets the app reads. Written only by scripts/generate-mock-data.ts. */
export const PRODUCTS_FILE = path.join(
  process.cwd(),
  "mock-data",
  "current-price-lists",
  "current-price-list.json",
);
export const DEALERS_FILE = path.join(process.cwd(), "mock-data", "dealers", "dealers.json");
export const SALES_FILE = path.join(process.cwd(), "mock-data", "sales", "sales-data.json");

/** Gitignored runtime state. */
export const DATA_DIR = path.join(process.cwd(), ".data");
export const TOKEN_FILE = path.join(DATA_DIR, "google-tokens.json");

/** Feature 2 working state: the normalised file and the review, one each per price list. */
export const NORMALIZED_DIR = path.join(DATA_DIR, "normalized");
export const REVIEWS_DIR = path.join(DATA_DIR, "reviews");

/**
 * Feature 3 working state: the message written for a price list, and the drafts made from it.
 * The 90-day window and the recipient cap live in lib/affected.ts, which the browser also loads.
 */
export const DRAFTS_DIR = path.join(DATA_DIR, "drafts");

/** A supplier file with more rows than this is refused rather than analysed. */
export const MAX_PRICE_LIST_ROWS = 2000;

/** Rows from the top of a file the LLM sees when proposing a column mapping. */
export const LLM_SAMPLE_ROWS = 15;

/** Each cell sent to the LLM is cut to this many characters. */
export const LLM_MAX_CELL_LENGTH = 80;

/**
 * Overridable with LLM_MODEL, and per feature with ANALYSE_MODEL / COPILOT_MODEL.
 * See context/architecture.md section 7.
 */
export const DEFAULT_LLM_MODEL = "gemini-3.8-flash";

/** Only these attachments are ever downloaded. Lowercase, with the dot. */
export const ALLOWED_EXTENSIONS = [".xlsx", ".csv"] as const;

/** How many messages one scan looks at. */
export const MAX_MESSAGES = 25;

/** Connect asks for this alone: Feature 1 reads Gmail and nothing else. */
export const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

/**
 * Feature 3's draft permission, asked for only when the user first creates a draft.
 * Google describes it as "Manage drafts and send emails" and offers no narrower
 * scope that creates drafts, so the app's promise never to send is enforced in
 * code (and by a test), not by this permission.
 */
export const GMAIL_COMPOSE_SCOPE = "https://www.googleapis.com/auth/gmail.compose";

export const OAUTH_STATE_COOKIE = "google_oauth_state";
/** Set while "Allow Gmail drafts" is in progress: where to return to, and that drafts were asked for. */
export const OAUTH_RETURN_COOKIE = "google_oauth_return";
export const OAUTH_DRAFTS_COOKIE = "google_oauth_drafts";

export const DEFAULT_REDIRECT_URI =
  "http://localhost:3000/api/auth/google/callback";

/** Comma-separated in the environment; empty means any sender. */
export function senderAllowlist(): string[] {
  return (process.env.SENDER_ALLOWLIST ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Gmail's `filename:` matching is loose and xlsx often arrives as
 * application/octet-stream, so extensions are re-checked in code as well.
 */
export function buildGmailQuery(): string {
  const clauses = [
    "has:attachment",
    "(filename:xlsx OR filename:csv)",
    '(subject:(price OR pricing OR "price list") OR filename:price)',
    "newer_than:90d",
  ];

  const senders = senderAllowlist();
  if (senders.length > 0) {
    clauses.push(`(${senders.map((s) => `from:${s}`).join(" OR ")})`);
  }

  return clauses.join(" ");
}

export function hasAllowedExtension(filename: string): boolean {
  const lower = filename.toLowerCase();
  return ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}
