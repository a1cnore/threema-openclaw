#!/usr/bin/env tsx

import fs from "node:fs";
import path from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveThreemaDataDir } from "./runtime-paths.js";

type SetupOptions = {
  dataDirOverride?: string;
  account: string;
  skipLink: boolean;
  nonInteractive: boolean;
  pluginSpec: string;
  help: boolean;
};

type SpawnResult = SpawnSyncReturns<string>;

function printUsage(): void {
  console.log("threema-openclaw setup");
  console.log("");
  console.log("Usage:");
  console.log("  threema-openclaw setup [options]");
  console.log("");
  console.log("Options:");
  console.log("  --data-dir <path>       Directory for identity.json/contacts.json/groups.json");
  console.log("  --account <id>          OpenClaw account id to configure (default: default)");
  console.log("  --plugin-spec <spec>    Plugin npm spec to install when missing");
  console.log("                          (default: threema-openclaw@latest)");
  console.log("  --skip-link             Skip QR linking (requires existing identity.json)");
  console.log("  --non-interactive       Fail if interactive linking would be required");
  console.log("  -h, --help              Show this help");
}

function fail(message: string): never {
  console.error(`\nError: ${message}`);
  process.exit(1);
}

function parseRequiredArg(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    fail(`Missing value for ${flag}`);
  }
  return value;
}

function parseArgs(argv: string[]): SetupOptions {
  const options: SetupOptions = {
    account: "default",
    skipLink: false,
    nonInteractive: false,
    pluginSpec: process.env.THREEMA_OPENCLAW_PLUGIN_SPEC?.trim() || "threema-openclaw@latest",
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    switch (value) {
      case "--data-dir":
        options.dataDirOverride = parseRequiredArg(argv, i + 1, value);
        i += 1;
        break;
      case "--account":
        options.account = parseRequiredArg(argv, i + 1, value);
        i += 1;
        break;
      case "--plugin-spec":
        options.pluginSpec = parseRequiredArg(argv, i + 1, value);
        i += 1;
        break;
      case "--skip-link":
        options.skipLink = true;
        break;
      case "--non-interactive":
        options.nonInteractive = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        fail(`Unknown option: ${value}`);
    }
  }

  return options;
}

function runCommand(
  command: string,
  args: string[],
  options: { capture?: boolean; env?: NodeJS.ProcessEnv; check?: boolean } = {},
): SpawnResult {
  const result = spawnSync(command, args, {
    stdio: options.capture ? "pipe" : "inherit",
    encoding: "utf-8",
    env: options.env ?? process.env,
  });

  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === "ENOENT") {
      fail(`Command not found: ${command}`);
    }
    fail(`Failed to run ${command}: ${result.error.message}`);
  }

  if (options.check !== false && result.status !== 0) {
    fail(`${command} ${args.join(" ")} exited with code ${result.status ?? "unknown"}`);
  }

  return result;
}

function ensureOpenClawAvailable(): void {
  const versionResult = runCommand("openclaw", ["--version"], { capture: true });
  const version = (versionResult.stdout || "").trim();
  if (version.length > 0) {
    console.log(`Detected OpenClaw CLI ${version}`);
  } else {
    console.log("Detected OpenClaw CLI");
  }
}

function ensurePluginInstalled(pluginId: string, pluginSpec: string): void {
  const infoResult = runCommand("openclaw", ["plugins", "info", pluginId], {
    capture: true,
    check: false,
  });

  if (infoResult.status === 0) {
    console.log(`Plugin ${pluginId} is already installed.`);
    return;
  }

  console.log(`Installing plugin ${pluginSpec}...`);
  runCommand("openclaw", ["plugins", "install", pluginSpec]);
}

function enablePlugin(pluginId: string): void {
  console.log(`Enabling plugin ${pluginId}...`);
  runCommand("openclaw", ["plugins", "enable", pluginId]);
}

function runLinkDevice(dataDir: string): void {
  const srcDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(srcDir, "..");
  const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
  const linkScript = path.join(srcDir, "link-device.ts");

  if (!fs.existsSync(tsxCli)) {
    fail(`Missing runtime dependency: ${tsxCli}`);
  }

  const env = { ...process.env, THREEMA_DATA_DIR: dataDir };
  const result = spawnSync(process.execPath, [tsxCli, linkScript], {
    stdio: "inherit",
    env,
    cwd: process.cwd(),
  });

  if (result.error) {
    fail(`Failed to start link-device flow: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`link-device exited with code ${result.status ?? "unknown"}`);
  }
}

function configureAccount(account: string, dataDir: string, identityPath: string): void {
  const base = `channels.threema.accounts.${account}`;
  console.log(`Configuring OpenClaw account "${account}"...`);
  runCommand("openclaw", ["config", "set", `${base}.identityFile`, identityPath]);
  runCommand("openclaw", ["config", "set", `${base}.dataDir`, dataDir]);
}

function verifyPlugin(pluginId: string): void {
  console.log("Running plugin checks...");
  runCommand("openclaw", ["plugins", "doctor"]);
  runCommand("openclaw", ["plugins", "info", pluginId]);
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    process.exit(0);
  }

  if (!options.account.trim()) {
    fail("Account id cannot be empty");
  }

  if (options.dataDirOverride) {
    process.env.THREEMA_DATA_DIR = path.resolve(process.cwd(), options.dataDirOverride);
  }

  const dataDir = resolveThreemaDataDir();
  const identityPath = path.join(dataDir, "identity.json");
  const pluginId = "threema-openclaw";

  console.log("Starting threema-openclaw setup...");
  ensureOpenClawAvailable();
  ensurePluginInstalled(pluginId, options.pluginSpec);
  enablePlugin(pluginId);

  fs.mkdirSync(dataDir, { recursive: true });
  console.log(`Using data directory: ${dataDir}`);

  if (options.skipLink) {
    if (!fs.existsSync(identityPath)) {
      fail(`--skip-link requires an existing identity file at ${identityPath}`);
    }
    console.log("Skipping link step as requested.");
  } else if (fs.existsSync(identityPath)) {
    console.log(`Existing identity detected at ${identityPath}; skipping link step.`);
  } else {
    if (options.nonInteractive) {
      fail("Linking is required but --non-interactive was provided.");
    }
    console.log("No identity found. Starting interactive device linking...");
    runLinkDevice(dataDir);
    if (!fs.existsSync(identityPath)) {
      fail(`Linking completed without creating ${identityPath}`);
    }
  }

  configureAccount(options.account, dataDir, identityPath);
  verifyPlugin(pluginId);

  console.log("");
  console.log("Setup complete.");
  console.log(`Account: ${options.account}`);
  console.log(`Identity file: ${identityPath}`);
  console.log(`Data directory: ${dataDir}`);
}

main();
