import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { FooterConfig, FooterFieldGroup, FooterFieldId } from "./types.js";
import { FIELD_DEFINITIONS } from "./types.js";

type Theme = ExtensionContext["ui"]["theme"];

type FooterData = {
  getGitBranch(): string | null;
  getExtensionStatuses(): ReadonlyMap<string, string>;
  getAvailableProviderCount(): number;
  onBranchChange(callback: () => void): () => void;
};

interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

interface RenderState {
  ctx: ExtensionContext;
  theme: Theme;
  footerData: FooterData;
  config: FooterConfig;
  totals: UsageTotals;
  autoCompactEnabled: boolean;
  thinkingLevel: string;
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function sanitizeStatusText(text: string): string {
  return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function dim(theme: Theme, text: string): string {
  return theme.fg("dim", text);
}

function getTotals(ctx: ExtensionContext): UsageTotals {
  const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const usage = entry.message.usage;
    if (!usage) continue;

    totals.input += usage.input ?? 0;
    totals.output += usage.output ?? 0;
    totals.cacheRead += usage.cacheRead ?? 0;
    totals.cacheWrite += usage.cacheWrite ?? 0;
    totals.cost += usage.cost?.total ?? 0;
  }

  return totals;
}

function readJson(path: string): any | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return undefined;
  }
}

export function isAutoCompactEnabled(cwd: string, projectTrusted = false): boolean {
  const globalSettings = readJson(join(getAgentDir(), "settings.json"));
  const projectSettings = projectTrusted ? readJson(join(cwd, CONFIG_DIR_NAME, "settings.json")) : undefined;

  let enabled = true;
  if (globalSettings?.compaction?.enabled !== undefined) {
    enabled = Boolean(globalSettings.compaction.enabled);
  }
  if (projectSettings?.compaction?.enabled !== undefined) {
    enabled = Boolean(projectSettings.compaction.enabled);
  }
  return enabled;
}

function getCwdDisplay(ctx: ExtensionContext): string {
  let cwd = ctx.sessionManager.getCwd();
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home && cwd.startsWith(home)) {
    cwd = `~${cwd.slice(home.length)}`;
  }
  return cwd;
}

