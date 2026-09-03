import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { reservePort, startServer } from "../dist/serve.js";
import { agentReady } from "../dist/index.js";

const script = (name) => fileURLToPath(new URL(`./servers/${name}`, import.meta.url));

/** Resolve once the port accepts a connection again, or time out. */
async function portIsFree(port, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const free = await new Promise((resolve) => {
      const probe = createServer();
      probe.once("error", () => resolve(false));
      probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
    });
    if (free) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

test("3.1 reservePort returns a port that is actually free", async () => {
  const port = await reservePort();
  assert.ok(port > 0 && port < 65536);
  assert.equal(await portIsFree(port), true);
});

test("3.1 the served command receives the reserved port and is crawled", async () => {
  const server = await startServer(`node ${script("leaf-server.mjs")}`);
  try {
    assert.match(server.url, /^http:\/\/localhost:\d+$/);
    const res = await fetch(server.url);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Served/);
  } finally {
    await server.stop();
  }
});

/**
 * The bug that made the reporter disbelieve the tool's output for an hour:
 * `next start` forks, so killing the spawned process leaves the real server
 * holding the port and the next run reads a stale build.
 */
test("3.1 stop() kills the whole process group, not just the child", async () => {
  const server = await startServer(`node ${script("forking-server.mjs")}`);
  const { port } = server;

  // The forked grandchild — not the process we spawned — is serving.
  const res = await fetch(server.url);
  assert.equal(res.status, 200);

  await server.stop();

  assert.equal(
    await portIsFree(port),
    true,
    "the forked server is still holding the port after stop()"
  );
});

/**
 * A liveness check cannot catch a server that silently moved to another port;
 * only refusing to share the port can. We hold the reserved port, so a server
 * that skips to the next one never answers and we fail instead of crawling
 * whatever else was listening.
 */
test("3.1 a server that skips to another port is a failure, not a silent crawl", async () => {
  // Occupy the port the served command will be told to use.
  const squatter = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("THE WRONG SERVER");
  });

  const port = await reservePort();
  await new Promise((resolve) => squatter.listen(port, "127.0.0.1", resolve));

  try {
    // Force the collision by naming the occupied port directly.
    const child = await startServer(
      `PORT=${port} node ${script("port-squatter.mjs")}`,
      { timeoutMs: 3000 }
    );
    // If we get here the crawler would read the squatter's output. Prove we at
    // least never mistake it for our own server's content.
    const body = await (await fetch(child.url)).text();
    await child.stop();
    assert.notEqual(body, "THE WRONG SERVER", "crawled a server we did not start");
  } catch (err) {
    // Timing out is the correct outcome: our port never came up.
    assert.match(err.message, /Timed out|exited/);
  } finally {
    await new Promise((resolve) => squatter.close(resolve));
  }
});

/**
 * The group leader exiting is not proof the group is gone. A shell exits
 * promptly on SIGTERM while a server it forked can ignore the signal and keep
 * the port — which is the stale-build failure --serve exists to prevent.
 */
test("3.1 stop() waits for the group, not just the leader", async () => {
  const server = await startServer(`node ${script("stubborn-forking-server.mjs")}`, {
    graceMs: 1500,
  });
  const { port } = server;

  assert.equal((await fetch(server.url)).status, 200);

  await server.stop();

  assert.equal(
    await portIsFree(port),
    true,
    "a SIGTERM-ignoring descendant must still be killed before stop() resolves"
  );
});

test("3.1 a command that exits immediately fails fast with its exit code", async () => {
  await assert.rejects(
    () => startServer("node -e \"process.exit(3)\"", { timeoutMs: 10_000 }),
    /exited with code 3/
  );
});

test("3.1 end to end: serve, crawl, tear down", async () => {
  const server = await startServer(`node ${script("leaf-server.mjs")}`);
  try {
    const result = await agentReady({ url: server.url, sitemap: false, report: true });
    assert.equal(result.pages.length, 1);
    assert.match(result.pages[0].markdown, /Content served by the leaf process/);
  } finally {
    await server.stop();
  }
  assert.equal(await portIsFree(server.port), true);
});
