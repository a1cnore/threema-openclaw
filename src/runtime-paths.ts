import path from "node:path";

/**
 * Resolve the Threema data directory.
 *
 * Priority:
 * 1) THREEMA_DATA_DIR environment variable
 * 2) ./data under the caller's current working directory
 */
export function resolveThreemaDataDir(): string {
  const override = process.env.THREEMA_DATA_DIR?.trim();
  if (override) {
    return path.resolve(override);
  }
  return path.resolve(process.cwd(), "data");
}

export function resolveThreemaIdentityPath(dataDir: string = resolveThreemaDataDir()): string {
  return path.join(dataDir, "identity.json");
}
