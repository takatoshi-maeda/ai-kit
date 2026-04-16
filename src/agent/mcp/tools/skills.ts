import { z } from "zod";
import type { AuthContext } from "../../../auth/index.js";
import { AgentContextImpl } from "../../context.js";
import { InMemoryHistory } from "../../conversation/memory-history.js";
import { listSkills } from "../../skills.js";
import type { AgentRegistry } from "../agent-registry.js";

export const SkillsListParamsSchema = z.object({
  agentId: z.string().optional().describe("Agent ID to inspect. Defaults to the default agent."),
  params: z.record(z.unknown()).optional().describe("Optional agent params used to resolve the working directory."),
});

export interface SkillsToolDeps {
  registry: AgentRegistry;
  authContext?: AuthContext;
}

export async function handleSkillsList(
  deps: SkillsToolDeps,
  params: z.infer<typeof SkillsListParamsSchema>,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  isError: boolean;
}> {
  const agentId = deps.registry.resolveAgentId(params.agentId);
  const workingDir = await resolveAgentWorkingDir(
    deps.registry,
    agentId,
    deps.authContext,
    params.params,
  );

  if (!workingDir) {
    const payload = { items: [] };
    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload,
      isError: false,
    };
  }

  const payload = {
    items: (await listSkills(workingDir)).map((skill) => ({
      name: skill.name,
      description: skill.description,
      mention: skill.mention,
    })),
  };

  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: false,
  };
}

export async function resolveAgentWorkingDir(
  registry: AgentRegistry,
  agentId: string,
  authContext?: AuthContext,
  params?: Record<string, unknown>,
): Promise<string | null> {
  const entry = registry.get(agentId);
  if (!entry.skills) {
    return null;
  }

  const context = new AgentContextImpl({
    history: new InMemoryHistory(),
    auth: authContext,
    selectedAgentName: agentId,
  });
  const workingDir = await entry.skills.resolveWorkingDir({
    agentContext: context,
    params,
  });
  return workingDir.trim();
}
