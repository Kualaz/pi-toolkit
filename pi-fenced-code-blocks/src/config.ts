import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DEFAULT_CONFIG, normalizeConfig, type CodeBlockConfig } from "./types.js";

export const SETTINGS_PATH = join(getAgentDir(), "fenced-code-blocks", "settings.json");

export async function loadConfig(): Promise<CodeBlockConfig> {
  try {
    const raw = await readFile(SETTINGS_PATH, "utf8");
    return normalizeConfig(JSON.parse(raw) as Partial<CodeBlockConfig>);
  } catch {
    return normalizeConfig(DEFAULT_CONFIG);
  }
}

export async function saveConfig(config: CodeBlockConfig): Promise<void> {
  const normalized = normalizeConfig(config);
  await mkdir(dirname(SETTINGS_PATH), { recursive: true });
  await writeFile(SETTINGS_PATH, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
}
