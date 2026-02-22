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
  const payload = summary
    ? {
        period: summary.period,
        cost: {
          totalUsd: summary.cost.totalUsd,
          totalByCurrency: summary.cost.totalByCurrency,
        },
        tokens: null,
        requests: null,
      }
    : {
        period: params.period ?? "all",
        cost: { totalUsd: 0, totalByCurrency: {} },
        tokens: null,
        requests: null,
      };

  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: false,
  };
}
