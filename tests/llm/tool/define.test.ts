import { describe, it, expect } from "vitest";
import { z } from "zod";
import { defineTool, toolToJsonSchema } from "../../../src/llm/tool/define.js";

describe("defineTool", () => {
  it("returns the same tool config (pass-through)", () => {
    const tool = defineTool({
      name: "greet",
      description: "Says hello",
      parameters: z.object({ name: z.string() }),
      execute: async ({ name }) => `Hello, ${name}!`,
    });

    expect(tool.name).toBe("greet");
    expect(tool.description).toBe("Says hello");
  });
});

describe("toolToJsonSchema", () => {
  it("converts Zod schema to JSON Schema", () => {
    const tool = defineTool({
      name: "add",
      description: "Adds two numbers",
      parameters: z.object({
        a: z.number().describe("First number"),
        b: z.number().describe("Second number"),
      }),
      execute: async ({ a, b }) => a + b,
    });

    const result = toolToJsonSchema(tool);

    expect(result.name).toBe("add");
    expect(result.description).toBe("Adds two numbers");
    expect(result.parameters).toHaveProperty("type", "object");
    expect(result.parameters).toHaveProperty("properties");

    const props = result.parameters.properties as Record<string, unknown>;
    expect(props).toHaveProperty("a");
    expect(props).toHaveProperty("b");
  });

  it("does not include $schema in output", () => {
    const tool = defineTool({
      name: "test",
      description: "Test tool",
      parameters: z.object({ x: z.string() }),
      execute: async () => "ok",
    });

    const result = toolToJsonSchema(tool);
    expect(result.parameters).not.toHaveProperty("$schema");
  });
});
