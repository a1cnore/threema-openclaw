/**
 * Connection Rendezvous Protocol — RID (Rendezvous Initiator Device) implementation.
 * 
 * We are ND (New Device) requesting to join. We act as RID.
 * The phone (ED = Existing Device) acts as RRD and is the nominator.
 */
import WebSocket from 'ws';
import { randomBytes } from 'crypto';
import {
  deriveAuthKeys,
  deriveTransportKeys,
  RendezvousCipher,
  generateAK,
  generateEphemeralKey,
  generateChallenge,
  x25519DH,
} from './rendezvous-crypto.js';
import { getTypes } from './proto/load.js';
import { rphToEmojiSequence } from './rph-emoji.js';

/**
 * Frame encoding/decoding.
 * 
 * For WebSocket transport: each WS message contains one or more frames.
 * Each frame is: u32-LE-length || encrypted-payload.
 * 
 * BUT looking at the desktop code more carefully: the WASM bindings return
 * raw encrypted bytes (no length prefix). The FrameDecoder with U32LittleEndian
 * is used on the receiving side to reassemble from potentially chunked data.
 * Over WebSocket, each message is typically a complete frame, but we still need
 * the u32 LE framing because the relay server just passes through raw bytes
 * and the FrameDecoder on the other side expects it.
 */
function encodeFrame(payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(4 + payload.length);
  const view = new DataView(frame.buffer);
  view.setUint32(0, payload.length, true);
  frame.set(payload, 4);
  return frame;
}

function decodeFrames(data: Uint8Array): { frames: Uint8Array[]; remainder: Uint8Array } {
  const frames: Uint8Array[] = [];
  let offset = 0;
  while (offset + 4 <= data.length) {
    const len = new DataView(data.buffer, data.byteOffset + offset).getUint32(0, true);
    if (offset + 4 + len > data.length) break;
    frames.push(data.slice(offset + 4, offset + 4 + len));
    offset += 4 + len;
  }
  return { frames, remainder: data.slice(offset) };
}

export interface RendezvousResult {
  /** Send ULP data (encrypted) */
  send: (data: Uint8Array) => void;
  /** Receive ULP data (decrypted) */
  receive: () => Promise<Uint8Array>;
  /** Rendezvous Path Hash for verification */
  rph: Uint8Array;
  /** Close the connection */
  close: () => void;
}

export interface LinkSetup {
  /** The threema:// URI to display as QR code */
  joinUri: string;
  /** The Authentication Key */
  ak: Uint8Array;
  /** Connect and run the rendezvous protocol. Resolves when nominated. */
  connect: () => Promise<RendezvousResult>;
}

