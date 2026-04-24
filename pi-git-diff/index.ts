import type { ExtensionAPI, TruncationResult } from "@mariozechner/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";

type GitDiffDetails = {
  args: string[];
  code: number;
  cwd: string;
  diff: string;
  stderr: string;
  truncation: TruncationResult;
};

const PARAMETERS = Type.Object({
  staged: Type.Optional(
    Type.Boolean({
      description: "Show staged changes using git diff --cached.",
    }),
  ),
  path: Type.Optional(
    Type.String({
      description: "Optional file or pathspec to limit the diff. A leading @ is stripped for Pi path references.",
    }),
  ),
  context: Type.Optional(
    Type.Number({
      description: "Optional number of context lines to show around changes.",
      minimum: 0,
      maximum: 100,
    }),
  ),
});

function normalizePath(path: string | undefined): string | undefined {
  const trimmed = path?.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/^@/, "");
}

function normalizeContext(context: number | undefined): number | undefined {
  if (typeof context !== "number" || !Number.isFinite(context)) return undefined;
  return Math.max(0, Math.min(100, Math.floor(context)));
}

function formatTruncationNotice(truncation: TruncationResult): string {
  if (!truncation.truncated) return "";

  return `\n\n[Output truncated: showing first ${truncation.outputLines} of ${truncation.totalLines} lines, ${formatSize(
    truncation.outputBytes,
  )} of ${formatSize(truncation.totalBytes)}.]`;
}

function countDiffLines(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }

  return { additions, deletions };
}

function renderGitDiff(diff: string, theme: any): string {
  return diff
    .split("\n")
    .map((line) => {
      if (line.startsWith("+") && !line.startsWith("+++")) {
        return theme.fg("toolDiffAdded", line);
      }

      if (line.startsWith("-") && !line.startsWith("---")) {
        return theme.fg("toolDiffRemoved", line);
      }

      if (line.startsWith("@@")) {
        return theme.fg("accent", line);
      }

      if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++")) {
        return theme.fg("toolTitle", line);
      }

      return theme.fg("toolDiffContext", line);
    })
    .join("\n");
}

function commandPreview(args: string[]): string {
  return ["git", ...args].join(" ");
}

export default function gitDiffExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "git_diff",
    label: "git diff",
    description: "Run git diff and render added/removed lines with Pi's diff theme colors.",
    promptSnippet: "Use git_diff to inspect repository changes with themed added and removed diff lines.",
    promptGuidelines: [
      "Use git_diff instead of bash for git diff requests so additions and deletions render with Pi diff colors.",
      "Pass staged=true when the user asks for staged/cached changes.",
      "Pass path for a specific file or pathspec. Strip a leading @ from Pi path references if present.",
      "This tool is read-only and must not be used for commands that mutate the repository.",
    ],
    parameters: PARAMETERS,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const args = ["--no-pager", "diff", "--no-color"];
      const context = normalizeContext(params.context);
      const path = normalizePath(params.path);

      if (params.staged) args.push("--cached");
      if (context !== undefined) args.push(`--unified=${context}`);
      if (path) args.push("--", path);

      const result = await pi.exec("git", args, {
        cwd: ctx.cwd,
        signal,
        timeout: 10_000,
      });

      const rawOutput = result.code === 0 ? result.stdout : result.stderr || result.stdout;
      const truncation = truncateHead(rawOutput, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });

      let text: string;
      if (result.code !== 0) {
        text = `git diff failed with exit code ${result.code}`;
        if (truncation.content.trim()) text += `\n\n${truncation.content}`;
      } else if (truncation.content.trim()) {
        text = truncation.content;
      } else {
        text = "No diff.";
      }

      text += formatTruncationNotice(truncation);

      return {
        content: [{ type: "text", text }],
        details: {
          args,
          code: result.code,
          cwd: ctx.cwd,
          diff: result.code === 0 ? truncation.content : "",
          stderr: result.stderr,
          truncation,
        } satisfies GitDiffDetails,
      };
    },

    renderCall(args, theme) {
      const parts = ["diff", "--no-color"];
      const context = normalizeContext(args.context);
      const path = normalizePath(args.path);

      if (args.staged) parts.push("--cached");
      if (context !== undefined) parts.push(`--unified=${context}`);
      if (path) parts.push("--", path);

      let text = theme.fg("toolTitle", theme.bold("git "));
      text += theme.fg("accent", parts.join(" "));
      return new Text(text, 0, 0);
    },

    renderResult(result, { isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Running git diff..."), 0, 0);

      const details = result.details as GitDiffDetails | undefined;
      if (!details) return new Text(theme.fg("muted", "No git diff details."), 0, 0);

      if (details.code !== 0) {
        const message = details.stderr.trim() || `git diff exited with code ${details.code}`;
        return new Text(theme.fg("error", message), 0, 0);
      }

      if (!details.diff.trim()) {
        return new Text(theme.fg("success", "No diff"), 0, 0);
      }

      const counts = countDiffLines(details.diff);
      let text = `${theme.fg("toolDiffAdded", `+${counts.additions}`)} ${theme.fg("toolDiffRemoved", `-${counts.deletions}`)}`;
      text += theme.fg("dim", `  ${commandPreview(details.args)}`);
      text += `\n${renderGitDiff(details.diff, theme)}`;

      if (details.truncation.truncated) {
        text += `\n${theme.fg("warning", formatTruncationNotice(details.truncation).trim())}`;
      }

      return new Text(text, 0, 0);
    },
  });
}
