import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { AssistantMessageEvent, Context, Model, SimpleStreamOptions, Transport } from "@earendil-works/pi-ai/compat";
import { writeFile } from "node:fs/promises";
import path from "node:path";

const STATE_ENTRY_TYPE = "fast-mode-state";
const STATUS_KEY = "fast-mode";
const FAST_SERVICE_TIER = "priority";

const OPENAI_SERVICE_TIER_APIS = new Set(["openai-completions", "openai-responses", "openai-codex-responses"]);
const OPENAI_SERVICE_TIER_PROVIDERS = new Set(["openai", "openai-codex"]);

interface PersistedState {
  enabled: boolean;
}

type SessionEntryLike = {
  type: string;
  customType?: string;
  data?: unknown;
};

type ModelLike = NonNullable<ExtensionContext["model"]>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function modelLabel(model: ModelLike | undefined): string {
  if (!model) return "no model selected";
  return `${model.provider}/${model.id}`;
}

function supportsOpenAIServiceTier(model: ModelLike | undefined): boolean {
  if (!model) return false;

  const api = String(model.api);
  if (!OPENAI_SERVICE_TIER_APIS.has(api)) return false;

  const provider = String(model.provider).toLowerCase();
  const baseUrl = String(model.baseUrl ?? "").toLowerCase();

  return (
    OPENAI_SERVICE_TIER_PROVIDERS.has(provider) ||
    baseUrl.includes("api.openai.com") ||
    baseUrl.includes("chatgpt.com/backend-api")
  );
}

function readPersistedState(entry: SessionEntryLike | undefined): PersistedState | undefined {
  if (!isRecord(entry?.data)) return undefined;
  return typeof entry.data.enabled === "boolean" ? { enabled: entry.data.enabled } : undefined;
}

type BenchTier = "default" | "priority";

interface BenchmarkOptions {
  runs: number;
  warmup: number;
  prompt: string;
  maxTokens: number;
  delayMs: number;
  timeoutMs: number;
  transport: Transport;
  csvPath?: string;
}

interface BenchmarkSample {
  tier: BenchTier;
  run: number;
  warmup: boolean;
  responseMs: number | undefined;
  firstEventMs: number | undefined;
  firstTextMs: number | undefined;
  firstTextDeltaMs: number | undefined;
  totalMs: number;
  textChars: number;
  estimatedTokens: number;
  tokensPerSecond: number | undefined;
  status: number | undefined;
  serviceTierPatched: boolean;
  error: string | undefined;
}

interface BenchmarkReport {
  model: string;
  options: BenchmarkOptions;
  measured: BenchmarkSample[];
  warmups: BenchmarkSample[];
  summary: string;
}

interface ResolvedBenchAuth {
  apiKey?: string;
  headers?: Record<string, string>;
}

const DEFAULT_BENCH_PROMPT = "Reply with exactly: OK";
const BENCH_STATUS_KEY = "fast-bench";

