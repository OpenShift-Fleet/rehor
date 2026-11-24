import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  loadOpenCodeProjectConfig,
  validateOpenCodeProjectFile,
} from "../src/runtimes/opencode/project-config";
import { renderOpenCodeConfigForCycle, writeOpenCodeConfig } from "../src/runtimes/opencode/render";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function root() {
  const path = await mkdtemp(join(tmpdir(), "native-frontmatter-"));
  temporary.push(path);
  return path;
}
const markdown = (
  header: string,
  body = "Preserve body exactly.\n\noptions: body text, never metadata.\n",
) => `---\n${header}\n---\n${body}`;
const nativeDeny = 'permissions:\n  - { action: read, resource: "*", effect: deny }';
const render = (path: string, content: string) =>
  renderOpenCodeConfigForCycle(
    { model: "m", allowedTools: ["Read"] },
    "p",
    {},
    { settings: {}, files: [{ path, content }] },
  );

it("preserves native agent/command bodies and CRLF/BOM bytes through loading and staging", async () => {
  const directory = await root();
  await mkdir(join(directory, ".opencode/agents"), { recursive: true });
  await mkdir(join(directory, ".opencode/commands"), { recursive: true });
  const agent = `\uFEFF${markdown(`description: Review changes\nmode: subagent\nmodel: provider/model#high\nsteps: 3\nrequest:\n  body: { temperature: 0.2 }\n${nativeDeny}`).replaceAll("\n", "\r\n")}`;
  const command = markdown(
    "description: Review changes\nagent: reviewer\nmodel: { providerID: provider, model: model, variant: high }\nsubagent: true",
    "Review $ARGUMENTS.\n",
  );
  await writeFile(join(directory, ".opencode/agents/reviewer.md"), agent);
  await writeFile(join(directory, ".opencode/commands/review.md"), command);
  const captured = await loadOpenCodeProjectConfig(directory);
  const rendered = renderOpenCodeConfigForCycle({ model: "m" }, "p", {}, captured);
  const staged = await writeOpenCodeConfig(join(directory, "state"), rendered);
  expect(await readFile(join(staged.globalConfigDirectory, "agents/reviewer.md"), "utf8")).toBe(
    agent,
  );
  expect(await readFile(join(staged.globalConfigDirectory, "commands/review.md"), "utf8")).toBe(
    command,
  );
});

it("rejects native permissions plus legacy options before startup, including every staging entry point", async () => {
  const directory = await root();
  const file = { path: "agents/reviewer.md", content: markdown(`${nativeDeny}\noptions: {}`) };
  await mkdir(join(directory, ".opencode/agents"), { recursive: true });
  await writeFile(join(directory, ".opencode/agents/reviewer.md"), file.content);
  await expect(loadOpenCodeProjectConfig(directory)).rejects.toThrow(
    /agents\/reviewer\.md.*options/s,
  );
  expect(() => render(file.path, file.content)).toThrow(/agents\/reviewer\.md.*options/s);
  const valid = render("agents/reviewer.md", markdown(nativeDeny));
  await expect(
    writeOpenCodeConfig(join(directory, "state"), { ...valid, projectFiles: [file] }),
  ).rejects.toThrow(/agents\/reviewer\.md.*options/s);
  await expect(lstat(join(directory, "state"))).rejects.toMatchObject({ code: "ENOENT" });
});

it.each([
  "options: {}",
  "permission: { read: deny }",
  "tools: { read: false }",
  "variant: high",
  "name: reviewer",
  "prompt: Review",
  "temperature: 0.1",
  "disable: true",
  "unknown: false",
  "mode: invalid",
  "mode: [subagent]",
  "steps: 0",
  'hidden: "false"',
  "system: 12",
  "description: [review]",
  "color: red",
  "model: bare-model",
  "permissions: { read: deny }",
  "permissions: [deny]",
  "permissions: null",
  'permissions: [{ action: read, resource: "*", effect: maybe }]',
  'permissions: [{ action: read, resource: "*", effect: false }]',
  'permissions: [{ action: read, resource: "*", effect: [deny] }]',
  'permissions: [{ action: 1_000, resource: "*", effect: deny }]',
  "permissions: [{ action: read, resource: 1_000, effect: deny }]",
  "permissions: [{ action: read, effect: deny }]",
  'permissions: [{ action: read, resource: "*", effect: deny, extra: true }]',
  'permissions: [{ action: bash, resource: "*", effect: deny }]',
  "request: { body: [] }",
  "request: { headers: { Example: 1 } }",
  "description: 2026-10-21",
  "request: { body: { deadline: 2026-10-21 } }",
  "request: { body: { value: .nan } }",
])("rejects invalid/mixed agent frontmatter with filename: %s", (header) => {
  expect(() => render("agents/nested/reviewer.md", markdown(header))).toThrow(
    ".opencode/agents/nested/reviewer.md",
  );
});

it.each([
  "description: !custom value",
  "description: !!str value",
  "description: !!timestamp 2026-10-21",
  "permissions: &rules []",
  "permissions: *rules",
  "request: { body: { <<: { value: true } } }",
  "description: first\ndescription: second",
  'permissions: [{ action: read, resource: "*", effect: deny, effect: allow }]',
  "description: unquoted: colon",
  "%YAML 1.1\ndescription: directive",
  "false",
  "null",
  "[agent]",
  "12",
  "description: [broken",
])("rejects malformed, tagged or ambiguous YAML: %s", (header) => {
  expect(() => render("agents/reviewer.md", markdown(header))).toThrow(
    ".opencode/agents/reviewer.md",
  );
});

it.each([
  "subtask: true",
  "options: {}",
  "permissions: []",
  "variant: high",
  "template: {}",
  "subagent: yes",
  "agent: [reviewer]",
  "model: { providerID: p, model: m, unknown: true }",
])(
  "validates native command frontmatter without body overriding invalid metadata: %s",
  (header) => {
    expect(() => render("commands/review.md", markdown(header))).toThrow(
      ".opencode/commands/review.md",
    );
  },
);

it("requires closed plain frontmatter and bounded YAML size/depth/nodes", () => {
  for (const content of [
    "---\npermissions: []",
    "---yaml\nmode: primary\n---\nBody",
    markdown(`request: { body: { deep: ${"[".repeat(70)}null${"]".repeat(70)} } }`),
    markdown(`description: ${"x".repeat(256 * 1024)}`),
    markdown(`request: { body: { nodes: [${Array(21000).fill("null").join(",")}] } }`),
  ]) {
    expect(() => render("agents/reviewer.md", content)).toThrow(".opencode/agents/reviewer.md");
  }
});

it("accepts native empty/no frontmatter and keeps YAML-looking body text untouched", () => {
  for (const content of [
    markdown(""),
    "Review only.\n",
    markdown("# comment only"),
    markdown(nativeDeny),
  ]) {
    expect(() =>
      validateOpenCodeProjectFile({ path: "agents/reviewer.md", content }),
    ).not.toThrow();
  }
  expect(() => render("commands/review.md", "Review $ARGUMENTS.\n")).not.toThrow();
});
