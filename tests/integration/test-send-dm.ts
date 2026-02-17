#!/usr/bin/env tsx

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MediatorClient, type IdentityData } from '../../src/mediator-client.js';

const TEST_TIMEOUT_MS = 120_000;
const LEADER_AND_CSP_TIMEOUT_MS = 90_000;
const MESSAGE_TEXT = 'Hello from the bot! 🤖';

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
      console.error(`[test-send] Timeout after ${timeoutMs}ms`);
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

async function main(): Promise<void> {
  console.log('[test-send] Hint: close the phone\'s Threema app first, or the bot will not be promoted to leader.');
  const targetIdentity = resolveTargetIdentity();

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const dataDir = path.join(__dirname, '..', '..', 'data');
  const identityPath = path.join(dataDir, 'identity.json');

  console.log(`[test-send] Step 1/6: Loading identity from ${identityPath}`);
  if (!fs.existsSync(identityPath)) {
    throw new Error(`Missing identity file: ${identityPath}`);
  }
  const identity: IdentityData = JSON.parse(fs.readFileSync(identityPath, 'utf-8'));
  console.log(`[test-send] Loaded identity ${identity.identity}`);

  console.log('[test-send] Step 2/6: Creating MediatorClient and connecting');
  const client = new MediatorClient({ identity, dataDir });
  activeClient = client;

  client.on('promotedToLeader', () => {
    console.log('[test-send] Event: promotedToLeader');
  });
  client.on('cspReady', () => {
    console.log('[test-send] Event: cspReady');
  });
  client.on('reflectAck', ({ reflectId, timestamp }: { reflectId: number; timestamp: bigint }) => {
    console.log(`[test-send] Event: ReflectAck id=${reflectId} ts=${timestamp}`);
  });

  try {
    await client.connect();
    console.log('[test-send] Connected to mediator');

    console.log('[test-send] Step 3/6: Waiting for leader promotion and CSP ready');
    await client.waitForLeaderAndCsp(LEADER_AND_CSP_TIMEOUT_MS);
    console.log('[test-send] Leader + CSP ready');

    console.log(`[test-send] Step 4/6: Sending text message to ${targetIdentity}`);
    const messageId = await client.sendTextMessage(targetIdentity, MESSAGE_TEXT);
    console.log(`[test-send] Message sent with ID ${messageId.toString()}`);

    console.log('[test-send] Step 5/6: ReflectAck received (sendTextMessage completed)');
    console.log('[test-send] Step 6/6: Success');
  } finally {
    console.log('[test-send] Disconnecting');
    client.disconnect();
    activeClient = null;
  }
}

try {
  await runWithTimeout(main, TEST_TIMEOUT_MS);
  process.exit(0);
} catch (err) {
  console.error(`[test-send] Failed: ${formatError(err)}`);
  process.exit(1);
}
