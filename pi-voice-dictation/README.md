# pi-voice-dictation

Pi extension that adds Codex-style voice dictation to the editor.

- Press `Cmd+Z` to start recording.
- Press `Cmd+Z` again to stop, transcribe, and paste the transcript into the input editor.
- Use `/voice` if your terminal does not forward Command-key shortcuts.

In Pi keybinding terms, macOS `Cmd` is `super`, so the default shortcut is `super+z`.

## Usage

```text
/voice              Toggle recording
/voice start        Start dictating
/voice stop         Stop, transcribe, and paste into the editor
/voice cancel       Stop and discard the recording
/voice status       Show status
/voice help         Show help
```

## Install locally

From this repository, install into project-local Pi settings:

```bash
pi install ./pi-voice-dictation -l
```

For global settings, use an absolute path:

```bash
pi install "$(pwd)/pi-voice-dictation"
```

Or try it once without installing:

```bash
pi -e ./pi-voice-dictation
```

## Shortcut

Default shortcut: `Cmd+Z` (`super+z`).

Configure it in `~/.pi/agent/keybindings.json`:

```json
{
  "pi-voice-dictation.toggle": "super+z"
}
```

Aliases `cmd+z`, `command+z`, `meta+z`, and `⌘+z` are normalized to `super+z`.

Multiple shortcuts and disabling are also supported:

```json
{
  "pi-voice-dictation.toggle": ["super+z", "f8"]
}
```

```json
{
  "pi-voice-dictation.toggle": []
}
```

Run `/reload` after editing keybindings.

> Note: `Cmd+Z` is often Undo. If you rely on Undo in your terminal editor, bind this extension to another key.

## Transcription

Recording currently uses the bundled macOS Swift helper. On first use, it compiles the helper with `swiftc`, so Xcode Command Line Tools must be installed.

Transcriber selection is controlled by `PI_VOICE_TRANSCRIBER`:

- `auto` (default): use OpenAI when `OPENAI_API_KEY` is set, otherwise Apple Speech on macOS
- `openai`: force OpenAI Audio Transcriptions
- `apple`: force Apple Speech

Useful environment variables:

```bash
export OPENAI_API_KEY=...
export PI_VOICE_OPENAI_MODEL=gpt-4o-mini-transcribe
export PI_VOICE_LANGUAGE=en       # OpenAI ISO language hint
export PI_VOICE_LOCALE=en-US      # Apple Speech locale
```

macOS will prompt for Microphone and Speech Recognition permissions the first time it records/transcribes.
