"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { CircleCheck, ExternalLink, EyeOff, PenLine, RefreshCw, TriangleAlert } from "lucide-react";

import { AddressNote } from "@/app/_components/AddressNote";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { AddressSummary } from "@/lib/affected";
import type { CreatedDraft, DraftMessage, EmailText } from "@/lib/drafts/types";
import { formatDate } from "@/lib/format";
import type { ApiError } from "@/lib/types";

/**
 * Workflow step 5, Draft email (context/ui-design.md §2.6).
 *
 * Gemini writes the words; the app adds every price. The user reads the
 * preview, then saves it as a Gmail draft: To is their own account, and the
 * dealers are in Bcc so they cannot see each other. Nothing is sent, ever.
 */
export function DraftPanel({
  fileId,
  connectedAddress,
  addresses,
  dealers,
  bccAddresses,
  message,
  email,
  drafts,
  openUrl,
  hasDraftPermission,
  outcome,
}: {
  fileId: string;
  /** The connected account, where the draft's To goes. Null when Gmail is not connected. */
  connectedAddress: string | null;
  addresses: AddressSummary;
  /** Dealers with an address, and the distinct Bcc addresses they make. */
  dealers: number;
  bccAddresses: number;
  message: DraftMessage | null;
  /** The email as it will be drafted, built on the server from the stored message. */
  email: EmailText | null;
  drafts: CreatedDraft[];
  /** Opens the latest draft in Gmail. */
  openUrl: string | null;
  hasDraftPermission: boolean;
  /** What came back from Google after "Allow Gmail drafts". */
  outcome?: { drafts?: string; error?: string };
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<"writing" | "creating" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsPermission, setNeedsPermission] = useState(false);
  const [confirmAnother, setConfirmAnother] = useState(false);

  const latest = drafts.at(-1) ?? null;
  const ready = bccAddresses > 0;
  const allowUrl = `/api/auth/google?drafts=1&returnTo=${encodeURIComponent(`/price-updates/${fileId}`)}`;
  const canCreate = hasDraftPermission && !needsPermission;

  async function post(path: string, body: Record<string, unknown>): Promise<boolean> {
    const response = await fetch(`/api/prices/${fileId}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.ok) return true;
    const failure = (await response.json().catch(() => null)) as ApiError | null;
    if (failure?.error === "gmail_scope_missing") setNeedsPermission(true);
    setError(failure?.message ?? `The request failed (${response.status}).`);
    return false;
  }

  async function write(template: boolean) {
    setBusy("writing");
    setError(null);
    try {
      if (await post("draft/message", template ? { template: true } : {})) router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  async function create(another: boolean) {
    setBusy("creating");
    setError(null);
    try {
      if (await post("draft", another ? { another: true } : {})) {
        setConfirmAnother(false);
        router.refresh();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Draft email</CardTitle>
        <CardDescription>
          Step 5 · Gemini writes the words, the app adds every price, and you send it from Gmail
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {outcome?.drafts === "granted" ? (
          <Alert>
            <CircleCheck />
            <AlertTitle>Gmail can now save drafts</AlertTitle>
            <AlertDescription>Permission granted. Create the draft when you are happy with the message.</AlertDescription>
          </Alert>
        ) : null}
        {outcome?.drafts === "denied" ? (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertTitle>The draft permission was not given</AlertTitle>
            <AlertDescription>
              Google lets you untick it on the consent screen. Press Allow Gmail drafts again and leave it ticked.
            </AlertDescription>
          </Alert>
        ) : null}
        {outcome?.drafts === "error" ? (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertTitle>Google sign-in did not finish</AlertTitle>
            <AlertDescription>{outcome.error ?? "Try Allow Gmail drafts again."}</AlertDescription>
          </Alert>
        ) : null}

        <AddressNote summary={addresses} connected={connectedAddress} />

        {!ready ? (
          <p className="text-sm text-muted-foreground">
            No affected dealer has a usable email address, so there is nothing to put in Bcc.
          </p>
        ) : (
          <>
            <dl className="grid gap-1.5 rounded-lg border bg-muted/40 p-3 text-sm sm:grid-cols-[4rem_1fr]">
              <dt className="text-muted-foreground">To</dt>
              <dd>{connectedAddress ?? "your Gmail account"}</dd>
              <dt className="text-muted-foreground">Bcc</dt>
              <dd className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary" className="gap-1">
                  <EyeOff className="size-3" aria-hidden />
                  {dealers} {dealers === 1 ? "dealer" : "dealers"} · hidden from each other
                </Badge>
                <span className="text-xs text-muted-foreground">
                  {bccAddresses} {bccAddresses === 1 ? "address" : "addresses"}
                </span>
              </dd>
              <dt className="text-muted-foreground">Subject</dt>
              <dd className="font-medium">{email?.subject ?? "Not written yet"}</dd>
            </dl>

            {email && message ? (
              <div className="space-y-1.5">
                <pre className="rounded-lg border bg-card p-3 font-sans text-sm leading-relaxed whitespace-pre-wrap">
                  {email.body}
                </pre>
                <p className="text-xs text-muted-foreground">
                  {message.source === "model"
                    ? `Wording by Gemini (${message.model}); every price was added by the app from the approved review.`
                    : "Standard message. Every price was added by the app from the approved review."}
                  {message.note ? ` ${message.note}` : ""}
                </p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                Write the message first. Gemini sees the changed products and prices only, never a dealer name or address.
              </p>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button variant={message ? "outline" : "default"} onClick={() => write(false)} disabled={busy !== null}>
                {message ? <RefreshCw /> : <PenLine />}
                {busy === "writing" ? "Writing…" : message ? "Rewrite" : "Write message"}
              </Button>
              <Button variant="ghost" onClick={() => write(true)} disabled={busy !== null}>
                Use the standard message (no Gemini)
              </Button>
            </div>
          </>
        )}

        {error ? (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertTitle>Could not do that</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        {ready && latest ? (
          <Alert>
            <CircleCheck />
            <AlertTitle>Draft created {formatDate(latest.createdAt)}</AlertTitle>
            <AlertDescription>
              <p>
                Saved in Gmail with {latest.recipients} {latest.recipients === 1 ? "dealer" : "dealers"} in Bcc
                {drafts.length > 1 ? ` (${drafts.length} drafts so far)` : ""}. Nothing was sent: review it in Gmail,
                edit it if you like, and send it from there.
              </p>
              {openUrl ? (
                <a
                  className={`${buttonVariants({ variant: "outline", size: "sm" })} mt-2`}
                  href={openUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  <ExternalLink />
                  Open in Gmail
                </a>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}

        {ready && message ? (
          <div className="space-y-2">
            {!canCreate ? (
              <div className="space-y-1.5">
                <a className={buttonVariants()} href={allowUrl}>
                  Allow Gmail drafts
                </a>
                <p className="text-xs text-muted-foreground">
                  Google will ask for permission to manage drafts (its wording is “Manage drafts and send emails”: the
                  permission cannot be narrower). This app only ever saves a draft. It has no code that sends.
                </p>
              </div>
            ) : latest && !confirmAnother ? (
              <Button variant="outline" onClick={() => setConfirmAnother(true)} disabled={busy !== null}>
                Create another draft
              </Button>
            ) : latest ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm">Create another draft? The first stays in Gmail.</span>
                <Button onClick={() => create(true)} disabled={busy !== null}>
                  {busy === "creating" ? "Creating…" : "Yes, create another"}
                </Button>
                <Button variant="ghost" onClick={() => setConfirmAnother(false)} disabled={busy !== null}>
                  Cancel
                </Button>
              </div>
            ) : (
              <div className="space-y-1.5">
                <Button onClick={() => create(false)} disabled={busy !== null}>
                  {busy === "creating" ? "Creating…" : "Create Gmail draft"}
                </Button>
                <p className="text-xs text-muted-foreground">
                  Nothing is sent. The draft is saved in Gmail for you to review and send.
                </p>
              </div>
            )}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
