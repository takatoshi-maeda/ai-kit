import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LLMUsage } from "../../src/types/llm.js";

// Reset module state between tests by re-importing
async function loadModule() {
  // Force fresh module to reset module-level state
  const mod = await import("../../src/tracing/langfuse.js");
  return mod;
}

function makeUsage(overrides?: Partial<LLMUsage>): LLMUsage {
  return {
    inputTokens: 100,
    outputTokens: 50,
    cachedInputTokens: 0,
    totalTokens: 150,
    inputCost: 0.001,
    outputCost: 0.002,
    cacheCost: 0,
    totalCost: 0.003,
    ...overrides,
  };
}

describe("langfuse tracing", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("withObservation — no-op when not initialized", () => {
    it("passes a no-op observation and returns fn result", async () => {
      const { withObservation } = await loadModule();

      const result = await withObservation(
        "test-op",
        { type: "span" },
        async (obs) => {
          // Should not throw even though langfuse is not initialized
          obs.update({ output: "hello" });
          obs.end();
          return 42;
        },
      );

      expect(result).toBe(42);
    });

    it("propagates errors from fn", async () => {
      const { withObservation } = await loadModule();

      await expect(
        withObservation("fail-op", {}, async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
    });
  });

  describe("initTracing + withObservation — with mocked langfuse", () => {
    it("creates a span observation and calls end on success", async () => {
      const mockEnd = vi.fn();
      const mockUpdate = vi.fn();
      const mockSpan = vi.fn().mockReturnValue({ update: mockUpdate, end: mockEnd });
      const mockGeneration = vi.fn();
      const mockTrace = vi.fn().mockReturnValue({ span: mockSpan, generation: mockGeneration });
      const MockLangfuse = vi.fn().mockReturnValue({ trace: mockTrace });

      vi.doMock("langfuse", () => ({ Langfuse: MockLangfuse }));

      // Clear module cache to pick up the mock
      vi.resetModules();
      const { initTracing, withObservation } = await import("../../src/tracing/langfuse.js");

      initTracing({ publicKey: "pk-test", secretKey: "sk-test" });

      const result = await withObservation(
        "my-span",
        { type: "span", input: { query: "hello" }, metadata: { foo: "bar" } },
        async (obs) => {
          obs.update({ output: "world" });
          return "done";
        },
      );

      expect(result).toBe("done");
      expect(MockLangfuse).toHaveBeenCalledWith({
        publicKey: "pk-test",
        secretKey: "sk-test",
        baseUrl: undefined,
      });
      expect(mockTrace).toHaveBeenCalledWith({
        name: "my-span",
        input: { query: "hello" },
        metadata: { foo: "bar" },
      });
      expect(mockSpan).toHaveBeenCalledWith({
        name: "my-span",
        input: { query: "hello" },
        metadata: { foo: "bar" },
      });
      expect(mockGeneration).not.toHaveBeenCalled();
      expect(mockUpdate).toHaveBeenCalledWith({ output: "world" });
      // end() called once by update wrapper, once by the auto-end
      expect(mockEnd).toHaveBeenCalled();
    });

    it("creates a generation observation when type is 'generation'", async () => {
      const mockEnd = vi.fn();
      const mockUpdate = vi.fn();
      const mockSpan = vi.fn();
      const mockGeneration = vi.fn().mockReturnValue({ update: mockUpdate, end: mockEnd });
      const mockTrace = vi.fn().mockReturnValue({ span: mockSpan, generation: mockGeneration });
      const MockLangfuse = vi.fn().mockReturnValue({ trace: mockTrace });

      vi.doMock("langfuse", () => ({ Langfuse: MockLangfuse }));
      vi.resetModules();
      const { initTracing, withObservation } = await import("../../src/tracing/langfuse.js");

      initTracing({ publicKey: "pk", secretKey: "sk", baseUrl: "https://lf.example.com" });

      await withObservation(
        "llm-call",
        { type: "generation", model: "gpt-4o", input: "prompt" },
        async () => "response",
      );

      expect(mockSpan).not.toHaveBeenCalled();
      expect(mockGeneration).toHaveBeenCalledWith({
        name: "llm-call",
        input: "prompt",
        metadata: undefined,
        model: "gpt-4o",
      });
      expect(mockEnd).toHaveBeenCalled();
    });

    it("converts LLMUsage to Langfuse usage format", async () => {
      const mockUpdate = vi.fn();
      const mockEnd = vi.fn();
      const mockSpan = vi.fn().mockReturnValue({ update: mockUpdate, end: mockEnd });
      const mockTrace = vi.fn().mockReturnValue({ span: mockSpan, generation: vi.fn() });
      const MockLangfuse = vi.fn().mockReturnValue({ trace: mockTrace });

      vi.doMock("langfuse", () => ({ Langfuse: MockLangfuse }));
      vi.resetModules();
      const { initTracing, withObservation } = await import("../../src/tracing/langfuse.js");

      initTracing({ publicKey: "pk", secretKey: "sk" });

      const usage = makeUsage();

      await withObservation("usage-test", {}, async (obs) => {
        obs.update({ usage });
      });

      expect(mockUpdate).toHaveBeenCalledWith({
        usage: {
          input: 100,
          output: 50,
          total: 150,
          inputCost: 0.001,
          outputCost: 0.002,
          totalCost: 0.003,
        },
      });
    });

    it("records error on the observation when fn throws", async () => {
      const mockUpdate = vi.fn();
      const mockEnd = vi.fn();
      const mockSpan = vi.fn().mockReturnValue({ update: mockUpdate, end: mockEnd });
      const mockTrace = vi.fn().mockReturnValue({ span: mockSpan, generation: vi.fn() });
      const MockLangfuse = vi.fn().mockReturnValue({ trace: mockTrace });

      vi.doMock("langfuse", () => ({ Langfuse: MockLangfuse }));
      vi.resetModules();
      const { initTracing, withObservation } = await import("../../src/tracing/langfuse.js");

      initTracing({ publicKey: "pk", secretKey: "sk" });

      await expect(
        withObservation("error-test", {}, async () => {
          throw new Error("test error");
        }),
      ).rejects.toThrow("test error");

      // Should have called update with error info on the raw observation
      expect(mockUpdate).toHaveBeenCalledWith({
        level: "ERROR",
        statusMessage: "test error",
      });
      expect(mockEnd).toHaveBeenCalled();
    });

    it("defaults to span when type is omitted", async () => {
      const mockSpan = vi.fn().mockReturnValue({ update: vi.fn(), end: vi.fn() });
      const mockGeneration = vi.fn();
      const mockTrace = vi.fn().mockReturnValue({ span: mockSpan, generation: mockGeneration });
      const MockLangfuse = vi.fn().mockReturnValue({ trace: mockTrace });

      vi.doMock("langfuse", () => ({ Langfuse: MockLangfuse }));
      vi.resetModules();
      const { initTracing, withObservation } = await import("../../src/tracing/langfuse.js");

      initTracing({ publicKey: "pk", secretKey: "sk" });

      await withObservation("default-type", {}, async () => "ok");

      expect(mockSpan).toHaveBeenCalled();
      expect(mockGeneration).not.toHaveBeenCalled();
    });
  });

  describe("initTracing — import failure (langfuse not installed)", () => {
    it("falls back to no-op when langfuse import rejects", async () => {
      vi.doMock("langfuse", () => {
        throw new Error("Cannot find module 'langfuse'");
      });
      vi.resetModules();
      const { initTracing, withObservation } = await import("../../src/tracing/langfuse.js");

      initTracing({ publicKey: "pk", secretKey: "sk" });

      const result = await withObservation(
        "noop-test",
        { type: "generation", model: "gpt-4o" },
        async (obs) => {
          obs.update({ output: "ignored" });
          obs.end();
          return "fallback";
        },
      );

      expect(result).toBe("fallback");
    });
  });
});
