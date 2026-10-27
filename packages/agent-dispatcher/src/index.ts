console.log("Hello from @rehor/agent-dispatcher");

const keepAlive = setInterval(() => {}, 60_000);
let shuttingDown = false;

const shutdown = (): void => {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  clearInterval(keepAlive);
  process.exitCode = 0;
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
