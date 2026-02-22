export class AiKitError extends Error {
  constructor(message: string, options?: { cause?: Error }) {
    super(message, options);
    this.name = "AiKitError";
  }
}

export class LLMApiError extends AiKitError {
  readonly statusCode?: number;
  readonly provider: string;

  constructor(
    message: string,
    options: { provider: string; statusCode?: number; cause?: Error },
  ) {
    super(message, { cause: options.cause });
    this.name = "LLMApiError";
    this.provider = options.provider;
    this.statusCode = options.statusCode;
  }
}

export class RateLimitError extends LLMApiError {
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    options: {
      provider: string;
      statusCode?: number;
      retryAfterMs?: number;
      cause?: Error;
    },
  ) {
    super(message, options);
    this.name = "RateLimitError";
    this.retryAfterMs = options.retryAfterMs;
  }
}

export class ContextLengthExceededError extends LLMApiError {
  constructor(
    message: string,
    options: { provider: string; statusCode?: number; cause?: Error },
  ) {
    super(message, options);
    this.name = "ContextLengthExceededError";
  }
}

export class ToolExecutionError extends AiKitError {
  readonly toolName: string;

  constructor(
    message: string,
    options: { toolName: string; cause?: Error },
  ) {
    super(message, { cause: options.cause });
    this.name = "ToolExecutionError";
    this.toolName = options.toolName;
  }
}

export class MaxTurnsExceededError extends AiKitError {
  readonly maxTurns: number;
  readonly completedTurns: number;

  constructor(
    message: string,
    options: { maxTurns: number; completedTurns: number },
  ) {
    super(message);
    this.name = "MaxTurnsExceededError";
    this.maxTurns = options.maxTurns;
    this.completedTurns = options.completedTurns;
  }
}
