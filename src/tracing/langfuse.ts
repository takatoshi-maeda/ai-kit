import { AsyncLocalStorage } from "node:async_hooks";
import type { LLMUsage } from "../types/llm.js";

export interface TracingOptions {
  publicKey?: string;
  secretKey?: string;
  baseUrl?: string;
}

export interface Observation {
  update(data: {
    output?: unknown;
    usage?: LLMUsage;
    metadata?: Record<string, unknown>;
    level?: string;
    statusMessage?: string;
  }): void;
  end(): void;
}

// Minimal shape to avoid importing langfuse at the type level
interface LangfuseClient {
  trace(params: Record<string, unknown>): LangfuseTrace;
}

interface LangfuseTrace {
  id?: string;
  traceId?: string;
  span(params: Record<string, unknown>): LangfuseObservation;
  generation(params: Record<string, unknown>): LangfuseObservation;
}

interface LangfuseObservation {
  id?: string;
  traceId?: string;
  span(params: Record<string, unknown>): LangfuseObservation;
  generation(params: Record<string, unknown>): LangfuseObservation;
  update(params: Record<string, unknown>): void;
  end(): void;
}

const noopObservation: Observation = {
  update() {},
  end() {},
};

let clientPromise: Promise<void> | null = null;
let client: LangfuseClient | null = null;
let autoInitChecked = false;
const contextStorage =
  new AsyncLocalStorage<LangfuseTrace | LangfuseObservation>();
const rawByObservation = new WeakMap<Observation, LangfuseTrace | LangfuseObservation>();

function shouldEnableTracing(
  publicKey?: string,
  secretKey?: string,
): boolean {
  return Boolean(publicKey && secretKey);
}

function maybeAutoInitFromEnv(): void {
  if (clientPromise || autoInitChecked) {
    return;
  }
  autoInitChecked = true;
  if (!shouldEnableTracing(process.env.LANGFUSE_PUBLIC_KEY, process.env.LANGFUSE_SECRET_KEY)) {
    return;
  }
  initTracing();
}

export function initTracing(options?: TracingOptions): void {
  const publicKey = options?.publicKey ?? process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = options?.secretKey ?? process.env.LANGFUSE_SECRET_KEY;
  const baseUrl = options?.baseUrl ?? process.env.LANGFUSE_BASE_URL;
  autoInitChecked = true;

  if (!shouldEnableTracing(publicKey, secretKey)) {
    client = null;
    clientPromise = Promise.resolve();
    return;
  }

  clientPromise = import("langfuse")
    .then((mod) => {
      const Ctor = mod.Langfuse ?? mod.default;
      client = new Ctor({ publicKey, secretKey, baseUrl }) as LangfuseClient;
    })
    .catch(() => {
      client = null;
    });
}

export async function startObservation(
  name: string,
  options: {
    type?: "span" | "generation";
    input?: unknown;
    metadata?: Record<string, unknown>;
    model?: string;
  },
): Promise<Observation> {
  maybeAutoInitFromEnv();

  if (clientPromise) {
    await clientPromise;
  }

  if (!client) {
    return noopObservation;
  }

  const obsType = options.type ?? "span";
  const params: Record<string, unknown> = {
    name,
    input: options.input,
    metadata: options.metadata,
  };
  if (options.model) params.model = options.model;

  const parent = contextStorage.getStore();
  const raw = (() => {
    if (parent) {
      return obsType === "generation"
        ? parent.generation(params)
        : parent.span(params);
    }
    const trace = client.trace({
      name,
      input: options.input,
      metadata: options.metadata,
    });
    return obsType === "generation"
      ? trace.generation(params)
      : trace.span(params);
  })();

  const wrapped: Observation = {
    update(data) {
      const payload: Record<string, unknown> = {};
      if (data.output !== undefined) payload.output = data.output;
      if (data.metadata !== undefined) payload.metadata = data.metadata;
      if (data.level !== undefined) payload.level = data.level;
      if (data.statusMessage !== undefined) {
        payload.statusMessage = data.statusMessage;
      }
      if (data.usage) {
        payload.usage = {
          input: data.usage.inputTokens,
          output: data.usage.outputTokens,
          total: data.usage.totalTokens,
          inputCost: data.usage.inputCost,
          outputCost: data.usage.outputCost,
          totalCost: data.usage.totalCost,
        };
      }
      raw.update(payload);
    },
    end() {
      raw.end();
    },
  };
  rawByObservation.set(wrapped, raw);
  return wrapped;
}

export function runWithObservationContext<T>(
  observation: Observation,
  fn: () => T,
): T {
  const raw = rawByObservation.get(observation);
  if (!raw) {
    return fn();
  }
  return contextStorage.run(raw, fn);
}

export async function withObservation<T>(
  name: string,
  options: {
    type?: "span" | "generation";
    input?: unknown;
    metadata?: Record<string, unknown>;
    model?: string;
  },
  fn: (observation: Observation) => Promise<T>,
): Promise<T> {
  const observation = await startObservation(name, options);

  try {
    const result = await runWithObservationContext(
      observation,
      () => fn(observation),
    );
    observation.end();
    return result;
  } catch (error) {
    observation.update({
      level: "ERROR",
      statusMessage:
        error instanceof Error ? error.message : String(error),
    });
    observation.end();
    throw error;
  }
}