function getFieldValue(id: FooterFieldId, state: RenderState): string | undefined {
  const { ctx, theme, footerData, totals } = state;

  switch (id) {
    case "cwd":
      return dim(theme, getCwdDisplay(ctx));

    case "gitBranch": {
      const branch = footerData.getGitBranch();
      return branch ? dim(theme, `(${branch})`) : undefined;
    }

    case "sessionName": {
      const sessionName = ctx.sessionManager.getSessionName();
      return sessionName ? dim(theme, `• ${sessionName}`) : undefined;
    }

    case "inputTokens":
      return totals.input ? dim(theme, `↑${formatTokens(totals.input)}`) : undefined;

    case "outputTokens":
      return totals.output ? dim(theme, `↓${formatTokens(totals.output)}`) : undefined;

    case "cacheReadTokens":
      return totals.cacheRead ? dim(theme, `R${formatTokens(totals.cacheRead)}`) : undefined;

    case "cacheWriteTokens":
      return totals.cacheWrite ? dim(theme, `W${formatTokens(totals.cacheWrite)}`) : undefined;

    case "cost": {
      const usingSubscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
      if (!totals.cost && !usingSubscription) return undefined;
      return dim(theme, `$${totals.cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
    }

    case "contextUsage": {
      const usage = ctx.getContextUsage();
      const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
      if (!contextWindow) return undefined;

      const percentValue = usage?.percent ?? 0;
      const percent = usage?.percent === null ? "?" : `${percentValue.toFixed(1)}%`;
      const auto = state.autoCompactEnabled ? " (auto)" : "";
      const text = `${percent}/${formatTokens(contextWindow)}${auto}`;

      if (percent !== "?" && percentValue > 90) return theme.fg("error", text);
      if (percent !== "?" && percentValue > 70) return theme.fg("warning", text);
      return dim(theme, text);
    }

    case "provider":
      return ctx.model?.provider ? dim(theme, `(${ctx.model.provider})`) : undefined;

    case "model":
      return ctx.model?.id ? dim(theme, ctx.model.id) : dim(theme, "no-model");

    case "thinking": {
      if (!ctx.model?.reasoning) return undefined;
      return state.thinkingLevel && state.thinkingLevel !== "off"
        ? dim(theme, `• ${state.thinkingLevel}`)
        : dim(theme, "• thinking off");
    }

    case "extensionStatuses": {
      const statuses = Array.from(footerData.getExtensionStatuses().entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, text]) => sanitizeStatusText(text))
        .filter(Boolean);
      return statuses.length > 0 ? statuses.join(" ") : undefined;
    }
  }
}

function joinParts(parts: string[]): string {
  return parts.filter(Boolean).join(" ");
}

function alignLine(leftParts: string[], rightParts: string[], width: number, theme: Theme): string | undefined {
  const leftRaw = joinParts(leftParts);
  const rightRaw = joinParts(rightParts);
  if (!leftRaw && !rightRaw) return undefined;

  const ellipsis = dim(theme, "...");

  if (!rightRaw) {
    return truncateToWidth(leftRaw, width, ellipsis);
  }

  if (!leftRaw) {
    const right = truncateToWidth(rightRaw, width, "");
    const pad = " ".repeat(Math.max(0, width - visibleWidth(right)));
    return pad + right;
  }

  const leftWidth = visibleWidth(leftRaw);
  const rightWidth = visibleWidth(rightRaw);
  const minPadding = 2;

  if (leftWidth + minPadding + rightWidth <= width) {
    return leftRaw + " ".repeat(width - leftWidth - rightWidth) + rightRaw;
  }

  const available = Math.max(0, width - minPadding);
  let leftBudget = Math.ceil(available / 2);
  let rightBudget = Math.floor(available / 2);

  if (leftWidth <= leftBudget) {
    rightBudget += leftBudget - leftWidth;
    leftBudget = leftWidth;
  } else if (rightWidth <= rightBudget) {
    leftBudget += rightBudget - rightWidth;
    rightBudget = rightWidth;
  }

  const left = leftBudget > 0 ? truncateToWidth(leftRaw, leftBudget, ellipsis) : "";
  const right = rightBudget > 0 ? truncateToWidth(rightRaw, rightBudget, "") : "";
  const padding = " ".repeat(Math.max(minPadding, width - visibleWidth(left) - visibleWidth(right)));
  return truncateToWidth(left + padding + right, width, "");
}

function renderGroup(group: FooterFieldGroup, state: RenderState, width: number): string | undefined {
  const left: string[] = [];
  const right: string[] = [];

  for (const field of FIELD_DEFINITIONS) {
    if (field.group !== group) continue;

    const placement = state.config.fields[field.id];
    if (placement === "disabled") continue;

    const value = getFieldValue(field.id, state);
    if (!value) continue;

    if (placement === "left") left.push(value);
    if (placement === "right") right.push(value);
  }

  return alignLine(left, right, width, state.theme);
}

export function renderFooter(
  width: number,
  ctx: ExtensionContext,
  theme: Theme,
  footerData: FooterData,
  config: FooterConfig,
  getThinkingLevel: () => string,
  autoCompactEnabled = isAutoCompactEnabled(ctx.cwd, ctx.isProjectTrusted()),
): string[] {
  const state: RenderState = {
    ctx,
    theme,
    footerData,
    config,
    totals: getTotals(ctx),
    autoCompactEnabled,
    thinkingLevel: getThinkingLevel(),
  };

  const lines = [
    renderGroup("location", state, width),
    renderGroup("metrics", state, width),
    renderGroup("statuses", state, width),
  ].filter((line): line is string => Boolean(line));

  return lines;
}
