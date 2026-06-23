import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { loadConfig, saveConfig, SETTINGS_PATH } from "./src/config.js";
import { installMarkdownPatch, isHexColor, uninstallMarkdownPatch, updateMarkdownPatchConfig } from "./src/patch.js";
import { DEFAULT_CONFIG, normalizeConfig, normalizeLanguage, type CodeBlockConfig } from "./src/types.js";

type MutableConfig = { value: CodeBlockConfig };

function booleanFromArg(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (["on", "true", "yes", "enable", "enabled", "show"].includes(normalized)) return true;
  if (["off", "false", "no", "disable", "disabled", "hide"].includes(normalized)) return false;
  return undefined;
}

function summarizeConfig(config: CodeBlockConfig): string {
  const sampleSymbols = ["text", "go", "typescript", "javascript", "json", "bash", "python", "diff"]
    .map((lang) => `${lang}=${config.languageSymbols[lang] ?? config.defaultSymbol}`)
    .join(", ");

  return [
    "Fenced code block rendering:",
    `  enabled:        ${config.enabled}`,
    `  background:     ${config.backgroundColor}`,
    `  header fg:      ${config.headerForegroundColor ?? "theme"}`,
    `  header:         ${config.showLanguageHeader ? "on" : "off"}`,
    `  fence markers:  ${config.hideFenceMarkers ? "hidden" : "shown"}`,
    `  template:       ${config.headerTemplate}`,
    `  default label:  ${config.defaultLanguageLabel}`,
    `  default symbol: ${config.defaultSymbol}`,
    `  symbols:        ${sampleSymbols}`,
    `  file:           ${SETTINGS_PATH}`,
  ].join("\n");
}

async function saveApplyNotify(ctx: ExtensionContext, currentConfig: MutableConfig, message: string): Promise<void> {
  currentConfig.value = normalizeConfig(currentConfig.value);
  updateMarkdownPatchConfig(currentConfig.value);
  await saveConfig(currentConfig.value);
  ctx.ui.notify(message);
}

function commandHelp(): string {
  return [
    "Usage:",
    "  /code-blocks status",
    "  /code-blocks bg #303030",
    "  /code-blocks fg #d0d0d0|theme",
    "  /code-blocks enable|disable",
    "  /code-blocks header on|off",
    "  /code-blocks fences hide|show",
    "  /code-blocks symbol <language> <symbol>",
    "  /code-blocks template <template with {symbol} and {lang}>",
    "  /code-blocks reset",
  ].join("\n");
}

