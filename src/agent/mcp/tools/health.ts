import type { McpPersistence } from "../persistence.js";

export async function handleHealthCheck(
  persistence: McpPersistence,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  isError: boolean;
}> {
  const result = await persistence.checkHealth();
  const payload = {
    ok: result.ok,
    timestamp: new Date().toISOString(),
    dependencies: {
      storage: {
        driver: "filesystem",
        ok: result.ok,
        error: result.error ?? null,
      },
    },
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: false,
  };
}
