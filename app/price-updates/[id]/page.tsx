import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";

import { AffectedDealers } from "@/app/_components/AffectedDealers";
import { AnalyseCard } from "@/app/_components/AnalyseCard";
import { DraftPanel } from "@/app/_components/DraftPanel";
import { PageHeader } from "@/app/_components/PageHeader";
import { PriceListStatus } from "@/app/_components/PriceListStatus";
import { ReviewPanel } from "@/app/_components/ReviewPanel";
import { WorkflowStepper } from "@/app/_components/WorkflowStepper";
import { Button } from "@/components/ui/button";
import { findAffectedDealers, summariseAddresses } from "@/lib/affected";
import { salesByProduct } from "@/lib/analytics";
import { findOutdatedItems } from "@/lib/compare";
import { LLM_SAMPLE_ROWS } from "@/lib/config";
import { readDealers, readProducts, readSales } from "@/lib/data/mock-data";
import { buildEmail } from "@/lib/drafts/message";
import { formatDate, senderName } from "@/lib/format";
import { connectedAddressOrNull, openInGmailUrl } from "@/lib/gmail/drafts";
import { hasDraftPermission } from "@/lib/google/oauth";
import { readDraftState } from "@/lib/storage/drafts";
import { findPriceList, readNormalized, readReview } from "@/lib/storage/price-reviews";

export const dynamic = "force-dynamic";

/**
 * The workflow for one downloaded price list: step 2 (Analyse) until it has
 * been analysed, then step 3 (Review & approve), and once approved, step 4
 * (Affected dealers) and step 5 (Draft email). Reads storage directly; the
 * actions go through /api/prices/[id]/*.
 */
export default async function PriceListWorkflow({
  params,
  searchParams,
}: PageProps<"/price-updates/[id]">) {
  const { id } = await params;
  const query = await searchParams;
  const entry = await findPriceList(id);
  if (!entry) notFound();

  const [review, normalized, products, sales, dealers] = await Promise.all([
    readReview(id),
    readNormalized(id),
    readProducts(),
    readSales(),
    readDealers(),
  ]);

  const analysed = review !== null && review.status !== "failed";
  const approved = review?.status === "approved";
  const outdated =
    review?.status === "needs-review" ? findOutdatedItems(review.items, products) : [];

  // Steps 4 and 5 (Feature 3): only for an approved review.
  const affected = approved && review ? findAffectedDealers({ review, sales, dealers }) : null;
  const [draftState, connectedAddress, draftPermission] = affected
    ? await Promise.all([readDraftState(id), connectedAddressOrNull(), hasDraftPermission()])
    : [null, null, false];
  const addresses = affected ? summariseAddresses(affected.recipients, connectedAddress) : null;
  const brand = review?.brand ?? affected?.models[0]?.brand ?? null;
  const email =
    affected && draftState?.message && brand ? buildEmail(draftState.message, brand, affected.models) : null;
  const latestDraft = draftState?.drafts.at(-1) ?? null;
  const nothingToNotify = affected !== null && affected.models.length === 0;
  const stepperAt = !analysed ? 2 : !approved ? 3 : nothingToNotify || latestDraft ? 6 : 5;

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

        <WorkflowStepper current={stepperAt} approved={approved} />

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

        {affected && addresses ? (
          <>
            <AffectedDealers
              affected={affected}
              addresses={addresses}
              connected={connectedAddress}
              dealerCount={dealers.length}
            />
            {affected.models.length > 0 ? (
              <DraftPanel
                fileId={id}
                connectedAddress={connectedAddress}
                addresses={addresses}
                dealers={affected.dealers.filter((dealer) => dealer.email !== null).length}
                bccAddresses={affected.recipients.length}
                message={draftState?.message ?? null}
                email={email}
                drafts={draftState?.drafts ?? []}
                openUrl={latestDraft ? openInGmailUrl(latestDraft.to, latestDraft.messageId) : null}
                hasDraftPermission={draftPermission}
                outcome={{
                  drafts: typeof query.drafts === "string" ? query.drafts : undefined,
                  error: typeof query.connect_error === "string" ? query.connect_error : undefined,
                }}
              />
            ) : null}
          </>
        ) : null}
      </div>
    </>
  );
}
