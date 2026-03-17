import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createFakePostgresSql } from "../helpers/fake-postgres.js";

describe("runSetupCommand", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates the filesystem data directory when using the filesystem backend", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "ai-kit-cli-setup-fs-"));
    await writeFile(
      path.join(cwd, "ai-kit.config.mjs"),
      'export default { persistence: { kind: "filesystem", dataDir: "./runtime-data" } };',
      "utf8",
    );

    const { runSetupCommand } = await import("../../src/cli/commands/setup.js");
    const message = await runSetupCommand({
      cwd,
      configFile: path.join(cwd, "ai-kit.config.mjs"),
    });

    expect(message).toContain("Filesystem backend is ready");
    const result = await stat(path.join(cwd, "runtime-data"));
    expect(result.isDirectory()).toBe(true);
  });

  it("creates postgres tables directly through postgres.js", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "ai-kit-cli-setup-pg-"));
    const configPath = path.join(cwd, "ai-kit.config.mjs");
    const fakeSql = createFakePostgresSql();
    await writeFile(
      configPath,
      [
        "export default {",
        '  persistence: {',
        '    kind: "postgres",',
        '    connectionString: "postgresql://postgres:postgres@example.com:5432/postgres",',
        '    schema: "custom_schema",',
        '    tablePrefix: "custom_",',
        '    assetDataDir: "./runtime-assets"',
        "  }",
        "};",
      ].join("\n"),
      "utf8",
    );

    vi.doMock("../../src/agent/postgres/client.js", async () => {
      const actual = await vi.importActual<typeof import("../../src/agent/postgres/client.js")>(
        "../../src/agent/postgres/client.js",
      );
      return {
        ...actual,
        createPostgresClient: vi.fn(() => fakeSql),
      };
    });

    const { runSetupCommand } = await import("../../src/cli/commands/setup.js");
    const message = await runSetupCommand({
      cwd,
      configFile: configPath,
    });

    expect(message).toContain("Postgres backend setup completed");
    expect(fakeSql.appliedSql().join("\n")).toContain('create schema if not exists "custom_schema";');
    const result = await stat(path.join(cwd, "runtime-assets"));
    expect(result.isDirectory()).toBe(true);
  });

  it("initializes a temporary supabase project and pushes the generated migration", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "ai-kit-cli-setup-supabase-"));
    const configPath = path.join(cwd, "ai-kit.config.mjs");
    await writeFile(
      configPath,
      [
        "export default {",
        '  persistence: {',
        '    kind: "supabase",',
        '    url: "https://example.supabase.co",',
        '    serviceRoleKey: "service-role-key",',
        '    schema: "custom_schema",',
        '    tablePrefix: "custom_",',
        '    bucket: "custom-bucket"',
        "  }",
        "};",
      ].join("\n"),
      "utf8",
    );

    const execCalls: Array<{ args: string[] }> = [];
    vi.doMock("node:child_process", () => ({
      execFile: (
        _file: string,
        args: string[],
        _options: Record<string, unknown>,
        callback: (error: Error | null, stdout?: string, stderr?: string) => void,
      ) => {
        execCalls.push({ args });
        callback(null, "", "");
        return {} as never;
      },
    }));

    const { runSetupCommand } = await import("../../src/cli/commands/setup.js");
    const message = await runSetupCommand({
      cwd,
      configFile: configPath,
      dbUrl: "postgresql://postgres:postgres@example.com:5432/postgres",
    });

    expect(message).toContain("Supabase backend setup completed");
    expect(execCalls.map((call) => call.args)).toEqual([
      ["--version"],
      ["--version"],
      expect.arrayContaining(["--workdir", expect.any(String), "init", "--force"]),
      expect.arrayContaining(["--workdir", expect.any(String), "db", "push", "--include-all"]),
    ]);
  });

  it("falls back to npx supabase when the binary is not on PATH", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "ai-kit-cli-setup-supabase-npx-"));
    const configPath = path.join(cwd, "ai-kit.config.mjs");
    await writeFile(
      configPath,
      [
        "export default {",
        '  persistence: {',
        '    kind: "supabase",',
        '    url: "https://example.supabase.co",',
        '    serviceRoleKey: "service-role-key"',
        "  }",
        "};",
      ].join("\n"),
      "utf8",
    );

    const execCalls: Array<{ file: string; args: string[] }> = [];
    vi.doMock("node:child_process", () => ({
      execFile: (
        file: string,
        args: string[],
        _options: Record<string, unknown>,
        callback: (error: NodeJS.ErrnoException | null, stdout?: string, stderr?: string) => void,
      ) => {
        execCalls.push({ file, args });
        if (file === "supabase") {
          callback(Object.assign(new Error("not found"), { code: "ENOENT" }));
          return {} as never;
        }
        callback(null, "", "");
        return {} as never;
      },
    }));

    const { runSetupCommand } = await import("../../src/cli/commands/setup.js");
    const message = await runSetupCommand({
      cwd,
      configFile: configPath,
      dbUrl: "postgresql://postgres:postgres@example.com:5432/postgres",
    });

    expect(message).toContain("Supabase backend setup completed");
    expect(execCalls).toEqual([
      { file: "supabase", args: ["--version"] },
      { file: "npx", args: ["--yes", "supabase", "--version"] },
      { file: "npx", args: ["--yes", "supabase", "--version"] },
      { file: "npx", args: expect.arrayContaining(["--yes", "supabase", "--workdir", expect.any(String), "init", "--force"]) },
      { file: "npx", args: expect.arrayContaining(["--yes", "supabase", "--workdir", expect.any(String), "db", "push", "--include-all"]) },
    ]);
  });

  it("uses the real project directory for linked supabase setup", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "ai-kit-cli-setup-supabase-linked-"));
    const configPath = path.join(cwd, "ai-kit.config.mjs");
    await writeFile(
      configPath,
      [
        "export default {",
        '  persistence: {',
        '    kind: "supabase",',
        '    url: "https://example.supabase.co",',
        '    serviceRoleKey: "service-role-key",',
        '    schema: "linked_schema",',
        '    tablePrefix: "linked_",',
        '    bucket: "linked-bucket"',
        "  }",
        "};",
      ].join("\n"),
      "utf8",
    );

    const execCalls: Array<{ file: string; args: string[]; cwd?: string }> = [];
    vi.doMock("node:child_process", () => ({
      execFile: (
        file: string,
        args: string[],
        options: Record<string, unknown>,
        callback: (error: Error | null, stdout?: string, stderr?: string) => void,
      ) => {
        execCalls.push({ file, args, cwd: typeof options.cwd === "string" ? options.cwd : undefined });
        callback(null, "", "");
        return {} as never;
      },
    }));

    const { runSetupCommand } = await import("../../src/cli/commands/setup.js");
    const message = await runSetupCommand({
      cwd,
      configFile: configPath,
    });

    expect(message).toContain("Supabase backend setup completed");
    expect(execCalls).toEqual([
      { file: "supabase", args: ["--version"], cwd: undefined },
      { file: "supabase", args: ["--version"], cwd: undefined },
      { file: "supabase", args: ["db", "push", "--include-all", "--linked"], cwd },
    ]);
    const migration = await readFile(
      path.join(cwd, "supabase", "migrations", "20260317000000_ai_kit_setup.sql"),
      "utf8",
    );
    expect(migration).toContain('create schema if not exists "linked_schema";');
    expect(migration).toContain('"linked_conversations"');
    expect(migration).toContain("'linked-bucket'");
  });

  it("uses local mode when --local is requested", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "ai-kit-cli-setup-supabase-local-"));
    const configPath = path.join(cwd, "ai-kit.config.mjs");
    await writeFile(
      configPath,
      [
        "export default {",
        '  persistence: {',
        '    kind: "supabase",',
        '    url: "https://example.supabase.co",',
        '    serviceRoleKey: "service-role-key"',
        "  }",
        "};",
      ].join("\n"),
      "utf8",
    );

    const execCalls: Array<{ file: string; args: string[]; cwd?: string }> = [];
    vi.doMock("node:child_process", () => ({
      execFile: (
        file: string,
        args: string[],
        options: Record<string, unknown>,
        callback: (error: Error | null, stdout?: string, stderr?: string) => void,
      ) => {
        execCalls.push({ file, args, cwd: typeof options.cwd === "string" ? options.cwd : undefined });
        callback(null, "", "");
        return {} as never;
      },
    }));

    const { runSetupCommand } = await import("../../src/cli/commands/setup.js");
    const message = await runSetupCommand({
      cwd,
      configFile: configPath,
      local: true,
    });

    expect(message).toContain("Supabase backend setup completed");
    expect(execCalls).toEqual([
      { file: "supabase", args: ["--version"], cwd: undefined },
      { file: "supabase", args: ["--version"], cwd: undefined },
      { file: "supabase", args: ["db", "push", "--include-all", "--local"], cwd },
    ]);
  });

  it("includes setup diagnostics when debug mode is enabled", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "ai-kit-cli-setup-debug-"));
    const configPath = path.join(cwd, "ai-kit.config.mjs");
    await writeFile(
      configPath,
      [
        "export default {",
        '  persistence: {',
        '    kind: "supabase",',
        '    url: "https://example.supabase.co",',
        '    serviceRoleKey: "service-role-key"',
        "  }",
        "};",
      ].join("\n"),
      "utf8",
    );

    vi.doMock("node:child_process", () => ({
      execFile: (
        _file: string,
        args: string[],
        _options: Record<string, unknown>,
        callback: (error: Error | null, stdout?: string, stderr?: string) => void,
      ) => {
        if (args.includes("db") && args.includes("push")) {
          callback(new Error("push failed"), "", "Cannot find project ref");
          return {} as never;
        }
        callback(null, "", "");
        return {} as never;
      },
    }));

    const { runSetupCommand } = await import("../../src/cli/commands/setup.js");
    await expect(runSetupCommand({
      cwd,
      configFile: configPath,
      debug: true,
    })).rejects.toThrow(/ai-kit debug/);
  });
});
