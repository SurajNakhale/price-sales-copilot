"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const COMPOSE = "https://www.googleapis.com/auth/gmail.compose";
const READONLY = "https://www.googleapis.com/auth/gmail.readonly";

export function GmailSettings({
  connected,
  tokenPath,
  scopes,
  senderAllowlist,
}: {
  connected: boolean;
  tokenPath: string;
  /** The permissions Google says the stored token covers. */
  scopes: string[];
  senderAllowlist: string[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function disconnect() {
    setBusy(true);
    try {
      await fetch("/api/auth/google/disconnect", { method: "POST" });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Gmail</CardTitle>
        <CardDescription>
          {connected
            ? scopes.includes(COMPOSE)
              ? "Connected. Reading mail, and saving drafts for Feature 3. The app never sends."
              : "Connected with read-only access. Scanning never changes your mailbox."
            : "Connect a Gmail account to look for price-list emails. Read-only access."}
        </CardDescription>
        <CardAction>
          {connected ? (
            <div className="flex items-center gap-2">
              <Badge variant="secondary">Connected</Badge>
              <Button variant="outline" size="sm" onClick={disconnect} disabled={busy}>
                {busy ? "Disconnecting…" : "Disconnect"}
              </Button>
            </div>
          ) : (
            <a className={buttonVariants({ size: "sm" })} href="/api/auth/google">
              Connect Gmail
            </a>
          )}
        </CardAction>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-3 text-sm sm:grid-cols-[10rem_1fr]">
          <dt className="text-muted-foreground">Permissions granted</dt>
          <dd className="space-y-1">
            {scopes.length === 0 ? (
              <span className="text-muted-foreground">None: Gmail is not connected.</span>
            ) : (
              <>
                <p>
                  Read mail{" "}
                  <span className="font-mono text-xs text-muted-foreground">gmail.readonly</span>
                  {scopes.includes(READONLY) ? "" : " (not granted)"}
                </p>
                <p>
                  Save drafts{" "}
                  <span className="font-mono text-xs text-muted-foreground">gmail.compose</span>
                  {scopes.includes(COMPOSE)
                    ? ". Google words this as “Manage drafts and send emails”, so it could send, but the app has no code that does."
                    : ": not granted. It is asked for when you first create a draft in a price list's workflow."}
                </p>
              </>
            )}
          </dd>

          <dt className="text-muted-foreground">Tokens stored at</dt>
          <dd className="font-mono text-xs break-all">{tokenPath}</dd>

          <dt className="text-muted-foreground">Sender allowlist</dt>
          <dd>
            {senderAllowlist.length === 0 ? (
              <span className="text-muted-foreground">
                Empty — any sender. Set SENDER_ALLOWLIST in .env.local to narrow it.
              </span>
            ) : (
              <span className="font-mono text-xs">{senderAllowlist.join(", ")}</span>
            )}
          </dd>
        </dl>
      </CardContent>
    </Card>
  );
}
