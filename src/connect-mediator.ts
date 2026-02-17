#!/usr/bin/env tsx
/**
 * Connect to the Threema mediator server as a linked device.
 * Receives reflected messages from other devices in the device group.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { MediatorClient, type IdentityData } from './mediator-client.js';
import { resolveThreemaDataDir, resolveThreemaIdentityPath } from './runtime-paths.js';

const dataDir = resolveThreemaDataDir();

// Load identity
const identityPath = resolveThreemaIdentityPath(dataDir);
if (!fs.existsSync(identityPath)) {
  console.error('No identity.json found. Run link-device first.');
  process.exit(1);
}

const identity: IdentityData = JSON.parse(fs.readFileSync(identityPath, 'utf-8'));
console.log(`Identity: ${identity.identity} (server group: ${identity.serverGroup})`);
console.log(`Linked at: ${identity.linkedAt}`);
console.log(`Contacts: ${identity.contactCount}, Groups: ${identity.groupCount}`);

// Create and connect
const client = new MediatorClient({
  identity,
  dataDir,
  onEnvelope: (envelope) => {
    // Log all reflected envelopes
    if (envelope.incomingMessage) {
      const msg = envelope.incomingMessage;
      console.log(`\n📩 Message from ${msg.senderIdentity}: type=${msg.type}`);
      if (msg.type === 1 && msg.body?.length > 0) {
        console.log(`   "${new TextDecoder().decode(msg.body)}"`);
      }
    }
  },
  onCspMessage: (message) => {
    const id = message.messageId !== undefined ? message.messageId.toString() : 'unknown';
    console.log(`\n📨 CSP incoming from ${message.senderIdentity}: type=0x${message.containerType.toString(16)} id=${id}`);
  },
});

const commandInterface = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: true,
});

let cspReady = false;

function printCommandHelp(): void {
  console.log('\nCommands:');
  console.log('  send <IDENTITY> <text>              Send a 1:1 text message');
  console.log('  gsend <CREATOR> <GID> <MEMBERS> <text>  Send a group text');
  console.log('    MEMBERS = comma-separated identities (e.g. ID1,ID2,ID3)');
  console.log('    GID = decimal group ID (uint64)');
  console.log('  help                                Show this help');
  console.log('  quit                                Disconnect and exit');
}

function bigintToBytes8LE(val: bigint): Uint8Array {
  const buf = new Uint8Array(8);
  const view = new DataView(buf.buffer);
  view.setBigUint64(0, val, true);
  return buf;
}

async function handleCommand(line: string): Promise<void> {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return;
  }

  if (trimmed === 'help') {
    printCommandHelp();
    return;
  }

  if (trimmed === 'quit' || trimmed === 'exit') {
    console.log('Disconnecting...');
    commandInterface.close();
    client.disconnect();
    return;
  }

  const sendMatch = trimmed.match(/^send\s+([*0-9A-Za-z]{8})\s+([\s\S]+)$/);
  if (sendMatch) {
    if (!cspReady) {
      console.log('CSP not ready yet; wait for the handshake to complete.');
      return;
    }

    const recipientIdentity = sendMatch[1]!.toUpperCase();
    const text = sendMatch[2]!;
    try {
      const messageId = await client.sendTextMessage(recipientIdentity, text);
      console.log(`Sent message ${messageId.toString()} to ${recipientIdentity}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Send failed: ${message}`);
    }
    return;
  }

  const gsendMatch = trimmed.match(/^gsend\s+([*0-9A-Za-z]{8})\s+(\d+)\s+([*0-9A-Za-z,]+)\s+([\s\S]+)$/);
  if (gsendMatch) {
    if (!cspReady) {
      console.log('CSP not ready yet; wait for the handshake to complete.');
      return;
    }
    const creator = gsendMatch[1]!.toUpperCase();
    const gid = BigInt(gsendMatch[2]!);
    const members = gsendMatch[3]!.split(',').map(m => m.trim().toUpperCase());
    const text = gsendMatch[4]!;
    try {
      const messageId = await client.sendGroupTextMessage(creator, bigintToBytes8LE(gid), members, text);
      console.log(`Sent group message ${messageId.toString()} to group ${creator}/${gid}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Group send failed: ${message}`);
    }
    return;
  }

  console.log('Unknown command. Type "help" for usage.');
}

commandInterface.on('line', (line) => {
  void handleCommand(line);
});

client.on('close', (code: number, reason: string) => {
  console.log(`\nDisconnected: ${code} ${reason}`);
  if (code === 4115) {
    console.log('Device slot state mismatch — try deleting deviceId from identity.json');
  }
  commandInterface.close();
  process.exit(code === 1000 ? 0 : 1);
});

client.on('promotedToLeader', () => {
  console.log('\n⚡ We are the leader device — starting CSP over mediator proxy');
});

client.on('cspReady', () => {
  cspReady = true;
  console.log('\n🔐 CSP handshake completed (LoginAck received)');
  printCommandHelp();
});

client.on('reflectionQueueDry', () => {
  console.log('\n✅ Reflection queue is empty — all caught up');
});

// Handle Ctrl+C
process.on('SIGINT', () => {
  console.log('\nDisconnecting...');
  commandInterface.close();
  client.disconnect();
  process.exit(0);
});

try {
  await client.connect();
  console.log('\n🟢 Connected to mediator. Waiting for reflected messages...\n');
} catch (err) {
  console.error('Failed to connect:', err);
  process.exit(1);
}
