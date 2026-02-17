/**
 * Threema Channel Plugin for OpenClaw
 * 
 * Connects to Threema as a linked desktop device via the multi-device protocol.
 * Receives incoming messages via D2M reflected envelopes + CSP proxy.
 * Sends outgoing messages via CSP with D2M reflection.
 */

import {
  createDefaultChannelRuntimeState,
  collectStatusIssuesFromLastError,
  DEFAULT_ACCOUNT_ID,
  formatPairingApproveHint,
  type ChannelPlugin,
  type PluginRuntime,
} from "openclaw/plugin-sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import {
  MediatorClient,
  type IdentityData,
  type ResolvedDirectFileMessage,
  type ResolvedGroupFileMessage,
} from "./mediator-client.js";
import { getThreemaRuntime } from "../plugin.js";
import { transcribeAudioBytes } from "./media-transcription.js";
import {
  normalizeAudioMemoForThreema,
  synthesizeSpeechToAudioMemo,
} from "./media-speech.js";
import {
  THREEMA_DELIVERY_RECEIPT_MESSAGE_TYPE,
  THREEMA_GROUP_DELIVERY_RECEIPT_MESSAGE_TYPE,
  THREEMA_REACTION_MESSAGE_TYPE,
  THREEMA_GROUP_REACTION_MESSAGE_TYPE,
  decodeDeliveryReceiptBody,
  decodeReactionMessageBody,
  legacyDeliveryStatusToEmoji,
  parseGroupMemberContainer,
  type ThreemaReactionAction,
} from "./emoji-reactions.js";
import * as fs from "node:fs";
import * as path from "node:path";

// ─── Config types ────────────────────────────────────────────────────────────

type ThreemaAccountConfig = {
  enabled?: boolean;
  identityFile?: string; // Path to identity.json
  dataDir?: string; // Path to data dir (contacts.json, etc.)
  allowFrom?: string[]; // Allowed Threema IDs
  dmPolicy?: "open" | "pairing" | "allowlist";
  features?: ThreemaFeaturesConfig;
};

type ThreemaFeaturesConfig = {
  groupEvolvingReplies?: {
    enabled?: boolean;
    partialStreaming?: {
      enabled?: boolean;
      minIntervalMs?: number;
      minCharsDelta?: number;
    };
  };
};

type ResolvedThreemaAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  identityFile: string;
  dataDir: string;
  identity?: IdentityData;
  config: ThreemaAccountConfig;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getThreemaConfig(cfg: OpenClawConfig): Record<string, any> {
  return (cfg.channels as any)?.threema ?? {};
}

function getAccountsConfig(cfg: OpenClawConfig): Record<string, ThreemaAccountConfig> {
  const tc = getThreemaConfig(cfg);
  return tc.accounts ?? {};
}

function resolveGroupEvolvingRepliesConfig(
  cfg: OpenClawConfig,
  accountId: string,
): ThreemaFeaturesConfig["groupEvolvingReplies"] {
  const threemaConfig = getThreemaConfig(cfg);
  const channelCfg = threemaConfig?.features?.groupEvolvingReplies ?? {};
  const accountCfg = getAccountsConfig(cfg)?.[accountId]?.features?.groupEvolvingReplies ?? {};
  const channelPartialCfg = channelCfg?.partialStreaming ?? {};
  const accountPartialCfg = accountCfg?.partialStreaming ?? {};

  return {
    ...channelCfg,
    ...accountCfg,
    partialStreaming: {
      ...channelPartialCfg,
      ...accountPartialCfg,
    },
  };
}

function isGroupEvolvingRepliesEnabled(cfg: OpenClawConfig, accountId: string): boolean {
  const mergedCfg = resolveGroupEvolvingRepliesConfig(cfg, accountId);
  const enabled = mergedCfg?.enabled;
  return typeof enabled === "boolean" ? enabled : false;
}

type GroupEvolvingPartialStreamingOptions = {
  enabled: boolean;
  minIntervalMs: number;
  minCharsDelta: number;
};

const DEFAULT_GROUP_EVOLVING_PARTIAL_INTERVAL_MS = 120;
const DEFAULT_GROUP_EVOLVING_PARTIAL_MIN_CHARS_DELTA = 1;

function resolveGroupEvolvingPartialStreamingOptions(
  cfg: OpenClawConfig,
  accountId: string,
): GroupEvolvingPartialStreamingOptions {
  const mergedCfg = resolveGroupEvolvingRepliesConfig(cfg, accountId);
  const partialCfg = mergedCfg?.partialStreaming;
  const rawEnabled = partialCfg?.enabled;
  const enabled = typeof rawEnabled === "boolean" ? rawEnabled : true;

  const rawMinIntervalMs = partialCfg?.minIntervalMs;
  const minIntervalMs = (
    typeof rawMinIntervalMs === "number"
    && Number.isFinite(rawMinIntervalMs)
    && rawMinIntervalMs >= 0
  )
    ? Math.floor(rawMinIntervalMs)
    : DEFAULT_GROUP_EVOLVING_PARTIAL_INTERVAL_MS;

  const rawMinCharsDelta = partialCfg?.minCharsDelta;
  const minCharsDelta = (
    typeof rawMinCharsDelta === "number"
    && Number.isFinite(rawMinCharsDelta)
    && rawMinCharsDelta >= 1
  )
    ? Math.floor(rawMinCharsDelta)
    : DEFAULT_GROUP_EVOLVING_PARTIAL_MIN_CHARS_DELTA;

  return {
    enabled,
    minIntervalMs,
    minCharsDelta,
  };
}

function resolveThreemaAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedThreemaAccount {
  const { cfg, accountId } = params;
  const aid = accountId ?? DEFAULT_ACCOUNT_ID;
  const accounts = getAccountsConfig(cfg);
  const acct = accounts[aid] ?? {};

  const identityFile = acct.identityFile ?? "";
  const dataDir = acct.dataDir ?? (identityFile ? path.dirname(identityFile) : "");

  let identity: IdentityData | undefined;
  let configured = false;
  if (identityFile && fs.existsSync(identityFile)) {
    try {
      identity = JSON.parse(fs.readFileSync(identityFile, "utf-8"));
      configured = !!(identity?.identity && identity?.clientKey && identity?.deviceGroupKey);
    } catch {}
  }

  return {
    accountId: aid,
    name: identity?.identity,
    enabled: acct.enabled !== false,
    configured,
    identityFile,
    dataDir,
    identity,
    config: acct,
  };
}

// ─── Active clients ──────────────────────────────────────────────────────────

const activeClients = new Map<string, MediatorClient>();

// Track message IDs we've sent to avoid echo loops
const sentMessageIds = new Set<string>();
const MAX_SENT_TRACKING = 1000;
const THREEMA_TEXT_MESSAGE_TYPE = 0x01;
const THREEMA_FILE_MESSAGE_TYPE = 0x17;
const THREEMA_GROUP_TEXT_MESSAGE_TYPE = 0x41;
const THREEMA_GROUP_NAME_MESSAGE_TYPE = 0x4b;
const THREEMA_GROUP_FILE_MESSAGE_TYPE = 0x46;
const THREEMA_LEGACY_DELIVERY_RECEIPT_MESSAGE_TYPE = THREEMA_DELIVERY_RECEIPT_MESSAGE_TYPE;
const THREEMA_LEGACY_GROUP_DELIVERY_RECEIPT_MESSAGE_TYPE = THREEMA_GROUP_DELIVERY_RECEIPT_MESSAGE_TYPE;
const THREEMA_DIRECT_REACTION_MESSAGE_TYPE = THREEMA_REACTION_MESSAGE_TYPE;
const THREEMA_GROUP_REACTION_MESSAGE_TYPE_INTERNAL = THREEMA_GROUP_REACTION_MESSAGE_TYPE;
const THREEMA_TYPING_INDICATOR_MESSAGE_TYPE = 0x90;
const DIRECT_TYPING_REFRESH_MS = 4_000;
const DIRECT_TYPING_STOP_DEBOUNCE_MS = 1_200;
const DEFAULT_MEDIA_DOWNLOAD_MAX_BYTES = 30 * 1024 * 1024;
const DEFAULT_TRANSCRIBE_MAX_BYTES = 24 * 1024 * 1024;
const MEDIA_STORAGE_SUBDIR = "media";
const DEFAULT_VOICE_REPLY_MAX_TEXT_CHARS = 6_000;
const observedGroupMemberIdentities = new Map<string, Set<string>>();
const GROUP_EVOLVING_REPLY_SESSION_TTL_MS = 15 * 60_000;

type GroupEvolvingReplySession = {
  anchorMessageId: bigint;
  lastText: string;
  updatedAt: number;
};

const groupEvolvingReplySessions = new Map<string, GroupEvolvingReplySession>();

type DirectTypingSession = {
  accountId: string;
  recipientIdentity: string;
  refreshTimer: ReturnType<typeof setInterval> | null;
  stopTimer: ReturnType<typeof setTimeout> | null;
  active: boolean;
};

const directTypingSessions = new Map<string, DirectTypingSession>();

function buildDirectTypingSessionKey(accountId: string, recipientIdentity: string): string {
  return `${accountId}:${recipientIdentity}`;
}

function clearDirectTypingSessionTimers(session: DirectTypingSession): void {
  if (session.stopTimer) {
    clearTimeout(session.stopTimer);
    session.stopTimer = null;
  }
  if (session.refreshTimer) {
    clearInterval(session.refreshTimer);
    session.refreshTimer = null;
  }
}

async function sendDirectTypingIndicator(params: {
  accountId: string;
  recipientIdentity: string;
  isTyping: boolean;
  ctx: any;
}): Promise<void> {
  const { accountId, recipientIdentity, isTyping, ctx } = params;
  const client = activeClients.get(accountId);
  if (!client) {
    return;
  }

  try {
    const result = await client.sendTypingIndicator(recipientIdentity, isTyping);
    if (!result.sent) {
      ctx.log?.debug?.(
        `[${accountId}] Typing ${isTyping ? "start" : "stop"} skipped for ${recipientIdentity}: ${result.reason ?? "unknown"}`,
      );
    }
  } catch (err) {
    ctx.log?.warn?.(
      `[${accountId}] Failed to send typing ${isTyping ? "start" : "stop"} for ${recipientIdentity}: ${String(err)}`,
    );
  }
}

function beginDirectTyping(params: {
  accountId: string;
  recipientIdentity: string;
  ctx: any;
}): void {
  const normalizedRecipient = tryNormalizeIdentity(params.recipientIdentity);
  if (!normalizedRecipient) {
    return;
  }

  const key = buildDirectTypingSessionKey(params.accountId, normalizedRecipient);
  let session = directTypingSessions.get(key);
  if (!session) {
    session = {
      accountId: params.accountId,
      recipientIdentity: normalizedRecipient,
      refreshTimer: null,
      stopTimer: null,
      active: false,
    };
    directTypingSessions.set(key, session);
  }

  if (session.stopTimer) {
    clearTimeout(session.stopTimer);
    session.stopTimer = null;
  }

  if (!session.refreshTimer) {
    session.refreshTimer = setInterval(() => {
      void sendDirectTypingIndicator({
        accountId: session.accountId,
        recipientIdentity: session.recipientIdentity,
        isTyping: true,
        ctx: params.ctx,
      });
    }, DIRECT_TYPING_REFRESH_MS);
  }

  if (session.active) {
    return;
  }

  session.active = true;
  void sendDirectTypingIndicator({
    accountId: session.accountId,
    recipientIdentity: session.recipientIdentity,
    isTyping: true,
    ctx: params.ctx,
  });
}

function touchDirectTyping(params: {
  accountId: string;
  recipientIdentity: string;
}): void {
  const normalizedRecipient = tryNormalizeIdentity(params.recipientIdentity);
  if (!normalizedRecipient) {
    return;
  }

  const key = buildDirectTypingSessionKey(params.accountId, normalizedRecipient);
  const session = directTypingSessions.get(key);
  if (!session || !session.stopTimer) {
    return;
  }
  clearTimeout(session.stopTimer);
  session.stopTimer = null;
}

function endDirectTyping(params: {
  accountId: string;
  recipientIdentity: string;
  ctx: any;
}): void {
  const normalizedRecipient = tryNormalizeIdentity(params.recipientIdentity);
  if (!normalizedRecipient) {
    return;
  }

  const key = buildDirectTypingSessionKey(params.accountId, normalizedRecipient);
  const session = directTypingSessions.get(key);
  if (!session) {
    return;
  }

  if (session.stopTimer) {
    clearTimeout(session.stopTimer);
    session.stopTimer = null;
  }

  session.stopTimer = setTimeout(() => {
    session.stopTimer = null;
    void sendDirectTypingIndicator({
      accountId: session.accountId,
      recipientIdentity: session.recipientIdentity,
      isTyping: false,
      ctx: params.ctx,
    });
    clearDirectTypingSessionTimers(session);
    session.active = false;
    directTypingSessions.delete(key);
  }, DIRECT_TYPING_STOP_DEBOUNCE_MS);
}

function clearDirectTypingSessionsForAccount(params: {
  accountId: string;
  ctx: any;
  sendStop: boolean;
}): void {
  for (const [key, session] of directTypingSessions.entries()) {
    if (session.accountId !== params.accountId) {
      continue;
    }

    if (params.sendStop) {
      void sendDirectTypingIndicator({
        accountId: session.accountId,
        recipientIdentity: session.recipientIdentity,
        isTyping: false,
        ctx: params.ctx,
      });
    }

    clearDirectTypingSessionTimers(session);
    session.active = false;
    directTypingSessions.delete(key);
  }
}

function parseTypingIndicatorBody(body: unknown): boolean | null {
  let payload: Uint8Array | null = null;
  if (body instanceof Uint8Array) {
    payload = body;
  } else if (ArrayBuffer.isView(body)) {
    payload = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  } else if (body instanceof ArrayBuffer) {
    payload = new Uint8Array(body);
  } else if (Array.isArray(body)) {
    payload = new Uint8Array(body);
  }

  if (!payload || payload.length !== 1) {
    return null;
  }
  if (payload[0] === 1) {
    return true;
  }
  if (payload[0] === 0) {
    return false;
  }
  return null;
}

function parseGroupCreatorContainer(body: Uint8Array): {
  groupId: bigint;
  groupIdBytes: Uint8Array;
  innerData: Uint8Array;
} | null {
  if (body.length < 8) {
    return null;
  }
  const groupIdBytes = body.slice(0, 8);
  const groupId = new DataView(
    groupIdBytes.buffer,
    groupIdBytes.byteOffset,
    groupIdBytes.byteLength,
  ).getBigUint64(0, true);
  return {
    groupId,
    groupIdBytes,
    innerData: body.slice(8),
  };
}

function parseGroupNameControlMessageBody(body: unknown): {
  groupId: bigint;
  groupIdBytes: Uint8Array;
  name: string;
} | null {
  const bytes = toUint8Array(body);
  if (!bytes || bytes.length < 9) {
    return null;
  }

  const container = parseGroupCreatorContainer(bytes);
  if (!container) {
    return null;
  }

  const name = new TextDecoder().decode(container.innerData).trim();
  if (name.length === 0) {
    return null;
  }

  return {
    groupId: container.groupId,
    groupIdBytes: container.groupIdBytes,
    name,
  };
}

function buildGroupEvolvingReplySessionKey(params: {
  accountId: string;
  chatId: string;
  inboundMessageId: string;
}): string {
  return `${params.accountId}:${params.chatId}:${params.inboundMessageId}`;
}

function pruneGroupEvolvingReplySessions(now = Date.now()): void {
  for (const [key, session] of groupEvolvingReplySessions.entries()) {
    if (now - session.updatedAt > GROUP_EVOLVING_REPLY_SESSION_TTL_MS) {
      groupEvolvingReplySessions.delete(key);
    }
  }
}

function resolveGroupEvolvingReplyText(params: {
  session: GroupEvolvingReplySession | undefined;
  nextText: string;
  deliveryInfo?: { kind?: string } | undefined;
}): string {
  const trimmedNext = params.nextText;
  const existing = params.session;
  if (!existing) {
    return trimmedNext;
  }

  const previous = existing.lastText;
  if (!previous) {
    return trimmedNext;
  }

  const kind = typeof params.deliveryInfo?.kind === "string"
    ? params.deliveryInfo.kind
    : "";
  if (kind === "block") {
    if (trimmedNext.startsWith(previous)) {
      return trimmedNext;
    }
    // Some runtimes emit delta-style block chunks. In that case append.
    return `${previous}${trimmedNext}`;
  }

  return trimmedNext;
}

function trackSentMessage(id: string) {
  sentMessageIds.add(id);
  // Prune old entries
  if (sentMessageIds.size > MAX_SENT_TRACKING) {
    const first = sentMessageIds.values().next().value;
    if (first) sentMessageIds.delete(first);
  }
}

function tryNormalizeIdentity(value: string): string | null {
  const normalized = value.trim().toUpperCase();
  if (!/^[*0-9A-Z]{8}$/.test(normalized)) {
    return null;
  }
  return normalized;
}

