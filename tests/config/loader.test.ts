import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadAiKitConfig } from "../../src/config/loader.js";

describe("loadAiKitConfig", () => {
  it("loads an explicit .mjs config file", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "ai-kit-config-"));
    const configPath = path.join(cwd, "custom.config.mjs");
    await writeFile(
      configPath,
      'export default { persistence: { kind: "filesystem", dataDir: "custom-data" } };',
      "utf8",
    );

    const config = await loadAiKitConfig({ cwd, configFile: "custom.config.mjs" });

    expect(config).toEqual({
      persistence: {
        kind: "filesystem",
        dataDir: "custom-data",
      },
    });
  });

  it("returns null when config loading is disabled", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "ai-kit-config-"));
    await mkdir(cwd, { recursive: true });
    await writeFile(
      path.join(cwd, "ai-kit.config.mjs"),
      'export default { persistence: { kind: "filesystem", dataDir: "ignored" } };',
      "utf8",
    );

    const config = await loadAiKitConfig({ cwd, configFile: false });

    expect(config).toBeNull();
  });

  it("prefers ai-kit.config.ts over ai-kit.config.mjs during auto-discovery", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "ai-kit-config-"));
    await writeFile(
      path.join(cwd, "ai-kit.config.ts"),
      'export default { persistence: { kind: "filesystem", dataDir: "from-ts" } };',
      "utf8",
    );
    await writeFile(
      path.join(cwd, "ai-kit.config.mjs"),
      'export default { persistence: { kind: "filesystem", dataDir: "from-mjs" } };',
      "utf8",
    );

    const config = await loadAiKitConfig({ cwd });

    expect(config).toEqual({
      persistence: {
        kind: "filesystem",
        dataDir: "from-ts",
      },
    });
  });

  it("falls back to ai-kit.config.mjs when no TypeScript config exists", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "ai-kit-config-"));
    await writeFile(
      path.join(cwd, "ai-kit.config.mjs"),
      'export default { persistence: { kind: "filesystem", dataDir: "from-mjs" } };',
      "utf8",
    );

    const config = await loadAiKitConfig({ cwd });

    expect(config).toEqual({
      persistence: {
        kind: "filesystem",
        dataDir: "from-mjs",
      },
    });
  });
});
