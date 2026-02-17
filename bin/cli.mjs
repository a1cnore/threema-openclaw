#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");
const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");

function printUsage() {
  console.log("threema-openclaw");
  console.log("");
  console.log("Usage:");
  console.log("  threema-openclaw link-device [--data-dir <path>]");
  console.log("  threema-openclaw connect-mediator [--data-dir <path>]");
  console.log("");
  console.log("Environment:");
  console.log("  THREEMA_DATA_DIR   Directory for identity.json/contacts.json/groups.json");
}

function parseDataDir(args) {
  const nextArgs = [];
  let dataDir;
  for (let i = 0; i < args.length; i += 1) {
    const value = args[i];
    if (value === "--data-dir") {
      dataDir = args[i + 1];
      i += 1;
      continue;
    }
    nextArgs.push(value);
  }
  return { dataDir, nextArgs };
}

const [command = "help", ...rest] = process.argv.slice(2);

if (command === "help" || command === "--help" || command === "-h") {
  printUsage();
  process.exit(0);
}

const scriptsByCommand = {
  "link-device": path.join(repoRoot, "src", "link-device.ts"),
  "connect-mediator": path.join(repoRoot, "src", "connect-mediator.ts"),
};

const script = scriptsByCommand[command];
if (!script) {
  console.error(`Unknown command: ${command}`);
  printUsage();
  process.exit(1);
}

const { dataDir, nextArgs } = parseDataDir(rest);
const env = { ...process.env };
if (dataDir) {
  env.THREEMA_DATA_DIR = path.resolve(process.cwd(), dataDir);
}

const result = spawnSync(
  process.execPath,
  [tsxCli, script, ...nextArgs],
  { stdio: "inherit", env, cwd: process.cwd() },
);

if (typeof result.status === "number") {
  process.exit(result.status);
}
process.exit(1);