function parseU64(value: unknown): bigint | null {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return BigInt(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    try {
      return BigInt(value.trim());
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") {
    return null;
  }

  const asRecord = value as Record<string, unknown>;
  const low = asRecord.low;
  const high = asRecord.high;
  if (typeof low !== "number" || typeof high !== "number") {
    return null;
  }

  const lowPart = BigInt(low >>> 0);
  const highPart = BigInt(high >>> 0);
  return (highPart << 32n) | lowPart;
}

function parseGroupId(value: unknown): bigint | null {
  return parseU64(value);
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
}

function buildObservedGroupMemberKey(creatorIdentity: string, groupId: bigint): string {
  return `${creatorIdentity}/${groupId.toString()}`;
}

function rememberObservedGroupMember(params: {
  creatorIdentity: string;
  groupId: bigint;
  memberIdentity: string;
  dataDir?: string;
}): void {
  const creatorIdentity = tryNormalizeIdentity(params.creatorIdentity);
  const memberIdentity = tryNormalizeIdentity(params.memberIdentity);
  if (!creatorIdentity || !memberIdentity) {
    return;
  }
  const key = buildObservedGroupMemberKey(creatorIdentity, params.groupId);
  const bucket = observedGroupMemberIdentities.get(key);
  if (bucket) {
    bucket.add(memberIdentity);
  } else {
    observedGroupMemberIdentities.set(key, new Set([memberIdentity]));
  }

  if (typeof params.dataDir === "string" && params.dataDir.trim().length > 0) {
    try {
      persistObservedGroupMemberToGroupsFile({
        dataDir: params.dataDir,
        creatorIdentity,
        groupId: params.groupId,
        memberIdentity,
      });
    } catch (err) {
      console.warn(`[threema] Failed persisting observed group member: ${String(err)}`);
    }
  }
}

function rememberObservedGroupMemberForChat(params: {
  chatId: string;
  memberIdentity: string;
  dataDir?: string;
}): void {
  const target = parseThreemaChatTarget(params.chatId);
  if (!target || target.kind !== "group") {
    return;
  }
  rememberObservedGroupMember({
    creatorIdentity: target.creatorIdentity,
    groupId: target.groupId,
    memberIdentity: params.memberIdentity,
    dataDir: params.dataDir,
  });
}

function resolveCreatorIdentityFromGroupRecord(record: Record<string, unknown>): string | null {
  const directCreator = tryNormalizeIdentity(String(record.creatorIdentity ?? ""));
  if (directCreator) {
    return directCreator;
  }

  const groupIdentity = toRecord(record.groupIdentity);
  const groupIdentityCreator = groupIdentity
    ? tryNormalizeIdentity(String(groupIdentity.creatorIdentity ?? ""))
    : null;
  if (groupIdentityCreator) {
    return groupIdentityCreator;
  }

  const nestedGroup = toRecord(record.group);
  const nestedCreator = nestedGroup
    ? tryNormalizeIdentity(String(nestedGroup.creatorIdentity ?? ""))
    : null;
  if (nestedCreator) {
    return nestedCreator;
  }

  const nestedGroupIdentity = nestedGroup ? toRecord(nestedGroup.groupIdentity) : null;
  return nestedGroupIdentity
    ? tryNormalizeIdentity(String(nestedGroupIdentity.creatorIdentity ?? ""))
    : null;
}

function resolveGroupIdFromGroupRecord(record: Record<string, unknown>): bigint | null {
  const directGroupId = parseGroupId(record.groupId);
  if (directGroupId !== null) {
    return directGroupId;
  }

  const groupIdentity = toRecord(record.groupIdentity);
  const groupIdentityId = groupIdentity ? parseGroupId(groupIdentity.groupId) : null;
  if (groupIdentityId !== null) {
    return groupIdentityId;
  }

  const nestedGroup = toRecord(record.group);
  const nestedGroupId = nestedGroup ? parseGroupId(nestedGroup.groupId) : null;
  if (nestedGroupId !== null) {
    return nestedGroupId;
  }

  const nestedGroupIdentity = nestedGroup ? toRecord(nestedGroup.groupIdentity) : null;
  return nestedGroupIdentity ? parseGroupId(nestedGroupIdentity.groupId) : null;
}

function collectGroupMembersFromGroupRecord(record: Record<string, unknown>, out: Set<string>): void {
  collectGroupMemberIdentities(record.members, out);
  collectGroupMemberIdentities(record.memberIdentities, out);
  collectGroupMemberIdentities(record.contacts, out);
  collectGroupMemberIdentities(record.participants, out);
  collectGroupMemberIdentities(record.participantIdentities, out);

  const group = toRecord(record.group);
  if (!group) {
    return;
  }
  collectGroupMemberIdentities(group.members, out);
  collectGroupMemberIdentities(group.memberIdentities, out);
  collectGroupMemberIdentities(group.contacts, out);
  collectGroupMemberIdentities(group.participants, out);
  collectGroupMemberIdentities(group.participantIdentities, out);
}

function normalizeGroupName(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveGroupNameFromGroupRecord(record: Record<string, unknown>): string | null {
  const directName = normalizeGroupName(record.name);
  if (directName) {
    return directName;
  }

  const nestedGroup = toRecord(record.group);
  if (nestedGroup) {
    const nestedName = normalizeGroupName(nestedGroup.name);
    if (nestedName) {
      return nestedName;
    }
  }

  const groupIdentity = toRecord(record.groupIdentity);
  if (groupIdentity) {
    const identityName = normalizeGroupName(groupIdentity.name);
    if (identityName) {
      return identityName;
    }
  }

  return null;
}

function readGroupsFileRecords(dataDir: string): Record<string, unknown>[] {
  const groupsPath = path.join(dataDir, "groups.json");
  if (!fs.existsSync(groupsPath)) {
    return [];
  }

  const raw = fs.readFileSync(groupsPath, "utf-8").trim();
  if (raw.length === 0) {
    return [];
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object");
}

function resolveGroupDisplayName(params: {
  dataDir?: string;
  creatorIdentity: string;
  groupId: bigint;
  accountId?: string;
  ctx?: any;
}): string | null {
  const creatorIdentity = tryNormalizeIdentity(params.creatorIdentity);
  if (!creatorIdentity || !params.dataDir) {
    return null;
  }

  try {
    const records = readGroupsFileRecords(params.dataDir);
    for (const record of records) {
      if (resolveCreatorIdentityFromGroupRecord(record) !== creatorIdentity) {
        continue;
      }

      const entryGroupId = resolveGroupIdFromGroupRecord(record);
      if (entryGroupId === null || entryGroupId !== params.groupId) {
        continue;
      }

      const resolvedName = resolveGroupNameFromGroupRecord(record);
      if (resolvedName) {
        params.ctx?.log?.debug?.(
          `[${params.accountId ?? "default"}] Resolved group name "${resolvedName}" for ${creatorIdentity}/${params.groupId.toString()} from groups.json`,
        );
      }
      return resolvedName;
    }
  } catch (err) {
    params.ctx?.log?.warn?.(
      `[${params.accountId ?? "default"}] Failed reading groups.json for group-name resolution: ${String(err)}`,
    );
  }

  return null;
}

function buildGroupFallbackLabel(creatorIdentity: string, groupId: bigint): string {
  return `Group ${creatorIdentity}/${groupId.toString()}`;
}

function resolveGroupConversationLabel(params: {
  dataDir?: string;
  creatorIdentity: string;
  groupId: bigint;
  accountId?: string;
  ctx?: any;
}): string {
  const creatorIdentity = tryNormalizeIdentity(params.creatorIdentity) ?? params.creatorIdentity;
  const fallback = buildGroupFallbackLabel(creatorIdentity, params.groupId);
  const resolvedName = resolveGroupDisplayName({
    dataDir: params.dataDir,
    creatorIdentity,
    groupId: params.groupId,
    accountId: params.accountId,
    ctx: params.ctx,
  });

  if (resolvedName) {
    return resolvedName;
  }

  params.ctx?.log?.debug?.(
    `[${params.accountId ?? "default"}] Using fallback group label for ${creatorIdentity}/${params.groupId.toString()}`,
  );
  return fallback;
}

function upsertGroupNameInGroupsFile(params: {
  dataDir: string;
  creatorIdentity: string;
  groupId: bigint;
  name: string;
}): void {
  const { dataDir, groupId } = params;
  const creatorIdentity = tryNormalizeIdentity(params.creatorIdentity);
  const name = params.name.trim();
  if (!creatorIdentity || name.length === 0) {
    return;
  }

  const groupsPath = path.join(dataDir, "groups.json");
  const records = readGroupsFileRecords(dataDir);

  let targetRecord: Record<string, unknown> | undefined = records.find((record) => (
    resolveCreatorIdentityFromGroupRecord(record) === creatorIdentity
    && resolveGroupIdFromGroupRecord(record) === groupId
  ));

  if (!targetRecord) {
    targetRecord = {
      creatorIdentity,
      groupId: groupId.toString(),
      memberIdentities: [],
    };
    records.push(targetRecord);
  }

  targetRecord.creatorIdentity = creatorIdentity;
  if (targetRecord.groupId === undefined) {
    targetRecord.groupId = groupId.toString();
  }
  targetRecord.name = name;

  const nestedGroup = toRecord(targetRecord.group);
  if (nestedGroup) {
    nestedGroup.name = name;
  }

  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(groupsPath, JSON.stringify(records, null, 2));
}

function persistObservedGroupMemberToGroupsFile(params: {
  dataDir: string;
  creatorIdentity: string;
  groupId: bigint;
  memberIdentity: string;
}): void {
  const { dataDir, creatorIdentity, groupId, memberIdentity } = params;
  const groupsPath = path.join(dataDir, "groups.json");
  let records: Record<string, unknown>[] = [];
  if (fs.existsSync(groupsPath)) {
    const raw = fs.readFileSync(groupsPath, "utf-8").trim();
    if (raw.length > 0) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        records = parsed.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object");
      }
    }
  }

  let targetRecord: Record<string, unknown> | undefined = records.find((record) => (
    resolveCreatorIdentityFromGroupRecord(record) === creatorIdentity
    && resolveGroupIdFromGroupRecord(record) === groupId
  ));

  if (!targetRecord) {
    targetRecord = {
      creatorIdentity,
      groupId: groupId.toString(),
      memberIdentities: [],
    };
    records.push(targetRecord);
  }

  const mergedMembers = new Set<string>();
  collectGroupMembersFromGroupRecord(targetRecord, mergedMembers);
  mergedMembers.add(memberIdentity);
  mergedMembers.delete(creatorIdentity);

  targetRecord.creatorIdentity = creatorIdentity;
  if (targetRecord.groupId === undefined) {
    targetRecord.groupId = groupId.toString();
  }
  targetRecord.memberIdentities = Array.from(mergedMembers);

  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(groupsPath, JSON.stringify(records, null, 2));
}

type ParsedThreemaChatTarget =
  | {
      kind: "direct";
      chatId: string;
      recipientIdentity: string;
    }
  | {
      kind: "group";
      chatId: string;
      creatorIdentity: string;
      groupId: bigint;
      groupIdBytes: Uint8Array;
    };

function parseThreemaChatTarget(raw: string): ParsedThreemaChatTarget | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const buildGroupTarget = (
    creatorCandidate: string,
    groupIdCandidate: string,
  ): ParsedThreemaChatTarget | null => {
    const creatorIdentity = tryNormalizeIdentity(creatorCandidate);
    const groupId = parseU64(groupIdCandidate);
    if (!creatorIdentity || groupId === null) {
      return null;
    }
    const groupIdBytes = new Uint8Array(8);
    new DataView(groupIdBytes.buffer).setBigUint64(0, groupId, true);
    return {
      kind: "group",
      chatId: `threema:group:${creatorIdentity}/${groupId.toString()}`,
      creatorIdentity,
      groupId,
      groupIdBytes,
    };
  };

  const directMatch = trimmed.match(/^threema:([*0-9a-z]{8})$/i);
  if (directMatch) {
    const recipientIdentity = tryNormalizeIdentity(directMatch[1] ?? "");
    if (!recipientIdentity) {
      return null;
    }
    return {
      kind: "direct",
      chatId: `threema:${recipientIdentity}`,
      recipientIdentity,
    };
  }

  const canonicalGroupMatch = trimmed.match(/^threema:group:([*0-9a-z]{8})\/([0-9]+)$/i);
  if (canonicalGroupMatch) {
    return buildGroupTarget(canonicalGroupMatch[1] ?? "", canonicalGroupMatch[2] ?? "");
  }

  const legacyGroupMatch = trimmed.match(/^group:([*0-9a-z]{8})\/([0-9]+)$/i);
  if (legacyGroupMatch) {
    return buildGroupTarget(legacyGroupMatch[1] ?? "", legacyGroupMatch[2] ?? "");
  }

  // OpenClaw session IDs for group chats can be emitted as:
  //   threema:g-group-<creatorIdentityLower>-<groupIdDecimal>
  // Keep this compatible by normalizing it to canonical threema:group:<CREATOR>/<GROUP_ID>.
  const openClawGroupMatch = trimmed.match(/^threema:g-group-([*0-9a-z]{8})-([0-9]+)$/i);
  if (openClawGroupMatch) {
    return buildGroupTarget(openClawGroupMatch[1] ?? "", openClawGroupMatch[2] ?? "");
  }

  const rawOpenClawGroupMatch = trimmed.match(/^g-group-([*0-9a-z]{8})-([0-9]+)$/i);
  if (rawOpenClawGroupMatch) {
    return buildGroupTarget(rawOpenClawGroupMatch[1] ?? "", rawOpenClawGroupMatch[2] ?? "");
  }

  return null;
}

function collectGroupMemberIdentities(source: unknown, out: Set<string>): void {
  if (!Array.isArray(source)) {
    return;
  }
  for (const member of source) {
    if (typeof member === "string") {
      const normalized = tryNormalizeIdentity(member);
      if (normalized) {
        out.add(normalized);
      }
      continue;
    }
    if (!member || typeof member !== "object") {
      continue;
    }
    const asRecord = member as Record<string, unknown>;
    const identityValue = asRecord.identity ?? asRecord.memberIdentity ?? asRecord.id;
    if (typeof identityValue === "string") {
      const normalized = tryNormalizeIdentity(identityValue);
      if (normalized) {
        out.add(normalized);
      }
    }
  }
}

function resolveGroupRecipients(params: {
  dataDir: string;
  creatorIdentity: string;
  groupId: bigint;
  selfIdentity: string;
}): string[] {
  const { dataDir, creatorIdentity, groupId, selfIdentity } = params;
  const recipients = new Set<string>();
  if (creatorIdentity !== selfIdentity) {
    recipients.add(creatorIdentity);
  }

  const groupsPath = path.join(dataDir, "groups.json");
  if (fs.existsSync(groupsPath)) {
    try {
      const raw = fs.readFileSync(groupsPath, "utf-8").trim();
      if (raw.length > 0) {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) {
          for (const entry of parsed) {
            if (!entry || typeof entry !== "object") {
              continue;
            }
            const record = entry as Record<string, unknown>;
            const normalizedCreator = resolveCreatorIdentityFromGroupRecord(record);
            if (normalizedCreator !== creatorIdentity) {
              continue;
            }

            const entryGroupId = resolveGroupIdFromGroupRecord(record);
            if (entryGroupId === null || entryGroupId !== groupId) {
              continue;
            }

            collectGroupMembersFromGroupRecord(record, recipients);
          }
        }
      }
    } catch (err) {
      console.warn(`[threema] Failed to read groups.json for recipient resolution: ${String(err)}`);
    }
  }

  const observed = observedGroupMemberIdentities.get(
    buildObservedGroupMemberKey(creatorIdentity, groupId),
  );
  if (observed) {
    for (const memberIdentity of observed) {
      recipients.add(memberIdentity);
    }
  }

  recipients.delete(selfIdentity);
  return Array.from(recipients);
}

function resolveGroupReplyRecipients(params: {
  client: MediatorClient;
  accountId: string;
  senderIdentity: string;
  groupCreator: string;
  groupIdBytes: Uint8Array;
  ctx: any;
}): string[] {
  if (params.groupIdBytes.length !== 8) {
    params.ctx.log?.warn?.(
      `[${params.accountId}] Invalid groupId bytes length ${params.groupIdBytes.length}; falling back to sender recipient`,
    );
    const senderFallback = tryNormalizeIdentity(params.senderIdentity);
    return senderFallback ? [senderFallback] : [];
  }
  const groupCreator = tryNormalizeIdentity(params.groupCreator);
  if (!groupCreator) {
    params.ctx.log?.warn?.(
      `[${params.accountId}] Invalid group creator "${params.groupCreator}"; falling back to sender recipient`,
    );
    const senderFallback = tryNormalizeIdentity(params.senderIdentity);
    return senderFallback ? [senderFallback] : [];
  }

  const selfIdentity = params.client.getIdentity().trim().toUpperCase();
  const groupId = new DataView(
    params.groupIdBytes.buffer,
    params.groupIdBytes.byteOffset,
    params.groupIdBytes.byteLength,
  ).getBigUint64(0, true);
  const recipients = new Set(
    resolveGroupRecipients({
      dataDir: params.client.getDataDir(),
      creatorIdentity: groupCreator,
      groupId,
      selfIdentity,
    }),
  );

  // Ensure the requesting member still receives replies when groups.json is stale.
  const senderIdentity = tryNormalizeIdentity(params.senderIdentity);
  if (senderIdentity && senderIdentity !== selfIdentity) {
    recipients.add(senderIdentity);
  }

  if (recipients.size === 0) {
    params.ctx.log?.warn?.(
      `[${params.accountId}] No resolved recipients for ${groupCreator}/${groupId.toString()}; sending reflect-only group message`,
    );
  }
  return Array.from(recipients);
}

const REACTIONS_STORE_FILE = "reactions.json";

type PersistedReactionSource = "reaction" | "legacy_receipt";

type PersistedReactionEntry = {
  emoji: string;
  reactedAt: number;
  source: PersistedReactionSource;
};

type PersistedMessageReactionState = {
  chatId: string;
  messageId: string;
  updatedAt: number;
  bySender: Record<string, PersistedReactionEntry[]>;
};

type PersistedReactionStore = {
  version: 1;
  messages: Record<string, PersistedMessageReactionState>;
};

type ReactionPersistenceEvent = {
  chatId: string;
  messageId: string;
  senderIdentity: string;
  emoji: string;
  action: ThreemaReactionAction;
  reactedAt: number;
  source: PersistedReactionSource;
  legacyReplaceSender: boolean;
};

