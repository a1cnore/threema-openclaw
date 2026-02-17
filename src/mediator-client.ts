/**
 * Threema Mediator (D2M) Client
 * 
 * Connects to the Threema mediator server as a linked desktop device.
 * Handles D2M protocol: auth handshake, reflected messages, CSP proxy.
 */

import WebSocket from 'ws';
import { blake2b } from '@noble/hashes/blake2.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { xsalsa20poly1305, hsalsa } from '@noble/ciphers/salsa.js';
import { randomBytes } from '@noble/hashes/utils.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import {
  CspHandler,
  type CspContainer,
  type CspIncomingMessage,
  type CspOutgoingMessageAck,
} from './csp-handler.js';
import Long from 'long';
import {
  THREEMA_DELIVERY_RECEIPT_MESSAGE_TYPE,
  THREEMA_GROUP_DELIVERY_RECEIPT_MESSAGE_TYPE,
  THREEMA_REACTION_MESSAGE_TYPE,
  THREEMA_GROUP_REACTION_MESSAGE_TYPE,
  THREEMA_REACTION_SUPPORT_FEATURE_MASK,
  encodeDeliveryReceiptBody,
  encodeReactionMessageBody,
  isValidReactionEmojiInput,
  mapReactionToLegacyDeliveryStatus,
  parseGroupMemberContainer,
  type ThreemaReactionAction,
} from './emoji-reactions.js';
import { normalizeAudioMemoForThreema } from './media-speech.js';

// ─── D2M Payload Types ───────────────────────────────────────────────────────

const D2M = {
  PROXY:                   0x00,
  SERVER_HELLO:            0x10,
  CLIENT_HELLO:            0x11,
  SERVER_INFO:             0x12,
  REFLECTION_QUEUE_DRY:    0x20,
  ROLE_PROMOTED_TO_LEADER: 0x21,
  GET_DEVICES_INFO:        0x30,
  DEVICES_INFO:            0x31,
  DROP_DEVICE:             0x32,
  DROP_DEVICE_ACK:         0x33,
  SET_SHARED_DEVICE_DATA:  0x34,
  BEGIN_TRANSACTION:       0x40,
  BEGIN_TRANSACTION_ACK:   0x41,
  COMMIT_TRANSACTION:      0x42,
  COMMIT_TRANSACTION_ACK:  0x43,
  TRANSACTION_REJECTED:    0x44,
  TRANSACTION_ENDED:       0x45,
  REFLECT:                 0x80,
  REFLECT_ACK:             0x81,
  REFLECTED:               0x82,
  REFLECTED_ACK:           0x83,
} as const;

const D2M_TYPE_NAMES: Record<number, string> = {};
for (const [k, v] of Object.entries(D2M)) {
  D2M_TYPE_NAMES[v] = k;
}

const DIRECTORY_BASE_URL = 'https://ds-apip.threema.ch';
const DIRECTORY_USER_AGENT = 'Threema;openclaw;;D;;;';
const CSP_CONTAINER_OUTGOING_MESSAGE = 0x01;
const E2E_TEXT_MESSAGE_TYPE = 0x01;
const E2E_FILE_MESSAGE_TYPE = 0x17;
const E2E_GROUP_TEXT_MESSAGE_TYPE = 0x41;
const E2E_GROUP_FILE_MESSAGE_TYPE = 0x46;
const E2E_EDIT_MESSAGE_TYPE = 0x91;
const E2E_GROUP_EDIT_MESSAGE_TYPE = 0x93;
const E2E_TYPING_INDICATOR_MESSAGE_TYPE = 0x90;
const E2E_GROUP_SETUP_MESSAGE_TYPE = 0x4a;
const E2E_GROUP_NAME_MESSAGE_TYPE = 0x4b;
const E2E_DELIVERY_RECEIPT_MESSAGE_TYPE = THREEMA_DELIVERY_RECEIPT_MESSAGE_TYPE;
const E2E_GROUP_DELIVERY_RECEIPT_MESSAGE_TYPE = THREEMA_GROUP_DELIVERY_RECEIPT_MESSAGE_TYPE;
const E2E_REACTION_MESSAGE_TYPE = THREEMA_REACTION_MESSAGE_TYPE;
const E2E_GROUP_REACTION_MESSAGE_TYPE = THREEMA_GROUP_REACTION_MESSAGE_TYPE;
const DEFAULT_MESSAGE_FLAGS = 0x01;
const GROUP_CONTROL_MESSAGE_FLAGS = 0x00;
const TYPING_INDICATOR_MESSAGE_FLAGS = 0x06; // no queueing + no server acknowledgement
const LEGACY_STATUS_UPDATE_MESSAGE_FLAGS = 0x00;
const CSP_KEY_PERSONALIZATION = '3ma-csp';
const MESSAGE_METADATA_MIN_PADDING = 16;
const REFLECT_ACK_TIMEOUT_MS = 15_000;
const CSP_OUTGOING_ACK_TIMEOUT_MS = 20_000;
const MAX_INCOMING_MESSAGE_DEDUPE = 4_096;
const INCOMING_MESSAGE_DEDUPE_STATE_FILE = 'incoming-message-dedupe.json';
const INCOMING_MESSAGE_DEDUPE_PERSIST_EVERY = 1;
const BLOB_UPLOAD_TIMEOUT_MS = 30_000;
const BLOB_DOWNLOAD_TIMEOUT_MS = 30_000;
const DEFAULT_BLOB_SERVER_URL_TEMPLATE =
  'https://blob-mirror-{deviceGroupIdPrefix4}.threema.ch/{deviceGroupIdPrefix8}/';
const DEFAULT_PUBLIC_BLOB_UPLOAD_URL = 'https://ds-blobp-upload.threema.ch/upload';
const DEFAULT_PUBLIC_BLOB_DOWNLOAD_URL_TEMPLATE = 'https://ds-blobp-{blobIdPrefix}.threema.ch/{blobId}';
const DEFAULT_BLOB_DOWNLOAD_URL_TEMPLATE = 'https://blob-mirror-{blobIdPrefix}.threema.ch/blob/{blobId}';
const BLOB_FILE_NONCE = new Uint8Array([
  0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 1,
]);
const BLOB_THUMBNAIL_NONCE = new Uint8Array([
  0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 2,
]);

const DEFAULT_D2M_DEVICE_INFO_PADDING_BYTES = 0;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface IdentityData {
  identity: string;
  clientKey: string;        // hex
  serverGroup: string;
  deviceGroupKey: string;   // hex
  deviceCookie: string;     // hex
  contactCount: number;
  groupCount: number;
  linkedAt: string;
  deviceId?: string;        // hex u64, generated on first connect
}

export interface DeviceGroupKeys {
  dgpkSecret: Uint8Array;   // X25519 secret key for auth
  dgpkPublic: Uint8Array;   // X25519 public key (= device group ID)
  dgrk: Uint8Array;          // Reflect key (decrypt reflected envelopes)
  dgdik: Uint8Array;         // Device Info key
  dgsddk: Uint8Array;        // Shared Device Data key  
  dgtsk: Uint8Array;         // Transaction Scope key
}

export interface MediatorClientOptions {
  identity: IdentityData;
  dataDir: string;
  onEnvelope?: (envelope: any) => void;
  onCspMessage?: (message: CspIncomingMessage) => void;
}

export type DirectMediaKind = 'image' | 'audio';
type BlobScope = 'public' | 'local';
type ReactionSupport = 'supported' | 'unsupported' | 'unknown';

export type ReactionSendMode = 'reaction' | 'legacy' | 'mixed' | 'omitted';

export interface SendReactionResult {
  sent: boolean;
  mode: ReactionSendMode;
  messageId?: bigint;
  reactionRecipients?: string[];
  legacyRecipients?: string[];
  omittedRecipients?: string[];
}

export interface SendDirectMediaMessageParams {
  recipientIdentity: string;
  kind: DirectMediaKind;
  bytes: Uint8Array;
  mediaType: string;
  fileName?: string;
  caption?: string;
  durationSeconds?: number;
}

export interface SendGroupMediaMessageParams {
  groupCreator: string;
  groupId: Uint8Array;
  memberIdentities: string[];
  kind: DirectMediaKind;
  bytes: Uint8Array;
  mediaType: string;
  fileName?: string;
  caption?: string;
  durationSeconds?: number;
  requireCsp?: boolean;
}

export interface CreateGroupResult {
  groupId: Uint8Array;
  groupIdBigInt: bigint;
}

export interface CreateGroupWithMembersParams {
  name: string;
  memberIdentities: string[];
  requireCsp?: boolean;
}

export interface CreateGroupWithMembersResult extends CreateGroupResult {
  members: string[];
}

export interface DirectFileMessageDescriptor {
  renderingType: number;
  blobId: string;
  blobKey: Uint8Array;
  mediaType: string;
  fileName?: string;
  fileSize?: number;
  caption?: string;
  metadata?: Record<string, unknown>;
  correlationId?: string;
  thumbnailBlobId?: string;
  thumbnailMediaType?: string;
  rawPayload: Record<string, unknown>;
}

export interface DownloadedBlobResult {
  blobId: string;
  sourceUrl: string;
  encryptedBytes: Uint8Array;
  contentType?: string;
}

export interface ResolvedDirectFileMessage {
  descriptor: DirectFileMessageDescriptor;
  file: {
    blob: DownloadedBlobResult;
    bytes: Uint8Array;
  };
  thumbnail?: {
    blob: DownloadedBlobResult;
    bytes: Uint8Array;
  };
}

export interface ParsedGroupFileMessageDescriptor {
  creatorIdentity: string;
  groupId: bigint;
  groupIdBytes: Uint8Array;
  innerData: Uint8Array;
  descriptor: DirectFileMessageDescriptor;
}

export interface ResolvedGroupFileMessage extends ResolvedDirectFileMessage {
  creatorIdentity: string;
  groupId: bigint;
  groupIdBytes: Uint8Array;
}

interface ContactCacheEntry {
  identity: string;
  publicKey?: string;
  featureMask?: unknown;
  firstName?: string | null;
  lastName?: string | null;
  nickname?: string | null;
  [key: string]: unknown;
}

interface PendingReflectAck {
  resolve: (timestamp: bigint) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface PendingCspMessageAck {
  identity: string;
  messageId: bigint;
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface ReflectionConversation {
  contact?: string;
  group?: {
    creatorIdentity: string;
    groupId: Uint8Array;
  };
}

interface SendGroupControlMessageOptions {
  creatorIdentity: string;
  groupId: Uint8Array;
  memberIdentities: string[];
  type: number;
  body: Uint8Array;
  strictCsp: boolean;
  actionLabel: string;
}

// ─── Key Derivation ──────────────────────────────────────────────────────────

function pad16(s: string): Uint8Array {
  const buf = new Uint8Array(16);
  const src = new TextEncoder().encode(s);
  buf.set(src.subarray(0, 16));
  return buf;
}

function deriveDeviceGroupKey(dgk: Uint8Array, salt: string): Uint8Array {
  return blake2b(new Uint8Array(0), {
    key: dgk,
    salt: pad16(salt),
    personalization: pad16('3ma-mdev'),
    dkLen: 32,
  });
}

function deriveMessageMetadataKey(senderSecretKey: Uint8Array, receiverPublicKey: Uint8Array): Uint8Array {
  const sharedSecret = naclBoxBeforeNm(senderSecretKey, receiverPublicKey);
  return blake2b(new Uint8Array(0), {
    key: sharedSecret,
    salt: pad16('mm'),
    personalization: pad16(CSP_KEY_PERSONALIZATION),
    dkLen: 32,
  });
}

const HSALSA_SIGMA = new Uint32Array([
  0x61707865, // "expa"
  0x3320646e, // "nd 3"
  0x79622d32, // "2-by"
  0x6b206574, // "te k"
]);

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

export function deriveDeviceGroupKeys(dgk: Uint8Array): DeviceGroupKeys {
  const dgpkSecret = deriveDeviceGroupKey(dgk, 'p');
  const dgpkPublic = x25519.scalarMultBase(dgpkSecret);
  return {
    dgpkSecret,
    dgpkPublic,
    dgrk: deriveDeviceGroupKey(dgk, 'r'),
    dgdik: deriveDeviceGroupKey(dgk, 'di'),
    dgsddk: deriveDeviceGroupKey(dgk, 'sdd'),
    dgtsk: deriveDeviceGroupKey(dgk, 'ts'),
  };
}

// ─── NaCl crypto_box helpers ─────────────────────────────────────────────────

/** NaCl crypto_box_beforenm: X25519 DH + HSalsa20 key extraction */
function naclBoxBeforeNm(mySecret: Uint8Array, theirPublic: Uint8Array): Uint8Array {
  const shared = x25519.scalarMult(mySecret, theirPublic);
  const keyWords = bytesToWordsLE(shared);
  const inputWords = new Uint32Array(4); // 16-byte all-zero nonce input
  const outWords = new Uint32Array(8);
  hsalsa(HSALSA_SIGMA, keyWords, inputWords, outWords);
  return wordsToBytesLE(outWords);
}

/** NaCl crypto_box: XSalsa20-Poly1305 with DH key */
function naclBoxEncrypt(plaintext: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array {
  return xsalsa20poly1305(key, nonce).encrypt(plaintext);
}

function naclBoxDecrypt(ciphertext: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array {
  return xsalsa20poly1305(key, nonce).decrypt(ciphertext);
}

/** Encrypt with random nonce prefixed (24 + ciphertext bytes) */
function secretBoxEncryptWithRandomNonce(plaintext: Uint8Array, key: Uint8Array): Uint8Array {
  const nonce = randomBytes(24);
  const encrypted = xsalsa20poly1305(key, nonce).encrypt(plaintext);
  const result = new Uint8Array(24 + encrypted.length);
  result.set(nonce, 0);
  result.set(encrypted, 24);
  return result;
}

/** Decrypt with nonce-ahead format (first 24 bytes = nonce) */
function secretBoxDecryptWithNonceAhead(data: Uint8Array, key: Uint8Array): Uint8Array {
  const nonce = data.subarray(0, 24);
  const ciphertext = data.subarray(24);
  return xsalsa20poly1305(key, nonce).decrypt(ciphertext);
}

// ─── D2M Frame Encoding ─────────────────────────────────────────────────────

function encodeD2mFrame(type: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(4 + payload.length);
  frame[0] = type;
  // bytes 1-3 are reserved (zeros)
  frame.set(payload, 4);
  return frame;
}

function decodeD2mFrame(data: Uint8Array): { type: number; payload: Uint8Array } {
  return {
    type: data[0],
    payload: data.subarray(4),
  };
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function normalizeIdentity(identity: string, fieldName = 'identity'): string {
  const normalized = identity.trim().toUpperCase();
  if (!/^[*0-9A-Z]{8}$/.test(normalized)) {
    throw new Error(`Invalid ${fieldName} "${identity}" (expected 8-character Threema ID)`);
  }
  return normalized;
}

function encodeIdentity(identity: string): Uint8Array {
  const normalized = normalizeIdentity(identity);
  const encoded = textEncoder.encode(normalized);
  if (encoded.length !== 8) {
    throw new Error(`Identity must encode to exactly 8 bytes, got ${encoded.length}`);
  }
  return encoded;
}

function decodeIdentity(bytes: Uint8Array): string {
  return textDecoder.decode(bytes).replace(/\0+$/g, '');
}

function encodeTypingIndicatorBody(isTyping: boolean): Uint8Array {
  return new Uint8Array([isTyping ? 1 : 0]);
}

function decodeTypingIndicatorBody(body: Uint8Array): boolean | null {
  if (body.length !== 1) {
    return null;
  }
  if (body[0] === 1) {
    return true;
  }
  if (body[0] === 0) {
    return false;
  }
  return null;
}

function parseBlobId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(normalized)) {
    return null;
  }
  return normalized;
}

function parseBlobKey(value: unknown): Uint8Array | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    return null;
  }
  return new Uint8Array(Buffer.from(normalized, 'hex'));
}

function parseOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseOptionalObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function parseOptionalNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return undefined;
}

function parseBooleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}

function shouldForceOutboundAudioM4a(): boolean {
  return parseBooleanEnv('THREEMA_AUDIO_FORCE_M4A', true);
}

function parseRenderingType(value: unknown, deprecatedValue: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return value;
  }
  if (typeof deprecatedValue === 'number' && Number.isInteger(deprecatedValue) && deprecatedValue > 0) {
    return 1;
  }
  return 0;
}

function encodeNickname(nickname: string): Uint8Array {
  const nicknameBytes = textEncoder.encode(nickname);
  const padded = new Uint8Array(32);
  padded.set(nicknameBytes.subarray(0, 32));
  return padded;
}

