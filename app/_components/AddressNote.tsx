import { CircleCheck, Info, TriangleAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { AddressSummary } from "@/lib/affected";
import { addressNoteText } from "@/lib/drafts/wording";

/** Text with `backticks` around a command, shown in a monospace span. */
function withCode(text: string) {
  return text.split("`").map((part, index) =>
    index % 2 === 1 ? (
      <span key={index} className="font-mono text-xs">
        {part}
      </span>
    ) : (
      part
    ),
  );
}

/**
 * Whose addresses the dealers' are, so a test draft is recognisable as one
 * (context/features/feature-3-dealer-drafts.md §5). The draft can be created in
 * every case; only the wording changes, and only the placeholder is a warning.
 * The wording itself lives in lib/drafts/wording.ts.
 */
export function AddressNote({
  summary,
  connected,
}: {
  summary: AddressSummary;
  /** The connected account's address, when Gmail could be asked. */
  connected: string | null;
}) {
  const note = addressNoteText(summary, connected);
  if (note === null) return null;

  const Icon = note.tone === "ok" ? CircleCheck : note.tone === "warning" ? TriangleAlert : Info;
  return (
    <Alert variant={note.tone === "warning" ? "destructive" : "default"}>
      <Icon />
      <AlertTitle>{note.title}</AlertTitle>
      <AlertDescription>
        <p>{withCode(note.text)}</p>
        {note.hint ? <p className="mt-1">{withCode(note.hint)}</p> : null}
      </AlertDescription>
    </Alert>
  );
}
