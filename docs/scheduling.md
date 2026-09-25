# Bot Scheduling

How to auto-scale your bot instance on a time-based schedule using KEDA. This lets you run the bot only during business hours and save compute costs overnight and on weekends.

## KEDA Cron Scaler

Scale your OpenShell `SandboxWarmPool` to 1 replica during a configured time window and 0 outside it. Uses [KEDA](https://keda.sh/). KEDA is already installed on shared platform clusters; standalone namespaces must install it.

### What it does

- Scales the `SandboxWarmPool` to `desiredReplicas` during the configured window
- Outside the window, scales to `minReplicaCount: 0` — the pod is completely stopped
- No compute costs outside working hours
- KEDA owns `SandboxWarmPool` replica count; `BOT_REPLICAS` is the initial/off-hours baseline.

### Adding to your deploy template

Add a `ScaledObject` resource to `deploy/template.yaml`, after the `SandboxWarmPool`:

```yaml
# --- Cron Scaler ---
- apiVersion: keda.sh/v1alpha1
  kind: ScaledObject
  metadata:
    name: ${BOT_NAME}-cron-scaler
    labels:
      app.kubernetes.io/name: ${BOT_NAME}
      app.kubernetes.io/part-of: devbot
  spec:
    scaleTargetRef:
       apiVersion: extensions.agents.x-k8s.io/v1beta1
      kind: SandboxWarmPool
      name: ${BOT_NAME}
    minReplicaCount: 0
    maxReplicaCount: 1
    triggers:
    - type: cron
      metadata:
        timezone: "Europe/Prague"
        start: "0 9 * * 1-5"
        end: "0 23 * * 1-5"
        desiredReplicas: "1"
```

The `triggers` section is where you define when the bot runs. Each trigger has:

| Field | Description |
|-------|-------------|
| `timezone` | IANA timezone (e.g. `Europe/Prague`, `America/New_York`, `US/Eastern`) |
| `start` | Cron expression — when to scale **up** |
| `end` | Cron expression — when to scale **down** |
| `desiredReplicas` | How many replicas during the window (always `"1"` for bot instances) |

The cron format is standard 5-field: `minute hour day-of-month month day-of-week` where day-of-week is 0=Sunday through 6=Saturday.

---

### Schedule examples

#### Business hours, Monday–Friday

The framework instance uses this — bot runs 9:00–23:00 Prague time on weekdays:

```yaml
triggers:
- type: cron
  metadata:
    timezone: "Europe/Prague"
    start: "0 9 * * 1-5"
    end: "0 23 * * 1-5"
    desiredReplicas: "1"
```

#### US East Coast working hours

9am–6pm ET, weekdays only:

```yaml
triggers:
- type: cron
  metadata:
    timezone: "America/New_York"
    start: "0 9 * * 1-5"
    end: "0 18 * * 1-5"
    desiredReplicas: "1"
```

#### 24/7 weekdays, off on weekends

Run all day Monday through Friday, off Saturday and Sunday:

```yaml
triggers:
- type: cron
  metadata:
    timezone: "UTC"
    start: "0 0 * * 1"
    end: "0 0 * * 6"
    desiredReplicas: "1"
```

#### Mondays only

Bot runs only on Mondays, 8am–5pm:

```yaml
triggers:
- type: cron
  metadata:
    timezone: "America/New_York"
    start: "0 8 * * 1"
    end: "0 17 * * 1"
    desiredReplicas: "1"
```

#### Weekdays with reduced weekend hours

Full hours on weekdays, shorter window on weekends. Use multiple triggers — if any trigger's window is active, the bot scales up:

```yaml
triggers:
- type: cron
  metadata:
    timezone: "America/New_York"
    start: "0 8 * * 1-5"
    end: "0 18 * * 1-5"
    desiredReplicas: "1"
- type: cron
  metadata:
    timezone: "America/New_York"
    start: "0 10 * * 0,6"
    end: "0 14 * * 0,6"
    desiredReplicas: "1"
```

#### Morning and afternoon blocks (skip lunch)

Two separate windows per day:

```yaml
triggers:
- type: cron
  metadata:
    timezone: "Europe/Prague"
    start: "0 8 * * 1-5"
    end: "0 12 * * 1-5"
    desiredReplicas: "1"
- type: cron
  metadata:
    timezone: "Europe/Prague"
    start: "0 13 * * 1-5"
    end: "0 18 * * 1-5"
    desiredReplicas: "1"
```

---

### How multiple triggers work

KEDA evaluates all triggers independently. If **any** trigger's window is active, the bot scales up. The bot only scales to 0 when **no** trigger is active. This means triggers are effectively OR'd together — you can combine them to build complex schedules.

### Timezone and DST

KEDA cron triggers use a single [IANA timezone](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones) per trigger. DST transitions are handled automatically within that timezone — if you set `Europe/Prague`, the schedule shifts with CET/CEST automatically.

If your team spans multiple timezones, pick the primary one and document the effective hours for others. Different triggers can use different timezones if needed.

---

## App-interface requirements

Your SaaS file (`deploy.yml`) must include OpenShell and KEDA resources in `managedResourceTypes`:

```yaml
managedResourceTypes:
- SandboxTemplate.agents.x-k8s.io
- SandboxWarmPool.agents.x-k8s.io
- NetworkPolicy
- ScaledObject.keda.sh      # required for KEDA
```

Without these, app-interface will prune the OpenShell resources or ScaledObject on the next sync.

The namespace file (`namespaces/*.yml`) must also allow it — either `managedResourceTypes: []` (allow all, which is the default) or explicitly list `ScaledObject.keda.sh`.

## Reference

- [Framework instance PR](https://github.com/RedHatInsights/hcc-framework-agent-dev/pull/7) — first implementation
- [KEDA cron trigger docs](https://keda.sh/docs/latest/scalers/cron/)
