# pi-footer-control

Pi extension package that replaces Pi's built-in footer with a configurable footer.

Each built-in footer field can be placed on the left, placed on the right, or hidden.

## Install

```bash
pi install /Users/kuala/Documents/Projects/OpenSource/pi-toolkit/pi-footer-control
```

Then restart Pi or run:

```text
/reload
```

## Commands

```text
/footer                 Open the footer settings UI
/footer settings        Open the footer settings UI
/footer status          Show the current field placement config
/footer reset           Restore defaults
/footer <field>         Show one field's placement
/footer <field> <value> Set one field to disabled, left, or right
```

Examples:

```text
/footer provider disabled
/footer model right
/footer extensionStatuses disabled
```

## Settings file

The extension stores settings in the active Pi agent directory:

```text
$PI_CODING_AGENT_DIR/footer/settings.json
```

If `PI_CODING_AGENT_DIR` is not set, it falls back to:

```text
~/.pi/agent/footer/settings.json
```

Example:

```json
{
  "fields": {
    "cwd": "left",
    "gitBranch": "left",
    "sessionName": "left",
    "inputTokens": "left",
    "outputTokens": "left",
    "cacheReadTokens": "left",
    "cacheWriteTokens": "left",
    "cost": "left",
    "contextUsage": "left",
    "provider": "right",
    "model": "right",
    "thinking": "right",
    "extensionStatuses": "left"
  }
}
```

## Fields

- `cwd`
- `gitBranch`
- `sessionName`
- `inputTokens`
- `outputTokens`
- `cacheReadTokens`
- `cacheWriteTokens`
- `cost`
- `contextUsage`
- `provider`
- `model`
- `thinking`
- `extensionStatuses`
