import { PageHeader } from "@/app/_components/PageHeader";
import { PriceListsCard } from "@/app/_components/PriceListsCard";
import { ScanDialog } from "@/app/_components/ScanDialog";
import { WorkflowStepper } from "@/app/_components/WorkflowStepper";
import { isConnected } from "@/lib/google/oauth";
import { readManifest } from "@/lib/storage/new-price-lists";
import { listReviews } from "@/lib/storage/price-reviews";

export const dynamic = "force-dynamic";

/** Every price list received, with where each one is in the workflow (ui-design.md §2.4). */
export default async function PriceUpdates() {
  const [connected, manifest, reviews] = await Promise.all([
    isConnected(),
    readManifest(),
    listReviews(),
  ]);

  return (
    <>
      <PageHeader
        title="Price Updates"
        description="Gmail → normalise → review → affected dealers → draft email"
        actions={<ScanDialog connected={connected} />}
      />

      <div className="flex flex-col gap-3.5 p-7">
        <WorkflowStepper />
        <PriceListsCard entries={manifest} reviews={reviews} connected={connected} />
      </div>
    </>
  );
}
