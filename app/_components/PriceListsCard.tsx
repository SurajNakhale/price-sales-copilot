import Link from "next/link";

import { PriceListStatus } from "@/app/_components/PriceListStatus";
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
import { countItems, describeCounts } from "@/lib/compare";
import { fileIdFor } from "@/lib/file-id";
import { EM_DASH, formatDate, formatNumber } from "@/lib/format";
import type { ManifestEntry, PriceReview } from "@/lib/types";

/** The one action each status offers (context/ui-design.md §2.1 and §3). */
const ACTIONS = {
  downloaded: "Analyse",
  "needs-review": "Review",
  approved: "View",
  "no-changes": "View",
  failed: "Retry",
} as const;

/**
 * The files Feature 1 has downloaded, with what Feature 2 made of each.
 *
 * Brand and Changes stay — until a file is analysed: both come from the
 * normalised file, and showing 0 would read as "no changes found" rather than
 * "not looked at yet".
 */
export function PriceListsCard({
  entries,
  reviews,
  connected,
  limit,
}: {
  entries: ManifestEntry[];
  reviews: PriceReview[];
  connected: boolean;
  limit?: number;
}) {
  const sorted = [...entries].sort((a, b) =>
    b.downloadedAt.localeCompare(a.downloadedAt),
  );
  const shown = limit === undefined ? sorted : sorted.slice(0, limit);
  const reviewFor = new Map(reviews.map((review) => [review.fileId, review]));

  return (
    <Card>
      <CardHeader>
        <CardTitle>New price lists</CardTitle>
        <CardDescription>
          Supplier files downloaded from Gmail, newest first
        </CardDescription>
        {sorted.length > (limit ?? Infinity) ? (
          <CardAction>
            <Button variant="ghost" size="sm" nativeButton={false} render={<Link href="/price-updates" />}>
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
                <TableHead>Changes</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-0" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((entry) => {
                const fileId = fileIdFor(entry);
                const review = reviewFor.get(fileId);
                const state = review ? review.status : "downloaded";
                const analysed = review !== undefined && review.status !== "failed";
                const href = `/price-updates/${fileId}`;

                return (
                  <TableRow key={`${entry.messageId}:${entry.partId}`}>
                    <TableCell className="font-medium">
                      <Link href={href} className="underline-offset-4 hover:underline">
                        {entry.savedAs}
                      </Link>
                    </TableCell>
                    <TableCell className={review?.brand ? undefined : "text-muted-foreground"}>
                      {review?.brand ?? EM_DASH}
                    </TableCell>
                    <TableCell className="max-w-[220px] truncate text-muted-foreground">
                      {entry.from}
                    </TableCell>
                    <TableCell>{formatDate(entry.emailDate)}</TableCell>
                    <TableCell className={analysed ? "tabular-nums" : "text-muted-foreground"}>
                      {analysed ? describeCounts(countItems(review.items)) : EM_DASH}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-2">
                        <PriceListStatus state={state} />
                        {review?.status === "approved" ? (
                          <span className="text-xs text-muted-foreground tabular-nums">
                            {formatNumber(review.applied?.length ?? 0)} of{" "}
                            {formatNumber(review.items.length)} applied
                          </span>
                        ) : null}
                        {review?.status === "failed" && review.error ? (
                          <span className="max-w-65 truncate text-xs text-destructive" title={review.error}>
                            {review.error}
                          </span>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant={state === "needs-review" ? "default" : "outline"}
                        nativeButton={false}
                        render={<Link href={href} />}
                      >
                        {ACTIONS[state]}
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
