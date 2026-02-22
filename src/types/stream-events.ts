import type { LLMResult, LLMUsage } from "./llm.js";

export interface ResponseCreatedEvent {
  type: "response.created";
  responseId: string;
}

export interface ResponseCompletedEvent {
  type: "response.completed";
  result: LLMResult;
}

export interface ResponseFailedEvent {
  type: "response.failed";
  error: Error;
}

export interface TextDeltaEvent {
  type: "text.delta";
  delta: string;
}

export interface TextDoneEvent {
  type: "text.done";
  text: string;
}

export interface ToolCallDeltaEvent {
  type: "tool_call.arguments.delta";
  toolCallId: string;
  name: string;
  delta: string;
}

export interface ToolCallDoneEvent {
  type: "tool_call.arguments.done";
  toolCallId: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ReasoningDeltaEvent {
  type: "reasoning.delta";
  delta: string;
}

export interface ReasoningDoneEvent {
  type: "reasoning.done";
  text: string;
}

export interface ErrorEvent {
  type: "error";
  error: Error;
}

export interface UsageEvent {
  type: "usage";
  usage: LLMUsage;
}

export type LLMStreamEvent =
  | ResponseCreatedEvent
  | ResponseCompletedEvent
  | ResponseFailedEvent
  | TextDeltaEvent
  | TextDoneEvent
  | ToolCallDeltaEvent
  | ToolCallDoneEvent
  | ReasoningDeltaEvent
  | ReasoningDoneEvent
  | ErrorEvent
  | UsageEvent;
