# pi-tool-toggle

Pi extension that toggles the `edit`, `write`, and `bash` tools on/off as a group.

## Usage

```text
/tool-toggle              Toggle edit/write/bash on or off
/tool-toggle on           Re-enable edit/write/bash
/tool-toggle off          Disable edit/write/bash
/tool-toggle status       Show current state and shortcut
/tool-toggle help         Show command help
```

When disabled, the extension:

- removes `edit`, `write`, and `bash` from Pi's active tools
- blocks those tool calls as a safety net if they are attempted anyway
- shows a footer status indicator
- persists the toggle state in the current session branch

## Shortcut

Default shortcut: `ctrl+h`

The extension intentionally does **not** default to `ctrl+i`: many terminals send `Ctrl+I` as `Tab`, and Pi binds `Tab` to autocomplete/path completion.

Configure the shortcut in Pi's agent keybindings config:

```json
{
  "pi-tool-toggle.toggle": "ctrl+h"
}
```

You can also bind multiple shortcuts or disable the shortcut:

```json
{
  "pi-tool-toggle.toggle": ["ctrl+h", "f8"]
}
```

```json
{
  "pi-tool-toggle.toggle": []
}
```

After editing the file, run `/reload`.

Config path:

```text
~/.pi/agent/keybindings.json
```

or under `PI_CODING_AGENT_DIR` when that environment variable is set.

Note: Pi's built-in keybinding manager currently only knows built-in action IDs, so this extension reads its own `pi-tool-toggle.toggle` entry from the same agent config file during extension load.

## Install locally while developing

From this repository:

```bash
pi install -e ./pi-tool-toggle
/reload
```
