import { createPreflightRunContext } from "../dist/index.js";

/**
 * Fixture wiring for the obsint preflight tests: plain-object client fakes
 * implementing the engine client interfaces (the run context accepts
 * already-built clients through its structural checks), plus a run-context
 * factory that wires only the clients a test supplies. Zero network.
 */

/** A memory-server client fake with call recording. */
export function fakeMemory({ tasks = [], memories = [] } = {}) {
  const calls = { listedTags: [], deletedMemories: [], archivedTasks: [] };
  return {
    calls,
    getTasks: async () => tasks,
    getCapacity: async () => ({ active: 0, max: 10 }),
    getTaskByKey: async () => undefined,
    getActiveTasks: async () => [],
    listMemories: async (tag, limit = 100) => {
      calls.listedTags.push({ tag, limit });
      return memories.filter((record) => record.tags.includes(tag));
    },
    deleteMemory: async (id) => {
      calls.deletedMemories.push(id);
    },
    archiveTask: async (externalKey) => {
      calls.archivedTasks.push(externalKey);
    },
  };
}

/** An in-memory persistent state store fake with call recording. */
export function fakePersistentState(initial = {}) {
  const store = new Map(Object.entries(initial));
  const calls = { reads: [], writes: [], deletes: [] };
  return {
    calls,
    get: async (key) => {
      calls.reads.push(key);
      return store.get(key);
    },
    set: async (key, value) => {
      calls.writes.push({ key, value });
      store.set(key, value);
    },
    delete: async (key) => {
      calls.deletes.push(key);
      store.delete(key);
    },
    has: async (key) => store.has(key),
  };
}

/** A Jenkins client fake with call recording. */
export function fakeJenkins({ jobs = null, details = new Map(), errors = [] } = {}) {
  const calls = { buildDetails: [], allJobsCalls: [] };
  const instances = {
    qe: { url: "https://jenkins-qe.example.invalid", prefix: "/job/ccx" },
    idp: { url: "https://jenkins-idp.example.invalid", prefix: "" },
  };
  return {
    calls,
    instances,
    errors,
    getAllJobs: async (nBuilds = 7) => {
      calls.allJobsCalls.push(nBuilds);
      return jobs === null ? null : { jobs };
    },
    getJobBuilds: async () => null,
    getBuildDetail: async (job, buildNum) => {
      calls.buildDetails.push(`${job}:${buildNum}`);
      return (
        details.get(`${job}:${buildNum}`) ?? {
          build: buildNum,
          stages: [],
        }
      );
    },
    instanceForJob: (job) => (job.startsWith("internal-pipeline") ? "idp" : "qe"),
  };
}

/** A Slack client fake with call recording. */
export function fakeSlack({ ok = true } = {}) {
  const calls = { sent: [], sentTo: [] };
  return {
    calls,
    send: async (text) => {
      calls.sent.push(text);
      return ok;
    },
    sendTo: async (channel, text) => {
      calls.sentTo.push({ channel, text });
      return ok;
    },
  };
}

/** A Jira client fake with JQL recording and optional update failures. */
export function fakeJira({ issues = [], byKey = {}, updateOk = true } = {}) {
  const calls = { jqls: [], fields: [], updated: [] };
  return {
    calls,
    searchIssues: async (jql, options = {}) => {
      calls.jqls.push(jql);
      calls.fields.push(options.fields);
      return typeof issues === "function" ? issues(jql, options) : issues;
    },
    getIssue: async (key) => byKey[key] ?? { key, fields: {} },
    getIssueComments: async () => [],
    getIssueWithComments: async (key) => byKey[key] ?? { key, fields: {} },
    updateIssue: async (key, fields) => {
      calls.updated.push({ key, fields });
      if (!updateOk) {
        throw new Error("jira update failed");
      }
    },
  };
}

/** A GitHub client fake with call recording. */
export function fakeGithub({ files = new Map(), prs = new Map(), prFailures = new Set() } = {}) {
  const calls = { files: [], prs: [] };
  return {
    calls,
    route: "https://proxy.example/github",
    getPr: async (ownerRepo, number) => {
      calls.prs.push(`${ownerRepo}#${number}`);
      const key = `${ownerRepo}#${number}`;
      if (prFailures.has(key)) {
        throw new Error(`github unreachable for ${key}`);
      }
      return prs.get(key) ?? null;
    },
    getPrComments: async () => [],
    listMergedPrs: async () => [],
    listRepoFiles: async () => [],
    getFileContents: async (ownerRepo, path, ref) => {
      calls.files.push({ ownerRepo, path, ref });
      return files.get(path) ?? null;
    },
  };
}

/**
 * A run context wired only to the supplied client fakes. Omitted clients
 * stay undefined so wiring-failure paths can be exercised.
 */
export function obsintContext({ memory, jira, jenkins, slack, persistentState, proxy } = {}) {
  const options = {
    instanceId: "obsint-test",
    memory: memory ?? fakeMemory(),
  };
  if (jira !== undefined) options.jira = jira;
  if (jenkins !== undefined) options.jenkins = jenkins;
  if (slack !== undefined) options.slack = slack;
  if (persistentState !== undefined) options.persistentState = persistentState;
  if (proxy !== undefined) options.proxy = proxy;
  return createPreflightRunContext(options);
}

/** A Jenkins build record. */
export const build = (number, result) => ({ number, result });

/** A Jenkins job record with its derived lastBuild/lastFailedBuild refs. */
export const job = (
  name,
  { color = "blue", builds = [], instance = "qe", lastFailedNumber } = {},
) => ({
  name,
  color,
  instance,
  builds,
  lastBuild: builds.length > 0 ? { number: builds[0].number } : undefined,
  lastFailedBuild:
    lastFailedNumber !== undefined
      ? { number: lastFailedNumber }
      : builds.some((entry) => entry.result === "FAILURE")
        ? { number: builds.find((entry) => entry.result === "FAILURE").number }
        : undefined,
});
