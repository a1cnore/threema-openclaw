import { EventEmitter } from 'node:events';
import { blake2b } from '@noble/hashes/blake2.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { xsalsa20poly1305, hsalsa } from '@noble/ciphers/salsa.js';
import { randomBytes } from '@noble/hashes/utils.js';

const HSALSA_SIGMA = new Uint32Array([
  0x61707865,
  0x3320646e,
  0x79622d32,
  0x6b206574,
]);

const CHAT_SERVER_KEY = new Uint8Array([
  0x45, 0x0b, 0x97, 0x57, 0x35, 0x27, 0x9f, 0xde,
  0xcb, 0x33, 0x13, 0x64, 0x8f, 0x5f, 0xc6, 0xee,
  0x9f, 0xf4, 0x36, 0x0e, 0xa9, 0x2a, 0x8c, 0x17,
  0x51, 0xc6, 0x61, 0xe4, 0xc0, 0xd8, 0xc9, 0x09,
]);

const EXTENSION_MAGIC = new TextEncoder().encode('threema-clever-extension-field');

const CSP_TYPE_NAMES: Record<number, string> = {
  0x00: 'ECHO_REQUEST',
  0x01: 'OUTGOING_MESSAGE',
  0x02: 'INCOMING_MESSAGE',
  0x03: 'UNBLOCK_INCOMING_MESSAGES',
  0x80: 'ECHO_RESPONSE',
  0x81: 'OUTGOING_MESSAGE_ACK',
  0x82: 'INCOMING_MESSAGE_ACK',
  0xd0: 'QUEUE_SEND_COMPLETE',
  0xd2: 'DEVICE_COOKIE_CHANGE_INDICATION',
  0xe0: 'CLOSE_ERROR',
  0xe1: 'ALERT',
};

export interface CspHandlerOptions {
  identity: string;
  clientSecretKey: Uint8Array;
  d2mDeviceId: bigint;
  deviceCookie: Uint8Array;
  clientInfo?: string;
  sendProxyData: (data: Uint8Array) => void;
}

export interface CspContainer {
  type: number;
  data: Uint8Array;
}

export interface CspIncomingMessage {
  containerType: 0x02;
  senderIdentity: string;
  receiverIdentity?: string;
  messageId?: bigint;
  createdAt?: number;
  flags?: number;
  rawPayload: Uint8Array;
}

export interface CspOutgoingMessageAck {
  containerType: 0x81;
  identity: string;
  messageId: bigint;
  rawPayload: Uint8Array;
}

type CspState = 'idle' | 'waitingServerHello' | 'waitingLoginAck' | 'ready' | 'closed';

function pad16(s: string): Uint8Array {
  const buf = new Uint8Array(16);
  const src = new TextEncoder().encode(s);
  buf.set(src.subarray(0, 16));
  return buf;
}

function bytesToWordsLE(bytes: Uint8Array): Uint32Array {
  if (bytes.length % 4 !== 0) {
    throw new Error(`Expected length multiple of 4, got ${bytes.length}`);
  }
  const words = new Uint32Array(bytes.length / 4);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < words.length; i++) {
    words[i] = view.getUint32(i * 4, true);
  }
  return words;
}

function wordsToBytesLE(words: Uint32Array): Uint8Array {
  const out = new Uint8Array(words.length * 4);
  const view = new DataView(out.buffer);
  for (let i = 0; i < words.length; i++) {
    view.setUint32(i * 4, words[i]!, true);
  }
  return out;
}

/** NaCl crypto_box_beforenm: X25519 DH + HSalsa20 key extraction. */
function naclBoxBeforeNm(mySecret: Uint8Array, theirPublic: Uint8Array): Uint8Array {
  const shared = x25519.scalarMult(mySecret, theirPublic);
  const keyWords = bytesToWordsLE(shared);
  const inputWords = new Uint32Array(4);
  const outWords = new Uint32Array(8);
  hsalsa(HSALSA_SIGMA, keyWords, inputWords, outWords);
  return wordsToBytesLE(outWords);
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}

