import { z } from "zod";
import type { McpPersistence } from "../persistence.js";

export const UsageSummaryParamsSchema = z.object({
  period: z
    .string()
    .optional()
    .describe("Period filter (e.g. '2025-01' for January 2025). Omit for all-time"),
});

export async function handleUsageSummary(
  persistence: McpPersistence,
  params: z.infer<typeof UsageSummaryParamsSchema>,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  isError: boolean;
}> {
  const summary = await persistence.summarizeUsage(params.period);
  const now = new Date();
  const zeroCost = { totalUsd: 0, totalByCurrency: {} };
  const payload = summary
    ? {
        period: summary.period,
        cost: {
          totalUsd: summary.cost.totalUsd,
          totalByCurrency: summary.cost.totalByCurrency,
        },
        periods: summary.periods,
        tokens: null,
        requests: null,
      }
    : {
        period: params.period ?? "all",
        cost: zeroCost,
        periods: {
          cumulative: {
            period: "all",
            cost: zeroCost,
          },
          monthly: {
            period: now.toISOString().slice(0, 7),
            cost: zeroCost,
          },
          weekly: {
            period: formatIsoWeek(now),
            cost: zeroCost,
          },
          daily: {
            period: now.toISOString().slice(0, 10),
            cost: zeroCost,
          },
        },
        tokens: null,
        requests: null,
      };

  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: false,
  };
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
