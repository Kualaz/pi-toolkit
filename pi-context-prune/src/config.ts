import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ContextPruneConfig } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";

/** Path to the extension's own settings file, independent of any project. */
export const SETTINGS_PATH = join(getAgentDir(), "context-prune", "settings.json");

/** Reads the active Pi agent-dir context-prune settings and returns the config (or defaults). */
export async function loadConfig(): Promise<ContextPruneConfig> {
  try {
    const raw = await readFile(SETTINGS_PATH, "utf-8");
    const existing = JSON.parse(raw);
    return { ...DEFAULT_CONFIG, ...existing };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/** Writes the full config to the active Pi agent-dir context-prune settings. */
export async function saveConfig(config: ContextPruneConfig): Promise<void> {
  await mkdir(dirname(SETTINGS_PATH), { recursive: true });
  await writeFile(SETTINGS_PATH, JSON.stringify(config, null, 2));
}
