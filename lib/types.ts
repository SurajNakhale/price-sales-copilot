/** The three brands in the catalogue. */
export type Brand = "Seagate" | "Samsung" | "TP-Link";

/**
 * One row of mock-data/current-price-lists/current-price-list.json.
 * `status` is absent on an active product, so presence in the file means
 * "we stock this". See context/architecture.md section 6.2.
 */
export interface Product {
  productId: string;
  brand: Brand;
  model: string;
  category: string;
  dealerPrice: number;
  mrp: number;
  status?: "discontinued";
  /** ISO date, set when the deactivation was approved. */
  discontinuedOn?: string;
}

/** One row of mock-data/dealers/dealers.json. */
export interface Dealer {
  dealer: string;
  state: string;
  email: string;
}

/** One invoice line of mock-data/sales/sales-data.json. `unitPrice` is per unit. */
export interface SalesLine {
  invoiceNo: string;
  date: string;
  dealer: string;
  state: string;
  productId: string;
  model: string;
  quantity: number;
  unitPrice: number;
}

/** One downloaded attachment, recorded in mock-data/new-price-lists/manifest.json. */
export interface ManifestEntry {
  /** Gmail message id. With partId this is the dedup key. */
  messageId: string;
  /** MIME part id within that message. */
  partId: string;
  /** Filename on disk, after sanitizing and any collision rename. */
  savedAs: string;
  /** Filename exactly as Gmail reported it. */
  originalName: string;
  from: string;
  subject: string;
  /** ISO 8601. */
  emailDate: string;
  /** SHA-256 of the file contents, used to tell same-name files apart. */
  sha256: string;
  /** ISO 8601. */
  downloadedAt: string;
}

/** A price-list attachment found by a scan. Nothing is saved at this point. */
export interface Candidate {
  messageId: string;
  partId: string;
  filename: string;
  sizeBytes: number;
  from: string;
  subject: string;
  emailDate: string;
  alreadyDownloaded: boolean;
  /** Set when alreadyDownloaded: the name it was saved under. */
  savedAs?: string;
}

/** All the client may send back. Filenames are re-derived from Gmail server-side. */
export interface Selection {
  messageId: string;
  partId: string;
}

export type IngestStatus = "downloaded" | "skipped-duplicate" | "failed";

export interface IngestItem {
  messageId: string;
  partId: string;
  /** Best effort: the Gmail filename, or "(unknown)" if the part could not be read. */
  filename: string;
  status: IngestStatus;
  savedAs?: string;
  /** Why it was skipped or how it failed. */
  message?: string;
}

export interface IngestReport {
  items: IngestItem[];
  downloaded: number;
  skipped: number;
  failed: number;
}

/** Shape of an error response from every API route. */
export interface ApiError {
  error:
    | "not_connected"
    | "missing_config"
    | "bad_request"
    | "not_found"
    | "conflict"
    | "unusable_file"
    | "invalid_llm_output"
    | "internal";
  message: string;
}

// ---------------------------------------------------------------------------
// Feature 2: normalise, compare, approve.
// See context/features/feature-2-normalise-compare-approve.md.
// ---------------------------------------------------------------------------

/** One spreadsheet cell as read from the file. Dates become ISO strings. */
export type Cell = string | number | boolean | null;

/** A parsed supplier file: the sheet used (null for csv) and its rows. */
export interface ParsedSheet {
  sheet: string | null;
  rows: Cell[][];
}

/**
 * What the LLM proposes for one file: which row holds the headers and which
 * header is which field. Never rows or prices; code applies it.
 */
export interface ColumnMapping {
  /** 1-based row number of the header row. */
  headerRow: number;
  brand: Brand;
  columns: {
    model: string;
    /** Null when the file has no category column. */
    category: string | null;
    dealerPrice: string;
    mrp: string;
  };
}

/** A row the mapping could not use, shown to the reviewer rather than dropped. */
export interface RowIssue {
  rowNumber: number;
  reason: string;
}

/** A data row after the mapping is applied, before it is matched. */
export interface MappedRow {
  rowNumber: number;
  /** The model exactly as the supplier wrote it, trimmed. */
  supplierModel: string;
  category: string | null;
  dealerPrice: number;
  mrp: number;
}

/** How a row found its Product ID. */
export type MatchMethod = "key" | "llm" | "new";

/** One row of the normalised file: the standard price-list shape plus provenance. */
export interface NormalizedRow {
  rowNumber: number;
  productId: string;
  match: MatchMethod;
  supplierModel: string;
  brand: Brand;
  /** The catalogue's model name when matched, the supplier's when new. */
  model: string;
  category: string;
  dealerPrice: number;
  mrp: number;
  /** The file's category, when it differs from the catalogue's. Shown, never applied. */
  fileCategory?: string;
}

/** `.data/normalized/<fileId>.json`: the separate normalised object the comparison reads. */
export interface NormalizedPriceList {
  fileId: string;
  sourceFile: string;
  sheet: string | null;
  brand: Brand;
  mapping: ColumnMapping;
  rows: NormalizedRow[];
  issues: RowIssue[];
  normalizedAt: string;
}

export interface Prices {
  dealerPrice: number;
  mrp: number;
}

export interface PriceChangeItem {
  kind: "price-change";
  itemId: string;
  productId: string;
  brand: Brand;
  model: string;
  supplierModel: string;
  match: MatchMethod;
  old: Prices;
  new: Prices;
  fileCategory?: string;
}

export interface NewProductItem {
  kind: "new-product";
  itemId: string;
  productId: string;
  brand: Brand;
  model: string;
  category: string;
  dealerPrice: number;
  mrp: number;
  /** Matched a discontinued product: approving reuses its ID and clears `status`. */
  reactivates: boolean;
}

export interface MissingItem {
  kind: "missing";
  itemId: string;
  productId: string;
  brand: Brand;
  model: string;
  category: string;
  dealerPrice: number;
  mrp: number;
}

export type ReviewItem = PriceChangeItem | NewProductItem | MissingItem;

export type ReviewStatus = "needs-review" | "approved" | "no-changes" | "failed";

/** `.data/reviews/<fileId>.json`: the pending changes and, once approved, what was applied. */
export interface PriceReview {
  fileId: string;
  sourceFile: string;
  /** Null only when the analysis failed before the brand was known. */
  brand: Brand | null;
  status: ReviewStatus;
  rowsInFile: number;
  unchanged: number;
  /** How many rows were skipped as issues. */
  issues: number;
  items: ReviewItem[];
  analysedAt: string;
  /** Set when status is "failed". */
  error?: string;
  approvedAt?: string;
  /** Item IDs written to the current price list. The handoff to Feature 3. */
  applied?: string[];
}

/** An item that no longer matches the current price list, and why. */
export interface OutdatedItem {
  itemId: string;
  reason: string;
}
