import { Check } from "lucide-react";

import { AddressNote } from "@/app/_components/AddressNote";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { AddressSummary, AffectedResult } from "@/lib/affected";
import { affectedHeadline, leftOutLines } from "@/lib/drafts/wording";
import { formatDate, formatNumber } from "@/lib/format";

/**
 * Workflow step 4, Affected dealers (context/ui-design.md §2.6). Computed by
 * code from the approved review and the sales file: no LLM, no Gmail needed.
 */
export function AffectedDealers({
  affected,
  addresses,
  connected,
  dealerCount,
}: {
  affected: AffectedResult;
  addresses: AddressSummary;
  connected: string | null;
  /** Dealers in the dealer list, for "13 of 20". */
  dealerCount: number;
}) {
  const { window, dealers, models, skipped, recipients, leftOut } = affected;

  if (models.length === 0 || window === null) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Affected dealers</CardTitle>
          <CardDescription>Step 4 · sales, last 90 days</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            None of the approved changes was a price change, so there is nobody to notify. New products have no
            purchase history, and a deactivated product is not a price change.
          </p>
        </CardContent>
      </Card>
    );
  }

  const sharedAddress = dealers.filter((d) => d.email !== null).length > recipients.length;
  const left = leftOutLines(leftOut);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Affected dealers</CardTitle>
        <CardDescription>Step 4 · {affectedHeadline(affected, dealerCount)}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* With no draft step to follow (nobody has an address), the note about addresses goes here instead. */}
        {recipients.length === 0 ? <AddressNote summary={addresses} connected={connected} /> : null}

        {dealers.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No dealer bought a repriced model in that window, so there is nobody to notify.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Dealer</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Repriced models bought</TableHead>
                <TableHead data-numeric>Units</TableHead>
                <TableHead>Last order</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {dealers.map((dealer) => (
                <TableRow key={dealer.dealer}>
                  <TableCell className="font-medium">
                    <span className="flex items-center gap-1.5">
                      {dealer.email ? (
                        <Check className="size-3.5 text-[var(--status-ok)]" aria-label="Will be in Bcc" />
                      ) : (
                        <Badge variant="outline" className="font-normal">
                          no address
                        </Badge>
                      )}
                      {dealer.dealer}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{dealer.state}</TableCell>
                  <TableCell>{dealer.models.map((m) => `${m.model} (${formatNumber(m.units)})`).join(", ")}</TableCell>
                  <TableCell data-numeric>{formatNumber(dealer.units)}</TableCell>
                  <TableCell>{formatDate(dealer.lastOrder)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        <ul className="space-y-0.5 text-xs text-muted-foreground">
          <li>
            ✓ marks a dealer who will be in the Bcc: {formatNumber(recipients.length)}{" "}
            {recipients.length === 1 ? "address" : "addresses"}
            {sharedAddress ? " (some dealers share one, so it appears once)" : ""}.
          </li>
          {skipped.map((s) => (
            <li key={s.dealer}>
              Skipped {s.dealer}: {s.reason}
            </li>
          ))}
          {left.length > 0 ? <li>Not covered: {left.join(", ")}.</li> : null}
        </ul>
      </CardContent>
    </Card>
  );
}