function toUrlSafeBase64WithPadding(data: Uint8Array): string {
  return Buffer.from(data)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function fromUrlSafeBase64(data: string): Uint8Array {
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

/**
 * Set up a rendezvous connection as RID (initiator, non-nominator).
 */
export async function setupRendezvous(): Promise<LinkSetup> {
  const types = await getTypes();
  
  // Generate AK
  const ak = generateAK();
  
  // Generate random rendezvous path (32 bytes hex)
  const rendezvousPath = randomBytes(32).toString('hex');
  const prefix4 = rendezvousPath.slice(0, 1);
  const prefix8 = rendezvousPath.slice(0, 2);
  
  // Relay URL
  const relayUrl = `wss://rendezvous-${prefix4}.threema.ch/${prefix8}/${rendezvousPath}`;
  const pathId = 1; // Matches the desktop client's relayed WebSocket path ID.
  
  // Build the join URI
  const rendezvousInit = types.RendezvousInit.create({
    version: 0, // V1_0
    ak: ak,
    relayedWebSocket: {
      pathId,
      networkCost: 0, // UNKNOWN
      url: relayUrl,
    },
  });
  
  const VariantType = types.root.lookupType('url.DeviceGroupJoinRequestOrOffer.Variant');
  const variant = VariantType.create({
    requestToJoin: {},
  });

  const joinRequest = types.DeviceGroupJoinRequestOrOffer.create({
    version: 0, // V1_0
    variant,
    rendezvousInit,
    d2dProtocolVersion: 2, // V0_2 = 0x0002
  });
  
  const encoded = types.DeviceGroupJoinRequestOrOffer.encode(joinRequest).finish();
  const base64 = toUrlSafeBase64WithPadding(encoded);
  const joinUri = `threema://device-group/join#${base64}`;

  // Fail fast if we generated a QR payload that cannot be parsed back.
  try {
    const fragment = joinUri.split('#')[1];
    if (!fragment) {
      throw new Error('join URI is missing payload fragment');
    }
    const decodedPayload = fromUrlSafeBase64(fragment);
    types.DeviceGroupJoinRequestOrOffer.decode(decodedPayload);
  } catch (err) {
    throw new Error(
      `Generated invalid join URI payload: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  
  async function connect(): Promise<RendezvousResult> {
    return new Promise((resolve, reject) => {
      console.log(`[rendezvous] Connecting to relay: ${relayUrl}`);
      const ws = new WebSocket(relayUrl);
      ws.binaryType = 'arraybuffer';
      
      // Derive auth keys
      const { ridak, rrdak } = deriveAuthKeys(ak);
      const ridEncrypt = new RendezvousCipher(ridak, pathId, 1);
      const rrdDecrypt = new RendezvousCipher(rrdak, pathId, 1);
      
      // Generate our ephemeral key
      const localEtk = generateEphemeralKey();
      const localChallenge = generateChallenge();
      
      let buffer = new Uint8Array(0);
      const incomingFrames: Uint8Array[] = [];
      let state: 'awaiting-hello' | 'awaiting-auth' | 'awaiting-nominate' | 'nominated' = 'awaiting-hello';
      
      // For nominated state: ULP data queue
      const ulpQueue: Uint8Array[] = [];
      let ulpResolve: ((data: Uint8Array) => void) | null = null;
      
      // Transport ciphers (set after auth)
      let ridtkEncrypt: RendezvousCipher;
      let rrdtkDecrypt: RendezvousCipher;
      let transportKeys: ReturnType<typeof deriveTransportKeys> | null = null;
      let rph: Uint8Array;
      
      ws.on('open', () => {
        console.log('[rendezvous] Connected to relay, waiting for phone...');
      });
      
      ws.on('message', (rawData: ArrayBuffer) => {
        const data = new Uint8Array(rawData);
        // Append to buffer
        const combined = new Uint8Array(buffer.length + data.length);
        combined.set(buffer);
        combined.set(data, buffer.length);
        
        const { frames, remainder } = decodeFrames(combined);
        buffer = remainder;
        
        for (const frame of frames) {
          try {
            processFrame(frame);
          } catch (err) {
            console.error('[rendezvous] Error processing frame:', err);
            reject(err);
          }
        }
      });
      
      ws.on('error', (err) => {
        console.error('[rendezvous] WebSocket error:', err);
        reject(err);
      });
      
      ws.on('close', (code, reason) => {
        console.log(`[rendezvous] WebSocket closed: ${code} ${reason}`);
      });
      
      function processFrame(encryptedFrame: Uint8Array) {
        switch (state) {
          case 'awaiting-hello': {
            // Decrypt with RRDAK
            const plaintext = rrdDecrypt.decrypt(encryptedFrame);
            const hello = types.RrdToRidHello.decode(plaintext);
            console.log('[rendezvous] Received Hello from phone');
            
            const remoteChallenge = hello.challenge as Uint8Array;
            const remoteEtkPub = hello.etk as Uint8Array;
            
            // Create AuthHello response
            const authHello = types.RidToRrdAuthHello.create({
              response: remoteChallenge, // Echo their challenge back
              challenge: localChallenge,
              etk: localEtk.public,
            });
            const authHelloBytes = types.RidToRrdAuthHello.encode(authHello).finish();
            const encrypted = ridEncrypt.encrypt(authHelloBytes);
            ws.send(encodeFrame(encrypted));
            console.log('[rendezvous] Sent AuthHello');
            
            // Compute shared ETK (X25519 DH)
            const sharedEtk = x25519DH(localEtk.secret, remoteEtkPub);
            
            // Derive transport keys
            transportKeys = deriveTransportKeys(ak, sharedEtk);
            rph = transportKeys.rph;
            const trustSymbols = rphToEmojiSequence(rph, 3).join('   ');
            console.log(`[rendezvous] Trust symbols: ${trustSymbols}`);
            
            state = 'awaiting-auth';
            break;
          }
          
          case 'awaiting-auth': {
            // Decrypt with RRDAK (still using auth key for this message)
            const plaintext = rrdDecrypt.decrypt(encryptedFrame);
            const auth = types.RrdToRidAuth.decode(plaintext);
            console.log('[rendezvous] Received Auth from phone');
            
            // Verify challenge response
            const response = auth.response as Uint8Array;
            if (!buffersEqual(response, localChallenge)) {
              throw new Error('Auth challenge response mismatch!');
            }

            if (!transportKeys) {
              throw new Error('Missing transport key material after hello');
            }

            // Transition only after Auth has been processed so sequence numbers
            // match libthreema's new_from(...) behavior on both sides.
            ridtkEncrypt = ridEncrypt.transitionTo(transportKeys.ridtk);
            rrdtkDecrypt = rrdDecrypt.transitionTo(transportKeys.rrdtk);
            console.log('[rendezvous] Auth verified, awaiting nomination...');
            
            state = 'awaiting-nominate';
            break;
          }
          
          case 'awaiting-nominate': {
            // Decrypt with RRDTK (transport key)
            const plaintext = rrdtkDecrypt.decrypt(encryptedFrame);
            const _nominate = types.Nominate.decode(plaintext);
            console.log('[rendezvous] Path nominated! Rendezvous established.');
            
            state = 'nominated';
            
            resolve({
              send: (data: Uint8Array) => {
                const encrypted = ridtkEncrypt.encrypt(data);
                ws.send(encodeFrame(encrypted));
              },
              receive: () => {
                if (ulpQueue.length > 0) {
                  return Promise.resolve(ulpQueue.shift()!);
                }
                return new Promise<Uint8Array>((res) => {
                  ulpResolve = res;
                });
              },
              rph: rph!,
              close: () => ws.close(1000),
            });
            break;
          }
          
          case 'nominated': {
            // Decrypt ULP data with RRDTK
            const plaintext = rrdtkDecrypt.decrypt(encryptedFrame);
            if (ulpResolve) {
              const r = ulpResolve;
              ulpResolve = null;
              r(plaintext);
            } else {
              ulpQueue.push(plaintext);
            }
            break;
          }
        }
      }
    });
  }
  
  return { joinUri, ak, connect };
}

function buffersEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
