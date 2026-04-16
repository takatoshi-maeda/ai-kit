import {
  createPartFromUri,
  createUserContent,
  GoogleGenAI,
} from "@google/genai";
import type {
  CreateSpeechClientOptions,
  SpeechClient,
  SpeechTranscriptionResult,
  TranscribeInput,
} from "../types.js";
import { LLMApiError, RateLimitError } from "../../errors.js";
import { resolveGoogleClientOptions } from "../../google/client-options.js";

export class GoogleSpeechClient implements SpeechClient {
  readonly provider = "google" as const;
  readonly model: string;

  private readonly client: GoogleGenAI;

  constructor(options: CreateSpeechClientOptions) {
    this.model = options.model;
    this.client = new GoogleGenAI(buildClientOptions(options));
  }

  async transcribe(input: TranscribeInput): Promise<SpeechTranscriptionResult> {
    const file = await this.client.files.upload({
      file: new File([Buffer.from(input.audio.bytes)], input.audio.fileName, {
        type: input.audio.mimeType,
      }),
      config: {
        mimeType: input.audio.mimeType,
        displayName: input.audio.fileName,
      },
    });

    try {
      const response = await this.client.models.generateContent({
        model: this.model,
        contents: createUserContent([
          createPartFromUri(file.uri ?? "", file.mimeType ?? input.audio.mimeType),
          buildPrompt(input),
        ]),
      });

      return {
        text: response.text ?? "",
        provider: "google",
        model: this.model,
        raw: {
          responseId: response.responseId,
          modelVersion: response.modelVersion,
          usageMetadata: response.usageMetadata,
        },
        usage: response.usageMetadata
          ? { ...response.usageMetadata }
          : undefined,
      };
    } catch (error) {
      throw mapGoogleError(error);
    } finally {
      if (file.name) {
        await this.client.files.delete({ name: file.name }).catch(() => undefined);
      }
    }
  }
}

function buildClientOptions(options: CreateSpeechClientOptions) {
  return resolveGoogleClientOptions(options);
}

function buildPrompt(input: TranscribeInput): string {
  const instructions = [
    "Generate a verbatim transcript of the spoken audio.",
    "Return only the transcript text without commentary or formatting.",
  ];

  if (input.language) {
    instructions.push(`The expected spoken language is ${input.language}.`);
  }
  if (input.prompt) {
    instructions.push(input.prompt);
  }

  return instructions.join("\n");
}

function mapGoogleError(error: unknown): Error {
  if (isRateLimitError(error)) {
    return new RateLimitError(
      getErrorMessage(error),
      { provider: "google", cause: error instanceof Error ? error : undefined },
    );
  }
  if (error instanceof Error) {
    return new LLMApiError(error.message, {
      provider: "google",
      cause: error,
    });
  }
  return new Error(String(error));
}

function isRateLimitError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return message.includes("rate limit") || message.includes("resource exhausted");
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
