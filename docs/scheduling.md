# Agent Scheduling

## Dispatcher cadence

The dispatcher checks configured agents at most once every five minutes. Registered preflights determine whether a per-run OpenShell session should start for an eligible agent. A profile without a `schedule:` declaration is always eligible.

## Per-instance schedule windows

An agent profile restricts when the dispatcher may start new sessions by declaring KEDA-style cron windows in `instance/<name>/agent/instance.yaml`:

```yaml
schedule:
  triggers:
    - timezone: Europe/Prague
      start: "0 8 * * 1-5"
      end: "0 18 * * 1-5"
```

- `schedule` is optional. A profile without it is always eligible.
- `triggers` is a non-empty list; each trigger has exactly `timezone`, `start`, and `end`.
- `timezone` is a valid IANA zone name; `start` and `end` are standard five-field cron expressions evaluated in that zone.
- `start` and `end` must differ — identical expressions define no window and are rejected, as in KEDA.
- Unknown keys are rejected, including `desiredReplicas`: the dispatcher is on/off only, there is no warm pool.

Malformed declarations fail closed: profile discovery rejects the whole checkout, exactly like malformed `preflights:`, and the lifecycle log carries the structured diagnostics. Schedule data is dispatcher-side only; it never reaches the input envelope, the sandbox environment, or preflight wiring.

## Window semantics

The dispatcher replicates the [KEDA cron scaler](https://keda.sh/docs/latest/scalers/cron/): for each trigger it computes the next `start` and next `end` occurrence after the current time in the trigger's timezone. The window is active when the next boundary is its own end (`nextEnd < nextStart`). Consequences:

- `start` is inclusive, `end` exclusive: a `0 8`–`0 18` window is active at exactly 08:00 and inactive at exactly 18:00.
- Overnight windows work: `start: "0 22 * * *"`, `end: "0 6 * * *"` is active from 22:00 to 06:00 the next day.
- Multiple triggers OR together: the profile is eligible while any window is active.
- Daylight-saving transitions are resolved by the timezone database; a window spanning a transition evaluates by wall-clock times in the trigger's zone.

### Day-of-week symmetry pitfall

Restrictions must be symmetric in `start` and `end`. With `start: "0 8 * * 1-5"` (weekdays) and `end: "0 18 * * *"` (every day), Friday's next `start` is Monday 08:00 while the next `end` is Saturday 18:00 — the window stays open over the weekend. This is KEDA behavior; the dispatcher evaluates the declaration as written and does not rewrite user configuration.

## Interaction with the cycle

- Schedules gate new dispatches only. A session started inside a window runs to completion after the window closes; the cycle reports `busy` until it drains.
- While a profile is outside every window, the cycle reports `off-schedule` and consumes no preflight cooldown: the first cycle after a window opens dispatches immediately, subject to preflights.
- An absent `schedule` leaves behavior unchanged.

## KEDA integration

Do not add KEDA `ScaledObject` or `SandboxWarmPool` configuration for dispatcher-managed agents; the dispatcher owns scheduling. See [legacy warm-pool scheduling](legacy/scheduling.md) only when maintaining a template-managed deployment.
