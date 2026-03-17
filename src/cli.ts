#!/usr/bin/env node

import { runDoctorCommand } from "./cli/commands/doctor.js";
import { runSetupCommand } from "./cli/commands/setup.js";
import type { CliGlobalOptions, DoctorCommandOptions, SetupCommandOptions } from "./cli/shared.js";

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  try {
    switch (command) {
      case "setup": {
        const options = parseSetupOptions(rest);
        process.stdout.write(`${await runSetupCommand(options)}\n`);
        return 0;
      }
      case "doctor": {
        const options = parseDoctorOptions(rest);
        process.stdout.write(`${await runDoctorCommand(options)}\n`);
        return 0;
      }
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

void main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});

function parseSetupOptions(args: string[]): SetupCommandOptions {
  const parsed = parseCommonOptions(args);
  return {
    ...parsed,
    debug: parsed.flags.has("debug") || process.env.AI_KIT_DEBUG === "1",
    local: parsed.flags.has("local"),
    schema: parsed.named.schema,
    tablePrefix: parsed.named["table-prefix"],
    bucket: parsed.named.bucket,
    dbUrl: parsed.named["db-url"],
  };
}

function parseDoctorOptions(args: string[]): DoctorCommandOptions {
  const parsed = parseCommonOptions(args);
  return {
    ...parsed,
    debug: parsed.flags.has("debug") || process.env.AI_KIT_DEBUG === "1",
    schema: parsed.named.schema,
    tablePrefix: parsed.named["table-prefix"],
    bucket: parsed.named.bucket,
    json: parsed.flags.has("json"),
  };
}

function parseCommonOptions(args: string[]): CliGlobalOptions & {
  named: Record<string, string | undefined>;
  flags: Set<string>;
} {
  const named: Record<string, string | undefined> = {};
  const flags = new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index] ?? "";
    if (!current.startsWith("--")) {
      throw new Error(`Unexpected argument: ${current}`);
    }

    if (current === "--help") {
      throw new Error(usage());
    }

    const key = current.slice(2);
    const next = args[index + 1];
    if (!next || next.startsWith("--")) {
      flags.add(key);
      continue;
    }

    named[key] = next;
    index += 1;
  }

  return {
    cwd: named.cwd,
    configFile: named.config,
    named,
    flags,
  };
}

function usage(): string {
  return [
    "Usage:",
    "  ai-kit setup [--cwd <path>] [--config <path>] [--schema <name>] [--table-prefix <prefix>] [--bucket <name>] [--db-url <postgres-url>] [--local] [--debug]",
    "  ai-kit doctor [--cwd <path>] [--config <path>] [--schema <name>] [--table-prefix <prefix>] [--bucket <name>] [--json] [--debug]",
  ].join("\n");
}
