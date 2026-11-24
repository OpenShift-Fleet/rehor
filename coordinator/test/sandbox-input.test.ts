import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  loadSandboxInput,
  MAX_INPUT_BYTES,
  resolveCoordinatorEnvironment,
  resolveSandboxInputMode,
  SandboxInputModeError,
  type SandboxInputOutcome,
} from "../src/sandbox-input";

const runId = "01234567-89ab-cdef-0123-456789abcdef";
const secretPrompt = "secret-prompt-content-0123";

function envelope(prompt = secretPrompt): Record<string, unknown> {
  return {
    schemaVersion: 1,
    runId,
    prompt,
    metadata: {
      action: "start",
      scripts: [{ name: "01-test.py", status: "start" }],
    },
  };
}

function serialized(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), "utf8");
}

async function writeInput(directory: string, content: Buffer): Promise<string> {
  const path = join(directory, "rehor-input.json");
  await writeFile(path, content);
  return path;
}

function load(path: string): Promise<SandboxInputOutcome> {
  return loadSandboxInput({ REHOR_INPUT_SOURCE: "sandbox", REHOR_INPUT_FILE: path });
}

describe("sandbox input mode", () => {
  it("treats unset, empty, and legacy as the legacy polling loop", () => {
    expect(resolveSandboxInputMode({})).toBe("legacy");
    expect(resolveSandboxInputMode({ REHOR_INPUT_SOURCE: "" })).toBe("legacy");
    expect(resolveSandboxInputMode({ REHOR_INPUT_SOURCE: "legacy" })).toBe("legacy");
    expect(resolveSandboxInputMode({ REHOR_INPUT_SOURCE: "sandbox" })).toBe("sandbox");
  });

  it("rejects any other source value", () => {
    for (const value of ["kubernetes", "file", "SANDBOX", "sandbox "]) {
      expect(() => resolveSandboxInputMode({ REHOR_INPUT_SOURCE: value })).toThrow(
        SandboxInputModeError,
      );
    }
  });
});

describe("coordinator environment", () => {
  it("maps the sandbox memory placeholder onto the model proxy token", () => {
    const environment = resolveCoordinatorEnvironment("sandbox", {
      BOT_MEMORY_TOKEN: "openshell:resolve:env:BOT_MEMORY_TOKEN",
      BOT_MEMORY_URL: "https://memory.example.test/mcp",
      REHOR_MODEL_PROXY_TOKEN: "ambient-deployment-value",
      BOT_LABEL: "onboarding-test",
    });
    expect(environment).toEqual({
      BOT_MEMORY_TOKEN: "openshell:resolve:env:BOT_MEMORY_TOKEN",
      BOT_MEMORY_URL: "https://memory.example.test/mcp",
      REHOR_MODEL_PROXY_TOKEN: "openshell:resolve:env:BOT_MEMORY_TOKEN",
      BOT_LABEL: "onboarding-test",
    });
  });

  it("keeps legacy mode and sandbox mode without a placeholder unchanged", () => {
    const legacy = { REHOR_MODEL_PROXY_TOKEN: "ambient-value", BOT_MEMORY_TOKEN: "token" };
    expect(resolveCoordinatorEnvironment("legacy", legacy)).toBe(legacy);
    expect(resolveCoordinatorEnvironment("legacy", {})).toEqual({});

    const tokenless = { REHOR_MODEL_PROXY_TOKEN: "ambient-value" };
    expect(resolveCoordinatorEnvironment("sandbox", tokenless)).toBe(tokenless);
    expect(resolveCoordinatorEnvironment("sandbox", {})).toEqual({});
  });
});

