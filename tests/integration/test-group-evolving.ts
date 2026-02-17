#!/usr/bin/env tsx

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { MediatorClient, type IdentityData } from "../../src/mediator-client.js";

const TEST_TIMEOUT_MS = 10 * 60_000;
const LEADER_AND_CSP_TIMEOUT_MS = 90_000;

type CadenceProfileName = "slow" | "medium" | "fast" | "stress";

const CADENCE_PROFILES: Record<CadenceProfileName, { edits: number; intervalMs: number }> = {
  slow: { edits: 6, intervalMs: 1_500 },
  medium: { edits: 10, intervalMs: 900 },
  fast: { edits: 20, intervalMs: 400 },
  stress: { edits: 40, intervalMs: 200 },
};

type ScriptOptions = {
  profile: CadenceProfileName;
  edits: number;
  intervalMs: number;
  jitterMs: number;
  textPrefix: string;
  groupTarget: {
    creatorIdentity: string;
    groupId: bigint;
    groupIdBytes: Uint8Array;
  } | null;
  groupName: string;
  memberIdentities: string[];
  requireCsp: boolean;
  holdMs: number;
};

let activeClient: MediatorClient | null = null;

function printUsage(): void {
  console.log("Usage: npm run test-group-evolving -- [options]");
  console.log("");
  console.log("Options:");
  console.log("  --profile <slow|medium|fast|stress>");
  console.log("  --edits <n>");
  console.log("  --interval-ms <ms>");
  console.log("  --jitter-ms <ms>");
  console.log("  --text-prefix <text>");
  console.log("  --group <CREATOR/GROUP_ID>");
  console.log("  --group-name <name>");
  console.log("  --members <ID1,ID2,...>");
  console.log("  --require-csp");
  console.log("  --hold-ms <ms>");
  console.log("  --help");
  console.log("");
  console.log("Notes:");
  console.log("  - Without --members this creates a self-only notes group.");
  console.log("  - With --members this creates a real member group and enforces CSP readiness.");
}

function normalizeIdentity(identity: string, fieldName: string): string {
  const normalized = identity.trim().toUpperCase();
  if (!/^[*0-9A-Z]{8}$/.test(normalized)) {
    throw new Error(`Invalid ${fieldName} "${identity}" (expected 8-character Threema ID)`);
  }
  return normalized;
}

