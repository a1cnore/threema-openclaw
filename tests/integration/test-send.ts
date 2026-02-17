#!/usr/bin/env tsx

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MediatorClient, type IdentityData } from '../../src/mediator-client.js';

function bigintToBytes8LE(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

function parseGroupId(value: unknown): bigint | null {
  if (typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return BigInt(value);
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    try {
      return BigInt(value.trim());
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object') {
    return null;
  }

  const asRecord = value as Record<string, unknown>;
  const low = asRecord.low;
  const high = asRecord.high;
  if (typeof low !== 'number' || typeof high !== 'number') {
    return null;
  }

  const lowPart = BigInt(low >>> 0);
  const highPart = BigInt(high >>> 0);
  return (highPart << 32n) | lowPart;
}

function loadKnownGroupId(dataDir: string, creatorIdentity: string): bigint | null {
  const groupsPath = path.join(dataDir, 'groups.json');
  if (!fs.existsSync(groupsPath)) {
    return null;
  }

  const raw = fs.readFileSync(groupsPath, 'utf-8').trim();
  if (raw.length === 0) {
    return null;
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    return null;
  }

  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.creatorIdentity !== 'string') {
      continue;
    }
    if (record.creatorIdentity.trim().toUpperCase() !== creatorIdentity) {
      continue;
    }
    const groupId = parseGroupId(record.groupId);
    if (groupId !== null) {
      return groupId;
    }
  }

  return null;
}

function waitForEvent(
  client: MediatorClient,
  eventName: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.removeListener(eventName, onEvent);
      reject(new Error(`Timed out waiting for ${eventName}`));
    }, timeoutMs);
    const onEvent = () => {
      clearTimeout(timer);
      resolve();
    };
    client.once(eventName, onEvent);
  });
}

async function main(): Promise<void> {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const dataDir = path.join(__dirname, '..', '..', 'data');
  const identityPath = path.join(dataDir, 'identity.json');
  if (!fs.existsSync(identityPath)) {
    throw new Error(`Missing identity file: ${identityPath}`);
  }

  const identity: IdentityData = JSON.parse(fs.readFileSync(identityPath, 'utf-8'));
  const selfIdentity = identity.identity.trim().toUpperCase();

  const client = new MediatorClient({ identity, dataDir });
  const serverInfoPromise = waitForEvent(client, 'serverInfo', 20_000);

  try {
    await client.connect();
    console.log(`[test-send] Connected as ${selfIdentity}`);

    try {
      await serverInfoPromise;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[test-send] ${message}; continuing with reflect send`);
    }

    let creatorIdentity = (process.env.TEST_GROUP_CREATOR ?? selfIdentity).trim().toUpperCase();
    let groupId: bigint | null = null;

    const explicitGroupId = process.env.TEST_GROUP_ID;
    if (explicitGroupId && explicitGroupId.trim().length > 0) {
      groupId = BigInt(explicitGroupId.trim());
      console.log(`[test-send] Using TEST_GROUP_ID=${groupId.toString()} creator=${creatorIdentity}`);
    }

    if (groupId === null) {
      groupId = loadKnownGroupId(dataDir, creatorIdentity);
      if (groupId !== null) {
        console.log(`[test-send] Using known group creator=${creatorIdentity} gid=${groupId.toString()}`);
      }
    }

    if (groupId === null && creatorIdentity !== selfIdentity) {
      creatorIdentity = selfIdentity;
      groupId = loadKnownGroupId(dataDir, creatorIdentity);
      if (groupId !== null) {
        console.log(`[test-send] Using known self-created group gid=${groupId.toString()}`);
      }
    }

    if (groupId === null) {
      const groupName = `Reflect Test ${new Date().toISOString().slice(11, 19)}`;
      const created = await client.createGroup(groupName);
      creatorIdentity = selfIdentity;
      groupId = created.groupIdBigInt;
      console.log(`[test-send] Created self-only group "${groupName}" gid=${groupId.toString()}`);
    }

    const text = `Reflect test ${new Date().toISOString()}`;
    const messageId = await client.sendGroupTextMessage(
      creatorIdentity,
      bigintToBytes8LE(groupId),
      [],
      text,
    );

    console.log(
      `[test-send] Sent reflected group text: creator=${creatorIdentity} gid=${groupId.toString()} messageId=${messageId.toString()}`,
    );
    console.log('[test-send] Success');
  } finally {
    client.disconnect();
  }
}

try {
  await main();
  process.exit(0);
} catch (err) {
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(`[test-send] Failed: ${message}`);
  process.exit(1);
}
