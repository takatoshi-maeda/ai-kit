import type { McpUsagePeriodSummary, McpUsageSummary } from "./types.js";

export interface UsageSummaryEntry {
  amount: number;
  currency: string;
  timestamp: string;
}

export function buildUsageSummary(
  entries: UsageSummaryEntry[],
  period?: string,
  now: Date = new Date(),
): McpUsageSummary | null {
  if (entries.length === 0) {
    return null;
  }

  const normalizedEntries = entries.map((entry) => ({
    amount: Number(entry.amount),
    currency: entry.currency,
    timestamp: normalizeTimestamp(entry.timestamp),
  }));

  const periods = buildRelativePeriods(normalizedEntries, now);
  const selected = period
    ? summarizePeriod(
        normalizedEntries.filter((entry) => entry.timestamp.startsWith(period)),
        period,
      )
    : periods.cumulative;

  return {
    period: selected.period,
    cost: selected.cost,
    periods,
  };
}

function buildRelativePeriods(
  entries: UsageSummaryEntry[],
  now: Date,
): Record<"cumulative" | "monthly" | "weekly" | "daily", McpUsagePeriodSummary> {
  const utcNow = new Date(now.toISOString());
  const dayStart = new Date(Date.UTC(
    utcNow.getUTCFullYear(),
    utcNow.getUTCMonth(),
    utcNow.getUTCDate(),
    0,
    0,
    0,
    0,
  ));
  const monthStart = new Date(Date.UTC(
    utcNow.getUTCFullYear(),
    utcNow.getUTCMonth(),
    1,
    0,
    0,
    0,
    0,
  ));
  const weekStart = startOfIsoWeek(utcNow);

  return {
    cumulative: summarizePeriod(entries, "all"),
    monthly: summarizePeriod(
      entries.filter((entry) => entry.timestamp >= monthStart.toISOString()),
      formatMonth(utcNow),
    ),
    weekly: summarizePeriod(
      entries.filter((entry) => entry.timestamp >= weekStart.toISOString()),
      formatIsoWeek(utcNow),
    ),
    daily: summarizePeriod(
      entries.filter((entry) => entry.timestamp >= dayStart.toISOString()),
      formatDay(utcNow),
    ),
  };
}

function summarizePeriod(
  entries: UsageSummaryEntry[],
  period: string,
): McpUsagePeriodSummary {
  const totalByCurrency: Record<string, number> = {};
  let totalUsd = 0;

  for (const entry of entries) {
    totalByCurrency[entry.currency] =
      (totalByCurrency[entry.currency] ?? 0) + entry.amount;
    if (entry.currency === "usd") {
      totalUsd += entry.amount;
    }
  }

  return {
    period,
    cost: {
      totalUsd,
      totalByCurrency,
    },
  };
}

function startOfIsoWeek(date: Date): Date {
  const day = date.getUTCDay() || 7;
  const start = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    0,
    0,
    0,
    0,
  ));
  start.setUTCDate(start.getUTCDate() - (day - 1));
  return start;
}

function formatDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function formatMonth(date: Date): string {
  return date.toISOString().slice(0, 7);
}

function formatIsoWeek(date: Date): string {
  const target = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    0,
    0,
    0,
    0,
  ));
  const day = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - day);
  const isoYear = target.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const weekNumber = Math.ceil((((target.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${isoYear}-W${String(weekNumber).padStart(2, "0")}`;
}

function normalizeTimestamp(value: string): string {
  return new Date(value).toISOString();
}
