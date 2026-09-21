import Link from "next/link";
import { Sparkles } from "lucide-react";

import { KpiCards, buildKpis } from "@/app/_components/KpiCards";
import { PageHeader } from "@/app/_components/PageHeader";
import { PriceListsCard } from "@/app/_components/PriceListsCard";
import { SalesCharts } from "@/app/_components/SalesCharts";
import { ScanDialog } from "@/app/_components/ScanDialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  brandTotals,
  earliestInvoiceDate,
  invoiceCount,
  latestInvoiceDate,
  totalRevenue,
  totalUnits,
  weeklyBuckets,
} from "@/lib/analytics";
import { summarizeReviews } from "@/lib/compare";
import { readProducts, readSales } from "@/lib/data/mock-data";
import { isConnected } from "@/lib/google/oauth";
import { readManifest } from "@/lib/storage/new-price-lists";
import { listReviews } from "@/lib/storage/price-reviews";

// Connection state, the manifest and the datasets are read from disk on every
// request.
export const dynamic = "force-dynamic";

export default async function Dashboard({ searchParams }: PageProps<"/">) {
  const [connected, manifest, reviews, products, sales, params] = await Promise.all([
    isConnected(),
    readManifest(),
    listReviews(),
    readProducts(),
    readSales(),
    searchParams,
  ]);

  const connectError =
    typeof params.connect_error === "string" ? params.connect_error : undefined;

  const kpis = buildKpis({
    revenue: totalRevenue(sales),
    units: totalUnits(sales),
    invoices: invoiceCount(sales),
    productsSold: new Set(sales.map((line) => line.productId)).size,
    productsTotal: products.length,
    from: earliestInvoiceDate(sales),
    to: latestInvoiceDate(sales),
    reviews: summarizeReviews(reviews),
  });

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Supplier pricing and sales intelligence"
        actions={<ScanDialog connected={connected} />}
      />

      <div className="flex flex-col gap-3.5 p-7">
        {connectError ? (
          <Alert variant="destructive">
            <AlertTitle>Gmail could not be connected</AlertTitle>
            <AlertDescription>{connectError}</AlertDescription>
          </Alert>
        ) : null}

        <KpiCards items={kpis} />

        <SalesCharts
          weeks={weeklyBuckets(sales)}
          brands={brandTotals(sales, products)}
        />

        <PriceListsCard entries={manifest} reviews={reviews} connected={connected} limit={5} />
      </div>

      <Button
        size="lg"
        className="fixed right-6 bottom-6 h-11 gap-2 rounded-full px-4 shadow-lg"
        nativeButton={false}
        render={<Link href="/copilot" />}
      >
        <Sparkles />
        Sales Copilot
      </Button>
    </>
  );
}
