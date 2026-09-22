"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, Download } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { columnLetter, displayCell, type PreviewSheet } from "@/lib/file-preview";
import { formatNumber, formatSize } from "@/lib/format";
import type { FilePreview } from "@/lib/file-view";

const LABEL = "text-[11px] font-medium tracking-wide text-muted-foreground uppercase";

function plural(count: number, one: string, many = `${one}s`): string {
  return `${formatNumber(count)} ${count === 1 ? one : many}`;
}

/**
 * Workflow step 1, the file as received (context/ui-design.md §2.4a). The
 * cells exactly as Feature 1 saved them, collapsed until asked for so the
 * review below stays in view. Read-only; "Download original" returns the
 * untouched bytes.
 */
export function ReceivedFileCard({
  fileId,
  filename,
  preview,
}: {
  fileId: string;
  filename: string;
  preview: FilePreview;
}) {
  const [open, setOpen] = useState(false);
  const isCsv = filename.toLowerCase().endsWith(".csv");
  const missing = !preview.ok && preview.problem === "missing";

  return (
    <Card>
      <CardHeader>
        <CardTitle>The file as received</CardTitle>
        <CardDescription>Step 1 · Gmail · saved unchanged in mock-data/new-price-lists/</CardDescription>
        <CardAction className="flex gap-2">
          {missing ? (
            <Button variant="outline" size="sm" disabled>
              <Download />
              Download original
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              nativeButton={false}
              render={<a href={`/api/prices/${fileId}/file`} download={filename} />}
            >
              <Download />
              Download original
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            aria-expanded={open}
            disabled={!preview.ok}
            onClick={() => setOpen((current) => !current)}
          >
            {open ? <ChevronUp /> : <ChevronDown />}
            {open ? "Hide file" : "Show file"}
          </Button>
        </CardAction>
      </CardHeader>

      <CardContent className="space-y-3">
        {preview.ok ? (
          <>
            <p className="text-xs text-muted-foreground">{summary(preview, isCsv)}</p>
            {open ? <SheetsView sheets={preview.sheets} /> : null}
          </>
        ) : (
          <Alert variant={missing ? "destructive" : "default"}>
            <AlertTitle>{missing ? "File not found" : "This file cannot be shown"}</AlertTitle>
            <AlertDescription>
              {preview.reason}
              {missing ? null : " Download the original to open it in a spreadsheet app."}
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}

function summary(preview: Extract<FilePreview, { ok: true }>, isCsv: boolean): string {
  const [first] = preview.sheets;
  const size = formatSize(preview.bytes);
  if (isCsv || preview.sheets.length === 0) {
    return `CSV · ${plural(first?.totalRows ?? 0, "row")} · ${plural(first?.columnCount ?? 0, "column")} · ${size}`;
  }
  if (preview.sheets.length === 1) {
    return `Excel workbook · sheet “${first.name}” · ${plural(first.totalRows, "row")} · ${plural(first.columnCount, "column")} · ${size}`;
  }
  return `Excel workbook · ${plural(preview.sheets.length, "sheet")} with content · ${size}`;
}

function SheetsView({ sheets }: { sheets: PreviewSheet[] }) {
  if (sheets.length === 1) return <SheetTable sheet={sheets[0]} />;

  const used = sheets.findIndex((sheet) => sheet.used);
  return (
    <Tabs defaultValue={String(used >= 0 ? used : 0)}>
      <TabsList>
        {sheets.map((sheet, index) => (
          <TabsTrigger key={index} value={String(index)}>
            {sheet.name}
            {sheet.used ? " · used for analysis" : ""}
          </TabsTrigger>
        ))}
      </TabsList>
      {sheets.map((sheet, index) => (
        <TabsContent key={index} value={String(index)} className="space-y-3 pt-2">
          <p className="text-xs text-muted-foreground">
            {plural(sheet.totalRows, "row")} · {plural(sheet.columnCount, "column")}
          </p>
          <SheetTable sheet={sheet} />
        </TabsContent>
      ))}
    </Tabs>
  );
}

function SheetTable({ sheet }: { sheet: PreviewSheet }) {
  if (sheet.totalRows === 0) {
    return <p className="text-sm text-muted-foreground">This sheet is empty.</p>;
  }

  const issues = new Map(sheet.issues.map((issue) => [issue.rowNumber, issue.reason]));
  const mapped = sheet.columnRoles.some((role) => role !== null);

  return (
    <div className="space-y-2">
      {sheet.headerRow !== null ? (
        <p className="text-xs text-muted-foreground">
          The analysis read this sheet. Row {sheet.headerRow} is the header, and the labels under the letters show
          the columns the LLM mapped{mapped ? "" : " (none of them was found in that row)"}. The app copied each price
          from its cell.
        </p>
      ) : null}

      {/* The table's own container scrolls both ways, so the column letters stay in view. */}
      <div className="rounded-lg border [&>[data-slot=table-container]]:max-h-[480px]">
        <Table className="text-[13px]">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="sticky top-0 z-10 w-12 bg-card" aria-label="Row" />
              {sheet.columnRoles.map((role, column) => (
                <TableHead
                  key={column}
                  data-numeric={sheet.numericColumns[column] ? true : undefined}
                  className={`sticky top-0 z-10 h-auto bg-card py-2 align-top ${sheet.numericColumns[column] ? "text-right" : ""}`}
                >
                  <span className={LABEL}>{columnLetter(column)}</span>
                  {role ? (
                    <Badge
                      variant="outline"
                      className={`mt-1 block w-fit font-normal ${sheet.numericColumns[column] ? "ml-auto" : ""}`}
                    >
                      {role}
                    </Badge>
                  ) : null}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {sheet.rows.map((row, index) => {
              const rowNumber = index + 1;
              const isHeader = rowNumber === sheet.headerRow;
              const issue = issues.get(rowNumber);
              return (
                <TableRow
                  key={rowNumber}
                  className={isHeader ? "bg-background font-medium hover:bg-background" : undefined}
                >
                  <TableCell className="text-right text-xs text-muted-foreground tabular-nums">
                    {issue ? (
                      <Tooltip>
                        <TooltipTrigger className="mr-1.5 cursor-help underline decoration-dotted underline-offset-2">
                          skipped
                        </TooltipTrigger>
                        <TooltipContent>{issue}</TooltipContent>
                      </Tooltip>
                    ) : null}
                    {rowNumber}
                  </TableCell>
                  {row.map((cell, column) => {
                    const text = displayCell(cell);
                    return (
                      <TableCell
                        key={column}
                        data-numeric={sheet.numericColumns[column] ? true : undefined}
                        className="max-w-[320px] truncate"
                        title={text.length > 40 ? text : undefined}
                      >
                        {text}
                      </TableCell>
                    );
                  })}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {sheet.truncated ? (
        <p className="text-xs text-muted-foreground">
          Showing {formatNumber(sheet.rows.length)} of {formatNumber(sheet.totalRows)} rows · download the original to
          see all
        </p>
      ) : null}
    </div>
  );
}