function parsePositiveInt(raw: string, fieldName: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid ${fieldName} "${raw}" (expected non-negative integer)`);
  }
  return parsed;
}

function parseCadenceProfile(raw: string): CadenceProfileName {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "slow" || normalized === "medium" || normalized === "fast" || normalized === "stress") {
    return normalized;
  }
  throw new Error(`Invalid --profile "${raw}" (expected slow|medium|fast|stress)`);
}

function parseGroupTarget(raw: string): { creatorIdentity: string; groupId: bigint; groupIdBytes: Uint8Array } {
  const match = raw.trim().match(/^([*0-9a-z]{8})\/([0-9]+)$/i);
  if (!match) {
    throw new Error(`Invalid --group "${raw}" (expected CREATOR/GROUP_ID)`);
  }
  const creatorIdentity = normalizeIdentity(match[1] ?? "", "groupCreator");
  const groupId = BigInt(match[2] ?? "0");
  if (groupId <= 0n) {
    throw new Error(`Invalid --group groupId "${match[2]}" (expected > 0)`);
  }
  const groupIdBytes = new Uint8Array(8);
  new DataView(groupIdBytes.buffer).setBigUint64(0, groupId, true);
  return { creatorIdentity, groupId, groupIdBytes };
}

function parseMemberIdentities(raw: string): string[] {
  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return Array.from(new Set(values.map((value) => normalizeIdentity(value, "memberIdentity"))));
}

function parseArgs(argv: string[]): ScriptOptions {
  let profile: CadenceProfileName = "medium";
  let edits: number | null = null;
  let intervalMs: number | null = null;
  let jitterMs = 0;
  let textPrefix = "Evolving group test";
  let groupTarget: ScriptOptions["groupTarget"] = null;
  let groupName = `Evolving ${new Date().toISOString().slice(11, 19)}`;
  let memberIdentities: string[] = [];
  let requireCsp = false;
  let holdMs = 5_000;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = argv[i + 1];

    if (arg === "--help") {
      printUsage();
      process.exit(0);
    }

    if (arg === "--profile") {
      if (!next) throw new Error("Missing value for --profile");
      profile = parseCadenceProfile(next);
      i += 1;
      continue;
    }
    if (arg === "--edits") {
      if (!next) throw new Error("Missing value for --edits");
      edits = parsePositiveInt(next, "--edits");
      i += 1;
      continue;
    }
    if (arg === "--interval-ms") {
      if (!next) throw new Error("Missing value for --interval-ms");
      intervalMs = parsePositiveInt(next, "--interval-ms");
      i += 1;
      continue;
    }
    if (arg === "--jitter-ms") {
      if (!next) throw new Error("Missing value for --jitter-ms");
      jitterMs = parsePositiveInt(next, "--jitter-ms");
      i += 1;
      continue;
    }
    if (arg === "--text-prefix") {
      if (!next) throw new Error("Missing value for --text-prefix");
      textPrefix = next;
      i += 1;
      continue;
    }
    if (arg === "--group") {
      if (!next) throw new Error("Missing value for --group");
      groupTarget = parseGroupTarget(next);
      i += 1;
      continue;
    }
    if (arg === "--group-name") {
      if (!next) throw new Error("Missing value for --group-name");
      groupName = next.trim();
      i += 1;
      continue;
    }
    if (arg === "--members") {
      if (!next) throw new Error("Missing value for --members");
      memberIdentities = parseMemberIdentities(next);
      i += 1;
      continue;
    }
    if (arg === "--require-csp") {
      requireCsp = true;
      continue;
    }
    if (arg === "--hold-ms") {
      if (!next) throw new Error("Missing value for --hold-ms");
      holdMs = parsePositiveInt(next, "--hold-ms");
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  const profileDefaults = CADENCE_PROFILES[profile];
  const resolvedEdits = edits ?? profileDefaults.edits;
  const resolvedIntervalMs = intervalMs ?? profileDefaults.intervalMs;
  if (resolvedEdits <= 0) {
    throw new Error("--edits must be >= 1");
  }
  if (resolvedIntervalMs <= 0) {
    throw new Error("--interval-ms must be >= 1");
  }

  return {
    profile,
    edits: resolvedEdits,
    intervalMs: resolvedIntervalMs,
    jitterMs,
    textPrefix,
    groupTarget,
    groupName,
    memberIdentities,
    requireCsp,
    holdMs,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveDelayMs(intervalMs: number, jitterMs: number): number {
  if (jitterMs <= 0) {
    return intervalMs;
  }
  const delta = Math.floor(Math.random() * (jitterMs * 2 + 1)) - jitterMs;
  return Math.max(1, intervalMs + delta);
}

function resolveEffectiveRequireCsp(options: ScriptOptions): boolean {
  // Member-delivery verification requires CSP-ready path; reflection-only does not reach members.
  return options.requireCsp || options.memberIdentities.length > 0;
}

async function runWithTimeout(task: () => Promise<void>, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        activeClient?.disconnect();
      } catch {
        // Ignore disconnect failures during timeout.
      }
      reject(new Error(`Timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    task()
      .then(() => {
        clearTimeout(timer);
        resolve();
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const members = options.memberIdentities;
  const effectiveRequireCsp = resolveEffectiveRequireCsp(options);

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const dataDir = path.join(__dirname, "..", "..", "data");
  const identityPath = path.join(dataDir, "identity.json");
  if (!fs.existsSync(identityPath)) {
    throw new Error(`Missing identity file: ${identityPath}`);
  }

  const identity: IdentityData = JSON.parse(fs.readFileSync(identityPath, "utf-8"));
  const client = new MediatorClient({ identity, dataDir });
  activeClient = client;

  try {
    await client.connect();
    if (effectiveRequireCsp) {
      await client.waitForLeaderAndCsp(LEADER_AND_CSP_TIMEOUT_MS);
    }
    if (members.length > 0 && !options.requireCsp) {
      console.log(
        "[test-group-evolving] Members were provided; enforcing CSP-ready send path to ensure recipient delivery.",
      );
    }

    const selfIdentity = normalizeIdentity(client.getIdentity(), "selfIdentity");
    const group = options.groupTarget ?? await (async () => {
      if (members.length > 0) {
        const created = await client.createGroupWithMembers({
          name: options.groupName,
          memberIdentities: members,
          requireCsp: effectiveRequireCsp,
        });
        return {
          creatorIdentity: selfIdentity,
          groupId: created.groupIdBigInt,
          groupIdBytes: created.groupId,
        };
      }
      const created = await client.createGroup(options.groupName);
      return {
        creatorIdentity: selfIdentity,
        groupId: created.groupIdBigInt,
        groupIdBytes: created.groupId,
      };
    })();

    const token = `EVOLVE-${Date.now().toString(36).toUpperCase()}`;
    const startAt = Date.now();
    const anchorText = `${options.textPrefix} [0/${options.edits}] ${token}`;

    console.log(`[test-group-evolving] Profile=${options.profile} edits=${options.edits} intervalMs=${options.intervalMs} jitterMs=${options.jitterMs} requireCsp=${effectiveRequireCsp} (requested=${options.requireCsp})`);
    console.log(`[test-group-evolving] Group=${group.creatorIdentity}/${group.groupId.toString()} members=${members.join(",") || "(none => reflect/self-only)"}`);
    console.log(`[test-group-evolving] Sending anchor text: "${anchorText}"`);

    const anchorMessageId = await client.sendGroupTextMessage(
      group.creatorIdentity,
      group.groupIdBytes,
      members,
      anchorText,
      { requireCsp: effectiveRequireCsp },
    );
    console.log(`[test-group-evolving] Anchor message ID: ${anchorMessageId.toString()}`);

    for (let index = 1; index <= options.edits; index += 1) {
      const delayMs = resolveDelayMs(options.intervalMs, options.jitterMs);
      await sleep(delayMs);
      const editText = `${options.textPrefix} [${index}/${options.edits}] ${token}${index === options.edits ? " FINAL" : ""}`;
      const editTransportMessageId = await client.sendGroupEditMessage(
        group.creatorIdentity,
        group.groupIdBytes,
        members,
        anchorMessageId,
        editText,
        { requireCsp: effectiveRequireCsp },
      );
      const elapsedMs = Date.now() - startAt;
      console.log(
        `[test-group-evolving] Edit ${index}/${options.edits} sent (delay=${delayMs}ms elapsed=${elapsedMs}ms editMessageId=${editTransportMessageId.toString()})`,
      );
    }

    const durationMs = Date.now() - startAt;
    const editsPerSecond = options.edits / Math.max(1, durationMs / 1000);
    console.log(`[test-group-evolving] Complete in ${durationMs}ms (${editsPerSecond.toFixed(2)} edits/sec).`);
    console.log(`[test-group-evolving] Manual verification: on phone, confirm one evolving message in ${group.creatorIdentity}/${group.groupId.toString()} ended with token "${token}" and suffix "FINAL".`);

    if (options.holdMs > 0) {
      await sleep(options.holdMs);
    }
  } finally {
    client.disconnect();
    activeClient = null;
  }
}

try {
  await runWithTimeout(main, TEST_TIMEOUT_MS);
  process.exit(0);
} catch (err) {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`[test-group-evolving] Failed: ${message}`);
  process.exit(1);
}
