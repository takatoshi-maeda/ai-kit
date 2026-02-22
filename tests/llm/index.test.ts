import { describe, it, expect, vi } from "vitest";
import { createLLMClient } from "../../src/llm/index.js";

// Mock all providers
vi.mock("openai", () => {
  class MockOpenAI {
    responses = { create: vi.fn(), stream: vi.fn() };
  }
  return { default: MockOpenAI, APIError: class APIError extends Error { status = 0; } };
});

vi.mock("@anthropic-ai/sdk", () => {
  class MockAnthropic {
    messages = { create: vi.fn(), stream: vi.fn() };
  }
  return { default: MockAnthropic, APIError: class APIError extends Error { status = 0; } };
});

vi.mock("@google/genai", () => {
  class MockGoogleGenAI {
    models = { generateContent: vi.fn(), generateContentStream: vi.fn() };
  }
  return { GoogleGenAI: MockGoogleGenAI };
});

describe("createLLMClient", () => {
  it("creates OpenAI client", () => {
    const client = createLLMClient({ provider: "openai", model: "gpt-4o" });
    expect(client.provider).toBe("openai");
    expect(client.model).toBe("gpt-4o");
  });

  it("creates Anthropic client", () => {
    const client = createLLMClient({
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
    });
    expect(client.provider).toBe("anthropic");
    expect(client.model).toBe("claude-sonnet-4-20250514");
  });

  it("creates Google client", () => {
    const client = createLLMClient({
      provider: "google",
      model: "gemini-2.5-flash",
    });
    expect(client.provider).toBe("google");
    expect(client.model).toBe("gemini-2.5-flash");
  });

  it("creates Perplexity client", () => {
    const client = createLLMClient({
      provider: "perplexity",
      model: "sonar",
    });
    expect(client.provider).toBe("perplexity");
    expect(client.model).toBe("sonar");
  });

  it("passes provider-specific options", () => {
    const client = createLLMClient({
      provider: "openai",
      model: "o3",
      reasoningEffort: "high",
    });
    expect(client.model).toBe("o3");
  });
});
