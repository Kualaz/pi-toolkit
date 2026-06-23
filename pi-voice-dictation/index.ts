import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import type { KeyId } from "@mariozechner/pi-tui";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const DEFAULT_SHORTCUT = "super+z" as const;
const KEYBINDING_ID = "pi-voice-dictation.toggle";
const KEYBINDINGS_PATH = join(getAgentDir(), "keybindings.json");
const STATUS_KEY = "voice-dictation";
const MAX_CAPTURED_STDERR = 8_000;
const RECORD_READY_TIMEOUT_MS = 20_000;
const RECORD_STOP_TIMEOUT_MS = 15_000;
const APPLE_TRANSCRIPTION_TIMEOUT_MS = 120_000;

const execFileAsync = promisify(execFile);

type TranscriberMode = "auto" | "openai" | "apple";

interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

interface RecordingState {
  child: ChildProcessWithoutNullStreams;
  audioPath: string;
  startedAt: number;
  stderr: string;
  ready: Promise<void>;
  exit: Promise<ExitInfo>;
  stopping: boolean;
  readyResolved: boolean;
}

function normalizeShortcut(value: unknown): KeyId | undefined {
  if (typeof value !== "string") return undefined;

  const shortcut = value
    .trim()
    .toLowerCase()
    .replace(/⌘/g, "cmd")
    .split("+")
    .map((part) => {
      const normalized = part.trim();
      if (["cmd", "command", "meta"].includes(normalized)) return "super";
      return normalized;
    })
    .filter(Boolean)
    .join("+");

  return shortcut ? (shortcut as KeyId) : undefined;
}

function uniqueShortcuts(shortcuts: KeyId[]): KeyId[] {
  const seen = new Set<string>();
  const unique: KeyId[] = [];

  for (const shortcut of shortcuts) {
    if (seen.has(shortcut)) continue;
    seen.add(shortcut);
    unique.push(shortcut);
  }

  return unique;
}

function normalizeShortcutConfig(value: unknown): KeyId[] | undefined {
  if (value === undefined) return undefined;

  if (Array.isArray(value)) {
    if (value.length === 0) return [];
    const shortcuts = uniqueShortcuts(value.map(normalizeShortcut).filter((shortcut): shortcut is KeyId => shortcut !== undefined));
    return shortcuts.length > 0 ? shortcuts : undefined;
  }

  const shortcut = normalizeShortcut(value);
  return shortcut ? [shortcut] : undefined;
}

