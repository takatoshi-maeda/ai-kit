import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebpageFetchTool } from "../../../src/agent/tools/webpage-summary.js";

describe("webpage tools", () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.ZYTE_API_KEY;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.ZYTE_API_KEY;
    } else {
      process.env.ZYTE_API_KEY = originalApiKey;
    }
    vi.restoreAllMocks();
  });

  it("webpage_fetch returns extracted markdown without summarization", async () => {
    process.env.ZYTE_API_KEY = "test-key";
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({
        browserHtml: `
          <html>
            <body>
              <main>
                <h1>Example Title</h1>
                <p>Hello <a href="/news">world</a>.</p>
              </main>
            </body>
          </html>
        `,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;

    const tool = createWebpageFetchTool();
    const result = await tool.execute({ url: "https://example.com/article" });

    expect(result).toContain("# Example Title");
    expect(result).toContain("[world](https://example.com/news)");
    expect(result).not.toContain("要約");
  });

  it("webpage_fetch retries once after Zyte abort and then fails", async () => {
    process.env.ZYTE_API_KEY = "test-key";
    globalThis.fetch = vi.fn(async () => {
      throw new DOMException("This operation was aborted", "AbortError");
    }) as typeof fetch;

    const tool = createWebpageFetchTool();

    await expect(tool.execute({ url: "https://example.com/article" })).rejects.toThrow("This operation was aborted");
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });
});
