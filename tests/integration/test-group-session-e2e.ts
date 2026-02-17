#!/usr/bin/env tsx

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MediatorClient, type IdentityData } from '../../src/mediator-client.js';

const TEST_TIMEOUT_MS = 600_000;
const LEADER_AND_CSP_TIMEOUT_MS = 90_000;
const DEFAULT_MANUAL_REPLY_TIMEOUT_MS = 300_000;

// Vendor/libthreema parity references:
// - common.proto: GROUP_SETUP=0x4A, GROUP_NAME=0x4B
// - common.proto: GROUP_TEXT=0x41
const E2E_GROUP_SETUP_MESSAGE_TYPE = 0x4a;
const E2E_GROUP_NAME_MESSAGE_TYPE = 0x4b;
const E2E_GROUP_TEXT_MESSAGE_TYPE = 0x41;

let activeClient: MediatorClient | null = null;

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ?? err.message;
  }
  return String(err);
}

function normalizeIdentity(identity: string, fieldName: string): string {
  const normalized = identity.trim().toUpperCase();
  if (!/^[*0-9A-Z]{8}$/.test(normalized)) {
    throw new Error(`Invalid ${fieldName} "${identity}" (expected 8-character Threema ID)`);
  }
  return normalized;
}

function resolveTargetIdentity(): string {
  const raw = process.env.TEST_TARGET_ID?.trim();
  if (!raw) {
    throw new Error('Missing TEST_TARGET_ID (set this to an 8-character Threema ID)');
  }
  return normalizeIdentity(raw, 'TEST_TARGET_ID');
}

function resolveManualReplyTimeoutMs(): number {
  const raw = process.env.TEST_GROUP_REPLY_TIMEOUT_MS?.trim();
  if (!raw) {
    return DEFAULT_MANUAL_REPLY_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 5_000) {
    throw new Error(`Invalid TEST_GROUP_REPLY_TIMEOUT_MS "${raw}" (expected >= 5000)`);
  }
  return Math.floor(parsed);
}

function decodeGroupTextBody(body: Uint8Array): {
  creatorIdentity: string;
  groupId: bigint;
  text: string;
} | null {
  if (body.length < 17) {
    return null;
  }
  const creatorIdentityRaw = new TextDecoder().decode(body.subarray(0, 8)).replace(/\0+$/g, '');
  let creatorIdentity: string;
  try {
    creatorIdentity = normalizeIdentity(creatorIdentityRaw, 'groupCreator');
  } catch {
    return null;
  }
  const groupId = new DataView(body.buffer, body.byteOffset, body.byteLength).getBigUint64(8, true);
  const text = new TextDecoder().decode(body.subarray(16));
  return { creatorIdentity, groupId, text };
}

