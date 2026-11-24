# Architecture

The dispatcher decides when to run work. OpenShell provides an isolated runtime. The coordinator runs one OpenCode V2 cycle and records its outcome.

```mermaid
flowchart TD
 D[Dispatcher] --> P[Registered preflights]
 P -->|Actionable results| S[OpenShell sandbox]
 S --> C[Coordinator and OpenCode V2]
 C --> M[Memory server]
```

| Component | Responsibility |
|---|---|
| [Dispatcher](packages/agent-dispatcher/README.md) | Sync instance profiles, decide whether to launch, coordinate per-agent admission, and clean up sandboxes. |
| [Preflight registry](packages/preflights/README.md) | Validate instance parameters and deterministically check for work before spending model tokens. |
| [OpenShell](docs/openshell-deployment.md) | Create a per-run environment with filesystem and network policy enforced outside the model runtime. |
| [Coordinator](coordinator/README.md) | Consume the one-shot input, prepare runtime configuration, supervise the OpenCode session, and normalize events. |
| [Memory server](docs/team-memory.md) | Persist task state, transcripts, and usage across runs. |
| [Gateway and proxy](docs/agent-proxy-gateways.md) | Authenticate requests and keep upstream vendor credentials outside the sandbox. |

The dispatcher supplies only `start` results to the sandbox; it does not launch on `skip` or `error` alone. The runner consumes the input once without rerunning preflights. See the [cycle contract](docs/bot-workflow-loop.md) and [credential boundaries](docs/dispatcher-secrets.md).
