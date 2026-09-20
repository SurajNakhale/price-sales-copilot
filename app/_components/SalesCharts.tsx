"use client";

import { useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from "recharts";

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
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { type BrandTotal, type Measure, trendSeries, type WeekBucket } from "@/lib/analytics";
import { formatDateShort, formatMoney, formatMoneyShort, formatNumber } from "@/lib/format";
import type { Brand } from "@/lib/types";

/** Fixed per brand everywhere, so a colour always means the same supplier. */
const BRAND_COLOR: Record<Brand, string> = {
  Samsung: "var(--brand-samsung)",
  Seagate: "var(--brand-seagate)",
  "TP-Link": "var(--brand-tplink)",
};

const MEASURE_LABEL: Record<Measure, string> = {
  revenue: "Revenue",
  units: "Units",
};

export function SalesCharts({
  weeks,
  brands,
}: {
  weeks: WeekBucket[];
  brands: BrandTotal[];
}) {
  // One toggle drives both charts: the brand ranking only makes sense read
  // against the same measure as the trend.
  const [measure, setMeasure] = useState<Measure>("revenue");

  return (
    <section className="grid gap-3.5 lg:grid-cols-[minmax(0,1.85fr)_minmax(0,1fr)]">
      <TrendCard weeks={weeks} measure={measure} onMeasureChange={setMeasure} />
      <BrandCard brands={brands} measure={measure} />
    </section>
  );
}

function MeasureToggle({
  measure,
  onChange,
}: {
  measure: Measure;
  onChange: (next: Measure) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Measure"
      className="flex items-center gap-0.5 rounded-lg bg-muted p-0.5"
    >
      {(["revenue", "units"] as const).map((option) => (
        <Button
          key={option}
          size="sm"
          variant={measure === option ? "default" : "ghost"}
          className="h-7 px-2.5 text-xs"
          aria-pressed={measure === option}
          onClick={() => onChange(option)}
        >
          {MEASURE_LABEL[option]}
        </Button>
      ))}
    </div>
  );
}

function TrendCard({
  weeks,
  measure,
  onMeasureChange,
}: {
  weeks: WeekBucket[];
  measure: Measure;
  onMeasureChange: (next: Measure) => void;
}) {
  // The solid/dashed split lives in lib/analytics.ts so it can be tested.
  const data = trendSeries(weeks, measure).map((point) => ({
    ...point,
    label: formatDateShort(point.weekStart),
  }));

  const partialWeeks = weeks.filter((week) => week.partial);
  const config = {
    solid: { label: MEASURE_LABEL[measure], color: "var(--chart-5)" },
    dashed: { label: MEASURE_LABEL[measure], color: "var(--chart-5)" },
  } satisfies ChartConfig;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sales trend — {MEASURE_LABEL[measure].toLowerCase()} by week</CardTitle>
        <CardDescription>
          {weeks.length} weeks
          {partialWeeks.length > 0
            ? `, ${partialWeeks.length} partial and drawn dashed`
            : null}
        </CardDescription>
        <CardAction>
          <MeasureToggle measure={measure} onChange={onMeasureChange} />
        </CardAction>
      </CardHeader>
      <CardContent>
        <ChartContainer config={config} className="aspect-auto h-[260px] w-full">
          <LineChart data={data} margin={{ left: 8, right: 16, top: 8, bottom: 0 }}>
            <CartesianGrid vertical={false} strokeDasharray="3 3" />
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={false}
              tickMargin={10}
              interval="preserveStartEnd"
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              width={56}
              tickFormatter={(value: number) =>
                measure === "revenue" ? formatMoneyShort(value) : formatNumber(value)
              }
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  labelKey="label"
                  formatter={(value) => (
                    <span className="tabular-nums">
                      {measure === "revenue"
                        ? formatMoney(Number(value))
                        : `${formatNumber(Number(value))} units`}
                    </span>
                  )}
                />
              }
            />
            <Line
              dataKey="dashed"
              type="monotone"
              stroke="var(--color-dashed)"
              strokeWidth={2}
              strokeDasharray="5 4"
              connectNulls={false}
              dot={<PartialDot />}
              activeDot={{ r: 4 }}
              isAnimationActive={false}
            />
            <Line
              dataKey="solid"
              type="monotone"
              stroke="var(--color-solid)"
              strokeWidth={2}
              connectNulls={false}
              dot={false}
              activeDot={{ r: 4 }}
              isAnimationActive={false}
            />
          </LineChart>
        </ChartContainer>
        {partialWeeks.length > 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            {partialWeeks
              .map(
                (week) =>
                  `Week of ${formatDateShort(week.weekStart)} is partial`,
              )
              .join(" · ")}
            . Sales run {formatDateShort(weeks[0].weekStart)} to{" "}
            {formatDateShort(weeks[weeks.length - 1].weekEnd)} only in part at
            either end.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** A hollow marker on the weeks that do not cover a full seven days. */
function PartialDot(props: {
  cx?: number;
  cy?: number;
  payload?: { partial?: boolean };
}) {
  const { cx, cy, payload } = props;
  if (cx === undefined || cy === undefined || !payload?.partial) return <g />;
  return (
    <circle
      cx={cx}
      cy={cy}
      r={4}
      fill="var(--card)"
      stroke="var(--chart-5)"
      strokeWidth={2}
    />
  );
}

function BrandCard({ brands, measure }: { brands: BrandTotal[]; measure: Measure }) {
  const ranked = [...brands].sort((a, b) => b[measure] - a[measure]);
  const data = ranked.map((total) => ({
    brand: total.brand,
    value: total[measure],
    fill: BRAND_COLOR[total.brand],
    label:
      measure === "revenue" ? formatMoneyShort(total.revenue) : formatNumber(total.units),
  }));

  const config = Object.fromEntries(
    ranked.map((total) => [total.brand, { label: total.brand, color: BRAND_COLOR[total.brand] }]),
  ) satisfies ChartConfig;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sales by brand — {MEASURE_LABEL[measure].toLowerCase()}</CardTitle>
        <CardDescription>
          {measure === "revenue"
            ? "Ranked by revenue; by units the order differs"
            : "Ranked by units; by revenue the order differs"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ChartContainer config={config} className="aspect-auto h-[260px] w-full">
          <BarChart
            data={data}
            layout="vertical"
            margin={{ left: 0, right: 56, top: 8, bottom: 8 }}
          >
            <CartesianGrid horizontal={false} strokeDasharray="3 3" />
            <YAxis
              dataKey="brand"
              type="category"
              tickLine={false}
              axisLine={false}
              width={74}
            />
            <XAxis type="number" hide />
            <Bar dataKey="value" radius={4} barSize={22}>
              {data.map((entry) => (
                <Cell key={entry.brand} fill={entry.fill} />
              ))}
              {/* Labelled directly because the green sits just under 3:1 on white. */}
              <LabelList
                dataKey="label"
                position="right"
                offset={8}
                className="fill-foreground tabular-nums"
                fontSize={12}
              />
            </Bar>
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}