async function runWithTimeout(task: () => Promise<void>, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      console.error(`[test-group-e2e] Timeout after ${timeoutMs}ms`);
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

async function waitForManualGroupReply(params: {
  client: MediatorClient;
  senderIdentity: string;
  creatorIdentity: string;
  groupId: bigint;
  requiredToken: string;
  timeoutMs: number;
}): Promise<{ messageId: string; text: string }> {
  const {
    client,
    senderIdentity,
    creatorIdentity,
    groupId,
    requiredToken,
    timeoutMs,
  } = params;

  return await new Promise<{ messageId: string; text: string }>((resolve, reject) => {
    const timer = setTimeout(() => {
      client.removeListener('envelope', onEnvelope);
      reject(
        new Error(
          `Timed out after ${timeoutMs}ms waiting for reply token "${requiredToken}" from ${senderIdentity} in ${creatorIdentity}/${groupId.toString()}`,
        ),
      );
    }, timeoutMs);

    const onEnvelope = (envelope: unknown) => {
      const candidate = envelope as {
        incomingMessage?: {
          senderIdentity?: unknown;
          messageId?: unknown;
          type?: unknown;
          body?: unknown;
        };
      };
      const msg = candidate?.incomingMessage;
      if (!msg) {
        return;
      }

      const incomingSender = typeof msg.senderIdentity === 'string'
        ? msg.senderIdentity.trim().toUpperCase()
        : '';
      if (incomingSender !== senderIdentity) {
        return;
      }

      const type = Number(msg.type ?? -1);
      if (type !== E2E_GROUP_TEXT_MESSAGE_TYPE) {
        return;
      }

      const body = msg.body instanceof Uint8Array
        ? msg.body
        : (msg.body && ArrayBuffer.isView(msg.body))
          ? new Uint8Array(msg.body.buffer, msg.body.byteOffset, msg.body.byteLength)
          : null;
      if (!body) {
        return;
      }

      const parsed = decodeGroupTextBody(body);
      if (!parsed) {
        return;
      }
      if (parsed.creatorIdentity !== creatorIdentity || parsed.groupId !== groupId) {
        return;
      }
      if (!parsed.text.includes(requiredToken)) {
        console.log(
          `[test-group-e2e] Ignoring reply in target group without token "${requiredToken}": "${parsed.text.slice(0, 120)}"`,
        );
        return;
      }

      clearTimeout(timer);
      client.removeListener('envelope', onEnvelope);
      const messageId = (msg.messageId as { toString?: () => string })?.toString?.() ?? '';
      resolve({
        messageId,
        text: parsed.text,
      });
    };

    client.on('envelope', onEnvelope);
  });
}

async function main(): Promise<void> {
  console.log('[test-group-e2e] Hint: close the phone\'s Threema app first, or the bot may not become leader.');
  const manualReplyTimeoutMs = resolveManualReplyTimeoutMs();
  const targetIdentity = resolveTargetIdentity();

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const dataDir = path.join(__dirname, '..', '..', 'data');
  const identityPath = path.join(dataDir, 'identity.json');

  console.log(`[test-group-e2e] Step 1/9: Loading identity from ${identityPath}`);
  if (!fs.existsSync(identityPath)) {
    throw new Error(`Missing identity file: ${identityPath}`);
  }
  const identity: IdentityData = JSON.parse(fs.readFileSync(identityPath, 'utf-8'));
  console.log(`[test-group-e2e] Loaded identity ${identity.identity}`);

  console.log('[test-group-e2e] Step 2/9: Creating MediatorClient and connecting');
  const client = new MediatorClient({ identity, dataDir });
  activeClient = client;

  client.on('promotedToLeader', () => {
    console.log('[test-group-e2e] Event: promotedToLeader');
  });
  client.on('cspReady', () => {
    console.log('[test-group-e2e] Event: cspReady');
  });
  client.on('reflectAck', ({ reflectId, timestamp }: { reflectId: number; timestamp: bigint }) => {
    console.log(`[test-group-e2e] Event: ReflectAck id=${reflectId} ts=${timestamp}`);
  });

  try {
    await client.connect();
    console.log('[test-group-e2e] Connected to mediator');

    console.log('[test-group-e2e] Step 3/9: Waiting for leader promotion and CSP ready');
    await client.waitForLeaderAndCsp(LEADER_AND_CSP_TIMEOUT_MS);
    if (!client.isLeader() || !client.isCspReady()) {
      throw new Error('Leader/CSP precondition failed after readiness wait');
    }
    console.log('[test-group-e2e] Leader + CSP ready');

    const token = `E2E-${Date.now().toString(36).toUpperCase()}`;
    const groupName = `Session ${new Date().toISOString().slice(11, 19)} ${token}`;
    console.log(
      `[test-group-e2e] Step 4/9: Vendor parity check -> GROUP_SETUP=0x${E2E_GROUP_SETUP_MESSAGE_TYPE.toString(16)}, GROUP_NAME=0x${E2E_GROUP_NAME_MESSAGE_TYPE.toString(16)}, GROUP_TEXT=0x${E2E_GROUP_TEXT_MESSAGE_TYPE.toString(16)}, recipients=1, strictCsp=true`,
    );

    console.log(`[test-group-e2e] Step 5/9: Creating real group "${groupName}" with member ${targetIdentity}`);
    const created = await client.createGroupWithMembers({
      name: groupName,
      memberIdentities: [targetIdentity],
      requireCsp: true,
    });
    const creatorIdentity = normalizeIdentity(client.getIdentity(), 'selfIdentity');
    console.log(
      `[test-group-e2e] Group created: creator=${creatorIdentity} gid=${created.groupIdBigInt.toString()} members=${created.members.join(',')}`,
    );

    console.log('[test-group-e2e] Step 6/9: Sending first group message with strict CSP mode');
    const promptText = `E2E group ready (${token}). Please reply in this group with: ACK ${token}`;
    const sentMessageId = await client.sendGroupTextMessage(
      creatorIdentity,
      created.groupId,
      created.members,
      promptText,
      { requireCsp: true },
    );
    console.log(`[test-group-e2e] Initial group message sent with ID ${sentMessageId.toString()}`);

    console.log(
      `[test-group-e2e] Step 7/9: Waiting up to ${manualReplyTimeoutMs}ms for manual reply from ${targetIdentity} in ${creatorIdentity}/${created.groupIdBigInt.toString()}`,
    );
    console.log(`[test-group-e2e] Manual action required: reply from ${targetIdentity} with token "${token}" in the new group.`);
    const confirmation = await waitForManualGroupReply({
      client,
      senderIdentity: targetIdentity,
      creatorIdentity,
      groupId: created.groupIdBigInt,
      requiredToken: token,
      timeoutMs: manualReplyTimeoutMs,
    });

    console.log(`[test-group-e2e] Step 8/9: Received confirmation message ${confirmation.messageId || '(no-id)'}`);
    console.log(`[test-group-e2e] Confirmation text: "${confirmation.text.slice(0, 180)}"`);
    console.log('[test-group-e2e] Step 9/9: Success');
  } finally {
    console.log('[test-group-e2e] Disconnecting');
    client.disconnect();
    activeClient = null;
  }
}

try {
  await runWithTimeout(main, TEST_TIMEOUT_MS);
  process.exit(0);
} catch (err) {
  console.error(`[test-group-e2e] Failed: ${formatError(err)}`);
  process.exit(1);
}
