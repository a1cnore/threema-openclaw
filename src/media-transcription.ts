const DEFAULT_TRANSCRIPTION_URL = "https://api.openai.com/v1/audio/transcriptions";
const DEFAULT_TRANSCRIPTION_MODEL = "whisper-1";
const DEFAULT_TIMEOUT_MS = 45_000;

export interface TranscribeAudioBytesParams {
  bytes: Uint8Array;
  mediaType: string;
  fileName?: string;
  model?: string;
  language?: string;
  prompt?: string;
  timeoutMs?: number;
  apiKey?: string;
}

export interface AudioTranscriptionResult {
  text: string;
  model: string;
  language?: string;
}

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function resolveTranscriptionModel(explicitModel?: string): string {
  const fromArgs = explicitModel?.trim();
  if (fromArgs) {
    return fromArgs;
  }
  const fromEnv = process.env.THREEMA_TRANSCRIBE_MODEL?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return DEFAULT_TRANSCRIPTION_MODEL;
}

function resolveTranscriptionUrl(): string {
  const fromEnv = process.env.THREEMA_TRANSCRIBE_URL?.trim();
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv;
  }
  return DEFAULT_TRANSCRIPTION_URL;
}

function resolveApiKey(explicitKey?: string): string | null {
  const key = explicitKey?.trim() || process.env.OPENAI_API_KEY?.trim();
  if (!key) {
    return null;
  }
  return key;
}

function resolveTimeout(explicitTimeoutMs?: number): number {
  if (
    typeof explicitTimeoutMs === "number"
    && Number.isFinite(explicitTimeoutMs)
    && explicitTimeoutMs > 0
  ) {
    return Math.floor(explicitTimeoutMs);
  }
  return parsePositiveIntEnv("THREEMA_TRANSCRIBE_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
}

export async function transcribeAudioBytes(
  params: TranscribeAudioBytesParams,
): Promise<AudioTranscriptionResult | null> {
  if (!params.bytes || params.bytes.length === 0) {
    throw new Error("Audio transcription payload is empty");
  }

  const apiKey = resolveApiKey(params.apiKey);
  if (!apiKey) {
    return null;
  }

  const url = resolveTranscriptionUrl();
  const model = resolveTranscriptionModel(params.model);
  const timeoutMs = resolveTimeout(params.timeoutMs);
  const fileName = (params.fileName?.trim() || "voice-memo").replace(/\s+/g, "_");
  const mediaType = params.mediaType?.trim() || "application/octet-stream";

  const form = new FormData();
  form.append(
    "file",
    new Blob([Buffer.from(params.bytes)], { type: mediaType }),
    fileName,
  );
  form.append("model", model);
  if (params.language && params.language.trim().length > 0) {
    form.append("language", params.language.trim());
  }
  if (params.prompt && params.prompt.trim().length > 0) {
    form.append("prompt", params.prompt.trim());
  }

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: form,
      signal: abortController.signal,
    });
  } catch (err) {
    throw new Error(`Audio transcription request failed: ${String(err)}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Audio transcription failed: status=${response.status} body=${body}`);
  }

  const parsed = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
  if (!text) {
    return null;
  }

  return {
    text,
    model: typeof parsed.model === "string" && parsed.model.trim().length > 0
      ? parsed.model
      : model,
    language: typeof parsed.language === "string" && parsed.language.trim().length > 0
      ? parsed.language
      : undefined,
  };
}
