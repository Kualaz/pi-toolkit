# pi-git-diff

Pi extension package that registers a `git_diff` tool for inspecting Git diffs with Pi theme colors.

The tool is intended as a themed replacement for asking Pi to run `git diff` through `bash`. It runs Git without ANSI colors and renders diff lines with Pi's diff theme tokens:

- `toolDiffAdded` for added lines
- `toolDiffRemoved` for removed lines
- `toolDiffContext` for context lines

## Install

This package has not been installed by this repo change.

To install it manually later:

```bash
pi install /Users/kuala/Documents/Projects/OpenSource/pi-toolkit/pi-git-diff
```

Then restart Pi or run:

```text
/reload
```

For a one-off test without installing:

```bash
pi -e /Users/kuala/Documents/Projects/OpenSource/pi-toolkit/pi-git-diff
```

## Tool

```text
git_diff
```

Parameters:

```json
{
  "staged": false,
  "path": "optional/file-or-pathspec",
  "context": 3
}
```

Examples prompts:

```text
Show me the git diff.
Show me the staged git diff.
Show me the diff for @src/index.ts with 5 context lines.
```

The extension's prompt guidelines tell the model to prefer `git_diff` over `bash` for diff inspection so additions/deletions render with the configured Pi diff colors.
