import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  STRUCTURED_OUTPUT_PROVIDERS,
  hasApiKey,
  createAgentContext,
} from "./helpers.js";
import { createTestClient } from "../llm/helpers.js";
import { StructuredAgent } from "../../../src/agent/structured.js";

const PersonSchema = z.object({
  name: z.string(),
  age: z.number(),
});

for (const config of STRUCTURED_OUTPUT_PROVIDERS) {
  describe.skipIf(!hasApiKey(config))(
    `${config.provider} StructuredAgent`,
    () => {
      it("returns parsed structured output", async () => {
        const agent = new StructuredAgent({
          context: createAgentContext(),
          client: createTestClient(config),
          instructions:
            "You extract structured data from user messages. Return JSON only.",
          responseSchema: PersonSchema,
        });

        const result = await agent.invoke(
          "John is 30 years old.",
        );

        expect(result.parsed).toBeDefined();
        expect(result.parsed.name).toMatch(/john/i);
        expect(result.parsed.age).toBe(30);
      }, 30_000);
    },
  );
}
