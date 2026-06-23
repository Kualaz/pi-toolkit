# pi-fast-mode

Pi extension that registers `/fast` to toggle OpenAI fast mode on and off, plus `/fast-bench` to benchmark default vs priority service tier on the currently selected Pi model.

When enabled, compatible OpenAI provider payloads are patched right before the request is sent:

```json
{
  "service_tier": "priority"
}
```

This mirrors Codex's fast-mode behavior, where `ServiceTier::Fast` is sent to OpenAI as the `priority` service tier.

## Usage

```bash
pi -e ./pi-fast-mode
# or install it:
pi install ./pi-fast-mode
```

Then in Pi:

```text
/fast
```

Run `/fast` again to disable it.

The toggle is persisted in the current session branch. Fast mode only applies to detected OpenAI-compatible service-tier models; for other providers it stays enabled but inactive until you switch to a compatible model.

## Benchmarking

Use `/fast-bench` from inside Pi. It uses the currently selected Pi model and auth, sends direct provider requests through Pi's provider implementation, and compares unchanged payloads against payloads patched with `service_tier: "priority"`.

```text
/fast-bench
/fast-bench 30 --warmup 2
/fast-bench 30 --warmup 2 --csv fast-bench.csv "Reply with exactly: OK"

# Better for testing claimed inference throughput, not just queue/TTFB latency:
/fast-bench 20 --warmup 2 --max-tokens 1024 --timeout 240000 --csv fast-throughput.csv "Write a 700 word plain-text explanation of merge sort. Do not use markdown."
```

Short prompts like `Reply with exactly: OK` mostly measure routing, queueing, and first-token latency. For claimed inference-speed improvements, use a longer output and compare the `generation tok/s` rows and CSV columns.

Options:

```text
--runs, --n, -n <n>        measured runs per tier (default 10)
--warmup <n>               warmup runs per tier, excluded from stats (default 0)
--max-tokens <n>           max output tokens per request (default 16)
--delay <ms>               delay between requests (default 500)
--timeout <ms>             per-request timeout (default 120000)
--transport <mode>         sse|auto|websocket|websocket-cached (default sse)
--csv <path>               write raw samples as CSV
```
