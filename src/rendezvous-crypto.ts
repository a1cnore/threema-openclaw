/**
 * Rendezvous protocol crypto primitives.
 * 
 * Uses ChaCha20-Poly1305 for encryption and Blake2b-MAC-256 for key derivation,
 * as specified in the Threema Connection Rendezvous Protocol.
 */
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hsalsa } from '@noble/ciphers/salsa.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { randomBytes } from 'crypto';

const PERSONAL = padTo16(Buffer.from('3ma-rendezvous'));
const HSALSA_SIGMA = new Uint32Array([
  0x61707865, // "expa"
  0x3320646e, // "nd 3"
  0x79622d32, // "2-by"
  0x6b206574, // "te k"
]);

function padTo16(buf: Buffer | Uint8Array): Uint8Array {
  const out = new Uint8Array(16);
  out.set(buf.subarray(0, 16));
  return out;
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

/**
 * Blake2b-MAC-256 with optional key, salt (padded to 16), and personalization.
 */
export function blake2bMac256(opts: {
  key?: Uint8Array;
  salt: string;
  input?: Uint8Array;
}): Uint8Array {
  const saltBytes = padTo16(Buffer.from(opts.salt));
  return blake2b(opts.input ?? new Uint8Array(0), {
    key: opts.key,
    salt: saltBytes,
    personalization: PERSONAL,
    dkLen: 32,
  });
}

/**
 * Derive RIDAK and RRDAK from AK.
 */
export function deriveAuthKeys(ak: Uint8Array): { ridak: Uint8Array; rrdak: Uint8Array } {
  return {
    ridak: blake2bMac256({ key: ak, salt: 'rida' }),
    rrdak: blake2bMac256({ key: ak, salt: 'rrda' }),
  };
}

/**
 * Derive transport keys (RIDTK, RRDTK) and RPH from AK + shared ETK.
 */
export function deriveTransportKeys(ak: Uint8Array, sharedEtk: Uint8Array): {
  ridtk: Uint8Array;
  rrdtk: Uint8Array;
  rph: Uint8Array;
} {
  // STK = Blake2b-MAC-256(key=AK||ETK, salt="st", personal="3ma-rendezvous")
  const stkKey = new Uint8Array(64);
  stkKey.set(ak, 0);
  stkKey.set(sharedEtk, 32);
  const stk = blake2bMac256({ key: stkKey, salt: 'st' });

  return {
    ridtk: blake2bMac256({ key: stk, salt: 'ridt' }),
    rrdtk: blake2bMac256({ key: stk, salt: 'rrdt' }),
    // RPH: key=none means we use input instead
    rph: blake2bMac256({ salt: 'ph', input: stk }),
  };
}

/**
 * ChaCha20-Poly1305 cipher with sequence number tracking.
 */
export class RendezvousCipher {
  private sn: number;

  constructor(
    private key: Uint8Array,
    private pid: number,
    initialSn: number = 1,
  ) {
    this.sn = initialSn;
  }

  get sequenceNumber(): number {
    return this.sn;
  }

  private makeNonce(): Uint8Array {
    // nonce = u32le(PID) || u32le(SN) || 4 zero bytes
    const nonce = new Uint8Array(12);
    const view = new DataView(nonce.buffer);
    view.setUint32(0, this.pid, true);
    view.setUint32(4, this.sn, true);
    // bytes 8-11 are already zero
    this.sn++;
    return nonce;
  }

  encrypt(plaintext: Uint8Array): Uint8Array {
    const nonce = this.makeNonce();
    const cipher = chacha20poly1305(this.key, nonce);
    return cipher.encrypt(plaintext);
  }

  decrypt(ciphertext: Uint8Array): Uint8Array {
    const nonce = this.makeNonce();
    const cipher = chacha20poly1305(this.key, nonce);
    return cipher.decrypt(ciphertext);
  }

  /**
   * Create a new cipher with the same PID and current SN but a new key.
   * Used when transitioning from auth keys to transport keys.
   */
  transitionTo(newKey: Uint8Array): RendezvousCipher {
    return new RendezvousCipher(newKey, this.pid, this.sn);
  }
}

/**
 * Generate a random 32-byte Authentication Key.
 */
export function generateAK(): Uint8Array {
  return randomBytes(32);
}

/**
 * Generate an X25519 ephemeral keypair.
 */
export function generateEphemeralKey(): { secret: Uint8Array; public: Uint8Array } {
  const secret = randomBytes(32);
  const pub = x25519.getPublicKey(secret);
  return { secret, public: pub };
}

/**
 * X25519 Diffie-Hellman.
 */
export function x25519DH(secret: Uint8Array, publicKey: Uint8Array): Uint8Array {
  // libthreema uses SharedSecretHSalsa20 (X25519 output transformed via HSalsa20
  // with all-zero input) before STK derivation.
  const shared = x25519.getSharedSecret(secret, publicKey);
  const keyWords = bytesToWordsLE(shared);
  const inputWords = new Uint32Array(4); // 16 zero bytes
  const outWords = new Uint32Array(8);
  hsalsa(HSALSA_SIGMA, keyWords, inputWords, outWords);
  return wordsToBytesLE(outWords);
}

/**
 * Generate a random 32-byte value.
 */
export { randomBytes };

/**
 * Generate a random 16-byte challenge.
 */
export function generateChallenge(): Uint8Array {
  return randomBytes(16);
}
