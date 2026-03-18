import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentPersistence } from "../agent/persistence/types.js";
import type { PublicAssetStorage } from "../agent/public-assets/storage.js";
import type { AuthContext } from "./backend.js";

export interface RequestRuntimeScope {
  auth: AuthContext;
  persistence: AgentPersistence;
  publicAssetStorage: PublicAssetStorage;
  publicAssetsDir?: string;
}

const storage = new AsyncLocalStorage<RequestRuntimeScope>();

export function runWithRequestRuntimeScope<T>(
  scope: RequestRuntimeScope,
  callback: () => T,
): T {
  return storage.run(scope, callback);
}

export function getRequestRuntimeScope(): RequestRuntimeScope | null {
  return storage.getStore() ?? null;
}
