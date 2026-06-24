import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, truncateToWidth } from "@earendil-works/pi-tui";
import { loadConfig, saveConfig, SETTINGS_PATH } from "./src/config.js";
import { isAutoCompactEnabled, renderFooter } from "./src/footer.js";
import {
  DEFAULT_CONFIG,
  FIELD_DEFINITIONS,
  FOOTER_PLACEMENTS,
  getFieldDefinition,
  isFooterPlacement,
  normalizeConfig,
  type FooterConfig,
  type FooterFieldId,
} from "./src/types.js";

function cloneConfig(config: FooterConfig): FooterConfig {
  return normalizeConfig(config);
}

function summarizeConfig(config: FooterConfig): string {
  const left = FIELD_DEFINITIONS.filter((field) => config.fields[field.id] === "left").map((field) => field.id);
  const right = FIELD_DEFINITIONS.filter((field) => config.fields[field.id] === "right").map((field) => field.id);
  const disabled = FIELD_DEFINITIONS.filter((field) => config.fields[field.id] === "disabled").map((field) => field.id);

  return [
    `Footer settings:`,
    `  left:     ${left.length ? left.join(", ") : "none"}`,
    `  right:    ${right.length ? right.join(", ") : "none"}`,
    `  disabled: ${disabled.length ? disabled.join(", ") : "none"}`,
    `  file:     ${SETTINGS_PATH}`,
  ].join("\n");
}

function makeItems(config: FooterConfig): SettingItem[] {
  return FIELD_DEFINITIONS.map((field) => ({
    id: field.id,
    label: field.label,
    currentValue: config.fields[field.id],
    values: FOOTER_PLACEMENTS,
    description: `${field.description} Values: disabled, left, right.`,
  }));
}

function applyFooter(ctx: ExtensionContext, config: FooterConfig, getThinkingLevel: () => string): void {
  if (!ctx.hasUI) return;

  const footerConfig = cloneConfig(config);
  const autoCompactEnabled = isAutoCompactEnabled(ctx.cwd, ctx.isProjectTrusted());
  ctx.ui.setFooter((tui, theme, footerData) => {
    const unsubBranch = footerData.onBranchChange(() => tui.requestRender());

    return {
      dispose: unsubBranch,
      invalidate() {},
      render(width: number): string[] {
        return renderFooter(width, ctx, theme, footerData, footerConfig, getThinkingLevel, autoCompactEnabled);
      },
    };
  });
}

async function showFooterSettings(
  ctx: ExtensionContext,
  currentConfig: { value: FooterConfig },
  getThinkingLevel: () => string,
): Promise<void> {
  await ctx.ui.custom((tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(
      new (class {
        render(width: number): string[] {
          return [
            truncateToWidth(theme.fg("accent", theme.bold("Footer Display")), width),
            truncateToWidth(theme.fg("dim", "Enter/Space cycles: disabled → left → right. Esc closes."), width),
            "",
          ];
        }
        invalidate() {}
      })(),
    );

    const settingsList = new SettingsList(
      makeItems(currentConfig.value),
      Math.min(FIELD_DEFINITIONS.length + 4, 18),
      getSettingsListTheme(),
      (id, newValue) => {
        const field = getFieldDefinition(id);
        if (!field || !isFooterPlacement(newValue)) return;

        currentConfig.value = cloneConfig({
          ...currentConfig.value,
          fields: {
            ...currentConfig.value.fields,
            [field.id]: newValue,
          },
        });
        saveConfig(currentConfig.value).catch((error) => {
          ctx.ui.notify(`Failed to save footer settings: ${error instanceof Error ? error.message : String(error)}`, "error");
        });
        applyFooter(ctx, currentConfig.value, getThinkingLevel);
      },
      () => done(undefined),
      { enableSearch: true },
    );

    container.addChild(settingsList);

    return {
      render(width: number): string[] {
        return container.render(width);
      },
      invalidate() {
        container.invalidate();
      },
      handleInput(data: string) {
        settingsList.handleInput?.(data);
        tui.requestRender();
      },
    };
  });
}

export default async function footerControlExtension(pi: ExtensionAPI) {
  const currentConfig: { value: FooterConfig } = { value: await loadConfig() };

  const getThinkingLevel = () => pi.getThinkingLevel();

  pi.registerCommand("footer", {
    description: "Configure footer display fields",
    getArgumentCompletions: (prefix: string) => {
      const tokens = prefix.trimStart().split(/\s+/);
      const first = tokens[0] ?? "";

      if (tokens.length <= 1 && !prefix.endsWith(" ")) {
        const values = ["settings", "status", "reset", ...FIELD_DEFINITIONS.map((field) => field.id)];
        return values
          .filter((value) => value.startsWith(first))
          .map((value) => ({ value, label: value }));
      }

      const field = getFieldDefinition(first);
      if (field && tokens.length <= 2) {
        const second = tokens[1] ?? "";
        return FOOTER_PLACEMENTS.filter((value) => value.startsWith(second)).map((value) => ({ value, label: value }));
      }

      return null;
    },
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed || trimmed === "settings") {
        await showFooterSettings(ctx, currentConfig, getThinkingLevel);
        return;
      }

      if (trimmed === "status") {
        ctx.ui.notify(summarizeConfig(currentConfig.value));
        return;
      }

      if (trimmed === "reset") {
        currentConfig.value = cloneConfig(DEFAULT_CONFIG);
        await saveConfig(currentConfig.value);
        applyFooter(ctx, currentConfig.value, getThinkingLevel);
        ctx.ui.notify("Footer settings reset to defaults.");
        return;
      }

      const [fieldId, placement] = trimmed.split(/\s+/, 2);
      const field = getFieldDefinition(fieldId);
      if (!field) {
        ctx.ui.notify(`Unknown footer command or field: ${fieldId}. Use /footer to open settings, /footer status, or /footer reset.`, "warning");
        return;
      }

      if (!placement) {
        ctx.ui.notify(`${field.label}: ${currentConfig.value.fields[field.id]}`);
        return;
      }

      if (!isFooterPlacement(placement)) {
        ctx.ui.notify(`Invalid footer placement: ${placement}. Use disabled, left, or right.`, "warning");
        return;
      }

      currentConfig.value = cloneConfig({
        ...currentConfig.value,
        fields: {
          ...currentConfig.value.fields,
          [field.id as FooterFieldId]: placement,
        },
      });
      await saveConfig(currentConfig.value);
      applyFooter(ctx, currentConfig.value, getThinkingLevel);
      ctx.ui.notify(`${field.label} set to ${placement}.`);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    currentConfig.value = await loadConfig();
    applyFooter(ctx, currentConfig.value, getThinkingLevel);
  });

  pi.on("model_select", async (_event, ctx) => {
    applyFooter(ctx, currentConfig.value, getThinkingLevel);
  });
}
