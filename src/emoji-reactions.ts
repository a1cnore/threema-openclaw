const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const THREEMA_DELIVERY_RECEIPT_MESSAGE_TYPE = 0x80;
export const THREEMA_GROUP_DELIVERY_RECEIPT_MESSAGE_TYPE = 0x81;
export const THREEMA_REACTION_MESSAGE_TYPE = 0x82;
export const THREEMA_GROUP_REACTION_MESSAGE_TYPE = 0x83;

export const THREEMA_DELIVERY_RECEIPT_STATUS_ACKNOWLEDGED = 0x03;
export const THREEMA_DELIVERY_RECEIPT_STATUS_DECLINED = 0x04;

export const THREEMA_REACTION_SUPPORT_FEATURE_MASK = 0x0400n;

const LEGACY_ACKNOWLEDGE_EMOJIS = new Set([
  "\u{1F44D}", // 👍
  "\u{1F44D}\u{1F3FB}", // 👍🏻
  "\u{1F44D}\u{1F3FC}", // 👍🏼
  "\u{1F44D}\u{1F3FD}", // 👍🏽
  "\u{1F44D}\u{1F3FE}", // 👍🏾
  "\u{1F44D}\u{1F3FF}", // 👍🏿
]);

const LEGACY_DECLINE_EMOJIS = new Set([
  "\u{1F44E}", // 👎
  "\u{1F44E}\u{1F3FB}", // 👎🏻
  "\u{1F44E}\u{1F3FC}", // 👎🏼
  "\u{1F44E}\u{1F3FD}", // 👎🏽
  "\u{1F44E}\u{1F3FE}", // 👎🏾
  "\u{1F44E}\u{1F3FF}", // 👎🏿
]);

export type ThreemaReactionAction = "apply" | "withdraw";

export interface ParsedThreemaReaction {
  messageId: bigint;
  action: ThreemaReactionAction;
  emoji: string;
}

export interface ParsedDeliveryReceipt {
  status: number;
  messageIds: bigint[];
}

export interface ParsedGroupMemberContainer {
  creatorIdentityRaw: string;
  groupId: bigint;
  groupIdBytes: Uint8Array;
  innerData: Uint8Array;
}

export function isValidReactionEmojiInput(emoji: string): boolean {
  const bytes = textEncoder.encode(emoji);
  return bytes.length > 0 && bytes.length <= 64;
}

export function mapReactionToLegacyDeliveryStatus(
  emoji: string,
  action: ThreemaReactionAction,
): number | null {
  if (action === "withdraw") {
    return null;
  }
  if (LEGACY_ACKNOWLEDGE_EMOJIS.has(emoji)) {
    return THREEMA_DELIVERY_RECEIPT_STATUS_ACKNOWLEDGED;
  }
  if (LEGACY_DECLINE_EMOJIS.has(emoji)) {
    return THREEMA_DELIVERY_RECEIPT_STATUS_DECLINED;
  }
  return null;
}

export function legacyDeliveryStatusToEmoji(status: number): string | null {
  if (status === THREEMA_DELIVERY_RECEIPT_STATUS_ACKNOWLEDGED) {
    return "\u{1F44D}";
  }
  if (status === THREEMA_DELIVERY_RECEIPT_STATUS_DECLINED) {
    return "\u{1F44E}";
  }
  return null;
}

export function encodeReactionMessageBody(params: {
  messageId: bigint;
  action: ThreemaReactionAction;
  emoji: string;
}): Uint8Array {
  if (!isValidReactionEmojiInput(params.emoji)) {
    throw new Error("Reaction emoji must be 1..64 UTF-8 bytes");
  }

  const emojiBytes = textEncoder.encode(params.emoji);
  const parts: Uint8Array[] = [];

  parts.push(encodeVarint(0x09)); // field 1, fixed64
  parts.push(encodeFixed64LE(params.messageId));

  if (params.action === "apply") {
    parts.push(encodeVarint(0x12)); // field 2, len-delimited
  } else {
    parts.push(encodeVarint(0x1a)); // field 3, len-delimited
  }
  parts.push(encodeVarint(emojiBytes.length));
  parts.push(emojiBytes);

  return concatBytes(parts);
}