function writeU32LE(buffer: Uint8Array, offset: number, value: number): void {
  new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).setUint32(offset, value, true);
}

function writeU16LE(buffer: Uint8Array, offset: number, value: number): void {
  new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).setUint16(offset, value, true);
}

function writeU64LE(buffer: Uint8Array, offset: number, value: bigint): void {
  new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).setBigUint64(offset, value, true);
}

function readU64LE(buffer: Uint8Array, offset: number): bigint {
  return new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).getBigUint64(offset, true);
}

function bytesToHex(data: Uint8Array): string {
  return Buffer.from(data).toString('hex');
}

function u64ToHexLe(value: bigint): string {
  const bytes = new Uint8Array(8);
  writeU64LE(bytes, 0, value);
  return bytesToHex(bytes);
}

// ─── Reflected structbuf decode ──────────────────────────────────────────────

interface ReflectedMessage {
  headerLength: number;
  reserved: number;
  flags: number;
  reflectedId: number;
  timestamp: bigint;
  envelope: Uint8Array;
}

function decodeReflected(data: Uint8Array): ReflectedMessage {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    headerLength: data[0],
    reserved: data[1],
    flags: view.getUint16(2, true),
    reflectedId: view.getUint32(4, true),
    timestamp: view.getBigUint64(8, true),
    envelope: data.subarray(16),
  };
}

function encodeReflectedAck(reflectedId: number): Uint8Array {
  const buf = new Uint8Array(8);
  const view = new DataView(buf.buffer);
  // bytes 0-3: reserved (zeros)
  view.setUint32(4, reflectedId, true);
  return buf;
}

// ─── Mediator Client ─────────────────────────────────────────────────────────

