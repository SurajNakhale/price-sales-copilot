"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Search } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDate, senderName } from "@/lib/format";
import type { ApiError, Candidate, IngestReport } from "@/lib/types";

function rowKey(row: { messageId: string; partId: string }): string {
  return `${row.messageId}\u0000${row.partId}`;
}

function formatSize(bytes: number): string {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Feature 1's human-in-the-loop gate.
 *
 * Scanning is read-only and saves nothing. The attachments it finds arrive
 * ticked, because downloading a file is cheap and undoable, and only the ones
 * still ticked when Download is pressed are written to disk.
 */
export function ScanDialog({ connected }: { connected: boolean }) {
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [scanning, setScanning] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [report, setReport] = useState<IngestReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectableKeys = (candidates ?? [])
    .filter((candidate) => !candidate.alreadyDownloaded)
    .map(rowKey);
  const busy = scanning || downloading;

  if (!connected) {
    return (
      <a className={buttonVariants({ size: "lg" })} href="/api/auth/google">
        Connect Gmail
      </a>
    );
  }

  async function readError(response: Response): Promise<string> {
    const body = (await response.json().catch(() => null)) as ApiError | null;
    return body?.message ?? `Request failed (${response.status}).`;
  }

  async function openAndScan(next: boolean) {
    setOpen(next);
    if (!next) return;

    setScanning(true);
    setError(null);
    setReport(null);
    setCandidates(null);
    try {
      const response = await fetch("/api/ingest/scan");
      if (!response.ok) {
        setError(await readError(response));
        return;
      }
      const { candidates: found } = (await response.json()) as { candidates: Candidate[] };
      setCandidates(found);
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

  function toggle(key: string, checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  return (
    <Dialog open={open} onOpenChange={openAndScan}>
      <DialogTrigger render={<Button size="lg" />}>
        <Search />
        Scan Gmail
      </DialogTrigger>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Price lists found in Gmail</DialogTitle>
          <DialogDescription>
            Scanning is read-only and saves nothing. New attachments are ticked;
            untick anything that is not a price list.
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <Alert variant="destructive">
            <AlertTitle>Scan failed</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        {report ? (
          <Alert>
            <AlertTitle>
              {report.downloaded} downloaded, {report.skipped} skipped, {report.failed} failed
            </AlertTitle>
            <AlertDescription>
              Saved to mock-data/new-price-lists/.
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="max-h-[52vh] overflow-auto">
          {scanning ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Searching your mailbox…
            </p>
          ) : candidates === null ? null : candidates.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No price-list attachments found in the last 90 days.
            </p>
          ) : (
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
                  <TableHead data-numeric>Size</TableHead>
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
                      <TableCell className="max-w-[16rem] truncate">
                        {candidate.subject}
                      </TableCell>
                      <TableCell>{formatDate(candidate.emailDate)}</TableCell>
                      <TableCell data-numeric>{formatSize(candidate.sizeBytes)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </div>

        <DialogFooter className="items-center sm:justify-between">
          <span className="text-sm text-muted-foreground">
            {candidates === null
              ? null
              : selected.size === 0
                ? "Nothing selected"
                : `${selected.size} selected`}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              Close
            </Button>
            <Button onClick={download} disabled={busy || selected.size === 0}>
              {downloading ? "Downloading…" : `Download selected (${selected.size})`}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
