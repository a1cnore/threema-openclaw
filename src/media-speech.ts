import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const DEFAULT_SPEECH_URL = "https://api.openai.com/v1/audio/speech";
const DEFAULT_SPEECH_MODEL = "gpt-4o-mini-tts";
const DEFAULT_SPEECH_FALLBACK_MODEL = "tts-1";
const DEFAULT_SPEECH_VOICE = "alloy";
const DEFAULT_SPEECH_FORMAT = "wav";
const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_VOICE_REPLY_FORCE_NATIVE = true;
const DEFAULT_VOICE_REPLY_FFMPEG_PATH = "ffmpeg";

export type SpeechAudioFormat = "wav" | "mp3" | "opus" | "aac" | "flac" | "pcm";

export interface SynthesizeSpeechToAudioMemoParams {
  text: string;
  model?: string;
  fallbackModel?: string;
  voice?: string;
  format?: SpeechAudioFormat;
  requireNativeVoiceMemoFormat?: boolean;
  speed?: number;
  timeoutMs?: number;
  apiKey?: string;
  fileName?: string;
}

export interface SynthesizedAudioMemo {
  bytes: Uint8Array;
  mediaType: string;
  fileName: string;
  durationSeconds?: number;
  model: string;
  voice: string;
  format: SpeechAudioFormat;
}

export interface NormalizeAudioMemoForThreemaParams {
  bytes: Uint8Array | ArrayBufferLike;
  mediaType: string;
  fileName?: string;
  durationSeconds?: number;
  forceM4a?: boolean;
}

export interface NormalizedAudioMemoForThreema {
  bytes: Uint8Array;
  mediaType: string;
  fileName: string;
  durationSeconds?: number;
  transcoded: boolean;
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

function parseBooleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function resolveApiKey(explicitKey?: string): string | null {
  const key = explicitKey?.trim() || process.env.OPENAI_API_KEY?.trim();
  if (!key) {
    return null;
  }
  return key;
}

function resolveSpeechUrl(): string {
  const fromEnv = process.env.THREEMA_VOICE_REPLY_URL?.trim();
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv;
  }
  return DEFAULT_SPEECH_URL;
}

function shouldForceNativeVoiceMemoFormat(): boolean {
  return parseBooleanEnv("THREEMA_VOICE_REPLY_FORCE_NATIVE", DEFAULT_VOICE_REPLY_FORCE_NATIVE);
}

function resolveRequireNativeVoiceMemoFormat(
  explicitRequireNativeVoiceMemoFormat?: boolean,
): boolean {
  if (typeof explicitRequireNativeVoiceMemoFormat === "boolean") {
    return explicitRequireNativeVoiceMemoFormat;
  }
  return shouldForceNativeVoiceMemoFormat();
}

function resolveFfmpegPath(): string {
  const fromEnv = process.env.THREEMA_VOICE_REPLY_FFMPEG_PATH?.trim();
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv;
  }
  return DEFAULT_VOICE_REPLY_FFMPEG_PATH;
}

function resolveSpeechModel(explicitModel?: string): string {
  const fromArgs = explicitModel?.trim();
  if (fromArgs) {
    return fromArgs;
  }
  const fromEnv = process.env.THREEMA_VOICE_REPLY_MODEL?.trim();
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv;
  }
  return DEFAULT_SPEECH_MODEL;
}

function resolveSpeechFallbackModel(explicitModel?: string): string {
  const fromArgs = explicitModel?.trim();
  if (fromArgs) {
    return fromArgs;
  }
  const fromEnv = process.env.THREEMA_VOICE_REPLY_MODEL_FALLBACK?.trim();
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv;
  }
  return DEFAULT_SPEECH_FALLBACK_MODEL;
}

function resolveSpeechVoice(explicitVoice?: string): string {
  const fromArgs = explicitVoice?.trim();
  if (fromArgs) {
    return fromArgs;
  }
  const fromEnv = process.env.THREEMA_VOICE_REPLY_VOICE?.trim();
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv;
  }
  return DEFAULT_SPEECH_VOICE;
}

