import type { ZodType } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ToolDefinition } from "../../types/tool.js";

export function defineTool<TParams extends ZodType, TResult>(
  config: ToolDefinition<TParams, TResult>,
): ToolDefinition<TParams, TResult> {
  return config;
}

export function toolToJsonSchema(tool: ToolDefinition): {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
} {
  const jsonSchema = zodToJsonSchema(tool.parameters, {
    $refStrategy: "none",
    // OpenAI function tools expect standard JSON Schema numeric bounds such as
    // `exclusiveMinimum: 0`, not the OpenAPI 3 boolean form plus `minimum`.
    target: "jsonSchema7",
  });

  // Remove $schema and top-level additionalProperties if added by zod-to-json-schema
  const { $schema, ...parameters } = jsonSchema as Record<string, unknown>;

  return {
    name: tool.name,
    description: tool.description,
    parameters,
  };
}
