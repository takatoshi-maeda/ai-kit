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
  }): void;
  end(): void;
}

// Minimal shape to avoid importing langfuse at the type level
interface LangfuseClient {
  trace(params: Record<string, unknown>): LangfuseTrace;
}

interface LangfuseTrace {
  span(params: Record<string, unknown>): LangfuseObservation;
  generation(params: Record<string, unknown>): LangfuseObservation;
}

interface LangfuseObservation {
  update(params: Record<string, unknown>): void;
  end(): void;
}

const noopObservation: Observation = {
  update() {},
  end() {},
};

let clientPromise: Promise<void> | null = null;
let client: LangfuseClient | null = null;

export function initTracing(options?: TracingOptions): void {
  const publicKey = options?.publicKey ?? process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = options?.secretKey ?? process.env.LANGFUSE_SECRET_KEY;
  const baseUrl = options?.baseUrl ?? process.env.LANGFUSE_BASE_URL;

  clientPromise = import("langfuse")
    .then((mod) => {
      const Ctor = mod.Langfuse ?? mod.default;
      client = new Ctor({ publicKey, secretKey, baseUrl }) as LangfuseClient;
    })
    .catch(() => {
      client = null;
    });
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
  if (clientPromise) {
    await clientPromise;
  }

  if (!client) {
    return fn(noopObservation);
  }

  const trace = client.trace({
    name,
    input: options.input,
    metadata: options.metadata,
  });

  const obsType = options.type ?? "span";
  const params: Record<string, unknown> = {
    name,
    input: options.input,
    metadata: options.metadata,
  };
  if (options.model) params.model = options.model;

  const raw =
    obsType === "generation"
      ? trace.generation(params)
      : trace.span(params);

  const observation: Observation = {
    update(data) {
      const payload: Record<string, unknown> = {};
      if (data.output !== undefined) payload.output = data.output;
      if (data.metadata !== undefined) payload.metadata = data.metadata;
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

  try {
    const result = await fn(observation);
    observation.end();
    return result;
  } catch (error) {
    raw.update({
      level: "ERROR",
      statusMessage:
        error instanceof Error ? error.message : String(error),
    });
    observation.end();
    throw error;
  }
}
