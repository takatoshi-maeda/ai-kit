import { z } from "zod";
import { createLLMClient } from "../../llm/index.js";
import type { ToolDefinition } from "../../types/tool.js";
import type { LLMClient } from "../../types/agent.js";

const DEFAULT_GOOGLE_MODEL = "gemini-2.5-flash";
const DEFAULT_ZYTE_API_URL = "https://api.zyte.com/v1/extract";

function resolveUrl(href: string, baseUrl: string): string {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return href;
  }
}

function decodeEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ""));
}

function truncateForPrompt(text: string, maxChars = 80_000): string {
  if (text.length <= maxChars) return text;
  const head = text.slice(0, 50_000).trimEnd();
  const tail = text.slice(-20_000).trimStart();
  return `${head}\n\n...\n\n${tail}`;
}

function extractMainHtml(html: string): string {
  const articleMatch = html.match(/<article\b[^>]*>[\s\S]*?<\/article>/i);
  if (articleMatch?.[0]?.trim()) return articleMatch[0];

  const mainMatch = html.match(/<main\b[^>]*>[\s\S]*?<\/main>/i);
  if (mainMatch?.[0]?.trim()) return mainMatch[0];

  return html;
}

function htmlToMarkdown(html: string, baseUrl: string): string {
  let text = html;

  text = text.replace(/<!--[\s\S]*?-->/g, "");
  text = text.replace(/<(script|style|noscript|svg|canvas)\b[^>]*>[\s\S]*?<\/\1>/gi, "");

  text = text.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, inner: string) => {
    const label = stripTags(inner).replace(/\s+/g, " ").trim();
    if (!label) return "";
    const resolved = resolveUrl(href, baseUrl);
    return `[${label}](${resolved})`;
  });

  text = text.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, inner: string) => {
    const code = stripTags(inner).trim();
    if (!code) return "";
    return `\n\n\`\`\`\n${code}\n\`\`\`\n\n`;
  });

  text = text.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, inner: string) => {
    const code = stripTags(inner).replace(/\s+/g, " ").trim();
    if (!code) return "";
    return `\`${code}\``;
  });

  text = text.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level: string, inner: string) => {
    const heading = stripTags(inner).replace(/\s+/g, " ").trim();
    if (!heading) return "";
    return `\n\n${"#".repeat(Number(level))} ${heading}\n\n`;
  });

  text = text.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, inner: string) => {
    const item = stripTags(inner).replace(/\s+/g, " ").trim();
    if (!item) return "";
    return `\n- ${item}`;
  });

  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/?(p|div|section|article|main|ul|ol|blockquote|tr|table|thead|tbody|footer|header|aside)\b[^>]*>/gi, "\n");

  text = stripTags(text);
  text = text.replace(/[ \t]+\n/g, "\n");
  text = text.replace(/\n{3,}/g, "\n\n");

  return text.trim() + "\n";
}

async function fetchBrowserHtmlViaZyte(url: string, options?: { apiKey?: string; zyteApiUrl?: string }): Promise<string> {
  const apiKey = options?.apiKey ?? process.env.LLM_KIT_ZYTE_API_KEY ?? process.env.ZYTE_API_KEY;
  if (!apiKey) {
    throw new Error("Zyte API key is missing. Set LLM_KIT_ZYTE_API_KEY or ZYTE_API_KEY.");
  }

  const endpoint = options?.zyteApiUrl ?? DEFAULT_ZYTE_API_URL;
  const auth = Buffer.from(`${apiKey}:`, "utf-8").toString("base64");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify({ url, browserHtml: true }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`ZyteAPI request failed (${response.status}): ${body}`);
    }

    const data = (await response.json()) as { browserHtml?: unknown };
    if (typeof data.browserHtml !== "string" || !data.browserHtml.trim()) {
      throw new Error("ZyteAPI returned empty browserHtml.");
    }

    return data.browserHtml;
  } finally {
    clearTimeout(timeout);
  }
}

export function createWebpageSummaryTool(options?: {
  model?: string;
  googleApiKey?: string;
  vertexai?: boolean;
  project?: string;
  location?: string;
  zyteApiUrl?: string;
  zyteApiKey?: string;
}): ToolDefinition {
  let client: LLMClient | null = null;

  function ensureClient(): LLMClient {
    if (client) return client;

    client = createLLMClient({
      provider: "google",
      model: options?.model ?? DEFAULT_GOOGLE_MODEL,
      apiKey: options?.googleApiKey,
      vertexai: options?.vertexai,
      project: options?.project,
      location: options?.location,
    });
    return client;
  }

  return {
    name: "WebpageSummary",
    description:
      "Fetch webpage content via ZyteAPI and summarize it in Japanese strictly based on the extracted content.",
    parameters: z.object({
      url: z.string().url().describe("Webpage URL to summarize"),
      instruction: z.string().optional().describe("Optional additional instruction for summary perspective/granularity"),
    }),
    async execute(params) {
      const llm = ensureClient();

      const rawHtml = await fetchBrowserHtmlViaZyte(params.url, {
        apiKey: options?.zyteApiKey,
        zyteApiUrl: options?.zyteApiUrl,
      });

      const markdown = htmlToMarkdown(extractMainHtml(rawHtml), params.url);

      const instructions = [
        "You are a helpful assistant.",
        "You summarize news webpages based ONLY on the provided Markdown content.",
        "Requirements:",
        "- Output in Japanese.",
        "- Do not fabricate details not present in the Markdown.",
        "- If there are links in the content worth citing, include them.",
      ].join("\n");

      let userText = [
        "出典:",
        `[1] ${params.url}`,
        "",
        "以下はZyteAPI経由で取得したHTMLから変換したMarkdownです。",
        "このMarkdownの内容に基づいて要約してください。",
        "",
        truncateForPrompt(markdown),
      ].join("\n");

      if (params.instruction) {
        userText += `\n\n追加指示:\n${params.instruction}`;
      }

      const result = await llm.invoke({
        instructions,
        messages: [{ role: "user", content: userText }],
      });

      return `${(result.content ?? "").trimEnd()}\n`;
    },
  };
}
