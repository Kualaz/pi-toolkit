export type CodeBlockConfig = {
  enabled: boolean;
  /** Hex color (#rgb or #rrggbb) used for fenced code block backgrounds. */
  backgroundColor: string;
  /** Hex foreground color (#rgb or #rrggbb) for the symbol/language header, or null to use the Pi theme. */
  headerForegroundColor: string | null;
  /** Replace the opening fence with a compact language header. */
  showLanguageHeader: boolean;
  /** Remove the rendered ``` fence marker lines. */
  hideFenceMarkers: boolean;
  /** Label used when a fenced block has no language info string. */
  defaultLanguageLabel: string;
  /** Symbol used when no language-specific symbol is configured. */
  defaultSymbol: string;
  /** Header template. Supports {symbol}, {lang}, and {rawLang}. */
  headerTemplate: string;
  /** Case-insensitive language -> symbol map. Values can be any terminal-safe string/glyph. */
  languageSymbols: Record<string, string>;
};

export const DEFAULT_LANGUAGE_SYMBOLS: Record<string, string> = {
  text: "≡",
  txt: "≡",
  plaintext: "≡",
  plain: "≡",
  markdown: "▦",
  md: "▦",
  go: "Go",
  golang: "Go",
  javascript: "JS",
  js: "JS",
  jsx: "JS",
  typescript: "TS",
  ts: "TS",
  tsx: "TS",
  json: "{}",
  jsonc: "{}",
  yaml: "◇",
  yml: "◇",
  toml: "◇",
  bash: "$",
  sh: "$",
  shell: "$",
  zsh: "$",
  fish: "$",
  powershell: ">_",
  ps1: ">_",
  python: "Py",
  py: "Py",
  ruby: "Rb",
  rb: "Rb",
  rust: "Rs",
  rs: "Rs",
  java: "Jv",
  kotlin: "Kt",
  kt: "Kt",
  swift: "Sw",
  c: "C",
  cpp: "C++",
  cxx: "C++",
  cc: "C++",
  csharp: "C#",
  cs: "C#",
  html: "<>",
  htm: "<>",
  xml: "<>",
  css: "#",
  scss: "#",
  sass: "#",
  sql: "▤",
  diff: "±",
  patch: "±",
  dockerfile: "▣",
  makefile: "▣",
};

export const DEFAULT_CONFIG: CodeBlockConfig = {
  enabled: true,
  backgroundColor: "#2b2b2b",
  headerForegroundColor: null,
  showLanguageHeader: true,
  hideFenceMarkers: true,
  defaultLanguageLabel: "text",
  defaultSymbol: "▣",
  headerTemplate: "{symbol} {lang}",
  languageSymbols: DEFAULT_LANGUAGE_SYMBOLS,
};

export function normalizeLanguage(language: string): string {
  return language.trim().toLowerCase();
}

export function normalizeConfig(value: Partial<CodeBlockConfig> | undefined): CodeBlockConfig {
  const input = value && typeof value === "object" ? value : {};
  const languageSymbols =
    input.languageSymbols && typeof input.languageSymbols === "object" && !Array.isArray(input.languageSymbols)
      ? Object.fromEntries(
          Object.entries(input.languageSymbols)
            .filter(([key, symbol]) => typeof key === "string" && typeof symbol === "string")
            .map(([key, symbol]) => [normalizeLanguage(key), symbol]),
        )
      : {};

  return {
    ...DEFAULT_CONFIG,
    ...input,
    enabled: typeof input.enabled === "boolean" ? input.enabled : DEFAULT_CONFIG.enabled,
    backgroundColor: typeof input.backgroundColor === "string" ? input.backgroundColor : DEFAULT_CONFIG.backgroundColor,
    headerForegroundColor:
      typeof input.headerForegroundColor === "string" || input.headerForegroundColor === null
        ? input.headerForegroundColor
        : DEFAULT_CONFIG.headerForegroundColor,
    showLanguageHeader:
      typeof input.showLanguageHeader === "boolean" ? input.showLanguageHeader : DEFAULT_CONFIG.showLanguageHeader,
    hideFenceMarkers: typeof input.hideFenceMarkers === "boolean" ? input.hideFenceMarkers : DEFAULT_CONFIG.hideFenceMarkers,
    defaultLanguageLabel:
      typeof input.defaultLanguageLabel === "string" ? input.defaultLanguageLabel : DEFAULT_CONFIG.defaultLanguageLabel,
    defaultSymbol: typeof input.defaultSymbol === "string" ? input.defaultSymbol : DEFAULT_CONFIG.defaultSymbol,
    headerTemplate: typeof input.headerTemplate === "string" ? input.headerTemplate : DEFAULT_CONFIG.headerTemplate,
    languageSymbols: {
      ...DEFAULT_LANGUAGE_SYMBOLS,
      ...languageSymbols,
    },
  };
}