async function loadConfiguredShortcuts(): Promise<KeyId[]> {
  try {
    const raw = await fs.readFile(KEYBINDINGS_PATH, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return normalizeShortcutConfig(parsed[KEYBINDING_ID]) ?? [DEFAULT_SHORTCUT];
  } catch {
    return [DEFAULT_SHORTCUT];
  }
}

function displayShortcut(shortcut: string): string {
  return shortcut
    .split("+")
    .map((part) => {
      if (part === "super") return "Cmd";
      if (part === "ctrl") return "Ctrl";
      if (part === "alt") return "Alt";
      if (part === "shift") return "Shift";
      return part.length === 1 ? part.toUpperCase() : part;
    })
    .join("+");
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function appendLimited(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length > MAX_CAPTURED_STDERR ? next.slice(-MAX_CAPTURED_STDERR) : next;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

function getTranscriberMode(): TranscriberMode {
  const raw = (process.env.PI_VOICE_TRANSCRIBER ?? "auto").trim().toLowerCase();
  if (["auto", "openai", "apple"].includes(raw)) return raw as TranscriberMode;
  return "auto";
}

function getOpenAIApiKey(): string | undefined {
  return process.env.PI_VOICE_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
}

function infoPlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>works.earendil.pi.voice-dictation</string>
  <key>CFBundleName</key>
  <string>Pi Voice Dictation</string>
  <key>NSMicrophoneUsageDescription</key>
  <string>Pi voice dictation records microphone audio so it can transcribe your prompt.</string>
  <key>NSSpeechRecognitionUsageDescription</key>
  <string>Pi voice dictation uses speech recognition to transcribe your recorded prompt.</string>
</dict>
</plist>
`;
}

let macHelperPromise: Promise<string> | undefined;

async function getMacHelperBinary(): Promise<string> {
  if (process.platform !== "darwin") {
    throw new Error("Voice recording with the bundled helper is currently macOS-only.");
  }

  macHelperPromise ??= buildMacHelperBinary();
  try {
    return await macHelperPromise;
  } catch (error) {
    macHelperPromise = undefined;
    throw error;
  }
}

async function buildMacHelperBinary(): Promise<string> {
  const sourcePath = fileURLToPath(new URL("./src/mac-voice-helper.swift", import.meta.url));
  const source = await fs.readFile(sourcePath);
  const plist = infoPlist();
  const hash = createHash("sha256").update(source).update(plist).digest("hex").slice(0, 16);
  const cacheDir = join(tmpdir(), "pi-voice-dictation");
  const binaryPath = join(cacheDir, `mac-voice-helper-${hash}`);
  const plistPath = join(cacheDir, `mac-voice-helper-${hash}.plist`);

  try {
    await fs.access(binaryPath);
    return binaryPath;
  } catch {
    // Build below.
  }

  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(plistPath, plist, "utf8");

  try {
    await execFileAsync(
      "swiftc",
      [
        sourcePath,
        "-o",
        binaryPath,
        "-Xlinker",
        "-sectcreate",
        "-Xlinker",
        "__TEXT",
        "-Xlinker",
        "__info_plist",
        "-Xlinker",
        plistPath,
      ],
      { encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024 },
    );
  } catch (error) {
    throw new Error(
      `Failed to build the macOS voice helper with swiftc. Install Xcode Command Line Tools, then try again.\n${errorMessage(error)}`,
    );
  }

  await fs.chmod(binaryPath, 0o755);
  return binaryPath;
}

async function transcribeWithAppleSpeech(audioPath: string): Promise<string> {
  const helper = await getMacHelperBinary();
  const args = ["transcribe", audioPath];
  const locale = process.env.PI_VOICE_LOCALE?.trim();
  if (locale) args.push(locale);

  const { stdout } = await execFileAsync(helper, args, {
    encoding: "utf8",
    timeout: APPLE_TRANSCRIPTION_TIMEOUT_MS + 10_000,
    maxBuffer: 1024 * 1024,
  });

  return String(stdout).trim();
}

async function transcribeWithOpenAI(audioPath: string): Promise<string> {
  const apiKey = getOpenAIApiKey();
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set.");

  const fetchFn = globalThis.fetch;
  const FormDataCtor = globalThis.FormData;
  const BlobCtor = globalThis.Blob;
  if (!fetchFn || !FormDataCtor || !BlobCtor) {
    throw new Error("This Node.js runtime does not provide fetch/FormData/Blob, which are required for OpenAI transcription.");
  }

  const audio = await fs.readFile(audioPath);
  const form = new FormDataCtor();
  form.append("model", process.env.PI_VOICE_OPENAI_MODEL ?? "gpt-4o-mini-transcribe");
  form.append("response_format", "json");

  const language = process.env.PI_VOICE_LANGUAGE?.trim();
  if (language) form.append("language", language);

  const prompt = process.env.PI_VOICE_PROMPT?.trim();
  if (prompt) form.append("prompt", prompt);

  form.append("file", new BlobCtor([audio], { type: "audio/mp4" }), "dictation.m4a");

  const baseUrl = (process.env.PI_VOICE_OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
  const organization = process.env.OPENAI_ORGANIZATION || process.env.OPENAI_ORG_ID;
  const project = process.env.OPENAI_PROJECT;
  if (organization) headers["OpenAI-Organization"] = organization;
  if (project) headers["OpenAI-Project"] = project;

  const response = await fetchFn(`${baseUrl}/audio/transcriptions`, {
    method: "POST",
    headers,
    body: form,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`OpenAI transcription failed (${response.status} ${response.statusText}): ${body.trim()}`);
  }

  const payload = (await response.json()) as { text?: unknown };
  if (typeof payload.text !== "string") {
    throw new Error("OpenAI transcription response did not include a text field.");
  }

  return payload.text.trim();
}

async function transcribeAudio(audioPath: string): Promise<{ text: string; engine: string }> {
  const mode = getTranscriberMode();

  if (mode === "openai") {
    return { text: await transcribeWithOpenAI(audioPath), engine: "OpenAI" };
  }

  if (mode === "apple") {
    return { text: await transcribeWithAppleSpeech(audioPath), engine: "Apple Speech" };
  }

  const openAIKey = getOpenAIApiKey();
  let openAIError: unknown;

  if (openAIKey) {
    try {
      return { text: await transcribeWithOpenAI(audioPath), engine: "OpenAI" };
    } catch (error) {
      openAIError = error;
    }
  }

  if (process.platform === "darwin") {
    try {
      return { text: await transcribeWithAppleSpeech(audioPath), engine: "Apple Speech" };
    } catch (appleError) {
      if (openAIError) {
        throw new Error(`OpenAI transcription failed: ${errorMessage(openAIError)}\nApple Speech fallback failed: ${errorMessage(appleError)}`);
      }
      throw appleError;
    }
  }

  if (openAIError) throw openAIError;
  throw new Error("No voice transcriber is available. Set OPENAI_API_KEY, or use this extension on macOS for Apple Speech fallback.");
}

function createRecordingState(child: ChildProcessWithoutNullStreams, audioPath: string): RecordingState {
  let readyResolve: (() => void) | undefined;
  let readyReject: ((error: Error) => void) | undefined;

  const state: RecordingState = {
    child,
    audioPath,
    startedAt: Date.now(),
    stderr: "",
    ready: new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    }),
    exit: new Promise<ExitInfo>((resolve) => {
      child.once("error", (error) => resolve({ code: null, signal: null, error }));
      child.once("exit", (code, signal) => resolve({ code, signal }));
    }),
    stopping: false,
    readyResolved: false,
  };

  let stdoutBuffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.trim() === "READY" && !state.readyResolved) {
        state.readyResolved = true;
        readyResolve?.();
      }
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    state.stderr = appendLimited(state.stderr, chunk);
  });

  state.exit.then((exit) => {
    if (!state.readyResolved) {
      readyReject?.(exit.error ?? new Error(`Recorder exited before it was ready (${exitSummary(exit)}).`));
    }
  });

  return state;
}

function exitSummary(exit: ExitInfo): string {
  if (exit.error) return exit.error.message;
  if (exit.signal) return `signal ${exit.signal}`;
  return `exit code ${exit.code ?? "unknown"}`;
}

async function stopRecorderProcess(recording: RecordingState): Promise<void> {
  recording.stopping = true;

  try {
    recording.child.stdin.end();
  } catch {
    // Ignore close races.
  }

  let exit: ExitInfo;
  try {
    exit = await withTimeout(recording.exit, RECORD_STOP_TIMEOUT_MS, "Timed out while waiting for the voice recorder to stop.");
  } catch (error) {
    try {
      recording.child.kill("SIGKILL");
    } catch {
      // Ignore close races.
    }
    throw error;
  }

  if (exit.error) throw exit.error;
  if (exit.code !== 0) {
    const stderr = recording.stderr.trim();
    throw new Error(`Voice recorder failed (${exitSummary(exit)}).${stderr ? `\n${stderr}` : ""}`);
  }
}

async function removeAudioFile(audioPath: string): Promise<void> {
  try {
    await fs.unlink(audioPath);
  } catch {
    // Best-effort privacy cleanup.
  }
}

export default async function voiceDictationExtension(pi: ExtensionAPI): Promise<void> {
  const shortcuts = await loadConfiguredShortcuts();

  let recording: RecordingState | undefined;
  let starting = false;
  let statusTimer: ReturnType<typeof setInterval> | undefined;

  function shortcutSummary(): string {
    return shortcuts.length > 0 ? shortcuts.map(displayShortcut).join(", ") : "none";
  }

  function stopHint(): string {
    return shortcuts.length > 0 ? `${shortcutSummary()} to stop` : "/voice stop to stop";
  }

  function setStatus(ctx: ExtensionContext, text: string | undefined, color: "accent" | "warning" | "error" = "accent"): void {
    if (!ctx.hasUI) return;
    try {
      ctx.ui.setStatus(STATUS_KEY, text ? ctx.ui.theme.fg(color, text) : undefined);
    } catch {
      // Ignore stale UI during reload/shutdown races.
    }
  }

  function clearStatusTimer(): void {
    if (statusTimer) clearInterval(statusTimer);
    statusTimer = undefined;
  }

  function updateRecordingStatus(ctx: ExtensionContext): void {
    if (!recording) return;
    setStatus(ctx, `🎙 ${formatDuration(Date.now() - recording.startedAt)} Dictating — ${stopHint()}`, "warning");
  }

  function startStatusTimer(ctx: ExtensionContext): void {
    clearStatusTimer();
    updateRecordingStatus(ctx);
    statusTimer = setInterval(() => {
      if (!recording) {
        clearStatusTimer();
        return;
      }
      updateRecordingStatus(ctx);
    }, 1000);
  }

  function commandHelp(): string {
    return [
      "Voice dictation:",
      "  /voice              Toggle recording",
      "  /voice start        Start dictating",
      "  /voice stop         Stop, transcribe, and paste into the editor",
      "  /voice cancel       Stop and discard the recording",
      "  /voice status       Show recorder/transcriber status",
      "  /voice help         Show this help",
      "",
      `Shortcut: ${shortcutSummary()} (keybinding id: ${KEYBINDING_ID})`,
      `Config:   ${KEYBINDINGS_PATH}`,
    ].join("\n");
  }

  function statusText(): string {
    const mode = getTranscriberMode();
    const openAI = getOpenAIApiKey() ? "available" : "not configured";
    const apple = process.platform === "darwin" ? "available" : "macOS only";

    return [
      "Voice dictation status:",
      `  recorder:    ${recording ? `recording for ${formatDuration(Date.now() - recording.startedAt)}` : starting ? "starting" : "idle"}`,
      `  shortcut:    ${shortcutSummary()}`,
      `  keybinding:  ${KEYBINDING_ID}`,
      `  transcriber: ${mode}`,
      `  OpenAI:      ${openAI}`,
      `  Apple:       ${apple}`,
    ].join("\n");
  }

  async function startRecording(ctx: ExtensionContext): Promise<void> {
    if (recording) {
      ctx.ui.notify(`Already dictating. Use ${stopHint()}.`, "warning");
      return;
    }

    if (starting) {
      ctx.ui.notify("Voice dictation is already starting.", "warning");
      return;
    }

    if (process.platform !== "darwin") {
      ctx.ui.notify("Voice recording is currently supported on macOS only. OpenAI transcription can be used after recording support is added for this platform.", "error");
      return;
    }

    let current: RecordingState | undefined;
    starting = true;
    setStatus(ctx, "🎙 Preparing microphone…", "accent");

    try {
      const helper = await getMacHelperBinary();
      const audioPath = join(tmpdir(), "pi-voice-dictation", `${process.pid}-${Date.now()}.m4a`);
      await fs.mkdir(dirname(audioPath), { recursive: true });

      const child = spawn(helper, ["record", audioPath], { stdio: ["pipe", "pipe", "pipe"] });
      current = createRecordingState(child, audioPath);
      recording = current;

      current.exit.then((exit) => {
        if (recording !== current || current.stopping) return;
        recording = undefined;
        clearStatusTimer();
        setStatus(ctx, undefined);
        const stderr = current.stderr.trim();
        ctx.ui.notify(`Voice recorder stopped unexpectedly (${exitSummary(exit)}).${stderr ? `\n${stderr}` : ""}`, "error");
      });

      await withTimeout(current.ready, RECORD_READY_TIMEOUT_MS, "Timed out while waiting for the voice recorder to become ready.");

      if (recording !== current) return;
      startStatusTimer(ctx);
      ctx.ui.notify(`Dictating… use ${stopHint()}.`);
    } catch (error) {
      if (current && recording !== current) return;

      if (current && recording === current) {
        recording = undefined;
        current.stopping = true;
        try {
          current.child.kill("SIGTERM");
        } catch {
          // Ignore close races.
        }
        await removeAudioFile(current.audioPath);
      }

      clearStatusTimer();
      setStatus(ctx, undefined);
      const stderr = current?.stderr.trim();
      ctx.ui.notify(`Voice dictation could not start: ${errorMessage(error)}${stderr ? `\n${stderr}` : ""}`, "error");
    } finally {
      starting = false;
    }
  }

  async function stopRecording(ctx: ExtensionContext, discard = false): Promise<void> {
    const current = recording;
    if (!current) {
      ctx.ui.notify(starting ? "Voice dictation is still starting." : "Voice dictation is not recording.", "warning");
      return;
    }

    recording = undefined;
    clearStatusTimer();
    setStatus(ctx, discard ? "🎙 Cancelling…" : "🎙 Stopping…", "accent");

    try {
      if (discard) {
        current.stopping = true;
        try {
          current.child.kill("SIGTERM");
        } catch {
          // Ignore close races.
        }
        await withTimeout(current.exit, 5_000, "Timed out while cancelling the voice recorder.").catch(() => {
          try {
            current.child.kill("SIGKILL");
          } catch {
            // Ignore close races.
          }
        });
        await removeAudioFile(current.audioPath);
        setStatus(ctx, undefined);
        ctx.ui.notify("Voice dictation cancelled.");
        return;
      }

      await stopRecorderProcess(current);

      const stat = await fs.stat(current.audioPath);
      if (stat.size <= 0) throw new Error("Recorder produced an empty audio file.");

      setStatus(ctx, "🎙 Transcribing…", "accent");
      const { text, engine } = await transcribeAudio(current.audioPath);
      const transcript = text.trim();

      if (!transcript) {
        ctx.ui.notify(`No speech was recognized by ${engine}.`, "warning");
        return;
      }

      ctx.ui.pasteToEditor(transcript);
      ctx.ui.notify(`Inserted voice transcript (${engine}).`);
    } catch (error) {
      const stderr = current.stderr.trim();
      ctx.ui.notify(`Voice dictation failed: ${errorMessage(error)}${stderr ? `\n${stderr}` : ""}`, "error");
    } finally {
      await removeAudioFile(current.audioPath);
      setStatus(ctx, undefined);
    }
  }

  async function toggleRecording(ctx: ExtensionContext): Promise<void> {
    if (recording) {
      await stopRecording(ctx);
      return;
    }

    await startRecording(ctx);
  }

  async function handleCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const [command = "toggle"] = args.trim().length > 0 ? args.trim().split(/\s+/) : ["toggle"];
    const commandLower = command.toLowerCase();

    if (["help", "-h", "--help"].includes(commandLower)) {
      ctx.ui.notify(commandHelp());
      return;
    }

    if (commandLower === "status") {
      ctx.ui.notify(statusText());
      return;
    }

    if (["toggle", "dictate", "record"].includes(commandLower)) {
      await toggleRecording(ctx);
      return;
    }

    if (["start", "on"].includes(commandLower)) {
      await startRecording(ctx);
      return;
    }

    if (["stop", "off", "done", "finish"].includes(commandLower)) {
      await stopRecording(ctx);
      return;
    }

    if (["cancel", "discard", "abort"].includes(commandLower)) {
      await stopRecording(ctx, true);
      return;
    }

    ctx.ui.notify(`${commandHelp()}\n\nUnknown subcommand: ${command}`, "warning");
  }

  pi.registerCommand("voice", {
    description: "Toggle Codex-style voice dictation into the editor",
    getArgumentCompletions: (prefix: string) => {
      const tokens = prefix.trimStart().split(/\s+/);
      const first = tokens[0] ?? "";
      if (tokens.length <= 1 && !prefix.endsWith(" ")) {
        return ["start", "stop", "cancel", "status", "help"]
          .filter((value) => value.startsWith(first))
          .map((value) => ({ value, label: value }));
      }
      return null;
    },
    handler: handleCommand,
  });

  for (const shortcut of shortcuts) {
    pi.registerShortcut(shortcut, {
      description: "Toggle voice dictation",
      handler: toggleRecording,
    });
  }

  pi.on("session_shutdown", async (_event, ctx) => {
    clearStatusTimer();
    setStatus(ctx, undefined);

    if (!recording) return;
    const current = recording;
    recording = undefined;
    current.stopping = true;

    try {
      current.child.kill("SIGTERM");
    } catch {
      // Ignore close races.
    }

    await removeAudioFile(current.audioPath);
  });
}
