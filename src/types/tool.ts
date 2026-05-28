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
  artifacts?: (
    result: TResult,
    params: z.infer<TParams>,
  ) => AgentArtifact[] | undefined;
}

export interface ToolExecutionOptions {
  signal?: AbortSignal;
}

export type ToolExecutionKind = "user_function" | "provider_native";

export interface ProviderNativeToolBase {
  kind: "provider_native";
  provider: "openai" | "anthropic";
}

export interface OpenAIProviderNativeToolBase extends ProviderNativeToolBase {
  provider: "openai";
}

export interface OpenAINativeShellTool extends OpenAIProviderNativeToolBase {
  type: "shell";
  workingDir: string;
  timeoutMs: number;
  allowedCommands?: string[];
  blockedCommands?: string[];
  inheritEnv?: boolean;
}

export interface OpenAINativeApplyPatchTool extends OpenAIProviderNativeToolBase {
  type: "apply_patch";
  allowedPaths: string[];
}

export interface AnthropicNativeTextEditorTool extends ProviderNativeToolBase {
  provider: "anthropic";
  type: "text_editor_20250728";
  name: "str_replace_based_edit_tool";
  maxCharacters?: number;
}

export type ProviderNativeTool =
  | OpenAINativeShellTool
  | OpenAINativeApplyPatchTool
  | AnthropicNativeTextEditorTool;

export type AgentTool = ToolDefinition | ProviderNativeTool;

export interface ProviderRawTransport {
  provider: "openai" | "anthropic";
  inputItems?: unknown[];
  outputItems?: unknown[];
  stopReason?: string | null;
  finishReason?: string;
}

export interface LLMToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  executionKind?: ToolExecutionKind;
  provider?: "openai" | "anthropic";
  extra?: Record<string, unknown>;
  result?: LLMToolResult;
}

export interface LLMToolResult {
  toolCallId: string;
  content: string;
  structuredContent?: unknown;
  outputContent?: ToolResultOutputContent[];
  artifacts?: AgentArtifact[];
  isError?: boolean;
  extra?: Record<string, unknown>;
}

export type ToolResultOutputContent =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "file";
      fileId: string;
      filename?: string;
    };

export interface ToolResultEnvelope {
  content?: string;
  structuredContent?: unknown;
  outputContent?: ToolResultOutputContent[];
  artifacts?: AgentArtifact[];
}

export type AgentArtifact =
  | {
      type: "file";
      artifactId: string;
      path?: string;
      text?: string;
      contentType?: string;
      [key: string]: unknown;
    }
  | {
      type: "data";
      artifactId: string;
      dataType: string;
      data: Record<string, unknown>;
      [key: string]: unknown;
    };

export function isProviderNativeTool(tool: AgentTool): tool is ProviderNativeTool {
  return (tool as ProviderNativeTool).kind === "provider_native";
}

export function isFunctionToolDefinition(tool: AgentTool): tool is ToolDefinition {
  return !isProviderNativeTool(tool);
}
