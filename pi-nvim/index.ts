import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";

const SOCKETS_DIR = process.env.PI_NVIM_SOCKETS_DIR ?? "/tmp/pi-nvim-sockets";
const LATEST_LINK = process.env.PI_NVIM_LATEST_SOCKET ?? "/tmp/pi-nvim-latest.sock";
const STATUS_KEY = "pi-nvim";

type Delivery = "steer" | "followUp";

type IncomingImage =
  | {
      type?: "image";
      data: string;
      mimeType: string;
    }
  | {
      type: "image";
      source: {
        type: "base64";
        mediaType: string;
        data: string;
      };
    };

type IncomingMessage = {
  type?: string;
  message?: unknown;
  images?: unknown;
  events?: unknown;
  deliverAs?: unknown;
  delivery?: unknown;
  streamingBehavior?: unknown;
  snapToBottom?: unknown;
};

const FILE_CHANGED_EVENT = "file.changed";

function cwdHash(cwd: string): string {
  return crypto.createHash("md5").update(cwd).digest("hex").slice(0, 12);
}

function getSocketPath(cwd: string): string {
  return path.join(SOCKETS_DIR, `${cwdHash(cwd)}-${process.pid}.sock`);
}

function normalizeDelivery(value: unknown): Delivery | undefined {
  if (value === "steer") return "steer";
  if (value === "followUp" || value === "followup" || value === "follow_up") return "followUp";
  return undefined;
}

function isProcessAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function unlinkIfExists(filePath: string | null | undefined): void {
  if (!filePath) return;
  try {
    fs.unlinkSync(filePath);
  } catch {
    // ignore missing/stale files
  }
}

function cleanupStaleSocketFiles(): void {
  try {
    fs.mkdirSync(SOCKETS_DIR, { recursive: true });
  } catch {
    return;
  }

  let entries: string[] = [];
  try {
    entries = fs.readdirSync(SOCKETS_DIR);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".info")) continue;

    const infoPath = path.join(SOCKETS_DIR, entry);
    const socketPath = infoPath.slice(0, -".info".length);

    try {
      const raw = fs.readFileSync(infoPath, "utf8");
      const info = JSON.parse(raw) as { pid?: unknown };
      if (!isProcessAlive(info.pid)) {
        unlinkIfExists(infoPath);
        unlinkIfExists(socketPath);
      }
    } catch {
      unlinkIfExists(infoPath);
      unlinkIfExists(socketPath);
    }
  }
}

function toPiContent(message: string, images: unknown): string | Array<any> {
  if (!Array.isArray(images) || images.length === 0) return message;

  const content: Array<any> = [{ type: "text", text: message }];

  for (const image of images as IncomingImage[]) {
    if (!image || typeof image !== "object") continue;

    if ("source" in image && image.source?.type === "base64") {
      content.push(image);
      continue;
    }

    if ("data" in image && typeof image.data === "string" && typeof image.mimeType === "string") {
      content.push({
        type: "image",
        source: {
          type: "base64",
          mediaType: image.mimeType,
          data: image.data,
        },
      });
    }
  }

  return content.length > 1 ? content : message;
}

function snapTerminalToBottom(ctx: ExtensionContext | null, msg: IncomingMessage): void {
  if (!ctx?.hasUI) return;
  if (msg.snapToBottom === false) return;

  try {
    // Same trick used by pi-nvim: briefly switch to the alternate screen and
    // back so terminal scrollback viewers snap to the live Pi prompt.
    process.stdout.write("\x1b[?1049h\x1b[?1049l");
  } catch {
    // best effort only
  }
}

function response(conn: net.Socket, payload: Record<string, unknown>): void {
  try {
    conn.write(`${JSON.stringify(payload)}\n`);
  } catch {
    // client went away
  }
}