function normalizeTimestampMillis(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === "bigint" && value > 0n) {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber) && asNumber > 0) {
      return asNumber < 1_000_000_000_000 ? asNumber * 1000 : asNumber;
    }
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      try {
        const asBigInt = BigInt(trimmed);
        return normalizeTimestampMillis(asBigInt);
      } catch {
        const parsed = Number(trimmed);
        if (Number.isFinite(parsed) && parsed > 0) {
          return normalizeTimestampMillis(parsed);
        }
      }
    }
  }
  return Date.now();
}

function normalizeReactionStore(data: unknown): PersistedReactionStore {
  if (!data || typeof data !== "object") {
    return { version: 1, messages: {} };
  }
  const record = data as Record<string, unknown>;
  const normalized: PersistedReactionStore = {
    version: 1,
    messages: {},
  };
  const rawMessages = record.messages;
  if (!rawMessages || typeof rawMessages !== "object" || Array.isArray(rawMessages)) {
    return normalized;
  }

  for (const [key, value] of Object.entries(rawMessages)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const rawState = value as Record<string, unknown>;
    const chatId = typeof rawState.chatId === "string" ? rawState.chatId : "";
    const messageId = typeof rawState.messageId === "string" ? rawState.messageId : "";
    if (!chatId || !messageId) {
      continue;
    }
    const bySender: Record<string, PersistedReactionEntry[]> = {};
    const rawBySender = rawState.bySender;
    if (rawBySender && typeof rawBySender === "object" && !Array.isArray(rawBySender)) {
      for (const [sender, senderValue] of Object.entries(rawBySender)) {
        if (!Array.isArray(senderValue)) {
          continue;
        }
        const entries: PersistedReactionEntry[] = [];
        for (const entry of senderValue) {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            continue;
          }
          const rawEntry = entry as Record<string, unknown>;
          if (typeof rawEntry.emoji !== "string" || rawEntry.emoji.length === 0) {
            continue;
          }
          const source = rawEntry.source === "legacy_receipt" ? "legacy_receipt" : "reaction";
          const reactedAt = normalizeTimestampMillis(rawEntry.reactedAt);
          entries.push({
            emoji: rawEntry.emoji,
            reactedAt,
            source,
          });
        }
        if (entries.length > 0) {
          bySender[sender] = entries;
        }
      }
    }

    if (Object.keys(bySender).length === 0) {
      continue;
    }

    normalized.messages[key] = {
      chatId,
      messageId,
      updatedAt: normalizeTimestampMillis(rawState.updatedAt),
      bySender,
    };
  }

  return normalized;
}

function readReactionStore(dataDir: string): PersistedReactionStore {
  const storePath = path.join(dataDir, REACTIONS_STORE_FILE);
  if (!fs.existsSync(storePath)) {
    return { version: 1, messages: {} };
  }
  const raw = fs.readFileSync(storePath, "utf-8").trim();
  if (!raw) {
    return { version: 1, messages: {} };
  }
  return normalizeReactionStore(JSON.parse(raw));
}

function writeReactionStore(dataDir: string, store: PersistedReactionStore): void {
  const storePath = path.join(dataDir, REACTIONS_STORE_FILE);
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const tmpPath = `${storePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2) + "\n");
  fs.renameSync(tmpPath, storePath);
}

function buildReactionStoreKey(chatId: string, messageId: string): string {
  return `${chatId}#${messageId}`;
}

function applyReactionEventToStore(store: PersistedReactionStore, event: ReactionPersistenceEvent): boolean {
  const key = buildReactionStoreKey(event.chatId, event.messageId);
  const current: PersistedMessageReactionState = store.messages[key] ?? {
    chatId: event.chatId,
    messageId: event.messageId,
    updatedAt: Date.now(),
    bySender: {},
  };

  const senderKey = event.senderIdentity;
  const existingSenderEntries = current.bySender[senderKey] ?? [];
  const workingEntries = event.legacyReplaceSender ? [] : [...existingSenderEntries];

  if (event.action === "apply") {
    const existing = workingEntries.find((entry) => entry.emoji === event.emoji);
    if (existing) {
      existing.reactedAt = event.reactedAt;
      existing.source = event.source;
    } else {
      workingEntries.push({
        emoji: event.emoji,
        reactedAt: event.reactedAt,
        source: event.source,
      });
    }
  } else {
    for (let i = workingEntries.length - 1; i >= 0; i--) {
      if (workingEntries[i]?.emoji === event.emoji) {
        workingEntries.splice(i, 1);
      }
    }
  }

  if (workingEntries.length === 0) {
    delete current.bySender[senderKey];
  } else {
    current.bySender[senderKey] = workingEntries;
  }

  if (Object.keys(current.bySender).length === 0) {
    if (store.messages[key]) {
      delete store.messages[key];
      return true;
    }
    return false;
  }

  current.updatedAt = Date.now();
  store.messages[key] = current;
  return true;
}

function persistReactionEvent(params: {
  account: { accountId: string; dataDir: string };
  event: ReactionPersistenceEvent;
  ctx: any;
}): void {
  const { account, event, ctx } = params;
  try {
    const store = readReactionStore(account.dataDir);
    const changed = applyReactionEventToStore(store, event);
    if (!changed) {
      return;
    }
    writeReactionStore(account.dataDir, store);
  } catch (err) {
    ctx?.log?.warn?.(
      `[${account.accountId}] Failed persisting reaction ${event.chatId}#${event.messageId}: ${String(err)}`,
    );
  }
}

type NormalizedMediaPayloadInput = {
  kind: "image" | "audio";
  bytes: Uint8Array;
  mediaType: string;
  fileName?: string;
  caption?: string;
  durationSeconds?: number;
};

type NormalizedDirectMediaSendInput = NormalizedMediaPayloadInput & {
  recipientIdentity: string;
};

type NormalizedGroupMediaSendInput = NormalizedMediaPayloadInput & {
  groupCreator: string;
  groupIdBytes: Uint8Array;
  memberIdentities: string[];
};

type NormalizedMediaSendRequest =
  | {
      target: {
        kind: "direct";
        recipientIdentity: string;
      };
      payload: NormalizedMediaPayloadInput;
    }
  | {
      target: {
        kind: "group";
        creatorIdentity: string;
        groupId: bigint;
        groupIdBytes: Uint8Array;
      };
      payload: NormalizedMediaPayloadInput;
    };

type StoredInboundMedia = {
  filePath: string;
  relativeFilePath: string;
  fileSize: number;
  thumbnailPath?: string;
  relativeThumbnailPath?: string;
};

type VoiceReplyInstruction = {
  text: string;
  caption?: string;
  sendTextAlso: boolean;
};

type OutboundReplyMediaInstruction = {
  payload: NormalizedMediaPayloadInput;
  sendTextAlso: boolean;
};

type GroupCommand = {
  name: string;
};

function parseBooleanEnv(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (!raw) {
    return defaultValue;
  }
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function shouldAutoDownloadMedia(): boolean {
  return parseBooleanEnv("THREEMA_MEDIA_AUTO_DOWNLOAD", true);
}

function shouldAutoTranscribeAudio(): boolean {
  return parseBooleanEnv("THREEMA_TRANSCRIBE_AUDIO", true);
}

function shouldEnableVoiceReplies(): boolean {
  return parseBooleanEnv("THREEMA_VOICE_REPLY_ENABLED", true);
}

function shouldSendVoiceReplyTextAlso(): boolean {
  return parseBooleanEnv("THREEMA_VOICE_REPLY_SEND_TEXT_ALSO", false);
}

function shouldAutoVoiceReplyOnExplicitRequest(): boolean {
  return parseBooleanEnv("THREEMA_VOICE_REPLY_AUTO_ON_REQUEST", true);
}

function shouldForceOutboundAudioM4a(): boolean {
  return parseBooleanEnv("THREEMA_AUDIO_FORCE_M4A", true);
}

function shouldSendMediaReplyTextFallbackOnError(): boolean {
  return parseBooleanEnv("THREEMA_MEDIA_REPLY_TEXT_FALLBACK_ON_ERROR", true);
}

function resolveMediaDownloadMaxBytes(): number {
  return parsePositiveIntEnv("THREEMA_MEDIA_DOWNLOAD_MAX_BYTES", DEFAULT_MEDIA_DOWNLOAD_MAX_BYTES);
}

function resolveTranscribeMaxBytes(): number {
  return parsePositiveIntEnv("THREEMA_TRANSCRIBE_MAX_BYTES", DEFAULT_TRANSCRIBE_MAX_BYTES);
}

function resolveVoiceReplyMaxTextChars(): number {
  return parsePositiveIntEnv("THREEMA_VOICE_REPLY_MAX_TEXT_CHARS", DEFAULT_VOICE_REPLY_MAX_TEXT_CHARS);
}

function mediaTypeToExtension(mediaType: string): string {
  const normalized = mediaType.trim().toLowerCase();
  switch (normalized) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "audio/wav":
      return ".wav";
    case "audio/x-wav":
      return ".wav";
    case "audio/mpeg":
      return ".mp3";
    case "audio/mp4":
      return ".m4a";
    case "audio/ogg":
      return ".ogg";
    case "audio/opus":
      return ".opus";
    case "audio/aac":
      return ".aac";
    default: {
      const subtype = normalized.split("/")[1] ?? "";
      if (!subtype || !/^[a-z0-9.+-]+$/.test(subtype)) {
        return ".bin";
      }
      const safeSubtype = subtype.replaceAll("+", ".").replace(/[^a-z0-9.-]/g, "");
      return safeSubtype.length > 0 ? `.${safeSubtype}` : ".bin";
    }
  }
}

function guessMediaTypeFromFileName(fileName: string | undefined, fallback = "application/octet-stream"): string {
  if (!fileName) {
    return fallback;
  }
  const ext = path.extname(fileName).trim().toLowerCase();
  switch (ext) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".wav":
      return "audio/wav";
    case ".mp3":
      return "audio/mpeg";
    case ".m4a":
      return "audio/mp4";
    case ".ogg":
      return "audio/ogg";
    case ".opus":
      return "audio/opus";
    case ".aac":
      return "audio/aac";
    default:
      return fallback;
  }
}

function inferDirectMediaKind(mediaType: string): "image" | "audio" | null {
  const normalized = mediaType.trim().toLowerCase();
  if (normalized.startsWith("image/")) {
    return "image";
  }
  if (normalized.startsWith("audio/")) {
    return "audio";
  }
  return null;
}

function isAudioMediaType(mediaType: string): boolean {
  return mediaType.trim().toLowerCase().startsWith("audio/");
}

function toUint8Array(input: unknown): Uint8Array | null {
  if (input instanceof Uint8Array) {
    return input;
  }
  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input);
  }
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  if (Array.isArray(input)) {
    return new Uint8Array(input);
  }
  return null;
}

function parseOptionalNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return undefined;
}

function normalizeMediaPayloadInput(input: any): NormalizedMediaPayloadInput {
  const directBytes =
    toUint8Array(input?.bytes)
    ?? toUint8Array(input?.data)
    ?? toUint8Array(input?.content)
    ?? toUint8Array(input?.mediaBytes);
  let bytes = directBytes;
  const filePath = typeof input?.filePath === "string" ? input.filePath : undefined;
  if (!bytes && filePath) {
    bytes = new Uint8Array(fs.readFileSync(filePath));
  }
  if (!bytes && typeof input?.base64Data === "string") {
    const trimmedBase64 = input.base64Data.trim();
    const commaIndex = trimmedBase64.indexOf(",");
    const payload = trimmedBase64.startsWith("data:") && commaIndex >= 0
      ? trimmedBase64.slice(commaIndex + 1)
      : trimmedBase64;
    bytes = new Uint8Array(Buffer.from(payload, "base64"));
  }
  if (!bytes || bytes.length === 0) {
    throw new Error("Media payload is empty (expected bytes, filePath, or base64Data)");
  }

  const explicitFileName = typeof input?.fileName === "string" ? input.fileName.trim() : "";
  const inferredFileName = explicitFileName.length > 0
    ? explicitFileName
    : (filePath ? path.basename(filePath) : undefined);
  const mediaType = String(
    input?.mediaType
    ?? input?.mimeType
    ?? input?.mime
    ?? guessMediaTypeFromFileName(inferredFileName),
  ).trim().toLowerCase();
  if (!mediaType.includes("/")) {
    throw new Error(`Invalid mediaType "${mediaType}"`);
  }

  const explicitKind = typeof input?.kind === "string" ? input.kind.trim().toLowerCase() : "";
  const inferredKind = inferDirectMediaKind(mediaType);
  const kind = explicitKind === "image" || explicitKind === "audio"
    ? explicitKind
    : inferredKind;
  if (!kind) {
    throw new Error(`Unable to infer direct media kind for mediaType "${mediaType}"`);
  }

  const caption = typeof input?.caption === "string" && input.caption.trim().length > 0
    ? input.caption
    : undefined;
  const durationSeconds = parseOptionalNonNegativeNumber(
    input?.durationSeconds ?? input?.duration ?? input?.voiceDurationSeconds,
  );

  return {
    kind,
    bytes,
    mediaType,
    fileName: inferredFileName,
    caption,
    durationSeconds,
  };
}

