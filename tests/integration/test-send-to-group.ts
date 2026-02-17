#!/usr/bin/env tsx

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MediatorClient, type IdentityData } from '../../src/mediator-client.js';

function normalizeIdentity(identity: string, fieldName: string): string {
  const normalized = identity.trim().toUpperCase();
  if (!/^[*0-9A-Z]{8}$/.test(normalized)) {
    throw new Error(`Invalid ${fieldName} "${identity}" (expected 8-character Threema ID)`);
  }
  return normalized;
}

function resolveRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

function resolveGroupIdBytes(): Uint8Array {
  const raw = resolveRequiredEnv('TEST_GROUP_ID');
  let groupId: bigint;
  try {
    groupId = BigInt(raw);
  } catch {
    throw new Error(`Invalid TEST_GROUP_ID "${raw}" (expected unsigned integer)`);
  }
  if (groupId < 0n) {
    throw new Error(`Invalid TEST_GROUP_ID "${raw}" (expected unsigned integer)`);
  }
  const groupIdBytes = new Uint8Array(8);
  new DataView(groupIdBytes.buffer).setBigUint64(0, groupId, true);
  return groupIdBytes;
}

function resolveMemberIdentities(): string[] {
  const raw = process.env.TEST_GROUP_MEMBERS?.trim();
  if (!raw) {
    return [];
  }
  const entries = raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .map((value) => normalizeIdentity(value, 'TEST_GROUP_MEMBERS'));
  return Array.from(new Set(entries));
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', '..', 'data');
const identityPath = path.join(dataDir, 'identity.json');
if (!fs.existsSync(identityPath)) {
  throw new Error(`Missing identity file: ${identityPath}`);
}

const identity: IdentityData = JSON.parse(fs.readFileSync(identityPath, 'utf-8'));
const client = new MediatorClient({ identity, dataDir });
const groupCreator = normalizeIdentity(resolveRequiredEnv('TEST_GROUP_CREATOR'), 'TEST_GROUP_CREATOR');
const groupIdBytes = resolveGroupIdBytes();
const memberIdentities = resolveMemberIdentities();
const messageText = process.env.TEST_GROUP_MESSAGE?.trim() || `Group test message ${new Date().toISOString()}`;

client.on('cspReady', async () => {
  console.log('CSP ready, sending group message...');
  try {
    const msgId = await client.sendGroupTextMessage(
      groupCreator,
      groupIdBytes,
      memberIdentities,
      messageText,
    );
    console.log('Sent message:', msgId.toString());
  } catch (err) {
    console.error('Send failed:', err);
  }
  setTimeout(() => {
    client.disconnect();
    process.exit(0);
  }, 2000);
});

await client.connect();
