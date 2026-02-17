#!/usr/bin/env tsx

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MediatorClient, type IdentityData } from '../../src/mediator-client.js';

const TEST_TIMEOUT_MS = 120_000;
const LEADER_AND_CSP_TIMEOUT_MS = 90_000;
const DEFAULT_IMAGE_FIXTURE = 'sample-image.jpg';
const DEFAULT_AUDIO_FIXTURE = 'sample-audio.wav';
const DEFAULT_AUDIO_DURATION_SECONDS = 1.0;
const DEFAULT_IMAGE_BASE64 =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAkGBxAQEBAQEA8QDw8PEA8PDw8PDw8PDw8PFREWFhURFRUYHSggGBolGxUVITEhJSkrLi4uFx8zODMtNygtLisBCgoKDg0OGhAQGy0fICUtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLf/AABEIAAEAAQMBIgACEQEDEQH/xAAXAAEBAQEAAAAAAAAAAAAAAAAAAQID/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEAMQAAAB9A//xAAXEAADAQAAAAAAAAAAAAAAAAAAAREh/9oACAEBAAE/AL//xAAVEQEBAAAAAAAAAAAAAAAAAAAAIf/aAAgBAgEBPwC//8QAFBEBAAAAAAAAAAAAAAAAAAAAEP/aAAgBAwEBPwCf/9k=';

let activeClient: MediatorClient | null = null;

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ?? err.message;
  }
  return String(err);
}

function resolveTargetIdentity(): string {
  const raw = process.env.TEST_TARGET_ID?.trim();
  if (!raw) {
    throw new Error('Missing TEST_TARGET_ID (set this to an 8-character Threema ID)');
  }
  const normalized = raw.toUpperCase();
  if (!/^[*0-9A-Z]{8}$/.test(normalized)) {
    throw new Error(`Invalid TEST_TARGET_ID "${raw}" (expected 8-character Threema ID)`);
  }
  return normalized;
}

async function runWithTimeout(task: () => Promise<void>, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      console.error(`[test-send-media] Timeout after ${timeoutMs}ms`);
      try {
        activeClient?.disconnect();
      } catch {
        // Ignore disconnect errors while timing out.
      }
      reject(new Error(`Overall test timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    task()
      .then(() => {
        clearTimeout(timer);
        resolve();
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

function requireFixture(filePath: string, label: string): Uint8Array {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing ${label} fixture: ${filePath}`);
  }
  const bytes = fs.readFileSync(filePath);
  if (bytes.length === 0) {
    throw new Error(`${label} fixture is empty: ${filePath}`);
  }
  return new Uint8Array(bytes);
}

function createDefaultWavFixture(durationSeconds = 1): Uint8Array {
  const sampleRate = 8_000;
  const channels = 1;
  const bitsPerSample = 16;
  const samples = Math.max(1, Math.round(sampleRate * durationSeconds));
  const dataSize = samples * channels * (bitsPerSample / 8);
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const wav = Buffer.alloc(44 + dataSize);

  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(byteRate, 28);
  wav.writeUInt16LE(blockAlign, 32);
  wav.writeUInt16LE(bitsPerSample, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataSize, 40);

  return new Uint8Array(wav);
}

function ensureDefaultFixtures(fixtureDir: string): void {
  if (!fs.existsSync(fixtureDir)) {
    fs.mkdirSync(fixtureDir, { recursive: true });
  }

  const defaultImagePath = path.join(fixtureDir, DEFAULT_IMAGE_FIXTURE);
  if (!fs.existsSync(defaultImagePath)) {
    fs.writeFileSync(defaultImagePath, Buffer.from(DEFAULT_IMAGE_BASE64, 'base64'));
  }

  const defaultAudioPath = path.join(fixtureDir, DEFAULT_AUDIO_FIXTURE);
  if (!fs.existsSync(defaultAudioPath)) {
    fs.writeFileSync(defaultAudioPath, createDefaultWavFixture());
  }
}

function guessMediaType(filePath: string, fallback: string): string {
  const ext = path.extname(filePath).trim().toLowerCase();
  switch (ext) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.wav':
      return 'audio/wav';
    case '.m4a':
      return 'audio/mp4';
    case '.mp3':
      return 'audio/mpeg';
    case '.ogg':
      return 'audio/ogg';
    case '.opus':
      return 'audio/opus';
    default:
      return fallback;
  }
}

