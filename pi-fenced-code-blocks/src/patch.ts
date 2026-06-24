import { Markdown, truncateToWidth, visibleWidth, type MarkdownTheme } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG, normalizeLanguage, type CodeBlockConfig } from "./types.js";

type MarkdownInstance = {
  theme?: MarkdownTheme;
};

type FenceLine = {
  prefix: string;
  lang: string;
  rawInfo: string;
};

type PatchState = {
  installed: boolean;
  originalRender?: (this: MarkdownInstance, width: number) => string[];
  config: CodeBlockConfig;
};

const PATCH_STATE_KEY = Symbol.for("pi-fenced-code-blocks.markdown-patch");
const CSI_OR_OSC_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|_[^\x07\x1b]*(?:\x07|\x1b\\))/g;

function getPatchState(config: CodeBlockConfig): PatchState {
  const globalState = globalThis as any;
  if (!globalState[PATCH_STATE_KEY]) {
    globalState[PATCH_STATE_KEY] = {
      installed: false,
      config,
    } satisfies PatchState;
  }
  globalState[PATCH_STATE_KEY].config = config;
  return globalState[PATCH_STATE_KEY] as PatchState;
}

function stripAnsi(text: string): string {
  return text.replace(CSI_OR_OSC_PATTERN, "");
}

function parseFenceLine(line: string): FenceLine | undefined {
  const stripped = stripAnsi(line).trimEnd();
  const match = stripped.match(/^(\s*(?:(?:[-*+]|\d+\.)\s+)?)```(.*)$/);
  if (!match) return undefined;

  const rawInfo = (match[2] ?? "").trim();
  // A rendered fence marker should only have markdown info-string text after it.
  // If another backtick appears, treat it as normal code/prose.
  if (rawInfo.includes("`")) return undefined;

  return {
    prefix: match[1] ?? "",
    lang: rawInfo.split(/\s+/, 1)[0] ?? "",
    rawInfo,
  };
}

function parseHexColor(value: string): [number, number, number] | undefined {
  const trimmed = value.trim();
  const short = trimmed.match(/^#?([0-9a-fA-F]{3})$/);
  if (short) {
    const [r, g, b] = short[1]!.split("").map((part) => parseInt(part + part, 16));
    return [r!, g!, b!];
  }

  const long = trimmed.match(/^#?([0-9a-fA-F]{6})$/);
  if (long) {
    const hex = long[1]!;
    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
  }

  return undefined;
}

function makeBackgroundPrefix(config: CodeBlockConfig): string {
  const rgb = parseHexColor(config.backgroundColor) ?? parseHexColor(DEFAULT_CONFIG.backgroundColor)!;
  return `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
}

function makeForegroundPrefix(color: string | null): string | undefined {
  if (!color) return undefined;
  const rgb = parseHexColor(color);
  if (!rgb) return undefined;
  return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
}

function padToWidth(line: string, width: number): string {
  const clipped = visibleWidth(line) > width ? truncateToWidth(line, width, "") : line;
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function applyBlockBackground(line: string, width: number, bgPrefix: string): string {
  // Do not emit \x1b[49m here. Pi's TUI resets every rendered line, and avoiding
  // an inner background reset preserves nested Box backgrounds until this block
  // intentionally covers the full line. If syntax highlighting emits a full reset,
  // immediately re-apply the code-block background for the rest of the line.
  const padded = padToWidth(line, width);
  return bgPrefix + padded.replace(/\x1b\[(?:0)?m|\x1b\[49m/g, (reset) => reset + bgPrefix);
}

function getLanguageLabel(rawLang: string, config: CodeBlockConfig): string {
  const lang = rawLang.trim();
  return lang.length > 0 ? lang : config.defaultLanguageLabel;
}

function getLanguageSymbol(rawLang: string, config: CodeBlockConfig): string {
  const lang = normalizeLanguage(rawLang || config.defaultLanguageLabel);
  return config.languageSymbols[lang] ?? config.defaultSymbol;
}

function buildHeaderLine(fence: FenceLine, width: number, config: CodeBlockConfig, markdownTheme?: MarkdownTheme): string {
  const lang = getLanguageLabel(fence.lang, config);
  const symbol = getLanguageSymbol(fence.lang, config);
  const rawLabel = config.headerTemplate
    .replaceAll("{symbol}", symbol)
    .replaceAll("{lang}", lang)
    .replaceAll("{rawLang}", fence.rawInfo);
  const headerForegroundPrefix = makeForegroundPrefix(config.headerForegroundColor);
  const styledLabel = headerForegroundPrefix
    ? `${headerForegroundPrefix}${rawLabel}\x1b[39m`
    : markdownTheme?.codeBlockBorder
      ? markdownTheme.codeBlockBorder(rawLabel)
      : rawLabel;
  return padToWidth(`${fence.prefix}${styledLabel}`, width);
}

export function transformRenderedMarkdownLines(
  lines: string[],
  width: number,
  config: CodeBlockConfig,
  markdownTheme?: MarkdownTheme,
): string[] {
  if (!config.enabled || lines.length === 0) return lines;

  const bgPrefix = makeBackgroundPrefix(config);
  const rendered: string[] = [];
  let inCodeBlock = false;
  let openingPrefixWidth = 0;

  for (const line of lines) {
    const fence = parseFenceLine(line);

    if (fence && !inCodeBlock) {
      inCodeBlock = true;
      openingPrefixWidth = visibleWidth(fence.prefix);

      if (config.showLanguageHeader) {
        rendered.push(applyBlockBackground(buildHeaderLine(fence, width, config, markdownTheme), width, bgPrefix));
      } else if (!config.hideFenceMarkers) {
        rendered.push(applyBlockBackground(line, width, bgPrefix));
      }
      continue;
    }

    if (fence && inCodeBlock && fence.lang === "" && visibleWidth(fence.prefix) <= openingPrefixWidth) {
      inCodeBlock = false;
      if (!config.hideFenceMarkers) {
        rendered.push(applyBlockBackground(line, width, bgPrefix));
      }
      continue;
    }

    rendered.push(inCodeBlock ? applyBlockBackground(line, width, bgPrefix) : line);
  }

  return rendered;
}

export function installMarkdownPatch(config: CodeBlockConfig): void {
  const state = getPatchState(config);
  if (state.installed) return;

  state.originalRender = Markdown.prototype.render as (this: MarkdownInstance, width: number) => string[];

  Markdown.prototype.render = function patchedMarkdownRender(this: MarkdownInstance, width: number): string[] {
    const activeState = getPatchState(state.config);
    const original = activeState.originalRender;
    if (!original) return [];

    const lines = original.call(this, width);
    return transformRenderedMarkdownLines(lines, width, activeState.config, this.theme);
  } as typeof Markdown.prototype.render;

  state.installed = true;
}

export function updateMarkdownPatchConfig(config: CodeBlockConfig): void {
  getPatchState(config).config = config;
}

export function uninstallMarkdownPatch(): void {
  const globalState = globalThis as any;
  const state = globalState[PATCH_STATE_KEY] as PatchState | undefined;
  if (!state?.installed || !state.originalRender) return;

  Markdown.prototype.render = state.originalRender as typeof Markdown.prototype.render;
  state.installed = false;
  state.originalRender = undefined;
  delete globalState[PATCH_STATE_KEY];
}

export function isHexColor(value: string): boolean {
  return parseHexColor(value) !== undefined;
}
