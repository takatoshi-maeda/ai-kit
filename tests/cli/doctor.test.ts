import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createFakePostgresSql } from "../helpers/fake-postgres.js";
import type { SupabaseClientLike, SupabaseQueryLike, SupabaseQueryResult } from "../../src/agent/supabase/client.js";

describe("runDoctorCommand", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("reports filesystem health as text", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "ai-kit-cli-doctor-fs-"));
    const configPath = path.join(cwd, "ai-kit.config.mjs");
    await writeFile(
      configPath,
      'export default { persistence: { kind: "filesystem", dataDir: "./runtime-data" } };',
      "utf8",
    );

    const { runDoctorCommand } = await import("../../src/cli/commands/doctor.js");
    const output = await runDoctorCommand({ configFile: configPath });

    expect(output).toContain("Backend: filesystem");
    expect(output).toContain("Status: ok");
    expect(output).toContain("MigrationStatus:");
  });

  it("reports missing supabase resources in json mode", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "ai-kit-cli-doctor-supabase-"));
    const configPath = path.join(cwd, "ai-kit.config.mjs");
    await writeFile(
      configPath,
      [
        "export default {",
        '  persistence: {',
        '    kind: "supabase",',
        '    url: "https://example.supabase.co",',
        '    serviceRoleKey: "service-role-key",',
        "  }",
        "};",
      ].join("\n"),
      "utf8",
    );

    const client = createDoctorStubClient({
      "public.ai_kit_versions": {
        columns: ["version", "applied_at"],
        rows: [{ version: "20260317000000", applied_at: "2026-03-17T00:00:00.000Z" }],
      },
      "public.ai_kit_conversations": {
        columns: ["id", "app_name", "session_id"],
      },
      "public.ai_kit_conversation_events": false,
      "public.ai_kit_conversation_run_states": false,
      "public.ai_kit_input_history": false,
      "public.ai_kit_usage_entries": true,
      "public.ai_kit_idempotency_records": true,
      "storage.bucket-api": true,
    });

    vi.doMock("../../src/agent/supabase/client.js", async () => {
      const actual = await vi.importActual<typeof import("../../src/agent/supabase/client.js")>(
        "../../src/agent/supabase/client.js",
      );
      return {
        ...actual,
        createSupabaseBackendClient: vi.fn(() => client),
      };
    });

    const { runDoctorCommand } = await import("../../src/cli/commands/doctor.js");
    const output = await runDoctorCommand({ configFile: configPath, json: true });
    const parsed = JSON.parse(output) as {
      ok: boolean;
      checks: Array<{ name: string; ok: boolean }>;
      migrationStatus: Array<{ name: string; ok: boolean }>;
    };

    expect(parsed.ok).toBe(false);
    expect(parsed.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "table:public.ai_kit_versions", ok: true }),
        expect.objectContaining({ name: "table:public.ai_kit_conversations", ok: false }),
        expect.objectContaining({ name: "table:public.ai_kit_conversation_events", ok: false }),
        expect.objectContaining({ name: "table:public.ai_kit_conversation_run_states", ok: false }),
        expect.objectContaining({ name: "table:public.ai_kit_input_history", ok: false }),
      ]),
    );
    expect(parsed.migrationStatus).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "20260317000000", ok: true, detail: "applied" }),
        expect.objectContaining({ name: "20260318000000", ok: false, detail: "pending" }),
        expect.objectContaining({ name: "20260319000000", ok: false, detail: "pending" }),
        expect.objectContaining({ name: "20260416000000", ok: false, detail: "pending" }),
      ]),
    );
  });

  it("reports postgres resources in json mode", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "ai-kit-cli-doctor-pg-"));
    const configPath = path.join(cwd, "ai-kit.config.mjs");
    const fakeSql = createFakePostgresSql();
    fakeSql.markMissingTable("conversation_events");
    fakeSql.markMissingColumn("conversations", "user_id");
    await fakeSql.unsafe('insert into "public"."ai_kit_versions" (version, applied_at) values ($1, now())', [
      "20260317000000",
    ]);
    await writeFile(
      configPath,
      [
        "export default {",
        '  persistence: {',
        '    kind: "postgres",',
        '    connectionString: "postgresql://postgres:secret@example.com:5432/postgres",',
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

    const { runDoctorCommand } = await import("../../src/cli/commands/doctor.js");
    const output = await runDoctorCommand({ configFile: configPath, json: true });
    const parsed = JSON.parse(output) as {
      ok: boolean;
      config: { connectionString: string };
      checks: Array<{ name: string; ok: boolean }>;
      migrationStatus: Array<{ name: string; ok: boolean }>;
    };

    expect(parsed.ok).toBe(false);
    expect(parsed.config.connectionString).toContain(":***@");
    expect(fakeSql.endCalls()).toBeGreaterThanOrEqual(1);
    expect(parsed.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "connectivity", ok: true }),
        expect.objectContaining({ name: "table:public.ai_kit_versions", ok: true }),
        expect.objectContaining({ name: "table:public.ai_kit_conversations", ok: false }),
        expect.objectContaining({ name: "table:public.ai_kit_conversation_events", ok: false }),
        expect.objectContaining({ name: "table:public.ai_kit_conversation_run_states", ok: true }),
        expect.objectContaining({ name: expect.stringContaining("assetDir:"), ok: true }),
      ]),
    );
    expect(parsed.migrationStatus).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "20260317000000", ok: true, detail: "applied" }),
        expect.objectContaining({ name: "20260318000000", ok: false, detail: "pending" }),
        expect.objectContaining({ name: "20260319000000", ok: false, detail: "pending" }),
        expect.objectContaining({ name: "20260416000000", ok: false, detail: "pending" }),
      ]),
    );
  });
});

