import { describe, expect, it } from "vitest";
import {
  AiKitError,
  LLMApiError,
  RateLimitError,
  ContextLengthExceededError,
  ToolExecutionError,
  MaxTurnsExceededError,
} from "../src/errors.js";

describe("AiKitError", () => {
  it("should create with message", () => {
    const err = new AiKitError("something went wrong");
    expect(err.message).toBe("something went wrong");
    expect(err.name).toBe("AiKitError");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AiKitError);
  });

  it("should propagate cause", () => {
    const cause = new Error("root cause");
    const err = new AiKitError("wrapped", { cause });
    expect(err.cause).toBe(cause);
  });
});

describe("LLMApiError", () => {
  it("should store provider and statusCode", () => {
    const err = new LLMApiError("api failed", {
      provider: "openai",
      statusCode: 500,
    });
    expect(err.message).toBe("api failed");
    expect(err.name).toBe("LLMApiError");
    expect(err.provider).toBe("openai");
    expect(err.statusCode).toBe(500);
    expect(err).toBeInstanceOf(AiKitError);
    expect(err).toBeInstanceOf(LLMApiError);
  });

  it("should work without statusCode", () => {
    const err = new LLMApiError("network error", { provider: "anthropic" });
    expect(err.statusCode).toBeUndefined();
    expect(err.provider).toBe("anthropic");
  });

  it("should propagate cause", () => {
    const cause = new Error("timeout");
    const err = new LLMApiError("request failed", {
      provider: "google",
      cause,
    });
    expect(err.cause).toBe(cause);
  });
});

describe("RateLimitError", () => {
  it("should store retryAfterMs", () => {
    const err = new RateLimitError("rate limited", {
      provider: "openai",
      statusCode: 429,
      retryAfterMs: 5000,
    });
    expect(err.message).toBe("rate limited");
    expect(err.name).toBe("RateLimitError");
    expect(err.retryAfterMs).toBe(5000);
    expect(err.statusCode).toBe(429);
    expect(err.provider).toBe("openai");
    expect(err).toBeInstanceOf(AiKitError);
    expect(err).toBeInstanceOf(LLMApiError);
    expect(err).toBeInstanceOf(RateLimitError);
  });

  it("should work without retryAfterMs", () => {
    const err = new RateLimitError("too many requests", {
      provider: "anthropic",
    });
    expect(err.retryAfterMs).toBeUndefined();
  });
});

describe("ContextLengthExceededError", () => {
  it("should be instanceof LLMApiError", () => {
    const err = new ContextLengthExceededError("context too long", {
      provider: "openai",
      statusCode: 400,
    });
    expect(err.message).toBe("context too long");
    expect(err.name).toBe("ContextLengthExceededError");
    expect(err.provider).toBe("openai");
    expect(err).toBeInstanceOf(AiKitError);
    expect(err).toBeInstanceOf(LLMApiError);
    expect(err).toBeInstanceOf(ContextLengthExceededError);
  });
});

describe("ToolExecutionError", () => {
  it("should store toolName", () => {
    const cause = new Error("file not found");
    const err = new ToolExecutionError("tool failed", {
      toolName: "readFile",
      cause,
    });
    expect(err.message).toBe("tool failed");
    expect(err.name).toBe("ToolExecutionError");
    expect(err.toolName).toBe("readFile");
    expect(err.cause).toBe(cause);
    expect(err).toBeInstanceOf(AiKitError);
    expect(err).toBeInstanceOf(ToolExecutionError);
  });

  it("should not be instanceof LLMApiError", () => {
    const err = new ToolExecutionError("failed", { toolName: "search" });
    expect(err).not.toBeInstanceOf(LLMApiError);
  });
});

describe("MaxTurnsExceededError", () => {
  it("should store maxTurns and completedTurns", () => {
    const err = new MaxTurnsExceededError("exceeded", {
      maxTurns: 10,
      completedTurns: 10,
    });
    expect(err.message).toBe("exceeded");
    expect(err.name).toBe("MaxTurnsExceededError");
    expect(err.maxTurns).toBe(10);
    expect(err.completedTurns).toBe(10);
    expect(err).toBeInstanceOf(AiKitError);
    expect(err).toBeInstanceOf(MaxTurnsExceededError);
  });

  it("should not be instanceof LLMApiError", () => {
    const err = new MaxTurnsExceededError("exceeded", {
      maxTurns: 5,
      completedTurns: 5,
    });
    expect(err).not.toBeInstanceOf(LLMApiError);
  });
});