export function decodeReactionMessageBody(bytes: Uint8Array): ParsedThreemaReaction | null {
  let offset = 0;
  let messageId: bigint | undefined;
  let apply: Uint8Array | undefined;
  let withdraw: Uint8Array | undefined;

  while (offset < bytes.length) {
    const keyDecoded = decodeVarint(bytes, offset);
    if (!keyDecoded) {
      return null;
    }
    const key = keyDecoded.value;
    offset = keyDecoded.nextOffset;

    const fieldNumber = key >>> 3;
    const wireType = key & 0x07;

    if (fieldNumber === 1) {
      if (wireType !== 1 || offset + 8 > bytes.length) {
        return null;
      }
      messageId = decodeFixed64LE(bytes.subarray(offset, offset + 8));
      offset += 8;
      continue;
    }

    if (fieldNumber === 2 || fieldNumber === 3) {
      if (wireType !== 2) {
        return null;
      }
      const lenDecoded = decodeVarint(bytes, offset);
      if (!lenDecoded) {
        return null;
      }
      const length = lenDecoded.value;
      offset = lenDecoded.nextOffset;
      if (length < 0 || offset + length > bytes.length) {
        return null;
      }
      const value = bytes.subarray(offset, offset + length);
      offset += length;
      if (fieldNumber === 2) {
        apply = new Uint8Array(value);
      } else {
        withdraw = new Uint8Array(value);
      }
      continue;
    }

    const skipped = skipUnknownField(bytes, offset, wireType);
    if (skipped === null) {
      return null;
    }
    offset = skipped;
  }

  if (messageId === undefined) {
    return null;
  }

  if (apply && withdraw) {
    return null;
  }

  if (apply) {
    const emoji = textDecoder.decode(apply);
    if (!isValidReactionEmojiInput(emoji)) {
      return null;
    }
    return {
      messageId,
      action: "apply",
      emoji,
    };
  }

  if (withdraw) {
    const emoji = textDecoder.decode(withdraw);
    if (!isValidReactionEmojiInput(emoji)) {
      return null;
    }
    return {
      messageId,
      action: "withdraw",
      emoji,
    };
  }

  return null;
}

export function encodeDeliveryReceiptBody(params: {
  status: number;
  messageIds: readonly bigint[];
}): Uint8Array {
  if (!Number.isInteger(params.status) || params.status < 0 || params.status > 0xff) {
    throw new Error(`Invalid delivery receipt status ${params.status}`);
  }
  if (params.messageIds.length === 0) {
    throw new Error("Delivery receipt requires at least one message ID");
  }

  const out = new Uint8Array(1 + params.messageIds.length * 8);
  out[0] = params.status & 0xff;
  for (let i = 0; i < params.messageIds.length; i++) {
    const id = params.messageIds[i]!;
    const start = 1 + i * 8;
    out.set(encodeFixed64LE(id), start);
  }
  return out;
}

export function decodeDeliveryReceiptBody(body: Uint8Array): ParsedDeliveryReceipt | null {
  if (body.length < 9 || (body.length - 1) % 8 !== 0) {
    return null;
  }

  const status = body[0] ?? 0;
  const messageIds: bigint[] = [];
  for (let offset = 1; offset < body.length; offset += 8) {
    messageIds.push(decodeFixed64LE(body.subarray(offset, offset + 8)));
  }

  if (messageIds.length === 0) {
    return null;
  }

  return { status, messageIds };
}

export function parseGroupMemberContainer(body: Uint8Array): ParsedGroupMemberContainer | null {
  if (body.length < 16) {
    return null;
  }

  const creatorIdentityRaw = textDecoder.decode(body.subarray(0, 8)).replace(/\0+$/g, "");
  const groupIdBytes = new Uint8Array(body.subarray(8, 16));
  const groupId = decodeFixed64LE(groupIdBytes);
  const innerData = new Uint8Array(body.subarray(16));

  return {
    creatorIdentityRaw,
    groupId,
    groupIdBytes,
    innerData,
  };
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function encodeFixed64LE(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

function decodeFixed64LE(bytes: Uint8Array): bigint {
  if (bytes.length !== 8) {
    throw new Error(`Expected 8 bytes for fixed64, got ${bytes.length}`);
  }
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(0, true);
}

function encodeVarint(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Varint value must be a non-negative integer, got ${value}`);
  }

  const out: number[] = [];
  let remaining = value;
  while (remaining >= 0x80) {
    out.push((remaining & 0x7f) | 0x80);
    remaining = Math.floor(remaining / 128);
  }
  out.push(remaining);
  return new Uint8Array(out);
}

function decodeVarint(bytes: Uint8Array, offset: number): { value: number; nextOffset: number } | null {
  let value = 0;
  let shift = 0;
  let cursor = offset;

  while (cursor < bytes.length && shift <= 35) {
    const byte = bytes[cursor]!;
    cursor += 1;
    value += (byte & 0x7f) * (2 ** shift);
    if ((byte & 0x80) === 0) {
      return { value, nextOffset: cursor };
    }
    shift += 7;
  }

  return null;
}

function skipUnknownField(bytes: Uint8Array, offset: number, wireType: number): number | null {
  switch (wireType) {
    case 0: {
      const decoded = decodeVarint(bytes, offset);
      return decoded?.nextOffset ?? null;
    }
    case 1:
      return offset + 8 <= bytes.length ? offset + 8 : null;
    case 2: {
      const decoded = decodeVarint(bytes, offset);
      if (!decoded) {
        return null;
      }
      const nextOffset = decoded.nextOffset + decoded.value;
      return nextOffset <= bytes.length ? nextOffset : null;
    }
    case 5:
      return offset + 4 <= bytes.length ? offset + 4 : null;
    default:
      return null;
  }
}
