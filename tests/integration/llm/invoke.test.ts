import { describe, it, expect } from "vitest";
import { PROVIDERS, hasApiKey, createTestClient } from "./helpers.js";
import type { LLMMessage } from "../../../src/types/llm.js";

for (const config of PROVIDERS) {
  describe.skipIf(!hasApiKey(config))(`${config.provider} invoke`, () => {
    it("returns a response for a simple prompt", async () => {
      const client = createTestClient(config);
      const result = await client.invoke({
        messages: [{ role: "user", content: "Say hello in one word." }],
      });

      expect(result.type).toBe("message");
      expect(result.content).toBeTruthy();
      expect(result.finishReason).toBe("stop");
      expect(result.usage.inputTokens).toBeGreaterThan(0);
      expect(result.usage.outputTokens).toBeGreaterThan(0);
    }, 30_000);

    it("follows system message instructions", async () => {
      const client = createTestClient(config);
      const messages: LLMMessage[] = [
        {
          role: "system",
          content:
            "You must always respond in French, no matter what language the user uses.",
        },
        { role: "user", content: "Say hello." },
      ];
      const result = await client.invoke({ messages });

      expect(result.content).toBeTruthy();
      // French greetings
      expect(result.content!.toLowerCase()).toMatch(
        /bonjour|salut|coucou|bonsoir/,
      );
    }, 30_000);

    it("follows instructions field", async () => {
      const client = createTestClient(config);
      const result = await client.invoke({
        messages: [{ role: "user", content: "Say hello." }],
        instructions:
          "You must always respond in French, no matter what language the user uses.",
      });

      expect(result.content).toBeTruthy();
      expect(result.content!.toLowerCase()).toMatch(
        /bonjour|salut|coucou|bonsoir/,
      );
    }, 30_000);

    it("maintains context in multi-turn conversation", async () => {
      const client = createTestClient(config);
      const messages: LLMMessage[] = [
        { role: "user", content: "My name is TestUser42. Remember this." },
        {
          role: "assistant",
          content: "I'll remember that your name is TestUser42.",
        },
        { role: "user", content: "What is my name?" },
      ];
      const result = await client.invoke({ messages });

      expect(result.content).toBeTruthy();
      expect(result.content!).toContain("TestUser42");
    }, 30_000);

    it("reports token usage", async () => {
      const client = createTestClient(config);
      const result = await client.invoke({
        messages: [{ role: "user", content: "Hi" }],
      });

      expect(result.usage.inputTokens).toBeGreaterThan(0);
      expect(result.usage.outputTokens).toBeGreaterThan(0);
      expect(result.usage.totalTokens).toBeGreaterThanOrEqual(
        result.usage.inputTokens + result.usage.outputTokens,
      );
    }, 30_000);

    it("returns a responseId", async () => {
      const client = createTestClient(config);
      const result = await client.invoke({
        messages: [{ role: "user", content: "Hi" }],
      });

      expect(result.responseId).toBeTruthy();
    }, 30_000);
  });
}
