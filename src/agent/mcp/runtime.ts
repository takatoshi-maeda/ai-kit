import { AiKitError } from "../../errors.js";
import type {
  AgentReasoningEffort,
  AgentRuntimePolicy,
  AgentRuntimeSettings,
  AgentVerbosity,
  ResolvedAgentRuntime,
} from "../../types/runtime.js";

const SUPPORTED_RUNTIME_PROVIDERS = new Set(["openai"]);

export class AgentRuntimeValidationError extends AiKitError {
  constructor(message: string) {
    super(message);
    this.name = "AgentRuntimeValidationError";
  }
}

export function hasRequestedRuntime(
  runtime?: AgentRuntimeSettings,
): boolean {
  return runtime !== undefined &&
    (runtime.model !== undefined ||
      runtime.reasoningEffort !== undefined ||
      runtime.verbosity !== undefined);
}

export function resolveAgentRuntime(
  policy: AgentRuntimePolicy | undefined,
  runtime?: AgentRuntimeSettings,
): ResolvedAgentRuntime | undefined {
  if (!policy) {
    if (hasRequestedRuntime(runtime)) {
      throw new AgentRuntimeValidationError(
        "runtime overrides are not enabled for this agent",
      );
    }
    return undefined;
  }

  if (
    hasRequestedRuntime(runtime) &&
    !SUPPORTED_RUNTIME_PROVIDERS.has(policy.provider)
  ) {
    throw new AgentRuntimeValidationError(
      `runtime overrides are not implemented for provider "${policy.provider}"`,
    );
  }

  const resolved: ResolvedAgentRuntime = {
    model: runtime?.model ?? policy.defaults.model,
    reasoningEffort: runtime?.reasoningEffort ?? policy.defaults.reasoningEffort,
    verbosity: runtime?.verbosity ?? policy.defaults.verbosity,
  };

  validateAllowedModel(policy.allowedModels, resolved.model);
  validateAllowedEnum(
    "reasoningEffort",
    policy.allowedReasoningEfforts,
    resolved.reasoningEffort,
  );
  validateAllowedEnum(
    "verbosity",
    policy.allowedVerbosity,
    resolved.verbosity,
  );

  return resolved;
}

function validateAllowedModel(
  allowedModels: string[] | undefined,
  model: string,
): void {
  if (!allowedModels || allowedModels.length === 0) {
    return;
  }
  if (!allowedModels.includes(model)) {
    throw new AgentRuntimeValidationError(
      `model "${model}" is not allowed for this agent`,
    );
  }
}

function validateAllowedEnum<T extends AgentReasoningEffort | AgentVerbosity>(
  field: string,
  allowedValues: T[] | undefined,
  value: T | undefined,
): void {
  if (value === undefined || !allowedValues || allowedValues.length === 0) {
    return;
  }
  if (!allowedValues.includes(value)) {
    throw new AgentRuntimeValidationError(
      `${field} "${value}" is not allowed for this agent`,
    );
  }
}
