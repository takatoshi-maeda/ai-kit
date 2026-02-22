import type { LLMStreamEvent } from "../types/stream-events.js";
import type { AgentResult } from "../types/agent.js";
import type { AgentStream } from "./conversational.js";
import { AgentRouter, type AgentRouterOptions } from "./router.js";

/**
 * Combines agent routing and execution into a single facade.
 *
 * Resolves the appropriate agent via AgentRouter, then delegates
 * execution to the selected agent's stream().
 */
export class AgentProxy {
  private readonly router: AgentRouter;

  constructor(options: AgentRouterOptions) {
    this.router = new AgentRouter(options);
  }

  run(input: string): AgentStream {
    let resolveResult!: (r: AgentResult) => void;
    let rejectResult!: (e: Error) => void;
    const resultPromise = new Promise<AgentResult>((res, rej) => {
      resolveResult = res;
      rejectResult = rej;
    });

    const router = this.router;

    const gen = (async function* (): AsyncGenerator<LLMStreamEvent, void> {
      const agent = await router.resolve(input);
      const agentStream = agent.stream(input);

      try {
        for await (const event of agentStream) {
          yield event;
        }
        resolveResult(await agentStream.result);
      } catch (err) {
        // Suppress the unhandled rejection on the inner agent's result promise
        agentStream.result.catch(() => {});
        const error = err instanceof Error ? err : new Error(String(err));
        rejectResult(error);
        throw error;
      }
    })();

    const wrappedIterator: AsyncIterableIterator<LLMStreamEvent> = {
      async next() {
        try {
          const iterResult = await gen.next();
          if (iterResult.done) {
            return { done: true as const, value: undefined as unknown as LLMStreamEvent };
          }
          return { done: false as const, value: iterResult.value };
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          rejectResult(error);
          throw error;
        }
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
}
