import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { xsalsa20poly1305 } from '@noble/ciphers/salsa.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { MediatorClient, type IdentityData } from '../../src/mediator-client.js';

type MutableMediatorClient = MediatorClient & {
  ws: { send: (frame: Uint8Array) => void } | null;
  keys: { dgrk: Uint8Array };
  d2dRoot: {
    lookupType: (name: string) => {
      decode: (data: Uint8Array) => unknown;
    };
  } | null;
  handleReflected: (payload: Uint8Array) => void;
};

function createIdentity(): IdentityData {
  return {
    identity: 'UNITTEST',
    clientKey: '11'.repeat(32),
    serverGroup: '01',
    deviceGroupKey: '22'.repeat(32),
    deviceCookie: '33'.repeat(16),
    contactCount: 0,
    groupCount: 0,
    linkedAt: '2026-02-16T00:00:00.000Z',
  };
}

function encryptWithNonceAhead(plaintext: Uint8Array, key: Uint8Array): Uint8Array {
  const nonce = randomBytes(24);
  const encrypted = xsalsa20poly1305(key, nonce).encrypt(plaintext);
  const result = new Uint8Array(24 + encrypted.length);
  result.set(nonce, 0);
  result.set(encrypted, 24);
  return result;
}

function createReflectedPayload(params: {
  reflectedId: number;
  flags?: number;
  dgrk: Uint8Array;
}): Uint8Array {
  const { reflectedId, flags = 0, dgrk } = params;
  const encryptedEnvelope = encryptWithNonceAhead(new Uint8Array([0xde, 0xad, 0xbe, 0xef]), dgrk);
  const payload = new Uint8Array(16 + encryptedEnvelope.length);
  const view = new DataView(payload.buffer);
  payload[0] = 16; // structbuf header length used by libthreema
  payload[1] = 0;
  view.setUint16(2, flags, true);
  view.setUint32(4, reflectedId, true);
  view.setBigUint64(8, 1n, true);
  payload.set(encryptedEnvelope, 16);
  return payload;
}

function extractReflectedAckId(frame: Uint8Array): number {
  assert.equal(frame[0], 0x83, 'expected REFLECTED_ACK frame type');
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  return view.getUint32(8, true);
}

function createTestClient(onEnvelope: (envelope: unknown) => void): {
  client: MutableMediatorClient;
  sentFrames: Uint8Array[];
  cleanup: () => void;
} {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'threema-reflected-ack-'));
  const sentFrames: Uint8Array[] = [];
  const client = new MediatorClient({
    identity: createIdentity(),
    dataDir: tmpDir,
    onEnvelope,
  }) as unknown as MutableMediatorClient;

  client.ws = {
    send: (frame: Uint8Array) => sentFrames.push(frame),
  };

  return {
    client,
    sentFrames,
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  };
}

test('ACKs duplicate reflected incoming messages even when deduped', () => {
  const envelopes: unknown[] = [];
  const { client, sentFrames, cleanup } = createTestClient((envelope) => envelopes.push(envelope));
  try {

    const sharedEnvelope = {
      content: 'incomingMessage',
      incomingMessage: {
        senderIdentity: 'UNITTEST',
        messageId: '42',
        type: 0x01,
        body: new TextEncoder().encode('hello'),
      },
    };

    client.d2dRoot = {
      lookupType: (name: string) => {
        assert.equal(name, 'd2d.Envelope');
        return {
          decode: () => sharedEnvelope,
        };
      },
    };

    const payload1 = createReflectedPayload({
      reflectedId: 1001,
      dgrk: client.keys.dgrk,
    });
    const payload2 = createReflectedPayload({
      reflectedId: 1002,
      dgrk: client.keys.dgrk,
    });

    client.handleReflected(payload1);
    client.handleReflected(payload2);

    assert.equal(envelopes.length, 1, 'duplicate should not be reprocessed');
    assert.equal(sentFrames.length, 2, 'both reflections must be ACKed');
    assert.equal(extractReflectedAckId(sentFrames[0]!), 1001);
    assert.equal(extractReflectedAckId(sentFrames[1]!), 1002);
  } finally {
    cleanup();
  }
});

test('ACKs non-duplicate reflected incoming messages', () => {
  const envelopes: unknown[] = [];
  const { client, sentFrames, cleanup } = createTestClient((envelope) => envelopes.push(envelope));
  try {

    client.d2dRoot = {
      lookupType: (name: string) => {
        assert.equal(name, 'd2d.Envelope');
        return {
          decode: () => ({
            content: 'incomingMessage',
            incomingMessage: {
              senderIdentity: 'UNITTEST',
              messageId: '43',
              type: 0x01,
              body: new TextEncoder().encode('ok'),
            },
          }),
        };
      },
    };

    client.handleReflected(
      createReflectedPayload({
        reflectedId: 2001,
        dgrk: client.keys.dgrk,
      }),
    );

    assert.equal(envelopes.length, 1);
    assert.equal(sentFrames.length, 1);
    assert.equal(extractReflectedAckId(sentFrames[0]!), 2001);
  } finally {
    cleanup();
  }
});

test('does not ACK ephemeral reflected messages', () => {
  const envelopes: unknown[] = [];
  const { client, sentFrames, cleanup } = createTestClient((envelope) => envelopes.push(envelope));
  try {

    client.d2dRoot = {
      lookupType: (name: string) => {
        assert.equal(name, 'd2d.Envelope');
        return {
          decode: () => ({
            content: 'incomingMessage',
            incomingMessage: {
              senderIdentity: 'UNITTEST',
              messageId: '44',
              type: 0x01,
              body: new TextEncoder().encode('ephemeral'),
            },
          }),
        };
      },
    };

    client.handleReflected(
      createReflectedPayload({
        reflectedId: 3001,
        flags: 0x0001, // ephemeral
        dgrk: client.keys.dgrk,
      }),
    );

    assert.equal(envelopes.length, 1);
    assert.equal(sentFrames.length, 0);
  } finally {
    cleanup();
  }
});

test('persists incoming dedupe keys across client restarts', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'threema-incoming-dedupe-'));
  try {
    const identity = createIdentity();
    const first = new MediatorClient({
      identity,
      dataDir: tmpDir,
    }) as unknown as {
      recordIncomingMessage: (identity: string, messageId: bigint) => boolean;
      disconnect: () => void;
    };

    assert.equal(first.recordIncomingMessage('UNITTEST', 42n), true);
    first.disconnect();

    const dedupeStatePath = path.join(tmpDir, 'incoming-message-dedupe.json');
    assert.equal(fs.existsSync(dedupeStatePath), true);

    const second = new MediatorClient({
      identity,
      dataDir: tmpDir,
    }) as unknown as {
      recordIncomingMessage: (identity: string, messageId: bigint) => boolean;
      disconnect: () => void;
    };
    assert.equal(second.recordIncomingMessage('UNITTEST', 42n), false);
    assert.equal(second.recordIncomingMessage('UNITTEST', 43n), true);
    second.disconnect();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