function previewHex(bytes: Uint8Array, limit = 24): string {
  const clipped = bytes.subarray(0, Math.min(limit, bytes.length));
  return `${toHex(clipped)}${bytes.length > limit ? '...' : ''}`;
}

function encodeU64LE(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

function decodeU64LE(bytes: Uint8Array, offset: number): bigint {
  if (offset + 8 > bytes.length) {
    throw new Error('u64 out of bounds');
  }
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(offset, true);
}

function buildNonce(cookie: Uint8Array, sequenceNumber: bigint): Uint8Array {
  if (cookie.length !== 16) {
    throw new Error(`Invalid cookie length ${cookie.length}, expected 16`);
  }
  const nonce = new Uint8Array(24);
  nonce.set(cookie, 0);
  new DataView(nonce.buffer).setBigUint64(16, sequenceNumber, true);
  return nonce;
}

function decodeIdentity(raw: Uint8Array): string {
  return new TextDecoder().decode(raw).replace(/\0+$/g, '');
}

function encodeIdentity(identity: string): Uint8Array {
  const encoded = new TextEncoder().encode(identity);
  if (encoded.length !== 8) {
    throw new Error(`Expected 8-byte identity, got ${identity} (${encoded.length} bytes)`);
  }
  return encoded;
}

function looksLikeIdentity(identity: string): boolean {
  return /^[*0-9A-Z]{8}$/.test(identity);
}

function isAllZero(bytes: Uint8Array): boolean {
  for (const byte of bytes) {
    if (byte !== 0) {
      return false;
    }
  }
  return true;
}

export class CspHandler extends EventEmitter {
  private readonly identity: string;
  private readonly identityBytes: Uint8Array;
  private readonly clientSecretKey: Uint8Array;
  private readonly d2mDeviceId: bigint;
  private readonly deviceCookie: Uint8Array;
  private readonly clientInfo: string;
  private readonly sendProxyData: (data: Uint8Array) => void;

  private state: CspState = 'idle';
  private buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

  private tckSecret: Uint8Array | null = null;
  private tckPublic: Uint8Array | null = null;
  private cck: Uint8Array | null = null;
  private sck: Uint8Array | null = null;
  private tskPublic: Uint8Array | null = null;
  private transportKey: Uint8Array | null = null;

  private csn = 1n;
  private ssn = 1n;

  constructor(options: CspHandlerOptions) {
    super();
    this.identity = options.identity;
    this.identityBytes = encodeIdentity(options.identity);
    this.clientSecretKey = options.clientSecretKey;
    this.d2mDeviceId = options.d2mDeviceId;
    this.deviceCookie = options.deviceCookie;
    this.clientInfo = options.clientInfo ?? 'OpenClaw/1.0';
    this.sendProxyData = options.sendProxyData;

    if (this.clientSecretKey.length !== 32) {
      throw new Error(`Invalid client key length ${this.clientSecretKey.length}, expected 32`);
    }
    if (this.deviceCookie.length !== 16) {
      throw new Error(`Invalid device cookie length ${this.deviceCookie.length}, expected 16`);
    }
    if (EXTENSION_MAGIC.length !== 30) {
      throw new Error(`Invalid extension magic length ${EXTENSION_MAGIC.length}, expected 30`);
    }
  }

  startHandshake(): void {
    if (this.state === 'closed') {
      throw new Error('CSP handler is closed');
    }
    if (this.state !== 'idle') {
      this.emit('log', `Handshake already started (state=${this.state})`);
      return;
    }

    this.tckSecret = randomBytes(32);
    this.tckPublic = x25519.scalarMultBase(this.tckSecret);
    this.cck = randomBytes(16);

    const clientHello = new Uint8Array(48);
    clientHello.set(this.tckPublic, 0);
    clientHello.set(this.cck, 32);

    this.state = 'waitingServerHello';
    this.sendProxyData(clientHello);
    this.emit('log', 'Sent ClientHello');
  }

  close(): void {
    this.state = 'closed';
    this.buffer = new Uint8Array(0);
  }

  isReady(): boolean {
    return this.state === 'ready';
  }

  handleProxyData(data: Uint8Array): void {
    if (this.state === 'closed') {
      return;
    }
    this.emit('log', `PROXY in len=${data.length} head=${previewHex(data)}`);
    this.buffer = concatBytes(this.buffer, data);

    try {
      this.processBufferedData();
    } catch (err) {
      this.emit('error', err);
      this.close();
    }
  }

  sendContainer(type: number, data: Uint8Array = new Uint8Array(0)): void {
    if (this.state !== 'ready') {
      throw new Error(`CSP not ready (state=${this.state})`);
    }
    const transportKey = this.requireTransportKey();

    const container = new Uint8Array(4 + data.length);
    container[0] = type;
    container.set(data, 4);

    const box = xsalsa20poly1305(transportKey, this.nextClientNonce()).encrypt(container);
    const frame = new Uint8Array(2 + box.length);
    new DataView(frame.buffer).setUint16(0, box.length, true);
    frame.set(box, 2);

    this.sendProxyData(frame);
  }

  private processBufferedData(): void {
    while (true) {
      if (this.state === 'waitingServerHello') {
        if (!this.tryConsumeServerHello()) {
          return;
        }
        continue;
      }

      if (this.state === 'waitingLoginAck') {
        if (!this.tryConsumeLoginAck()) {
          return;
        }
        continue;
      }

      if (this.state === 'ready') {
        if (!this.tryConsumePayloadFrame()) {
          return;
        }
        continue;
      }

      return;
    }
  }

  private tryConsumeServerHello(): boolean {
    if (this.buffer.length < 80) {
      return false;
    }

    const parsed = this.tryParseServerHello(this.buffer.subarray(0, 80));
    if (!parsed) {
      return false;
    }

    this.buffer = this.buffer.slice(80);
    this.completeServerHello(parsed.sck, parsed.tskPublic);
    return true;
  }

  private tryParseServerHello(serverHello: Uint8Array): { sck: Uint8Array; tskPublic: Uint8Array } | null {
    const tckSecret = this.requireTempClientSecret();
    const cck = this.requireClientCookie();

    if (serverHello.length !== 80) {
      return null;
    }

    const sck = serverHello.subarray(0, 16);
    if (equalBytes(sck, cck)) {
      throw new Error('Server cookie equals client cookie, aborting handshake');
    }

    const authKey = naclBoxBeforeNm(tckSecret, CHAT_SERVER_KEY);
    const serverChallengeResponseBox = serverHello.subarray(16, 80);
    const nonce = buildNonce(sck, this.ssn);
    const decrypted = this.tryDecrypt(serverChallengeResponseBox, nonce, authKey, 'ServerHello');
    if (!decrypted) {
      return null;
    }

    if (decrypted.length < 48) {
      throw new Error(`Invalid ServerChallengeResponse length ${decrypted.length}`);
    }

    const tskPublic = decrypted.subarray(0, 32);
    const echoedCck = decrypted.subarray(32, 48);
    if (!equalBytes(echoedCck, cck)) {
      throw new Error('Server challenge response did not echo CCK');
    }

    return {
      sck: new Uint8Array(sck),
      tskPublic: new Uint8Array(tskPublic),
    };
  }

  private completeServerHello(sck: Uint8Array, tskPublic: Uint8Array): void {
    const tckSecret = this.requireTempClientSecret();

    this.sck = sck;
    this.tskPublic = tskPublic;
    this.transportKey = naclBoxBeforeNm(tckSecret, tskPublic);
    this.ssn += 1n;

    this.sendLogin();
    this.state = 'waitingLoginAck';
    this.emit('log', 'Received ServerHello and sent Login');
  }

  private sendLogin(): void {
    const transportKey = this.requireTransportKey();
    const loginDataNonce = this.nextClientNonce();
    const extensionsNonce = this.nextClientNonce();

    const extensionsPlain = this.buildExtensionsPlaintext();
    const extensionsBox = xsalsa20poly1305(transportKey, extensionsNonce).encrypt(extensionsPlain);
    const loginDataPlain = this.buildLoginDataPlaintext(extensionsBox.length);
    const loginDataBox = xsalsa20poly1305(transportKey, loginDataNonce).encrypt(loginDataPlain);

    this.emit('log', `LoginData plaintext[0..31]=${toHex(loginDataPlain.subarray(0, 32))}`);
    this.emit(
      'log',
      `Login sizes loginDataPlain=${loginDataPlain.length} loginDataBox=${loginDataBox.length} extensionsPlain=${extensionsPlain.length} extensionsBox=${extensionsBox.length}`,
    );

    this.sendProxyData(concatBytes(loginDataBox, extensionsBox));
  }

  private buildExtensionsPlaintext(): Uint8Array {
    const clientInfoPayload = new TextEncoder().encode(this.clientInfo);
    const cspDeviceIdPayload = encodeU64LE(this.d2mDeviceId);
    const messagePayloadVersionPayload = new Uint8Array([1]);
    const deviceCookiePayload = this.deviceCookie;

    return concatBytes(
      this.encodeExtension(0x00, clientInfoPayload),
      this.encodeExtension(0x01, cspDeviceIdPayload),
      this.encodeExtension(0x02, messagePayloadVersionPayload),
      this.encodeExtension(0x03, deviceCookiePayload),
    );
  }

  private encodeExtension(type: number, payload: Uint8Array): Uint8Array {
    const ext = new Uint8Array(3 + payload.length);
    ext[0] = type;
    new DataView(ext.buffer).setUint16(1, payload.length, true);
    ext.set(payload, 3);
    return ext;
  }

  private buildLoginDataPlaintext(extensionsBoxLength: number): Uint8Array {
    if (!Number.isInteger(extensionsBoxLength) || extensionsBoxLength < 0 || extensionsBoxLength > 0xffff) {
      throw new Error(`Invalid extensions box length ${extensionsBoxLength}`);
    }

    const tckPublic = this.requireTempClientPublic();
    const tskPublic = this.requireTempServerPublic();
    const sck = this.requireServerCookie();

    const ss1 = naclBoxBeforeNm(this.clientSecretKey, CHAT_SERVER_KEY);
    const ss2 = naclBoxBeforeNm(this.clientSecretKey, tskPublic);
    const vouchKey = blake2b(new Uint8Array(0), {
      key: concatBytes(ss1, ss2),
      salt: pad16('v2'),
      personalization: pad16('3ma-csp'),
      dkLen: 32,
    });
    const vouch = blake2b(concatBytes(sck, tckPublic), {
      key: vouchKey,
      dkLen: 32,
    });

    const loginData = new Uint8Array(128);
    loginData.set(this.identityBytes, 0);
    loginData.set(EXTENSION_MAGIC, 8);
    new DataView(loginData.buffer, loginData.byteOffset, loginData.byteLength).setUint16(38, extensionsBoxLength, true);
    loginData.set(sck, 40);
    loginData.set(vouch, 80);

    if (loginData.length !== 128) {
      throw new Error(`Invalid LoginData length ${loginData.length}`);
    }

    return loginData;
  }

  private tryConsumeLoginAck(): boolean {
    const transportKey = this.requireTransportKey();
    const serverNonce = buildNonce(this.requireServerCookie(), this.ssn);
    this.emit('log', `tryConsumeLoginAck buffer=${this.buffer.length} head=${previewHex(this.buffer)} ssn=${this.ssn.toString()}`);

    if (this.buffer.length < 32) {
      return false;
    }

    const rawBox = this.buffer.subarray(0, 32);
    const rawPlain = this.tryDecrypt(rawBox, serverNonce, transportKey, 'LoginAck');
    if (!rawPlain) {
      throw new Error(`Failed to decrypt LoginAck reserved-box (ssn=${this.ssn.toString()}, head=${previewHex(rawBox)})`);
    }
    if (!this.isValidLoginAckPlain(rawPlain)) {
      throw new Error(`LoginAck plaintext invalid (len=${rawPlain.length}, head=${previewHex(rawPlain)})`);
    }

    // Parse LoginAckData: [reserved:4][current_time_utc:u64-le][queued_messages:u32-le]
    const view = new DataView(rawPlain.buffer, rawPlain.byteOffset, rawPlain.byteLength);
    const serverTime = view.getBigUint64(4, true);
    const queuedMessages = view.getUint32(12, true);
    this.emit('log', `LoginAck: serverTime=${serverTime}, queuedMessages=${queuedMessages}`);

    this.buffer = this.buffer.slice(32);
    this.ssn += 1n;
    this.finishHandshake();
    return true;
  }

  private finishHandshake(): void {
    this.state = 'ready';
    this.emit('log', 'Received LoginAck');
    this.sendContainer(0x03, new Uint8Array(0));
    this.emit('log', 'Sent UnblockIncomingMessages');
    this.emit('ready');
  }

  private isValidLoginAckPlain(plain: Uint8Array): boolean {
    // LoginAckData: [reserved: 4 bytes][current_time_utc: u64-le][queued_messages: u32-le] = 16 bytes
    if (plain.length !== 16) {
      return false;
    }
    // First 4 bytes must be zero (reserved)
    for (let i = 0; i < 4; i++) {
      if (plain[i] !== 0) return false;
    }
    return true;
  }

  private tryConsumePayloadFrame(): boolean {
    if (this.buffer.length < 2) {
      return false;
    }

    const view = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);
    const boxLength = view.getUint16(0, true);
    if (boxLength < 16) {
      throw new Error(`Invalid CSP frame length ${boxLength}`);
    }
    if (this.buffer.length < 2 + boxLength) {
      return false;
    }

    const transportKey = this.requireTransportKey();
    const box = this.buffer.subarray(2, 2 + boxLength);
    const container = xsalsa20poly1305(transportKey, this.nextServerNonce()).decrypt(box);

    this.buffer = this.buffer.slice(2 + boxLength);
    this.handlePayloadContainer(container);
    return true;
  }

  private handlePayloadContainer(container: Uint8Array): void {
    if (container.length < 4) {
      throw new Error(`CSP container too short (${container.length})`);
    }

    const type = container[0]!;
    const data = container.subarray(4);
    this.emit('container', { type, data } satisfies CspContainer);

    switch (type) {
      case 0x00:
        this.emit('log', `Echo request (${data.length} bytes)`);
        this.sendContainer(0x80, new Uint8Array(data));
        break;
      case 0x80:
        this.emit('log', `Echo response (${data.length} bytes)`);
        break;
      case 0x02: {
        const message = this.parseIncomingMessage(data);
        this.emit('message', message);

        if (message.messageId !== undefined && (message.flags === undefined || (message.flags & 0x04) === 0)) {
          this.sendMessageAck(message.senderIdentity, message.messageId);
        }
        break;
      }
      case 0x81: {
        const ack = this.parseOutgoingMessageAck(data);
        this.emit('outgoingMessageAck', ack);
        this.emit('log', `Received outgoing message ack for ${ack.identity}#${ack.messageId.toString()}`);
        break;
      }
      default:
        this.emit('log', `Received payload ${this.typeName(type)} (${data.length} bytes)`);
        break;
    }
  }

  private sendMessageAck(senderIdentity: string, messageId: bigint): void {
    const payload = new Uint8Array(16);
    payload.set(encodeIdentity(senderIdentity), 0);
    payload.set(encodeU64LE(messageId), 8);
    this.sendContainer(0x81, payload);
    this.emit('log', `Sent message ack for ${senderIdentity}#${messageId.toString()}`);
  }

  private parseOutgoingMessageAck(payload: Uint8Array): CspOutgoingMessageAck {
    if (payload.length < 16) {
      throw new Error(`Outgoing message ack payload too short (${payload.length})`);
    }

    const identity = decodeIdentity(payload.subarray(0, 8));
    const messageId = decodeU64LE(payload, 8);
    return {
      containerType: 0x81,
      identity,
      messageId,
      rawPayload: payload,
    };
  }

  private parseIncomingMessage(payload: Uint8Array): CspIncomingMessage {
    if (payload.length < 8) {
      throw new Error(`Incoming message payload too short (${payload.length})`);
    }

    const senderIdentity = decodeIdentity(payload.subarray(0, 8));
    let receiverIdentity: string | undefined;
    let cursor = 8;

    if (payload.length >= 16) {
      const maybeIdentity = decodeIdentity(payload.subarray(8, 16));
      if (looksLikeIdentity(maybeIdentity) && maybeIdentity === this.identity) {
        receiverIdentity = maybeIdentity;
        cursor = 16;
      }
    }

    let messageId: bigint | undefined;
    if (payload.length >= cursor + 8) {
      messageId = decodeU64LE(payload, cursor);
      cursor += 8;
    }

    let createdAt: number | undefined;
    if (payload.length >= cursor + 4) {
      createdAt = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(cursor, true);
      cursor += 4;
    }

    let flags: number | undefined;
    if (payload.length > cursor) {
      flags = payload[cursor]!;
    }

    return {
      containerType: 0x02,
      senderIdentity,
      receiverIdentity,
      messageId,
      createdAt,
      flags,
      rawPayload: payload,
    };
  }

  private typeName(type: number): string {
    return CSP_TYPE_NAMES[type] ?? `0x${type.toString(16)}`;
  }

  private tryDecrypt(ciphertext: Uint8Array, nonce: Uint8Array, key: Uint8Array, context = 'decrypt'): Uint8Array | null {
    try {
      return xsalsa20poly1305(key, nonce).decrypt(ciphertext);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.emit(
        'log',
        `${context} decrypt failed cipherLen=${ciphertext.length} nonce=${toHex(nonce)} head=${previewHex(ciphertext)} error=${errorMessage}`,
      );
      return null;
    }
  }

  private nextClientNonce(): Uint8Array {
    const nonce = buildNonce(this.requireClientCookie(), this.csn);
    this.csn += 1n;
    return nonce;
  }

  private nextServerNonce(): Uint8Array {
    const nonce = buildNonce(this.requireServerCookie(), this.ssn);
    this.ssn += 1n;
    return nonce;
  }

  private requireTempClientSecret(): Uint8Array {
    if (!this.tckSecret) {
      throw new Error('Temporary client secret key missing');
    }
    return this.tckSecret;
  }

  private requireTempClientPublic(): Uint8Array {
    if (!this.tckPublic) {
      throw new Error('Temporary client public key missing');
    }
    return this.tckPublic;
  }

  private requireClientCookie(): Uint8Array {
    if (!this.cck) {
      throw new Error('Client cookie missing');
    }
    return this.cck;
  }

  private requireServerCookie(): Uint8Array {
    if (!this.sck) {
      throw new Error('Server cookie missing');
    }
    return this.sck;
  }

  private requireTempServerPublic(): Uint8Array {
    if (!this.tskPublic) {
      throw new Error('Temporary server public key missing');
    }
    return this.tskPublic;
  }

  private requireTransportKey(): Uint8Array {
    if (!this.transportKey) {
      throw new Error('Transport key missing');
    }
    return this.transportKey;
  }
}
