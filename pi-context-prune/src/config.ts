import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ContextPruneConfig } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";

/** Path to the extension's own settings file, independent of any project. */
export const SETTINGS_PATH = join(getAgentDir(), "context-prune", "settings.json");

/** Pre-getAgentDir() settings path used by older versions of this extension. */
export const LEGACY_SETTINGS_PATH = join(homedir(), ".pi", "agent", "context-prune", "settings.json");

async function readConfig(path: string): Promise<ContextPruneConfig> {
  const raw = await readFile(path, "utf-8");
  const existing = JSON.parse(raw);
  return { ...DEFAULT_CONFIG, ...existing };
}

/** Reads the active Pi agent-dir context-prune settings and returns the config (or defaults). */
export async function loadConfig(): Promise<ContextPruneConfig> {
  try {
    return await readConfig(SETTINGS_PATH);
  } catch {
    // Fall through to legacy migration/defaults below.
  }

  if (SETTINGS_PATH !== LEGACY_SETTINGS_PATH) {
    try {
      const legacyConfig = await readConfig(LEGACY_SETTINGS_PATH);
      // Best-effort one-time migration so users with PI_CODING_AGENT_DIR keep
      // their existing pruner settings after the Pi API path update.
      await saveConfig(legacyConfig).catch(() => undefined);
      return legacyConfig;
    } catch {
      // Fall through to defaults.
    }
  }

  return { ...DEFAULT_CONFIG };
}

/** Writes the full config to the active Pi agent-dir context-prune settings. */
export async function saveConfig(config: ContextPruneConfig): Promise<void> {
  await mkdir(dirname(SETTINGS_PATH), { recursive: true });
  await writeFile(SETTINGS_PATH, JSON.stringify(config, null, 2));
}
