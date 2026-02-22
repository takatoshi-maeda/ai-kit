import { describe, it, expect } from "vitest";
import {
  AGENT_PROVIDERS,
  hasApiKey,
  createAgent,
  createAgentContext,
} from "./helpers.js";
import { createTestClient } from "../llm/helpers.js";
import { AgentRouter } from "../../../src/agent/router.js";

for (const config of AGENT_PROVIDERS) {
  describe.skipIf(!hasApiKey(config))(
    `${config.provider} AgentRouter`,
    () => {
      it("routes to the correct agent", async () => {
        const context = createAgentContext();
        const client = createTestClient(config);

        const greeter = createAgent(config, {
          instructions: "You are a greeter. You greet people warmly.",
        });
        const coder = createAgent(config, {
          instructions: "You are a coder. You write code.",
        });

        const agents = new Map([
          ["greeter", greeter],
          ["coder", coder],
        ]);

        const router = new AgentRouter({
          context,
          client,
          instructions:
            "Route the user to the most appropriate agent based on their request.",
          agents,
        });

        const selected = await router.resolve("Say bonjour and greet me warmly");
        expect(context.selectedAgentName).toBe("greeter");
      }, 30_000);
    },
  );
}