function normalizeOutboundMediaPayloadForSend<T extends NormalizedMediaPayloadInput>(params: {
  accountId: string;
  input: T;
}): T {
  const { accountId, input } = params;
  if (input.kind !== "audio" || !shouldForceOutboundAudioM4a()) {
    return input;
  }

  try {
    const normalizedAudio = normalizeAudioMemoForThreema({
      bytes: input.bytes,
      mediaType: input.mediaType,
      fileName: input.fileName,
      durationSeconds: input.durationSeconds,
      forceM4a: true,
    });
    if (normalizedAudio.transcoded) {
      console.log(
        `[threema] [${accountId}] Normalized outbound audio to ${normalizedAudio.mediaType}/${normalizedAudio.fileName}`,
      );
    }
    return {
      ...input,
      bytes: normalizedAudio.bytes,
      mediaType: normalizedAudio.mediaType,
      fileName: normalizedAudio.fileName,
      durationSeconds: normalizedAudio.durationSeconds,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Outbound audio normalization failed: ${message}`);
  }
}

function normalizeDirectMediaSendInput(input: any): NormalizedDirectMediaSendInput {
  const recipientIdentity = String(
    input?.recipientIdentity ?? input?.to ?? input?.target ?? "",
  ).trim().toUpperCase();
  if (!/^[*0-9A-Z]{8}$/.test(recipientIdentity)) {
    throw new Error(`Invalid recipient identity "${recipientIdentity}"`);
  }

  return {
    recipientIdentity,
    ...normalizeMediaPayloadInput(input),
  };
}

function normalizeMediaSendTarget(input: any): ParsedThreemaChatTarget {
  const candidate = String(
    input?.chatId
    ?? input?.conversation
    ?? input?.recipientIdentity
    ?? input?.to
    ?? input?.target
    ?? "",
  ).trim();

  if (candidate.length > 0) {
    const parsedChatTarget = parseThreemaChatTarget(candidate);
    if (parsedChatTarget) {
      return parsedChatTarget;
    }

    const normalizedIdentity = tryNormalizeIdentity(candidate);
    if (normalizedIdentity) {
      return {
        kind: "direct",
        chatId: `threema:${normalizedIdentity}`,
        recipientIdentity: normalizedIdentity,
      };
    }

    const legacyGroupMatch = candidate.match(/^group:([*0-9a-z]{8})\/([0-9]+)$/i);
    if (legacyGroupMatch) {
      const creatorIdentity = tryNormalizeIdentity(legacyGroupMatch[1] ?? "");
      const groupId = parseU64(legacyGroupMatch[2] ?? "");
      if (creatorIdentity && groupId !== null) {
        const groupIdBytes = new Uint8Array(8);
        new DataView(groupIdBytes.buffer).setBigUint64(0, groupId, true);
        return {
          kind: "group",
          chatId: `threema:group:${creatorIdentity}/${groupId.toString()}`,
          creatorIdentity,
          groupId,
          groupIdBytes,
        };
      }
    }
  }

  const explicitGroupCreator = tryNormalizeIdentity(
    String(input?.groupCreator ?? input?.creatorIdentity ?? ""),
  );
  const explicitGroupId = parseU64(input?.groupId);
  if (explicitGroupCreator && explicitGroupId !== null) {
    const groupIdBytes = new Uint8Array(8);
    new DataView(groupIdBytes.buffer).setBigUint64(0, explicitGroupId, true);
    return {
      kind: "group",
      chatId: `threema:group:${explicitGroupCreator}/${explicitGroupId.toString()}`,
      creatorIdentity: explicitGroupCreator,
      groupId: explicitGroupId,
      groupIdBytes,
    };
  }

  throw new Error(
    "Invalid media target (expected direct Threema ID, chatId threema:..., group:<CREATOR>/<GROUP_ID>, threema:g-group-<CREATOR>-<GROUP_ID>, or groupCreator+groupId)",
  );
}

function normalizeMediaSendRequestInput(input: any): NormalizedMediaSendRequest {
  const target = normalizeMediaSendTarget(input);
  const payload = normalizeMediaPayloadInput(input);
  if (target.kind === "direct") {
    return {
      target: {
        kind: "direct",
        recipientIdentity: target.recipientIdentity,
      },
      payload,
    };
  }
  return {
    target: {
      kind: "group",
      creatorIdentity: target.creatorIdentity,
      groupId: target.groupId,
      groupIdBytes: target.groupIdBytes,
    },
    payload,
  };
}

function sanitizeFileComponent(value: string): string {
  const replaced = value.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/_+/g, "_");
  const trimmed = replaced.replace(/^_+|_+$/g, "");
  return trimmed.length > 0 ? trimmed : "file";
}

function ensureFileExtension(fileName: string, mediaType: string): string {
  if (path.extname(fileName).length > 0) {
    return fileName;
  }
  return `${fileName}${mediaTypeToExtension(mediaType)}`;
}

function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "unknown";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kib = bytes / 1024;
  if (kib < 1024) {
    return `${kib.toFixed(1)} KiB`;
  }
  const mib = kib / 1024;
  return `${mib.toFixed(2)} MiB`;
}

function storeInboundResolvedMedia(params: {
  account: ResolvedThreemaAccount;
  senderIdentity: string;
  messageId: string;
  resolved: ResolvedDirectFileMessage;
}): StoredInboundMedia {
  const { account, senderIdentity, messageId, resolved } = params;
  const storeDir = path.join(
    account.dataDir,
    MEDIA_STORAGE_SUBDIR,
    "inbound",
    sanitizeFileComponent(senderIdentity),
  );
  fs.mkdirSync(storeDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
  const safeMessageId = sanitizeFileComponent(messageId || "msg");
  const baseName = sanitizeFileComponent(
    ensureFileExtension(
      resolved.descriptor.fileName?.trim() || `media-${safeMessageId}`,
      resolved.descriptor.mediaType,
    ),
  );
  const fileName = `${timestamp}-${safeMessageId}-${baseName}`;
  const filePath = path.join(storeDir, fileName);
  fs.writeFileSync(filePath, Buffer.from(resolved.file.bytes));

  let thumbnailPath: string | undefined;
  if (resolved.thumbnail) {
    const thumbnailExt = mediaTypeToExtension(
      resolved.descriptor.thumbnailMediaType ?? "image/jpeg",
    );
    const thumbnailName = `${timestamp}-${safeMessageId}-thumb${thumbnailExt}`;
    thumbnailPath = path.join(storeDir, thumbnailName);
    fs.writeFileSync(thumbnailPath, Buffer.from(resolved.thumbnail.bytes));
  }

  return {
    filePath,
    relativeFilePath: path.relative(account.dataDir, filePath),
    fileSize: resolved.file.bytes.length,
    thumbnailPath,
    relativeThumbnailPath: thumbnailPath ? path.relative(account.dataDir, thumbnailPath) : undefined,
  };
}

function buildInboundMediaText(params: {
  senderIdentity: string;
  mediaType: string;
  stored: StoredInboundMedia;
  fileName?: string;
  caption?: string;
  transcription?: string;
}): string {
  const lines = [
    `[Media message from ${params.senderIdentity}]`,
    `Type: ${params.mediaType}`,
    `File: ${params.fileName ?? path.basename(params.stored.filePath)}`,
    `Size: ${formatByteSize(params.stored.fileSize)}`,
    `Saved: ${params.stored.filePath}`,
  ];
  if (params.caption) {
    lines.push(`Caption: ${params.caption}`);
  }
  if (params.stored.thumbnailPath) {
    lines.push(`Thumbnail: ${params.stored.thumbnailPath}`);
  }
  if (params.transcription) {
    lines.push("Voice memo transcript:");
    lines.push(params.transcription);
  }
  return lines.join("\n");
}

const VOICE_REPLY_NEGATION_PATTERN =
  /\b(?:do\s+not|don't|dont|no|not)\b[\s\S]{0,28}\b(?:voice|audio|memo)\b/i;

const VOICE_REPLY_REQUEST_PATTERNS: RegExp[] = [
  /\b(?:reply|respond|answer)\b[\s\S]{0,40}\b(?:with|via|using|as)\b[\s\S]{0,24}\b(?:voice(?:\s+memo|\s+message)?|audio(?:\s+memo|\s+message)?|memo)\b/i,
  /\b(?:send|record|leave|return)\b[\s\S]{0,32}\b(?:voice(?:\s+memo|\s+message)?|audio(?:\s+memo|\s+message)?|memo)\b/i,
  /\b(?:voice|audio)\s*(?:reply|response|memo|message)\b/i,
  /\brespond\s+in\s+(?:voice|audio)\b/i,
];

function hasExplicitVoiceReplyRequest(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return false;
  }
  if (VOICE_REPLY_NEGATION_PATTERN.test(normalized)) {
    return false;
  }
  return VOICE_REPLY_REQUEST_PATTERNS.some((pattern) => pattern.test(normalized));
}

function shouldForceVoiceReplyFromInboundMessage(params: {
  text: string;
  contextOverrides?: Record<string, unknown>;
}): boolean {
  if (!shouldEnableVoiceReplies() || !shouldAutoVoiceReplyOnExplicitRequest()) {
    return false;
  }

  const candidates: string[] = [];
  if (typeof params.contextOverrides?.MediaTranscript === "string") {
    candidates.push(params.contextOverrides.MediaTranscript);
  }
  if (typeof params.contextOverrides?.MediaCaption === "string") {
    candidates.push(params.contextOverrides.MediaCaption);
  }
  candidates.push(params.text);
  return candidates.some((candidate) => hasExplicitVoiceReplyRequest(candidate));
}

function extractVoiceInstructionFromText(text: string): VoiceReplyInstruction | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  const tagged = trimmed.match(/^<voice(?:\s+caption=\"([^\"]*)\")?>([\s\S]*?)<\/voice>$/i);
  if (tagged) {
    const inner = tagged[2]?.trim() ?? "";
    if (inner.length === 0) {
      return null;
    }
    const caption = tagged[1]?.trim() || undefined;
    return {
      text: inner,
      caption,
      sendTextAlso: shouldSendVoiceReplyTextAlso(),
    };
  }

  const markerMatch = trimmed.match(/^(?:\[voice\]|\[audio\]|\/voice\b|!voice\b)\s*/i);
  if (!markerMatch) {
    return null;
  }
  const remainder = trimmed.slice(markerMatch[0].length).trim();
  if (!remainder) {
    return null;
  }
  return {
    text: remainder,
    sendTextAlso: shouldSendVoiceReplyTextAlso(),
  };
}

function extractVoiceReplyInstruction(payload: any, replyText: string): VoiceReplyInstruction | null {
  if (!shouldEnableVoiceReplies()) {
    return null;
  }

  const voiceConfig = payload?.voiceReply;
  if (voiceConfig && typeof voiceConfig === "object") {
    const disabled = (voiceConfig as any).enabled === false;
    if (disabled) {
      return null;
    }
    const voiceText = String((voiceConfig as any).text ?? replyText ?? "").trim();
    if (!voiceText) {
      return null;
    }
    return {
      text: voiceText,
      caption: typeof (voiceConfig as any).caption === "string"
        ? (voiceConfig as any).caption
        : undefined,
      sendTextAlso: typeof (voiceConfig as any).sendTextAlso === "boolean"
        ? (voiceConfig as any).sendTextAlso
        : shouldSendVoiceReplyTextAlso(),
    };
  }

  if (payload?.voice === true) {
    const voiceText = String(payload?.text ?? payload?.body ?? replyText ?? "").trim();
    if (!voiceText) {
      return null;
    }
    return {
      text: voiceText,
      sendTextAlso: shouldSendVoiceReplyTextAlso(),
    };
  }

  return extractVoiceInstructionFromText(replyText);
}

function parseMediaDirectiveArgument(rawText: string): string | null {
  const text = rawText.trim();
  if (!text) {
    return null;
  }

  const directive = text.match(/^MEDIA:\s*(.+)$/im);
  if (!directive) {
    return null;
  }

  const rawArgument = directive[1]?.trim() ?? "";
  if (!rawArgument) {
    return null;
  }

  const stripped = rawArgument.replace(/^['"]|['"]$/g, "").trim();
  if (!stripped) {
    return null;
  }
  return stripped;
}

function parseMediaDirectiveFromText(rawText: string): OutboundReplyMediaInstruction | null {
  const directiveArgument = parseMediaDirectiveArgument(rawText);
  if (!directiveArgument) {
    return null;
  }
  try {
    const normalizedPayload = normalizeMediaPayloadInput({
      filePath: directiveArgument,
    });
    return {
      payload: normalizedPayload,
      sendTextAlso: false,
    };
  } catch {
    return null;
  }
}

function extractMediaDirectiveParseError(rawText: string): string | null {
  const directiveArgument = parseMediaDirectiveArgument(rawText);
  if (!directiveArgument) {
    return null;
  }
  try {
    normalizeMediaPayloadInput({
      filePath: directiveArgument,
    });
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `MEDIA directive "${directiveArgument}" could not be resolved: ${message}`;
  }
}

function buildMediaReplyFallbackText(reason: string): string {
  const compactReason = reason.replace(/\s+/g, " ").trim();
  return `Failed to send media reply: ${compactReason}`;
}

function extractMediaReplyInstruction(payload: any, replyText: string): OutboundReplyMediaInstruction | null {
  const mediaCandidate = payload?.media && typeof payload.media === "object"
    ? payload.media
    : null;
  if (mediaCandidate) {
    try {
      const normalizedPayload = normalizeMediaPayloadInput(mediaCandidate);
      const sendTextAlso = typeof payload?.media?.sendTextAlso === "boolean"
        ? payload.media.sendTextAlso
        : false;
      return {
        payload: normalizedPayload,
        sendTextAlso,
      };
    } catch {}
  }

  return parseMediaDirectiveFromText(replyText);
}

function parseGroupCommand(text: string): GroupCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }
  const match = trimmed.match(/^\/group(?:\s+(.+))?$/i);
  if (!match) {
    return null;
  }
  return {
    name: (match[1] ?? "").trim(),
  };
}

async function handleGroupCommand(params: {
  account: ResolvedThreemaAccount;
  senderIdentity: string;
  text: string;
  ctx: any;
}): Promise<boolean> {
  const command = parseGroupCommand(params.text);
  if (!command) {
    return false;
  }

  const senderIdentity = tryNormalizeIdentity(params.senderIdentity);
  const client = activeClients.get(params.account.accountId);
  if (!senderIdentity || !client) {
    params.ctx.log?.warn?.(
      `[${params.account.accountId}] /group ignored: client unavailable or invalid sender identity`,
    );
    return true;
  }

  if (!command.name) {
    const usageId = await client.sendTextMessage(
      senderIdentity,
      "Usage: /group <group-name>",
    );
    trackSentMessage(usageId.toString());
    return true;
  }

  try {
    await client.waitForLeaderAndCsp(60_000);

    const created = await client.createGroupWithMembers({
      name: command.name,
      memberIdentities: [senderIdentity],
      requireCsp: true,
    });
    const creatorIdentity = client.getIdentity().trim().toUpperCase();
    for (const memberIdentity of created.members) {
      rememberObservedGroupMember({
        creatorIdentity,
        groupId: created.groupIdBigInt,
        memberIdentity,
        dataDir: client.getDataDir(),
      });
    }
    try {
      upsertGroupNameInGroupsFile({
        dataDir: client.getDataDir(),
        creatorIdentity,
        groupId: created.groupIdBigInt,
        name: command.name,
      });
    } catch (err) {
      params.ctx.log?.warn?.(
        `[${params.account.accountId}] Failed persisting created group name "${command.name}" for ${creatorIdentity}/${created.groupIdBigInt.toString()}: ${String(err)}`,
      );
    }
    const groupChatId = `threema:group:${creatorIdentity}/${created.groupIdBigInt.toString()}`;

    const bootstrapText = `Session "${command.name}" created. Continue in this group.\nSession chatId: ${groupChatId}`;
    const bootstrapMessageId = await client.sendGroupTextMessage(
      creatorIdentity,
      created.groupId,
      created.members,
      bootstrapText,
      { requireCsp: true },
    );
    trackSentMessage(bootstrapMessageId.toString());

    const directConfirmation = [
      `Created group "${command.name}" and invited you.`,
      `Group chat: ${groupChatId}`,
      "A bootstrap message has been posted there so it is a distinct session.",
    ].join("\n");
    const confirmationId = await client.sendTextMessage(senderIdentity, directConfirmation);
    trackSentMessage(confirmationId.toString());

    params.ctx.log?.info?.(
      `[${params.account.accountId}] /group created ${groupChatId} for ${senderIdentity}`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    params.ctx.log?.warn?.(
      `[${params.account.accountId}] /group failed for ${senderIdentity}: ${message}`,
    );

    try {
      const failureId = await client.sendTextMessage(
        senderIdentity,
        `Failed to create group "${command.name}": ${message}`,
      );
      trackSentMessage(failureId.toString());
    } catch {}
  }

  return true;
}

async function sendDirectMediaForAccount(params: {
  accountId: string;
  input: NormalizedDirectMediaSendInput;
}): Promise<bigint> {
  const normalizedInput = normalizeOutboundMediaPayloadForSend({
    accountId: params.accountId,
    input: params.input,
  });
  const client = activeClients.get(params.accountId);
  if (!client) {
    throw new Error(`Threema client not running for account ${params.accountId}`);
  }

  if (!client.isLeader() || !client.isCspReady()) {
    await client.waitForLeaderAndCsp(60_000);
  }

  return await client.sendDirectMediaMessage({
    recipientIdentity: normalizedInput.recipientIdentity,
    kind: normalizedInput.kind,
    bytes: normalizedInput.bytes,
    mediaType: normalizedInput.mediaType,
    fileName: normalizedInput.fileName,
    caption: normalizedInput.caption,
    durationSeconds: normalizedInput.durationSeconds,
  });
}

async function sendGroupMediaForAccount(params: {
  accountId: string;
  input: NormalizedGroupMediaSendInput;
  requireCsp?: boolean;
}): Promise<bigint> {
  const normalizedInput = normalizeOutboundMediaPayloadForSend({
    accountId: params.accountId,
    input: params.input,
  });
  const client = activeClients.get(params.accountId);
  if (!client) {
    throw new Error(`Threema client not running for account ${params.accountId}`);
  }

  const requireCsp = params.requireCsp ?? true;

  if (requireCsp && (!client.isLeader() || !client.isCspReady())) {
    await client.waitForLeaderAndCsp(60_000);
  }

  return await client.sendGroupMediaMessage({
    groupCreator: normalizedInput.groupCreator,
    groupId: normalizedInput.groupIdBytes,
    memberIdentities: normalizedInput.memberIdentities,
    kind: normalizedInput.kind,
    bytes: normalizedInput.bytes,
    mediaType: normalizedInput.mediaType,
    fileName: normalizedInput.fileName,
    caption: normalizedInput.caption,
    durationSeconds: normalizedInput.durationSeconds,
    requireCsp,
  });
}

async function sendMediaForAccount(params: {
  accountId: string;
  request: NormalizedMediaSendRequest;
}): Promise<bigint> {
  const { accountId, request } = params;
  if (request.target.kind === "direct") {
    return await sendDirectMediaForAccount({
      accountId,
      input: {
        recipientIdentity: request.target.recipientIdentity,
        ...request.payload,
      },
    });
  }

  const client = activeClients.get(accountId);
  if (!client) {
    throw new Error(`Threema client not running for account ${accountId}`);
  }

  const memberIdentities = resolveGroupRecipients({
    dataDir: client.getDataDir(),
    creatorIdentity: request.target.creatorIdentity,
    groupId: request.target.groupId,
    selfIdentity: client.getIdentity().trim().toUpperCase(),
  });

  return await sendGroupMediaForAccount({
    accountId,
    input: {
      groupCreator: request.target.creatorIdentity,
      groupIdBytes: request.target.groupIdBytes,
      memberIdentities,
      ...request.payload,
    },
  });
}

const mediaOutboundHandlers: Record<string, unknown> = {
  sendMedia: async (payload: any) => {
    const aid = (payload?.accountId ?? DEFAULT_ACCOUNT_ID) as string;
    const candidateInput = payload?.media && typeof payload.media === "object"
      ? {
          ...payload.media,
          chatId: payload?.chatId ?? payload?.media?.chatId,
          to: payload?.to ?? payload?.target ?? payload?.recipientIdentity ?? payload?.media?.to,
          groupCreator: payload?.groupCreator ?? payload?.creatorIdentity ?? payload?.media?.groupCreator,
          groupId: payload?.groupId ?? payload?.media?.groupId,
        }
      : payload;
    const request = normalizeMediaSendRequestInput(candidateInput);
    const messageId = await sendMediaForAccount({
      accountId: aid,
      request,
    });
    return {
      channel: "threema" as any,
      messageId: messageId.toString(),
    };
  },
};

// ─── Channel Plugin ──────────────────────────────────────────────────────────

export const threemaPlugin: ChannelPlugin<ResolvedThreemaAccount> = {
  id: "threema",
  meta: {
    id: "threema",
    label: "Threema",
    selectionLabel: "Threema (Desktop Emulation)",
    docsPath: "/channels/threema",
    docsLabel: "threema",
    blurb: "End-to-end encrypted Threema messaging via multi-device protocol.",
    order: 110,
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    blockStreaming: true,
  },
  reload: { configPrefixes: ["channels.threema"] },

  config: {
    listAccountIds: (cfg) => Object.keys(getAccountsConfig(cfg)),
    resolveAccount: (cfg, accountId) => resolveThreemaAccount({ cfg, accountId }),
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    isConfigured: (account) => account.configured,
    isEnabled: (account) => account.enabled,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
    }),
    resolveAllowFrom: ({ cfg, accountId }) => {
      const account = resolveThreemaAccount({ cfg, accountId });
      return account.config.allowFrom ?? [];
    },
  },

  security: {
    resolveDmPolicy: ({ account }) => ({
      policy: account.config.dmPolicy ?? "open",
      allowFrom: account.config.allowFrom ?? [],
      policyPath: "channels.threema.dmPolicy",
      allowFromPath: "channels.threema.allowFrom",
      approveHint: formatPairingApproveHint("threema"),
    }),
  },

  pairing: {
    idLabel: "threemaId",
  },

  messaging: {
    normalizeTarget: (raw) => raw.trim().toUpperCase(),
    targetResolver: {
      looksLikeId: (input) => /^[*0-9A-Z]{8}$/.test(input.trim().toUpperCase()),
      hint: "<8-char Threema ID>",
    },
  },

  agentTools: () => {
    const Type = {
      Object: (p: any, o?: any) => ({ type: "object", properties: p, ...o }),
      String: (o?: any) => ({ type: "string", ...o }),
      Number: (o?: any) => ({ type: "number", ...o }),
    };
    return [
      {
        name: "threema_create_group",
        label: "Create Threema Group",
        description: "Create a new Threema group (self-only notes group) that becomes a distinct chat session. Returns the group ID.",
        parameters: Type.Object({
          name: Type.String({ description: "Group name" }),
        }, { required: ["name"] }),
        async execute(_toolCallId: string, params: { name: string }) {
          const client = activeClients.get(DEFAULT_ACCOUNT_ID);
          if (!client) {
            return {
              content: [{ type: "text" as const, text: "Error: Threema client not running" }],
              details: { error: true },
            };
          }
          const { groupIdBigInt } = await client.createGroup(params.name);
          const creatorIdentity = client.getIdentity().trim().toUpperCase();
          try {
            upsertGroupNameInGroupsFile({
              dataDir: client.getDataDir(),
              creatorIdentity,
              groupId: groupIdBigInt,
              name: params.name,
            });
          } catch (err) {
            console.warn(
              `[threema] Failed persisting created group name "${params.name}" for ${creatorIdentity}/${groupIdBigInt.toString()}: ${String(err)}`,
            );
          }
          const result = {
            success: true,
            groupName: params.name,
            groupId: groupIdBigInt.toString(),
            chatId: `threema:group:${creatorIdentity}/${groupIdBigInt}`,
          };
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
            details: result,
          };
        },
      },
      {
        name: "threema_send_media",
        label: "Send Threema Media",
        description: "Send an image/audio file via Threema to a direct or group chat. Provide filePath or base64Data.",
        parameters: Type.Object({
          to: Type.String({ description: "Recipient identity or target alias (8-char ID, threema:<ID>, group:<CREATOR>/<GROUP_ID>, or threema:g-group-<CREATOR>-<GROUP_ID>)." }),
          chatId: Type.String({ description: "Explicit chat id target (threema:<ID>, threema:group:<CREATOR>/<GROUP_ID>, or threema:g-group-<CREATOR>-<GROUP_ID>)." }),
          groupCreator: Type.String({ description: "Optional explicit group creator identity (alternative target form)." }),
          groupId: Type.String({ description: "Optional explicit group id as unsigned 64-bit integer decimal string." }),
          kind: Type.String({ description: "Optional: image or audio." }),
          filePath: Type.String({ description: "Absolute path to the media file." }),
          base64Data: Type.String({ description: "Base64 media payload (alternative to filePath)." }),
          mediaType: Type.String({ description: "Media type (for example image/jpeg or audio/wav)." }),
          fileName: Type.String({ description: "Optional display file name." }),
          caption: Type.String({ description: "Optional caption text." }),
          durationSeconds: Type.Number({ description: "Optional audio duration in seconds." }),
        }),
        async execute(_toolCallId: string, params: any) {
          try {
            const request = normalizeMediaSendRequestInput({
              ...params,
              to: params?.to,
              chatId: params?.chatId,
              groupCreator: params?.groupCreator,
              groupId: params?.groupId,
            });
            const messageId = await sendMediaForAccount({
              accountId: DEFAULT_ACCOUNT_ID,
              request,
            });
            const targetChatId = request.target.kind === "direct"
              ? `threema:${request.target.recipientIdentity}`
              : `threema:group:${request.target.creatorIdentity}/${request.target.groupId.toString()}`;
            const result = {
              success: true,
              chatId: targetChatId,
              kind: request.payload.kind,
              mediaType: request.payload.mediaType,
              fileName: request.payload.fileName,
              messageId: messageId.toString(),
            };
            return {
              content: [{ type: "text" as const, text: JSON.stringify(result) }],
              details: result,
            };
          } catch (err) {
            return {
              content: [{ type: "text" as const, text: `Error: ${String(err)}` }],
              details: { error: true },
            };
          }
        },
      },
      {
        name: "threema_react_to_message",
        label: "React To Threema Message",
        description: "Apply or withdraw an emoji reaction on a Threema message by chatId and messageId.",
        parameters: Type.Object({
          chatId: Type.String({ description: "Chat id (threema:<ID>, threema:group:<CREATOR>/<GROUP_ID>, or threema:g-group-<CREATOR>-<GROUP_ID>)." }),
          messageId: Type.String({ description: "Target message id (unsigned 64-bit integer as decimal string)." }),
          emoji: Type.String({ description: "Emoji to apply or withdraw." }),
          action: Type.String({ description: "apply or withdraw." }),
        }, { required: ["chatId", "messageId", "emoji", "action"] }),
        async execute(_toolCallId: string, params: any) {
          try {
            const client = activeClients.get(DEFAULT_ACCOUNT_ID);
            if (!client) {
              return {
                content: [{ type: "text" as const, text: "Error: Threema client not running" }],
                details: { error: true },
              };
            }

            const chatTarget = parseThreemaChatTarget(String(params?.chatId ?? ""));
            if (!chatTarget) {
              throw new Error("Invalid chatId (expected threema:<ID>, threema:group:<CREATOR>/<GROUP_ID>, or threema:g-group-<CREATOR>-<GROUP_ID>)");
            }

            const reactedMessageId = parseU64(params?.messageId);
            if (reactedMessageId === null || reactedMessageId <= 0n) {
              throw new Error("Invalid messageId (expected unsigned 64-bit integer)");
            }

            const emoji = typeof params?.emoji === "string" ? params.emoji.trim() : "";
            if (!emoji) {
              throw new Error("emoji must be a non-empty string");
            }

            const actionRaw = typeof params?.action === "string" ? params.action.trim().toLowerCase() : "";
            if (actionRaw !== "apply" && actionRaw !== "withdraw") {
              throw new Error("action must be \"apply\" or \"withdraw\"");
            }
            const action = actionRaw as ThreemaReactionAction;

            const result = chatTarget.kind === "direct"
              ? await client.sendDirectReaction(
                  chatTarget.recipientIdentity,
                  reactedMessageId,
                  emoji,
                  action,
                )
              : await client.sendGroupReaction(
                  chatTarget.creatorIdentity,
                  chatTarget.groupIdBytes,
                  resolveGroupRecipients({
                    dataDir: client.getDataDir(),
                    creatorIdentity: chatTarget.creatorIdentity,
                    groupId: chatTarget.groupId,
                    selfIdentity: client.getIdentity().trim().toUpperCase(),
                  }),
                  reactedMessageId,
                  emoji,
                  action,
                );

            if (result.messageId !== undefined) {
              trackSentMessage(result.messageId.toString());
            }

            if (result.sent) {
              persistReactionEvent({
                account: {
                  accountId: DEFAULT_ACCOUNT_ID,
                  dataDir: client.getDataDir(),
                },
                event: {
                  chatId: chatTarget.chatId,
                  messageId: reactedMessageId.toString(),
                  senderIdentity: client.getIdentity().trim().toUpperCase(),
                  emoji,
                  action,
                  reactedAt: Date.now(),
                  source: result.mode === "legacy" ? "legacy_receipt" : "reaction",
                  legacyReplaceSender: result.mode === "legacy",
                },
                ctx: null,
              });
            }

            const response = {
              success: result.sent,
              sent: result.sent,
              mode: result.mode,
              chatId: chatTarget.chatId,
              messageId: reactedMessageId.toString(),
              emoji,
              action,
              transportMessageId: result.messageId?.toString(),
              reactionRecipients: result.reactionRecipients ?? [],
              legacyRecipients: result.legacyRecipients ?? [],
              omittedRecipients: result.omittedRecipients ?? [],
            };
            return {
              content: [{ type: "text" as const, text: JSON.stringify(response) }],
              details: response,
            };
          } catch (err) {
            return {
              content: [{ type: "text" as const, text: `Error: ${String(err)}` }],
              details: { error: true },
            };
          }
        },
      },
    ];
  },

  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 4000,
    sendText: async ({ to, text, accountId }) => {
      const aid = accountId ?? DEFAULT_ACCOUNT_ID;
      const client = activeClients.get(aid);
      if (!client) {
        throw new Error(`Threema client not running for account ${aid}`);
      }

      // If already leader, pre-wait for CSP handshake to reduce send latency.
      if (client.isLeader() && !client.isCspReady()) {
        try {
          await client.waitForCspReady(30000);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(
            `[threema] CSP not ready after timeout; send will continue and await leader/CSP in mediator client: ${message}`,
          );
        }
      }

      const trimmedTo = String(to ?? "").trim();
      const parsedChatTarget = parseThreemaChatTarget(trimmedTo);
      if (parsedChatTarget?.kind === "group") {
        if (!client.isLeader() || !client.isCspReady()) {
          await client.waitForLeaderAndCsp(60_000);
        }
        const members = resolveGroupRecipients({
          dataDir: client.getDataDir(),
          creatorIdentity: parsedChatTarget.creatorIdentity,
          groupId: parsedChatTarget.groupId,
          selfIdentity: client.getIdentity().trim().toUpperCase(),
        });
        if (members.length === 0) {
          console.warn(
            `[threema] No resolved recipients for ${parsedChatTarget.creatorIdentity}/${parsedChatTarget.groupId.toString()}; sending reflect-only group message`,
          );
        }
        const messageId = await client.sendGroupTextMessage(
          parsedChatTarget.creatorIdentity,
          parsedChatTarget.groupIdBytes,
          members,
          text,
          { requireCsp: true },
        );
        return {
          channel: "threema" as any,
          messageId: messageId.toString(),
        };
      }

      const directRecipient = parsedChatTarget?.kind === "direct"
        ? parsedChatTarget.recipientIdentity
        : tryNormalizeIdentity(trimmedTo);
      if (!directRecipient) {
        throw new Error(
          `Invalid Threema outbound target "${to}" (expected 8-char ID, threema:<ID>, threema:group:<CREATOR>/<GROUP_ID>, group:<CREATOR>/<GROUP_ID>, or threema:g-group-<CREATOR>-<GROUP_ID>)`,
        );
      }

      // 1:1 message
      const messageId = await client.sendTextMessage(directRecipient, text);
      return {
        channel: "threema" as any,
        messageId: messageId.toString(),
      };
    },
    ...mediaOutboundHandlers,
  },

  status: {
    defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
    collectStatusIssues: (accounts) => collectStatusIssuesFromLastError("threema", accounts),
  },

  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      ctx.setStatus({
        accountId: account.accountId,
        name: account.identity?.identity,
      });

      if (!account.configured || !account.identity) {
        throw new Error(
          "Threema identity not configured. Run `npm run link-device` in the threema-integration directory first.",
        );
      }

      const runtime = getThreemaRuntime();
      ctx.log?.info(
        `[${account.accountId}] Starting Threema provider (identity: ${account.identity.identity})`,
      );

      const client = new MediatorClient({
        identity: account.identity,
        dataDir: account.dataDir,
        onEnvelope: async (envelope: any) => {
          try {
            await handleInboundEnvelope({
              envelope,
              account,
              runtime,
              ctx,
            });
          } catch (err) {
            ctx.log?.error(`Threema inbound error: ${String(err)}`);
          }
        },
        onCspMessage: (message: any) => {
          ctx.log?.debug?.(
            `[${account.accountId}] CSP incoming from ${message.senderIdentity}: type=0x${message.containerType.toString(16)}`,
          );
        },
      });

      let stopped = false;
      let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
      let reconnectInFlight = false;

      const scheduleReconnect = (delayMs = 5000): void => {
        if (stopped || reconnectTimer || reconnectInFlight) {
          return;
        }

        reconnectTimer = setTimeout(async () => {
          reconnectTimer = null;
          if (stopped) {
            return;
          }

          reconnectInFlight = true;
          let shouldRetry = false;
          try {
            ctx.log?.info(`[${account.accountId}] Reconnecting...`);
            await client.connect();

            if (stopped) {
              client.disconnect();
              return;
            }

            activeClients.set(account.accountId, client);
            ctx.setStatus({
              ...ctx.getStatus(),
              connected: true,
              running: true,
              lastConnectedAt: Date.now(),
            });
          } catch (err) {
            shouldRetry = !stopped;
            ctx.log?.error(`[${account.accountId}] Reconnect failed: ${String(err)}`);
          } finally {
            reconnectInFlight = false;
            if (shouldRetry) {
              scheduleReconnect();
            }
          }
        }, delayMs);
      };

      try {
        await client.connect();
        activeClients.set(account.accountId, client);
        ctx.setStatus({
          ...ctx.getStatus(),
          connected: true,
          running: true,
          lastConnectedAt: Date.now(),
          lastStartAt: Date.now(),
        });
        ctx.log?.info(
          `[${account.accountId}] Threema connected (identity: ${account.identity.identity})`,
        );
      } catch (err) {
        activeClients.delete(account.accountId);
        throw err;
      }

      // Handle disconnection with reconnect
      client.on("close", (code: number, reason: string) => {
        if (stopped) {
          return;
        }

        clearDirectTypingSessionsForAccount({
          accountId: account.accountId,
          ctx,
          sendStop: false,
        });
        activeClients.delete(account.accountId);
        ctx.log?.warn(
          `[${account.accountId}] Threema disconnected: ${code} ${reason}`,
        );
        ctx.setStatus({
          ...ctx.getStatus(),
          connected: false,
          lastDisconnect: { at: Date.now(), status: code, error: reason },
        });
        scheduleReconnect();
      });

      client.on("cspReady", () => {
        ctx.log?.info(`[${account.accountId}] CSP handshake complete — ready to send/receive`);
      });

      return {
        stop: () => {
          stopped = true;
          if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
          }
          clearDirectTypingSessionsForAccount({
            accountId: account.accountId,
            ctx,
            sendStop: true,
          });
          client.disconnect();
          activeClients.delete(account.accountId);
          ctx.log?.info(`[${account.accountId}] Threema provider stopped`);
        },
      };
    },
  },
};

// ─── Shared message processor ────────────────────────────────────────────────

type ProcessTextMessageParams = {
  text: string;
  chatId: string;
  chatType: "direct" | "group";
  senderIdentity: string;
  conversationLabel: string;
  groupSubject?: string;
  groupCreator?: string;
  groupIdBytes?: Uint8Array;
  messageId: string;
  commandSource?: string;
  contextOverrides?: Record<string, unknown>;
  account: ResolvedThreemaAccount;
  runtime: PluginRuntime;
  ctx: any;
};

async function processTextMessage(params: ProcessTextMessageParams) {
  const {
    text, chatId, chatType, senderIdentity, conversationLabel,
    groupSubject, groupCreator, groupIdBytes, messageId,
    commandSource, contextOverrides,
    account, runtime, ctx,
  } = params;

  if (!text.trim()) return;

  const cfg = runtime.config.loadConfig();
  const groupEvolvingRepliesEnabled = chatType === "group"
    && isGroupEvolvingRepliesEnabled(cfg, account.accountId);
  const groupEvolvingSessionKey = (
    groupEvolvingRepliesEnabled
    && groupCreator
    && groupIdBytes
  )
    ? buildGroupEvolvingReplySessionKey({
        accountId: account.accountId,
        chatId,
        inboundMessageId: messageId,
      })
    : null;
  const forceVoiceReplyFromRequest = shouldForceVoiceReplyFromInboundMessage({ text, contextOverrides });

  ctx.log?.info(
    `[${account.accountId}] 📩 ${chatType} message from ${senderIdentity}: "${text.slice(0, 80)}"`,
  );

  const directTypingRecipient = chatType === "direct"
    ? tryNormalizeIdentity(senderIdentity)
    : null;
  if (directTypingRecipient) {
    beginDirectTyping({
      accountId: account.accountId,
      recipientIdentity: directTypingRecipient,
      ctx,
    });
  }
  let directTypingEndScheduled = false;
  const scheduleDirectTypingEnd = () => {
    if (!directTypingRecipient || directTypingEndScheduled) {
      return;
    }
    directTypingEndScheduled = true;
    endDirectTyping({
      accountId: account.accountId,
      recipientIdentity: directTypingRecipient,
      ctx,
    });
  };
  let groupPartialDispatchChain: Promise<void> = Promise.resolve();

  try {
    const handled = await handleGroupCommand({
      account,
      senderIdentity,
      text,
      ctx,
    });
    if (handled) {
      return;
    }

    const route = runtime.channel.routing.resolveAgentRoute({
      cfg,
      channel: "threema",
      accountId: account.accountId,
      peer: {
        kind: chatType === "direct" ? "direct" : "channel",
        id: chatId,
      },
    });

    const storePath = runtime.channel.session.resolveStorePath(
      (cfg as any).session?.store,
      { agentId: route.agentId },
    );

    const envelopeOptions = runtime.channel.reply.resolveEnvelopeFormatOptions(cfg);
    const previousTimestamp = runtime.channel.session.readSessionUpdatedAt({
      storePath,
      sessionKey: route.sessionKey,
    });

    const body = runtime.channel.reply.formatAgentEnvelope({
      channel: "Threema",
      from: conversationLabel,
      timestamp: Date.now(),
      previousTimestamp,
      envelope: envelopeOptions,
      body: text,
    });

    const ctxPayload = runtime.channel.reply.finalizeInboundContext({
      Body: body,
      BodyForAgent: text,
      RawBody: text,
      CommandBody: text,
      From: chatId,
      To: chatId,
      SessionKey: route.sessionKey,
      AccountId: route.accountId,
      ChatType: chatType,
      ConversationLabel: conversationLabel,
      SenderName: senderIdentity,
      SenderId: senderIdentity,
      GroupSubject: groupSubject,
      VoiceReplyRequestedByUser: forceVoiceReplyFromRequest,
      VoiceReplyHint: forceVoiceReplyFromRequest
        ? "User explicitly requested a voice memo response. Prefer [voice] or <voice>...</voice> for voice memo replies."
        : "Prefix with [voice] or wrap in <voice>...</voice> to send a voice memo reply.",
      Provider: "threema" as any,
      Surface: "threema" as any,
      MessageSid: messageId,
      Timestamp: Date.now(),
      CommandAuthorized: true,
      CommandSource: (commandSource ?? "text") as any,
      OriginatingChannel: "threema" as any,
      OriginatingTo: chatId,
      ...(contextOverrides ?? {}),
    });

    await runtime.channel.session.recordInboundSession({
      storePath,
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      ctx: ctxPayload,
      updateLastRoute: chatType === "direct"
        ? {
            sessionKey: route.mainSessionKey,
            channel: "threema",
            to: chatId,
            accountId: route.accountId,
          }
        : undefined,
      onRecordError: (err: any) => {
        ctx.log?.warn(`Failed updating session meta: ${String(err)}`);
      },
    });

    const tableMode = runtime.channel.text.resolveMarkdownTableMode({
      cfg,
      channel: "threema",
      accountId: route.accountId,
    });

    const groupEvolvingPartialStreaming = groupEvolvingRepliesEnabled
      ? resolveGroupEvolvingPartialStreamingOptions(cfg, account.accountId)
      : null;
    const shouldUseGroupPartialStreaming = Boolean(
      groupEvolvingSessionKey
      && groupEvolvingPartialStreaming?.enabled,
    );

    let cachedGroupReplyRecipients: string[] | null = null;
    const resolveCachedGroupReplyRecipients = (client: MediatorClient): string[] => {
      if (cachedGroupReplyRecipients) {
        return cachedGroupReplyRecipients;
      }
      cachedGroupReplyRecipients = (
        chatType === "group" && groupCreator && groupIdBytes
      )
        ? resolveGroupReplyRecipients({
            client,
            accountId: account.accountId,
            senderIdentity,
            groupCreator,
            groupIdBytes,
            ctx,
          })
        : [];
      return cachedGroupReplyRecipients;
    };

    const sendGroupEvolvingReplyText = async (options: {
      nextText: string;
      deliveryInfo?: { kind?: string };
      source: "deliver" | "partial";
      client?: MediatorClient;
    }): Promise<boolean> => {
      if (!(chatType === "group" && groupCreator && groupIdBytes && groupEvolvingSessionKey)) {
        return false;
      }

      if (!options.nextText || !options.nextText.trim()) {
        return true;
      }

      const client = options.client ?? activeClients.get(account.accountId);
      if (!client) {
        ctx.log?.error("Cannot send reply — Threema client not active");
        return true;
      }

      const groupReplyRecipients = resolveCachedGroupReplyRecipients(client);
      pruneGroupEvolvingReplySessions();

      const existingSession = groupEvolvingReplySessions.get(groupEvolvingSessionKey);
      const nextGroupText = resolveGroupEvolvingReplyText({
        session: existingSession,
        nextText: options.nextText,
        deliveryInfo: options.deliveryInfo,
      });

      if (
        options.source === "partial"
        && existingSession
        && existingSession.lastText.length > nextGroupText.length
        && existingSession.lastText.startsWith(nextGroupText)
      ) {
        existingSession.updatedAt = Date.now();
        return true;
      }

      if (!existingSession) {
        if (!client.isLeader() || !client.isCspReady()) {
          await client.waitForLeaderAndCsp(60_000);
        }
        const anchorMessageId = await client.sendGroupTextMessage(
          groupCreator,
          groupIdBytes,
          groupReplyRecipients,
          nextGroupText,
          { requireCsp: true },
        );
        trackSentMessage(anchorMessageId.toString());
        groupEvolvingReplySessions.set(groupEvolvingSessionKey, {
          anchorMessageId,
          lastText: nextGroupText,
          updatedAt: Date.now(),
        });
        ctx.log?.info?.(
          `[${account.accountId}] Group evolving reply started in ${chatId} anchor=${anchorMessageId.toString()} source=${options.source}`,
        );
        return true;
      }

      if (existingSession.lastText === nextGroupText) {
        existingSession.updatedAt = Date.now();
        return true;
      }

      try {
        if (!client.isLeader() || !client.isCspReady()) {
          await client.waitForLeaderAndCsp(60_000);
        }
        const editMessageId = await client.sendGroupEditMessage(
          groupCreator,
          groupIdBytes,
          groupReplyRecipients,
          existingSession.anchorMessageId,
          nextGroupText,
          { requireCsp: true },
        );
        trackSentMessage(editMessageId.toString());
        existingSession.lastText = nextGroupText;
        existingSession.updatedAt = Date.now();
        ctx.log?.info?.(
          `[${account.accountId}] Group evolving edit in ${chatId} anchor=${existingSession.anchorMessageId.toString()} edit=${editMessageId.toString()} source=${options.source} kind=${options.deliveryInfo?.kind ?? "unknown"} chars=${nextGroupText.length}`,
        );
        return true;
      } catch (err) {
        ctx.log?.warn?.(
          `[${account.accountId}] Group evolving edit failed in ${chatId}; falling back to new group text: ${String(err)}`,
        );
        const fallbackAnchorId = await client.sendGroupTextMessage(
          groupCreator,
          groupIdBytes,
          groupReplyRecipients,
          nextGroupText,
          { requireCsp: true },
        );
        trackSentMessage(fallbackAnchorId.toString());
        existingSession.anchorMessageId = fallbackAnchorId;
        existingSession.lastText = nextGroupText;
        existingSession.updatedAt = Date.now();
        ctx.log?.info?.(
          `[${account.accountId}] Group evolving reply re-anchored in ${chatId} anchor=${fallbackAnchorId.toString()} source=${options.source}`,
        );
        return true;
      }
    };

    let lastGroupPartialAt = 0;
    let lastGroupPartialText = "";
    let groupFinalized = false;
    groupPartialDispatchChain = Promise.resolve();
    const queueGroupPartialUpdate = (rawPartialText: string): void => {
      if (groupFinalized) {
        return;
      }
      if (!groupEvolvingSessionKey || !groupEvolvingPartialStreaming?.enabled) {
        return;
      }
      if (!rawPartialText || !rawPartialText.trim()) {
        return;
      }

      const partialText = runtime.channel.text.convertMarkdownTables(rawPartialText, tableMode);
      if (!partialText || !partialText.trim()) {
        return;
      }
      if (partialText === lastGroupPartialText) {
        return;
      }

      const now = Date.now();
      const deltaChars = partialText.startsWith(lastGroupPartialText)
        ? partialText.length - lastGroupPartialText.length
        : partialText.length;
      if (
        deltaChars < groupEvolvingPartialStreaming.minCharsDelta
        && now - lastGroupPartialAt < groupEvolvingPartialStreaming.minIntervalMs
      ) {
        return;
      }

      lastGroupPartialText = partialText;
      lastGroupPartialAt = now;
      groupPartialDispatchChain = groupPartialDispatchChain
        .then(async () => {
          await sendGroupEvolvingReplyText({
            nextText: partialText,
            deliveryInfo: { kind: "partial" },
            source: "partial",
          });
        })
        .catch((err) => {
          ctx.log?.warn?.(
            `[${account.accountId}] Group evolving partial update failed in ${chatId}: ${String(err)}`,
          );
        });
    };

    const { dispatcher, replyOptions, markDispatchIdle } =
      runtime.channel.reply.createReplyDispatcherWithTyping({
        humanDelay: runtime.channel.reply.resolveHumanDelayConfig(cfg, route.agentId),
        deliver: async (payload: any, deliveryInfo?: { kind?: string }) => {
          if (directTypingRecipient) {
            touchDirectTyping({
              accountId: account.accountId,
              recipientIdentity: directTypingRecipient,
            });
          }

          const rawReplyText = String(payload?.text ?? payload?.body ?? "");
          let textForTextSend = rawReplyText;

          const mediaInstruction = extractMediaReplyInstruction(payload, rawReplyText);
          if (mediaInstruction) {
            try {
              let mediaSentId: bigint;
              if (chatType === "group" && groupCreator && groupIdBytes) {
                const clientForMedia = activeClients.get(account.accountId);
                if (!clientForMedia) {
                  throw new Error("Threema client not active");
                }
                const groupReplyRecipients = resolveCachedGroupReplyRecipients(clientForMedia);
                mediaSentId = await sendGroupMediaForAccount({
                  accountId: account.accountId,
                  input: {
                    groupCreator,
                    groupIdBytes,
                    memberIdentities: groupReplyRecipients,
                    ...mediaInstruction.payload,
                  },
                  requireCsp: true,
                });
              } else {
                mediaSentId = await sendDirectMediaForAccount({
                  accountId: account.accountId,
                  input: {
                    recipientIdentity: senderIdentity,
                    ...mediaInstruction.payload,
                  },
                });
              }
              trackSentMessage(mediaSentId.toString());
              if (!mediaInstruction.sendTextAlso) {
                return;
              }
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              if (shouldSendMediaReplyTextFallbackOnError()) {
                textForTextSend = buildMediaReplyFallbackText(message);
                ctx.log?.warn?.(
                  `[${account.accountId}] Media reply failed; sending text fallback: ${message}`,
                );
              } else {
                ctx.log?.warn?.(
                  `[${account.accountId}] Media reply failed and text fallback is disabled: ${message}`,
                );
                const isDirectiveReply = parseMediaDirectiveArgument(rawReplyText) !== null;
                if (isDirectiveReply || !mediaInstruction.sendTextAlso) {
                  return;
                }
              }
            }
          } else {
            const mediaDirectiveParseError = extractMediaDirectiveParseError(rawReplyText);
            if (mediaDirectiveParseError) {
              if (shouldSendMediaReplyTextFallbackOnError()) {
                textForTextSend = buildMediaReplyFallbackText(mediaDirectiveParseError);
                ctx.log?.warn?.(
                  `[${account.accountId}] MEDIA directive parse failed; sending text fallback: ${mediaDirectiveParseError}`,
                );
              } else {
                ctx.log?.warn?.(
                  `[${account.accountId}] MEDIA directive parse failed and text fallback is disabled: ${mediaDirectiveParseError}`,
                );
                return;
              }
            }
          }

          let voiceInstruction = extractVoiceReplyInstruction(payload, rawReplyText);
          if (
            !voiceInstruction
            && forceVoiceReplyFromRequest
            && shouldEnableVoiceReplies()
          ) {
            const forcedText = rawReplyText.trim();
            if (forcedText.length > 0) {
              voiceInstruction = {
                text: forcedText,
                sendTextAlso: shouldSendVoiceReplyTextAlso(),
              };
              ctx.log?.info?.(
                `[${account.accountId}] Forcing voice memo reply in ${chatType} chat ${chatId} due to explicit request`,
              );
            }
          }
          if (voiceInstruction) {
            textForTextSend = voiceInstruction.text;
            const maxVoiceChars = resolveVoiceReplyMaxTextChars();
            const voiceText = voiceInstruction.text.slice(0, maxVoiceChars).trim();
            if (voiceText.length > 0) {
              try {
                const memo = await synthesizeSpeechToAudioMemo({
                  text: voiceText,
                  requireNativeVoiceMemoFormat: true,
                });
                if (memo) {
                  let mediaSentId: bigint;
                  if (chatType === "group" && groupCreator && groupIdBytes) {
                    const clientForVoice = activeClients.get(account.accountId);
                    if (!clientForVoice) {
                      throw new Error("Threema client not active");
                    }
                    const groupReplyRecipients = resolveCachedGroupReplyRecipients(clientForVoice);
                    mediaSentId = await sendGroupMediaForAccount({
                      accountId: account.accountId,
                      input: {
                        groupCreator,
                        groupIdBytes,
                        memberIdentities: groupReplyRecipients,
                        kind: "audio",
                        bytes: memo.bytes,
                        mediaType: memo.mediaType,
                        fileName: memo.fileName,
                        caption: voiceInstruction.caption,
                        durationSeconds: memo.durationSeconds,
                      },
                      requireCsp: true,
                    });
                  } else {
                    mediaSentId = await sendDirectMediaForAccount({
                      accountId: account.accountId,
                      input: {
                        recipientIdentity: senderIdentity,
                        kind: "audio",
                        bytes: memo.bytes,
                        mediaType: memo.mediaType,
                        fileName: memo.fileName,
                        caption: voiceInstruction.caption,
                        durationSeconds: memo.durationSeconds,
                      },
                    });
                  }
                  trackSentMessage(mediaSentId.toString());
                  if (!voiceInstruction.sendTextAlso) {
                    return;
                  }
                }
              } catch (err) {
                ctx.log?.warn?.(
                  `[${account.accountId}] Voice reply synthesis/send failed; falling back to text: ${String(err)}`,
                );
              }
            }
          }

          const replyText = textForTextSend;
          if (!replyText || !replyText.trim()) return;

          const finalText = runtime.channel.text.convertMarkdownTables(replyText, tableMode);
          const directFinalText = chatType === "direct" ? finalText.trimEnd() : finalText;

          if (shouldUseGroupPartialStreaming && deliveryInfo?.kind === "block") {
            return;
          }
          if (shouldUseGroupPartialStreaming && deliveryInfo?.kind === "final") {
            groupFinalized = true;
            await groupPartialDispatchChain.catch(() => {});
          }

          const client = activeClients.get(account.accountId);
          if (!client) {
            ctx.log?.error("Cannot send reply — Threema client not active");
            return;
          }

          const evolvingHandled = await sendGroupEvolvingReplyText({
            nextText: finalText,
            deliveryInfo,
            source: "deliver",
            client,
          });
          if (evolvingHandled) {
            return;
          }

          const groupReplyRecipients = resolveCachedGroupReplyRecipients(client);

          let sentId: bigint;
          if (chatType === "group" && groupCreator && groupIdBytes) {
            if (!client.isLeader() || !client.isCspReady()) {
              await client.waitForLeaderAndCsp(60_000);
            }
            sentId = await client.sendGroupTextMessage(
              groupCreator,
              groupIdBytes,
              groupReplyRecipients,
              finalText,
              { requireCsp: true },
            );
          } else {
            if (!directFinalText.trim()) {
              return;
            }
            sentId = await client.sendTextMessage(senderIdentity, directFinalText);
          }
          trackSentMessage(sentId.toString());
        },
        onError: (err: any, info: any) => {
          ctx.log?.error(`Threema ${info.kind} reply failed: ${String(err)}`);
        },
      });

    const baseOnPartialReply = (replyOptions as any).onPartialReply as
      | ((payload: any) => Promise<void> | void)
      | undefined;
    const effectiveOnPartialReply = shouldUseGroupPartialStreaming
      ? async (payload: any) => {
          if (baseOnPartialReply) {
            await baseOnPartialReply(payload);
          }
          queueGroupPartialUpdate(String(payload?.text ?? ""));
        }
      : baseOnPartialReply;

    let queuedFinal = false;
    try {
      const dispatchResult = await runtime.channel.reply.dispatchReplyFromConfig({
        ctx: ctxPayload,
        cfg,
        dispatcher,
        replyOptions: {
          ...replyOptions,
          // For group evolving:
          // - partial mode: disable block streaming to avoid block/partial interleaving.
          // - block mode: enable block streaming.
          // For direct chats: keep block streaming disabled.
          disableBlockStreaming: shouldUseGroupPartialStreaming
            ? true
            : (groupEvolvingRepliesEnabled ? false : true),
          onPartialReply: effectiveOnPartialReply,
        },
      });
      queuedFinal = dispatchResult.queuedFinal;
    } finally {
      markDispatchIdle();
    }

    if (queuedFinal) {
      ctx.log?.info(`[${account.accountId}] Reply dispatched to ${chatId}`);
    }
  } finally {
    await groupPartialDispatchChain.catch(() => {});
    if (groupEvolvingSessionKey) {
      groupEvolvingReplySessions.delete(groupEvolvingSessionKey);
    }
    scheduleDirectTypingEnd();
  }
}

async function handleIncomingDirectFileMessage(params: {
  msg: any;
  senderIdentity: string;
  account: ResolvedThreemaAccount;
  runtime: PluginRuntime;
  ctx: any;
}): Promise<void> {
  const { msg, senderIdentity, account, runtime, ctx } = params;
  const client = activeClients.get(account.accountId);
  if (!client) {
    ctx.log?.warn?.(
      `[${account.accountId}] Cannot process inbound file message from ${senderIdentity}: client not active`,
    );
    return;
  }

  const rawBody = toUint8Array(msg.body);
  if (!rawBody || rawBody.length === 0) {
    ctx.log?.warn?.(
      `[${account.accountId}] Ignoring inbound file message from ${senderIdentity}: empty body`,
    );
    return;
  }

  const descriptor = client.parseDirectFileMessageBody(rawBody);
  const messageId = msg.messageId?.toString?.() ?? `threema-${Date.now()}`;
  if (!descriptor) {
    ctx.log?.warn?.(
      `[${account.accountId}] Ignoring inbound file message from ${senderIdentity}: unparseable payload`,
    );
    return;
  }

  if (!shouldAutoDownloadMedia()) {
    const text = [
      `[Media message from ${senderIdentity}]`,
      `Type: ${descriptor.mediaType}`,
      `File: ${descriptor.fileName ?? descriptor.blobId}`,
      "Auto-download disabled via THREEMA_MEDIA_AUTO_DOWNLOAD=0",
    ].join("\n");
    await processTextMessage({
      text,
      chatId: `threema:${senderIdentity}`,
      chatType: "direct",
      senderIdentity,
      conversationLabel: senderIdentity,
      messageId,
      commandSource: "media",
      contextOverrides: {
        MediaMessage: true,
        MediaType: descriptor.mediaType,
        MediaBlobId: descriptor.blobId,
      },
      account,
      runtime,
      ctx,
    });
    return;
  }

  const maxBytes = resolveMediaDownloadMaxBytes();
  if (descriptor.fileSize !== undefined && descriptor.fileSize > maxBytes) {
    const text = [
      `[Media message from ${senderIdentity}]`,
      `Type: ${descriptor.mediaType}`,
      `File: ${descriptor.fileName ?? descriptor.blobId}`,
      `Download skipped: declared size ${formatByteSize(descriptor.fileSize)} exceeds configured limit ${formatByteSize(maxBytes)}`,
    ].join("\n");
    await processTextMessage({
      text,
      chatId: `threema:${senderIdentity}`,
      chatType: "direct",
      senderIdentity,
      conversationLabel: senderIdentity,
      messageId,
      commandSource: "media",
      contextOverrides: {
        MediaMessage: true,
        MediaType: descriptor.mediaType,
        MediaBlobId: descriptor.blobId,
        MediaDownloadSkipped: true,
      },
      account,
      runtime,
      ctx,
    });
    return;
  }

  let resolved: ResolvedDirectFileMessage | null = null;
  try {
    resolved = await client.resolveDirectFileMessageBody(rawBody);
    if (!resolved) {
      throw new Error("file message payload could not be resolved");
    }
  } catch (err) {
    const text = [
      `[Media message from ${senderIdentity}]`,
      `Type: ${descriptor.mediaType}`,
      `File: ${descriptor.fileName ?? descriptor.blobId}`,
      `Download/decrypt failed: ${String(err)}`,
    ].join("\n");
    await processTextMessage({
      text,
      chatId: `threema:${senderIdentity}`,
      chatType: "direct",
      senderIdentity,
      conversationLabel: senderIdentity,
      messageId,
      commandSource: "media",
      contextOverrides: {
        MediaMessage: true,
        MediaType: descriptor.mediaType,
        MediaBlobId: descriptor.blobId,
        MediaDownloadFailed: true,
      },
      account,
      runtime,
      ctx,
    });
    return;
  }

  if (!resolved) {
    return;
  }

  if (resolved.file.bytes.length > maxBytes) {
    const text = [
      `[Media message from ${senderIdentity}]`,
      `Type: ${resolved.descriptor.mediaType}`,
      `File: ${resolved.descriptor.fileName ?? resolved.descriptor.blobId}`,
      `Download skipped after fetch: ${formatByteSize(resolved.file.bytes.length)} exceeds configured limit ${formatByteSize(maxBytes)}`,
    ].join("\n");
    await processTextMessage({
      text,
      chatId: `threema:${senderIdentity}`,
      chatType: "direct",
      senderIdentity,
      conversationLabel: senderIdentity,
      messageId,
      commandSource: "media",
      contextOverrides: {
        MediaMessage: true,
        MediaType: resolved.descriptor.mediaType,
        MediaBlobId: resolved.descriptor.blobId,
        MediaDownloadSkipped: true,
      },
      account,
      runtime,
      ctx,
    });
    return;
  }

  const stored = storeInboundResolvedMedia({
    account,
    senderIdentity,
    messageId,
    resolved,
  });
  let transcriptionText: string | undefined;
  if (
    isAudioMediaType(resolved.descriptor.mediaType)
    && shouldAutoTranscribeAudio()
    && resolved.file.bytes.length <= resolveTranscribeMaxBytes()
  ) {
    try {
      const transcription = await transcribeAudioBytes({
        bytes: resolved.file.bytes,
        mediaType: resolved.descriptor.mediaType,
        fileName: resolved.descriptor.fileName ?? path.basename(stored.filePath),
      });
      if (transcription && transcription.text.trim().length > 0) {
        transcriptionText = transcription.text.trim();
      }
    } catch (err) {
      ctx.log?.warn?.(
        `[${account.accountId}] Audio transcription failed for ${senderIdentity}#${messageId}: ${String(err)}`,
      );
    }
  }

  const text = buildInboundMediaText({
    senderIdentity,
    mediaType: resolved.descriptor.mediaType,
    stored,
    fileName: resolved.descriptor.fileName,
    caption: resolved.descriptor.caption,
    transcription: transcriptionText,
  });
  await processTextMessage({
    text,
    chatId: `threema:${senderIdentity}`,
    chatType: "direct",
    senderIdentity,
    conversationLabel: senderIdentity,
    messageId,
    commandSource: "media",
    contextOverrides: {
      MediaMessage: true,
      MediaType: resolved.descriptor.mediaType,
      MediaBlobId: resolved.descriptor.blobId,
      MediaFilePath: stored.filePath,
      MediaRelativeFilePath: stored.relativeFilePath,
      MediaFileName: resolved.descriptor.fileName,
      MediaCaption: resolved.descriptor.caption,
      MediaTranscript: transcriptionText,
      MediaThumbnailPath: stored.thumbnailPath,
      MediaRelativeThumbnailPath: stored.relativeThumbnailPath,
      MediaDownloadSourceUrl: resolved.file.blob.sourceUrl,
      MediaFileSize: resolved.file.bytes.length,
    },
    account,
    runtime,
    ctx,
  });
}

