import { describe, it, expect } from "vitest";
import { AgentRegistry } from "../../../src/agent/mcp/agent-registry.js";
import type { AgentContext } from "../../../src/types/agent.js";
import type { ConversationalAgent } from "../../../src/agent/conversational.js";

function stubAgent(_ctx: AgentContext): ConversationalAgent {
  return {} as ConversationalAgent;
}

function anotherAgent(_ctx: AgentContext): ConversationalAgent {
  return {} as ConversationalAgent;
}

describe("AgentRegistry", () => {
  it("registers agents and lists IDs", () => {
    const registry = new AgentRegistry({
      agents: [
        { create: stubAgent, description: "Stub agent" },
        { create: anotherAgent, description: "Another" },
      ],
    });

    expect(registry.agentIds()).toEqual(["stubAgent", "anotherAgent"]);
  });

  it("resolves default agent as first agent", () => {
    const registry = new AgentRegistry({
      agents: [
        { create: stubAgent, description: "Stub" },
        { create: anotherAgent, description: "Another" },
      ],
    });

    expect(registry.resolveAgentId()).toBe("stubAgent");
  });

  it("resolves explicit default agent", () => {
    const registry = new AgentRegistry({
      agents: [
        { create: stubAgent, description: "Stub" },
        { create: anotherAgent, description: "Another" },
      ],
      defaultAgentId: "anotherAgent",
    });

    expect(registry.resolveAgentId()).toBe("anotherAgent");
  });

  it("resolves specific agent by ID", () => {
    const registry = new AgentRegistry({
      agents: [
        { create: stubAgent, description: "Stub" },
        { create: anotherAgent, description: "Another" },
      ],
    });

    expect(registry.resolveAgentId("anotherAgent")).toBe("anotherAgent");
  });

  it("uses custom agentId", () => {
    const registry = new AgentRegistry({
      agents: [
        { create: stubAgent, agentId: "custom-id", description: "Custom" },
      ],
    });

    expect(registry.agentIds()).toEqual(["custom-id"]);
    expect(registry.resolveAgentId("custom-id")).toBe("custom-id");
  });

  it("throws on duplicate agent ID", () => {
    expect(
      () =>
        new AgentRegistry({
          agents: [
            { create: stubAgent, agentId: "dup" },
            { create: anotherAgent, agentId: "dup" },
          ],
        }),
    ).toThrow("Duplicate agent ID: dup");
  });

  it("throws on unknown default agent", () => {
    expect(
      () =>
        new AgentRegistry({
          agents: [{ create: stubAgent }],
          defaultAgentId: "nonexistent",
        }),
    ).toThrow('Default agent ID "nonexistent" not found');
  });

  it("throws when resolving unknown agent ID", () => {
    const registry = new AgentRegistry({
      agents: [{ create: stubAgent }],
    });

    expect(() => registry.resolveAgentId("unknown")).toThrow(
      "Agent not found: unknown",
    );
  });

  it("throws when no agents registered and resolving default", () => {
    const registry = new AgentRegistry({ agents: [] });
    expect(() => registry.resolveAgentId()).toThrow("No agents registered");
  });

  it("gets agent entry by ID", () => {
    const entry = { create: stubAgent, description: "Stub" };
    const registry = new AgentRegistry({ agents: [entry] });

    const resolved = registry.get("stubAgent");
    expect(resolved.description).toBe("Stub");
    expect(resolved.create).toBe(stubAgent);
  });

  it("generates list payload", () => {
    const registry = new AgentRegistry({
      agents: [
        { create: stubAgent, description: "Stub agent" },
        { create: anotherAgent, agentId: "custom", description: "Custom" },
      ],
      defaultAgentId: "custom",
    });

    const payload = registry.listPayload();
    expect(payload.defaultAgentId).toBe("custom");
    expect(payload.agents).toEqual([
      { agentId: "stubAgent", description: "Stub agent" },
      { agentId: "custom", description: "Custom" },
    ]);
  });
});
