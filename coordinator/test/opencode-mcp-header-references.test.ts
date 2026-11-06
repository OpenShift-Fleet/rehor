import { describe, expect, it } from "vitest";
import { renderOpenCodeConfigForCycle } from "../src/runtimes/opencode/render";
import type { JsonObject } from "../src/runtimes/opencode/types";

const marker = "Bearer openshell:resolve:env:v1_MEMORY_TOKEN";
const render = (settings: JsonObject) =>
  renderOpenCodeConfigForCycle({ model: "m" }, "p", {}, { settings, files: [] });
const remote = (headers: JsonObject, url = "https://example.test/mcp"): JsonObject => ({
  mcp: { servers: { "memory.server": { type: "remote", url, headers } } },
});

describe("profile MCP header references", () => {
  it("accepts an exact marker in a direct, case-insensitive Authorization header for a dotted server name", () => {
    const settings = remote({ aUtHoRiZaTiOn: marker }, "{env:JIRA_MCP_URL}");
    const rendered = render(settings);
    expect(rendered.profileConfig).toMatchObject(settings);
    expect(JSON.parse(rendered.enforcementJson)).toMatchObject(settings);
  });

  it.each([
    "Bearer actual-secret",
    "bearer openshell:resolve:env:MEMORY_TOKEN",
    "Bearer  openshell:resolve:env:MEMORY_TOKEN",
    "Bearer openshell:resolve:env:",
    "Bearer openshell:resolve:env:MEMORY-TOKEN",
    `${marker}\n`,
    `${marker}extra!`,
    "{env:JIRA_MCP_URL}",
    "${JIRA_MCP_URL}",
    "{file:/tmp/token}",
  ])("rejects invalid Authorization value %j", (value) => {
    expect(() => render(remote({ Authorization: value }))).toThrow();
  });

  it.each<JsonObject>([
    remote({ "X-Authorization": marker }),
    remote({ Authorization: [marker] }),
    remote({ nested: { Authorization: marker } }),
    {
      mcp: {
        servers: [
          { type: "remote", url: "https://example.test", headers: { Authorization: marker } },
        ],
      },
    },
    { mcp: { servers: { memory: [{ type: "remote", headers: { Authorization: marker } }] } } },
    {
      mcp: {
        servers: {
          memory: { type: "local", command: ["server"], headers: { Authorization: marker } },
        },
      },
    },
    {
      mcp: {
        servers: {
          memory: {
            type: "remote",
            url: "https://example.test",
            timeout: { headers: { Authorization: marker } },
          },
        },
      },
    },
    { formatter: { mcp: { servers: { memory: { headers: { Authorization: marker } } } } } },
    { formatter: { headers: [{ Authorization: marker }] } },
  ])("rejects marker in spoofed or non-MCP structures %#", (settings) => {
    expect(() => render(settings)).toThrow();
  });

  it.each<JsonObject>([
    { watcher: { nested: { token: "literal-secret" } } },
    { watcher: { nested: [{ password: "literal-secret" }] } },
    { watcher: { nested: { value: "{env:JIRA_MCP_URL}" } } },
    { watcher: { nested: { value: "${JIRA_MCP_URL}" } } },
    { watcher: { nested: { value: "{file:/tmp/value}" } } },
    remote({}, "{env:GH_TOKEN}"),
    remote({}, "{file:/tmp/url}"),
    {
      mcp: {
        servers: { memory: { type: "local", command: ["server"], environment: { token: marker } } },
      },
    },
  ])("retains recursive credential and reference rejection %#", (settings) => {
    expect(() => render(settings)).toThrow();
  });
});
