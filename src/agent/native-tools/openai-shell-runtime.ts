import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { LLMToolCall, LLMToolResult, OpenAINativeShellTool } from "../../types/tool.js";

const execFileAsync = promisify(execFile);

export async function executeOpenAIShellToolCall(
  toolCall: LLMToolCall,
  tool: OpenAINativeShellTool,
): Promise<LLMToolResult> {
  const action = normalizeShellAction(toolCall.arguments);
  const commands = action.commands;

  if (commands.length === 0) {
    return createShellError(toolCall.id, "Shell call did not include any commands.");
  }

  for (const command of commands) {
    const blockedReason = validateCommandPolicy(command, tool);
    if (blockedReason) {
      return createShellError(toolCall.id, blockedReason);
    }
  }

  const timeoutMs = action.timeoutMs ?? tool.timeoutMs;
  const maxOutputLength = action.maxOutputLength;
  const output = await Promise.all(commands.map((command) => executeCommand(command, tool, timeoutMs)));
  const content = JSON.stringify(output);

  return {
    toolCallId: toolCall.id,
    content,
    isError: output.some((entry) => entry.outcome.type === "timeout" || (entry.outcome.type === "exit" && entry.outcome.exit_code !== 0)),
    extra: {
      providerRaw: {
        provider: "openai",
        inputItems: [
          {
            type: "shell_call_output",
            call_id: toolCall.id,
            ...(typeof maxOutputLength === "number" ? { max_output_length: maxOutputLength } : {}),
            output,
          },
        ],
      },
      commandCount: commands.length,
      timeoutMs,
    },
  };
}

async function executeCommand(
  command: string,
  tool: OpenAINativeShellTool,
  timeoutMs: number,
): Promise<{
  stdout: string;
  stderr: string;
  outcome: { type: "exit"; exit_code: number } | { type: "timeout" };
}> {
  try {
    const result = await execFileAsync("bash", ["-lc", command], {
      cwd: tool.workingDir,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      env: tool.inheritEnv === false ? {} : process.env,
    });
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      outcome: { type: "exit", exit_code: 0 },
    };
  } catch (error) {
    const asRecord = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: string | number;
      signal?: string;
      killed?: boolean;
    };
    if (asRecord.killed || asRecord.signal === "SIGTERM" || asRecord.code === "ETIMEDOUT") {
      return {
        stdout: asRecord.stdout ?? "",
        stderr: asRecord.stderr ?? "",
        outcome: { type: "timeout" },
      };
    }
    return {
      stdout: asRecord.stdout ?? "",
      stderr: asRecord.stderr ?? (error instanceof Error ? error.message : String(error)),
      outcome: {
        type: "exit",
        exit_code: typeof asRecord.code === "number" ? asRecord.code : 1,
      },
    };
  }
}

function normalizeShellAction(argumentsValue: Record<string, unknown>): {
  commands: string[];
  timeoutMs?: number;
  maxOutputLength?: number;
} {
  const action = isRecord(argumentsValue.action) ? argumentsValue.action : argumentsValue;
  const commands = Array.isArray(action.commands)
    ? action.commands.filter((value): value is string => typeof value === "string")
    : typeof action.command === "string"
      ? [action.command]
      : [];

  return {
    commands,
    timeoutMs: typeof action.timeout_ms === "number"
      ? action.timeout_ms
      : typeof action.timeoutMs === "number"
        ? action.timeoutMs
        : undefined,
    maxOutputLength: typeof action.max_output_length === "number"
      ? action.max_output_length
      : typeof action.maxOutputLength === "number"
        ? action.maxOutputLength
        : undefined,
  };
}

function validateCommandPolicy(
  command: string,
  tool: OpenAINativeShellTool,
): string | null {
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    return "Shell command must not be empty.";
  }

  const executable = trimmed.split(/\s+/, 1)[0] ?? "";
  if (tool.allowedCommands && !tool.allowedCommands.includes(executable)) {
    return `Shell command is not allowed by policy: ${executable}`;
  }
  if (tool.blockedCommands?.includes(executable)) {
    return `Shell command is blocked by policy: ${executable}`;
  }
  return null;
}

function createShellError(toolCallId: string, message: string): LLMToolResult {
  return {
    toolCallId,
    content: message,
    isError: true,
    extra: {
      providerRaw: {
        provider: "openai",
        inputItems: [
          {
            type: "shell_call_output",
            call_id: toolCallId,
            output: [
              {
                stdout: "",
                stderr: message,
                outcome: { type: "exit", exit_code: 1 },
              },
            ],
          },
        ],
      },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
