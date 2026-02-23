import { z } from "zod";
import type { ToolDefinition } from "../../types/tool.js";

const DEFAULT_MODEL = "sonar-pro";
const DEFAULT_BASE_URL = "https://api.perplexity.ai";

interface PerplexityResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  citations?: string[];
  search_results?: unknown;
}

export function createGroundingSearchTool(options?: {
  model?: string;
  apiKey?: string;
  baseUrl?: string;
}): ToolDefinition {
  const model = options?.model ?? DEFAULT_MODEL;
  const baseUrl = (options?.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");

  return {
    name: "GroundingSearch",
    description:
      "Use Perplexity (sonar) to collect current facts and sources for a query. Returns a research memo, not a final answer.",
    parameters: z.object({
      query: z.string().describe("Natural-language question to research"),
      focus: z.string().optional().describe("Optional focus area for the research"),
      recencyDays: z.number().int().min(1).optional().describe("Prefer sources from the last N days"),
      maxOutputTokens: z.number().int().min(1).optional().describe("Maximum output tokens"),
    }),
    async execute(params) {
      const apiKey =
        options?.apiKey ??
        process.env.PERPLEXITY_API_KEY ??
        process.env.LLM_KIT_PERPLEXITY_API_KEY;

      if (!apiKey) {
        throw new Error(
          "Perplexity API key is missing. Set PERPLEXITY_API_KEY (or LLM_KIT_PERPLEXITY_API_KEY).",
        );
      }

      const focusText = params.focus ? `\nFocus: ${params.focus}` : "";
      const recencyText = params.recencyDays ? `\nRecency: last ${params.recencyDays} days` : "";

      const instructions = [
        "You are a web research assistant with access to the internet.",
        "Return a concise research memo for the given query.",
        "Requirements:",
        "- Prefer primary/official sources when possible.",
        "- Include URLs for each important claim.",
        "- If uncertain or sources conflict, say so explicitly.",
        "- Output in Japanese.",
      ].join("\n");

      const maxOutputTokens = params.maxOutputTokens ?? 900;

      const body = {
        model,
        max_tokens: maxOutputTokens,
        messages: [
          { role: "system", content: instructions },
          { role: "user", content: `Question: ${params.query}${focusText}${recencyText}` },
        ],
      };

      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Perplexity request failed (${response.status}): ${errText}`);
      }

      const data = (await response.json()) as PerplexityResponse;
      const content = data.choices?.[0]?.message?.content?.trim() ?? "";
      const citations = Array.isArray(data.citations) ? data.citations : [];
      const searchResults = data.search_results;

      if (!citations.length && searchResults === undefined) {
        return content;
      }

      const parts: string[] = [content];
      parts.push("\n\n---\nPerplexity extra:");

      if (citations.length > 0) {
        parts.push("citations:");
        parts.push(...citations.map((citation) => `- ${citation}`));
      }

      if (searchResults !== undefined) {
        parts.push("search_results:");
        parts.push(JSON.stringify(searchResults, null, 2));
      }

      return `${parts.join("\n").trim()}\n`;
    },
  };
}
