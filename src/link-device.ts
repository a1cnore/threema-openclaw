#!/usr/bin/env npx tsx
/**
 * Threema Device Linking — Main entry point.
 * 
 * Generates a QR code, waits for phone to scan it, runs the rendezvous
 * and device join protocols, and saves the received identity + keys.
 */
import { setupRendezvous } from './rendezvous.js';
import { runDeviceJoin } from './device-join.js';
import { rphToEmojiSequence } from './rph-emoji.js';
import { resolveThreemaDataDir } from './runtime-paths.js';
import qrcode from 'qrcode-terminal';
import fs from 'fs';
import path from 'path';
const DATA_DIR = resolveThreemaDataDir();

/**
 * Display RPH as emoji for verification (matches Threema's display).
 */
function rphToEmoji(rph: Uint8Array): string {
  const emojis = rphToEmojiSequence(rph, 3).join('   ');
  const hex = Buffer.from(rph).toString('hex');
  return `Trust symbols: ${emojis}\nRPH: ${hex.slice(0, 8)}...${hex.slice(-8)}`;
}

async function main() {
  console.log('=== Threema Device Linking ===\n');
  
  // Step 1: Set up rendezvous
  console.log('Setting up rendezvous connection...');
  const setup = await setupRendezvous();
  
  // Step 2: Display QR code
  console.log('\nScan this QR code with your Threema app:');
  console.log('(Threema > Settings > Linked Devices > Link New Device)\n');
  
  await new Promise<void>((resolve) => {
    qrcode.generate(setup.joinUri, { small: true }, (code: string) => {
      console.log(code);
      resolve();
    });
  });
  
  console.log(`\nURI: ${setup.joinUri.slice(0, 80)}...`);
  console.log('\nWaiting for phone to scan...\n');
  
  // Step 3: Run rendezvous protocol
  const conn = await setup.connect();
  
  // Step 4: Display RPH for verification
  console.log('\n' + rphToEmoji(conn.rph));
  console.log('Verify this matches what your phone shows.\n');
  
  // Step 5: Run device join protocol
  const result = await runDeviceJoin(conn);
  
  // Step 6: Save identity data
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const identityFile = path.join(DATA_DIR, 'identity.json');
  
  const identityData = {
    identity: result.identity,
    clientKey: Buffer.from(result.clientKey).toString('hex'),
    serverGroup: result.serverGroup,
    deviceGroupKey: Buffer.from(result.deviceGroupKey).toString('hex'),
    deviceCookie: Buffer.from(result.deviceCookie).toString('hex'),
    contactCount: result.contacts.length,
    groupCount: result.groups.length,
    linkedAt: new Date().toISOString(),
  };
  
  fs.writeFileSync(identityFile, JSON.stringify(identityData, null, 2));
  console.log(`\n✅ Identity saved to ${identityFile}`);
  
  // Save contacts
  const contactsFile = path.join(DATA_DIR, 'contacts.json');
  const contactData = result.contacts.map(c => ({
    identity: c.identity,
    publicKey: Buffer.from(c.publicKey).toString('hex'),
    firstName: c.firstName,
    lastName: c.lastName,
    nickname: c.nickname,
  }));
  fs.writeFileSync(contactsFile, JSON.stringify(contactData, null, 2));
  console.log(`✅ ${contactData.length} contacts saved to ${contactsFile}`);
  
  // Save groups
  if (result.groups.length > 0) {
    const groupsFile = path.join(DATA_DIR, 'groups.json');
    fs.writeFileSync(groupsFile, JSON.stringify(result.groups, null, 2));
    console.log(`✅ ${result.groups.length} groups saved to ${groupsFile}`);
  }
  
  console.log('\n🎉 Device linked successfully!');
  console.log(`   Threema ID: ${result.identity}`);
  console.log(`   Server Group: ${result.serverGroup}`);
  
  // Close rendezvous connection
  conn.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('\n❌ Error:', err);
  process.exit(1);
});
