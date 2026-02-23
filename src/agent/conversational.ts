import { MaxTurnsExceededError } from "../errors.js";
import type {
  AgentContext,
  AgentOptions,
  AgentResult,
  TurnResult,
} from "../types/agent.js";
import type { LLMChatInput, LLMMessage, LLMResult, LLMUsage } from "../types/llm.js";
import type { LLMStreamEvent } from "../types/stream-events.js";
import type { LLMToolCall, ToolDefinition } from "../types/tool.js";
import { ToolExecutor } from "../llm/tool/executor.js";
import { toolCallsToMessages } from "../llm/tool/message-converter.js";
import {
  runWithObservationContext,
  startObservation,
  withObservation,
} from "../tracing/langfuse.js";
import {
  runBeforeTurnHooks,
  runAfterTurnHooks,
  runBeforeToolCallHooks,
  runAfterToolCallHooks,
  runAfterRunHooks,
} from "./hooks.js";

export interface AgentStream extends AsyncIterable<LLMStreamEvent> {
  readonly result: Promise<AgentResult>;
}

const DEFAULT_MAX_TURNS = 10;

export class ConversationalAgent {
  protected readonly options: AgentOptions;
  private readonly toolExecutor: ToolExecutor;

  constructor(options: AgentOptions) {
    this.options = options;
    this.toolExecutor = new ToolExecutor(options.tools ?? []);
  }

