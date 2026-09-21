import { addDays } from "@/lib/analytics";
import { formatDate } from "@/lib/format";

import { type PeriodInput, type ResolvedPeriod, ToolArgumentError } from "./types";

/**
 * Turns the model's period ("last month", "last 90 days") into explicit dates.
 * The model never does date arithmetic: it names the kind of period and code
 * works out the days against `today`, which is the latest invoice date, not
 * the clock. Pure.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A period may start this many days before the first invoice without being called incomplete. */
export const DATA_START_GRACE_DAYS = 7;

/** How many days `date` falls before `reference`; negative when after. */
export function daysBefore(date: string, reference: string): number {
  return Math.round((Date.parse(`${reference}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86_400_000);
}

function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function firstOfMonth(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}-01`;
}

function lastOfMonth(year: number, month: number): string {
  // Day 0 of the next month is the last day of this one.
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

function spanDays(from: string, to: string): number {
  if (to < from) return 0;
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.round(ms / 86_400_000) + 1;
}

/**
 * @param today     latest invoice date
 * @param dataStart earliest invoice date
 */
export function resolvePeriod(
  input: PeriodInput | undefined,
  today: string,
  dataStart: string,
): ResolvedPeriod {
  const period = input ?? { kind: "all" };
  const [todayYear, todayMonth] = today.split("-").map(Number);

  let from: string;
  let to: string;

  switch (period.kind) {
    case "all":
      from = dataStart;
      to = today;
      break;

    case "last_month": {
      const year = todayMonth === 1 ? todayYear - 1 : todayYear;
      const month = todayMonth === 1 ? 12 : todayMonth - 1;
      from = firstOfMonth(year, month);
      to = lastOfMonth(year, month);
      break;
    }

    case "this_month":
      from = firstOfMonth(todayYear, todayMonth);
      to = lastOfMonth(todayYear, todayMonth);
      break;

    case "last_days": {
      const days = period.days;
      if (days === undefined || !Number.isInteger(days) || days < 1 || days > 365) {
        throw new ToolArgumentError('period.days must be a whole number from 1 to 365 when kind is "last_days".');
      }
      // Same rule as Feature 3 and the analytics tests: daysBetween(today, date) <= days.
      from = addDays(today, -days);
      to = today;
      break;
    }

    case "month": {
      const month = period.month;
      if (month === undefined || !Number.isInteger(month) || month < 1 || month > 12) {
        throw new ToolArgumentError('period.month must be 1 to 12 when kind is "month".');
      }
      let year = period.year;
      if (year === undefined) {
        // The most recent such month that has started.
        year = month > todayMonth ? todayYear - 1 : todayYear;
      } else if (!Number.isInteger(year) || year < 2000 || year > 2100) {
        throw new ToolArgumentError("period.year must be a four-digit year.");
      }
      from = firstOfMonth(year, month);
      to = lastOfMonth(year, month);
      break;
    }

    case "between": {
      if (!period.from || !period.to || !isIsoDate(period.from) || !isIsoDate(period.to)) {
        throw new ToolArgumentError('period.from and period.to must be dates as YYYY-MM-DD when kind is "between".');
      }
      if (period.from > period.to) {
        throw new ToolArgumentError("period.from must not be after period.to.");
      }
      from = period.from;
      to = period.to;
      break;
    }

    default:
      throw new ToolArgumentError(`Unknown period kind "${String((period as { kind: unknown }).kind)}".`);
  }

  const caveats: string[] = [];
  if (to < dataStart) {
    caveats.push(`This period ends before the first sale (${formatDate(dataStart)}), so it has no data.`);
  } else if (from > today) {
    caveats.push(
      `This period starts after the last sale (${formatDate(today)}), so it has no data.`,
    );
  } else if (to > today) {
    caveats.push(
      `The period is not over in the data, which ends on ${formatDate(today)}. Figures run to that date only.`,
    );
    to = today;
  }
  // The first invoice is not necessarily the first day of the data (1 Jul had no
  // invoice; the data starts 2 Jul), so a short gap is not worth a caveat.
  const reachesBeforeData = daysBefore(from, dataStart) > DATA_START_GRACE_DAYS;
  if (reachesBeforeData && period.kind !== "all" && to >= dataStart) {
    caveats.push(`Sales data starts on ${formatDate(dataStart)}, so nothing earlier exists to count.`);
  }

  // Days that actually have data coverage, for fair per-day comparisons.
  const coveredFrom = reachesBeforeData ? dataStart : from;
  const days = from > today || to < dataStart ? 0 : spanDays(coveredFrom, to);

  return {
    from,
    to,
    label: from > to ? `${formatDate(from)} onwards` : `${formatDate(from)} – ${formatDate(to)}`,
    days,
    caveats,
  };
}

export function inPeriod(date: string, period: ResolvedPeriod): boolean {
  return date >= period.from && date <= period.to;
}
