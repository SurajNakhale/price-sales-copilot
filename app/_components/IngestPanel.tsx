"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ApiError, Candidate, IngestReport } from "@/lib/types";

interface SavedFile {
  savedAs: string;
  from: string;
  subject: string;
  emailDate: string;
}

interface IngestPanelProps {
  connected: boolean;
  saved: SavedFile[];
  connectError?: string;
}

function rowKey(row: { messageId: string; partId: string }): string {
  return `${row.messageId}\u0000${row.partId}`;
}

function formatSize(bytes: number): string {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
}

/** "Seagate Distributor <sales@x.com>" reads better as just the display name. */
function senderName(from: string): string {
  const match = /^\s*"?([^"<]*?)"?\s*</.exec(from);
  return (match?.[1] || from).trim();
}

export function IngestPanel({ connected, saved, connectError }: IngestPanelProps) {
  const router = useRouter();

  const [isConnected, setIsConnected] = useState(connected);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [scanning, setScanning] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [report, setReport] = useState<IngestReport | null>(null);
  const [error, setError] = useState<string | null>(connectError ?? null);

  const selectableKeys = (candidates ?? [])
    .filter((candidate) => !candidate.alreadyDownloaded)
    .map(rowKey);
  const busy = scanning || downloading;

  async function readError(response: Response): Promise<string> {
    const body = (await response.json().catch(() => null)) as ApiError | null;
    if (body?.error === "not_connected") setIsConnected(false);
    return body?.message ?? `Request failed (${response.status}).`;
  }

  async function scan() {
    setScanning(true);
    setError(null);
    setReport(null);
    try {
      const response = await fetch("/api/ingest/scan");
      if (!response.ok) {
        setCandidates(null);
        setError(await readError(response));
        return;
      }
      const { candidates: found } = (await response.json()) as { candidates: Candidate[] };
      setCandidates(found);
      // Everything new starts ticked; already-downloaded rows stay out.
      setSelected(new Set(found.filter((row) => !row.alreadyDownloaded).map(rowKey)));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setScanning(false);
    }
  }

  async function download() {
    if (!candidates || selected.size === 0) return;

    setDownloading(true);
    setError(null);
    try {
      const selection = candidates
        .filter((candidate) => selected.has(rowKey(candidate)))
        .map(({ messageId, partId }) => ({ messageId, partId }));

      const response = await fetch("/api/ingest/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selection }),
      });

      if (!response.ok) {
        setError(await readError(response));
        return;
      }

      const result = (await response.json()) as IngestReport;
      setReport(result);

      const saved = new Map(
        result.items
          .filter((item) => item.status !== "failed")
          .map((item) => [rowKey(item), item.savedAs]),
      );
      setCandidates(
        candidates.map((candidate) =>
          saved.has(rowKey(candidate))
            ? {
                ...candidate,
                alreadyDownloaded: true,
                savedAs: saved.get(rowKey(candidate)) ?? candidate.savedAs,
              }
            : candidate,
        ),
      );
      setSelected(new Set());
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDownloading(false);
    }
  }

  async function disconnect() {
    await fetch("/api/auth/google/disconnect", { method: "POST" });
    setIsConnected(false);
    setCandidates(null);
    setSelected(new Set());
    setReport(null);
    setError(null);
    router.refresh();
  }

  function toggle(key: string, checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  return (
    <div className="flex flex-col gap-6">
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>{isConnected ? "Something went wrong" : "Gmail is not connected"}</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Gmail</CardTitle>
          <CardDescription>
            {isConnected
              ? "Connected with read-only access. Scanning never changes your mailbox."
              : "Connect a Gmail account to look for price-list emails. Read-only access."}
          </CardDescription>
          <CardAction>
            {isConnected ? (
              <div className="flex items-center gap-2">
                <Badge variant="secondary">Connected</Badge>
                <Button variant="outline" size="sm" onClick={disconnect} disabled={busy}>
                  Disconnect
                </Button>
              </div>
            ) : (
              <a className={buttonVariants({ size: "sm" })} href="/api/auth/google">
                Connect Gmail
              </a>
            )}
          </CardAction>
        </CardHeader>

        {isConnected ? (
          <CardContent className="flex flex-wrap items-center gap-3">
            <Button onClick={scan} disabled={busy}>
              {scanning ? "Scanning…" : "Scan Gmail"}
            </Button>
            <Button
              variant="outline"
              onClick={download}
              disabled={busy || selected.size === 0}
            >
              {downloading ? "Downloading…" : `Download selected (${selected.size})`}
            </Button>
            {candidates ? (
              <span className="text-sm text-muted-foreground">
                {candidates.length === 0
                  ? "No price lists found."
                  : `${candidates.length} attachment${candidates.length === 1 ? "" : "s"} found.`}
              </span>
            ) : null}
          </CardContent>
        ) : null}
      </Card>

      {candidates && candidates.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Price lists found in Gmail</CardTitle>
            <CardDescription>
              New attachments are ticked. Untick anything that is not a price list, then download.
              Nothing is saved until you do.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox
                      aria-label="Select all new attachments"
                      checked={
                        selectableKeys.length > 0 && selected.size === selectableKeys.length
                      }
                      indeterminate={
                        selected.size > 0 && selected.size < selectableKeys.length
                      }
                      disabled={selectableKeys.length === 0 || busy}
                      onCheckedChange={(checked) =>
                        setSelected(checked ? new Set(selectableKeys) : new Set())
                      }
                    />
                  </TableHead>
                  <TableHead>File</TableHead>
                  <TableHead>From</TableHead>
                  <TableHead>Subject</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead className="text-right">Size</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {candidates.map((candidate) => {
                  const key = rowKey(candidate);
                  return (
                    <TableRow key={key}>
                      <TableCell>
                        <Checkbox
                          aria-label={`Select ${candidate.filename}`}
                          checked={selected.has(key)}
                          disabled={candidate.alreadyDownloaded || busy}
                          onCheckedChange={(checked) => toggle(key, checked)}
                        />
                      </TableCell>
                      <TableCell className="font-medium">
                        <div className="flex flex-wrap items-center gap-2">
                          {candidate.filename}
                          {candidate.alreadyDownloaded ? (
                            <Badge variant="outline">already downloaded</Badge>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell>{senderName(candidate.from)}</TableCell>
                      <TableCell className="max-w-[18rem] truncate">{candidate.subject}</TableCell>
                      <TableCell>{formatDate(candidate.emailDate)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatSize(candidate.sizeBytes)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}

      {report ? (
        <Card>
          <CardHeader>
            <CardTitle>Result</CardTitle>
            <CardDescription>
              {report.downloaded} downloaded, {report.skipped} skipped, {report.failed} failed.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-2 text-sm">
              {report.items.map((item) => (
                <li key={rowKey(item)} className="flex flex-wrap items-center gap-2">
                  <Badge
                    variant={
                      item.status === "downloaded"
                        ? "default"
                        : item.status === "failed"
                          ? "destructive"
                          : "secondary"
                    }
                  >
                    {item.status === "skipped-duplicate" ? "duplicate" : item.status}
                  </Badge>
                  <span className="font-medium">{item.savedAs ?? item.filename}</span>
                  {item.message ? (
                    <span className="text-muted-foreground">{item.message}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Saved price lists</CardTitle>
          <CardDescription>
            {saved.length === 0
              ? "Nothing downloaded yet. These are the raw files Feature 2 will read."
              : `${saved.length} file${saved.length === 1 ? "" : "s"} in mock-data/new-price-lists/.`}
          </CardDescription>
        </CardHeader>
        {saved.length > 0 ? (
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>File</TableHead>
                  <TableHead>From</TableHead>
                  <TableHead>Subject</TableHead>
                  <TableHead>Email date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {saved.map((file) => (
                  <TableRow key={file.savedAs}>
                    <TableCell className="font-medium">{file.savedAs}</TableCell>
                    <TableCell>{senderName(file.from)}</TableCell>
                    <TableCell className="max-w-[18rem] truncate">{file.subject}</TableCell>
                    <TableCell>{formatDate(file.emailDate)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        ) : null}
      </Card>
    </div>
  );
}