function normalizeSpeechFormat(raw: string | undefined): SpeechAudioFormat {
  const normalized = raw?.trim().toLowerCase();
  switch (normalized) {
    case "wav":
    case "mp3":
    case "opus":
    case "aac":
    case "flac":
    case "pcm":
      return normalized;
    default:
      return DEFAULT_SPEECH_FORMAT;
  }
}

function resolveSpeechFormat(explicitFormat?: SpeechAudioFormat): SpeechAudioFormat {
  if (explicitFormat) {
    return explicitFormat;
  }
  return normalizeSpeechFormat(process.env.THREEMA_VOICE_REPLY_FORMAT);
}

function resolveTimeout(explicitTimeoutMs?: number): number {
  if (
    typeof explicitTimeoutMs === "number"
    && Number.isFinite(explicitTimeoutMs)
    && explicitTimeoutMs > 0
  ) {
    return Math.floor(explicitTimeoutMs);
  }
  return parsePositiveIntEnv("THREEMA_VOICE_REPLY_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
}

function resolveSpeed(explicitSpeed?: number): number | undefined {
  if (typeof explicitSpeed === "number" && Number.isFinite(explicitSpeed) && explicitSpeed > 0) {
    return explicitSpeed;
  }
  const fromEnv = process.env.THREEMA_VOICE_REPLY_SPEED;
  if (!fromEnv) {
    return undefined;
  }
  const parsed = Number(fromEnv);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

function mapFormatToMediaType(format: SpeechAudioFormat): string {
  switch (format) {
    case "wav":
      return "audio/wav";
    case "mp3":
      return "audio/mpeg";
    case "opus":
      return "audio/opus";
    case "aac":
      return "audio/aac";
    case "flac":
      return "audio/flac";
    case "pcm":
      return "audio/L16";
    default:
      return "audio/wav";
  }
}

function mapMediaTypeToExtension(mediaType: string): string {
  switch (mediaType.trim().toLowerCase()) {
    case "audio/wav":
    case "audio/x-wav":
      return ".wav";
    case "audio/mpeg":
      return ".mp3";
    case "audio/mp4":
      return ".m4a";
    case "audio/ogg":
      return ".ogg";
    case "audio/opus":
      return ".opus";
    case "audio/aac":
      return ".aac";
    case "audio/flac":
      return ".flac";
    case "audio/l16":
      return ".pcm";
    default:
      return ".bin";
  }
}

function mapFormatToExtension(format: SpeechAudioFormat): string {
  switch (format) {
    case "wav":
      return ".wav";
    case "mp3":
      return ".mp3";
    case "opus":
      return ".opus";
    case "aac":
      return ".aac";
    case "flac":
      return ".flac";
    case "pcm":
      return ".pcm";
    default:
      return ".wav";
  }
}

function ensureFileName(fileName: string | undefined, format: SpeechAudioFormat): string {
  const raw = fileName?.trim();
  if (!raw) {
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
    return `voice-reply-${stamp}${mapFormatToExtension(format)}`;
  }
  if (raw.includes(".")) {
    return raw;
  }
  return `${raw}${mapFormatToExtension(format)}`;
}

function ensureM4aFileName(fileName: string): string {
  const ext = path.extname(fileName);
  const base = path.basename(fileName, ext).trim() || "voice-reply";
  return `${base}.m4a`;
}

function ensureAudioFileName(fileName: string | undefined, mediaType: string): string {
  const trimmed = fileName?.trim();
  if (trimmed && trimmed.length > 0) {
    return trimmed;
  }
  const ext = mapMediaTypeToExtension(mediaType);
  if (ext === ".bin") {
    return "audio";
  }
  return `audio${ext}`;
}

function parseWavDurationSeconds(bytes: Uint8Array): number | undefined {
  if (bytes.length < 44) {
    return undefined;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const riff = String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0, bytes[2] ?? 0, bytes[3] ?? 0);
  const wave = String.fromCharCode(bytes[8] ?? 0, bytes[9] ?? 0, bytes[10] ?? 0, bytes[11] ?? 0);
  if (riff !== "RIFF" || wave !== "WAVE") {
    return undefined;
  }

  let offset = 12;
  let sampleRate: number | null = null;
  let channels: number | null = null;
  let bitsPerSample: number | null = null;
  let dataSize: number | null = null;

  while (offset + 8 <= bytes.length) {
    const chunkId = String.fromCharCode(
      bytes[offset] ?? 0,
      bytes[offset + 1] ?? 0,
      bytes[offset + 2] ?? 0,
      bytes[offset + 3] ?? 0,
    );
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkDataStart = offset + 8;

    if (chunkId === "fmt " && chunkSize >= 16 && chunkDataStart + 16 <= bytes.length) {
      channels = view.getUint16(chunkDataStart + 2, true);
      sampleRate = view.getUint32(chunkDataStart + 4, true);
      bitsPerSample = view.getUint16(chunkDataStart + 14, true);
    } else if (chunkId === "data") {
      dataSize = chunkSize;
      break;
    }

    offset = chunkDataStart + chunkSize + (chunkSize % 2);
  }

  if (!sampleRate || !channels || !bitsPerSample || !dataSize) {
    return undefined;
  }
  const bytesPerSecond = sampleRate * channels * (bitsPerSample / 8);
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
    return undefined;
  }
  return dataSize / bytesPerSecond;
}

let ffmpegAvailabilityCache: { path: string; available: boolean } | null = null;

function checkFfmpegAvailability(ffmpegPath: string): boolean {
  if (ffmpegAvailabilityCache && ffmpegAvailabilityCache.path === ffmpegPath) {
    return ffmpegAvailabilityCache.available;
  }
  const probe = spawnSync(ffmpegPath, ["-version"], { stdio: "ignore" });
  const available = !probe.error && probe.status === 0;
  ffmpegAvailabilityCache = { path: ffmpegPath, available };
  return available;
}

function transcodeToM4a(params: {
  sourceBytes: Uint8Array;
  sourceFileName: string;
  sourceMediaType: string;
}): Uint8Array {
  const ffmpegPath = resolveFfmpegPath();
  if (!checkFfmpegAvailability(ffmpegPath)) {
    throw new Error(`ffmpeg not available at path "${ffmpegPath}"`);
  }

  const inputExt = path.extname(params.sourceFileName).trim().toLowerCase()
    || mapMediaTypeToExtension(params.sourceMediaType);
  const tempDir = mkdtempSync(path.join(tmpdir(), "threema-voice-"));
  const inputPath = path.join(tempDir, `input${inputExt || ".bin"}`);
  const outputPath = path.join(tempDir, "output.m4a");

  try {
    writeFileSync(inputPath, Buffer.from(params.sourceBytes));
    const result = spawnSync(
      ffmpegPath,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        inputPath,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "aac",
        "-movflags",
        "+faststart",
        "-f",
        "mp4",
        outputPath,
      ],
      { encoding: "utf8" },
    );
    if (result.error || result.status !== 0) {
      const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
      const reason = stderr.length > 0 ? stderr : String(result.error ?? `status=${result.status}`);
      throw new Error(`ffmpeg transcode failed: ${reason}`);
    }

    const outputBytes = readFileSync(outputPath);
    if (outputBytes.length === 0) {
      throw new Error("ffmpeg produced empty output");
    }
    return new Uint8Array(outputBytes);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export function normalizeAudioMemoForThreema(
  params: NormalizeAudioMemoForThreemaParams,
): NormalizedAudioMemoForThreema {
  const mediaType = params.mediaType.trim().toLowerCase();
  if (!mediaType.startsWith("audio/")) {
    throw new Error(`Expected audio mediaType, got "${params.mediaType}"`);
  }

  const sourceBytes = params.bytes instanceof Uint8Array
    ? params.bytes
    : new Uint8Array(params.bytes);
  if (sourceBytes.length === 0) {
    throw new Error("Audio bytes are empty");
  }

  const fileName = ensureAudioFileName(params.fileName, mediaType);
  const forceM4a = params.forceM4a ?? true;
  if (!forceM4a) {
    return {
      bytes: sourceBytes,
      mediaType,
      fileName,
      durationSeconds: params.durationSeconds,
      transcoded: false,
    };
  }

  const alreadyNativeMemo = mediaType === "audio/mp4"
    && path.extname(fileName).trim().toLowerCase() === ".m4a";
  if (alreadyNativeMemo) {
    return {
      bytes: sourceBytes,
      mediaType,
      fileName,
      durationSeconds: params.durationSeconds,
      transcoded: false,
    };
  }

  const transcodedBytes = transcodeToM4a({
    sourceBytes,
    sourceFileName: fileName,
    sourceMediaType: mediaType,
  });
  return {
    bytes: transcodedBytes,
    mediaType: "audio/mp4",
    fileName: ensureM4aFileName(fileName),
    durationSeconds: params.durationSeconds,
    transcoded: true,
  };
}

async function requestSpeechBytes(params: {
  url: string;
  apiKey: string;
  model: string;
  voice: string;
  format: SpeechAudioFormat;
  speed?: number;
  timeoutMs: number;
  text: string;
}): Promise<Uint8Array> {
  const body: Record<string, unknown> = {
    model: params.model,
    voice: params.voice,
    input: params.text,
    response_format: params.format,
  };
  if (typeof params.speed === "number") {
    body.speed = params.speed;
  }

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), params.timeoutMs);
  let response: Response;
  try {
    response = await fetch(params.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: abortController.signal,
    });
  } catch (err) {
    throw new Error(`Voice synthesis request failed: ${String(err)}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(`Voice synthesis failed: status=${response.status} body=${errorBody}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length === 0) {
    throw new Error("Voice synthesis returned an empty body");
  }
  return bytes;
}

