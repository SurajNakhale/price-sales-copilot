import { CopilotChat } from "@/app/_components/CopilotChat";
import { PageHeader } from "@/app/_components/PageHeader";
import { latestInvoiceDate } from "@/lib/analytics";
import { readSales } from "@/lib/data/mock-data";
import { formatDate } from "@/lib/format";

export const dynamic = "force-dynamic";

/** Questions the three tools answer, one of each kind (context/features/feature-4-sales-copilot.md §5). */
const SUGGESTIONS = [
  "Which models sold the most last month?",
  "How much did we sell to ABC Computers in the last 90 days?",
  "Which dealer bought the most Samsung products?",
  "Which dealers have not bought Samsung?",
  "Compare August with July by brand",
  "What is the dealer price of T7 1TB?",
];

export default async function Copilot() {
  const today = latestInvoiceDate(await readSales());

  return (
    <>
      <PageHeader
        title="Sales Copilot"
        description={
          today
            ? `Plain-English questions about sales, products and dealers · data to ${formatDate(today)}`
            : "Plain-English questions about sales, products and dealers"
        }
      />
      <CopilotChat suggestions={SUGGESTIONS} configured={Boolean(process.env.GEMINI_API_KEY)} />
    </>
  );
}
