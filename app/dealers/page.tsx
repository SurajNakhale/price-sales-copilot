import { PageHeader } from "@/app/_components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { lineRevenue } from "@/lib/analytics";
import { readDealers, readSales } from "@/lib/data/mock-data";
import { formatMoney, formatNumber } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function Dealers() {
  const [dealers, sales] = await Promise.all([readDealers(), readSales()]);

  const byDealer = new Map<string, { revenue: number; units: number; invoices: Set<string> }>();
  for (const line of sales) {
    const entry = byDealer.get(line.dealer) ?? {
      revenue: 0,
      units: 0,
      invoices: new Set<string>(),
    };
    entry.revenue += lineRevenue(line);
    entry.units += line.quantity;
    entry.invoices.add(line.invoiceNo);
    byDealer.set(line.dealer, entry);
  }

  const rows = dealers
    .map((dealer) => ({
      ...dealer,
      revenue: byDealer.get(dealer.dealer)?.revenue ?? 0,
      units: byDealer.get(dealer.dealer)?.units ?? 0,
      invoices: byDealer.get(dealer.dealer)?.invoices.size ?? 0,
    }))
    .sort((a, b) => b.revenue - a.revenue);

  return (
    <>
      <PageHeader
        title="Dealers"
        description={`${dealers.length} dealers, ranked by revenue`}
      />

      <div className="p-7">
        <Card>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Dealer</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead data-numeric>Invoices</TableHead>
                  <TableHead data-numeric>Units</TableHead>
                  <TableHead data-numeric>Revenue</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.dealer}>
                    <TableCell className="font-medium">{row.dealer}</TableCell>
                    <TableCell className="text-muted-foreground">{row.state}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {row.email}
                    </TableCell>
                    <TableCell data-numeric>{formatNumber(row.invoices)}</TableCell>
                    <TableCell data-numeric>{formatNumber(row.units)}</TableCell>
                    <TableCell data-numeric>{formatMoney(row.revenue)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