export default function piNvimExtension(pi: ExtensionAPI) {
  let server: net.Server | null = null;
  let socketPath: string | null = null;
  let activeCtx: ExtensionContext | null = null;
  let activeCwd: string | null = null;
  let startedAt: string | null = null;
  let eventSeq = 0;
  const subscribers = new Set<net.Socket>();

  function cleanup(): void {
    if (server) {
      try {
        server.close();
      } catch {
        // ignore close races
      }
      server = null;
    }

    for (const subscriber of subscribers) {
      try {
        subscriber.destroy();
      } catch {
        // ignore disconnect races
      }
    }
    subscribers.clear();

    const currentSocketPath = socketPath;
    unlinkIfExists(currentSocketPath);
    unlinkIfExists(currentSocketPath ? `${currentSocketPath}.info` : null);

    try {
      const target = fs.readlinkSync(LATEST_LINK);
      if (target === currentSocketPath) unlinkIfExists(LATEST_LINK);
    } catch {
      // no latest link or not our link
    }

    try {
      activeCtx?.ui.setStatus(STATUS_KEY, undefined);
    } catch {
      // no UI during teardown
    }

    socketPath = null;
    activeCtx = null;
    activeCwd = null;
    startedAt = null;
  }

  function writeManifest(ctx: ExtensionContext): void {
    if (!socketPath) return;

    try {
      fs.mkdirSync(SOCKETS_DIR, { recursive: true });
      fs.writeFileSync(
        `${socketPath}.info`,
        JSON.stringify({
          cwd: ctx.cwd,
          pid: process.pid,
          socketPath,
          sessionFile: ctx.sessionManager.getSessionFile(),
          startedAt,
          protocol: "pi-nvim-jsonl-v1",
          capabilities: ["ping", "prompt", "steer", "follow_up", "status", "subscribe", "file_changed_events"],
        }),
      );
    } catch (error) {
      ctx.ui.notify(`pi-nvim: failed to write socket manifest: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
  }

  function removeSubscriber(conn: net.Socket): void {
    subscribers.delete(conn);
  }

  function subscribe(conn: net.Socket, msg: IncomingMessage): void {
    subscribers.add(conn);
    conn.once("close", () => removeSubscriber(conn));
    conn.once("end", () => removeSubscriber(conn));
    response(conn, {
      ok: true,
      type: "subscribed",
      events: Array.isArray(msg.events) && msg.events.length > 0 ? msg.events : [FILE_CHANGED_EVENT],
    });
  }

  function emitEvent(payload: Record<string, unknown>): void {
    if (subscribers.size === 0) return;

    const message = `${JSON.stringify({ type: "event", seq: ++eventSeq, at: new Date().toISOString(), ...payload })}\n`;
    for (const subscriber of Array.from(subscribers)) {
      try {
        subscriber.write(message);
      } catch {
        subscribers.delete(subscriber);
        try {
          subscriber.destroy();
        } catch {
          // ignore disconnect races
        }
      }
    }
  }

  function emitFileChanged(filePath: string, originalPath: string, toolName: string): void {
    emitEvent({
      event: FILE_CHANGED_EVENT,
      path: filePath,
      originalPath,
      tool: toolName,
      cwd: activeCwd,
    });
  }

  function handleMessage(raw: string, conn: net.Socket): void {
    try {
      const msg = JSON.parse(raw) as IncomingMessage;
      const type = typeof msg.type === "string" ? msg.type : "";

      if (type === "subscribe") {
        subscribe(conn, msg);
        return;
      }

      if (type === "unsubscribe") {
        removeSubscriber(conn);
        response(conn, { ok: true, type: "unsubscribed" });
        return;
      }

      if (type === "ping") {
        response(conn, {
          ok: true,
          type: "pong",
          cwd: activeCwd,
          pid: process.pid,
          socketPath,
          idle: activeCtx?.isIdle() ?? true,
        });
        return;
      }

      if (type === "status") {
        response(conn, {
          ok: true,
          type: "status",
          cwd: activeCwd,
          pid: process.pid,
          socketPath,
          startedAt,
          idle: activeCtx?.isIdle() ?? true,
        });
        return;
      }

      const isPrompt = type === "prompt" || type === "steer" || type === "follow_up" || type === "followup";
      if (!isPrompt) {
        response(conn, { ok: false, error: `Unknown command type: ${type || "<missing>"}` });
        return;
      }

      if (!activeCtx) {
        response(conn, { ok: false, error: "No active Pi session context" });
        return;
      }

      if (typeof msg.message !== "string") {
        response(conn, { ok: false, error: "Prompt command requires a string message" });
        return;
      }

      const message = msg.message.trimEnd();
      if (!message.trim()) {
        response(conn, { ok: false, error: "Prompt message is empty" });
        return;
      }

      const requestedDelivery =
        type === "steer"
          ? "steer"
          : type === "follow_up" || type === "followup"
            ? "followUp"
            : normalizeDelivery(msg.deliverAs ?? msg.delivery ?? msg.streamingBehavior);
      const idle = activeCtx.isIdle();
      const deliverAs = idle ? undefined : requestedDelivery ?? "followUp";
      const content = toPiContent(message, msg.images);

      snapTerminalToBottom(activeCtx, msg);
      pi.sendUserMessage(content, deliverAs ? { deliverAs } : undefined);

      response(conn, {
        ok: true,
        type: "accepted",
        delivery: deliverAs ?? "immediate",
        idle,
      });
    } catch (error) {
      response(conn, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function startServer(ctx: ExtensionContext): void {
    cleanup();
    cleanupStaleSocketFiles();

    activeCtx = ctx;
    activeCwd = ctx.cwd;
    startedAt = new Date().toISOString();
    socketPath = getSocketPath(ctx.cwd);

    try {
      fs.mkdirSync(SOCKETS_DIR, { recursive: true });
      unlinkIfExists(socketPath);
    } catch (error) {
      ctx.ui.notify(`pi-nvim: failed to prepare socket dir: ${error instanceof Error ? error.message : String(error)}`, "error");
      return;
    }

    server = net.createServer((conn) => {
      let buffer = "";

      conn.on("data", (data) => {
        buffer += data.toString("utf8");
        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (line) handleMessage(line, conn);
          newlineIndex = buffer.indexOf("\n");
        }
      });

      conn.on("close", () => removeSubscriber(conn));
      conn.on("error", () => {
        removeSubscriber(conn);
        // Ignore client disconnect races.
      });
    });

    server.on("error", (error) => {
      ctx.ui.notify(`pi-nvim socket error: ${error.message}`, "error");
      ctx.ui.setStatus(STATUS_KEY, "nvim: socket error");
    });

    server.listen(socketPath, () => {
      if (!socketPath) return;

      try {
        fs.chmodSync(socketPath, 0o600);
      } catch {
        // best effort
      }

      unlinkIfExists(LATEST_LINK);
      try {
        fs.symlinkSync(socketPath, LATEST_LINK);
      } catch {
        // latest link is a convenience only
      }

      writeManifest(ctx);
      ctx.ui.setStatus(STATUS_KEY, "nvim: listening");
    });
  }

  const processCleanup = () => cleanup();
  process.on("exit", processCleanup);

  pi.on("session_start", async (_event, ctx) => {
    startServer(ctx);
  });

  pi.on("session_shutdown", async () => {
    cleanup();
    process.off("exit", processCleanup);
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.isError) return;
    if (event.toolName !== "edit" && event.toolName !== "write") return;

    const input = event.input as { path?: unknown } | undefined;
    if (!input || typeof input.path !== "string" || input.path.trim() === "") return;

    const originalPath = input.path;
    const changedPath = path.isAbsolute(originalPath) ? originalPath : path.resolve(ctx.cwd, originalPath);
    emitFileChanged(changedPath, originalPath, event.toolName);
  });

  pi.registerCommand("pi-nvim", {
    description: "Show the Neovim bridge socket for this Pi session",
    handler: async (_args, ctx) => {
      if (!socketPath) {
        ctx.ui.notify("pi-nvim bridge is not listening", "warning");
        return;
      }

      ctx.ui.notify(
        [
          "pi-nvim bridge listening",
          `socket: ${socketPath}`,
          `cwd:    ${activeCwd ?? ctx.cwd}`,
          `pid:    ${process.pid}`,
        ].join("\n"),
        "info",
      );
    },
  });

  pi.registerCommand("pi-nvim-info", {
    description: "Alias for /pi-nvim",
    handler: async (_args, ctx) => {
      if (!socketPath) {
        ctx.ui.notify("pi-nvim bridge is not listening", "warning");
        return;
      }
      ctx.ui.notify(`Socket: ${socketPath}`, "info");
    },
  });
}