  stream(
    input: string,
    additionalInstructions?: string,
  ): AgentStream {
    const observationPromise = startObservation("agent.run", {
      type: "span",
      input: {
        input,
        additionalInstructions,
      },
      metadata: {
        sessionId: this.options.context.sessionId,
        selectedAgentName: this.options.context.selectedAgentName,
        provider: this.options.client.provider,
        model: this.options.client.model,
      },
    });
    let observationEnded = false;

    const finishObservation = async (
      result?: AgentResult,
      error?: Error,
    ): Promise<void> => {
      if (observationEnded) {
        return;
      }
      observationEnded = true;
      try {
        const observation = await observationPromise;
        if (result) {
          observation.update({
            output: result.content,
            usage: result.usage,
            metadata: {
              responseId: result.responseId,
              toolCalls: result.toolCalls.length,
              turns: this.options.context.turns.length,
            },
          });
        } else if (error) {
          observation.update({
            metadata: {
              error: error.message,
            },
          });
        } else {
          observation.update({
            metadata: {
              cancelled: true,
            },
          });
        }
        observation.end();
      } catch {
        // Tracing must never break agent execution
      }
    };

    let resolveResult!: (r: AgentResult) => void;
    let rejectResult!: (e: Error) => void;
    const resultPromise = new Promise<AgentResult>((res, rej) => {
      resolveResult = res;
      rejectResult = rej;
    });

    const gen = this.runLoop(input, additionalInstructions);

    const wrappedIterator: AsyncIterableIterator<LLMStreamEvent> = {
      async next() {
        try {
          const iterResult = await runWithObservationContext(
            await observationPromise,
            () => gen.next(),
          );
          if (iterResult.done) {
            await finishObservation(iterResult.value);
            resolveResult(iterResult.value);
            return { done: true as const, value: undefined as unknown as LLMStreamEvent };
          }
          return { done: false as const, value: iterResult.value };
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          await finishObservation(undefined, error);
          rejectResult(error);
          throw error;
        }
      },
      async return() {
        const r = await runWithObservationContext(
          await observationPromise,
          () => gen.return(undefined as unknown as AgentResult),
        );
        await finishObservation();
        return { done: true as const, value: r.value as unknown as LLMStreamEvent };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };

    return {
      [Symbol.asyncIterator]() {
        return wrappedIterator;
      },
      result: resultPromise,
    };
  }

  async invoke(
    input: string,
    additionalInstructions?: string,
  ): Promise<AgentResult> {
    const agentStream = this.stream(input, additionalInstructions);
    try {
      for await (const _event of agentStream) {
        // Consume stream to drive the run loop
      }
      return await agentStream.result;
    } catch (err) {
      // Suppress the unhandled rejection on resultPromise — the
      // generator error is already propagated via the for-await throw.
      agentStream.result.catch(() => {});
      throw err;
    }
  }

  protected buildChatInput(
    messages: LLMMessage[],
    instructions: string,
  ): LLMChatInput {
    return {
      messages,
      instructions,
      tools: this.options.tools,
    };
  }

  private async *runLoop(
    input: string,
    additionalInstructions?: string,
  ): AsyncGenerator<LLMStreamEvent, AgentResult> {
    const {
      context,
      client,
      instructions,
      hooks,
      toolPipeline,
      maxTurns = DEFAULT_MAX_TURNS,
    } = this.options;

    const enforcedQueue: ToolDefinition[] = [
      ...(toolPipeline?.onStart ?? []),
    ];
    let onBeforeCompleteConsumed = false;

    const currentMessages: LLMMessage[] = [
      { role: "user", content: input },
    ];

    const totalUsage = emptyUsage();
    let currentTurn = 0;

    while (currentTurn < maxTurns) {
      // 1. Execute enforced tools from queue
      await this.executeEnforcedTools(enforcedQueue, currentMessages);

      // 2. Build chat input
      const historyMessages = await context.history.toLLMMessages();
      const combinedInstructions = additionalInstructions
        ? `${instructions}\n\n${additionalInstructions}`
        : instructions;

      const chatInput = this.buildChatInput(
        [...historyMessages, ...currentMessages],
        combinedInstructions,
      );

      // 3. beforeTurn hooks
      await runBeforeTurnHooks(hooks, {
        agentContext: context,
        turnIndex: currentTurn,
        input: chatInput,
      });

      // 4. Stream LLM call, yield events, collect result
      const turnLLMResult = yield* this.streamAndCollect(
        client.stream(chatInput),
      );

      addUsage(totalUsage, turnLLMResult.usage);

      // Record turn
      const turn: TurnResult = {
        turnType: turnLLMResult.toolCalls.length > 0 ? "next_action" : "finish",
        result: turnLLMResult,
        index: currentTurn,
      };
      context.turns.push(turn);

      // afterTurn hooks
      await runAfterTurnHooks(hooks, {
        agentContext: context,
        turnResult: turn,
      });

      // 5. If tool calls, execute them and continue
      if (turnLLMResult.toolCalls.length > 0) {
        await this.executeToolCalls(
          turnLLMResult.toolCalls,
          context,
          hooks,
        );

        const toolMessages = toolCallsToMessages(
          turnLLMResult.toolCalls,
          turnLLMResult.content ?? undefined,
        );
        currentMessages.push(...toolMessages);

        currentTurn++;
        continue;
      }

      // 6. No tool calls = finish. Check onBeforeComplete first.
      if (!onBeforeCompleteConsumed && toolPipeline?.onBeforeComplete?.length) {
        enforcedQueue.push(...toolPipeline.onBeforeComplete);
        onBeforeCompleteConsumed = true;
        currentTurn++;
        continue;
      }

      // 7. Build agent result and run afterRun hooks
      const agentResult: AgentResult = {
        content: turnLLMResult.content,
        toolCalls: [...context.toolCallResults],
        usage: totalUsage,
        responseId: turnLLMResult.responseId,
        raw: turnLLMResult,
      };

      const action = await runAfterRunHooks(hooks, {
        agentContext: context,
        result: agentResult,
      });

      if (action.type === "rerun") {
        currentTurn++;
        continue;
      }

      // Save to conversation history
      await context.history.addMessage({ role: "user", content: input });
      if (turnLLMResult.content) {
        await context.history.addMessage({
          role: "assistant",
          content: turnLLMResult.content,
        });
      }

      return agentResult;
    }

    throw new MaxTurnsExceededError(
      `Agent exceeded maximum turns (${maxTurns})`,
      { maxTurns, completedTurns: currentTurn },
    );
  }

  private async *streamAndCollect(
    stream: AsyncIterable<LLMStreamEvent>,
  ): AsyncGenerator<LLMStreamEvent, LLMResult> {
    let result: LLMResult | null = null;
    let streamError: Error | null = null;

    for await (const event of stream) {
      yield event;
      if (event.type === "response.completed") {
        result = event.result;
      }
      if (event.type === "error") {
        streamError = event.error;
      }
    }

    if (streamError) {
      throw streamError;
    }
    if (!result) {
      throw new Error("LLM stream ended without a response.completed event");
    }
    return result;
  }

  private async executeToolCalls(
    toolCalls: LLMToolCall[],
    context: AgentContext,
    hooks: AgentOptions["hooks"],
  ): Promise<void> {
    for (const toolCall of toolCalls) {
      await runBeforeToolCallHooks(hooks, {
        agentContext: context,
        toolCall,
      });

      const result = await withObservation(
        "agent.tool_call",
        {
          type: "span",
          input: {
            toolCallId: toolCall.id,
            name: toolCall.name,
            arguments: toolCall.arguments,
          },
          metadata: {
            toolCallId: toolCall.id,
            toolName: toolCall.name,
          },
        },
        async (observation) => {
          const toolResult = await this.toolExecutor.execute(toolCall);
          observation.update({
            output: toolResult.content,
            metadata: {
              isError: !!toolResult.isError,
            },
          });
          return toolResult;
        },
      );
      toolCall.result = result;
      context.toolCallResults.push(toolCall);

      await runAfterToolCallHooks(hooks, {
        agentContext: context,
        toolCall,
        result,
      });
    }
  }

  private async executeEnforcedTools(
    queue: ToolDefinition[],
    messages: LLMMessage[],
  ): Promise<void> {
    while (queue.length > 0) {
      const tool = queue.shift()!;
      try {
        const parsed = tool.parameters.parse({});
        const rawResult = await tool.execute(parsed);
        const content =
          typeof rawResult === "string" ? rawResult : JSON.stringify(rawResult);
        messages.push({
          role: "user",
          content: `[${tool.name}]: ${content}`,
        });
      } catch {
        // Skip enforced tools that fail to parse/execute
      }
    }
  }
}

function emptyUsage(): LLMUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    totalTokens: 0,
    inputCost: 0,
    outputCost: 0,
    cacheCost: 0,
    totalCost: 0,
  };
}

function addUsage(target: LLMUsage, source: LLMUsage): void {
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.cachedInputTokens += source.cachedInputTokens;
  target.totalTokens += source.totalTokens;
  target.inputCost += source.inputCost;
  target.outputCost += source.outputCost;
  target.cacheCost += source.cacheCost;
  target.totalCost += source.totalCost;
}
