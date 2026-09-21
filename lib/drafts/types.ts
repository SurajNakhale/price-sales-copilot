/**
 * The shapes Feature 3 stores and shows. Types only, so the page's client
 * components can import them. See context/features/feature-3-dealer-drafts.md §8.
 */

/** The words Gemini writes. Every number in the email comes from the review instead. */
export interface DealerEmailProse {
  subject: string;
  greeting: string;
  intro: string;
  closing: string;
}

export interface DraftMessage extends DealerEmailProse {
  /** "template" is the standard message, used when Gemini's wording was unusable or was skipped. */
  source: "model" | "template";
  /** The Gemini model, when source is "model". */
  model?: string;
  /** Why the standard message is shown, when it is. */
  note?: string;
  generatedAt: string;
}

/** A draft the app created in Gmail. The app never edits or deletes it afterwards. */
export interface CreatedDraft {
  draftId: string;
  /** The Gmail message inside the draft, which the Open in Gmail link needs. */
  messageId: string;
  createdAt: string;
  to: string;
  /** Dealers the draft is for, and how many distinct Bcc addresses that made. */
  recipients: number;
  addresses: number;
  subject: string;
}

/** `.data/drafts/<fileId>.json` */
export interface DraftState {
  fileId: string;
  message: DraftMessage | null;
  drafts: CreatedDraft[];
}

export interface EmailText {
  subject: string;
  body: string;
}
