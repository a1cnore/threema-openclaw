#!/usr/bin/env tsx

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MediatorClient, type IdentityData } from '../../src/mediator-client.js';

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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', '..', 'data');
const identityPath = path.join(dataDir, 'identity.json');
if (!fs.existsSync(identityPath)) {
  throw new Error(`Missing identity file: ${identityPath}`);
}

const identity: IdentityData = JSON.parse(fs.readFileSync(identityPath, 'utf-8'));
const client = new MediatorClient({ identity, dataDir });
const targetIdentity = resolveTargetIdentity();

client.on('cspReady', async () => {
  console.log('CSP ready, creating group...');
  try {
    const groupName = process.env.TEST_GROUP_NAME?.trim() || `BotTest ${new Date().toISOString().slice(11, 19)}`;
    const created = await client.createGroupWithMembers({
      name: groupName,
      memberIdentities: [targetIdentity],
      requireCsp: true,
    });
    const creatorIdentity = client.getIdentity().trim().toUpperCase();
    console.log(`Created group "${groupName}" with gid=${created.groupIdBigInt}`);

    const messageText = process.env.TEST_GROUP_MESSAGE?.trim() || 'Welcome to the test group.';
    const msgId = await client.sendGroupTextMessage(
      creatorIdentity,
      created.groupId,
      created.members,
      messageText,
      { requireCsp: true },
    );
    console.log(`Sent welcome message: ${msgId}`);
  } catch (err) {
    console.error('Failed:', err);
  }
  setTimeout(() => {
    client.disconnect();
    process.exit(0);
  }, 3000);
});

await client.connect();
