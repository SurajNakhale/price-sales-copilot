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