async function handleIncomingGroupFileMessage(params: {
  msg: any;
  senderIdentity: string;
  account: ResolvedThreemaAccount;
  runtime: PluginRuntime;
  ctx: any;
}): Promise<void> {
  const { msg, senderIdentity, account, runtime, ctx } = params;
  const client = activeClients.get(account.accountId);
  if (!client) {
    ctx.log?.warn?.(
      `[${account.accountId}] Cannot process inbound group file message from ${senderIdentity}: client not active`,
    );
    return;
  }

  const rawBody = toUint8Array(msg.body);
  if (!rawBody || rawBody.length === 0) {
    ctx.log?.warn?.(
      `[${account.accountId}] Ignoring inbound group file message from ${senderIdentity}: empty body`,
    );
    return;
  }

  const parsed = client.parseGroupFileMessageBody(rawBody);
  const messageId = msg.messageId?.toString?.() ?? `threema-${Date.now()}`;
  if (!parsed) {
    ctx.log?.warn?.(
      `[${account.accountId}] Ignoring inbound group file message from ${senderIdentity}: unparseable payload`,
    );
    return;
  }

  const chatId = `threema:group:${parsed.creatorIdentity}/${parsed.groupId.toString()}`;
  const conversationLabel = resolveGroupConversationLabel({
    dataDir: account.dataDir,
    creatorIdentity: parsed.creatorIdentity,
    groupId: parsed.groupId,
    accountId: account.accountId,
    ctx,
  });
  rememberObservedGroupMember({
    creatorIdentity: parsed.creatorIdentity,
    groupId: parsed.groupId,
    memberIdentity: senderIdentity,
    dataDir: account.dataDir,
  });

  if (!shouldAutoDownloadMedia()) {
    const text = [
      `[Media message from ${senderIdentity}]`,
      `Type: ${parsed.descriptor.mediaType}`,
      `File: ${parsed.descriptor.fileName ?? parsed.descriptor.blobId}`,
      "Auto-download disabled via THREEMA_MEDIA_AUTO_DOWNLOAD=0",
    ].join("\n");
    await processTextMessage({
      text,
      chatId,
      chatType: "group",
      senderIdentity,
      conversationLabel,
      groupSubject: conversationLabel,
      groupCreator: parsed.creatorIdentity,
      groupIdBytes: new Uint8Array(parsed.groupIdBytes),
      messageId,
      commandSource: "media",
      contextOverrides: {
        MediaMessage: true,
        MediaType: parsed.descriptor.mediaType,
        MediaBlobId: parsed.descriptor.blobId,
      },
      account,
      runtime,
      ctx,
    });
    return;
  }

  const maxBytes = resolveMediaDownloadMaxBytes();
  if (parsed.descriptor.fileSize !== undefined && parsed.descriptor.fileSize > maxBytes) {
    const text = [
      `[Media message from ${senderIdentity}]`,
      `Type: ${parsed.descriptor.mediaType}`,
      `File: ${parsed.descriptor.fileName ?? parsed.descriptor.blobId}`,
      `Download skipped: declared size ${formatByteSize(parsed.descriptor.fileSize)} exceeds configured limit ${formatByteSize(maxBytes)}`,
    ].join("\n");
    await processTextMessage({
      text,
      chatId,
      chatType: "group",
      senderIdentity,
      conversationLabel,
      groupSubject: conversationLabel,
      groupCreator: parsed.creatorIdentity,
      groupIdBytes: new Uint8Array(parsed.groupIdBytes),
      messageId,
      commandSource: "media",
      contextOverrides: {
        MediaMessage: true,
        MediaType: parsed.descriptor.mediaType,
        MediaBlobId: parsed.descriptor.blobId,
        MediaDownloadSkipped: true,
      },
      account,
      runtime,
      ctx,
    });
    return;
  }

  let resolved: ResolvedGroupFileMessage | null = null;
  try {
    resolved = await client.resolveGroupFileMessageBody(rawBody);
    if (!resolved) {
      throw new Error("group file message payload could not be resolved");
    }
  } catch (err) {
    const text = [
      `[Media message from ${senderIdentity}]`,
      `Type: ${parsed.descriptor.mediaType}`,
      `File: ${parsed.descriptor.fileName ?? parsed.descriptor.blobId}`,
      `Download/decrypt failed: ${String(err)}`,
    ].join("\n");
    await processTextMessage({
      text,
      chatId,
      chatType: "group",
      senderIdentity,
      conversationLabel,
      groupSubject: conversationLabel,
      groupCreator: parsed.creatorIdentity,
      groupIdBytes: new Uint8Array(parsed.groupIdBytes),
      messageId,
      commandSource: "media",
      contextOverrides: {
        MediaMessage: true,
        MediaType: parsed.descriptor.mediaType,
        MediaBlobId: parsed.descriptor.blobId,
        MediaDownloadFailed: true,
      },
      account,
      runtime,
      ctx,
    });
    return;
  }

  if (!resolved) {
    return;
  }

  if (resolved.file.bytes.length > maxBytes) {
    const text = [
      `[Media message from ${senderIdentity}]`,
      `Type: ${resolved.descriptor.mediaType}`,
      `File: ${resolved.descriptor.fileName ?? resolved.descriptor.blobId}`,
      `Download skipped after fetch: ${formatByteSize(resolved.file.bytes.length)} exceeds configured limit ${formatByteSize(maxBytes)}`,
    ].join("\n");
    await processTextMessage({
      text,
      chatId,
      chatType: "group",
      senderIdentity,
      conversationLabel,
      groupSubject: conversationLabel,
      groupCreator: resolved.creatorIdentity,
      groupIdBytes: new Uint8Array(resolved.groupIdBytes),
      messageId,
      commandSource: "media",
      contextOverrides: {
        MediaMessage: true,
        MediaType: resolved.descriptor.mediaType,
        MediaBlobId: resolved.descriptor.blobId,
        MediaDownloadSkipped: true,
      },
      account,
      runtime,
      ctx,
    });
    return;
  }

  const stored = storeInboundResolvedMedia({
    account,
    senderIdentity,
    messageId,
    resolved,
  });
  let transcriptionText: string | undefined;
  if (
    isAudioMediaType(resolved.descriptor.mediaType)
    && shouldAutoTranscribeAudio()
    && resolved.file.bytes.length <= resolveTranscribeMaxBytes()
  ) {
    try {
      const transcription = await transcribeAudioBytes({
        bytes: resolved.file.bytes,
        mediaType: resolved.descriptor.mediaType,
        fileName: resolved.descriptor.fileName ?? path.basename(stored.filePath),
      });
      if (transcription && transcription.text.trim().length > 0) {
        transcriptionText = transcription.text.trim();
      }
    } catch (err) {
      ctx.log?.warn?.(
        `[${account.accountId}] Audio transcription failed for ${senderIdentity}#${messageId}: ${String(err)}`,
      );
    }
  }

  const text = buildInboundMediaText({
    senderIdentity,
    mediaType: resolved.descriptor.mediaType,
    stored,
    fileName: resolved.descriptor.fileName,
    caption: resolved.descriptor.caption,
    transcription: transcriptionText,
  });
  await processTextMessage({
    text,
    chatId,
    chatType: "group",
    senderIdentity,
    conversationLabel,
    groupSubject: conversationLabel,
    groupCreator: resolved.creatorIdentity,
    groupIdBytes: new Uint8Array(resolved.groupIdBytes),
    messageId,
    commandSource: "media",
    contextOverrides: {
      MediaMessage: true,
      MediaType: resolved.descriptor.mediaType,
      MediaBlobId: resolved.descriptor.blobId,
      MediaFilePath: stored.filePath,
      MediaRelativeFilePath: stored.relativeFilePath,
      MediaFileName: resolved.descriptor.fileName,
      MediaCaption: resolved.descriptor.caption,
      MediaTranscript: transcriptionText,
      MediaThumbnailPath: stored.thumbnailPath,
      MediaRelativeThumbnailPath: stored.relativeThumbnailPath,
      MediaDownloadSourceUrl: resolved.file.blob.sourceUrl,
      MediaFileSize: resolved.file.bytes.length,
    },
    account,
    runtime,
    ctx,
  });
}

