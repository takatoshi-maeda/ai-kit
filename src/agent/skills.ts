import * as fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import type { ContentPart } from "../types/llm.js";
import type { AgentReasoningEffort, AgentVerbosity } from "../types/runtime.js";

export interface SkillAgentRuntime {
  model?: string;
  reasoningEffort?: AgentReasoningEffort;
  verbosity?: AgentVerbosity;
}

export interface DiscoveredSkill {
  name: string;
  description: string;
  mention: string;
  directory: string;
  body: string;
  agentRuntime?: SkillAgentRuntime;
}

interface ParsedSkillFile {
  name: string;
  description: string;
  body: string;
  agentRuntime?: SkillAgentRuntime;
}

const bundledSkillsRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../resources/skills",
);

export async function listSkills(workingDir: string): Promise<DiscoveredSkill[]> {
  const workspaceSkillsRoot = path.join(path.resolve(workingDir), ".skills");
  const [bundledSkills, workspaceSkills] = await Promise.all([
    listSkillsFromRoot(bundledSkillsRoot),
    listSkillsFromRoot(workspaceSkillsRoot),
  ]);

  const merged = new Map<string, DiscoveredSkill>();
  for (const skill of bundledSkills) {
    merged.set(skill.name, skill);
  }
  for (const skill of workspaceSkills) {
    merged.set(skill.name, skill);
  }

  return [...merged.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function collectSkillMentionNames(
  input: string | ContentPart[],
): string[] {
  if (typeof input === "string") {
    return collectMentionsFromText(input);
  }

  const mentionedSkillNames: string[] = [];
  for (const part of input) {
    if (part.type !== "text") {
      continue;
    }
    mentionedSkillNames.push(...collectMentionsFromText(part.text));
  }
  return unique(mentionedSkillNames);
}

export function stripResolvedSkillMentions(
  input: string | ContentPart[],
  activeSkillNames: Iterable<string>,
): string | ContentPart[] {
  const known = new Set(activeSkillNames);
  if (typeof input === "string") {
    return stripMentionsFromText(input, known).text;
  }

  return input.map((part) => {
    if (part.type !== "text") {
      return part;
    }
    return { ...part, text: stripMentionsFromText(part.text, known).text };
  });
}

export function resolveSkillsByName(
  availableSkills: DiscoveredSkill[],
  names: string[],
): Map<string, DiscoveredSkill> {
  const deduped = unique(names);
  const byName = new Map(availableSkills.map((skill) => [skill.name, skill]));
  const resolved = new Map<string, DiscoveredSkill>();
  for (const name of deduped) {
    const skill = byName.get(name);
    if (skill) {
      resolved.set(name, skill);
    }
  }
  return resolved;
}

export function buildActiveSkillsInstructions(skills: DiscoveredSkill[]): string | undefined {
  if (skills.length === 0) {
    return undefined;
  }

  const blocks = skills.map((skill) => [
    `<skill_content name="${escapeAttribute(skill.name)}">`,
    skill.body.trim(),
    "",
    `Skill directory: ${skill.directory}`,
    "Relative paths are resolved from this directory.",
    "</skill_content>",
  ].join("\n"));

  return [
    "<active_skills>",
    ...blocks,
    "</active_skills>",
  ].join("\n");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function collectMentionsFromText(text: string): string[] {
  const names: string[] = [];
  text.replace(/(^|[^\w])\$([A-Za-z0-9_-]+)/g, (_match, _prefix: string, rawName: string) => {
    const name = rawName.trim();
    if (name.length > 0) {
      names.push(name);
    }
    return "";
  });
  return unique(names);
}

function stripMentionsFromText(
  text: string,
  activeSkillNames: ReadonlySet<string>,
): { text: string; names: string[] } {
  const names: string[] = [];
  const stripped = text.replace(/(^|[^\w])\$([A-Za-z0-9_-]+)/g, (match, prefix: string, rawName: string) => {
    const name = rawName.trim();
    if (!activeSkillNames.has(name)) {
      return match;
    }
    names.push(name);
    return `${prefix} `;
  });
  return {
    text: stripped.replace(/[ \t]{2,}/g, " ").replace(/\n[ \t]+/g, "\n").trim(),
    names: unique(names),
  };
}

async function readSkillFile(filePath: string): Promise<ParsedSkillFile | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }

  const parsed = parseSkillMarkdown(raw);
  if (!parsed) {
    return null;
  }

  return parsed;
}

async function listSkillsFromRoot(rootDirectory: string): Promise<DiscoveredSkill[]> {
  return collectSkillsFromDirectory(path.resolve(rootDirectory));
}

async function collectSkillsFromDirectory(directory: string): Promise<DiscoveredSkill[]> {
  const parsed = await readSkillFile(path.join(directory, "SKILL.md"));
  if (parsed) {
    return [toDiscoveredSkill(directory, parsed)];
  }

  let entries: Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return [];
    }
    throw error;
  }

  const skills: DiscoveredSkill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    skills.push(...await collectSkillsFromDirectory(path.join(directory, entry.name)));
  }
  return skills;
}

function parseSkillMarkdown(raw: string): ParsedSkillFile | null {
  if (!raw.startsWith("---\n")) {
    return null;
  }

  const closingIndex = raw.indexOf("\n---\n", 4);
  if (closingIndex < 0) {
    return null;
  }

  const frontmatter = raw.slice(4, closingIndex);
  const body = raw.slice(closingIndex + 5).trim();
  if (body.length === 0) {
    return null;
  }

  let frontmatterDoc: unknown;
  try {
    frontmatterDoc = yaml.load(frontmatter);
  } catch {
    return null;
  }

  const doc = asRecord(frontmatterDoc);
  if (!doc) {
    return null;
  }

  const name = asString(doc.name);
  const description = asString(doc.description);

  if (!name || !description) {
    return null;
  }

  return {
    name,
    description,
    body,
    agentRuntime: parseAgentRuntime(doc),
  };
}

function toDiscoveredSkill(directory: string, parsed: ParsedSkillFile): DiscoveredSkill {
  return {
    name: parsed.name,
    description: parsed.description,
    mention: `$${parsed.name}`,
    directory,
    body: parsed.body,
    agentRuntime: parsed.agentRuntime,
  };
}

function parseAgentRuntime(doc: Record<string, unknown>): SkillAgentRuntime | undefined {
  const metadata = asRecord(doc.metadata);
  const agentRuntime = asRecord(metadata?.["agent-runtime"]);
  const model = asString(agentRuntime?.model);
  const reasoningEffort = asReasoningEffort(agentRuntime?.["reasoning-effort"]);
  const verbosity = asVerbosity(agentRuntime?.verbosity);

  if (!model && !reasoningEffort && !verbosity) {
    return undefined;
  }

  return {
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(verbosity ? { verbosity } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asReasoningEffort(value: unknown): AgentReasoningEffort | undefined {
  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }
  return undefined;
}

function asVerbosity(value: unknown): AgentVerbosity | undefined {
  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }
  return undefined;
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;");
}
