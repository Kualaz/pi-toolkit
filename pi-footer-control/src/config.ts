import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { FooterConfig } from "./types.js";
import { DEFAULT_CONFIG, normalizeConfig } from "./types.js";

function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

/** Path to this extension's settings file in the active Pi agent directory. */
export const SETTINGS_PATH = join(getAgentDir(), "footer", "settings.json");

export async function loadConfig(): Promise<FooterConfig> {
  try {
    const raw = await readFile(SETTINGS_PATH, "utf-8");
    return normalizeConfig(JSON.parse(raw));
  } catch {
    return normalizeConfig(DEFAULT_CONFIG);
  }
}

export async function saveConfig(config: FooterConfig): Promise<void> {
  await mkdir(dirname(SETTINGS_PATH), { recursive: true });
  await writeFile(SETTINGS_PATH, JSON.stringify(normalizeConfig(config), null, 2));
}