function collectIncomingReactionEvents(params: {
  msg: any;
  senderIdentity: string;
}): ReactionPersistenceEvent[] {
  const { msg } = params;
  const senderIdentity = tryNormalizeIdentity(params.senderIdentity);
  if (!senderIdentity) {
    return [];
  }

  const messageType = Number(msg?.type ?? 0);
  const body = toUint8Array(msg?.body);
  if (!body) {
    return [];
  }

  const reactedAt = normalizeTimestampMillis(msg?.createdAt);
  const events: ReactionPersistenceEvent[] = [];

  if (messageType === THREEMA_DIRECT_REACTION_MESSAGE_TYPE) {
    const parsed = decodeReactionMessageBody(body);
    if (!parsed) {
      return [];
    }
    events.push({
      chatId: `threema:${senderIdentity}`,
      messageId: parsed.messageId.toString(),
      senderIdentity,
      emoji: parsed.emoji,
      action: parsed.action,
      reactedAt,
      source: "reaction",
      legacyReplaceSender: false,
    });
    return events;
  }

  if (messageType === THREEMA_GROUP_REACTION_MESSAGE_TYPE_INTERNAL) {
    const container = parseGroupMemberContainer(body);
    const creatorIdentity = container
      ? tryNormalizeIdentity(container.creatorIdentityRaw)
      : null;
    if (!container || !creatorIdentity) {
      return [];
    }
    const parsed = decodeReactionMessageBody(container.innerData);
    if (!parsed) {
      return [];
    }
    events.push({
      chatId: `threema:group:${creatorIdentity}/${container.groupId.toString()}`,
      messageId: parsed.messageId.toString(),
      senderIdentity,
      emoji: parsed.emoji,
      action: parsed.action,
      reactedAt,
      source: "reaction",
      legacyReplaceSender: false,
    });
    return events;
  }

  if (messageType === THREEMA_LEGACY_DELIVERY_RECEIPT_MESSAGE_TYPE) {
    const parsed = decodeDeliveryReceiptBody(body);
    const emoji = parsed ? legacyDeliveryStatusToEmoji(parsed.status) : null;
    if (!parsed || !emoji) {
      return [];
    }
    for (const reactedMessageId of parsed.messageIds) {
      events.push({
        chatId: `threema:${senderIdentity}`,
        messageId: reactedMessageId.toString(),
        senderIdentity,
        emoji,
        action: "apply",
        reactedAt,
        source: "legacy_receipt",
        legacyReplaceSender: true,
      });
    }
    return events;
  }

  if (messageType === THREEMA_LEGACY_GROUP_DELIVERY_RECEIPT_MESSAGE_TYPE) {
    const container = parseGroupMemberContainer(body);
    const creatorIdentity = container
      ? tryNormalizeIdentity(container.creatorIdentityRaw)
      : null;
    if (!container || !creatorIdentity) {
      return [];
    }
    const parsed = decodeDeliveryReceiptBody(container.innerData);
    const emoji = parsed ? legacyDeliveryStatusToEmoji(parsed.status) : null;
    if (!parsed || !emoji) {
      return [];
    }
    for (const reactedMessageId of parsed.messageIds) {
      events.push({
        chatId: `threema:group:${creatorIdentity}/${container.groupId.toString()}`,
        messageId: reactedMessageId.toString(),
        senderIdentity,
        emoji,
        action: "apply",
        reactedAt,
        source: "legacy_receipt",
        legacyReplaceSender: true,
      });
    }
    return events;
  }

  return events;
}

