import type { z, ZodType } from "zod";

export interface ToolDefinition<
  TParams extends ZodType = ZodType,
  TResult = unknown,
> {
  name: string;
  description: string;
  parameters: TParams;
  execute: (
    params: z.infer<TParams>,
    options?: ToolExecutionOptions,
  ) => Promise<TResult>;
}

export interface ToolExecutionOptions {
  signal?: AbortSignal;
}

export type ToolExecutionKind = "user_function" | "provider_native";

export interface ProviderNativeToolBase {
  kind: "provider_native";
  provider: "openai";
}

export interface OpenAINativeShellTool extends ProviderNativeToolBase {
  type: "shell";
  workingDir: string;
  timeoutMs: number;
  allowedCommands?: string[];
  blockedCommands?: string[];
  inheritEnv?: boolean;
}

export interface OpenAINativeApplyPatchTool extends ProviderNativeToolBase {
  type: "apply_patch";
  allowedPaths: string[];
}

export type ProviderNativeTool =
  | OpenAINativeShellTool
  | OpenAINativeApplyPatchTool;

export type AgentTool = ToolDefinition | ProviderNativeTool;

export interface ProviderRawTransport {
  provider: "openai";
  inputItems?: unknown[];
  outputItems?: unknown[];
}

export interface LLMToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  executionKind?: ToolExecutionKind;
  provider?: "openai";
  extra?: Record<string, unknown>;
  result?: LLMToolResult;
}

export interface LLMToolResult {
  toolCallId: string;
  content: string;
  isError?: boolean;
  extra?: Record<string, unknown>;
}

export function isProviderNativeTool(tool: AgentTool): tool is ProviderNativeTool {
  return (tool as ProviderNativeTool).kind === "provider_native";
}

export function isFunctionToolDefinition(tool: AgentTool): tool is ToolDefinition {
  return !isProviderNativeTool(tool);
}
