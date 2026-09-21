import { Check, Lock } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";

/**
 * The five steps one price list moves through (context/ui-design.md §1,
 * Workflow 1). Each names who acts, so it is never unclear whether the app or
 * the model did something. Steps 3 and 5 belong to a person. Steps 4–5 unlock
 * only after an approval.
 *
 * Without `current` it is the legend on the Price Updates list.
 */

const STEPS = [
  { title: "Received", who: "Gmail" },
  { title: "Normalise", who: "LLM maps · app copies" },
  { title: "Review & approve", who: "You decide", person: true },
  { title: "Affected dealers", who: "Sales, last 90 days" },
  { title: "Draft email", who: "LLM + Gmail draft", person: true },
] as const;

type StepState = "legend" | "done" | "current" | "ahead" | "locked";

export function WorkflowStepper({
  current,
  approved = false,
}: {
  /** 1-based; 6 means every step is done. Omit for the legend. */
  current?: number;
  approved?: boolean;
}) {
  const stateOf = (step: number): StepState => {
    if (current === undefined) return "legend";
    if (step >= 4 && !approved) return "locked";
    // `current` past the last step (6) means every step is done.
    if (step < current) return "done";
    if (step === current) return "current";
    return "ahead";
  };

  return (
    <Card size="sm">
      <CardContent>
        <ol className="grid gap-3 sm:grid-cols-5">
          {STEPS.map((step, index) => {
            const number = index + 1;
            const state = stateOf(number);
            return (
              <li key={step.title} className="flex min-w-0 items-start gap-2.5">
                <StepMarker number={number} state={state} />
                <div className="min-w-0">
                  <p
                    className={
                      state === "ahead" || state === "locked"
                        ? "truncate text-[13px] font-medium text-muted-foreground"
                        : "truncate text-[13px] font-medium"
                    }
                  >
                    {step.title}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {state === "locked" ? "After approval" : step.who}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      </CardContent>
    </Card>
  );
}

function StepMarker({ number, state }: { number: number; state: StepState }) {
  const base =
    "flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium tabular-nums";

  if (state === "done") {
    return (
      <span className={`${base} border-primary bg-primary text-primary-foreground`}>
        <Check className="size-3.5" aria-label="Done" />
      </span>
    );
  }
  if (state === "current") {
    return (
      <span className={`${base} border-primary text-foreground ring-2 ring-primary/15`} aria-current="step">
        {number}
      </span>
    );
  }
  if (state === "locked") {
    return (
      <span className={`${base} border-dashed text-muted-foreground`}>
        <Lock className="size-3" aria-label="Locked" />
      </span>
    );
  }
  return <span className={`${base} text-muted-foreground`}>{number}</span>;
}