function collectOutgoingReactionEvents(params: {
  msg: any;
  account: ResolvedThreemaAccount;
}): ReactionPersistenceEvent[] {
  const { msg, account } = params;
  const senderIdentity = tryNormalizeIdentity(account.identity?.identity ?? "");
  if (!senderIdentity) {
    return [];
  }

  const messageType = Number(msg?.type ?? 0);
  const body = toUint8Array(msg?.body);
  if (!body) {
    return [];
  }

  const reactedAt = normalizeTimestampMillis(msg?.createdAt);
  const events: ReactionPersistenceEvent[] = [];

  const directConversationIdentity = tryNormalizeIdentity(msg?.conversation?.contact ?? "");

  if (messageType === THREEMA_DIRECT_REACTION_MESSAGE_TYPE) {
    if (!directConversationIdentity) {
      return [];
    }
    const parsed = decodeReactionMessageBody(body);
    if (!parsed) {
      return [];
    }
    events.push({
      chatId: `threema:${directConversationIdentity}`,
      messageId: parsed.messageId.toString(),
      senderIdentity,
      emoji: parsed.emoji,
      action: parsed.action,
      reactedAt,
      source: "reaction",
      legacyReplaceSender: false,
    });
    return events;
  }

  if (messageType === THREEMA_GROUP_REACTION_MESSAGE_TYPE_INTERNAL) {
    const container = parseGroupMemberContainer(body);
    const creatorIdentity = container
      ? tryNormalizeIdentity(container.creatorIdentityRaw)
      : null;
    if (!container || !creatorIdentity) {
      return [];
    }
    const parsed = decodeReactionMessageBody(container.innerData);
    if (!parsed) {
      return [];
    }
    events.push({
      chatId: `threema:group:${creatorIdentity}/${container.groupId.toString()}`,
      messageId: parsed.messageId.toString(),
      senderIdentity,
      emoji: parsed.emoji,
      action: parsed.action,
      reactedAt,
      source: "reaction",
      legacyReplaceSender: false,
    });
    return events;
  }

  if (messageType === THREEMA_LEGACY_DELIVERY_RECEIPT_MESSAGE_TYPE) {
    if (!directConversationIdentity) {
      return [];
    }
    const parsed = decodeDeliveryReceiptBody(body);
    const emoji = parsed ? legacyDeliveryStatusToEmoji(parsed.status) : null;
    if (!parsed || !emoji) {
      return [];
    }
    for (const reactedMessageId of parsed.messageIds) {
      events.push({
        chatId: `threema:${directConversationIdentity}`,
        messageId: reactedMessageId.toString(),
        senderIdentity,
        emoji,
        action: "apply",
        reactedAt,
        source: "legacy_receipt",
        legacyReplaceSender: true,
      });
    }
    return events;
  }

  if (messageType === THREEMA_LEGACY_GROUP_DELIVERY_RECEIPT_MESSAGE_TYPE) {
    const container = parseGroupMemberContainer(body);
    const creatorIdentity = container
      ? tryNormalizeIdentity(container.creatorIdentityRaw)
      : null;
    if (!container || !creatorIdentity) {
      return [];
    }
    const parsed = decodeDeliveryReceiptBody(container.innerData);
    const emoji = parsed ? legacyDeliveryStatusToEmoji(parsed.status) : null;
    if (!parsed || !emoji) {
      return [];
    }
    for (const reactedMessageId of parsed.messageIds) {
      events.push({
        chatId: `threema:group:${creatorIdentity}/${container.groupId.toString()}`,
        messageId: reactedMessageId.toString(),
        senderIdentity,
        emoji,
        action: "apply",
        reactedAt,
        source: "legacy_receipt",
        legacyReplaceSender: true,
      });
    }
    return events;
  }

  return events;
}

