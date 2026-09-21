import Link from "next/link";

import { PageHeader } from "@/app/_components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { lineRevenue, totalRevenue, totalUnits } from "@/lib/analytics";
import { readSales } from "@/lib/data/mock-data";
import { formatDate, formatMoney, formatNumber } from "@/lib/format";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

export default async function Sales({ searchParams }: PageProps<"/sales">) {
  const [sales, params] = await Promise.all([readSales(), searchParams]);

  const sorted = [...sales].sort(
    (a, b) => b.date.localeCompare(a.date) || a.invoiceNo.localeCompare(b.invoiceNo),
  );
  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const requested = Number.parseInt(
    typeof params.page === "string" ? params.page : "1",
    10,
  );
  const page = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), pageCount) : 1;
  const rows = sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <>
      <PageHeader
        title="Sales"
        description={`${formatNumber(sales.length)} invoice lines · ${formatNumber(
          totalUnits(sales),
        )} units · ${formatMoney(totalRevenue(sales))}`}
      />

      <div className="p-7">
        <Card>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Invoice</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Dealer</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Product ID</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead data-numeric>Qty</TableHead>
                  <TableHead data-numeric>Unit price</TableHead>
                  <TableHead data-numeric>Line total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((line) => (
                  <TableRow key={`${line.invoiceNo}:${line.productId}`}>
                    <TableCell className="font-mono text-xs">{line.invoiceNo}</TableCell>
                    <TableCell>{formatDate(line.date)}</TableCell>
                    <TableCell className="font-medium">{line.dealer}</TableCell>
                    <TableCell className="text-muted-foreground">{line.state}</TableCell>
                    <TableCell className="font-mono text-xs">{line.productId}</TableCell>
                    <TableCell>{line.model}</TableCell>
                    <TableCell data-numeric>{formatNumber(line.quantity)}</TableCell>
                    <TableCell data-numeric>{formatMoney(line.unitPrice)}</TableCell>
                    <TableCell data-numeric>{formatMoney(lineRevenue(line))}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
          <CardFooter className="justify-between">
            <span className="text-xs text-muted-foreground tabular-nums">
              Page {page} of {pageCount}
            </span>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={page <= 1}
                nativeButton={false}
                render={<Link href={`/sales?page=${page - 1}`} />}
              >
                Previous
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={page >= pageCount}
                nativeButton={false}
                render={<Link href={`/sales?page=${page + 1}`} />}
              >
                Next
              </Button>
            </div>
          </CardFooter>
        </Card>
      </div>
    </>
  );
}
