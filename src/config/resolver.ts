import type { AuthBackendOptions } from "../auth/index.js";
import type { PersistenceBackendOptions } from "../agent/persistence/factory.js";
import { loadAiKitConfig } from "./loader.js";
import type { MountMcpRoutesOptions } from "../hono/index.js";

export type ResolvedAiKitOptions =
  Omit<MountMcpRoutesOptions, "persistence"> & {
    persistence: PersistenceBackendOptions;
    auth: AuthBackendOptions;
  };

export async function resolveAiKitOptions(
  options: MountMcpRoutesOptions,
): Promise<ResolvedAiKitOptions> {
  const config = await loadAiKitConfig({
    configFile: options.configFile,
  });

  return {
    ...options,
    persistence: resolvePersistenceBackendOptions(options, config?.persistence),
    auth: resolveAuthBackendOptions(options, config?.auth),
  };
}

function resolvePersistenceBackendOptions(
  options: MountMcpRoutesOptions,
  configuredPersistence: PersistenceBackendOptions | undefined,
): PersistenceBackendOptions {
  if (options.persistence) {
    return { ...options.persistence };
  }

  if (configuredPersistence) {
    return { ...configuredPersistence };
  }

  if (typeof options.dataDir === "string" && options.dataDir.length > 0) {
    return {
      kind: "filesystem",
      dataDir: options.dataDir,
    };
  }

  return {
    kind: "filesystem",
    dataDir: "data",
  };
}

function resolveAuthBackendOptions(
  options: MountMcpRoutesOptions,
  configuredAuth: AuthBackendOptions | undefined,
): AuthBackendOptions {
  if (options.auth) {
    return { ...options.auth };
  }

  if (configuredAuth) {
    return { ...configuredAuth };
  }

  return { kind: "none" };
}