function shellSplit(input: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(input)) !== null) {
    tokens.push((match[1] ?? match[2] ?? match[3]).replace(/\\(["'\\])/g, "$1"));
  }
  return tokens;
}

function parsePositiveInteger(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseNonNegativeInteger(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function parseBenchmarkArgs(args: string): BenchmarkOptions {
  const tokens = shellSplit(args);
  const positional: string[] = [];
  const options: BenchmarkOptions = {
    runs: 10,
    warmup: 0,
    prompt: DEFAULT_BENCH_PROMPT,
    maxTokens: 16,
    delayMs: 500,
    timeoutMs: 120_000,
    transport: "sse",
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "--help" || token === "-h") {
      throw new Error("usage");
    }
    if (token === "--runs" || token === "--n" || token === "-n") {
      options.runs = parsePositiveInteger(tokens[++i], token);
      continue;
    }
    if (token.startsWith("--runs=")) {
      options.runs = parsePositiveInteger(token.slice("--runs=".length), "--runs");
      continue;
    }
    if (token === "--warmup") {
      options.warmup = parseNonNegativeInteger(tokens[++i], token);
      continue;
    }
    if (token.startsWith("--warmup=")) {
      options.warmup = parseNonNegativeInteger(token.slice("--warmup=".length), "--warmup");
      continue;
    }
    if (token === "--max-tokens") {
      options.maxTokens = parsePositiveInteger(tokens[++i], token);
      continue;
    }
    if (token.startsWith("--max-tokens=")) {
      options.maxTokens = parsePositiveInteger(token.slice("--max-tokens=".length), "--max-tokens");
      continue;
    }
    if (token === "--delay") {
      options.delayMs = parseNonNegativeInteger(tokens[++i], token);
      continue;
    }
    if (token.startsWith("--delay=")) {
      options.delayMs = parseNonNegativeInteger(token.slice("--delay=".length), "--delay");
      continue;
    }
    if (token === "--timeout") {
      options.timeoutMs = parsePositiveInteger(tokens[++i], token);
      continue;
    }
    if (token.startsWith("--timeout=")) {
      options.timeoutMs = parsePositiveInteger(token.slice("--timeout=".length), "--timeout");
      continue;
    }
    if (token === "--transport") {
      options.transport = parseTransport(tokens[++i]);
      continue;
    }
    if (token.startsWith("--transport=")) {
      options.transport = parseTransport(token.slice("--transport=".length));
      continue;
    }
    if (token === "--csv") {
      options.csvPath = tokens[++i];
      continue;
    }
    if (token.startsWith("--csv=")) {
      options.csvPath = token.slice("--csv=".length);
      continue;
    }
    positional.push(token);
  }

  if (positional.length > 0 && /^\d+$/.test(positional[0])) {
    options.runs = parsePositiveInteger(positional.shift(), "runs");
  }
  if (positional.length > 0) {
    options.prompt = positional.join(" ");
  }

  return options;
}

function parseTransport(value: string | undefined): Transport {
  if (value === "auto" || value === "sse" || value === "websocket" || value === "websocket-cached") return value;
  throw new Error("--transport must be one of: sse, auto, websocket, websocket-cached");
}

function usageText(): string {
  return [
    "Usage: /fast-bench [runs] [prompt] [options]",
    "Options:",
    "  --runs, --n, -n <n>        measured runs per tier (default 10)",
    "  --warmup <n>               warmup runs per tier, excluded from stats (default 0)",
    "  --max-tokens <n>           max output tokens per request (default 16)",
    "  --delay <ms>               delay between requests (default 500)",
    "  --timeout <ms>             per-request timeout (default 120000)",
    "  --transport <mode>         sse|auto|websocket|websocket-cached (default sse)",
    "  --csv <path>               write raw samples as CSV",
    "Example: /fast-bench 30 --warmup 2 \"Reply with exactly: OK\"",
  ].join("\n");
}

function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function average(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatMs(value: number | undefined): string {
  return value === undefined || Number.isNaN(value) ? "n/a" : `${Math.round(value)}ms`;
}

function formatDelta(priority: number | undefined, baseline: number | undefined): string {
  if (priority === undefined || baseline === undefined || Number.isNaN(priority) || Number.isNaN(baseline)) return "n/a";
  const delta = priority - baseline;
  const sign = delta > 0 ? "+" : "";
  return `${sign}${Math.round(delta)}ms`;
}

function formatNumber(value: number | undefined, digits = 1): string {
  return value === undefined || Number.isNaN(value) ? "n/a" : value.toFixed(digits);
}

function formatRatio(priority: number | undefined, baseline: number | undefined): string {
  if (priority === undefined || baseline === undefined || Number.isNaN(priority) || Number.isNaN(baseline) || baseline === 0) return "n/a";
  return `${(priority / baseline).toFixed(2)}x`;
}

function formatNumberDelta(priority: number | undefined, baseline: number | undefined, suffix = ""): string {
  if (priority === undefined || baseline === undefined || Number.isNaN(priority) || Number.isNaN(baseline)) return "n/a";
  const delta = priority - baseline;
  const sign = delta > 0 ? "+" : "";
  return `${sign}${delta.toFixed(1)}${suffix}`;
}

function csvEscape(value: unknown): string {
  const text = value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(samples: BenchmarkSample[]): string {
  const rows = [
    [
      "tier",
      "run",
      "warmup",
      "response_ms",
      "first_event_ms",
      "first_text_ms",
      "first_text_delta_ms",
      "total_ms",
      "text_chars",
      "estimated_tokens",
      "tokens_per_second",
      "status",
      "service_tier_patched",
      "error",
    ],
    ...samples.map((sample) => [
      sample.tier,
      sample.run,
      sample.warmup,
      sample.responseMs?.toFixed(1),
      sample.firstEventMs?.toFixed(1),
      sample.firstTextMs?.toFixed(1),
      sample.firstTextDeltaMs?.toFixed(1),
      sample.totalMs.toFixed(1),
      sample.textChars,
      sample.estimatedTokens.toFixed(1),
      sample.tokensPerSecond?.toFixed(1),
      sample.status,
      sample.serviceTierPatched,
      sample.error,
    ]),
  ];
  return `${rows.map((row) => row.map(csvEscape).join(",")).join("\n")}\n`;
}

function buildBenchmarkContext(prompt: string): Context {
  return {
    systemPrompt: "You are a latency benchmark respondent. Follow the user's requested output exactly and do not call tools.",
    messages: [
      {
        role: "user",
        content: prompt,
        timestamp: Date.now(),
      },
    ],
    tools: [],
  };
}

function isFirstTextEvent(event: AssistantMessageEvent): boolean {
  return event.type === "text_start" || event.type === "text_delta";
}

async function runBenchmarkSample(
  model: Model<any>,
  auth: ResolvedBenchAuth,
  options: BenchmarkOptions,
  tier: BenchTier,
  run: number,
  warmup: boolean,
): Promise<BenchmarkSample> {
  let responseAt: number | undefined;
  let firstEventAt: number | undefined;
  let firstTextAt: number | undefined;
  let firstTextDeltaAt: number | undefined;
  let textChars = 0;
  let status: number | undefined;
  let serviceTierPatched = false;
  let error: string | undefined;
  const start = performance.now();

  try {
    const streamOptions: SimpleStreamOptions = {
      apiKey: auth.apiKey,
      headers: auth.headers,
      maxTokens: options.maxTokens,
      reasoning: "minimal",
      cacheRetention: "none",
      transport: options.transport,
      timeoutMs: options.timeoutMs,
      maxRetries: 0,
      onPayload(payload) {
        if (tier !== "priority") return undefined;
        if (!isRecord(payload)) return undefined;
        serviceTierPatched = true;
        return {
          ...payload,
          service_tier: FAST_SERVICE_TIER,
        };
      },
      onResponse(response) {
        status = response.status;
        responseAt ??= performance.now();
      },
    };

    const stream = streamSimple(model, buildBenchmarkContext(options.prompt), streamOptions);
    for await (const event of stream) {
      firstEventAt ??= performance.now();
      if (firstTextAt === undefined && isFirstTextEvent(event)) {
        firstTextAt = performance.now();
      }
      if (event.type === "text_delta" && event.delta.length > 0) {
        firstTextDeltaAt ??= performance.now();
        textChars += event.delta.length;
      }
      if (event.type === "text_end" && textChars === 0) {
        textChars = event.content.length;
      }
      if (event.type === "error") {
        error = event.error.errorMessage ?? event.reason;
      }
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }

  const end = performance.now();
  const totalMs = end - start;
  const firstTextDeltaMs = firstTextDeltaAt === undefined ? undefined : firstTextDeltaAt - start;
  const estimatedTokens = textChars / 4;
  const generationSeconds = firstTextDeltaMs === undefined ? undefined : Math.max((totalMs - firstTextDeltaMs) / 1000, 0.001);
  return {
    tier,
    run,
    warmup,
    responseMs: responseAt === undefined ? undefined : responseAt - start,
    firstEventMs: firstEventAt === undefined ? undefined : firstEventAt - start,
    firstTextMs: firstTextAt === undefined ? undefined : firstTextAt - start,
    firstTextDeltaMs,
    totalMs,
    textChars,
    estimatedTokens,
    tokensPerSecond: generationSeconds === undefined ? undefined : estimatedTokens / generationSeconds,
    status,
    serviceTierPatched,
    error,
  };
}

function summarizeBenchmark(model: string, options: BenchmarkOptions, samples: BenchmarkSample[]): string {
  const successful = samples.filter((sample) => !sample.error);
  const errors = samples.filter((sample) => sample.error);
  const byTier = (tier: BenchTier) => successful.filter((sample) => sample.tier === tier);
  const metric = (tier: BenchTier, selector: (sample: BenchmarkSample) => number | undefined) =>
    byTier(tier)
      .map(selector)
      .filter((value): value is number => value !== undefined && !Number.isNaN(value));

  const responseDefault = metric("default", (sample) => sample.responseMs ?? sample.firstEventMs);
  const responsePriority = metric("priority", (sample) => sample.responseMs ?? sample.firstEventMs);
  const firstTextDefault = metric("default", (sample) => sample.firstTextMs ?? sample.firstEventMs);
  const firstTextPriority = metric("priority", (sample) => sample.firstTextMs ?? sample.firstEventMs);
  const totalDefault = metric("default", (sample) => sample.totalMs);
  const totalPriority = metric("priority", (sample) => sample.totalMs);
  const tokensDefault = metric("default", (sample) => sample.estimatedTokens);
  const tokensPriority = metric("priority", (sample) => sample.estimatedTokens);
  const throughputDefault = metric("default", (sample) => sample.tokensPerSecond);
  const throughputPriority = metric("priority", (sample) => sample.tokensPerSecond);

  const lines = [
    `Fast benchmark: ${model}`,
    `Prompt: ${JSON.stringify(options.prompt)}`,
    `Runs: ${options.runs}/tier measured, warmup ${options.warmup}/tier, transport ${options.transport}`,
    "",
    "Metric                 default      priority     delta(priority-default)",
    `response/first p50     ${formatMs(percentile(responseDefault, 50)).padEnd(12)} ${formatMs(percentile(responsePriority, 50)).padEnd(12)} ${formatDelta(percentile(responsePriority, 50), percentile(responseDefault, 50))}`,
    `response/first p95     ${formatMs(percentile(responseDefault, 95)).padEnd(12)} ${formatMs(percentile(responsePriority, 95)).padEnd(12)} ${formatDelta(percentile(responsePriority, 95), percentile(responseDefault, 95))}`,
    `first text p50         ${formatMs(percentile(firstTextDefault, 50)).padEnd(12)} ${formatMs(percentile(firstTextPriority, 50)).padEnd(12)} ${formatDelta(percentile(firstTextPriority, 50), percentile(firstTextDefault, 50))}`,
    `total avg              ${formatMs(average(totalDefault)).padEnd(12)} ${formatMs(average(totalPriority)).padEnd(12)} ${formatDelta(average(totalPriority), average(totalDefault))}`,
    `total p50              ${formatMs(percentile(totalDefault, 50)).padEnd(12)} ${formatMs(percentile(totalPriority, 50)).padEnd(12)} ${formatDelta(percentile(totalPriority, 50), percentile(totalDefault, 50))}`,
    `total p95              ${formatMs(percentile(totalDefault, 95)).padEnd(12)} ${formatMs(percentile(totalPriority, 95)).padEnd(12)} ${formatDelta(percentile(totalPriority, 95), percentile(totalDefault, 95))}`,
    `output est tokens avg  ${formatNumber(average(tokensDefault)).padEnd(12)} ${formatNumber(average(tokensPriority)).padEnd(12)} ${formatNumberDelta(average(tokensPriority), average(tokensDefault), " tok")}`,
    `generation tok/s avg   ${formatNumber(average(throughputDefault)).padEnd(12)} ${formatNumber(average(throughputPriority)).padEnd(12)} ${formatRatio(average(throughputPriority), average(throughputDefault))}`,
    `generation tok/s p50   ${formatNumber(percentile(throughputDefault, 50)).padEnd(12)} ${formatNumber(percentile(throughputPriority, 50)).padEnd(12)} ${formatRatio(percentile(throughputPriority, 50), percentile(throughputDefault, 50))}`,
  ];

  if (errors.length > 0) {
    lines.push("", `Errors: ${errors.length}`, ...errors.slice(0, 5).map((sample) => `  ${sample.tier} #${sample.run}: ${sample.error}`));
  }

  return lines.join("\n");
}

async function runBenchmark(ctx: ExtensionCommandContext, options: BenchmarkOptions): Promise<BenchmarkReport> {
  if (!ctx.model) throw new Error("No model selected");
  if (!supportsOpenAIServiceTier(ctx.model)) {
    throw new Error(`Current model (${modelLabel(ctx.model)}) was not detected as OpenAI service-tier compatible`);
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
  if (auth.ok === false) throw new Error(auth.error);

  const model = ctx.model as Model<any>;
  const modelName = modelLabel(model);
  const warmupOrder = shuffle(Array.from({ length: options.warmup }, () => ["default", "priority"] as BenchTier[]).flat());
  const measuredOrder = shuffle(Array.from({ length: options.runs }, () => ["default", "priority"] as BenchTier[]).flat());
  const warmups: BenchmarkSample[] = [];
  const measured: BenchmarkSample[] = [];
  const totalRequests = warmupOrder.length + measuredOrder.length;
  let completed = 0;

  const runOrder = async (order: BenchTier[], warmup: boolean, target: BenchmarkSample[]) => {
    const counts: Record<BenchTier, number> = { default: 0, priority: 0 };
    for (const tier of order) {
      counts[tier]++;
      completed++;
      ctx.ui.setStatus(BENCH_STATUS_KEY, ctx.ui.theme.fg("warning", `bench ${completed}/${totalRequests} ${tier}`));
      const sample = await runBenchmarkSample(model, auth, options, tier, counts[tier], warmup);
      target.push(sample);
      if (options.delayMs > 0 && completed < totalRequests) await sleep(options.delayMs);
    }
  };

  await runOrder(warmupOrder, true, warmups);
  await runOrder(measuredOrder, false, measured);

  const summary = summarizeBenchmark(modelName, options, measured);
  return { model: modelName, options, measured, warmups, summary };
}

export default function fastModeExtension(pi: ExtensionAPI): void {
  let enabled = false;

  function updateStatus(ctx: ExtensionContext): void {
    if (!enabled) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }

    const text = supportsOpenAIServiceTier(ctx.model) ? "⚡ fast" : "⚡ fast inactive";
    const color = supportsOpenAIServiceTier(ctx.model) ? "warning" : "dim";
    ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(color, text));
  }

  function persistState(): void {
    pi.appendEntry<PersistedState>(STATE_ENTRY_TYPE, { enabled });
  }

  function restoreFromBranch(ctx: ExtensionContext): void {
    const branchEntries = ctx.sessionManager.getBranch() as SessionEntryLike[];
    const savedEntry = [...branchEntries]
      .reverse()
      .find((entry) => entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE);
    enabled = readPersistedState(savedEntry)?.enabled ?? false;
    updateStatus(ctx);
  }

  function toggleFastMode(ctx: ExtensionCommandContext): void {
    enabled = !enabled;
    persistState();
    updateStatus(ctx);

    if (enabled) {
      const appliesNow = supportsOpenAIServiceTier(ctx.model);
      const note = appliesNow
        ? `Current model: ${modelLabel(ctx.model)}.`
        : `Current model (${modelLabel(ctx.model)}) was not detected as OpenAI service-tier compatible; fast mode will apply when a compatible OpenAI model is selected.`;
      ctx.ui.notify(`Fast mode enabled. Future OpenAI requests get service_tier="${FAST_SERVICE_TIER}". ${note}`, appliesNow ? "info" : "warning");
      return;
    }

    ctx.ui.notify("Fast mode disabled.", "info");
  }

  pi.registerCommand("fast", {
    description: "Toggle OpenAI priority service tier fast mode on/off",
    handler: async (_args, ctx) => {
      toggleFastMode(ctx);
    },
  });

  pi.registerCommand("fast-bench", {
    description: "Benchmark default vs OpenAI priority service tier using the current model",
    handler: async (args, ctx) => {
      let options: BenchmarkOptions;
      try {
        options = parseBenchmarkArgs(args);
      } catch (error) {
        const message = error instanceof Error && error.message !== "usage" ? `${error.message}\n\n${usageText()}` : usageText();
        if (ctx.hasUI) ctx.ui.notify(message, error instanceof Error && error.message === "usage" ? "info" : "warning");
        else console.log(message);
        return;
      }

      if (!ctx.isIdle()) {
        ctx.ui.notify("Wait for the current agent turn to finish before running /fast-bench.", "warning");
        return;
      }

      ctx.ui.notify(`Running fast benchmark (${options.runs} runs/tier) on ${modelLabel(ctx.model)}...`, "info");
      try {
        const report = await runBenchmark(ctx, options);
        const samples = [...report.warmups, ...report.measured];
        if (options.csvPath) {
          const csvPath = path.isAbsolute(options.csvPath) ? options.csvPath : path.resolve(ctx.cwd, options.csvPath);
          await writeFile(csvPath, toCsv(samples), "utf8");
          report.summary += `\n\nCSV: ${csvPath}`;
        }

        pi.sendMessage<BenchmarkReport>(
          {
            customType: "fast-bench-result",
            content: report.summary,
            display: true,
            details: report,
          },
          { triggerTurn: false },
        );
        if (ctx.hasUI) ctx.ui.notify("Fast benchmark complete. Results added to the session.", "info");
        else console.log(report.summary);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (ctx.hasUI) ctx.ui.notify(`Fast benchmark failed: ${message}`, "error");
        else console.error(`Fast benchmark failed: ${message}`);
      } finally {
        ctx.ui.setStatus(BENCH_STATUS_KEY, undefined);
      }
    },
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (!enabled) return;
    if (!supportsOpenAIServiceTier(ctx.model)) return;
    if (!isRecord(event.payload)) return;
    if (event.payload.service_tier === FAST_SERVICE_TIER) return;

    return {
      ...event.payload,
      service_tier: FAST_SERVICE_TIER,
    };
  });

  pi.on("session_start", async (_event, ctx) => {
    restoreFromBranch(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    restoreFromBranch(ctx);
  });

  pi.on("model_select", async (_event, ctx) => {
    updateStatus(ctx);
  });
}
