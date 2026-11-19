# Cost Report

Generate a cost report for the dev bot's cycles.

## Data source

Cost data is stored in `costs.jsonl` in the project root. Each line is a JSON object with:
- `timestamp` — ISO 8601 UTC timestamp
- `label` — the primary label used for the cycle
- `session_id` — Claude session ID
- `num_turns` — number of tool calls in the cycle
- `duration_ms` — wall-clock duration
- `cost_usd` — total cost in USD
- `input_tokens`, `output_tokens` — token counts
- `cache_read_tokens`, `cache_write_tokens` — prompt cache stats
- `model` — model used
- `is_error` — whether the cycle errored
- `no_work` — whether the cycle found no work (idle)

If `costs.jsonl` doesn't exist or is empty, backfill it from `bot.log`:
```bash./costs.sh backfill
```

## What to report

1. **Summary table** — one row per cycle with date, turns, duration, output tokens, cost, and label.
2. **Daily totals** — if data spans multiple days, show per-day cost and cycle count.
3. **Breakdown by type** — separate active cycles (did work) vs idle cycles (no work found). Show the cost split.
4. **Top 5 most expensive cycles** — with session ID so they can be investigated.
5. **Averages** — cost per cycle, cost per active cycle, cost per idle cycle, average turns.
6. **Cache efficiency** — ratio of cache reads to cache writes. Higher is better (means more prompt reuse).

## Quick commands

```bash
# All cycles./costs.sh

# Today only./costs.sh today

# Specific date./costs.sh 2026-03-31

# Last 7 days./costs.sh week
```
