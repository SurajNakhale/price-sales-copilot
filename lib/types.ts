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

/** Shape of an error response from the Feature 1 API routes. */
export interface ApiError {
  error: "not_connected" | "missing_config" | "bad_request" | "internal";
  message: string;
}
