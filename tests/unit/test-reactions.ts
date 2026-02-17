import assert from 'node:assert/strict';
import {
  decodeDeliveryReceiptBody,
  decodeReactionMessageBody,
  encodeDeliveryReceiptBody,
  encodeReactionMessageBody,
  legacyDeliveryStatusToEmoji,
  mapReactionToLegacyDeliveryStatus,
  parseGroupMemberContainer,
  THREEMA_DELIVERY_RECEIPT_STATUS_ACKNOWLEDGED,
  THREEMA_DELIVERY_RECEIPT_STATUS_DECLINED,
} from '../../src/emoji-reactions.js';

const textEncoder = new TextEncoder();

function encodeIdentity(identity: string): Uint8Array {
  const bytes = textEncoder.encode(identity);
  assert.equal(bytes.length, 8, 'identity must be 8 bytes');
  return bytes;
}

function encodeU64LE(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

(function run() {
  const reactedMessageId = 0x0123456789abcdefn;

  const applyBody = encodeReactionMessageBody({
    messageId: reactedMessageId,
    action: 'apply',
    emoji: '👍',
  });
  const decodedApply = decodeReactionMessageBody(applyBody);
  assert.ok(decodedApply, 'apply reaction should decode');
  assert.equal(decodedApply?.messageId, reactedMessageId);
  assert.equal(decodedApply?.action, 'apply');
  assert.equal(decodedApply?.emoji, '👍');

  const withdrawBody = encodeReactionMessageBody({
    messageId: reactedMessageId,
    action: 'withdraw',
    emoji: '😀',
  });
  const decodedWithdraw = decodeReactionMessageBody(withdrawBody);
  assert.ok(decodedWithdraw, 'withdraw reaction should decode');
  assert.equal(decodedWithdraw?.action, 'withdraw');
  assert.equal(decodedWithdraw?.emoji, '😀');

  assert.equal(
    mapReactionToLegacyDeliveryStatus('👍', 'apply'),
    THREEMA_DELIVERY_RECEIPT_STATUS_ACKNOWLEDGED,
  );
  assert.equal(
    mapReactionToLegacyDeliveryStatus('👎', 'apply'),
    THREEMA_DELIVERY_RECEIPT_STATUS_DECLINED,
  );
  assert.equal(mapReactionToLegacyDeliveryStatus('😀', 'apply'), null);
  assert.equal(mapReactionToLegacyDeliveryStatus('👍', 'withdraw'), null);

  const legacyBody = encodeDeliveryReceiptBody({
    status: THREEMA_DELIVERY_RECEIPT_STATUS_ACKNOWLEDGED,
    messageIds: [1n, 2n, reactedMessageId],
  });
  const decodedLegacy = decodeDeliveryReceiptBody(legacyBody);
  assert.ok(decodedLegacy, 'legacy receipt should decode');
  assert.equal(decodedLegacy?.status, THREEMA_DELIVERY_RECEIPT_STATUS_ACKNOWLEDGED);
  assert.deepEqual(decodedLegacy?.messageIds, [1n, 2n, reactedMessageId]);
  assert.equal(legacyDeliveryStatusToEmoji(decodedLegacy?.status ?? 0), '👍');
  assert.equal(legacyDeliveryStatusToEmoji(0x01), null);

  const creator = 'TEST0001';
  const groupId = 123456789n;
  const groupContainer = new Uint8Array(16 + applyBody.length);
  groupContainer.set(encodeIdentity(creator), 0);
  groupContainer.set(encodeU64LE(groupId), 8);
  groupContainer.set(applyBody, 16);

  const decodedContainer = parseGroupMemberContainer(groupContainer);
  assert.ok(decodedContainer, 'group-member-container should decode');
  assert.equal(decodedContainer?.creatorIdentityRaw, creator);
  assert.equal(decodedContainer?.groupId, groupId);
  const decodedInner = decodeReactionMessageBody(decodedContainer!.innerData);
  assert.ok(decodedInner, 'inner reaction should decode');
  assert.equal(decodedInner?.messageId, reactedMessageId);

  assert.equal(decodeReactionMessageBody(new Uint8Array([0xff, 0xff])), null);
  assert.equal(decodeDeliveryReceiptBody(new Uint8Array([0x03])), null);

  console.log('Reaction helper tests passed');
})();
