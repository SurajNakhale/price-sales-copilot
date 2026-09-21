"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Sparkles } from "lucide-react";

import { PriceListStatus } from "@/app/_components/PriceListStatus";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { ApiError } from "@/lib/types";

async function readError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as ApiError | null;
  return body?.message ?? `Request failed (${response.status}).`;
}

/** POSTs the analysis and returns an error message, or null when it worked. */
export async function requestAnalysis(fileId: string): Promise<string | null> {
  try {
    const response = await fetch(`/api/prices/${fileId}/analyse`, { method: "POST" });
    return response.ok ? null : await readError(response);
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
}

/**
 * Workflow step 2. Analysis is an explicit button, never automatic: it costs
 * an LLM call and sends part of a supplier's file to Gemini, so the card says
 * exactly what leaves the machine (context/ui-design.md §8, decision 3).
 */
export function AnalyseCard({
  fileId,
  sampleRows,
  failure,
}: {
  fileId: string;
  sampleRows: number;
  /** The reason the last analysis failed, when it did. */
  failure: string | null;
}) {
  const router = useRouter();
  const [analysing, setAnalysing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function analyse() {
    setAnalysing(true);
    setError(null);
    const problem = await requestAnalysis(fileId);
    if (problem) {
      setError(problem);
      setAnalysing(false);
      return;
    }
    router.refresh();
  }

  const reason = error ?? failure;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Normalise this price list</CardTitle>
        <CardDescription>Step 2 · the LLM maps the columns, the app copies the prices</CardDescription>
        <CardAction>
          <PriceListStatus state={analysing ? "analysing" : reason ? "failed" : "downloaded"} />
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="max-w-2xl space-y-2 text-sm text-ink-2">
          <p>
            Analysing sends this file&apos;s first {sampleRows} rows, its filename and the
            sender to Gemini, which answers with one thing: which column holds the model,
            category, dealer price and MRP. The app then reads every row itself and copies each
            price from its cell, so the LLM never types a number.
          </p>
          <p>
            Rows whose model is spelled differently from the catalogue go to Gemini a second
            time, with this brand&apos;s product names, to find the same product. Every answer
            is checked by the app, and nothing is written until you approve it.
          </p>
        </div>

        {reason ? (
          <Alert variant="destructive">
            <AlertTitle>Analysis failed</AlertTitle>
            <AlertDescription>{reason}</AlertDescription>
          </Alert>
        ) : null}

        <Button size="lg" onClick={analyse} disabled={analysing}>
          <Sparkles />
          {analysing ? "Analysing…" : reason ? "Retry" : "Analyse"}
        </Button>
      </CardContent>
    </Card>
  );
}
