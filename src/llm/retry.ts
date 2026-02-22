import { RateLimitError } from "../errors.js";

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 60_000;

function jitter(delayMs: number): number {
  return delayMs * (0.5 + Math.random() * 0.5);
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const { maxRetries, baseDelayMs = DEFAULT_BASE_DELAY_MS, maxDelayMs = DEFAULT_MAX_DELAY_MS } = options;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      if (attempt >= maxRetries || !isRetryable(error)) {
        throw error;
      }

      let delayMs: number;
      if (error instanceof RateLimitError && error.retryAfterMs) {
        delayMs = error.retryAfterMs;
      } else {
        delayMs = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      }

      await sleep(jitter(delayMs));
    }
  }

  throw lastError;
}

function isRetryable(error: unknown): boolean {
  if (error instanceof RateLimitError) return true;
  if (error instanceof Error) {
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode !== undefined) {
      return statusCode === 429 || statusCode >= 500;
    }
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
