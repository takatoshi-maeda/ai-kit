import { describe, it, expect } from "vitest";
import { PROVIDERS, hasApiKey, createTestClient } from "./helpers.js";
import type { LLMStreamEvent } from "../../../src/types/stream-events.js";

for (const config of PROVIDERS) {
  describe.skipIf(!hasApiKey(config))(`${config.provider} streaming`, () => {
    it("produces text delta events", async () => {
      const client = createTestClient(config);
      const events: LLMStreamEvent[] = [];

      for await (const event of client.stream({
        messages: [{ role: "user", content: "Count from 1 to 5." }],
      })) {
        events.push(event);
      }

      const textDeltas = events.filter((e) => e.type === "text.delta");
      expect(textDeltas.length).toBeGreaterThan(0);

      const fullText = textDeltas
        .map((e) => (e as { delta: string }).delta)
        .join("");
      expect(fullText).toBeTruthy();
    }, 30_000);

    it("emits response.completed with a result", async () => {
      const client = createTestClient(config);
      const events: LLMStreamEvent[] = [];

      for await (const event of client.stream({
        messages: [{ role: "user", content: "Say hi." }],
      })) {
        events.push(event);
      }

      const completed = events.find((e) => e.type === "response.completed");
      expect(completed).toBeDefined();

      if (completed?.type === "response.completed") {
        expect(completed.result.type).toBe("message");
        expect(completed.result.content).toBeTruthy();
      }
    }, 30_000);

    it("emits text.done with accumulated text", async () => {
      const client = createTestClient(config);
      const events: LLMStreamEvent[] = [];

      for await (const event of client.stream({
        messages: [{ role: "user", content: "Say hello." }],
      })) {
        events.push(event);
      }

      const textDone = events.find((e) => e.type === "text.done");
      expect(textDone).toBeDefined();

      if (textDone?.type === "text.done") {
        expect(textDone.text).toBeTruthy();
      }
    }, 30_000);

    it("emits response.created with responseId", async () => {
      const client = createTestClient(config);
      const events: LLMStreamEvent[] = [];

      for await (const event of client.stream({
        messages: [{ role: "user", content: "Hi" }],
      })) {
        events.push(event);
      }

      const created = events.find((e) => e.type === "response.created");
      expect(created).toBeDefined();

      if (created?.type === "response.created") {
        expect(created.responseId).toBeTruthy();
      }
    }, 30_000);
  });
}
