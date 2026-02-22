import { describe, it, expect } from "vitest";
import {
  TOOL_CAPABLE_PROVIDERS,
  hasApiKey,
  createTestClient,
  weatherTool,
} from "./helpers.js";

for (const config of TOOL_CAPABLE_PROVIDERS) {
  describe.skipIf(!hasApiKey(config))(
    `${config.provider} tool calling`,
    () => {
      it("invokes a tool when prompted", async () => {
        const client = createTestClient(config);
        const result = await client.invoke({
          messages: [
            {
              role: "user",
              content: "What is the current weather in Tokyo?",
            },
          ],
          tools: [weatherTool],
        });

        expect(result.type).toBe("tool_use");
        expect(result.finishReason).toBe("tool_use");
        expect(result.toolCalls.length).toBeGreaterThan(0);

        const call = result.toolCalls[0];
        expect(call.name).toBe("get_weather");
        expect(call.arguments).toHaveProperty("location");
        expect(call.id).toBeTruthy();
      }, 30_000);

      it("forces tool use with toolChoice required", async () => {
        const client = createTestClient(config);
        const result = await client.invoke({
          messages: [{ role: "user", content: "Hello, how are you?" }],
          tools: [weatherTool],
          toolChoice: "required",
        });

        expect(result.type).toBe("tool_use");
        expect(result.toolCalls.length).toBeGreaterThan(0);
        expect(result.toolCalls[0].name).toBe("get_weather");
      }, 30_000);

      it("skips tool use with toolChoice none", async () => {
        const client = createTestClient(config);
        const result = await client.invoke({
          messages: [
            {
              role: "user",
              content: "What is the weather in Tokyo? Just say you cannot.",
            },
          ],
          tools: [weatherTool],
          toolChoice: "none",
        });

        expect(result.type).toBe("message");
        expect(result.toolCalls).toHaveLength(0);
        expect(result.content).toBeTruthy();
      }, 30_000);

      it("returns parseable tool arguments", async () => {
        const client = createTestClient(config);
        const result = await client.invoke({
          messages: [
            { role: "user", content: "Get the weather in Paris." },
          ],
          tools: [weatherTool],
          toolChoice: "required",
        });

        const call = result.toolCalls[0];
        expect(typeof call.arguments.location).toBe("string");
        expect((call.arguments.location as string).length).toBeGreaterThan(0);
      }, 30_000);
    },
  );
}
