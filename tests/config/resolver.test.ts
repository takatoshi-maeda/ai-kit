import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveAiKitOptions } from "../../src/config/resolver.js";

describe("resolveAiKitOptions", () => {
  it("prefers explicit persistence over config and dataDir", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "ai-kit-resolve-"));
    const configPath = path.join(cwd, "ai-kit.config.mjs");
    await writeFile(
      configPath,
      'export default { persistence: { kind: "filesystem", dataDir: "from-config" } };',
      "utf8",
    );

    const resolved = await resolveAiKitOptions({
      agentDefinitions: [],
      dataDir: "from-data-dir",
      configFile: configPath,
      persistence: {
        kind: "filesystem",
        dataDir: "from-explicit-persistence",
      },
    });

    expect(resolved.persistence).toEqual({
      kind: "filesystem",
      dataDir: "from-explicit-persistence",
    });
  });

  it("prefers config persistence over legacy dataDir", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "ai-kit-resolve-"));
    const configPath = path.join(cwd, "ai-kit.config.mjs");
    await writeFile(
      configPath,
      'export default { persistence: { kind: "filesystem", dataDir: "from-config" } };',
      "utf8",
    );

    const resolved = await resolveAiKitOptions({
      agentDefinitions: [],
      dataDir: "from-data-dir",
      configFile: configPath,
    });

    expect(resolved.persistence).toEqual({
      kind: "filesystem",
      dataDir: "from-config",
    });
  });

  it("falls back to default filesystem persistence when nothing is configured", async () => {
    const resolved = await resolveAiKitOptions({
      agentDefinitions: [],
      configFile: false,
    });

    expect(resolved.persistence).toEqual({
      kind: "filesystem",
      dataDir: "data",
    });
  });

  it("returns postgres persistence from config when configured", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "ai-kit-resolve-"));
    const configPath = path.join(cwd, "ai-kit.config.mjs");
    await writeFile(
      configPath,
      [
        "export default {",
        '  persistence: {',
        '    kind: "postgres",',
        '    connectionString: "postgresql://postgres:postgres@example.com:5432/postgres",',
        '    tablePrefix: "custom_"',
        "  }",
        "};",
      ].join("\n"),
      "utf8",
    );

    const resolved = await resolveAiKitOptions({
      agentDefinitions: [],
      configFile: configPath,
    });

    expect(resolved.persistence).toEqual({
      kind: "postgres",
      connectionString: "postgresql://postgres:postgres@example.com:5432/postgres",
      tablePrefix: "custom_",
    });
  });

  it("auto-discovers ai-kit.config from process.cwd when configFile is omitted", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "ai-kit-resolve-"));
    await writeFile(
      path.join(cwd, "ai-kit.config.mjs"),
      'export default { persistence: { kind: "filesystem", dataDir: "from-autodiscovery" } };',
      "utf8",
    );

    const previousCwd = process.cwd();
    process.chdir(cwd);
    try {
      const resolved = await resolveAiKitOptions({
        agentDefinitions: [],
      });

      expect(resolved.persistence).toEqual({
        kind: "filesystem",
        dataDir: "from-autodiscovery",
      });
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("skips auto-discovery when configFile is false even if cwd contains a config", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "ai-kit-resolve-"));
    await writeFile(
      path.join(cwd, "ai-kit.config.mjs"),
      'export default { persistence: { kind: "filesystem", dataDir: "from-autodiscovery" } };',
      "utf8",
    );

    const previousCwd = process.cwd();
    process.chdir(cwd);
    try {
      const resolved = await resolveAiKitOptions({
        agentDefinitions: [],
        configFile: false,
      });

      expect(resolved.persistence).toEqual({
        kind: "filesystem",
        dataDir: "data",
      });
    } finally {
      process.chdir(previousCwd);
    }
  });
});
