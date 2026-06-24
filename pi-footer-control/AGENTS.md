# pi-footer-control notes

This package is a Pi extension package. Pi loads `index.ts` via the package manifest.

- Settings are stored at `$PI_CODING_AGENT_DIR/footer/settings.json` with fallback to `~/.pi/agent/footer/settings.json`.
- `/footer` opens a `SettingsList` UI where every footer field cycles through `disabled`, `left`, and `right`.
- The extension replaces the built-in footer via `ctx.ui.setFooter()`.
- Keep footer lines width-safe with `truncateToWidth()` and `visibleWidth()` from `@earendil-works/pi-tui`.
