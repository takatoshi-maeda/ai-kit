import { describe, it, expect } from "vitest";
import { AGENT_PROVIDERS, hasApiKey, createAgent } from "./helpers.js";
import type { LLMStreamEvent } from "../../../src/types/stream-events.js";

for (const config of AGENT_PROVIDERS) {
  describe.skipIf(!hasApiKey(config))(
    `${config.provider} ConversationalAgent.stream`,
    () => {
      it("produces text delta events", async () => {
        const agent = createAgent(config);
        const agentStream = agent.stream("Count from 1 to 3.");
        const events: LLMStreamEvent[] = [];

        for await (const event of agentStream) {
          events.push(event);
        }

        const textDeltas = events.filter((e) => e.type === "text.delta");
        expect(textDeltas.length).toBeGreaterThan(0);
      }, 30_000);

      it("resolves result promise", async () => {
        const agent = createAgent(config);
        const agentStream = agent.stream("Say hi.");

        for await (const _event of agentStream) {
          // consume
        }

        const result = await agentStream.result;
        expect(result.content).toBeTruthy();
      }, 30_000);

      it("emits response.completed", async () => {
        const agent = createAgent(config);
        const agentStream = agent.stream("Say hello.");
        const events: LLMStreamEvent[] = [];

        for await (const event of agentStream) {
          events.push(event);
        }

        const completed = events.find((e) => e.type === "response.completed");
        expect(completed).toBeDefined();
      }, 30_000);
    },
  );
}
