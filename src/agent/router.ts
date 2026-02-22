import { z } from "zod";
import type { AgentContext } from "../types/agent.js";
import type { LLMClient } from "../types/agent.js";
import type { ConversationalAgent } from "./conversational.js";

export interface AgentRouterOptions {
  context: AgentContext;
  client: LLMClient;
  instructions: string;
  agents: Map<string, ConversationalAgent>;
}

/**
 * Routes input to the appropriate agent using LLM tool selection.
 *
 * Each registered agent is exposed as a `delegate_to_{id}` tool.
 * The LLM is called with `toolChoice: 'required'` to force selection.
 */
export class AgentRouter {
  private readonly options: AgentRouterOptions;

  constructor(options: AgentRouterOptions) {
    if (options.agents.size === 0) {
      throw new Error("AgentRouter requires at least one agent");
    }
    this.options = options;
  }

  async resolve(input: string): Promise<ConversationalAgent> {
    const { context, client, instructions, agents } = this.options;

    // Single agent — no LLM call needed
    if (agents.size === 1) {
      const [name, agent] = [...agents.entries()][0];
      context.selectedAgentName = name;
      return agent;
    }

    // Build delegate tools — one per agent
    const tools = [...agents.entries()].map(([id]) => ({
      name: `delegate_to_${id}`,
      description: `Delegate the task to the "${id}" agent.`,
      parameters: z.object({}),
      execute: async () => id,
    }));

    const historyMessages = await context.history.toLLMMessages();

    const result = await client.invoke({
      messages: [...historyMessages, { role: "user", content: input }],
      instructions,
      tools,
      toolChoice: "required",
    });

    // Find which delegate tool was selected
    const selectedCall = result.toolCalls[0];
    if (!selectedCall) {
      // Fallback to first agent if LLM didn't select
      const [name, agent] = [...agents.entries()][0];
      context.selectedAgentName = name;
      return agent;
    }

    const selectedId = selectedCall.name.replace(/^delegate_to_/, "");
    const agent = agents.get(selectedId);
    if (!agent) {
      // Fallback to first agent if the selected ID is invalid
      const [name, fallback] = [...agents.entries()][0];
      context.selectedAgentName = name;
      return fallback;
    }

    context.selectedAgentName = selectedId;
    return agent;
  }
}
