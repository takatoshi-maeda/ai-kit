import { describe, it, expect } from "vitest";
import {
  STRUCTURED_OUTPUT_PROVIDERS,
  hasApiKey,
  createTestClient,
} from "./helpers.js";
import { z } from "zod";

const WeatherSchema = z.object({
  location: z.string(),
  temperature: z.number(),
  condition: z.string(),
});

for (const config of STRUCTURED_OUTPUT_PROVIDERS) {
  describe.skipIf(!hasApiKey(config))(
    `${config.provider} structured output`,
    () => {
      it("returns JSON matching the provided schema", async () => {
        const client = createTestClient(config);
        const result = await client.invoke({
          messages: [
            {
              role: "user",
              content:
                "Give me the weather in Tokyo. Temperature in celsius as a number.",
            },
          ],
          responseFormat: {
            type: "json_schema",
            schema: WeatherSchema,
            name: "weather",
          },
        });

        expect(result.content).toBeTruthy();

        const parsed = JSON.parse(result.content!);
        const validated = WeatherSchema.safeParse(parsed);
        expect(validated.success).toBe(true);
      }, 30_000);

      it("respects schema field types", async () => {
        const NumbersSchema = z.object({
          items: z.array(z.number()),
          total: z.number(),
        });

        const client = createTestClient(config);
        const result = await client.invoke({
          messages: [
            {
              role: "user",
              content: "List the numbers 1, 2, 3 and their total.",
            },
          ],
          responseFormat: {
            type: "json_schema",
            schema: NumbersSchema,
            name: "numbers",
          },
        });

        expect(result.content).toBeTruthy();

        const parsed = JSON.parse(result.content!);
        const validated = NumbersSchema.safeParse(parsed);
        expect(validated.success).toBe(true);

        if (validated.success) {
          expect(validated.data.items).toEqual([1, 2, 3]);
          expect(validated.data.total).toBe(6);
        }
      }, 30_000);
    },
  );
}
