import { describe, it, expect, vi } from "vitest";
import { withRetry } from "../../src/llm/retry.js";
import { RateLimitError, LLMApiError } from "../../src/errors.js";

describe("withRetry", () => {
  it("returns result on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn, { maxRetries: 3 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on RateLimitError and succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(
        new RateLimitError("rate limited", { provider: "openai", statusCode: 429 }),
      )
      .mockResolvedValue("ok");

    const result = await withRetry(fn, { maxRetries: 2, baseDelayMs: 1 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries on 500 status code", async () => {
    const error = new LLMApiError("server error", {
      provider: "openai",
      statusCode: 500,
    });
    const fn = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValue("ok");

    const result = await withRetry(fn, { maxRetries: 2, baseDelayMs: 1 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not retry on non-retryable error", async () => {
    const error = new LLMApiError("bad request", {
      provider: "openai",
      statusCode: 400,
    });
    const fn = vi.fn().mockRejectedValue(error);

    await expect(withRetry(fn, { maxRetries: 3, baseDelayMs: 1 })).rejects.toThrow(
      "bad request",
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("throws after max retries exhausted", async () => {
    const error = new RateLimitError("rate limited", {
      provider: "openai",
      statusCode: 429,
    });
    const fn = vi.fn().mockRejectedValue(error);

    await expect(withRetry(fn, { maxRetries: 2, baseDelayMs: 1 })).rejects.toThrow(
      "rate limited",
    );
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("respects retryAfterMs from RateLimitError", async () => {
    const error = new RateLimitError("rate limited", {
      provider: "openai",
      statusCode: 429,
      retryAfterMs: 10,
    });
    const fn = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValue("ok");

    const start = Date.now();
    await withRetry(fn, { maxRetries: 1, baseDelayMs: 1000 });
    const elapsed = Date.now() - start;

    // With retryAfterMs=10 and jitter (0.5-1.0), delay should be 5-10ms, not 1000ms
    expect(elapsed).toBeLessThan(100);
  });

  it("works with maxRetries 0 (no retries)", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("fail"));
    await expect(withRetry(fn, { maxRetries: 0 })).rejects.toThrow("fail");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
