import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { listSkills } from "../../src/agent/skills.js";

async function writeSkill(
  filesRoot: string,
  name: string,
  description: string,
  body: string,
  relativeSkillDir = name,
): Promise<void> {
  const skillDir = path.join(filesRoot, ".skills", relativeSkillDir);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), [
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
});