async function handleCodeBlocksCommand(args: string, ctx: ExtensionContext, currentConfig: MutableConfig): Promise<void> {
  const trimmed = args.trim();
  if (!trimmed || trimmed === "status") {
    ctx.ui.notify(summarizeConfig(currentConfig.value));
    return;
  }

  if (trimmed === "help") {
    ctx.ui.notify(commandHelp());
    return;
  }

  if (trimmed === "reset") {
    currentConfig.value = normalizeConfig(DEFAULT_CONFIG);
    await saveApplyNotify(ctx, currentConfig, "Fenced code block settings reset to defaults.");
    return;
  }

  if (trimmed === "enable" || trimmed === "enabled" || trimmed === "on") {
    currentConfig.value = { ...currentConfig.value, enabled: true };
    await saveApplyNotify(ctx, currentConfig, "Fenced code block styling enabled.");
    return;
  }

  if (trimmed === "disable" || trimmed === "disabled" || trimmed === "off") {
    currentConfig.value = { ...currentConfig.value, enabled: false };
    await saveApplyNotify(ctx, currentConfig, "Fenced code block styling disabled.");
    return;
  }

  const [command = "", ...rest] = trimmed.split(/\s+/);
  const commandLower = command.toLowerCase();

  if (commandLower === "bg" || commandLower === "background" || commandLower === "color") {
    const color = rest[0];
    if (!color || !isHexColor(color)) {
      ctx.ui.notify("Expected a hex color like #303030 or #333.", "warning");
      return;
    }

    currentConfig.value = { ...currentConfig.value, backgroundColor: color.startsWith("#") ? color : `#${color}` };
    await saveApplyNotify(ctx, currentConfig, `Fenced code block background set to ${currentConfig.value.backgroundColor}.`);
    return;
  }

  if (
    commandLower === "fg" ||
    commandLower === "foreground" ||
    commandLower === "header-fg" ||
    commandLower === "header-foreground"
  ) {
    const color = rest[0];
    if (!color || color.toLowerCase() === "theme" || color.toLowerCase() === "default" || color.toLowerCase() === "reset") {
      currentConfig.value = { ...currentConfig.value, headerForegroundColor: null };
      await saveApplyNotify(ctx, currentConfig, "Fenced code block header foreground reset to theme color.");
      return;
    }

    if (!isHexColor(color)) {
      ctx.ui.notify("Expected a hex color like #d0d0d0 or #ddd, or 'theme' to reset.", "warning");
      return;
    }

    currentConfig.value = { ...currentConfig.value, headerForegroundColor: color.startsWith("#") ? color : `#${color}` };
    await saveApplyNotify(
      ctx,
      currentConfig,
      `Fenced code block header foreground set to ${currentConfig.value.headerForegroundColor}.`,
    );
    return;
  }

  if (commandLower === "header") {
    const enabled = booleanFromArg(rest[0]);
    if (enabled === undefined) {
      ctx.ui.notify("Expected /code-blocks header on or /code-blocks header off.", "warning");
      return;
    }

    currentConfig.value = { ...currentConfig.value, showLanguageHeader: enabled };
    await saveApplyNotify(ctx, currentConfig, `Fenced code block header ${enabled ? "enabled" : "disabled"}.`);
    return;
  }

  if (commandLower === "fences" || commandLower === "markers") {
    const value = rest[0]?.toLowerCase();
    if (value !== "hide" && value !== "hidden" && value !== "show" && value !== "shown") {
      ctx.ui.notify("Expected /code-blocks fences hide or /code-blocks fences show.", "warning");
      return;
    }

    const hideFenceMarkers = value === "hide" || value === "hidden";
    currentConfig.value = { ...currentConfig.value, hideFenceMarkers };
    await saveApplyNotify(ctx, currentConfig, `Fence markers ${hideFenceMarkers ? "hidden" : "shown"}.`);
    return;
  }

  if (commandLower === "symbol" || commandLower === "icon") {
    const language = rest[0];
    const symbol = rest.slice(1).join(" ");
    if (!language || !symbol) {
      ctx.ui.notify("Expected /code-blocks symbol <language> <symbol>.", "warning");
      return;
    }

    const normalizedLanguage = normalizeLanguage(language);
    currentConfig.value = {
      ...currentConfig.value,
      languageSymbols: {
        ...currentConfig.value.languageSymbols,
        [normalizedLanguage]: symbol,
      },
    };
    await saveApplyNotify(ctx, currentConfig, `Symbol for ${normalizedLanguage} set to ${symbol}.`);
    return;
  }

  if (commandLower === "template") {
    const template = trimmed.slice(command.length).trim();
    if (!template) {
      ctx.ui.notify("Expected a template, e.g. /code-blocks template {symbol} {lang}.", "warning");
      return;
    }

    currentConfig.value = { ...currentConfig.value, headerTemplate: template };
    await saveApplyNotify(ctx, currentConfig, `Header template set to: ${template}`);
    return;
  }

  if (commandLower === "label") {
    const label = rest.join(" ").trim();
    if (!label) {
      ctx.ui.notify("Expected /code-blocks label <default-language-label>.", "warning");
      return;
    }

    currentConfig.value = { ...currentConfig.value, defaultLanguageLabel: label };
    await saveApplyNotify(ctx, currentConfig, `Default language label set to ${label}.`);
    return;
  }

  ctx.ui.notify(`${commandHelp()}\n\nUnknown subcommand: ${command}`, "warning");
}

export default async function fencedCodeBlocksExtension(pi: ExtensionAPI) {
  const currentConfig: MutableConfig = { value: await loadConfig() };
  installMarkdownPatch(currentConfig.value);

  pi.registerCommand("code-blocks", {
    description: "Configure fenced markdown code block rendering",
    getArgumentCompletions: (prefix: string) => {
      const tokens = prefix.trimStart().split(/\s+/);
      const first = tokens[0] ?? "";
      if (tokens.length <= 1 && !prefix.endsWith(" ")) {
        return ["status", "help", "bg", "fg", "enable", "disable", "header", "fences", "symbol", "template", "label", "reset"]
          .filter((value) => value.startsWith(first))
          .map((value) => ({ value, label: value }));
      }

      if ((first === "header" || first === "fences") && tokens.length <= 2) {
        const second = tokens[1] ?? "";
        const values = first === "header" ? ["on", "off"] : ["hide", "show"];
        return values.filter((value) => value.startsWith(second)).map((value) => ({ value, label: value }));
      }

      return null;
    },
    handler: async (args, ctx) => handleCodeBlocksCommand(args, ctx, currentConfig),
  });

  pi.registerCommand("fenced-code-blocks", {
    description: "Alias for /code-blocks",
    handler: async (args, ctx) => handleCodeBlocksCommand(args, ctx, currentConfig),
  });

  pi.on("session_start", async (_event, _ctx) => {
    currentConfig.value = await loadConfig();
    installMarkdownPatch(currentConfig.value);
    updateMarkdownPatchConfig(currentConfig.value);
  });

  pi.on("session_shutdown", async () => {
    uninstallMarkdownPatch();
  });
}