export async function synthesizeSpeechToAudioMemo(
  params: SynthesizeSpeechToAudioMemoParams,
): Promise<SynthesizedAudioMemo | null> {
  const text = params.text.trim();
  if (!text) {
    throw new Error("Voice synthesis text is empty");
  }

  const apiKey = resolveApiKey(params.apiKey);
  if (!apiKey) {
    return null;
  }

  const url = resolveSpeechUrl();
  const model = resolveSpeechModel(params.model);
  const fallbackModel = resolveSpeechFallbackModel(params.fallbackModel);
  const voice = resolveSpeechVoice(params.voice);
  const format = resolveSpeechFormat(params.format);
  const requireNativeVoiceMemoFormat = resolveRequireNativeVoiceMemoFormat(
    params.requireNativeVoiceMemoFormat,
  );
  const timeoutMs = resolveTimeout(params.timeoutMs);
  const speed = resolveSpeed(params.speed);

  let bytes: Uint8Array;
  let usedModel = model;
  try {
    bytes = await requestSpeechBytes({
      url,
      apiKey,
      model,
      voice,
      format,
      speed,
      timeoutMs,
      text,
    });
  } catch (err) {
    const canFallback = fallbackModel.trim().length > 0 && fallbackModel !== model;
    if (!canFallback) {
      throw err;
    }
    usedModel = fallbackModel;
    bytes = await requestSpeechBytes({
      url,
      apiKey,
      model: fallbackModel,
      voice,
      format,
      speed,
      timeoutMs,
      text,
    });
  }

  let mediaType = mapFormatToMediaType(format);
  let fileName = ensureFileName(params.fileName, format);
  let durationSeconds = format === "wav" ? parseWavDurationSeconds(bytes) : undefined;

  if (requireNativeVoiceMemoFormat) {
    const normalized = normalizeAudioMemoForThreema({
      bytes,
      mediaType,
      fileName,
      durationSeconds,
      forceM4a: true,
    });
    bytes = normalized.bytes;
    mediaType = normalized.mediaType;
    fileName = normalized.fileName;
    durationSeconds = normalized.durationSeconds;
  }

  return {
    bytes,
    mediaType,
    fileName,
    durationSeconds,
    model: usedModel,
    voice,
    format,
  };
}
