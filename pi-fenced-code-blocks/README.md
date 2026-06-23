# pi-fenced-code-blocks

Pi extension package that restyles markdown fenced code blocks in the TUI:

- hides rendered triple-backtick fence markers
- adds a configurable background color for the whole block line
- adds a configurable foreground color for the symbol/language header
- replaces the opening fence with a compact language header like `≡ text` or `Go go`
- lets you configure per-language symbols/glyphs

This works by patching Pi's bundled markdown renderer at runtime. It affects normal markdown-rendered Pi messages, including assistant/user markdown content.

## Install

```bash
pi install /Users/kuala/Documents/Projects/OpenSource/pi-toolkit/pi-fenced-code-blocks
```

Then restart Pi or run:

```text
/reload
```

## Commands

```text
/code-blocks status
/code-blocks bg #303030
/code-blocks fg #d0d0d0
/code-blocks fg theme
/code-blocks enable
/code-blocks disable
/code-blocks header on
/code-blocks header off
/code-blocks fences hide
/code-blocks fences show
/code-blocks symbol <language> <symbol>
/code-blocks template <template with {symbol}, {lang}, {rawLang}>
/code-blocks label <default-language-label>
/code-blocks reset
```

Examples:

```text
/code-blocks bg #242424
/code-blocks fg #d0d0d0
/code-blocks symbol go 
/code-blocks symbol text ≡
/code-blocks template {symbol} {lang}
```

Alias:

```text
/fenced-code-blocks status
```

## Settings file

The extension stores settings in the active Pi agent directory:

```text
$PI_CODING_AGENT_DIR/fenced-code-blocks/settings.json
```

If `PI_CODING_AGENT_DIR` is not set, it falls back to:

```text
~/.pi/agent/fenced-code-blocks/settings.json
```

Example:

```json
{
  "enabled": true,
  "backgroundColor": "#2b2b2b",
  "headerForegroundColor": null,
  "showLanguageHeader": true,
  "hideFenceMarkers": true,
  "defaultLanguageLabel": "text",
  "defaultSymbol": "▣",
  "headerTemplate": "{symbol} {lang}",
  "languageSymbols": {
    "text": "≡",
    "go": "Go",
    "typescript": "TS",
    "javascript": "JS",
    "json": "{}",
    "bash": "$",
    "python": "Py",
    "diff": "±"
  }
}
```

`backgroundColor` and `headerForegroundColor` accept `#rgb` or `#rrggbb`.
Set `headerForegroundColor` to `null` or run `/code-blocks fg theme` to use Pi's theme color.

## Notes

- Symbols can be plain text (`Go`, `TS`) or Nerd Font glyphs (``) if your terminal font supports them.
- The patch is intentionally small and runtime-only; if Pi changes its markdown renderer internals, this extension may need a small update.
