import { access } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { PersistenceBackendOptions } from "../agent/persistence/factory.js";

export interface AiKitConfig {
  persistence?: PersistenceBackendOptions;
}

export interface LoadAiKitConfigOptions {
  cwd?: string;
  configFile?: string | false;
}

const DEFAULT_CONFIG_FILES = [
  "ai-kit.config.ts",
  "ai-kit.config.mjs",
] as const;

export async function loadAiKitConfig(
  options: LoadAiKitConfigOptions = {},
): Promise<AiKitConfig | null> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const configPath = await resolveConfigPath(cwd, options.configFile);
  if (!configPath) {
    return null;
  }

  let imported: unknown;
  try {
    imported = await import(pathToFileURL(configPath).href);
  } catch (error) {
    throw rewriteConfigImportError(configPath, error);
  }

  const config = normalizeConfigModule(imported);
  if (!isAiKitConfig(config)) {
    throw new Error(`Invalid ai-kit config export in "${configPath}"`);
  }
  return config;
}

async function resolveConfigPath(
  cwd: string,
  configFile: string | false | undefined,
): Promise<string | null> {
  if (configFile === false) {
    return null;
  }

  if (typeof configFile === "string" && configFile.length > 0) {
    const resolved = path.isAbsolute(configFile)
      ? configFile
      : path.resolve(cwd, configFile);
    if (!await fileExists(resolved)) {
      throw new Error(`ai-kit config file not found: ${resolved}`);
    }
    return resolved;
  }

  for (const candidate of DEFAULT_CONFIG_FILES) {
    const resolved = path.resolve(cwd, candidate);
    if (await fileExists(resolved)) {
      return resolved;
    }
  }

  return null;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function normalizeConfigModule(imported: unknown): unknown {
  if (isRecord(imported) && "default" in imported) {
    return imported.default;
  }
  return imported;
}

function rewriteConfigImportError(configPath: string, error: unknown): Error {
  if (
    error instanceof Error &&
    /unknown file extension/i.test(error.message) &&
    configPath.endsWith(".ts")
  ) {
    return new Error(
      `Failed to import "${configPath}". TypeScript config files require a TS-aware runtime such as tsx.`,
    );
  }

  if (error instanceof Error) {
    return new Error(`Failed to import "${configPath}": ${error.message}`);
  }

  return new Error(`Failed to import "${configPath}": ${String(error)}`);
}

function isAiKitConfig(value: unknown): value is AiKitConfig {
  if (!isRecord(value)) {
    return false;
  }

  if (value.persistence === undefined) {
    return true;
  }

  return isPersistenceBackendOptions(value.persistence);
}

function isPersistenceBackendOptions(value: unknown): value is PersistenceBackendOptions {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return false;
  }

  switch (value.kind) {
    case "filesystem":
      return value.dataDir === undefined || typeof value.dataDir === "string";
    case "supabase":
      return typeof value.url === "string" &&
        typeof value.serviceRoleKey === "string" &&
        (value.schema === undefined || typeof value.schema === "string") &&
        (value.tablePrefix === undefined || typeof value.tablePrefix === "string") &&
        (value.bucket === undefined || typeof value.bucket === "string") &&
        (
          value.signedUrlExpiresInSeconds === undefined ||
          typeof value.signedUrlExpiresInSeconds === "number"
        );
    default:
      return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