function persistReactionEvents(params: {
  account: ResolvedThreemaAccount;
  events: ReactionPersistenceEvent[];
  ctx: any;
  logPrefix: string;
}): void {
  const { account, events, ctx, logPrefix } = params;
  for (const event of events) {
    persistReactionEvent({
      account,
      event,
      ctx,
    });
    ctx.log?.debug?.(
      `[${account.accountId}] ${logPrefix} reaction ${event.action} ${event.emoji} for ${event.chatId}#${event.messageId} (${event.source})`,
    );
  }
}

function buildReactionEventLine(event: ReactionPersistenceEvent): string {
  if (event.action === "apply") {
    const legacySuffix = event.source === "legacy_receipt" ? " (legacy)" : "";
    return `${event.senderIdentity} reacted with ${event.emoji} to message ${event.messageId}${legacySuffix}`;
  }
  return `${event.senderIdentity} removed reaction ${event.emoji} from message ${event.messageId}`;
}

async function forwardReactionEventsToAgent(params: {
  account: ResolvedThreemaAccount;
  runtime: PluginRuntime;
  ctx: any;
  events: ReactionPersistenceEvent[];
}): Promise<void> {
  const { account, runtime, ctx, events } = params;
  if (events.length === 0) {
    return;
  }

  const grouped = new Map<string, ReactionPersistenceEvent[]>();
  for (const event of events) {
    const bucket = grouped.get(event.chatId);
    if (bucket) {
      bucket.push(event);
    } else {
      grouped.set(event.chatId, [event]);
    }
  }

  for (const [chatId, chatEvents] of grouped.entries()) {
    const target = parseThreemaChatTarget(chatId);
    if (!target) {
      ctx.log?.warn?.(
        `[${account.accountId}] Cannot forward reaction events for unknown chat id ${chatId}`,
      );
      continue;
    }

    const senderIdentity = chatEvents[0]?.senderIdentity ?? "";
    const reactionText = [
      "[Reaction update]",
      ...chatEvents.map(buildReactionEventLine),
    ].join("\n");

    const syntheticMessageId = `threema-reaction-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    if (target.kind === "group") {
      const conversationLabel = resolveGroupConversationLabel({
        dataDir: account.dataDir,
        creatorIdentity: target.creatorIdentity,
        groupId: target.groupId,
        accountId: account.accountId,
        ctx,
      });
      await processTextMessage({
        text: reactionText,
        chatId: target.chatId,
        chatType: "group",
        senderIdentity,
        conversationLabel,
        groupSubject: conversationLabel,
        groupCreator: target.creatorIdentity,
        groupIdBytes: target.groupIdBytes,
        messageId: syntheticMessageId,
        commandSource: "reaction",
        contextOverrides: {
          ReactionEvent: true,
          ReactionEvents: chatEvents.map((event) => ({
            chatId: event.chatId,
            messageId: event.messageId,
            senderIdentity: event.senderIdentity,
            emoji: event.emoji,
            action: event.action,
            reactedAt: event.reactedAt,
            source: event.source,
            legacyReplaceSender: event.legacyReplaceSender,
          })),
          ReactionChatId: target.chatId,
          ReactionSenderIdentity: senderIdentity,
          ReactionCount: chatEvents.length,
        },
        account,
        runtime,
        ctx,
      });
    } else {
      await processTextMessage({
        text: reactionText,
        chatId: target.chatId,
        chatType: "direct",
        senderIdentity,
        conversationLabel: senderIdentity,
        messageId: syntheticMessageId,
        commandSource: "reaction",
        contextOverrides: {
          ReactionEvent: true,
          ReactionEvents: chatEvents.map((event) => ({
            chatId: event.chatId,
            messageId: event.messageId,
            senderIdentity: event.senderIdentity,
            emoji: event.emoji,
            action: event.action,
            reactedAt: event.reactedAt,
            source: event.source,
            legacyReplaceSender: event.legacyReplaceSender,
          })),
          ReactionChatId: target.chatId,
          ReactionSenderIdentity: senderIdentity,
          ReactionCount: chatEvents.length,
        },
        account,
        runtime,
        ctx,
      });
    }
  }
}

function persistGroupNameFromControlMessage(params: {
  body: unknown;
  creatorIdentity: string;
  account: ResolvedThreemaAccount;
  ctx: any;
  source: "incoming" | "outgoing";
}): void {
  const parsed = parseGroupNameControlMessageBody(params.body);
  const creatorIdentity = tryNormalizeIdentity(params.creatorIdentity);
  if (!parsed || !creatorIdentity) {
    params.ctx.log?.debug?.(
      `[${params.account.accountId}] Ignoring ${params.source} GROUP_NAME control message: invalid payload`,
    );
    return;
  }

  if (!params.account.dataDir || params.account.dataDir.trim().length === 0) {
    params.ctx.log?.debug?.(
      `[${params.account.accountId}] Ignoring ${params.source} GROUP_NAME control message: account dataDir not configured`,
    );
    return;
  }

  try {
    upsertGroupNameInGroupsFile({
      dataDir: params.account.dataDir,
      creatorIdentity,
      groupId: parsed.groupId,
      name: parsed.name,
    });
    params.ctx.log?.info?.(
      `[${params.account.accountId}] Learned group name "${parsed.name}" for ${creatorIdentity}/${parsed.groupId.toString()} from ${params.source} GROUP_NAME control`,
    );
  } catch (err) {
    params.ctx.log?.warn?.(
      `[${params.account.accountId}] Failed persisting group name from ${params.source} GROUP_NAME control: ${String(err)}`,
    );
  }
}

// ─── Inbound message handler ─────────────────────────────────────────────────

async function handleInboundEnvelope(params: {
  envelope: any;
  account: ResolvedThreemaAccount;
  runtime: PluginRuntime;
  ctx: any;
}) {
  const { envelope, account, runtime, ctx } = params;

  // Handle incoming messages (from other people to us)
  if (envelope.incomingMessage) {
    const msg = envelope.incomingMessage;
    const senderIdentity = msg.senderIdentity;

    if (msg.type === THREEMA_TYPING_INDICATOR_MESSAGE_TYPE) {
      const isTyping = parseTypingIndicatorBody(msg.body);
      if (isTyping === null) {
        ctx.log?.debug?.(
          `[${account.accountId}] Ignoring invalid typing indicator body from ${senderIdentity}`,
        );
      } else {
        ctx.log?.debug?.(
          `[${account.accountId}] ${senderIdentity} ${isTyping ? "is typing" : "stopped typing"}`,
        );
      }
      return;
    }

    if (
      msg.type === THREEMA_DIRECT_REACTION_MESSAGE_TYPE
      || msg.type === THREEMA_GROUP_REACTION_MESSAGE_TYPE_INTERNAL
      || msg.type === THREEMA_LEGACY_DELIVERY_RECEIPT_MESSAGE_TYPE
      || msg.type === THREEMA_LEGACY_GROUP_DELIVERY_RECEIPT_MESSAGE_TYPE
    ) {
      const events = collectIncomingReactionEvents({
        msg,
        senderIdentity,
      });
      if (events.length === 0) {
        ctx.log?.debug?.(
          `[${account.accountId}] Ignoring unparseable incoming reaction payload from ${senderIdentity} (type=0x${Number(msg.type).toString(16)})`,
        );
        return;
      }
      for (const event of events) {
        rememberObservedGroupMemberForChat({
          chatId: event.chatId,
          memberIdentity: event.senderIdentity,
          dataDir: account.dataDir,
        });
      }
      persistReactionEvents({
        account,
        events,
        ctx,
        logPrefix: "Stored incoming",
      });
      await forwardReactionEventsToAgent({
        account,
        runtime,
        ctx,
        events,
      });
      return;
    }

    if (msg.type === THREEMA_GROUP_NAME_MESSAGE_TYPE) {
      const conversationCreator = tryNormalizeIdentity(String(msg?.conversation?.group?.creatorIdentity ?? ""));
      persistGroupNameFromControlMessage({
        body: msg.body,
        creatorIdentity: conversationCreator ?? senderIdentity,
        account,
        ctx,
        source: "incoming",
      });
      return;
    }

    if (
      msg.type !== THREEMA_TEXT_MESSAGE_TYPE
      && msg.type !== THREEMA_GROUP_TEXT_MESSAGE_TYPE
      && msg.type !== THREEMA_FILE_MESSAGE_TYPE
      && msg.type !== THREEMA_GROUP_FILE_MESSAGE_TYPE
    ) {
      return;
    }

    if (msg.type === THREEMA_FILE_MESSAGE_TYPE) {
      await handleIncomingDirectFileMessage({
        msg,
        senderIdentity,
        account,
        runtime,
        ctx,
      });
      return;
    }

    if (msg.type === THREEMA_GROUP_FILE_MESSAGE_TYPE) {
      await handleIncomingGroupFileMessage({
        msg,
        senderIdentity,
        account,
        runtime,
        ctx,
      });
      return;
    }

    if (msg.type === THREEMA_GROUP_TEXT_MESSAGE_TYPE) {
      const body = msg.body as Uint8Array;
      if (!body || body.length < 17) return;
      const creatorIdentity = new TextDecoder().decode(body.slice(0, 8));
      const groupIdBytes = body.slice(8, 16);
      const gid = new DataView(groupIdBytes.buffer, groupIdBytes.byteOffset).getBigUint64(0, true);
      rememberObservedGroupMember({
        creatorIdentity,
        groupId: gid,
        memberIdentity: senderIdentity,
        dataDir: account.dataDir,
      });
      const text = new TextDecoder().decode(body.slice(16));
      const conversationLabel = resolveGroupConversationLabel({
        dataDir: account.dataDir,
        creatorIdentity,
        groupId: gid,
        accountId: account.accountId,
        ctx,
      });
      await processTextMessage({
        text,
        chatId: `threema:group:${creatorIdentity}/${gid}`,
        chatType: "group",
        senderIdentity,
        conversationLabel,
        groupSubject: conversationLabel,
        groupCreator: creatorIdentity,
        groupIdBytes: new Uint8Array(groupIdBytes),
        messageId: msg.messageId?.toString?.() ?? `threema-${Date.now()}`,
        account,
        runtime,
        ctx,
      });
    } else {
      const text = msg.body ? new TextDecoder().decode(msg.body) : "";
      await processTextMessage({
        text,
        chatId: `threema:${senderIdentity}`,
        chatType: "direct",
        senderIdentity,
        conversationLabel: senderIdentity,
        messageId: msg.messageId?.toString?.() ?? `threema-${Date.now()}`,
        account,
        runtime,
        ctx,
      });
    }
  }

  // Outgoing messages (reflected from our other devices)
  // Treat these as inbound for "notes" groups (self-only groups used as bot channels)
  if (envelope.outgoingMessage) {
    const msg = envelope.outgoingMessage;
    const msgIdStr = msg.messageId?.toString?.() ?? "";

    // Skip messages we sent ourselves (echo prevention)
    if (msgIdStr && sentMessageIds.has(msgIdStr)) {
      ctx.log?.debug?.(`[${account.accountId}] Skipping echo for message ${msgIdStr}`);
      return;
    }

    if (
      msg.type === THREEMA_DIRECT_REACTION_MESSAGE_TYPE
      || msg.type === THREEMA_GROUP_REACTION_MESSAGE_TYPE_INTERNAL
      || msg.type === THREEMA_LEGACY_DELIVERY_RECEIPT_MESSAGE_TYPE
      || msg.type === THREEMA_LEGACY_GROUP_DELIVERY_RECEIPT_MESSAGE_TYPE
    ) {
      const events = collectOutgoingReactionEvents({
        msg,
        account,
      });
      if (events.length === 0) {
        ctx.log?.debug?.(
          `[${account.accountId}] Ignoring unparseable reflected outgoing reaction payload (type=0x${Number(msg.type).toString(16)})`,
        );
        return;
      }
      for (const event of events) {
        rememberObservedGroupMemberForChat({
          chatId: event.chatId,
          memberIdentity: event.senderIdentity,
          dataDir: account.dataDir,
        });
      }
      persistReactionEvents({
        account,
        events,
        ctx,
        logPrefix: "Stored outgoing",
      });
      await forwardReactionEventsToAgent({
        account,
        runtime,
        ctx,
        events,
      });
      return;
    }

    if (msg.type === THREEMA_GROUP_NAME_MESSAGE_TYPE) {
      const conversationCreator = tryNormalizeIdentity(String(msg?.conversation?.group?.creatorIdentity ?? ""));
      const fallbackCreator = tryNormalizeIdentity(account.identity?.identity ?? "");
      const creatorIdentity = conversationCreator ?? fallbackCreator;
      if (!creatorIdentity) {
        ctx.log?.debug?.(
          `[${account.accountId}] Ignoring reflected GROUP_NAME control message: unknown creator identity`,
        );
        return;
      }
      persistGroupNameFromControlMessage({
        body: msg.body,
        creatorIdentity,
        account,
        ctx,
        source: "outgoing",
      });
      return;
    }

    if (msg.type === THREEMA_GROUP_TEXT_MESSAGE_TYPE) {
      // Group text: [creatorIdentity:8][groupId:8][text]
      const body = msg.body as Uint8Array;
      if (!body || body.length < 17) return;
      const creatorIdentity = new TextDecoder().decode(body.slice(0, 8));
      const groupIdBytes = body.slice(8, 16);
      const gid = new DataView(groupIdBytes.buffer, groupIdBytes.byteOffset).getBigUint64(0, true);
      const text = new TextDecoder().decode(body.slice(16));

      if (!text.trim()) return;

      const chatId = `threema:group:${creatorIdentity}/${gid}`;
      const conversationLabel = resolveGroupConversationLabel({
        dataDir: account.dataDir,
        creatorIdentity,
        groupId: gid,
        accountId: account.accountId,
        ctx,
      });

      ctx.log?.info(
        `[${account.accountId}] 📩 Reflected outgoing group text in ${creatorIdentity}/${gid}: "${text.slice(0, 80)}"`,
      );

      // Route through OpenClaw as if it were an inbound message
      await processTextMessage({
        text,
        chatId,
        chatType: "group",
        senderIdentity: account.identity?.identity ?? creatorIdentity,
        conversationLabel,
        groupSubject: conversationLabel,
        groupCreator: creatorIdentity,
        groupIdBytes: new Uint8Array(groupIdBytes),
        messageId: msg.messageId?.toString?.() ?? `threema-${Date.now()}`,
        account,
        runtime,
        ctx,
      });
    } else if (msg.type === THREEMA_TEXT_MESSAGE_TYPE) {
      const text = msg.body ? new TextDecoder().decode(msg.body) : "";
      ctx.log?.debug?.(`[${account.accountId}] Reflected outgoing text: "${text.slice(0, 80)}"`);
    } else if (msg.type === THREEMA_FILE_MESSAGE_TYPE) {
      const client = activeClients.get(account.accountId);
      const body = toUint8Array(msg.body);
      const parsed = client && body ? client.parseDirectFileMessageBody(body) : null;
      if (parsed) {
        ctx.log?.debug?.(
          `[${account.accountId}] Reflected outgoing media: ${parsed.mediaType} ${parsed.fileName ?? parsed.blobId}`,
        );
      } else {
        ctx.log?.debug?.(
          `[${account.accountId}] Reflected outgoing media payload (unparseable)`,
        );
      }
    } else if (msg.type === THREEMA_GROUP_FILE_MESSAGE_TYPE) {
      const client = activeClients.get(account.accountId);
      const body = toUint8Array(msg.body);
      const parsed = client && body ? client.parseGroupFileMessageBody(body) : null;
      if (parsed) {
        ctx.log?.debug?.(
          `[${account.accountId}] Reflected outgoing group media in ${parsed.creatorIdentity}/${parsed.groupId.toString()}: ${parsed.descriptor.mediaType} ${parsed.descriptor.fileName ?? parsed.descriptor.blobId}`,
        );
      } else {
        ctx.log?.debug?.(
          `[${account.accountId}] Reflected outgoing group media payload (unparseable)`,
        );
      }
    } else if (msg.type === THREEMA_TYPING_INDICATOR_MESSAGE_TYPE) {
      const isTyping = parseTypingIndicatorBody(msg.body);
      if (isTyping === null) {
        ctx.log?.debug?.(
          `[${account.accountId}] Ignoring invalid reflected typing indicator body`,
        );
      } else {
        ctx.log?.debug?.(
          `[${account.accountId}] Reflected typing indicator: ${isTyping ? "typing" : "stopped"}`,
        );
      }
    }
  }
}
