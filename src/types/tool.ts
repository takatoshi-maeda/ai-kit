import type { z, ZodType } from "zod";

export interface ToolDefinition<
  TParams extends ZodType = ZodType,
  TResult = unknown,
> {
  name: string;
  description: string;
  parameters: TParams;
  execute: (params: z.infer<TParams>) => Promise<TResult>;
}

export interface LLMToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result?: LLMToolResult;
}

export interface LLMToolResult {
  toolCallId: string;
  content: string;
  isError?: boolean;
}
