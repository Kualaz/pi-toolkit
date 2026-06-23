import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ToolCallEvent } from "@mariozechner/pi-coding-agent";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import type { KeyId } from "@mariozechner/pi-tui";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const GUARDED_TOOLS = ["edit", "write", "bash"] as const;
const DEFAULT_SHORTCUT = "ctrl+h" as const;
const KEYBINDING_ID = "pi-tool-toggle.toggle";
const KEYBINDINGS_PATH = join(getAgentDir(), "keybindings.json");
const STATE_ENTRY_TYPE = "tool-toggle-state";

interface PersistedState {
  disabled: boolean;
  restoreTools: string[];
}

type SessionEntryLike = {
  type: string;
  customType?: string;
  data?: unknown;
};

function normalizeShortcut(value: unknown): KeyId | undefined {
  if (typeof value !== "string") return undefined;
  const shortcut = value.trim().toLowerCase();
  return shortcut ? (shortcut as KeyId) : undefined;
}

function uniqueShortcuts(shortcuts: KeyId[]): KeyId[] {
  const seen = new Set<string>();
  const unique: KeyId[] = [];
  for (const shortcut of shortcuts) {
    if (seen.has(shortcut)) continue;
    seen.add(shortcut);
    unique.push(shortcut);
  }
  return unique;
}

function normalizeShortcutConfig(value: unknown): KeyId[] | undefined {
  if (value === undefined) return undefined;

  if (Array.isArray(value)) {
    if (value.length === 0) return [];
    const shortcuts = uniqueShortcuts(value.map(normalizeShortcut).filter((shortcut): shortcut is KeyId => shortcut !== undefined));
    return shortcuts.length > 0 ? shortcuts : undefined;
  }

  const shortcut = normalizeShortcut(value);
  return shortcut ? [shortcut] : undefined;
}

async function loadConfiguredShortcuts(): Promise<KeyId[]> {
  try {
    const raw = await readFile(KEYBINDINGS_PATH, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return normalizeShortcutConfig(parsed[KEYBINDING_ID]) ?? [DEFAULT_SHORTCUT];
  } catch {
    return [DEFAULT_SHORTCUT];
  }
}

function isGuardedTool(toolName: string): boolean {
  return (GUARDED_TOOLS as readonly string[]).includes(toolName);
}

function uniqueTools(toolNames: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const toolName of toolNames) {
    if (seen.has(toolName)) continue;
    seen.add(toolName);
    unique.push(toolName);
  }
  return unique;
}

function getAvailableGuardedTools(pi: ExtensionAPI): string[] {
  const allToolNames = new Set(pi.getAllTools().map((tool) => tool.name));
  return GUARDED_TOOLS.filter((toolName) => allToolNames.has(toolName));
}

function commandHelp(): string {
  return [
    "Usage:",
    "  /tool-toggle              Toggle edit/write/bash on or off",
    "  /tool-toggle on           Re-enable edit/write/bash",
    "  /tool-toggle off          Disable edit/write/bash",
    "  /tool-toggle status       Show current state and shortcut",
    "  /tool-toggle help         Show this help",
  ].join("\n");
}

