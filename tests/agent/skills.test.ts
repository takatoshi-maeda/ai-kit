import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import * as fs from "node:fs/promises";
import {
  buildActiveSkillsInstructionMessages,
  listSkills,
  resolveBuiltInSkillRoots,
} from "../../src/agent/skills.js";

async function writeSkill(
  filesRoot: string,
  name: string,
  description: string,
  body: string,
  relativeSkillDir = name,
): Promise<void> {
  const skillDir = path.join(filesRoot, ".skills", relativeSkillDir);
  await writeSkillFile(skillDir, name, description, body);
}

async function writeBuiltInSkill(
  root: string,
  name: string,
  description: string,
  body: string,
  relativeSkillDir = name,
): Promise<void> {
  const skillDir = path.join(root, relativeSkillDir);
  await writeSkillFile(skillDir, name, description, body);
}

async function writeSkillFile(
  skillDir: string,
  name: string,
  description: string,
  body: string,
  fileName = "SKILL.md",
): Promise<void> {
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, fileName), [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    "---",
    body,
    "",
  ].join("\n"), "utf8");
}

describe("skill discovery", () => {
  it("includes bundled global skills alongside workspace skills", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ai-kit-skills-"));
    await writeSkill(tmpDir, "focus", "Workspace focus", "Be concise.");

    const skills = await listSkills(tmpDir);

    expect(skills.find((skill) => skill.name === "focus")).toMatchObject({
      name: "focus",
      description: "Workspace focus",
    });
    expect(skills.find((skill) => skill.name === "skill-creator")).toMatchObject({
      name: "skill-creator",
      mention: "$skill-creator",
    });
  });

  it("discovers nested skills and prefers workspace definitions on name collision", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ai-kit-skills-nested-"));
    await writeSkill(
      tmpDir,
      "focus",
      "Nested focus",
      "Use the nested workflow.",
      path.join(".team", "focus"),
    );
    await writeSkill(
      tmpDir,
      "skill-creator",
      "Workspace override",
      "Use the workspace skill.",
    );

    const skills = await listSkills(tmpDir);
    const focus = skills.find((skill) => skill.name === "focus");
    const skillCreatorMatches = skills.filter((skill) => skill.name === "skill-creator");

    expect(focus?.directory).toBe(path.join(tmpDir, ".skills", ".team", "focus"));
    expect(skillCreatorMatches).toHaveLength(1);
    expect(skillCreatorMatches[0]).toMatchObject({
      name: "skill-creator",
      description: "Workspace override",
      directory: path.join(tmpDir, ".skills", "skill-creator"),
    });
  });

  it("includes agent built-in skills between bundled globals and workspace skills", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ai-kit-skills-precedence-"));
    const builtInRoot = await mkdtemp(path.join(os.tmpdir(), "ai-kit-built-in-skills-"));
    await writeBuiltInSkill(
      builtInRoot,
      "research-plan",
      "Built-in research plan",
      "Plan the investigation.",
    );
    await writeBuiltInSkill(
      builtInRoot,
      "focus",
      "Built-in focus",
      "Use the built-in workflow.",
    );
    await writeSkill(
      tmpDir,
      "focus",
      "Workspace focus",
      "Use the workspace workflow.",
    );

    const skills = await listSkills(tmpDir, {
      builtInSkillRoots: [builtInRoot],
    });

    expect(skills.find((skill) => skill.name === "research-plan")).toMatchObject({
      name: "research-plan",
      description: "Built-in research plan",
      directory: path.join(builtInRoot, "research-plan"),
    });
    expect(skills.find((skill) => skill.name === "skill-creator")).toMatchObject({
      name: "skill-creator",
      mention: "$skill-creator",
    });
    expect(skills.find((skill) => skill.name === "focus")).toMatchObject({
      name: "focus",
      description: "Workspace focus",
      directory: path.join(tmpDir, ".skills", "focus"),
    });
  });

  it("prefers provider-specific skill files and falls back to SKILL.md", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ai-kit-skills-provider-"));
    const builtInRoot = await mkdtemp(path.join(os.tmpdir(), "ai-kit-built-in-provider-skills-"));
    await writeSkillFile(
      path.join(builtInRoot, "edit-doc"),
      "edit-doc",
      "Default editor",
      "Use the default editor.",
    );
    await writeSkillFile(
      path.join(builtInRoot, "edit-doc"),
      "edit-doc",
      "Anthropic editor",
      "Use str_replace_based_edit_tool.",
      "SKILL.anthropic.md",
    );
    await writeBuiltInSkill(
      builtInRoot,
      "research-plan",
      "Built-in research plan",
      "Plan the investigation.",
    );

    const anthropicSkills = await listSkills(tmpDir, {
      builtInSkillRoots: [builtInRoot],
      provider: "anthropic",
    });
    const openAiSkills = await listSkills(tmpDir, {
      builtInSkillRoots: [builtInRoot],
      provider: "openai",
    });

    expect(anthropicSkills.find((skill) => skill.name === "edit-doc")).toMatchObject({
      description: "Anthropic editor",
      body: "Use str_replace_based_edit_tool.",
    });
    expect(openAiSkills.find((skill) => skill.name === "edit-doc")).toMatchObject({
      description: "Default editor",
      body: "Use the default editor.",
    });
    expect(anthropicSkills.find((skill) => skill.name === "research-plan")).toMatchObject({
      description: "Built-in research plan",
    });
  });
});

describe("active skill instructions", () => {
  it("builds one system message per active skill", () => {
    const messages = buildActiveSkillsInstructionMessages([
      {
        name: "focus",
        description: "Focus mode",
        mention: "$focus",
        directory: "/tmp/focus",
        body: "Be concise.",
      },
      {
        name: "review",
        description: "Review mode",
        mention: "$review",
        directory: "/tmp/review",
        body: "Find bugs.",
      },
    ]);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining('<skill_content name="focus">'),
    });
    expect(messages[1]).toMatchObject({
      role: "system",
      content: expect.stringContaining('<skill_content name="review">'),
    });
  });
});

describe("built-in skill roots", () => {
  it("resolves dynamic roots from runtime policy context", async () => {
    const roots = await resolveBuiltInSkillRoots({
      builtInSkillRoots: ({ runtimePolicy }) => [
        "common",
        runtimePolicy?.provider === "anthropic" ? "anthropic" : "openai",
      ],
      resolveWorkingDir: () => "/tmp",
    }, {
      agentContext: {} as never,
      runtimePolicy: {
        provider: "anthropic",
        defaults: { model: "claude-sonnet-4-6" },
      },
      runtime: { model: "claude-sonnet-4-6" },
    });

    expect(roots).toEqual(["common", "anthropic"]);
  });
});
