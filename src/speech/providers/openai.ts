import OpenAI from "openai";
import type {
  TranscriptionCreateResponse,
  TranscriptionSegment,
  TranscriptionVerbose,
} from "openai/resources/audio/transcriptions";
import { AiKitError, LLMApiError, RateLimitError } from "../../errors.js";
import type {
  CreateSpeechClientOptions,
  SpeechClient,
  SpeechTranscriptionResult,
  TranscribeInput,
} from "../types.js";

const OPENAI_MAX_AUDIO_FILE_BYTES = 25 * 1024 * 1024;

export class OpenAISpeechClient implements SpeechClient {
  readonly provider = "openai" as const;
  readonly model: string;

  private readonly client: OpenAI;

  constructor(options: CreateSpeechClientOptions) {
    this.model = options.model;
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseUrl,
      organization: options.organization,
      timeout: options.requestTimeout,
    });
  }

  async transcribe(input: TranscribeInput): Promise<SpeechTranscriptionResult> {
    if (input.audio.bytes.byteLength > OPENAI_MAX_AUDIO_FILE_BYTES) {
      throw new AiKitError(
        `audio file exceeds OpenAI limit of ${OPENAI_MAX_AUDIO_FILE_BYTES} bytes`,
      );
    }

    try {
      const response = await this.client.audio.transcriptions.create({
        file: new File([Buffer.from(input.audio.bytes)], input.audio.fileName, {
          type: input.audio.mimeType,
        }),
        model: this.model,
        language: input.language,
        prompt: input.prompt,
        temperature: input.temperature,
        response_format: "verbose_json",
        timestamp_granularities: ["segment"],
      });

      return mapOpenAIResponse(this.model, response);
    } catch (error) {
      throw mapOpenAIError(error);
    }
  }
}

function mapOpenAIResponse(
  model: string,
  response: TranscriptionCreateResponse,
): SpeechTranscriptionResult {
  const verbose = response as Partial<TranscriptionVerbose>;
  return {
    text: response.text,
    language: typeof verbose.language === "string" ? verbose.language : undefined,
    durationMs: typeof verbose.duration === "number"
      ? Math.round(verbose.duration * 1000)
      : undefined,
    segments: Array.isArray(verbose.segments)
      ? verbose.segments.map(mapSegment)
      : undefined,
    provider: "openai",
    model,
    raw: {
      text: response.text,
      language: verbose.language,
      duration: verbose.duration,
      segments: verbose.segments,
    },
  };
}

function mapSegment(segment: TranscriptionSegment) {
  return {
    id: String(segment.id),
    startMs: Math.round(segment.start * 1000),
    endMs: Math.round(segment.end * 1000),
    text: segment.text,
  };
}

function mapOpenAIError(error: unknown): Error {
  if (error instanceof OpenAI.RateLimitError) {
    return new RateLimitError(
      error.message,
      { provider: "openai", statusCode: error.status, cause: error },
    );
  }
  if (error instanceof OpenAI.APIError) {
    return new LLMApiError(
      error.message,
      { provider: "openai", statusCode: error.status, cause: error },
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}