function resolveAudioDurationSeconds(): number {
  const raw = process.env.TEST_AUDIO_DURATION_SECONDS;
  if (!raw || raw.trim().length === 0) {
    return DEFAULT_AUDIO_DURATION_SECONDS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid TEST_AUDIO_DURATION_SECONDS value "${raw}"`);
  }
  return parsed;
}

async function main(): Promise<void> {
  console.log('[test-send-media] Hint: close the phone\'s Threema app first, or the bot will not be promoted to leader.');

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const dataDir = path.join(__dirname, '..', '..', 'data');
  const identityPath = path.join(dataDir, 'identity.json');
  const fixtureDir = path.join(dataDir, 'test-media');
  const targetIdentity = resolveTargetIdentity();
  const imagePath = process.env.TEST_IMAGE_PATH ?? path.join(fixtureDir, DEFAULT_IMAGE_FIXTURE);
  const audioPath = process.env.TEST_AUDIO_PATH ?? path.join(fixtureDir, DEFAULT_AUDIO_FIXTURE);
  const audioDurationSeconds = resolveAudioDurationSeconds();

  console.log(`[test-send-media] Step 1/8: Loading identity from ${identityPath}`);
  if (!fs.existsSync(identityPath)) {
    throw new Error(`Missing identity file: ${identityPath}`);
  }
  const identity: IdentityData = JSON.parse(fs.readFileSync(identityPath, 'utf-8'));
  console.log(`[test-send-media] Loaded identity ${identity.identity}`);

  console.log(`[test-send-media] Step 2/8: Loading fixtures from ${fixtureDir}`);
  ensureDefaultFixtures(fixtureDir);
  const imageBytes = requireFixture(imagePath, 'image');
  const audioBytes = requireFixture(audioPath, 'audio');
  const imageMediaType = guessMediaType(imagePath, 'image/jpeg');
  const audioMediaType = guessMediaType(audioPath, 'audio/wav');
  console.log(`[test-send-media] Image fixture: ${imagePath} (${imageBytes.length} bytes, ${imageMediaType})`);
  console.log(`[test-send-media] Audio fixture: ${audioPath} (${audioBytes.length} bytes, ${audioMediaType})`);

  console.log('[test-send-media] Step 3/8: Creating MediatorClient and connecting');
  const client = new MediatorClient({ identity, dataDir });
  activeClient = client;

  client.on('promotedToLeader', () => {
    console.log('[test-send-media] Event: promotedToLeader');
  });
  client.on('cspReady', () => {
    console.log('[test-send-media] Event: cspReady');
  });
  client.on('reflectAck', ({ reflectId, timestamp }: { reflectId: number; timestamp: bigint }) => {
    console.log(`[test-send-media] Event: ReflectAck id=${reflectId} ts=${timestamp}`);
  });

  try {
    await client.connect();
    console.log('[test-send-media] Connected to mediator');

    console.log('[test-send-media] Step 4/8: Waiting for leader promotion and CSP ready');
    await client.waitForLeaderAndCsp(LEADER_AND_CSP_TIMEOUT_MS);
    console.log('[test-send-media] Leader + CSP ready');

    console.log(`[test-send-media] Step 5/8: Sending image message to ${targetIdentity}`);
    const imageMessageId = await client.sendDirectMediaMessage({
      recipientIdentity: targetIdentity,
      kind: 'image',
      bytes: imageBytes,
      mediaType: imageMediaType,
      fileName: path.basename(imagePath),
      caption: `Media image test ${new Date().toISOString()}`,
    });
    console.log(`[test-send-media] Image message sent with ID ${imageMessageId.toString()}`);

    console.log(`[test-send-media] Step 6/8: Sending audio message to ${targetIdentity}`);
    const audioMessageId = await client.sendDirectMediaMessage({
      recipientIdentity: targetIdentity,
      kind: 'audio',
      bytes: audioBytes,
      mediaType: audioMediaType,
      fileName: path.basename(audioPath),
      caption: `Media audio test ${new Date().toISOString()}`,
      durationSeconds: audioDurationSeconds,
    });
    console.log(`[test-send-media] Audio message sent with ID ${audioMessageId.toString()}`);

    console.log('[test-send-media] Step 7/8: Both media sends acknowledged');
    console.log('[test-send-media] Step 8/8: Success');
  } finally {
    console.log('[test-send-media] Disconnecting');
    client.disconnect();
    activeClient = null;
  }
}

try {
  await runWithTimeout(main, TEST_TIMEOUT_MS);
  process.exit(0);
} catch (err) {
  console.error(`[test-send-media] Failed: ${formatError(err)}`);
  process.exit(1);
}
