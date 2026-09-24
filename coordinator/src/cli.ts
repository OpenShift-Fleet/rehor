#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createCompatibilitySink } from "./adapters/compatibility";
import { CoordinatorHealthServer } from "./adapters/health";
import { coordinatorExitCode } from "./cli-result";
import { loadOpenCodeDeploymentConfig } from "./deployment-config";
import { runCoordinator } from "./runner";

interface CliOptions {
  label: string;
  instanceId: string;
  scriptDir: string;
  dataDirectory: string;
  lockPath: string;
  sleepSignalPath: string;
  once: boolean;
  metricsPort: number;
  workspaceRoot: string;
  openCodeCommand: string;
  openCodeExpectedVersion: string;
  deploymentConfigPath?: string;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    return 0;
  }
  await loadDotEnv(resolve(process.env.REHOR_SCRIPT_DIR ?? process.cwd(), ".env"));
  const scriptDirArgument = findOptionValue(argv, "script-dir");
  if (scriptDirArgument !== undefined) await loadDotEnv(resolve(scriptDirArgument, ".env"));
  const options = parseArgs(argv, process.env);
  await loadDotEnv(resolve(options.scriptDir, ".env"));
  const deployment = await loadOpenCodeDeploymentConfig(options.deploymentConfigPath);
  const memoryApiBase = process.env.BOT_MEMORY_URL?.replace(/\/mcp\/?$/, "");
  const compatibility = createCompatibilitySink({
    dataDirectory: options.dataDirectory,
    statusUrl: process.env.BOT_DASHBOARD_URL ?? endpoint(memoryApiBase, "/api/bot-status"),
    costsUrl: process.env.COSTS_API_URL ?? endpoint(memoryApiBase, "/api/costs"),
    cycleRunsUrl: process.env.CYCLE_RUNS_API_URL ?? endpoint(memoryApiBase, "/api/cycle-runs"),
  });
  const health = new CoordinatorHealthServer({
    port: options.metricsPort,
    metrics: compatibility.metricStore,
  });
  await health.start();

  const shutdown = new AbortController();
  const onSignal = (): void => shutdown.abort("process signal");
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    const result = await runCoordinator({
      ...options,
      writers: compatibility.writers,
      compatibility,
      openCodeDeployment: deployment,
      openCodeWorkspaceOwnerUid:
        parseOptionalInteger(process.env.REHOR_WORKSPACE_OWNER_UID) ?? process.getuid?.(),
      policyVersion: process.env.REHOR_POLICY_VERSION,
      environment: process.env,
      shutdownSignal: shutdown.signal,
      onReady: () => health.setReady(true),
      onError: (error, phase) => {
        console.error(`coordinator ${phase} error: ${describe(error)}`);
      },
    });
    console.log(
      JSON.stringify({
        stopReason: result.stopReason,
        cycles: result.cycles,
        results: result.results.length,
        failures: result.failures,
      }),
    );
    return coordinatorExitCode(result, options.once);
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    await health.close();
  }
}

function findOptionValue(argv: readonly string[], key: string): string | undefined {
  const prefix = `--${key}=`;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument?.startsWith(prefix)) return argument.slice(prefix.length);
    if (argument === `--${key}`) return argv[index + 1];
  }
  return undefined;
}

function usage(): string {
  return `Usage: rehor-coordinator [options]

Required:
  --label <label>                 Bot label (or BOT_LABEL)
  --instance-id <id>              Instance ID (or BOT_INSTANCE_ID)

Options:
  --once                          Run one cycle and exit
  --script-dir <path>             Repository/script directory
  --data-dir <path>               Local compatibility output directory
  --metrics-port <port>           Health/readiness/metrics port (default: 9091)
  --workspace-root <path>         Approved OpenCode workspace root
  --opencode-deployment-config <path>
                                   OpenCode deployment JSON
  --opencode-command <path>       OpenCode executable
  --opencode-version <version>    Expected OpenCode version
  -h, --help                      Show this help
`;
}

function parseArgs(argv: readonly string[], environment: NodeJS.ProcessEnv): CliOptions {
  const values = new Map<string, string>();
  let once = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--once") {
      once = true;
      continue;
    }
    if (!argument?.startsWith("--")) throw new Error(`unknown argument: ${argument ?? ""}`);
    const [key, inline] = argument.slice(2).split("=", 2);
    const value = inline ?? argv[++index];
    if (!value) throw new Error(`missing value for --${key}`);
    values.set(key, value);
  }

  const scriptDir = resolve(
    values.get("script-dir") ?? environment.REHOR_SCRIPT_DIR ?? process.cwd(),
  );
  const label = values.get("label") ?? environment.BOT_LABEL;
  const instanceId = values.get("instance-id") ?? environment.BOT_INSTANCE_ID;
  if (!label) throw new Error("--label is required (or set BOT_LABEL)");
  if (!instanceId) throw new Error("--instance-id is required (or set BOT_INSTANCE_ID)");

  const dataDirectory = resolve(
    values.get("data-dir") ?? environment.REHOR_DATA_DIR ?? `${scriptDir}/data`,
  );
  return {
    label,
    instanceId,
    scriptDir,
    dataDirectory,
    lockPath: resolve(
      values.get("lock-path") ?? environment.REHOR_LOCK_PATH ?? `${dataDirectory}/.lock`,
    ),
    sleepSignalPath: resolve(
      values.get("sleep-signal-path") ??
        environment.REHOR_SLEEP_SIGNAL_PATH ??
        `${dataDirectory}/cycle-sleep.json`,
    ),
    once,
    metricsPort: parseInteger(
      values.get("metrics-port") ?? environment.COORDINATOR_METRICS_PORT ?? "9091",
      "metrics-port",
    ),
    workspaceRoot: resolve(
      values.get("workspace-root") ?? environment.REHOR_WORKSPACE_ROOT ?? scriptDir,
    ),
    openCodeCommand:
      values.get("opencode-command") ?? environment.OPENCODE_COMMAND ?? "/usr/local/bin/opencode",
    openCodeExpectedVersion:
      values.get("opencode-version") ?? environment.OPENCODE_EXPECTED_VERSION ?? "1.18.29",
    deploymentConfigPath:
      values.get("opencode-deployment-config") ?? environment.REHOR_OPENCODE_DEPLOYMENT_CONFIG,
  };
}

async function loadDotEnv(path: string): Promise<void> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch {
    return;
  }
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const assignment = trimmed.startsWith("export ") ? trimmed.slice(7) : trimmed;
    const separator = assignment.indexOf("=");
    if (separator <= 0) continue;
    const name = assignment.slice(0, separator).trim();
    let value = assignment.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[name] === undefined) process.env[name] = value;
  }
}

function endpoint(base: string | undefined, path: string): string | undefined {
  return base === undefined ? undefined : `${base.replace(/\/$/, "")}${path}`;
}

function parseInteger(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

function parseOptionalInteger(value: string | undefined): number | undefined {
  return value === undefined ? undefined : parseInteger(value, "REHOR_WORKSPACE_OWNER_UID");
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

main().then(
  (code) => (process.exitCode = code),
  (error: unknown) => {
    console.error(`coordinator startup failed: ${describe(error)}`);
    process.exitCode = 1;
  },
);
