/** エージェントストリーミング出力の構造化レスポンス型 */
export type AgentStreamResponse =
  | AgentTextDelta
  | AgentToolCall
  | AgentReasoningDelta
  | AgentProgress
  | AgentResultEvent
  | AgentError
  | AgentRunStart
  | AgentRunStop;

export interface AgentTextDelta {
  type: "agent.text_delta";
  delta: string;
}

export interface AgentToolCall {
  type: "agent.tool_call";
  name: string;
  summary: string;
}

export interface AgentReasoningDelta {
  type: "agent.reasoning_delta";
  delta: string;
}

export interface AgentProgress {
  type: "agent.progress";
  summary: string;
  description: string;
}

export interface AgentResultEvent {
  type: "agent.result";
  resultType: "text" | "json";
  content: unknown;
  responseId?: string;
}

export interface AgentError {
  type: "agent.error";
  error: Error;
}

export interface AgentRunStart {
  type: "agent.run_start";
  sessionId: string;
  model: string;
}

export interface AgentRunStop {
  type: "agent.run_stop";
  status: "completed" | "error";
}
