"use client";

import { useState } from "react";
import { Check, CircleAlert, Copy, Download } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { csvFilename, tableToCsv, tableToTsv } from "@/lib/copilot/export";
import type {
  CopilotAnswer as Answer,
  Clarification,
  CopilotStep,
  ResultTable,
  SentenceSource,
} from "@/lib/copilot/types";
import { CLARIFY_SOURCE_NOTE } from "@/lib/copilot/wording";

/**
 * One answer, in the order ui-design.md §2.7 sets: the steps used, the rows,
 * the sentence, then Copy / Download and the standing line that every number
 * was computed from the files. A vague question gets the clarification block
 * in place of the sentence (spec §10).
 */

const SOURCE_LABEL: Record<SentenceSource, string> = {
  model: "Written by Gemini from the results above; every number in it was checked against them.",
  template: "Written by the app from the results above.",
  refusal: "No query was run.",
  no_tool: "No data was looked up for this.",
  clarify: CLARIFY_SOURCE_NOTE,
};

export function CopilotAnswer({
  answer,
  onAsk,
  disabled = false,
}: {
  answer: Answer;
  /** Asks one of a clarification's example questions. */
  onAsk?: (question: string) => void;
  disabled?: boolean;
}) {
  const tables = answer.steps.filter((step) => step.ok && step.table).map((step) => step.table as ResultTable);
  const last = tables[tables.length - 1];

  return (
    <div className="space-y-3">
      {answer.steps.length > 0 ? <Steps steps={answer.steps} /> : null}

      {tables.map((table, index) => (
        <ResultBlock key={`${index}-${table.title}`} table={table} />
      ))}

      <div className="rounded-lg border bg-card px-4 py-3">
        <p className="text-[15px] leading-relaxed">{answer.sentence}</p>
        {answer.clarification ? (
          <ClarificationOptions clarification={answer.clarification} onAsk={onAsk} disabled={disabled} />
        ) : null}
        <p className="mt-1.5 flex items-start gap-1.5 text-xs text-muted-foreground">
          {answer.guardNote ? <CircleAlert className="mt-px size-3.5 shrink-0" aria-hidden /> : null}
          <span>
            {SOURCE_LABEL[answer.sentenceSource]}
            {answer.guardNote ? ` ${answer.guardNote}` : ""}
          </span>
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {last ? <TableActions table={last} /> : null}
        <span className="ml-auto">
          {tables.length > 0 ? "Every number was computed from your files. " : ""}
          {answer.meta.cached ? (
            <>{answer.meta.model} · cached, no Gemini request</>
          ) : (
            <>
              {answer.meta.model} · {answer.meta.rounds} {answer.meta.rounds === 1 ? "Gemini request" : "Gemini requests"} ·{" "}
              {answer.meta.toolCalls} {answer.meta.toolCalls === 1 ? "query" : "queries"} ·{" "}
              {(answer.meta.ms / 1000).toFixed(1)} s
            </>
          )}
        </span>
      </div>
    </div>
  );
}

/** The readings the model picked; each button asks its example question. */
function ClarificationOptions({
  clarification,
  onAsk,
  disabled,
}: {
  clarification: Clarification;
  onAsk?: (question: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="mt-2 space-y-2 text-sm">
      <p className="text-ink-2">Would you like to see:</p>
      <ul className="space-y-1.5">
        {clarification.options.map((option) => (
          <li key={option.measure} className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Button
              variant="outline"
              size="sm"
              disabled={disabled || !onAsk}
              aria-label={`Ask: ${option.question}`}
              onClick={() => onAsk?.(option.question)}
            >
              {option.label}
            </Button>
            <span className="text-muted-foreground">{option.question}</span>
          </li>
        ))}
      </ul>
      <p className="text-ink-2">
        Or ask it your own way, for example: “{clarification.options[0].question}”
      </p>
    </div>
  );
}

function Steps({ steps }: { steps: CopilotStep[] }) {
  return (
    <details open className="group rounded-lg border bg-muted/40 px-4 py-3">
      <summary className="cursor-pointer text-sm font-medium select-none">
        Steps used to answer ({steps.length})
      </summary>
      <ol className="mt-3 space-y-3">
        {steps.map((step, index) => (
          <li key={index} className="text-sm">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground tabular-nums">{index + 1}.</span>
              <span className="font-medium">{step.title}</span>
              {step.ok ? null : (
                <Badge variant="outline" className="font-normal text-destructive">
                  rejected
                </Badge>
              )}
            </div>
            {step.ok ? (
              <ul className="mt-1 ml-5 list-disc space-y-0.5 text-ink-2 marker:text-muted-foreground">
                {step.lines.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 ml-5 text-ink-2">
                {step.error} The model was told, and could try again.
              </p>
            )}
            <details className="mt-1 ml-5">
              <summary className="cursor-pointer text-xs text-muted-foreground">
                Arguments the model sent
              </summary>
              <pre className="mt-1 overflow-x-auto rounded-md bg-background p-2 font-mono text-xs">
                {JSON.stringify(step.args, null, 2)}
              </pre>
            </details>
          </li>
        ))}
      </ol>
    </details>
  );
}

function ResultBlock({ table }: { table: ResultTable }) {
  return (
    <div className="rounded-lg border bg-card">
      <p className="border-b px-4 py-2.5 text-sm font-medium">{table.title}</p>
      {table.rows.length === 0 ? (
        // An empty result is an answer; column headings with nothing under them only look broken.
        <p className="px-4 py-3 text-sm text-muted-foreground">Nothing matches.</p>
      ) : (
        <div className="overflow-x-auto px-2">
          <Table>
            <TableHeader>
              <TableRow>
                {table.columns.map((column) => (
                  <TableHead key={column.key} data-numeric={column.numeric ? true : undefined}>
                    {column.label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {table.rows.map((row, index) => (
                <TableRow key={index}>
                  {table.columns.map((column) => (
                    <TableCell key={column.key} data-numeric={column.numeric ? true : undefined}>
                      {row[column.key]}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {table.footnotes.length > 0 ? (
        <ul className="space-y-0.5 border-t px-4 py-2 text-xs text-muted-foreground">
          {table.footnotes.map((note, index) => (
            <li key={index}>{note}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function TableActions({ table }: { table: ResultTable }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(tableToTsv(table));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be refused; Download still works.
    }
  }

  function download() {
    const url = URL.createObjectURL(new Blob([tableToCsv(table)], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = csvFilename(table);
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={copy}>
        {copied ? <Check /> : <Copy />}
        {copied ? "Copied" : "Copy table"}
      </Button>
      <Button variant="outline" size="sm" onClick={download}>
        <Download />
        Download CSV
      </Button>
    </>
  );
}
