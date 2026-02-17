#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

function readJson(filename) {
  const fullPath = path.join(repoRoot, filename);
  return JSON.parse(fs.readFileSync(fullPath, "utf8"));
}

const packageJson = readJson("package.json");
const pluginJson = readJson("openclaw.plugin.json");

if (packageJson.version !== pluginJson.version) {
  console.error("Version mismatch:");
  console.error(`  package.json: ${packageJson.version}`);
  console.error(`  openclaw.plugin.json: ${pluginJson.version}`);
  process.exit(1);
}

console.log(`Version check passed: ${packageJson.version}`);
