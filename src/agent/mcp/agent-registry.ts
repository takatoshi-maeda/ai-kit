import type { AgentContext } from "../../types/agent.js";
import type { ConversationalAgent } from "../conversational.js";
import { AiKitError } from "../../errors.js";

/** エージェント登録エントリ */
export interface AgentEntry {
  /** エージェントを生成するファクトリ関数 */
  create: (
    context: AgentContext,
    params?: Record<string, unknown>,
  ) => ConversationalAgent;
  /** MCP ツール一覧に表示する説明 */
  description?: string;
  /** カスタム ID。未指定時はファクトリ関数名を使用 */
  agentId?: string;
}

export interface AgentRegistryOptions {
  agents: AgentEntry[];
  defaultAgentId?: string;
}

/**
 * エージェントの登録・検索を行うレジストリ。
 * ID の重複を検証し、デフォルトエージェントの解決を行う。
 */
export class AgentRegistry {
  private readonly entries: Map<string, AgentEntry>;
  private readonly defaultAgentId: string | null;

  constructor(options: AgentRegistryOptions) {
    this.entries = new Map();

    for (const entry of options.agents) {
      const id = entry.agentId ?? entry.create.name;
      if (!id) {
        throw new AiKitError(
          "AgentEntry must have an agentId or a named create function",
        );
      }
      if (this.entries.has(id)) {
        throw new AiKitError(`Duplicate agent ID: ${id}`);
      }
      this.entries.set(id, entry);
    }

    if (options.defaultAgentId) {
      if (!this.entries.has(options.defaultAgentId)) {
        throw new AiKitError(
          `Default agent ID "${options.defaultAgentId}" not found in registry`,
        );
      }
      this.defaultAgentId = options.defaultAgentId;
    } else {
      this.defaultAgentId =
        options.agents.length > 0
          ? (options.agents[0].agentId ?? options.agents[0].create.name)
          : null;
    }
  }

  /** agent_id を解決する（未指定時はデフォルト→先頭の順でフォールバック） */
  resolveAgentId(agentId?: string): string {
    if (agentId) {
      if (!this.entries.has(agentId)) {
        throw new AiKitError(`Agent not found: ${agentId}`);
      }
      return agentId;
    }
    if (this.defaultAgentId) {
      return this.defaultAgentId;
    }
    throw new AiKitError("No agents registered");
  }

  /** ID からエントリを取得 */
  get(agentId: string): AgentEntry {
    const entry = this.entries.get(agentId);
    if (!entry) {
      throw new AiKitError(`Agent not found: ${agentId}`);
    }
    return entry;
  }

  /** 登録済み ID 一覧 */
  agentIds(): string[] {
    return [...this.entries.keys()];
  }

  /** agent.list ツール用のペイロードを生成 */
  listPayload(): {
    defaultAgentId: string | null;
    agents: { agentId: string; description?: string }[];
  } {
    return {
      defaultAgentId: this.defaultAgentId,
      agents: [...this.entries.entries()].map(([id, entry]) => ({
        agentId: id,
        description: entry.description,
      })),
    };
  }
}
