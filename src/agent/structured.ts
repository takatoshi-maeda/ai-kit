import type { ZodType } from "zod";
import type { AgentOptions, AgentResult } from "../types/agent.js";
import type { LLMChatInput, LLMMessage } from "../types/llm.js";
import { ConversationalAgent } from "./conversational.js";

export class StructuredAgent<T> extends ConversationalAgent {
  private readonly responseSchema: ZodType<T>;

  constructor(options: AgentOptions & { responseSchema: ZodType<T> }) {
    super(options);
    this.responseSchema = options.responseSchema;
  }

  protected override buildChatInput(
    messages: LLMMessage[],
    instructions: string,
  ): LLMChatInput {
    const input = super.buildChatInput(messages, instructions);
    return {
      ...input,
      responseFormat: {
        type: "json_schema",
        schema: this.responseSchema,
      },
    };
  }

  override async invoke(
    input: string,
    additionalInstructions?: string,
  ): Promise<AgentResult & { parsed: T }> {
    const result = await super.invoke(input, additionalInstructions);
    const parsed = this.responseSchema.parse(
      JSON.parse(result.content ?? "null"),
    );
    return { ...result, parsed };
  }
}
