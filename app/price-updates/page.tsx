import { NotBuiltYet } from "@/app/_components/NotBuiltYet";
import { PageHeader } from "@/app/_components/PageHeader";
import { PriceListsCard } from "@/app/_components/PriceListsCard";
import { ScanDialog } from "@/app/_components/ScanDialog";
import { isConnected } from "@/lib/google/oauth";
import { readManifest } from "@/lib/storage/new-price-lists";

export const dynamic = "force-dynamic";

export default async function PriceUpdates() {
  const [connected, manifest] = await Promise.all([isConnected(), readManifest()]);

  return (
    <>
      <PageHeader
        title="Price Updates"
        description="Gmail → normalise → review → affected dealers → draft email"
        actions={<ScanDialog connected={connected} />}
      />

      <div className="flex flex-col gap-3.5 p-7">
        <PriceListsCard entries={manifest} connected={connected} />

        <NotBuiltYet feature="Features 2 and 3" title="Reviewing and approving a price list">
          <p>
            Downloading a file is as far as this goes today. Opening one to see
            its price changes, new products and missing products needs Feature 2,
            and drafting the dealer email needs Feature 3.
          </p>
        </NotBuiltYet>
      </div>
    </>
  );
}
