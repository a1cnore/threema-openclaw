import { getTypes } from '../../src/proto/load.js';
import { setupRendezvous } from '../../src/rendezvous.js';

function expect(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function decodeUrlSafeBase64(data: string): Uint8Array {
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

async function main() {
  const setup = await setupRendezvous();
  const types = await getTypes();

  expect(
    setup.joinUri.startsWith('threema://device-group/join#'),
    'join URI has unexpected prefix'
  );

  const fragment = setup.joinUri.split('#')[1];
  expect(typeof fragment === 'string' && fragment.length > 0, 'join URI is missing payload fragment');
  expect(/^[A-Za-z0-9\-_]+=*$/.test(fragment), 'payload fragment is not URL-safe base64');
  expect(fragment.length % 4 === 0, 'payload fragment must be padded to a multiple of 4');

  const decodedPayload = decodeUrlSafeBase64(fragment);
  const parsed = types.DeviceGroupJoinRequestOrOffer.decode(decodedPayload) as any;

  expect(parsed.variant?.requestToJoin !== undefined, 'variant.requestToJoin is missing');
  expect(parsed.rendezvousInit?.relayedWebSocket?.pathId === 1, 'relayedWebSocket.pathId must be 1');
  expect(parsed.d2dProtocolVersion === 2, 'd2dProtocolVersion must be 2');

  console.log('✅ Join URI payload decodes successfully');
  console.log('✅ variant.requestToJoin is present');
  console.log('✅ relayedWebSocket.pathId = 1');
  console.log('✅ d2dProtocolVersion = 2');
}

main().catch((error) => {
  console.error('❌ test-proto failed:', error);
  process.exit(1);
});
