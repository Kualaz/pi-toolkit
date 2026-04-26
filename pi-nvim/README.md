# pi-nvim-local

Local Pi package that exposes a Unix socket so Neovim can send prompts, file paths, visual selections, and buffer context into the active Pi session.

This follows the same socket/manifest style as [`carderne/pi-nvim`](https://github.com/carderne/pi-nvim):

- Pi starts a JSONL socket under `/tmp/pi-nvim-sockets/` on `session_start`.
- Pi writes a sibling `*.info` manifest with cwd, pid, session file, and capabilities.
- Neovim discovers sessions by scanning those manifests, preferring a cwd match.
- `/tmp/pi-nvim-latest.sock` points at the most recently started bridge.

## Protocol

Send newline-delimited JSON to the socket:

```json
{"type":"ping"}
{"type":"status"}
{"type":"prompt","message":"look at this"}
{"type":"prompt","message":"queue this if busy","deliverAs":"followUp"}
{"type":"steer","message":"adjust course now"}
{"type":"follow_up","message":"do this after the current task"}
{"type":"subscribe","events":["file.changed"]}
```

Responses and events are newline-delimited JSON:

```json
{"ok":true,"type":"pong"}
{"ok":true,"type":"accepted","delivery":"immediate"}
{"ok":true,"type":"accepted","delivery":"followUp"}
{"ok":true,"type":"subscribed","events":["file.changed"]}
{"type":"event","event":"file.changed","path":"/abs/path/file.lua","originalPath":"file.lua","tool":"edit"}
{"ok":false,"error":"..."}
```

When Pi is busy, plain `prompt` messages default to `followUp` delivery unless `deliverAs`/`delivery`/`streamingBehavior` is set to `steer` or `followUp`.

Neovim keeps a subscription socket open for `file.changed` events. The Pi extension emits those events after successful built-in `edit` and `write` tool results; the Neovim plugin responds with `:checktime` so open buffers notice disk changes. Shell commands are intentionally not reported.

## Pi setup

Add this package to `~/.pi/agent/settings.json` or run Pi with `-e`:

```json
{
  "packages": [
    "../../Documents/Projects/OpenSource/pi-toolkit/pi-nvim"
  ]
}
```

Reload Pi after adding it:

```text
/reload
```

Use `/pi-nvim` or `/pi-nvim-info` in Pi to show the active socket path.

## Neovim setup

The Neovim client implementation lives in the public repo:

```text
https://github.com/Kualaz/pi-nvim
```

Example lazy.nvim spec:

```lua
return {
  "Kualaz/pi-nvim",
  name = "pi-nvim",
  lazy = false,
  config = function()
    require("pi").setup()
  end,
}
```

The client intentionally keeps the Neovim command surface small. It registers only:

- `:Pi` — open the Ask Pi dialog.
- `:PiSendAll` — open Ask Pi with `@buffer ` prefilled.
- `:PiSessions` — open the session picker UI and switch the active Pi socket.

The Ask Pi dialog supports opencode-style context placeholders:

- `<leader>aa` opens the dialog with `@this ` prefilled; `:Pi` opens it blank.
- `<leader>ab` / `:PiSendAll` opens the dialog with `@buffer ` prefilled.
- Typing `@` opens a native insert-completion dropdown in place. Current targets are `@this`, `@buffer`, and `@diagnostics`; cancelling leaves the literal `@`.
- Placeholder tokens are removed from the typed prompt before sending.
- Rendered context is appended under a `Context:` heading, so trailing prompt text does not corrupt markdown fences.

Context target behavior:

| Target | Behavior |
| --- | --- |
| `@this` in normal mode | `path/from/cwd.ext:L42` |
| `@this` in visual mode | selected text in a fenced code block, followed by `path/from/cwd.ext:L42-L50` |
| `@this` in file mode | `path/from/cwd.ext` |
| `@buffer` | whole buffer in a fenced code block, followed by `path/from/cwd.ext` |
| `@diagnostics` | current buffer diagnostics grouped as line references |

If the prompt does not include a context placeholder, it is sent as typed.

Default local keymaps:

| Key | Action |
| --- | --- |
| `<leader>aa` | Ask Pi (`@this` = current line/selection) |
| `<leader>ab` | Ask Pi with `@buffer` prefilled |
| `<leader>ap` | Pick active Pi session |
