import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";

import { AnalyseCard } from "@/app/_components/AnalyseCard";
import { PageHeader } from "@/app/_components/PageHeader";
import { PriceListStatus } from "@/app/_components/PriceListStatus";
import { ReviewPanel } from "@/app/_components/ReviewPanel";
import { WorkflowStepper } from "@/app/_components/WorkflowStepper";
import { Button } from "@/components/ui/button";
import { salesByProduct } from "@/lib/analytics";
import { findOutdatedItems } from "@/lib/compare";
import { LLM_SAMPLE_ROWS } from "@/lib/config";
import { readProducts, readSales } from "@/lib/data/mock-data";
import { formatDate, senderName } from "@/lib/format";
import { findPriceList, readNormalized, readReview } from "@/lib/storage/price-reviews";

export const dynamic = "force-dynamic";

/**
 * The workflow for one downloaded price list: step 2 (Analyse) until it has
 * been analysed, then step 3 (Review & approve). Reads storage directly; the
 * two actions go through /api/prices/[id]/*.
 */
export default async function PriceListWorkflow({ params }: PageProps<"/price-updates/[id]">) {
  const { id } = await params;
  const entry = await findPriceList(id);
  if (!entry) notFound();

  const [review, normalized, products, sales] = await Promise.all([
    readReview(id),
    readNormalized(id),
    readProducts(),
    readSales(),
  ]);

  const analysed = review !== null && review.status !== "failed";
  const approved = review?.status === "approved";
  const outdated =
    review?.status === "needs-review" ? findOutdatedItems(review.items, products) : [];

  return (
    <>
      <PageHeader
        title={entry.savedAs}
        description={`From ${senderName(entry.from)} · received ${formatDate(entry.emailDate)}${
          review?.brand ? ` · ${review.brand}` : ""
        }${normalized?.sheet ? ` · sheet "${normalized.sheet}"` : ""}`}
        actions={
          <PriceListStatus state={review ? review.status : "downloaded"} />
        }
      />

      <div className="flex flex-col gap-3.5 p-7">
        <div>
          <Button
            variant="ghost"
            size="sm"
            className="-ml-2"
            nativeButton={false}
            render={<Link href="/price-updates" />}
          >
            <ChevronLeft />
            Price Updates
          </Button>
        </div>

        <WorkflowStepper current={analysed ? 3 : 2} approved={approved} />

        {analysed ? (
          <ReviewPanel
            review={review}
            issues={normalized?.issues ?? []}
            evidence={salesByProduct(sales)}
            outdated={outdated}
          />
        ) : (
          <AnalyseCard
            fileId={id}
            sampleRows={LLM_SAMPLE_ROWS}
            failure={review?.status === "failed" ? (review.error ?? "Unknown error.") : null}
          />
        )}
      </div>
    </>
  );
}