describe("sandbox input loader", () => {
  it("accepts a valid envelope", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rehor-sandbox-input-"));
    const path = await writeInput(directory, serialized(envelope("do the work")));
    const outcome = await load(path);
    expect(outcome).toEqual({ status: "ok", runId, prompt: "do the work" });
  });

  it("enforces the byte limit, not the character count", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rehor-sandbox-input-"));
    const base = serialized(envelope("")).byteLength;
    const remaining = MAX_INPUT_BYTES - base;
    expect(remaining).toBeGreaterThan(0);
    // "€" encodes to 3 UTF-8 bytes; pad the remainder with 1-byte characters so
    // the complete serialized envelope is exactly MAX_INPUT_BYTES bytes.
    const prompt = "a".repeat(remaining % 3) + "€".repeat(Math.floor(remaining / 3));
    const exact = await writeInput(directory, serialized(envelope(prompt)));
    expect((await stat(exact)).size).toBe(MAX_INPUT_BYTES);
    expect(prompt.length).toBeLessThan(MAX_INPUT_BYTES);
    await expect(load(exact)).resolves.toEqual({ status: "ok", runId, prompt });

    const oneOver = await writeInput(directory, serialized(envelope(`${prompt}a`)));
    await expect(load(oneOver)).resolves.toMatchObject({ status: "error" });
  });

  it("skips on an empty or whitespace-only prompt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rehor-sandbox-input-"));
    for (const prompt of ["", " \n\t "]) {
      const path = await writeInput(directory, serialized(envelope(prompt)));
      await expect(load(path)).resolves.toEqual({ status: "skip" });
    }
  });

  it("fails closed on a missing file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rehor-sandbox-input-"));
    await expect(load(join(directory, "missing.json"))).resolves.toMatchObject({
      status: "error",
    });
  });

  it("fails closed on an unreadable path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rehor-sandbox-input-"));
    const notAFile = join(directory, "not-a-file");
    await mkdir(notAFile);
    await expect(load(notAFile)).resolves.toMatchObject({ status: "error" });
  });

  it("fails closed on invalid UTF-8", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rehor-sandbox-input-"));
    const path = await writeInput(directory, Buffer.from([0xff, 0xfe, 0x7b]));
    await expect(load(path)).resolves.toMatchObject({ status: "error" });
  });

  it("fails closed on malformed JSON", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rehor-sandbox-input-"));
    const path = await writeInput(directory, serialized(envelope()).subarray(0, 20));
    await expect(load(path)).resolves.toMatchObject({ status: "error" });
  });

  it("fails closed on a non-object envelope", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rehor-sandbox-input-"));
    const path = await writeInput(directory, Buffer.from('["schemaVersion",1]', "utf8"));
    await expect(load(path)).resolves.toMatchObject({ status: "error" });
  });

  it("fails closed on an unsupported schema version", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rehor-sandbox-input-"));
    const value = envelope();
    value.schemaVersion = 2;
    await expect(load(await writeInput(directory, serialized(value)))).resolves.toMatchObject({
      status: "error",
    });
  });

  it("fails closed on a non-UUID runId", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rehor-sandbox-input-"));
    const value = envelope();
    value.runId = "not-a-uuid";
    await expect(load(await writeInput(directory, serialized(value)))).resolves.toMatchObject({
      status: "error",
    });
  });

  it("fails closed on a non-string prompt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rehor-sandbox-input-"));
    const value = envelope();
    value.prompt = 42;
    await expect(load(await writeInput(directory, serialized(value)))).resolves.toMatchObject({
      status: "error",
    });
  });

  it("fails closed on metadata that is not a start decision", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rehor-sandbox-input-"));
    const value = envelope();
    (value.metadata as Record<string, unknown>).action = "skip";
    await expect(load(await writeInput(directory, serialized(value)))).resolves.toMatchObject({
      status: "error",
    });
  });

  it("fails closed on malformed metadata script entries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rehor-sandbox-input-"));
    for (const metadata of [
      null,
      { action: "start" },
      { action: "start", scripts: "01-test.py" },
      { action: "start", scripts: ["01-test.py"] },
      { action: "start", scripts: [{ name: "01-test.py", status: "running" }] },
      { action: "start", scripts: [{ name: 1, status: "start" }] },
    ]) {
      const value = envelope();
      value.metadata = metadata;
      await expect(load(await writeInput(directory, serialized(value)))).resolves.toMatchObject({
        status: "error",
      });
    }
  });

  it("never includes prompt content in error reasons", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rehor-sandbox-input-"));
    const truncated = await writeInput(
      directory,
      serialized(envelope(secretPrompt)).subarray(0, 30),
    );
    const outcome = await load(truncated);
    expect(outcome).toMatchObject({ status: "error" });
    expect(JSON.stringify(outcome)).not.toContain(secretPrompt);

    const oversized = await writeInput(
      directory,
      serialized(envelope(secretPrompt + "x".repeat(70_000))),
    );
    const oversizedOutcome = await load(oversized);
    expect(oversizedOutcome).toMatchObject({ status: "error" });
    expect(JSON.stringify(oversizedOutcome)).not.toContain(secretPrompt);
  });
});
