import { AiKitError } from "../errors.js";
import { AuthError, createAuthBackend } from "../auth/index.js";
import type { MountableHonoApp } from "./index.js";
import type { MountSpeechRoutesOptions } from "../speech/types.js";

export async function mountSpeechRoutes(
  app: MountableHonoApp,
  options: MountSpeechRoutesOptions,
): Promise<void> {
  const basePath = options.basePath ?? "/api/speech";
  const authBackend = createAuthBackend(options.auth ?? { kind: "none" });

  app.post(`${basePath}/transcriptions`, async (c) => {
    try {
      await authBackend.authenticateRequest({ headers: c.req.raw.headers });
      const formData = await c.req.formData();
      const asyncFlag = parseBooleanLike(formData.get("async"));
      const file = formData.get("file");
      if (!(file instanceof File)) {
        return c.json({ error: "multipart field `file` is required" }, 400);
      }

      const bytes = new Uint8Array(await file.arrayBuffer());
      const input = {
        audio: {
          mimeType: file.type || "application/octet-stream",
          fileName: file.name || "audio.bin",
          bytes,
        },
        prompt: readStringField(formData.get("prompt")),
        language: readStringField(formData.get("language")),
        temperature: readNumberField(formData.get("temperature")),
        responseFormat: readResponseFormat(formData.get("responseFormat")),
        sessionId: readStringField(formData.get("sessionId")),
      } as const;

      const record = asyncFlag
        ? await options.service.createJob(input)
        : await options.service.transcribe(input);
      const statusCode = asyncFlag ? 202 : record.status === "completed" ? 200 : 502;
      return c.json(record, statusCode);
    } catch (error) {
      return toErrorResponse(c, error);
    }
  });

  app.get(`${basePath}/transcriptions/:id`, async (c) => {
    try {
      await authBackend.authenticateRequest({ headers: c.req.raw.headers });
      const record = await options.service.getJob(c.req.param("id"));
      if (!record) {
        return c.json({ error: "transcription not found" }, 404);
      }
      return c.json(record);
    } catch (error) {
      return toErrorResponse(c, error);
    }
  });
}

function readStringField(value: FormDataEntryValue | null): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readNumberField(value: FormDataEntryValue | null): number | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readResponseFormat(
  value: FormDataEntryValue | null,
): "text" | "json" | undefined {
  return value === "text" || value === "json" ? value : undefined;
}

function parseBooleanLike(value: FormDataEntryValue | null): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function toErrorResponse(c: any, error: unknown): Response {
  if (error instanceof AuthError) {
    return c.json({ error: error.message }, error.status, {
      "WWW-Authenticate": error.wwwAuthenticate,
    });
  }
  if (error instanceof AiKitError) {
    return c.json({ error: error.message }, 400);
  }
  if (error instanceof Error) {
    return c.json({ error: error.message }, 500);
  }
  return c.json({ error: String(error) }, 500);
}