function createDoctorStubClient(
  availableTables: Record<string, boolean | { columns: string[]; rows?: Array<Record<string, unknown>> }>,
): SupabaseClientLike {
  return {
    from<T = Record<string, unknown>>(table: string): SupabaseQueryLike<T> {
      return new StubQueryBuilder<T>(table, availableTables);
    },
    storage: {
      async getBucket(id: string) {
        if (!availableTables["storage.bucket-api"]) {
          return { data: null, error: { message: "storage api unavailable" } };
        }
        if (id === "ai-kit") {
          return { data: { id }, error: null };
        }
        return { data: null, error: { message: `Bucket not found: ${id}` } };
      },
      from() {
        throw new Error("storage API is not used in doctor tests");
      },
    },
  };
}

class StubQueryBuilder<T extends Record<string, unknown>> implements SupabaseQueryLike<T> {
  private selectedColumns = "*";
  private filters: Array<{ column: string; value: unknown }> = [];

  constructor(
    private readonly table: string,
    private readonly availableTables: Record<string, boolean | { columns: string[]; rows?: Array<Record<string, unknown>> }>,
  ) {}

  select(columns?: string): SupabaseQueryLike<T> {
    this.selectedColumns = columns ?? "*";
    return this;
  }

  insert(_values: T | T[]): SupabaseQueryLike<T> {
    return this;
  }

  upsert(_values: T | T[], _options?: { onConflict?: string; ignoreDuplicates?: boolean }): SupabaseQueryLike<T> {
    return this;
  }

  delete(): SupabaseQueryLike<T> {
    return this;
  }

  eq(column: string, value: unknown): SupabaseQueryLike<T> {
    this.filters.push({ column, value });
    return this;
  }

  order(_column: string, _options?: { ascending?: boolean }): SupabaseQueryLike<T> {
    return this;
  }

  limit(_count: number): SupabaseQueryLike<T> {
    return this;
  }

  single(): SupabaseQueryLike<T> {
    return this;
  }

  maybeSingle(): SupabaseQueryLike<T> {
    return this;
  }

  then<TResult1 = SupabaseQueryResult<T>, TResult2 = never>(
    onfulfilled?: ((value: SupabaseQueryResult<T>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
  }

  private execute(): SupabaseQueryResult<T> {
    const key = `public.${this.table}`;
    const tableValue = this.availableTables[key];
    if (!tableValue) {
      return {
        data: null,
        error: { message: `relation "${key}" does not exist` },
      };
    }

    if (
      tableValue !== true &&
      this.selectedColumns !== "*" &&
      this.selectedColumns.split(",").map((column) => column.trim()).some((column) =>
        !tableValue.columns.includes(column)
      )
    ) {
      const missingColumn = this.selectedColumns
        .split(",")
        .map((column) => column.trim())
        .find((column) => !tableValue.columns.includes(column));
      return {
        data: null,
        error: { message: `column "${missingColumn}" does not exist` },
      };
    }

    return {
      data: (
        tableValue === true
          ? []
          : (tableValue.rows ?? [])
      ) as T[],
      error: null,
    };
  }
}