export default async function toolToggleExtension(pi: ExtensionAPI): Promise<void> {
  const shortcuts = await loadConfiguredShortcuts();

  let disabled = false;
  let restoreTools: string[] = [];

  function shortcutSummary(): string {
    return shortcuts.length > 0 ? shortcuts.join(", ") : "none";
  }

  function updateStatus(ctx: ExtensionContext): void {
    if (disabled) {
      ctx.ui.setStatus("tool-toggle", ctx.ui.theme.fg("warning", "🔒 edit/write/bash off"));
    } else {
      ctx.ui.setStatus("tool-toggle", undefined);
    }
  }

  function persistState(): void {
    pi.appendEntry<PersistedState>(STATE_ENTRY_TYPE, {
      disabled,
      restoreTools,
    });
  }

  function enforceDisabledTools(): void {
    if (!disabled) return;
    const activeTools = pi.getActiveTools();
    const nextTools = activeTools.filter((toolName) => !isGuardedTool(toolName));
    if (nextTools.length !== activeTools.length) {
      pi.setActiveTools(nextTools);
    }
  }

  function disableTools(ctx: ExtensionContext, notify = true, persist = true): void {
    const activeTools = pi.getActiveTools();

    if (!disabled) {
      restoreTools = activeTools.filter(isGuardedTool);
    }

    disabled = true;
    enforceDisabledTools();
    updateStatus(ctx);

    if (persist) persistState();
    if (notify) {
      const removed = restoreTools.length > 0 ? restoreTools.join(", ") : GUARDED_TOOLS.join(", ");
      ctx.ui.notify(`Disabled tools: ${removed}`);
    }
  }

  function enableTools(ctx: ExtensionContext, notify = true, persist = true): void {
    const availableTools = new Set(pi.getAllTools().map((tool) => tool.name));
    const activeTools = pi.getActiveTools().filter((toolName) => availableTools.has(toolName));
    const toolsToRestore = restoreTools.length > 0 ? restoreTools : getAvailableGuardedTools(pi);
    const nextTools = uniqueTools([
      ...activeTools,
      ...toolsToRestore.filter((toolName) => availableTools.has(toolName)),
    ]);

    pi.setActiveTools(nextTools);
    disabled = false;
    restoreTools = [];
    updateStatus(ctx);

    if (persist) persistState();
    if (notify) {
      const restored = toolsToRestore.length > 0 ? toolsToRestore.join(", ") : "none";
      ctx.ui.notify(`Enabled tools: ${restored}`);
    }
  }

  function toggleTools(ctx: ExtensionContext): void {
    if (disabled) {
      enableTools(ctx);
    } else {
      disableTools(ctx);
    }
  }

  function summarizeState(): string {
    const activeTools = pi.getActiveTools();
    const activeGuarded = GUARDED_TOOLS.filter((toolName) => activeTools.includes(toolName));
    const availableGuarded = getAvailableGuardedTools(pi);

    return [
      "Tool toggle:",
      `  guarded tools: ${GUARDED_TOOLS.join(", ")}`,
      `  state:         ${disabled ? "off/disabled" : "on/enabled"}`,
      `  active now:    ${activeGuarded.length > 0 ? activeGuarded.join(", ") : "none"}`,
      `  available:     ${availableGuarded.length > 0 ? availableGuarded.join(", ") : "none"}`,
      `  shortcuts:     ${shortcutSummary()}`,
      `  keybinding id: ${KEYBINDING_ID}`,
      `  config:        ${KEYBINDINGS_PATH}`,
    ].join("\n");
  }

  function restoreFromBranch(ctx: ExtensionContext): void {
    const branchEntries = ctx.sessionManager.getBranch() as SessionEntryLike[];
    const savedState = [...branchEntries]
      .reverse()
      .find((entry) => entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE)?.data as
      | Partial<PersistedState>
      | undefined;
    const wasDisabled = disabled;

    disabled = savedState?.disabled ?? false;
    restoreTools = Array.isArray(savedState?.restoreTools) ? savedState.restoreTools.filter(isGuardedTool) : [];

    if (disabled) {
      enforceDisabledTools();
    } else if (wasDisabled) {
      const availableTools = new Set(pi.getAllTools().map((tool) => tool.name));
      const activeTools = pi.getActiveTools().filter((toolName) => availableTools.has(toolName));
      pi.setActiveTools(uniqueTools([...activeTools, ...getAvailableGuardedTools(pi)]));
    }
    updateStatus(ctx);
  }

  async function handleCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const trimmed = args.trim();
    const [command = "toggle"] = trimmed.length > 0 ? trimmed.split(/\s+/) : ["toggle"];
    const commandLower = command.toLowerCase();

    if (commandLower === "help") {
      ctx.ui.notify(commandHelp());
      return;
    }

    if (commandLower === "status") {
      ctx.ui.notify(summarizeState());
      return;
    }

    if (["toggle", "switch"].includes(commandLower)) {
      toggleTools(ctx);
      return;
    }

    if (["off", "disable", "disabled", "lock", "locked"].includes(commandLower)) {
      disableTools(ctx);
      return;
    }

    if (["on", "enable", "enabled", "unlock", "unlocked"].includes(commandLower)) {
      enableTools(ctx);
      return;
    }

    ctx.ui.notify(`${commandHelp()}\n\nUnknown subcommand: ${command}`, "warning");
  }

  pi.registerCommand("tool-toggle", {
    description: "Toggle edit, write, and bash tools on/off",
    getArgumentCompletions: (prefix: string) => {
      const tokens = prefix.trimStart().split(/\s+/);
      const first = tokens[0] ?? "";
      if (tokens.length <= 1 && !prefix.endsWith(" ")) {
        return ["toggle", "on", "off", "status", "help"]
          .filter((value) => value.startsWith(first))
          .map((value) => ({ value, label: value }));
      }
      return null;
    },
    handler: handleCommand,
  });

  for (const shortcut of shortcuts) {
    pi.registerShortcut(shortcut, {
      description: "Toggle edit/write/bash tools",
      handler: async (ctx) => toggleTools(ctx),
    });
  }

  pi.on("tool_call", async (event: ToolCallEvent) => {
    if (!disabled || !isGuardedTool(event.toolName)) return;

    const shortcutText = shortcuts.length > 0 ? ` or the ${shortcutSummary()} shortcut` : "";
    return {
      block: true,
      reason: `${event.toolName} is currently disabled by /tool-toggle. Re-enable edit/write/bash with /tool-toggle on${shortcutText}.`,
    };
  });


  pi.on("session_start", async (_event, ctx) => {
    restoreFromBranch(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    restoreFromBranch(ctx);
  });
}
