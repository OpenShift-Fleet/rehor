import { createPreflightRunContext } from "../dist/index.js";

/**
 * Fixture wiring for the obsint preflight tests: plain-object client fakes
 * implementing the engine client interfaces (the run context accepts
 * already-built clients through its structural checks), plus a run-context
 * factory that wires only the clients a test supplies. Zero network.
 */

/** A memory-server client fake with call recording. */
export function fakeMemory({ tasks = [], memories = [] } = {}) {
  const calls = { deletedMemories: [], archivedTasks: [] };
  return {
    calls,
    getTasks: async () => tasks,
    getCapacity: async () => ({ active: 0, max: 10 }),
    getTaskByKey: async () => undefined,
    getActiveTasks: async () => [],
    listMemories: async (tag) => memories.filter((record) => record.tags.includes(tag)),
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
  const calls = { reads: [], writes: [] };
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
      store.delete(key);
    },
    has: async (key) => store.has(key),
  };
}

/** A Jenkins client fake with configurable job and build responses. */
export function fakeJenkins({ jobs = null, details = new Map(), errors = [] } = {}) {
  const instances = {
    qe: { url: "https://jenkins-qe.example.invalid", prefix: "/job/ccx" },
    idp: { url: "https://jenkins-idp.example.invalid", prefix: "" },
  };
  return {
    instances,
    errors,
    getAllJobs: async () => (jobs === null ? null : { jobs }),
    getJobBuilds: async () => null,
    getBuildDetail: async (job, buildNum) =>
      details.get(`${job}:${buildNum}`) ?? { build: buildNum, stages: [] },
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

/** A Jira client fake with search and update recording. */
export function fakeJira({ issues = [] } = {}) {
  const calls = { jqls: [], updated: [] };
  return {
    calls,
    searchIssues: async (jql) => {
      calls.jqls.push(jql);
      return issues;
    },
    getIssue: async (key) => ({ key, fields: {} }),
    getIssueComments: async () => [],
    getIssueWithComments: async (key) => ({ key, fields: {} }),
    updateIssue: async (key, fields) => {
      calls.updated.push({ key, fields });
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
export function obsintContext({ memory = fakeMemory(), ...clients } = {}) {
  return createPreflightRunContext({
    instanceId: "obsint-test",
    memory,
    ...clients,
  });
}

/** A Jenkins build record. */
export const build = (number, result) => ({ number, result });

/** A Jenkins job record with its derived lastBuild/lastFailedBuild refs. */
export function job(name, { color = "blue", builds = [] } = {}) {
  const lastFailed = builds.find(({ result }) => result === "FAILURE");
  return {
    name,
    color,
    instance: "qe",
    builds,
    lastBuild: builds.length > 0 ? { number: builds[0].number } : undefined,
    lastFailedBuild: lastFailed && { number: lastFailed.number },
  };
}
