import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EM_DASH, formatDate } from "@/lib/format";
import type { ManifestEntry } from "@/lib/types";

/**
 * The files Feature 1 has downloaded.
 *
 * Brand and Changes are blank on purpose: both are only known once Feature 2
 * normalises a file, and the manifest records neither. Showing 0 would read
 * as "no changes found" rather than "not looked at yet".
 */
export function PriceListsCard({
  entries,
  connected,
  limit,
}: {
  entries: ManifestEntry[];
  connected: boolean;
  limit?: number;
}) {
  const sorted = [...entries].sort((a, b) =>
    b.downloadedAt.localeCompare(a.downloadedAt),
  );
  const shown = limit === undefined ? sorted : sorted.slice(0, limit);

  return (
    <Card>
      <CardHeader>
        <CardTitle>New price lists</CardTitle>
        <CardDescription>
          Supplier files downloaded from Gmail, newest first
        </CardDescription>
        {sorted.length > (limit ?? Infinity) ? (
          <CardAction>
            <Button variant="ghost" size="sm" render={<Link href="/price-updates" />}>
              View all {sorted.length}
            </Button>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent>
        {shown.length === 0 ? (
          <p className="py-6 text-sm text-muted-foreground">
            {connected
              ? "Nothing downloaded yet. Scan Gmail to find price-list attachments."
              : "Connect Gmail in Settings to find price-list attachments."}
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>File</TableHead>
                <TableHead>Brand</TableHead>
                <TableHead>From</TableHead>
                <TableHead>Received</TableHead>
                <TableHead data-numeric>Changes</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((entry) => (
                <TableRow key={`${entry.messageId}:${entry.partId}`}>
                  <TableCell className="font-medium">{entry.savedAs}</TableCell>
                  <TableCell className="text-muted-foreground">{EM_DASH}</TableCell>
                  <TableCell className="max-w-[220px] truncate text-muted-foreground">
                    {entry.from}
                  </TableCell>
                  <TableCell>{formatDate(entry.emailDate)}</TableCell>
                  <TableCell data-numeric className="text-muted-foreground">
                    {EM_DASH}
                  </TableCell>
                  <TableCell>
                    <StatusBadge />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

/** Every downloaded file sits at the same status until Feature 2 can analyse it. */
function StatusBadge() {
  return (
    <Badge variant="outline" className="gap-1.5 font-normal">
      <span
        aria-hidden
        className="size-1.5 rounded-full"
        style={{ backgroundColor: "var(--status-neutral)" }}
      />
      Downloaded
    </Badge>
  );
}
