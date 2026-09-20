import { NotBuiltYet } from "@/app/_components/NotBuiltYet";
import { PageHeader } from "@/app/_components/PageHeader";

export const dynamic = "force-dynamic";

export default function Copilot() {
  return (
    <>
      <PageHeader
        title="Sales Copilot"
        description="Plain-English questions about sales, products and dealers"
      />

      <div className="flex flex-col gap-3.5 p-7">
        <NotBuiltYet
          feature="Feature 4"
          title="Ask a question about the sales data"
          steps={[
            "You type a question in plain English.",
            "The LLM turns it into a short plan of steps over the mock data — it never writes the answer's numbers.",
            "The app runs those steps and shows them, so every figure can be checked.",
            "The result table comes first, then a one-line answer.",
          ]}
        >
          <p>
            The data it will answer from is already here and browsable under
            Products, Dealers and Sales in the sidebar.
          </p>
        </NotBuiltYet>
      </div>
    </>
  );
}