export class MediatorClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private identity: IdentityData;
  private keys: DeviceGroupKeys;
  private d2dRoot: any = null; // protobuf root for d2d messages
  private dataDir: string;
  private onEnvelope?: (envelope: any) => void;
  private onCspMessage?: (message: CspIncomingMessage) => void;
  private isFirstConnection: boolean;
  private deviceId: bigint;
  private csp: CspHandler | null = null;
  private leader = false;
  private readonly clientSecretKey: Uint8Array;
  private readonly contactPublicKeyCache = new Map<string, Uint8Array>();
  private readonly pendingReflectAcks = new Map<number, PendingReflectAck>();
  private readonly pendingOutgoingMessageAcks = new Map<string, PendingCspMessageAck>();
  private readonly seenIncomingMessageKeys = new Set<string>();
  private readonly seenIncomingMessageOrder: string[] = [];
  private readonly incomingMessageDedupeStatePath: string;
  private incomingMessageDedupeDirtyAdds = 0;
  private nextReflectId = 1;

  getIdentity(): string {
    return this.identity.identity;
  }

  getDataDir(): string {
    return this.dataDir;
  }

  isLeader(): boolean {
    return this.leader;
  }

  isCspReady(): boolean {
    return this.csp?.isReady() ?? false;
  }

  constructor(options: MediatorClientOptions) {
    super();
    this.identity = {
      ...options.identity,
      identity: normalizeIdentity(options.identity.identity, 'identity'),
    };
    this.dataDir = options.dataDir;
    this.incomingMessageDedupeStatePath = path.join(
      this.dataDir,
      INCOMING_MESSAGE_DEDUPE_STATE_FILE,
    );
    this.onEnvelope = options.onEnvelope;
    this.onCspMessage = options.onCspMessage;

    const dgk = new Uint8Array(Buffer.from(this.identity.deviceGroupKey, 'hex'));
    this.keys = deriveDeviceGroupKeys(dgk);
    this.clientSecretKey = new Uint8Array(Buffer.from(this.identity.clientKey, 'hex'));
    if (this.clientSecretKey.length !== 32) {
      throw new Error(`Invalid clientKey length ${this.clientSecretKey.length}, expected 32 bytes`);
    }

    // Device ID: reuse from identity or generate new
    if (this.identity.deviceId) {
      this.deviceId = BigInt('0x' + this.identity.deviceId);
      this.isFirstConnection = false;
    } else {
      const idBytes = randomBytes(8);
      this.deviceId = new DataView(idBytes.buffer).getBigUint64(0, true);
      this.isFirstConnection = true;
    }

    console.log(`[mediator] Device ID: ${this.deviceId.toString(16)}`);
    console.log(`[mediator] DGPK public: ${Buffer.from(this.keys.dgpkPublic).toString('hex')}`);
    this.loadIncomingMessageDedupeState();
  }

  async connect(): Promise<void> {
    this.leader = false;
    this.csp?.close();
    this.csp = null;
    this.rejectAllPendingOutgoingMessageAcks(new Error('Mediator reconnecting'));

    // Load protobuf types
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const protoDir = path.join(__dirname, '..', 'proto');

    const protobuf = await import('protobufjs');
    const d2dRoot = await protobuf.default.load([
      path.join(protoDir, 'md-d2d.proto'),
      path.join(protoDir, 'md-d2m.proto'),
      path.join(protoDir, 'common.proto'),
      path.join(protoDir, 'csp-e2e.proto'),
    ]);
    this.d2dRoot = d2dRoot;

    // Build WebSocket URL
    const url = this.buildMediatorUrl();
    console.log(`[mediator] Connecting to ${url}`);

    return new Promise((resolve, reject) => {
      let settled = false;
      const settleResolve = () => {
        if (settled) {
          return;
        }
        settled = true;
        this.off('serverInfo', onServerInfo);
        resolve();
      };
      const settleReject = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        this.off('serverInfo', onServerInfo);
        reject(error);
      };
      const onServerInfo = () => {
        settleResolve();
      };
      this.once('serverInfo', onServerInfo);

      this.ws = new WebSocket(url, {
        // @ts-ignore
        binaryType: 'arraybuffer',
      });

      this.ws.binaryType = 'arraybuffer';

      this.ws.on('open', () => {
        console.log('[mediator] WebSocket connected');
      });

      this.ws.on('message', (rawData: ArrayBuffer) => {
        try {
          const data = new Uint8Array(rawData);
          this.handleFrame(data);
        } catch (err) {
          console.error('[mediator] Error handling message:', err);
        }
      });

      this.ws.on('close', (code: number, reason: Buffer) => {
        const reasonText = reason.toString('utf8');
        const reasonHex = reason.toString('hex');
        console.log(`[mediator] WebSocket closed: code=${code} reason="${reasonText}" reasonHex=${reasonHex} reasonLen=${reason.length}`);
        const wasLeader = this.leader;
        this.leader = false;
        this.csp?.close();
        this.csp = null;
        if (wasLeader) {
          this.emit('leaderLost');
        }
        this.rejectAllPendingReflectAcks(new Error(`Mediator connection closed (${code} ${reasonText || 'no reason'})`));
        this.rejectAllPendingOutgoingMessageAcks(new Error(`Mediator connection closed (${code} ${reasonText || 'no reason'})`));
        this.emit('close', code, reasonText);
        settleReject(new Error(`Mediator connection closed (${code} ${reasonText || 'no reason'})`));
      });

      this.ws.on('error', (err: Error) => {
        console.error('[mediator] WebSocket error:', err.message);
        settleReject(err);
      });
    });
  }

  private buildMediatorUrl(): string {
    const dgpkPublic = this.keys.dgpkPublic;
    
    // Build ClientUrlInfo protobuf
    const ClientUrlInfo = this.d2dRoot!.lookupType('d2m.ClientUrlInfo');
    const clientUrlInfo = ClientUrlInfo.encode(ClientUrlInfo.create({
      deviceGroupId: dgpkPublic,
      serverGroup: this.identity.serverGroup,
    })).finish();

    const clientUrlInfoHex = Buffer.from(clientUrlInfo).toString('hex');

    // URL: wss://mediator-{prefix4}.threema.ch/{prefix8}/{hex(ClientUrlInfo)}
    const prefix = Buffer.from(dgpkPublic.subarray(0, 1)).toString('hex');
    const prefix4 = prefix[0]; // first nibble
    const prefix8 = prefix;    // full byte hex (2 chars)

    return `wss://mediator-${prefix4}.threema.ch/${prefix8}/${clientUrlInfoHex}`;
  }

  private handleFrame(data: Uint8Array): void {
    if (data.length < 4) {
      console.log(`[mediator] RX frame too short: ${data.length} bytes`);
      return;
    }

    const { type, payload } = decodeD2mFrame(data);
    const typeName = D2M_TYPE_NAMES[type] || `0x${type.toString(16)}`;
    console.log(`[mediator] RX frame ${typeName} (0x${type.toString(16).padStart(2, '0')}): payload=${payload.length} total=${data.length}`);

    switch (type) {
      case D2M.PROXY:
        this.handleProxyFrame(payload);
        break;
      case D2M.SERVER_HELLO:
        this.handleServerHello(payload);
        break;
      case D2M.SERVER_INFO:
        this.handleServerInfo(payload);
        break;
      case D2M.REFLECTION_QUEUE_DRY:
        console.log('[mediator] Reflection queue dry');
        this.emit('reflectionQueueDry');
        break;
      case D2M.ROLE_PROMOTED_TO_LEADER:
        console.log('[mediator] Promoted to leader — starting CSP proxy handshake');
        this.leader = true;
        this.emit('promotedToLeader');
        this.startCspProxyHandshake();
        break;
      case D2M.REFLECTED:
        this.handleReflected(payload);
        break;
      case D2M.REFLECT_ACK:
        this.handleReflectAck(payload);
        break;
      case D2M.BEGIN_TRANSACTION_ACK:
        console.log('[mediator] Transaction begun (ack)');
        break;
      case D2M.COMMIT_TRANSACTION_ACK:
        console.log('[mediator] Transaction committed (ack)');
        break;
      case D2M.TRANSACTION_REJECTED:
        console.log('[mediator] Transaction rejected');
        break;
      case D2M.TRANSACTION_ENDED:
        console.log('[mediator] Transaction ended');
        break;
      default:
        console.log(`[mediator] Unknown frame type ${typeName}: ${payload.length} bytes`);
    }
  }

  private startCspProxyHandshake(): void {
    if (this.csp) {
      this.csp.startHandshake();
      return;
    }
    if (!this.ws) {
      throw new Error('WebSocket not connected');
    }

    const deviceCookie = new Uint8Array(Buffer.from(this.identity.deviceCookie, 'hex'));

    this.csp = new CspHandler({
      identity: this.identity.identity,
      clientSecretKey: this.clientSecretKey,
      d2mDeviceId: this.deviceId,
      deviceCookie,
      sendProxyData: (data: Uint8Array) => {
        if (!this.ws) {
          throw new Error('WebSocket not connected');
        }
        this.ws.send(encodeD2mFrame(D2M.PROXY, data));
      },
    });

    this.csp.on('log', (message: string) => {
      console.log(`[csp] ${message}`);
    });

    this.csp.on('ready', () => {
      console.log('[csp] Handshake complete');
      this.emit('cspReady');
    });

    this.csp.on('container', (container: CspContainer) => {
      this.emit('cspContainer', container);
    });

    this.csp.on('message', (message: CspIncomingMessage) => {
      this.emit('cspMessage', message);
      this.onCspMessage?.(message);
      void this.handleCspIncomingMessage(message).catch((err) => {
        console.warn(`[mediator] Failed to decode CSP incoming message: ${String(err)}`);
      });
    });

    this.csp.on('outgoingMessageAck', (ack: CspOutgoingMessageAck) => {
      this.resolvePendingOutgoingMessageAck(ack);
      this.emit('cspOutgoingMessageAck', ack);
    });

    this.csp.on('error', (err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error('[csp] Handler error:', error);
      if (error.stack) {
        console.error('[csp] Handler error stack:', error.stack);
      }
      this.rejectAllPendingOutgoingMessageAcks(error);
      this.emit('cspError', error);
    });

    this.csp.startHandshake();
  }

  private handleProxyFrame(payload: Uint8Array): void {
    if (!this.csp) {
      console.log(`[mediator] Ignoring PROXY frame (${payload.length} bytes) before CSP init`);
      return;
    }
    this.csp.handleProxyData(payload);
  }

  private handleServerHello(payload: Uint8Array): void {
    const ServerHello = this.d2dRoot!.lookupType('d2m.ServerHello');
    const hello = ServerHello.decode(payload);

    console.log(`[mediator] ServerHello: version=${hello.version}, esk=${Buffer.from(hello.esk).toString('hex').slice(0, 16)}...`);

    // Compute shared key: NaCl crypto_box_beforenm(dgpkSecret, esk)
    const sharedKey = naclBoxBeforeNm(this.keys.dgpkSecret, new Uint8Array(hello.esk));

    // Encrypt challenge with random nonce
    const nonce = randomBytes(24);
    const encrypted = naclBoxEncrypt(new Uint8Array(hello.challenge), nonce, sharedKey);

    // Response = nonce || encrypted (24 + 48 = 72 bytes)
    const response = new Uint8Array(24 + encrypted.length);
    response.set(nonce, 0);
    response.set(encrypted, 24);

    // Encrypt DeviceInfo with dgdik
    const encryptedDeviceInfo = this.createEncryptedDeviceInfo();

    // Build ClientHello
    const ClientHello = this.d2dRoot!.lookupType('d2m.ClientHello');
    const clientHello = ClientHello.create({
      version: 0,
      response: response,
      deviceId: this.deviceId,
      deviceSlotsExhaustedPolicy: 0, // REJECT
      deviceSlotExpirationPolicy: 1, // PERSISTENT
      expectedDeviceSlotState: this.isFirstConnection ? 0 : 1, // NEW or EXISTING
      encryptedDeviceInfo: encryptedDeviceInfo,
    });

    const encoded = ClientHello.encode(clientHello).finish();
    const frame = encodeD2mFrame(D2M.CLIENT_HELLO, encoded);

    console.log(`[mediator] Sending ClientHello (${frame.length} bytes, deviceId=${this.deviceId.toString(16)}, slotState=${this.isFirstConnection ? 'NEW' : 'EXISTING'})`);
    this.ws!.send(frame);

    // Save device ID for next connection
    this.saveDeviceId();
  }

  private createEncryptedDeviceInfo(): Uint8Array {
    const configuredPaddingRaw = process.env.THREEMA_D2M_DEVICE_INFO_PADDING_BYTES?.trim();
    let paddingLength = DEFAULT_D2M_DEVICE_INFO_PADDING_BYTES;
    if (configuredPaddingRaw) {
      const parsedPadding = Number(configuredPaddingRaw);
      if (Number.isInteger(parsedPadding) && parsedPadding >= 0) {
        paddingLength = Math.min(parsedPadding, 64);
      } else {
        console.warn(
          `[mediator] Ignoring invalid THREEMA_D2M_DEVICE_INFO_PADDING_BYTES="${configuredPaddingRaw}" (expected non-negative integer)`,
        );
      }
    }

    const DeviceInfo = this.d2dRoot!.lookupType('d2d.DeviceInfo');
    const info = DeviceInfo.create({
      // Keep ClientHello small by default; oversized DeviceInfo can trigger server protocol-error closes.
      padding: randomBytes(paddingLength),
      platform: 3, // DESKTOP
      platformDetails: 'OpenClaw Agent on Node.js',
      appVersion: '1.0.0',
      label: 'OpenClaw',
    });
    const encoded = DeviceInfo.encode(info).finish();
    return secretBoxEncryptWithRandomNonce(encoded, this.keys.dgdik);
  }

  private handleServerInfo(payload: Uint8Array): void {
    const ServerInfo = this.d2dRoot!.lookupType('d2m.ServerInfo');
    const info = ServerInfo.decode(payload);

    const serverTime = Number(info.currentTime);
    const localTime = Date.now();
    const drift = Math.abs(serverTime - localTime);

    console.log(`[mediator] ServerInfo: maxSlots=${info.maxDeviceSlots}, slotState=${info.deviceSlotState === 0 ? 'NEW' : 'EXISTING'}, queueLen=${info.reflectionQueueLength}, timeDrift=${drift}ms`);

    if (drift > 20 * 60 * 1000) {
      console.warn('[mediator] WARNING: Clock drift exceeds 20 minutes!');
    }

    this.emit('serverInfo', info);
  }

  private handleReflected(payload: Uint8Array): void {
    const reflected = decodeReflected(payload);
    const isEphemeral = (reflected.flags & 0x0001) !== 0;

    console.log(`[mediator] Reflected: id=${reflected.reflectedId}, ts=${reflected.timestamp}, ephemeral=${isEphemeral}, envelope=${reflected.envelope.length} bytes`);

    try {
      // Decrypt envelope with DGRK
      const decrypted = secretBoxDecryptWithNonceAhead(reflected.envelope, this.keys.dgrk);

      // Decode d2d.Envelope
      const Envelope = this.d2dRoot!.lookupType('d2d.Envelope');
      const envelope = Envelope.decode(decrypted);

      const contentField = envelope.content; // oneof field name
      console.log(`[mediator] Envelope content: ${contentField}`);

      if (envelope.incomingMessage) {
        const msg = envelope.incomingMessage;
        const normalizedSenderIdentity = normalizeIdentity(
          msg.senderIdentity,
          'incomingMessage.senderIdentity',
        );
        const messageId = this.tryToBigInt(msg.messageId);
        if (messageId !== null && !this.recordIncomingMessage(normalizedSenderIdentity, messageId)) {
          console.log(
            `[mediator] Duplicate reflected incoming message skipped (ACK will still be sent): ${normalizedSenderIdentity}#${messageId.toString()}`,
          );
          return;
        }

        console.log(`[mediator] Incoming message from ${msg.senderIdentity}: type=${msg.type}, id=${msg.messageId}`);
        
        // Body is unpadded plaintext for text types (0x01=text, 0x41=group text)
        if (msg.body && msg.body.length > 0) {
          try {
            const bodyBuf = msg.body instanceof Uint8Array ? msg.body : new Uint8Array(msg.body);
            if (msg.type === 0x41 && bodyBuf.length > 16) {
              // Group text: [creatorIdentity:8][groupId:8][text]
              const creator = new TextDecoder().decode(bodyBuf.subarray(0, 8)).replace(/\0+$/g, '');
              const groupIdBytes = bodyBuf.subarray(8, 16);
              const text = new TextDecoder().decode(bodyBuf.subarray(16));
              console.log(`[mediator] Group text (creator=${creator}): "${text}"`);
            } else if (msg.type === 1) {
              const text = new TextDecoder().decode(bodyBuf);
              console.log(`[mediator] Text: "${text}"`);
            } else if (msg.type === E2E_FILE_MESSAGE_TYPE) {
              const descriptor = this.parseDirectFileMessageBody(bodyBuf);
              if (descriptor) {
                console.log(
                  `[mediator] File message: mediaType=${descriptor.mediaType} blob=${descriptor.blobId} name=${descriptor.fileName ?? 'n/a'}`,
                );
              } else {
                console.log(`[mediator] File message body: ${bodyBuf.length} bytes (unparseable)`);
              }
            } else if (msg.type === E2E_GROUP_FILE_MESSAGE_TYPE) {
              const parsed = this.parseGroupFileMessageBody(bodyBuf);
              if (parsed) {
                console.log(
                  `[mediator] Group file message: group=${parsed.creatorIdentity}/${parsed.groupId.toString()} mediaType=${parsed.descriptor.mediaType} blob=${parsed.descriptor.blobId} name=${parsed.descriptor.fileName ?? 'n/a'}`,
                );
              } else {
                console.log(`[mediator] Group file message body: ${bodyBuf.length} bytes (unparseable)`);
              }
            } else if (msg.type === E2E_TYPING_INDICATOR_MESSAGE_TYPE) {
              const isTyping = decodeTypingIndicatorBody(bodyBuf);
              if (isTyping === null) {
                console.log(
                  `[mediator] Typing indicator with invalid body (${bodyBuf.length} bytes): ${Buffer.from(bodyBuf).toString('hex')}`,
                );
              } else {
                console.log(
                  `[mediator] Typing indicator from ${msg.senderIdentity}: ${isTyping ? 'typing' : 'stopped'}`,
                );
              }
            } else {
              console.log(`[mediator] Body: type=0x${msg.type.toString(16)} ${bodyBuf.length} bytes`);
            }
          } catch { console.log(`[mediator] Body: ${msg.body.length} bytes (decode error)`); }
        }
      } else if (envelope.outgoingMessage) {
        const msg = envelope.outgoingMessage;
        const conv = msg.conversation;
        let target = 'unknown';
        if (conv?.contact) target = conv.contact;
        else if (conv?.group) target = `group:${conv.group.creatorIdentity || '?'}/${String(conv.group.groupId || '')}`;
        console.log(`[mediator] Outgoing message to ${target}: type=${msg.type}, id=${msg.messageId}`);
        if (msg.body && msg.body.length > 0) {
          try {
            const bodyBuf = msg.body instanceof Uint8Array ? msg.body : new Uint8Array(msg.body);
            if (msg.type === 0x41 && bodyBuf.length > 16) {
              const creator = new TextDecoder().decode(bodyBuf.subarray(0, 8)).replace(/\0+$/g, '');
              const text = new TextDecoder().decode(bodyBuf.subarray(16));
              console.log(`[mediator] Group text (creator=${creator}): "${text}"`);
            } else if (msg.type === 1) {
              const text = new TextDecoder().decode(bodyBuf);
              console.log(`[mediator] Text: "${text}"`);
            } else if (msg.type === E2E_FILE_MESSAGE_TYPE) {
              const descriptor = this.parseDirectFileMessageBody(bodyBuf);
              if (descriptor) {
                console.log(
                  `[mediator] Reflected file message: mediaType=${descriptor.mediaType} blob=${descriptor.blobId} name=${descriptor.fileName ?? 'n/a'}`,
                );
              } else {
                console.log(`[mediator] Reflected file message body: ${bodyBuf.length} bytes (unparseable)`);
              }
            } else if (msg.type === E2E_GROUP_FILE_MESSAGE_TYPE) {
              const parsed = this.parseGroupFileMessageBody(bodyBuf);
              if (parsed) {
                console.log(
                  `[mediator] Reflected group file message: group=${parsed.creatorIdentity}/${parsed.groupId.toString()} mediaType=${parsed.descriptor.mediaType} blob=${parsed.descriptor.blobId} name=${parsed.descriptor.fileName ?? 'n/a'}`,
                );
              } else {
                console.log(`[mediator] Reflected group file message body: ${bodyBuf.length} bytes (unparseable)`);
              }
            } else if (msg.type === E2E_TYPING_INDICATOR_MESSAGE_TYPE) {
              const isTyping = decodeTypingIndicatorBody(bodyBuf);
              if (isTyping === null) {
                console.log(
                  `[mediator] Reflected typing indicator with invalid body (${bodyBuf.length} bytes): ${Buffer.from(bodyBuf).toString('hex')}`,
                );
              } else {
                console.log(
                  `[mediator] Reflected typing indicator to ${target}: ${isTyping ? 'typing' : 'stopped'}`,
                );
              }
            } else {
              console.log(`[mediator] Body: type=0x${msg.type.toString(16)} ${bodyBuf.length} bytes`);
            }
          } catch { console.log(`[mediator] Body: ${msg.body.length} bytes (decode error)`); }
        }
      } else if (envelope.incomingMessageUpdate) {
        console.log(`[mediator] Incoming message update`);
      } else if (envelope.outgoingMessageUpdate) {
        console.log(`[mediator] Outgoing message update`);
      } else if (envelope.contactSync) {
        console.log(`[mediator] Contact sync`);
      } else if (envelope.groupSync) {
        console.log(`[mediator] Group sync`);
      } else if (envelope.settingsSync) {
        console.log(`[mediator] Settings sync`);
      } else {
        console.log(`[mediator] Other envelope type`);
      }

      this.emit('envelope', envelope);
      this.onEnvelope?.(envelope);
    } catch (err) {
      console.error(`[mediator] Failed to decrypt/decode reflected message:`, err);
    } finally {
      // Send ReflectedAck (unless ephemeral), even when duplicate handling skips processing.
      if (!isEphemeral) {
        const ack = encodeReflectedAck(reflected.reflectedId);
        const frame = encodeD2mFrame(D2M.REFLECTED_ACK, ack);
        this.ws!.send(frame);
      }
    }
  }

  private handleReflectAck(payload: Uint8Array): void {
    if (payload.length < 16) {
      console.warn(`[mediator] ReflectAck too short (${payload.length} bytes)`);
      return;
    }
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const reflectId = view.getUint32(4, true);
    const timestamp = view.getBigUint64(8, true);
    console.log(`[mediator] ReflectAck: id=${reflectId}, ts=${timestamp}`);

    const pending = this.pendingReflectAcks.get(reflectId);
    if (!pending) {
      console.warn(`[mediator] Unexpected ReflectAck for unknown id=${reflectId}`);
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingReflectAcks.delete(reflectId);
    pending.resolve(timestamp);
    this.emit('reflectAck', { reflectId, timestamp });
  }

  private async handleCspIncomingMessage(message: CspIncomingMessage): Promise<void> {
    const decoded = await this.decodeCspIncomingMessage(message.rawPayload);
    if (!decoded) {
      return;
    }

    if (!this.recordIncomingMessage(decoded.senderIdentity, decoded.messageId)) {
      console.log(
        `[mediator] Duplicate CSP incoming message skipped: ${decoded.senderIdentity}#${decoded.messageId.toString()}`,
      );
      return;
    }

    console.log(
      `[mediator] Decoded CSP incoming message from ${decoded.senderIdentity}: type=0x${decoded.type.toString(16)} id=${decoded.messageId.toString()}`,
    );

    const envelope = {
      incomingMessage: {
        senderIdentity: decoded.senderIdentity,
        receiverIdentity: decoded.receiverIdentity,
        messageId: decoded.messageId,
        createdAt: decoded.createdAtSeconds,
        flags: decoded.flags,
        type: decoded.type,
        body: decoded.body,
      },
    };

    this.emit('envelope', envelope);
    this.onEnvelope?.(envelope);
  }

  private async decodeCspIncomingMessage(payload: Uint8Array): Promise<{
    senderIdentity: string;
    receiverIdentity: string;
    messageId: bigint;
    createdAtSeconds: number;
    flags: number;
    type: number;
    body: Uint8Array;
  } | null> {
    // message-with-metadata-box header:
    // sender(8) + receiver(8) + messageId(8) + createdAt(4) + flags(1)
    // + reserved(1) + metadataLength(2) + legacyNickname(32)
    const MESSAGE_HEADER_BYTES = 64;
    const NONCE_BYTES = 24;
    const MIN_BOX_BYTES = 16; // XSalsa20-Poly1305 authentication tag
    if (payload.length < MESSAGE_HEADER_BYTES + NONCE_BYTES + MIN_BOX_BYTES) {
      return null;
    }

    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const senderIdentity = normalizeIdentity(
      decodeIdentity(payload.subarray(0, 8)),
      'cspMessage.senderIdentity',
    );
    const receiverIdentity = normalizeIdentity(
      decodeIdentity(payload.subarray(8, 16)),
      'cspMessage.receiverIdentity',
    );
    if (receiverIdentity !== this.identity.identity) {
      console.warn(
        `[mediator] Ignoring CSP message for ${receiverIdentity} (expected ${this.identity.identity})`,
      );
      return null;
    }

    const messageId = readU64LE(payload, 16);
    const createdAtSeconds = view.getUint32(24, true);
    const flags = payload[28] ?? 0;
    const metadataLength = view.getUint16(30, true);

    let offset = MESSAGE_HEADER_BYTES;
    if (payload.length < offset + metadataLength + NONCE_BYTES + MIN_BOX_BYTES) {
      return null;
    }

    const metadataContainer = payload.subarray(offset, offset + metadataLength);
    offset += metadataLength;

    const messageNonce = payload.subarray(offset, offset + NONCE_BYTES);
    offset += NONCE_BYTES;

    const messageBox = payload.subarray(offset);
    if (messageBox.length < MIN_BOX_BYTES) {
      return null;
    }

    const senderPublicKey = await this.getContactPublicKey(senderIdentity);

    if (metadataLength > 0) {
      try {
        const MessageMetadata = this.requireMessageMetadataType();
        const metadataKey = deriveMessageMetadataKey(this.clientSecretKey, senderPublicKey);
        const metadataPlain = xsalsa20poly1305(metadataKey, messageNonce).decrypt(metadataContainer);
        const metadata = MessageMetadata.decode(metadataPlain) as Record<string, unknown>;
        const metadataMessageId = this.tryToBigInt(metadata.messageId);
        if (metadataMessageId !== null && metadataMessageId !== messageId) {
          console.warn(
            `[mediator] Ignoring CSP incoming message with mismatched metadata id: header=${messageId.toString()} metadata=${metadataMessageId.toString()}`,
          );
          return null;
        }
      } catch (err) {
        console.warn(`[mediator] Failed to decrypt/decode metadata for incoming CSP message: ${String(err)}`);
        return null;
      }
    }

    let decryptedContainer: Uint8Array;
    try {
      const sharedKey = naclBoxBeforeNm(this.clientSecretKey, senderPublicKey);
      decryptedContainer = naclBoxDecrypt(messageBox, messageNonce, sharedKey);
    } catch (err) {
      console.warn(`[mediator] Failed to decrypt incoming CSP message-box: ${String(err)}`);
      return null;
    }

    if (decryptedContainer.length < 2) {
      return null;
    }

    const type = decryptedContainer[0]!;
    if (
      type !== E2E_TEXT_MESSAGE_TYPE
      && type !== E2E_FILE_MESSAGE_TYPE
      && type !== E2E_GROUP_TEXT_MESSAGE_TYPE
      && type !== E2E_GROUP_FILE_MESSAGE_TYPE
      && type !== E2E_EDIT_MESSAGE_TYPE
      && type !== E2E_GROUP_EDIT_MESSAGE_TYPE
      && type !== E2E_DELIVERY_RECEIPT_MESSAGE_TYPE
      && type !== E2E_GROUP_DELIVERY_RECEIPT_MESSAGE_TYPE
      && type !== E2E_REACTION_MESSAGE_TYPE
      && type !== E2E_GROUP_REACTION_MESSAGE_TYPE
      && type !== E2E_TYPING_INDICATOR_MESSAGE_TYPE
    ) {
      return null;
    }

    let body: Uint8Array;
    try {
      body = this.unpadMessageBody(decryptedContainer.subarray(1));
    } catch (err) {
      console.warn(`[mediator] Failed to unpad incoming CSP message body: ${String(err)}`);
      return null;
    }

    if (type === E2E_TYPING_INDICATOR_MESSAGE_TYPE) {
      const isTyping = decodeTypingIndicatorBody(body);
      if (isTyping === null) {
        console.warn(
          `[mediator] Ignoring typing indicator with invalid body (${body.length} bytes): ${Buffer.from(body).toString('hex')}`,
        );
        return null;
      }
      body = encodeTypingIndicatorBody(isTyping);
    }

    return {
      senderIdentity,
      receiverIdentity,
      messageId,
      createdAtSeconds,
      flags,
      type,
      body,
    };
  }

  private unpadMessageBody(paddedBody: Uint8Array): Uint8Array {
    if (paddedBody.length === 0) {
      throw new Error('Cannot unpad empty message body');
    }

    const padLength = paddedBody[paddedBody.length - 1]!;
    if (padLength < 1 || padLength > 255 || padLength > paddedBody.length) {
      throw new Error(`Invalid message padding length ${padLength}`);
    }

    const unpaddedLength = paddedBody.length - padLength;
    for (let i = unpaddedLength; i < paddedBody.length; i++) {
      if (paddedBody[i] !== padLength) {
        throw new Error('Invalid message padding bytes');
      }
    }

    return paddedBody.subarray(0, unpaddedLength);
  }

  private buildIncomingMessageKey(identity: string, messageId: bigint): string {
    return `${normalizeIdentity(identity, 'incomingIdentity')}#${messageId.toString()}`;
  }

  private loadIncomingMessageDedupeState(): void {
    try {
      if (!fs.existsSync(this.incomingMessageDedupeStatePath)) {
        return;
      }
      const raw = fs.readFileSync(this.incomingMessageDedupeStatePath, 'utf-8').trim();
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw) as unknown;
      const keys = Array.isArray(parsed)
        ? parsed
        : (parsed && typeof parsed === 'object' && Array.isArray((parsed as any).keys))
          ? (parsed as any).keys
          : [];
      for (const item of keys) {
        if (typeof item !== 'string') {
          continue;
        }
        const key = item.trim();
        if (!key) {
          continue;
        }
        this.rememberIncomingMessageKey(key);
      }
      if (this.seenIncomingMessageOrder.length > 0) {
        console.log(
          `[mediator] Loaded ${this.seenIncomingMessageOrder.length} incoming dedupe key(s) from disk`,
        );
      }
    } catch (err) {
      console.warn(`[mediator] Failed to load incoming message dedupe state: ${String(err)}`);
    }
  }

  private persistIncomingMessageDedupeState(force = false): void {
    if (!force && this.incomingMessageDedupeDirtyAdds <= 0) {
      return;
    }
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      const payload = {
        version: 1,
        updatedAt: new Date().toISOString(),
        keys: this.seenIncomingMessageOrder.slice(-MAX_INCOMING_MESSAGE_DEDUPE),
      };
      fs.writeFileSync(this.incomingMessageDedupeStatePath, JSON.stringify(payload, null, 2) + '\n');
      this.incomingMessageDedupeDirtyAdds = 0;
    } catch (err) {
      console.warn(`[mediator] Failed to persist incoming message dedupe state: ${String(err)}`);
    }
  }

  private rememberIncomingMessageKey(key: string): void {
    if (this.seenIncomingMessageKeys.has(key)) {
      return;
    }
    this.seenIncomingMessageKeys.add(key);
    this.seenIncomingMessageOrder.push(key);
    if (this.seenIncomingMessageOrder.length > MAX_INCOMING_MESSAGE_DEDUPE) {
      const oldest = this.seenIncomingMessageOrder.shift();
      if (oldest) {
        this.seenIncomingMessageKeys.delete(oldest);
      }
    }
  }

  private recordIncomingMessage(identity: string, messageId: bigint): boolean {
    const key = this.buildIncomingMessageKey(identity, messageId);
    if (this.seenIncomingMessageKeys.has(key)) {
      return false;
    }

    this.rememberIncomingMessageKey(key);
    this.incomingMessageDedupeDirtyAdds += 1;
    if (this.incomingMessageDedupeDirtyAdds >= INCOMING_MESSAGE_DEDUPE_PERSIST_EVERY) {
      this.persistIncomingMessageDedupeState();
    }
    return true;
  }

  private tryToBigInt(value: unknown): bigint | null {
    if (typeof value === 'bigint') {
      return value;
    }
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
      return BigInt(value);
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) {
        return null;
      }
      try {
        return BigInt(trimmed);
      } catch {
        return null;
      }
    }
    if (!value || typeof value !== 'object') {
      return null;
    }
    if (Long.isLong(value)) {
      const asLong = value as Long;
      return BigInt(asLong.toString());
    }

    const asRecord = value as Record<string, unknown>;
    const low = asRecord.low;
    const high = asRecord.high;
    if (typeof low === 'number' && typeof high === 'number') {
      return (BigInt(high >>> 0) << 32n) | BigInt(low >>> 0);
    }

    const maybeString = typeof asRecord.toString === 'function'
      ? asRecord.toString()
      : '';
    if (typeof maybeString === 'string' && /^[0-9]+$/.test(maybeString)) {
      return BigInt(maybeString);
    }

    return null;
  }

  private buildOutgoingAckKey(identity: string, messageId: bigint): string {
    return `${identity.trim().toUpperCase()}#${messageId.toString()}`;
  }

  private createOutgoingMessageAckPromise(identity: string, messageId: bigint): Promise<void> {
    const normalizedIdentity = normalizeIdentity(identity, 'ackIdentity');
    const key = this.buildOutgoingAckKey(normalizedIdentity, messageId);
    return new Promise<void>((resolve, reject) => {
      const existing = this.pendingOutgoingMessageAcks.get(key);
      if (existing) {
        clearTimeout(existing.timeout);
        existing.reject(new Error(`Replaced duplicate outgoing message ack waiter for ${key}`));
      }
      const timeout = setTimeout(() => {
        this.pendingOutgoingMessageAcks.delete(key);
        reject(new Error(`Timed out waiting for CSP OUTGOING_MESSAGE_ACK ${key}`));
      }, CSP_OUTGOING_ACK_TIMEOUT_MS);

      this.pendingOutgoingMessageAcks.set(key, {
        identity: normalizedIdentity,
        messageId,
        resolve,
        reject,
        timeout,
      });
    });
  }

  private resolvePendingOutgoingMessageAck(ack: CspOutgoingMessageAck): void {
    const key = this.buildOutgoingAckKey(ack.identity, ack.messageId);
    const pending = this.pendingOutgoingMessageAcks.get(key);
    if (!pending) {
      console.warn(`[mediator] Unexpected CSP OUTGOING_MESSAGE_ACK for ${key}`);
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingOutgoingMessageAcks.delete(key);
    pending.resolve();
  }

  private rejectPendingOutgoingMessageAck(identity: string, messageId: bigint, error: Error): void {
    const key = this.buildOutgoingAckKey(identity, messageId);
    const pending = this.pendingOutgoingMessageAcks.get(key);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pendingOutgoingMessageAcks.delete(key);
    pending.reject(error);
  }

  private rejectOutgoingMessageAcksForMessageId(messageId: bigint, error: Error): void {
    for (const [key, pending] of this.pendingOutgoingMessageAcks.entries()) {
      if (pending.messageId !== messageId) {
        continue;
      }
      clearTimeout(pending.timeout);
      this.pendingOutgoingMessageAcks.delete(key);
      pending.reject(error);
    }
  }

  private rejectAllPendingOutgoingMessageAcks(error: Error): void {
    for (const [key, pending] of this.pendingOutgoingMessageAcks.entries()) {
      clearTimeout(pending.timeout);
      this.pendingOutgoingMessageAcks.delete(key);
      pending.reject(error);
    }
  }

  async sendTextMessage(recipientIdentity: string, text: string): Promise<bigint> {
    const recipient = normalizeIdentity(recipientIdentity, 'recipientIdentity');
    if (text.length === 0) {
      throw new Error('Message text must not be empty');
    }

    // When another device currently holds leader role (common when phone app is open),
    // reflect-only still allows that leader to deliver the DM.
    if (!this.isLeader() || !this.csp || !this.csp.isReady()) {
      console.log(`[mediator] CSP not ready; reflecting DM to ${recipient} via D2M only`);
      return this.sendTextMessageViaReflect(recipient, text);
    }

    const { csp } = this.requireReadyForSending();
    const recipientPublicKey = await this.getContactPublicKey(recipient);
    const messageBody = textEncoder.encode(text);
    const { messageId, createdAtSeconds, createdAtMillis } = this.createMessageTimestamps();
    const nonce = this.createReflectionNonces(1)[0]!;

    const encrypted = this.encryptE2ePayload(
      E2E_TEXT_MESSAGE_TYPE,
      messageBody,
      recipientPublicKey,
      nonce,
    );
    const payload = this.buildOutgoingMessagePayload({
      recipientIdentity: recipient,
      recipientPublicKey,
      messageId,
      createdAtSeconds,
      createdAtMillis,
      flags: DEFAULT_MESSAGE_FLAGS,
      nonce: encrypted.nonce,
      encryptedBody: encrypted.encryptedBody,
    });

    const cspAckPromise = this.createOutgoingMessageAckPromise(recipient, messageId);
    try {
      await this.reflectOutgoingMessage({
        conversation: { contact: recipient },
        messageId,
        createdAtMillis,
        type: E2E_TEXT_MESSAGE_TYPE,
        body: messageBody,
        nonces: [encrypted.nonce],
      });
      csp.sendContainer(CSP_CONTAINER_OUTGOING_MESSAGE, payload);
      await cspAckPromise;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.rejectPendingOutgoingMessageAck(recipient, messageId, error);
      throw error;
    }

    console.log(`[mediator] Sent text message to ${recipient} (id=${messageId.toString()})`);
    return messageId;
  }

  async sendTextMessageViaReflect(recipientIdentity: string, text: string): Promise<bigint> {
    const recipient = normalizeIdentity(recipientIdentity, 'recipientIdentity');
    if (text.length === 0) {
      throw new Error('Message text must not be empty');
    }

    this.requireReadyForReflecting();

    const messageBody = textEncoder.encode(text);
    const { messageId, createdAtMillis } = this.createMessageTimestamps();
    const nonces = this.createReflectionNonces(1);
    await this.reflectOutgoingMessage({
      conversation: { contact: recipient },
      messageId,
      createdAtMillis,
      type: E2E_TEXT_MESSAGE_TYPE,
      body: messageBody,
      nonces,
    });

    console.log(`[mediator] Reflected text message to ${recipient} (id=${messageId.toString()})`);
    return messageId;
  }

  async sendDirectReaction(
    recipientIdentity: string,
    reactedMessageIdInput: bigint | string | number,
    emojiInput: string,
    action: ThreemaReactionAction,
  ): Promise<SendReactionResult> {
    const recipient = normalizeIdentity(recipientIdentity, 'recipientIdentity');
    const reactedMessageId = this.requireMessageId(reactedMessageIdInput, 'reactedMessageId');
    const emoji = this.normalizeReactionEmoji(emojiInput);

    const legacyStatus = mapReactionToLegacyDeliveryStatus(emoji, action);
    const support = this.getContactReactionSupport(recipient);
    const useLegacy = support === 'unsupported';
    if (useLegacy && legacyStatus === null) {
      console.warn(
        `[mediator] Omitting reaction for ${recipient}: receiver does not support reactions and no legacy mapping exists`,
      );
      return {
        sent: false,
        mode: 'omitted',
        omittedRecipients: [recipient],
      };
    }

    const messageType = useLegacy
      ? this.resolveDeliveryReceiptMessageType()
      : this.resolveReactionMessageType();
    const messageBody = useLegacy
      ? encodeDeliveryReceiptBody({
          status: legacyStatus!,
          messageIds: [reactedMessageId],
        })
      : encodeReactionMessageBody({
          messageId: reactedMessageId,
          action,
          emoji,
        });
    const flags = useLegacy ? LEGACY_STATUS_UPDATE_MESSAGE_FLAGS : DEFAULT_MESSAGE_FLAGS;
    const mode: ReactionSendMode = useLegacy ? 'legacy' : 'reaction';

    const { messageId, createdAtSeconds, createdAtMillis } = this.createMessageTimestamps();
    const nonces = this.createReflectionNonces(1);

    if (!this.isLeader() || !this.csp || !this.csp.isReady()) {
      this.requireReadyForReflecting();
      await this.reflectOutgoingMessage({
        conversation: { contact: recipient },
        messageId,
        createdAtMillis,
        type: messageType,
        body: messageBody,
        nonces,
      });
      console.log(
        `[mediator] CSP not ready; reflected ${mode} reaction to ${recipient} via D2M only (id=${messageId.toString()})`,
      );
      return {
        sent: true,
        mode,
        messageId,
        reactionRecipients: mode === 'reaction' ? [recipient] : [],
        legacyRecipients: mode === 'legacy' ? [recipient] : [],
      };
    }

    const { csp } = this.requireReadyForSending();
    const nonce = nonces[0]!;
    const recipientPublicKey = await this.getContactPublicKey(recipient);
    const encrypted = this.encryptE2ePayload(
      messageType,
      messageBody,
      recipientPublicKey,
      nonce,
    );
    const payload = this.buildOutgoingMessagePayload({
      recipientIdentity: recipient,
      recipientPublicKey,
      messageId,
      createdAtSeconds,
      createdAtMillis,
      flags,
      nonce: encrypted.nonce,
      encryptedBody: encrypted.encryptedBody,
    });

    const cspAckPromise = this.createOutgoingMessageAckPromise(recipient, messageId);
    try {
      await this.reflectOutgoingMessage({
        conversation: { contact: recipient },
        messageId,
        createdAtMillis,
        type: messageType,
        body: messageBody,
        nonces: [encrypted.nonce],
      });
      csp.sendContainer(CSP_CONTAINER_OUTGOING_MESSAGE, payload);
      await cspAckPromise;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.rejectPendingOutgoingMessageAck(recipient, messageId, error);
      throw error;
    }

    console.log(
      `[mediator] Sent ${mode} reaction to ${recipient} (reacted=${reactedMessageId.toString()} id=${messageId.toString()})`,
    );
    return {
      sent: true,
      mode,
      messageId,
      reactionRecipients: mode === 'reaction' ? [recipient] : [],
      legacyRecipients: mode === 'legacy' ? [recipient] : [],
    };
  }

  async sendGroupReaction(
    groupCreator: string,
    groupId: Uint8Array,
    memberIdentities: string[],
    reactedMessageIdInput: bigint | string | number,
    emojiInput: string,
    action: ThreemaReactionAction,
  ): Promise<SendReactionResult> {
    const creatorIdentity = normalizeIdentity(groupCreator, 'groupCreator');
    if (groupId.length !== 8) {
      throw new Error(`groupId must be 8 bytes, got ${groupId.length}`);
    }

    const reactedMessageId = this.requireMessageId(reactedMessageIdInput, 'reactedMessageId');
    const emoji = this.normalizeReactionEmoji(emojiInput);
    const legacyStatus = mapReactionToLegacyDeliveryStatus(emoji, action);

    const members = Array.from(
      new Set(memberIdentities.map((identity) => normalizeIdentity(identity, 'memberIdentity'))),
    ).filter((identity) => identity !== this.identity.identity);

    const canonicalReactionBody = this.buildGroupMemberContainer(
      creatorIdentity,
      groupId,
      encodeReactionMessageBody({
        messageId: reactedMessageId,
        action,
        emoji,
      }),
    );

    const reactionRecipients: string[] = [];
    const legacyRecipients: string[] = [];
    const omittedRecipients: string[] = [];
    const specificRecipientPlans: Array<{
      identity: string;
      mode: 'reaction' | 'legacy';
      messageType: number;
      messageBody: Uint8Array;
      flags: number;
    }> = [];

    const reactionMessageType = this.resolveGroupReactionMessageType();
    const legacyMessageType = this.resolveGroupDeliveryReceiptMessageType();
    const legacyGroupBody = legacyStatus === null
      ? null
      : this.buildGroupMemberContainer(
          creatorIdentity,
          groupId,
          encodeDeliveryReceiptBody({
            status: legacyStatus,
            messageIds: [reactedMessageId],
          }),
        );

    for (const memberIdentity of members) {
      const support = this.getContactReactionSupport(memberIdentity);
      if (support === 'unsupported') {
        if (legacyGroupBody) {
          legacyRecipients.push(memberIdentity);
          specificRecipientPlans.push({
            identity: memberIdentity,
            mode: 'legacy',
            messageType: legacyMessageType,
            messageBody: legacyGroupBody,
            flags: LEGACY_STATUS_UPDATE_MESSAGE_FLAGS,
          });
        } else {
          omittedRecipients.push(memberIdentity);
        }
      } else {
        reactionRecipients.push(memberIdentity);
        specificRecipientPlans.push({
          identity: memberIdentity,
          mode: 'reaction',
          messageType: reactionMessageType,
          messageBody: canonicalReactionBody,
          flags: DEFAULT_MESSAGE_FLAGS,
        });
      }
    }

    if (specificRecipientPlans.length === 0 && members.length > 0) {
      console.warn(
        `[mediator] Omitting group reaction for ${creatorIdentity}/${readU64LE(groupId, 0).toString()}: no recipients can receive this reaction`,
      );
      return {
        sent: false,
        mode: 'omitted',
        omittedRecipients,
      };
    }

    const mode: ReactionSendMode =
      legacyRecipients.length > 0
        ? (reactionRecipients.length > 0 ? 'mixed' : 'legacy')
        : 'reaction';

    const { messageId, createdAtSeconds, createdAtMillis } = this.createMessageTimestamps();
    const nonces = this.createReflectionNonces(specificRecipientPlans.length);
    const groupIdCopy = new Uint8Array(groupId);

    await this.reflectOutgoingMessage({
      conversation: {
        group: {
          creatorIdentity,
          groupId: groupIdCopy,
        },
      },
      messageId,
      createdAtMillis,
      type: reactionMessageType,
      body: canonicalReactionBody,
      nonces,
    });

    if (specificRecipientPlans.length === 0) {
      console.log(
        `[mediator] Reflected self-only group reaction (id=${messageId.toString()})`,
      );
      return {
        sent: true,
        mode,
        messageId,
        reactionRecipients,
        legacyRecipients,
        omittedRecipients,
      };
    }

    if (!this.isLeader() || !this.csp || !this.csp.isReady()) {
      console.log(
        `[mediator] CSP not ready; reflected group reaction via D2M only (id=${messageId.toString()} mode=${mode})`,
      );
      return {
        sent: true,
        mode,
        messageId,
        reactionRecipients,
        legacyRecipients,
        omittedRecipients,
      };
    }

    const { csp } = this.requireReadyForSending();
    const ackPromises: Promise<void>[] = [];

    try {
      for (const [index, recipientPlan] of specificRecipientPlans.entries()) {
        const nonce = nonces[index];
        if (!nonce) {
          throw new Error(`Missing prepared nonce for reaction recipient index ${index}`);
        }

        const recipientPublicKey = await this.getContactPublicKey(recipientPlan.identity);
        const encrypted = this.encryptE2ePayload(
          recipientPlan.messageType,
          recipientPlan.messageBody,
          recipientPublicKey,
          nonce,
        );
        const payload = this.buildOutgoingMessagePayload({
          recipientIdentity: recipientPlan.identity,
          recipientPublicKey,
          messageId,
          createdAtSeconds,
          createdAtMillis,
          flags: recipientPlan.flags,
          nonce: encrypted.nonce,
          encryptedBody: encrypted.encryptedBody,
        });

        const ackPromise = this.createOutgoingMessageAckPromise(recipientPlan.identity, messageId);
        ackPromises.push(ackPromise);
        csp.sendContainer(CSP_CONTAINER_OUTGOING_MESSAGE, payload);
      }

      await Promise.all(ackPromises);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.rejectOutgoingMessageAcksForMessageId(messageId, error);
      throw error;
    }

    console.log(
      `[mediator] Sent group reaction to ${specificRecipientPlans.length} member(s) + reflected (id=${messageId.toString()} mode=${mode})`,
    );
    return {
      sent: true,
      mode,
      messageId,
      reactionRecipients,
      legacyRecipients,
      omittedRecipients,
    };
  }

  async sendDirectMediaMessage(params: SendDirectMediaMessageParams): Promise<bigint> {
    const recipient = normalizeIdentity(params.recipientIdentity, 'recipientIdentity');
    let mediaType = params.mediaType.trim().toLowerCase();
    if (!mediaType.includes('/')) {
      throw new Error(`Invalid mediaType "${params.mediaType}"`);
    }

    let bytes = params.bytes instanceof Uint8Array ? params.bytes : new Uint8Array(params.bytes);
    if (bytes.length === 0) {
      throw new Error('Media bytes must not be empty');
    }
    let fileName = params.fileName;
    let durationSeconds = params.durationSeconds;

    if (params.kind === 'audio' && shouldForceOutboundAudioM4a()) {
      try {
        const normalizedAudio = normalizeAudioMemoForThreema({
          bytes,
          mediaType,
          fileName,
          durationSeconds,
          forceM4a: true,
        });
        if (normalizedAudio.transcoded) {
          console.log(
            `[mediator] Normalized outbound direct audio to ${normalizedAudio.mediaType}/${normalizedAudio.fileName}`,
          );
        }
        bytes = normalizedAudio.bytes;
        mediaType = normalizedAudio.mediaType;
        fileName = normalizedAudio.fileName;
        durationSeconds = normalizedAudio.durationSeconds;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`sendDirectMediaMessage: outbound audio normalization failed: ${message}`);
      }
    }

    if (!this.isLeader() || !this.csp || !this.csp.isReady()) {
      throw new Error('CSP is not ready; media messages require leader + CSP readiness');
    }

    const { csp } = this.requireReadyForSending();
    const recipientPublicKey = await this.getContactPublicKey(recipient);
    const { messageId, createdAtSeconds, createdAtMillis } = this.createMessageTimestamps();
    const nonce = this.createReflectionNonces(1)[0]!;
    const blobKey = randomBytes(32);
    const encryptedBlobBytes = this.encryptBlobWithKey(bytes, blobKey, BLOB_FILE_NONCE);
    const blobId = await this.uploadBlob({
      encryptedBytes: encryptedBlobBytes,
      scope: 'public',
      persist: false,
    });
    const messageType = this.resolveFileMessageType();
    const body = this.buildFileMessageBody({
      kind: params.kind,
      blobId,
      blobKey,
      mediaType,
      fileSize: bytes.length,
      fileName,
      caption: params.caption,
      durationSeconds,
    });

    const encrypted = this.encryptE2ePayload(
      messageType,
      body,
      recipientPublicKey,
      nonce,
    );
    const payload = this.buildOutgoingMessagePayload({
      recipientIdentity: recipient,
      recipientPublicKey,
      messageId,
      createdAtSeconds,
      createdAtMillis,
      flags: DEFAULT_MESSAGE_FLAGS,
      nonce: encrypted.nonce,
      encryptedBody: encrypted.encryptedBody,
    });

    const cspAckPromise = this.createOutgoingMessageAckPromise(recipient, messageId);
    try {
      await this.reflectOutgoingMessage({
        conversation: { contact: recipient },
        messageId,
        createdAtMillis,
        type: messageType,
        body,
        nonces: [encrypted.nonce],
      });
      csp.sendContainer(CSP_CONTAINER_OUTGOING_MESSAGE, payload);
      await cspAckPromise;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.rejectPendingOutgoingMessageAck(recipient, messageId, error);
      throw error;
    }

    console.log(
      `[mediator] Sent ${params.kind} media message to ${recipient} (id=${messageId.toString()} blob=${blobId})`,
    );
    return messageId;
  }

  async sendGroupMediaMessage(params: SendGroupMediaMessageParams): Promise<bigint> {
    const creatorIdentity = normalizeIdentity(params.groupCreator, 'groupCreator');
    const groupId = new Uint8Array(params.groupId);
    if (groupId.length !== 8) {
      throw new Error(`groupId must be 8 bytes, got ${groupId.length}`);
    }

    const members = this.normalizeGroupMembers(params.memberIdentities);
    let mediaType = params.mediaType.trim().toLowerCase();
    if (!mediaType.includes('/')) {
      throw new Error(`Invalid mediaType "${params.mediaType}"`);
    }

    let bytes = params.bytes instanceof Uint8Array ? params.bytes : new Uint8Array(params.bytes);
    if (bytes.length === 0) {
      throw new Error('Media bytes must not be empty');
    }
    let fileName = params.fileName;
    let durationSeconds = params.durationSeconds;

    if (params.kind === 'audio' && shouldForceOutboundAudioM4a()) {
      try {
        const normalizedAudio = normalizeAudioMemoForThreema({
          bytes,
          mediaType,
          fileName,
          durationSeconds,
          forceM4a: true,
        });
        if (normalizedAudio.transcoded) {
          console.log(
            `[mediator] Normalized outbound group audio to ${normalizedAudio.mediaType}/${normalizedAudio.fileName}`,
          );
        }
        bytes = normalizedAudio.bytes;
        mediaType = normalizedAudio.mediaType;
        fileName = normalizedAudio.fileName;
        durationSeconds = normalizedAudio.durationSeconds;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`sendGroupMediaMessage: outbound audio normalization failed: ${message}`);
      }
    }

    const strictCsp = params.requireCsp ?? false;
    if (strictCsp && (!this.isLeader() || !this.csp || !this.csp.isReady())) {
      throw new Error(
        'sendGroupMediaMessage: strictCsp requires leader + CSP readiness; reflection-only fallback is disabled',
      );
    }

    const messageType = this.resolveGroupFileMessageType();
    const { messageId, createdAtSeconds, createdAtMillis } = this.createMessageTimestamps();
    const blobKey = randomBytes(32);
    const encryptedBlobBytes = this.encryptBlobWithKey(bytes, blobKey, BLOB_FILE_NONCE);
    const blobId = await this.uploadBlob({
      encryptedBytes: encryptedBlobBytes,
      scope: 'public',
      persist: false,
    });
    const innerBody = this.buildFileMessageBody({
      kind: params.kind,
      blobId,
      blobKey,
      mediaType,
      fileSize: bytes.length,
      fileName,
      caption: params.caption,
      durationSeconds,
    });
    const messageBody = this.buildGroupMemberContainer(creatorIdentity, groupId, innerBody);

    if (members.length === 0) {
      this.requireReadyForReflecting();
      await this.reflectOutgoingMessage({
        conversation: {
          group: {
            creatorIdentity,
            groupId,
          },
        },
        messageId,
        createdAtMillis,
        type: messageType,
        body: messageBody,
        nonces: [],
      });
      console.log(
        `[mediator] Reflected self-only group ${params.kind} media message (id=${messageId.toString()} blob=${blobId})`,
      );
      return messageId;
    }

    const nonces = this.createReflectionNonces(members.length);
    if (!this.isLeader() || !this.csp || !this.csp.isReady()) {
      this.requireReadyForReflecting();
      await this.reflectOutgoingMessage({
        conversation: {
          group: {
            creatorIdentity,
            groupId,
          },
        },
        messageId,
        createdAtMillis,
        type: messageType,
        body: messageBody,
        nonces,
      });
      console.log(
        `[mediator] CSP not ready; reflected group ${params.kind} media to ${members.length} member(s) via D2M only (id=${messageId.toString()} blob=${blobId})`,
      );
      return messageId;
    }

    const { csp } = this.requireReadyForSending();
    await this.reflectOutgoingMessage({
      conversation: {
        group: {
          creatorIdentity,
          groupId,
        },
      },
      messageId,
      createdAtMillis,
      type: messageType,
      body: messageBody,
      nonces,
    });

    const ackPromises: Promise<void>[] = [];
    try {
      for (const [index, memberIdentity] of members.entries()) {
        const nonce = nonces[index];
        if (!nonce) {
          throw new Error(`Missing prepared nonce for member index ${index}`);
        }
        const recipientPublicKey = await this.getContactPublicKey(memberIdentity);
        const encrypted = this.encryptE2ePayload(
          messageType,
          messageBody,
          recipientPublicKey,
          nonce,
        );
        const payload = this.buildOutgoingMessagePayload({
          recipientIdentity: memberIdentity,
          recipientPublicKey,
          messageId,
          createdAtSeconds,
          createdAtMillis,
          flags: DEFAULT_MESSAGE_FLAGS,
          nonce: encrypted.nonce,
          encryptedBody: encrypted.encryptedBody,
        });

        const ackPromise = this.createOutgoingMessageAckPromise(memberIdentity, messageId);
        ackPromises.push(ackPromise);
        csp.sendContainer(CSP_CONTAINER_OUTGOING_MESSAGE, payload);
      }
      await Promise.all(ackPromises);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.rejectOutgoingMessageAcksForMessageId(messageId, error);
      throw error;
    }

    console.log(
      `[mediator] Sent group ${params.kind} media message to ${members.length} member(s) + reflected (id=${messageId.toString()} blob=${blobId})`,
    );
    return messageId;
  }

  parseDirectFileMessageBody(body: Uint8Array): DirectFileMessageDescriptor | null {
    if (!body || body.length === 0) {
      return null;
    }

    let parsedUnknown: unknown;
    try {
      parsedUnknown = JSON.parse(textDecoder.decode(body));
    } catch {
      return null;
    }
    if (!parsedUnknown || typeof parsedUnknown !== 'object' || Array.isArray(parsedUnknown)) {
      return null;
    }

    const parsed = parsedUnknown as Record<string, unknown>;
    const blobId = parseBlobId(parsed.b);
    const blobKey = parseBlobKey(parsed.k);
    if (!blobId || !blobKey) {
      return null;
    }

    const descriptor: DirectFileMessageDescriptor = {
      renderingType: parseRenderingType(parsed.j, parsed.i),
      blobId,
      blobKey,
      mediaType: parseOptionalString(parsed.m) ?? 'application/octet-stream',
      fileName: parseOptionalString(parsed.n),
      fileSize: parseOptionalNonNegativeNumber(parsed.s),
      caption: parseOptionalString(parsed.d),
      metadata: parseOptionalObject(parsed.x),
      correlationId: parseOptionalString(parsed.c),
      rawPayload: parsed,
    };

    const thumbnailBlobId = parseBlobId(parsed.t);
    if (thumbnailBlobId) {
      descriptor.thumbnailBlobId = thumbnailBlobId;
      descriptor.thumbnailMediaType = parseOptionalString(parsed.p) ?? 'image/jpeg';
    }

    return descriptor;
  }

  parseGroupFileMessageBody(body: Uint8Array): ParsedGroupFileMessageDescriptor | null {
    if (!body || body.length < 16) {
      return null;
    }

    const container = parseGroupMemberContainer(body);
    if (!container) {
      return null;
    }

    let creatorIdentity: string;
    try {
      creatorIdentity = normalizeIdentity(container.creatorIdentityRaw, 'groupCreator');
    } catch {
      return null;
    }

    const descriptor = this.parseDirectFileMessageBody(container.innerData);
    if (!descriptor) {
      return null;
    }

    return {
      creatorIdentity,
      groupId: container.groupId,
      groupIdBytes: new Uint8Array(container.groupIdBytes),
      innerData: new Uint8Array(container.innerData),
      descriptor,
    };
  }

  async resolveDirectFileMessageBody(body: Uint8Array): Promise<ResolvedDirectFileMessage | null> {
    const descriptor = this.parseDirectFileMessageBody(body);
    if (!descriptor) {
      return null;
    }

    const fileBlob = await this.downloadBlobByScopeFallback(descriptor.blobId);
    const fileBytes = this.decryptBlobWithKey(
      fileBlob.encryptedBytes,
      descriptor.blobKey,
      BLOB_FILE_NONCE,
    );

    let thumbnail:
      | {
          blob: DownloadedBlobResult;
          bytes: Uint8Array;
        }
      | undefined;
    if (descriptor.thumbnailBlobId) {
      try {
        const thumbnailBlob = await this.downloadBlobByScopeFallback(descriptor.thumbnailBlobId);
        const thumbnailBytes = this.decryptBlobWithKey(
          thumbnailBlob.encryptedBytes,
          descriptor.blobKey,
          BLOB_THUMBNAIL_NONCE,
        );
        thumbnail = {
          blob: thumbnailBlob,
          bytes: thumbnailBytes,
        };
      } catch (err) {
        console.warn(
          `[mediator] Failed to download/decrypt thumbnail blob ${descriptor.thumbnailBlobId}: ${String(err)}`,
        );
      }
    }

    return {
      descriptor,
      file: {
        blob: fileBlob,
        bytes: fileBytes,
      },
      thumbnail,
    };
  }

  async resolveGroupFileMessageBody(body: Uint8Array): Promise<ResolvedGroupFileMessage | null> {
    const parsed = this.parseGroupFileMessageBody(body);
    if (!parsed) {
      return null;
    }

    const resolved = await this.resolveDirectFileMessageBody(parsed.innerData);
    if (!resolved) {
      return null;
    }

    return {
      creatorIdentity: parsed.creatorIdentity,
      groupId: parsed.groupId,
      groupIdBytes: parsed.groupIdBytes,
      ...resolved,
    };
  }

  async sendTypingIndicator(
    recipientIdentity: string,
    isTyping: boolean,
  ): Promise<{ sent: boolean; reason?: string }> {
    const recipient = normalizeIdentity(recipientIdentity, 'recipientIdentity');
    if (!this.isLeader() || !this.csp || !this.csp.isReady()) {
      return { sent: false, reason: 'csp_not_ready' };
    }

    const { csp } = this.requireReadyForSending();
    const recipientPublicKey = await this.getContactPublicKey(recipient);
    const { messageId, createdAtSeconds, createdAtMillis } = this.createMessageTimestamps();
    const nonce = randomBytes(24);
    const typingBody = encodeTypingIndicatorBody(isTyping);
    const type = this.resolveTypingMessageType();

    const encrypted = this.encryptE2ePayload(
      type,
      typingBody,
      recipientPublicKey,
      nonce,
    );
    const payload = this.buildOutgoingMessagePayload({
      recipientIdentity: recipient,
      recipientPublicKey,
      messageId,
      createdAtSeconds,
      createdAtMillis,
      flags: TYPING_INDICATOR_MESSAGE_FLAGS,
      nonce: encrypted.nonce,
      encryptedBody: encrypted.encryptedBody,
    });

    csp.sendContainer(CSP_CONTAINER_OUTGOING_MESSAGE, payload);
    return { sent: true };
  }

  /**
   * Create a new group (self-only "notes" group).
   * Sends group-setup (0x4A) and group-name (0x4B) messages via reflection.
   * Returns { groupId, groupIdBigInt } for the newly created group.
   */
  async createGroup(name: string): Promise<CreateGroupResult> {
    this.requireReadyForReflecting();
    if (!this.d2dRoot) {
      throw new Error('D2D protobuf types are not loaded');
    }
    const groupName = name.trim();
    if (groupName.length === 0) {
      throw new Error('Group name must not be empty');
    }

    // Generate random 8-byte group ID
    const groupId = randomBytes(8);
    const groupIdBigInt = readU64LE(groupId, 0);
    const creatorIdentity = this.identity.identity;
    const { groupSetupType, groupNameType } = this.requireGroupControlMessageTypes();

    // GroupCreatorContainer(groupId + inner-data) with empty member list.
    const setupBody = this.buildGroupCreatorContainer(groupId, new Uint8Array(0));
    await this.sendGroupControlMessageToMembers({
      creatorIdentity,
      groupId,
      memberIdentities: [],
      type: groupSetupType,
      body: setupBody,
      strictCsp: false,
      actionLabel: 'GROUP_SETUP',
    });

    // GroupCreatorContainer(groupId + UTF-8 name bytes).
    const nameBody = this.buildGroupCreatorContainer(groupId, textEncoder.encode(groupName));
    await this.sendGroupControlMessageToMembers({
      creatorIdentity,
      groupId,
      memberIdentities: [],
      type: groupNameType,
      body: nameBody,
      strictCsp: false,
      actionLabel: 'GROUP_NAME',
    });

    console.log(`[mediator] createGroup: Group "${groupName}" created (creator=${creatorIdentity}, gid=${groupIdBigInt})`);
    return { groupId, groupIdBigInt };
  }

  /**
   * Create a real group with explicit members (non-self recipients).
   * In strict mode, requires leader + CSP and verifies server ACKs per member.
   */
  async createGroupWithMembers(
    params: CreateGroupWithMembersParams,
  ): Promise<CreateGroupWithMembersResult> {
    this.requireReadyForReflecting();
    if (!this.d2dRoot) {
      throw new Error('D2D protobuf types are not loaded');
    }

    const groupName = params.name.trim();
    if (groupName.length === 0) {
      throw new Error('Group name must not be empty');
    }

    const members = this.normalizeGroupMembers(params.memberIdentities);
    if (members.length === 0) {
      throw new Error('Group must include at least one non-self member');
    }

    const strictCsp = params.requireCsp ?? false;
    if (strictCsp) {
      this.requireReadyForSending();
    }

    // Generate random 8-byte group ID.
    const groupId = randomBytes(8);
    const groupIdBigInt = readU64LE(groupId, 0);
    const creatorIdentity = this.identity.identity;
    const { groupSetupType, groupNameType } = this.requireGroupControlMessageTypes();

    // Vendor parity:
    // - csp.struct.yml: `group-setup.members` is `b8[]` (8-byte IDs, creator excluded)
    // - common.proto: GROUP_SETUP=0x4a and GROUP_NAME=0x4b
    const setupBody = this.buildGroupCreatorContainer(groupId, this.encodeGroupSetupMembers(members));
    await this.sendGroupControlMessageToMembers({
      creatorIdentity,
      groupId,
      memberIdentities: members,
      type: groupSetupType,
      body: setupBody,
      strictCsp,
      actionLabel: 'GROUP_SETUP',
    });

    const nameBody = this.buildGroupCreatorContainer(groupId, textEncoder.encode(groupName));
    await this.sendGroupControlMessageToMembers({
      creatorIdentity,
      groupId,
      memberIdentities: members,
      type: groupNameType,
      body: nameBody,
      strictCsp,
      actionLabel: 'GROUP_NAME',
    });

    console.log(
      `[mediator] createGroupWithMembers: Group "${groupName}" created (creator=${creatorIdentity}, gid=${groupIdBigInt}, members=${members.length}, strictCsp=${strictCsp})`,
    );
    return { groupId, groupIdBigInt, members };
  }

  async sendGroupTextMessage(
    groupCreator: string,
    groupId: Uint8Array,
    memberIdentities: string[],
    text: string,
    options?: { requireCsp?: boolean },
  ): Promise<bigint> {
    const creatorIdentity = normalizeIdentity(groupCreator, 'groupCreator');
    if (groupId.length !== 8) {
      throw new Error(`groupId must be 8 bytes, got ${groupId.length}`);
    }
    if (text.length === 0) {
      throw new Error('Message text must not be empty');
    }

    const members = Array.from(
      new Set(memberIdentities.map((identity) => normalizeIdentity(identity, 'memberIdentity'))),
    ).filter((identity) => identity !== this.identity.identity);
    const strictCsp = options?.requireCsp ?? false;

    const { messageId, createdAtSeconds, createdAtMillis } = this.createMessageTimestamps();
    const messageBody = this.buildGroupTextBody(creatorIdentity, groupId, text);
    const groupIdCopy = new Uint8Array(groupId);

    if (members.length === 0) {
      this.requireReadyForReflecting();
      await this.reflectOutgoingMessage({
        conversation: {
          group: {
            creatorIdentity,
            groupId: groupIdCopy,
          },
        },
        messageId,
        createdAtMillis,
        type: E2E_GROUP_TEXT_MESSAGE_TYPE,
        body: messageBody,
        nonces: [],
      });

      console.log(
        `[mediator] Reflected self-only group text message (id=${messageId.toString()})`,
      );
      return messageId;
    }

    const nonces = this.createReflectionNonces(members.length);
    if (strictCsp && (!this.isLeader() || !this.csp || !this.csp.isReady())) {
      throw new Error(
        'sendGroupTextMessage: strictCsp requires leader + CSP readiness; reflection-only fallback is disabled',
      );
    }

    if (!this.isLeader() || !this.csp || !this.csp.isReady()) {
      this.requireReadyForReflecting();
      await this.reflectOutgoingMessage({
        conversation: {
          group: {
            creatorIdentity,
            groupId: groupIdCopy,
          },
        },
        messageId,
        createdAtMillis,
        type: E2E_GROUP_TEXT_MESSAGE_TYPE,
        body: messageBody,
        nonces,
      });
      console.log(
        `[mediator] CSP not ready; reflected group text to ${members.length} member(s) via D2M only (id=${messageId.toString()})`,
      );
      return messageId;
    }

    const { csp } = this.requireReadyForSending();

    await this.reflectOutgoingMessage({
      conversation: {
        group: {
          creatorIdentity,
          groupId: groupIdCopy,
        },
      },
      messageId,
      createdAtMillis,
      type: E2E_GROUP_TEXT_MESSAGE_TYPE,
      body: messageBody,
      nonces,
    });

    const ackPromises: Promise<void>[] = [];

    // Send CSP messages to other members (skip for notes/self-only groups)
    try {
      for (const [index, memberIdentity] of members.entries()) {
        const nonce = nonces[index];
        if (!nonce) {
          throw new Error(`Missing prepared nonce for member index ${index}`);
        }
        const recipientPublicKey = await this.getContactPublicKey(memberIdentity);
        const encrypted = this.encryptE2ePayload(
          E2E_GROUP_TEXT_MESSAGE_TYPE,
          messageBody,
          recipientPublicKey,
          nonce,
        );
        const payload = this.buildOutgoingMessagePayload({
          recipientIdentity: memberIdentity,
          recipientPublicKey,
          messageId,
          createdAtSeconds,
          createdAtMillis,
          // Vendor parity: csp.struct.yml defines group-setup/group-name "Flags: None".
          flags: GROUP_CONTROL_MESSAGE_FLAGS,
          nonce: encrypted.nonce,
          encryptedBody: encrypted.encryptedBody,
        });

        const ackPromise = this.createOutgoingMessageAckPromise(memberIdentity, messageId);
        ackPromises.push(ackPromise);
        csp.sendContainer(CSP_CONTAINER_OUTGOING_MESSAGE, payload);
      }
      await Promise.all(ackPromises);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.rejectOutgoingMessageAcksForMessageId(messageId, error);
      throw error;
    }

    console.log(
      `[mediator] Sent group text message to ${members.length} member(s) + reflected (id=${messageId.toString()})`,
    );
    return messageId;
  }

  async sendGroupEditMessage(
    groupCreator: string,
    groupId: Uint8Array,
    memberIdentities: string[],
    editedMessageIdInput: bigint | string | number,
    text: string,
    options?: { requireCsp?: boolean },
  ): Promise<bigint> {
    const creatorIdentity = normalizeIdentity(groupCreator, 'groupCreator');
    if (groupId.length !== 8) {
      throw new Error(`groupId must be 8 bytes, got ${groupId.length}`);
    }

    const editedMessageId = this.requireMessageId(editedMessageIdInput, 'editedMessageId');
    if (text.length === 0) {
      throw new Error('Edit text must not be empty');
    }
    const textBytes = textEncoder.encode(text);
    if (textBytes.length > 6000) {
      throw new Error(`Edit text must be <= 6000 bytes, got ${textBytes.length}`);
    }

    const members = this.normalizeGroupMembers(memberIdentities);
    const strictCsp = options?.requireCsp ?? false;
    const groupEditType = this.resolveGroupEditMessageType();
    const body = this.buildGroupMemberContainer(
      creatorIdentity,
      groupId,
      this.encodeEditMessageBody({
        editedMessageId,
        text,
      }),
    );

    const messageId = await this.sendGroupControlMessageToMembers({
      creatorIdentity,
      groupId,
      memberIdentities: members,
      type: groupEditType,
      body,
      strictCsp,
      actionLabel: 'GROUP_EDIT_MESSAGE',
    });

    console.log(
      `[mediator] GROUP_EDIT_MESSAGE: target=${editedMessageId.toString()} sent id=${messageId.toString()} strictCsp=${strictCsp}`,
    );
    return messageId;
  }

  private createMessageTimestamps(): { messageId: bigint; createdAtSeconds: number; createdAtMillis: bigint } {
    const nowMillis = Date.now();
    return {
      messageId: this.generateMessageId(),
      createdAtSeconds: Math.floor(nowMillis / 1000),
      createdAtMillis: BigInt(nowMillis),
    };
  }

  private generateMessageId(): bigint {
    while (true) {
      const random = randomBytes(8);
      const id = readU64LE(random, 0);
      if (id !== 0n) {
        return id;
      }
    }
  }

  private requireGroupControlMessageTypes(): { groupSetupType: number; groupNameType: number } {
    const groupSetupType = this.requireCspE2eMessageType('GROUP_SETUP');
    const groupNameType = this.requireCspE2eMessageType('GROUP_NAME');
    if (
      groupSetupType !== E2E_GROUP_SETUP_MESSAGE_TYPE
      || groupNameType !== E2E_GROUP_NAME_MESSAGE_TYPE
    ) {
      throw new Error(
        `Unexpected CspE2eMessageType values (GROUP_SETUP=${groupSetupType}, GROUP_NAME=${groupNameType})`,
      );
    }
    return { groupSetupType, groupNameType };
  }

  private normalizeGroupMembers(memberIdentities: string[]): string[] {
    return Array.from(
      new Set(memberIdentities.map((identity) => normalizeIdentity(identity, 'memberIdentity'))),
    ).filter((identity) => identity !== this.identity.identity);
  }

  private encodeGroupSetupMembers(memberIdentities: string[]): Uint8Array {
    // Vendor parity reference:
    // csp.struct.yml `group-setup.members` is encoded as `b8[]`.
    const body = new Uint8Array(memberIdentities.length * 8);
    for (const [index, memberIdentity] of memberIdentities.entries()) {
      body.set(encodeIdentity(memberIdentity), index * 8);
    }
    return body;
  }

  private async sendGroupControlMessageToMembers(options: SendGroupControlMessageOptions): Promise<bigint> {
    const creatorIdentity = normalizeIdentity(options.creatorIdentity, 'groupCreator');
    const groupId = new Uint8Array(options.groupId);
    if (groupId.length !== 8) {
      throw new Error(`groupId must be 8 bytes, got ${groupId.length}`);
    }

    const members = this.normalizeGroupMembers(options.memberIdentities);
    const { messageId, createdAtSeconds, createdAtMillis } = this.createMessageTimestamps();

    if (members.length === 0) {
      this.requireReadyForReflecting();
      await this.reflectOutgoingMessage({
        conversation: {
          group: {
            creatorIdentity,
            groupId,
          },
        },
        messageId,
        createdAtMillis,
        type: options.type,
        body: options.body,
        nonces: [],
      });

      console.log(
        `[mediator] ${options.actionLabel}: reflected self-only group control (id=${messageId.toString()})`,
      );
      return messageId;
    }

    const cspReady = this.isLeader() && this.csp?.isReady();
    if (options.strictCsp && !cspReady) {
      throw new Error(
        `${options.actionLabel}: strictCsp requires leader + CSP readiness; reflection-only fallback is disabled`,
      );
    }

    const nonces = this.createReflectionNonces(members.length);
    if (!cspReady) {
      this.requireReadyForReflecting();
      await this.reflectOutgoingMessage({
        conversation: {
          group: {
            creatorIdentity,
            groupId,
          },
        },
        messageId,
        createdAtMillis,
        type: options.type,
        body: options.body,
        nonces,
      });

      console.log(
        `[mediator] ${options.actionLabel}: CSP not ready; reflected group control to ${members.length} member(s) via D2M only (id=${messageId.toString()})`,
      );
      return messageId;
    }

    const { csp } = this.requireReadyForSending();
    await this.reflectOutgoingMessage({
      conversation: {
        group: {
          creatorIdentity,
          groupId,
        },
      },
      messageId,
      createdAtMillis,
      type: options.type,
      body: options.body,
      nonces,
    });

    const ackPromises: Promise<void>[] = [];
    try {
      for (const [index, memberIdentity] of members.entries()) {
        const nonce = nonces[index];
        if (!nonce) {
          throw new Error(`Missing prepared nonce for member index ${index}`);
        }
        const recipientPublicKey = await this.getContactPublicKey(memberIdentity);
        const encrypted = this.encryptE2ePayload(
          options.type,
          options.body,
          recipientPublicKey,
          nonce,
        );
        const payload = this.buildOutgoingMessagePayload({
          recipientIdentity: memberIdentity,
          recipientPublicKey,
          messageId,
          createdAtSeconds,
          createdAtMillis,
          flags: DEFAULT_MESSAGE_FLAGS,
          nonce: encrypted.nonce,
          encryptedBody: encrypted.encryptedBody,
        });

        const ackPromise = this.createOutgoingMessageAckPromise(memberIdentity, messageId);
        ackPromises.push(ackPromise);
        csp.sendContainer(CSP_CONTAINER_OUTGOING_MESSAGE, payload);
      }
      await Promise.all(ackPromises);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.rejectOutgoingMessageAcksForMessageId(messageId, error);
      throw error;
    }

    console.log(
      `[mediator] ${options.actionLabel}: sent to ${members.length} member(s) + reflected (id=${messageId.toString()}, strictCsp=${options.strictCsp})`,
    );
    return messageId;
  }

  private createReflectionNonces(count: number): Uint8Array[] {
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(`Invalid nonce count ${count}`);
    }
    return Array.from({ length: count }, () => randomBytes(24));
  }

  /** Wait up to `timeoutMs` for leader promotion AND CSP ready. */
  async waitForLeaderAndCsp(timeoutMs = 60000): Promise<void> {
    if (this.isLeader() && this.csp?.isReady()) return;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeListener('cspReady', onReady);
        reject(new Error(`Leader/CSP ready timeout after ${timeoutMs}ms — phone may be holding leader role`));
      }, timeoutMs);
      const onReady = () => { clearTimeout(timer); resolve(); };
      this.once('cspReady', onReady);
    });
  }

  /** Wait up to `timeoutMs` for CSP to become ready. */
  async waitForCspReady(timeoutMs = 30000): Promise<void> {
    if (this.csp?.isReady()) return;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeListener('cspReady', onReady);
        reject(new Error('CSP ready timeout'));
      }, timeoutMs);
      const onReady = () => { clearTimeout(timer); resolve(); };
      this.once('cspReady', onReady);
    });
  }

  private requireReadyForReflecting(): { ws: WebSocket } {
    if (!this.ws) {
      throw new Error('Mediator WebSocket is not connected');
    }
    return { ws: this.ws };
  }

  private requireReadyForSending(): { ws: WebSocket; csp: CspHandler } {
    const { ws } = this.requireReadyForReflecting();
    if (!this.csp || !this.csp.isReady()) {
      throw new Error('CSP is not ready yet');
    }
    return { ws, csp: this.csp };
  }

  private buildOutgoingMessagePayload(options: {
    recipientIdentity: string;
    recipientPublicKey: Uint8Array;
    messageId: bigint;
    createdAtSeconds: number;
    createdAtMillis: bigint;
    flags: number;
    nickname?: string;
    nonce: Uint8Array;
    encryptedBody: Uint8Array;
  }): Uint8Array {
    const senderIdentityBytes = encodeIdentity(this.identity.identity);
    const recipientIdentityBytes = encodeIdentity(options.recipientIdentity);
    if (options.recipientPublicKey.length !== 32) {
      throw new Error(`Recipient public key must be 32 bytes, got ${options.recipientPublicKey.length}`);
    }
    if (options.nonce.length !== 24) {
      throw new Error(`Expected 24-byte nonce, got ${options.nonce.length}`);
    }

    const metadataContainer = this.encryptMessageMetadata({
      recipientPublicKey: options.recipientPublicKey,
      messageId: options.messageId,
      createdAtMillis: options.createdAtMillis,
      nickname: options.nickname,
      nonce: options.nonce,
    });
    if (metadataContainer.length > 0xffff) {
      throw new Error(`Metadata container too large (${metadataContainer.length} bytes)`);
    }

    const legacySenderNickname =
      options.nickname !== undefined && options.recipientIdentity.startsWith('*')
        ? encodeNickname(options.nickname)
        : new Uint8Array(32);

    const payload = new Uint8Array(
      8 + 8 + 8 + 4 + 1 + 1 + 2 + 32 + metadataContainer.length + 24 + options.encryptedBody.length,
    );
    let offset = 0;

    payload.set(senderIdentityBytes, offset);
    offset += 8;

    payload.set(recipientIdentityBytes, offset);
    offset += 8;

    writeU64LE(payload, offset, options.messageId);
    offset += 8;

    writeU32LE(payload, offset, options.createdAtSeconds >>> 0);
    offset += 4;

    payload[offset] = options.flags & 0xff;
    offset += 1;

    payload[offset] = 0x00; // reserved
    offset += 1;

    writeU16LE(payload, offset, metadataContainer.length);
    offset += 2;

    payload.set(legacySenderNickname, offset);
    offset += 32;

    payload.set(metadataContainer, offset);
    offset += metadataContainer.length;

    payload.set(options.nonce, offset);
    offset += 24;

    payload.set(options.encryptedBody, offset);
    return payload;
  }

  private encryptMessageMetadata(options: {
    recipientPublicKey: Uint8Array;
    messageId: bigint;
    createdAtMillis: bigint;
    nickname?: string;
    nonce: Uint8Array;
  }): Uint8Array {
    const plaintext = this.encodeMessageMetadata({
      messageId: options.messageId,
      createdAtMillis: options.createdAtMillis,
      nickname: options.nickname,
    });
    const key = deriveMessageMetadataKey(this.clientSecretKey, options.recipientPublicKey);
    return xsalsa20poly1305(key, options.nonce).encrypt(plaintext);
  }

  private encodeMessageMetadata(options: {
    messageId: bigint;
    createdAtMillis: bigint;
    nickname?: string;
  }): Uint8Array {
    const MessageMetadata = this.requireMessageMetadataType();
    const nicknameLength = options.nickname === undefined ? 0 : textEncoder.encode(options.nickname).length;

    const metadata: Record<string, unknown> = {
      padding: new Uint8Array(Math.max(0, MESSAGE_METADATA_MIN_PADDING - nicknameLength)),
      messageId: Long.fromString(options.messageId.toString(), true),
      createdAt: Long.fromString(options.createdAtMillis.toString(), true),
    };
    if (options.nickname !== undefined) {
      metadata.nickname = options.nickname;
    }

    return MessageMetadata.encode(MessageMetadata.create(metadata)).finish();
  }

  private requireMessageMetadataType(): any {
    if (!this.d2dRoot) {
      throw new Error('D2D protobuf types are not loaded');
    }
    const MessageMetadata = this.d2dRoot.lookupType('csp_e2e.MessageMetadata');
    if (!MessageMetadata) {
      throw new Error('csp_e2e.MessageMetadata type is not available');
    }
    return MessageMetadata;
  }

  private encryptE2ePayload(
    type: number,
    messageBody: Uint8Array,
    recipientPublicKey: Uint8Array,
    nonce?: Uint8Array,
  ): { nonce: Uint8Array; encryptedBody: Uint8Array } {
    if (recipientPublicKey.length !== 32) {
      throw new Error(`Recipient public key must be 32 bytes, got ${recipientPublicKey.length}`);
    }

    const paddedBody = this.padMessageBody(messageBody);
    const container = new Uint8Array(1 + paddedBody.length);
    container[0] = type;
    container.set(paddedBody, 1);

    const nonceValue = nonce ?? randomBytes(24);
    if (nonceValue.length !== 24) {
      throw new Error(`Expected 24-byte nonce, got ${nonceValue.length}`);
    }
    const nonceBytes = new Uint8Array(nonceValue);
    const sharedKey = naclBoxBeforeNm(this.clientSecretKey, recipientPublicKey);
    const encryptedBody = naclBoxEncrypt(container, nonceBytes, sharedKey);
    return { nonce: nonceBytes, encryptedBody };
  }

  private padMessageBody(messageBody: Uint8Array): Uint8Array {
    // Match desktop's PKCS#7 behavior: random 1..255 bytes, but ensure minimum total length 32.
    let padLength = Math.max(1, randomBytes(1)[0] ?? 0);
    if (messageBody.length + padLength < 32) {
      padLength = 32 - messageBody.length;
    }
    if (padLength < 1 || padLength > 255) {
      throw new Error(`Invalid computed pad length ${padLength}`);
    }

    const padded = new Uint8Array(messageBody.length + padLength);
    padded.set(messageBody, 0);
    padded.fill(padLength, messageBody.length);
    return padded;
  }

  private buildGroupTextBody(groupCreator: string, groupId: Uint8Array, text: string): Uint8Array {
    const textBytes = textEncoder.encode(text);
    return this.buildGroupMemberContainer(groupCreator, groupId, textBytes);
  }

  private buildFileMessageBody(options: {
    kind: DirectMediaKind;
    blobId: string;
    blobKey: Uint8Array;
    mediaType: string;
    fileSize: number;
    fileName?: string;
    caption?: string;
    durationSeconds?: number;
  }): Uint8Array {
    const json: Record<string, unknown> = {
      j: 1, // media rendering
      i: 1, // deprecated compatibility flag
      k: bytesToHex(options.blobKey),
      b: options.blobId,
      m: options.mediaType,
      n: options.fileName,
      s: options.fileSize,
      d: options.caption,
      x: this.buildFileMessageMetadata(options.kind, options.durationSeconds),
    };

    const filtered = Object.fromEntries(
      Object.entries(json).filter(([, value]) => value !== undefined),
    );
    return textEncoder.encode(JSON.stringify(filtered));
  }

  private buildFileMessageMetadata(
    kind: DirectMediaKind,
    durationSeconds?: number,
  ): Record<string, unknown> {
    if (kind === 'audio') {
      const metadata: Record<string, unknown> = {};
      if (
        typeof durationSeconds === 'number'
        && Number.isFinite(durationSeconds)
        && durationSeconds >= 0
      ) {
        metadata.d = durationSeconds;
      }
      return metadata;
    }
    return {};
  }

  private encryptBlobWithKey(data: Uint8Array, key: Uint8Array, nonce: Uint8Array): Uint8Array {
    if (key.length !== 32) {
      throw new Error(`Blob encryption key must be 32 bytes, got ${key.length}`);
    }
    if (nonce.length !== 24) {
      throw new Error(`Blob nonce must be 24 bytes, got ${nonce.length}`);
    }
    return xsalsa20poly1305(key, nonce).encrypt(data);
  }

  private decryptBlobWithKey(data: Uint8Array, key: Uint8Array, nonce: Uint8Array): Uint8Array {
    if (key.length !== 32) {
      throw new Error(`Blob encryption key must be 32 bytes, got ${key.length}`);
    }
    if (nonce.length !== 24) {
      throw new Error(`Blob nonce must be 24 bytes, got ${nonce.length}`);
    }
    return xsalsa20poly1305(key, nonce).decrypt(data);
  }

  private async downloadBlobByScopeFallback(blobId: string): Promise<DownloadedBlobResult> {
    let lastError: Error | null = null;
    for (const scope of ['public', 'local'] as const) {
      try {
        return await this.downloadBlob(blobId, scope);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }
    throw lastError ?? new Error(`Unable to download blob ${blobId}`);
  }

  private async downloadBlob(blobId: string, scope: BlobScope): Promise<DownloadedBlobResult> {
    const normalizedBlobId = parseBlobId(blobId);
    if (!normalizedBlobId) {
      throw new Error(`Invalid blob ID "${blobId}"`);
    }

    const candidates = this.buildBlobDownloadUrlCandidates(normalizedBlobId, scope);
    if (candidates.length === 0) {
      throw new Error(`No blob download URL candidates available for scope=${scope}`);
    }

    const errors: string[] = [];
    for (const url of candidates) {
      const abortController = new AbortController();
      const timeout = setTimeout(() => abortController.abort(), BLOB_DOWNLOAD_TIMEOUT_MS);

      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            accept: 'application/octet-stream',
            'user-agent': DIRECTORY_USER_AGENT,
          },
          signal: abortController.signal,
        });

        if (response.status !== 200) {
          const body = await response.text().catch(() => '');
          errors.push(`${response.status} ${url} ${body}`.trim());
          continue;
        }

        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length === 0) {
          errors.push(`200 ${url} empty body`);
          continue;
        }

        return {
          blobId: normalizedBlobId,
          sourceUrl: url,
          encryptedBytes: bytes,
          contentType: response.headers.get('content-type') ?? undefined,
        };
      } catch (err) {
        errors.push(`${url} ${String(err)}`);
      } finally {
        clearTimeout(timeout);
      }
    }

    throw new Error(
      `Blob download failed for ${normalizedBlobId} (scope=${scope}): ${errors.join(' | ')}`,
    );
  }

  private async uploadBlob(options: {
    encryptedBytes: Uint8Array;
    scope: 'local' | 'public';
    persist: boolean;
  }): Promise<string> {
    const url = this.buildBlobUploadUrl(options.scope, options.persist);
    const form = new FormData();
    form.append(
      'blob',
      new Blob([Buffer.from(options.encryptedBytes)], { type: 'application/octet-stream' }),
    );

    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), BLOB_UPLOAD_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          accept: 'text/plain',
          'user-agent': DIRECTORY_USER_AGENT,
        },
        body: form,
        signal: abortController.signal,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Blob upload request failed: ${message}`);
    } finally {
      clearTimeout(timeout);
    }

    if (response.status !== 200) {
      const responseBody = await response.text().catch(() => '');
      throw new Error(`Blob upload failed: status=${response.status} body=${responseBody}`);
    }

    const blobId = (await response.text()).trim().toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(blobId)) {
      throw new Error(`Blob upload returned invalid blob ID: ${blobId}`);
    }
    return blobId;
  }

  private buildBlobUploadUrl(scope: 'local' | 'public', persist: boolean): string {
    if (scope === 'public') {
      const publicUpload = process.env.THREEMA_PUBLIC_BLOB_UPLOAD_URL?.trim()
        || DEFAULT_PUBLIC_BLOB_UPLOAD_URL;
      const url = new URL(publicUpload);
      url.searchParams.set('persist', persist ? '1' : '0');
      return url.toString();
    }

    const base = this.buildBlobServerBaseUrl();
    const url = new URL('upload', base);
    url.searchParams.set('persist', persist ? '1' : '0');
    url.searchParams.set('deviceId', u64ToHexLe(this.deviceId));
    url.searchParams.set('deviceGroupId', bytesToHex(this.keys.dgpkPublic));
    url.searchParams.set('scope', scope);
    return url.toString();
  }

  private buildBlobDownloadUrlCandidates(blobId: string, scope: BlobScope): string[] {
    const deviceGroupId = bytesToHex(this.keys.dgpkPublic);
    const blobIdPrefix = blobId.slice(0, 2);
    const devicePrefix = bytesToHex(this.keys.dgpkPublic.subarray(0, 1));
    const deviceGroupIdPrefix4 = devicePrefix.slice(0, 1);
    const deviceGroupIdPrefix8 = devicePrefix.slice(0, 2);
    const deviceId = u64ToHexLe(this.deviceId);

    const interpolateTemplate = (template: string): string | null => {
      const trimmed = template.trim();
      if (trimmed.length === 0) {
        return null;
      }
      const interpolated = trimmed
        .replaceAll('{blobId}', blobId)
        .replaceAll('{blobIdPrefix}', blobIdPrefix)
        .replaceAll('{deviceId}', deviceId)
        .replaceAll('{deviceGroupId}', deviceGroupId)
        .replaceAll('{deviceGroupIdPrefix4}', deviceGroupIdPrefix4)
        .replaceAll('{deviceGroupIdPrefix8}', deviceGroupIdPrefix8)
        .replaceAll('{scope}', scope);
      try {
        const url = new URL(interpolated);
        if (scope === 'local') {
          if (!url.searchParams.has('deviceId')) {
            url.searchParams.set('deviceId', deviceId);
          }
          if (!url.searchParams.has('deviceGroupId')) {
            url.searchParams.set('deviceGroupId', deviceGroupId);
          }
          if (!url.searchParams.has('scope')) {
            url.searchParams.set('scope', scope);
          }
        }
        return url.toString();
      } catch {
        return null;
      }
    };

    const pushTemplates = (out: string[], rawValue: string | undefined): void => {
      if (!rawValue) {
        return;
      }
      const templates = rawValue
        .split(/[\n,;]+/g)
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
      for (const template of templates) {
        const rendered = interpolateTemplate(template);
        if (rendered) {
          out.push(rendered);
        }
      }
    };

    const candidates: string[] = [];
    if (scope === 'public') {
      pushTemplates(candidates, process.env.THREEMA_PUBLIC_BLOB_DOWNLOAD_URL_TEMPLATE);
      pushTemplates(candidates, DEFAULT_PUBLIC_BLOB_DOWNLOAD_URL_TEMPLATE);
      pushTemplates(candidates, 'https://ds-blobp-{blobIdPrefix}.threema.ch/blob/{blobId}');
      pushTemplates(candidates, 'https://blobp-{blobIdPrefix}.threema.ch/{blobId}');
      pushTemplates(candidates, 'https://blobp-{blobIdPrefix}.threema.ch/blob/{blobId}');
    } else {
      pushTemplates(candidates, process.env.THREEMA_BLOB_DOWNLOAD_URL_TEMPLATE);
      pushTemplates(candidates, DEFAULT_BLOB_DOWNLOAD_URL_TEMPLATE);

      const base = this.buildBlobServerBaseUrl();
      const baseWithBlobPath = new URL(`blob/${blobId}`, base);
      baseWithBlobPath.searchParams.set('deviceId', deviceId);
      baseWithBlobPath.searchParams.set('deviceGroupId', deviceGroupId);
      baseWithBlobPath.searchParams.set('scope', 'local');
      candidates.push(baseWithBlobPath.toString());

      const baseWithDirectPath = new URL(blobId, base);
      baseWithDirectPath.searchParams.set('deviceId', deviceId);
      baseWithDirectPath.searchParams.set('deviceGroupId', deviceGroupId);
      baseWithDirectPath.searchParams.set('scope', 'local');
      candidates.push(baseWithDirectPath.toString());
    }

    const seen = new Set<string>();
    const deduped: string[] = [];
    for (const candidate of candidates) {
      if (seen.has(candidate)) {
        continue;
      }
      seen.add(candidate);
      deduped.push(candidate);
    }
    return deduped;
  }

  private buildBlobServerBaseUrl(): string {
    const envTemplate = process.env.THREEMA_BLOB_SERVER_URL_TEMPLATE?.trim();
    const template = envTemplate && envTemplate.length > 0
      ? envTemplate
      : DEFAULT_BLOB_SERVER_URL_TEMPLATE;
    const prefix = bytesToHex(this.keys.dgpkPublic.subarray(0, 1));
    const prefix4 = prefix.slice(0, 1);
    const prefix8 = prefix.slice(0, 2);
    const withPrefix = template
      .replaceAll('{deviceGroupIdPrefix4}', prefix4)
      .replaceAll('{deviceGroupIdPrefix8}', prefix8);
    return withPrefix.endsWith('/') ? withPrefix : `${withPrefix}/`;
  }

  private buildGroupCreatorContainer(groupId: Uint8Array, innerData: Uint8Array): Uint8Array {
    if (groupId.length !== 8) {
      throw new Error(`groupId must be 8 bytes, got ${groupId.length}`);
    }

    const body = new Uint8Array(8 + innerData.length);
    body.set(groupId, 0);
    body.set(innerData, 8);
    return body;
  }

  private buildGroupMemberContainer(
    groupCreator: string,
    groupId: Uint8Array,
    innerData: Uint8Array,
  ): Uint8Array {
    if (groupId.length !== 8) {
      throw new Error(`groupId must be 8 bytes, got ${groupId.length}`);
    }

    const creatorBytes = encodeIdentity(groupCreator);
    const body = new Uint8Array(16 + innerData.length);
    body.set(creatorBytes, 0);
    body.set(groupId, 8);
    body.set(innerData, 16);
    return body;
  }

  private encodeEditMessageBody(options: {
    editedMessageId: bigint;
    text: string;
  }): Uint8Array {
    if (!this.d2dRoot) {
      throw new Error('D2D protobuf types are not loaded');
    }

    const EditMessage = this.d2dRoot.lookupType('csp_e2e.EditMessage');
    if (!EditMessage) {
      throw new Error('csp_e2e.EditMessage type is not available');
    }

    const payload = EditMessage.create({
      messageId: Long.fromString(options.editedMessageId.toString(), true),
      text: options.text,
    });
    return EditMessage.encode(payload).finish();
  }

  private requireMessageId(value: bigint | string | number, fieldName: string): bigint {
    let messageId: bigint | null = null;
    if (typeof value === 'bigint') {
      messageId = value;
    } else if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
      messageId = BigInt(value);
    } else if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        try {
          messageId = BigInt(trimmed);
        } catch {
          messageId = null;
        }
      }
    }

    if (messageId === null || messageId <= 0n) {
      throw new Error(`Invalid ${fieldName} "${String(value)}" (expected unsigned 64-bit integer)`);
    }
    return messageId;
  }

  private normalizeReactionEmoji(value: string): string {
    const emoji = value.trim();
    if (!isValidReactionEmojiInput(emoji)) {
      throw new Error('Reaction emoji must be 1..64 UTF-8 bytes');
    }
    return emoji;
  }

  private getContactReactionSupport(identity: string): ReactionSupport {
    const normalizedIdentity = normalizeIdentity(identity, 'reactionSupportIdentity');
    let contacts: ContactCacheEntry[];
    try {
      contacts = this.readContactsFile();
    } catch (err) {
      console.warn(
        `[mediator] Failed to read contacts while checking reaction support for ${normalizedIdentity}: ${String(err)}`,
      );
      return 'unknown';
    }

    const contact = contacts.find(
      (entry) => typeof entry.identity === 'string' && entry.identity.trim().toUpperCase() === normalizedIdentity,
    );
    if (!contact) {
      return 'unknown';
    }

    const rawFeatureMask =
      contact.featureMask
      ?? (contact as Record<string, unknown>).feature_mask
      ?? (contact as Record<string, unknown>).featuremask;
    const featureMask = this.parseFeatureMask(rawFeatureMask);
    if (featureMask === null) {
      return 'unknown';
    }
    return (featureMask & THREEMA_REACTION_SUPPORT_FEATURE_MASK) !== 0n
      ? 'supported'
      : 'unsupported';
  }

  private parseFeatureMask(value: unknown): bigint | null {
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        return null;
      }
      if (/^0x[0-9a-f]+$/i.test(trimmed)) {
        try {
          return BigInt(trimmed);
        } catch {
          return null;
        }
      }
    }

    const parsed = this.tryToBigInt(value);
    if (parsed === null || parsed < 0n) {
      return null;
    }
    return parsed;
  }

  private resolveTypingMessageType(): number {
    return this.requireCspE2eMessageType(
      'TYPING_INDICATOR',
      E2E_TYPING_INDICATOR_MESSAGE_TYPE,
    );
  }

  private resolveFileMessageType(): number {
    return this.requireCspE2eMessageType(
      'FILE',
      E2E_FILE_MESSAGE_TYPE,
    );
  }

  private resolveGroupFileMessageType(): number {
    return this.requireCspE2eMessageType(
      'GROUP_FILE',
      E2E_GROUP_FILE_MESSAGE_TYPE,
    );
  }

  private resolveReactionMessageType(): number {
    return this.requireCspE2eMessageType(
      'REACTION',
      E2E_REACTION_MESSAGE_TYPE,
    );
  }

  private resolveGroupReactionMessageType(): number {
    return this.requireCspE2eMessageType(
      'GROUP_REACTION',
      E2E_GROUP_REACTION_MESSAGE_TYPE,
    );
  }

  private resolveGroupEditMessageType(): number {
    return this.requireCspE2eMessageType(
      'GROUP_EDIT_MESSAGE',
      E2E_GROUP_EDIT_MESSAGE_TYPE,
    );
  }

  private resolveDeliveryReceiptMessageType(): number {
    return this.requireCspE2eMessageType(
      'DELIVERY_RECEIPT',
      E2E_DELIVERY_RECEIPT_MESSAGE_TYPE,
    );
  }

  private resolveGroupDeliveryReceiptMessageType(): number {
    return this.requireCspE2eMessageType(
      'GROUP_DELIVERY_RECEIPT',
      E2E_GROUP_DELIVERY_RECEIPT_MESSAGE_TYPE,
    );
  }

  private requireCspE2eMessageType(
    name:
      | 'GROUP_SETUP'
      | 'GROUP_NAME'
      | 'TYPING_INDICATOR'
      | 'FILE'
      | 'GROUP_FILE'
      | 'REACTION'
      | 'GROUP_REACTION'
      | 'GROUP_EDIT_MESSAGE'
      | 'DELIVERY_RECEIPT'
      | 'GROUP_DELIVERY_RECEIPT',
    fallback?: number,
  ): number {
    if (!this.d2dRoot) {
      throw new Error('D2D protobuf types are not loaded');
    }
    const CspE2eMessageType = this.d2dRoot.lookupEnum('common.CspE2eMessageType');
    const value = CspE2eMessageType.values?.[name];
    if (typeof value !== 'number') {
      if (typeof fallback === 'number') {
        return fallback;
      }
      throw new Error(`common.CspE2eMessageType.${name} is not available`);
    }
    return value;
  }

  private async reflectOutgoingMessage(options: {
    conversation: ReflectionConversation;
    messageId: bigint;
    createdAtMillis: bigint;
    type: number;
    body: Uint8Array;
    nonces: Uint8Array[];
  }): Promise<bigint> {
    const { ws } = this.requireReadyForReflecting();
    if (!this.d2dRoot) {
      throw new Error('D2D protobuf types are not loaded');
    }

    const Envelope = this.d2dRoot.lookupType('d2d.Envelope');
    const conversation = this.encodeReflectionConversation(options.conversation);
    const outgoingMessage = {
      conversation,
      messageId: options.messageId.toString(),
      createdAt: options.createdAtMillis.toString(),
      type: options.type,
      body: options.body,
      nonces: options.nonces,
    };
    const envelope = Envelope.create({
      padding: randomBytes(Math.floor(Math.random() * 16)),
      deviceId: this.deviceId.toString(),
      protocolVersion: 1,
      outgoingMessage,
    });

    const encodedEnvelope = Envelope.encode(envelope).finish();
    const encryptedEnvelope = secretBoxEncryptWithRandomNonce(encodedEnvelope, this.keys.dgrk);

    const reflectId = this.allocateReflectId();
    const reflectPayload = new Uint8Array(8 + encryptedEnvelope.length);
    reflectPayload[0] = 8; // Header bytes before envelope.
    reflectPayload[1] = 0;
    new DataView(reflectPayload.buffer, reflectPayload.byteOffset, reflectPayload.byteLength)
      .setUint16(2, 0, true); // Flags.
    writeU32LE(reflectPayload, 4, reflectId);
    reflectPayload.set(encryptedEnvelope, 8);

    const ackPromise = this.createReflectAckPromise(reflectId);
    try {
      ws.send(encodeD2mFrame(D2M.REFLECT, reflectPayload));
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.rejectPendingReflectAck(reflectId, error);
      throw error;
    }
    return await ackPromise;
  }

  private encodeReflectionConversation(conversation: ReflectionConversation): Record<string, unknown> {
    if (conversation.contact) {
      return { contact: normalizeIdentity(conversation.contact, 'contact') };
    }
    if (conversation.group) {
      const creatorIdentity = normalizeIdentity(conversation.group.creatorIdentity, 'group.creatorIdentity');
      const groupId = conversation.group.groupId;
      if (groupId.length !== 8) {
        throw new Error(`groupId must be 8 bytes, got ${groupId.length}`);
      }
      return {
        group: {
          creatorIdentity,
          groupId: readU64LE(groupId, 0).toString(),
        },
      };
    }
    throw new Error('Conversation must include either contact or group');
  }

  private allocateReflectId(): number {
    for (let i = 0; i < 0x1_0000_0000; i++) {
      const candidate = this.nextReflectId >>> 0;
      this.nextReflectId = (candidate + 1) >>> 0;
      if (!this.pendingReflectAcks.has(candidate)) {
        return candidate;
      }
    }
    throw new Error('Unable to allocate reflect id');
  }

  private createReflectAckPromise(reflectId: number): Promise<bigint> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingReflectAcks.delete(reflectId);
        reject(new Error(`Timed out waiting for REFLECT_ACK id=${reflectId}`));
      }, REFLECT_ACK_TIMEOUT_MS);
      this.pendingReflectAcks.set(reflectId, { resolve, reject, timeout });
    });
  }

  private rejectPendingReflectAck(reflectId: number, error: Error): void {
    const pending = this.pendingReflectAcks.get(reflectId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pendingReflectAcks.delete(reflectId);
    pending.reject(error);
  }

  private rejectAllPendingReflectAcks(error: Error): void {
    for (const [reflectId, pending] of this.pendingReflectAcks.entries()) {
      clearTimeout(pending.timeout);
      this.pendingReflectAcks.delete(reflectId);
      pending.reject(error);
    }
  }

  private async getContactPublicKey(identity: string): Promise<Uint8Array> {
    const normalizedIdentity = normalizeIdentity(identity);
    const cached = this.contactPublicKeyCache.get(normalizedIdentity);
    if (cached) {
      return cached;
    }

    let fromFile: Uint8Array | null = null;
    try {
      fromFile = this.lookupContactPublicKeyFromFile(normalizedIdentity);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[mediator] Invalid cached public key for ${normalizedIdentity}: ${message}`);
    }
    if (fromFile) {
      this.contactPublicKeyCache.set(normalizedIdentity, fromFile);
      return fromFile;
    }

    const fetched = await this.fetchPublicKeyFromDirectory(normalizedIdentity);
    this.contactPublicKeyCache.set(normalizedIdentity, fetched);
    this.upsertContactPublicKeyInFile(normalizedIdentity, fetched);
    return fetched;
  }

  private lookupContactPublicKeyFromFile(identity: string): Uint8Array | null {
    const contacts = this.readContactsFile();
    const contact = contacts.find(
      (entry) => typeof entry.identity === 'string' && entry.identity.trim().toUpperCase() === identity,
    );
    if (!contact || typeof contact.publicKey !== 'string') {
      return null;
    }
    return this.decodePublicKeyString(contact.publicKey, `contacts.json entry for ${identity}`);
  }

  private upsertContactPublicKeyInFile(identity: string, publicKey: Uint8Array): void {
    const contacts = this.readContactsFile();
    const keyHex = Buffer.from(publicKey).toString('hex');
    const existing = contacts.find(
      (entry) => typeof entry.identity === 'string' && entry.identity.trim().toUpperCase() === identity,
    );
    if (existing) {
      existing.publicKey = keyHex;
    } else {
      contacts.push({
        identity,
        publicKey: keyHex,
        firstName: null,
        lastName: null,
        nickname: null,
      });
    }
    contacts.sort((a, b) => a.identity.localeCompare(b.identity));
    this.writeContactsFile(contacts);
  }

  private readContactsFile(): ContactCacheEntry[] {
    const contactsPath = path.join(this.dataDir, 'contacts.json');
    if (!fs.existsSync(contactsPath)) {
      return [];
    }
    const raw = fs.readFileSync(contactsPath, 'utf-8').trim();
    if (raw.length === 0) {
      return [];
    }

    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error(`Expected contacts.json to contain an array, got ${typeof parsed}`);
    }

    const contacts: ContactCacheEntry[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }
      const asRecord = entry as Record<string, unknown>;
      if (typeof asRecord.identity !== 'string') {
        continue;
      }
      contacts.push({
        ...asRecord,
        identity: asRecord.identity,
      } as ContactCacheEntry);
    }
    return contacts;
  }

  private writeContactsFile(contacts: ContactCacheEntry[]): void {
    const contactsPath = path.join(this.dataDir, 'contacts.json');
    fs.writeFileSync(contactsPath, JSON.stringify(contacts, null, 2) + '\n');
  }

  private async fetchPublicKeyFromDirectory(identity: string): Promise<Uint8Array> {
    const url = `${DIRECTORY_BASE_URL}/identity/${encodeURIComponent(identity)}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'User-Agent': DIRECTORY_USER_AGENT,
      },
    });

    const body = await response.text();
    if (!response.ok) {
      throw new Error(`Directory lookup failed for ${identity}: ${response.status} ${body}`);
    }

    const publicKeyString = this.extractPublicKeyFromDirectoryBody(
      body,
      response.headers.get('content-type') ?? '',
    );
    const publicKey = this.decodePublicKeyString(
      publicKeyString,
      `directory response for ${identity}`,
    );
    console.log(`[mediator] Fetched public key for ${identity} from directory`);
    return publicKey;
  }

  private extractPublicKeyFromDirectoryBody(body: string, contentType: string): string {
    const trimmed = body.trim();
    if (trimmed.length === 0) {
      throw new Error('Directory response body is empty');
    }

    const shouldParseJson = contentType.toLowerCase().includes('application/json')
      || trimmed.startsWith('{')
      || trimmed.startsWith('[');
    if (shouldParseJson) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        const keyFromJson = this.findPublicKeyStringInUnknownValue(parsed);
        if (keyFromJson) {
          return keyFromJson;
        }
      } catch {
        // Fall through to plain text parsing.
      }
    }

    const plainCandidate = this.findPublicKeyCandidateInText(trimmed);
    if (plainCandidate) {
      return plainCandidate;
    }

    throw new Error(`Could not find a public key in directory response: ${trimmed}`);
  }

  private findPublicKeyStringInUnknownValue(value: unknown): string | null {
    const queue: unknown[] = [value];
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) {
        continue;
      }

      if (typeof current === 'string') {
        if (this.tryDecodePublicKeyString(current) !== null) {
          return current;
        }
        continue;
      }

      if (Array.isArray(current)) {
        for (const item of current) {
          queue.push(item);
        }
        continue;
      }

      if (typeof current === 'object') {
        const objectValue = current as Record<string, unknown>;
        for (const [key, objectField] of Object.entries(objectValue)) {
          if (typeof objectField === 'string') {
            const lower = key.toLowerCase();
            if (
              (lower === 'publickey' || lower === 'public_key' || lower === 'pk' || lower === 'key')
              && this.tryDecodePublicKeyString(objectField) !== null
            ) {
              return objectField;
            }
          }
          if (typeof objectField === 'object' && objectField !== null) {
            queue.push(objectField);
          }
        }
      }
    }
    return null;
  }

  private findPublicKeyCandidateInText(text: string): string | null {
    const tokens = text
      .split(/[\s"'`:,;=\{\}\[\]\(\)]+/g)
      .map((token) => token.trim())
      .filter((token) => token.length > 0);
    for (const token of tokens) {
      if (this.tryDecodePublicKeyString(token) !== null) {
        return token;
      }
    }
    if (this.tryDecodePublicKeyString(text) !== null) {
      return text;
    }
    return null;
  }

  private decodePublicKeyString(value: string, source: string): Uint8Array {
    const decoded = this.tryDecodePublicKeyString(value);
    if (!decoded) {
      throw new Error(`Invalid public key in ${source}: ${value}`);
    }
    return decoded;
  }

  private tryDecodePublicKeyString(value: string): Uint8Array | null {
    const trimmed = value.trim();
    const withoutPrefix = trimmed.startsWith('0x') || trimmed.startsWith('0X')
      ? trimmed.slice(2)
      : trimmed;
    if (/^[0-9a-fA-F]{64}$/.test(withoutPrefix)) {
      return new Uint8Array(Buffer.from(withoutPrefix, 'hex'));
    }

    const maybeBase64 = trimmed.replace(/\s+/g, '');
    if (/^[A-Za-z0-9+/]+={0,2}$/.test(maybeBase64)) {
      try {
        const decoded = new Uint8Array(Buffer.from(maybeBase64, 'base64'));
        if (decoded.length === 32) {
          return decoded;
        }
      } catch {
        // Ignore and continue.
      }
    }
    return null;
  }

  private saveDeviceId(): void {
    const idPath = path.join(this.dataDir, 'identity.json');
    const data = JSON.parse(fs.readFileSync(idPath, 'utf-8'));
    data.deviceId = this.deviceId.toString(16).padStart(16, '0');
    fs.writeFileSync(idPath, JSON.stringify(data, null, 2) + '\n');
    console.log(`[mediator] Saved device ID: ${data.deviceId}`);
  }

  disconnect(): void {
    this.csp?.close();
    this.csp = null;
    this.rejectAllPendingReflectAcks(new Error('Client disconnected'));
    this.rejectAllPendingOutgoingMessageAcks(new Error('Client disconnected'));
    this.persistIncomingMessageDedupeState(true);
    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }
  }

  sendCspContainer(type: number, payload: Uint8Array = new Uint8Array(0)): void {
    if (!this.csp) {
      throw new Error('CSP handler not initialized');
    }
    this.csp.sendContainer(type, payload);
  }
}
