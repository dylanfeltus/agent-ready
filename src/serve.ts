import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

/**
 * Boot a site, wait for it, and tear it down again.
 *
 * Two details here are load-bearing and easy to get wrong:
 *
 * - **We choose the port, not the server.** `next start` and friends do not
 *   fail on a busy port; they print a notice and move to the next one. The
 *   child is then alive and serving somewhere else while the crawler reads
 *   whatever was already listening on the port we assumed. A liveness check
 *   cannot catch that — only refusing to share a port can.
 * - **We kill the process group, not the child.** `next start` forks. Killing
 *   the process we spawned leaves the real server holding the port, so the
 *   next run reads a stale build.
 */

export interface ServeHandle {
  url: string;
  port: number;
  stop: () => Promise<void>;
}

/** Ask the OS for a free port and hand it straight to the child. */
export function reservePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close();
        reject(new Error("Could not reserve a port"));
        return;
      }
      const { port } = address;
      probe.close(() => resolvePort(port));
    });
  });
}

/** Poll until the server answers, or give up. */
async function waitForServer(url: string, timeoutMs: number, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no response";

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Server command exited with code ${child.exitCode} before serving ${url}`);
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      // Any answer proves something is listening; 404 on / is still a server.
      if (res.status < 500) return;
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  throw new Error(`Timed out after ${timeoutMs / 1000}s waiting for ${url} (${lastError})`);
}

/** True while any process remains in the group. */
function groupAlive(pid: number): boolean {
  try {
    // Signal 0 performs the permission and existence check without delivering.
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    // ESRCH is the only answer that means "nothing left"; EPERM means
    // something is still there that we merely cannot signal.
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Kill a whole process group, escalating if it does not go quietly.
 *
 * The group leader exiting is NOT proof the group is gone: a shell exits
 * promptly on SIGTERM while a server it forked can ignore the signal and keep
 * the port. So this waits on the group itself rather than on the child, which
 * is the difference between a clean next run and one that reads a stale build.
 */
async function killGroup(child: ChildProcess, graceMs: number): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;

  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      // Negative pid targets the group. The child was spawned detached, so it
      // leads its own group and anything it forked is inside it.
      process.kill(-pid, signal);
    } catch {
      try { child.kill(signal); } catch { /* already gone */ }
    }
  };

  signalGroup("SIGTERM");

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && groupAlive(pid)) await sleep(50);

  if (!groupAlive(pid)) return;

  signalGroup("SIGKILL");
  const hardDeadline = Date.now() + 2_000;
  while (Date.now() < hardDeadline && groupAlive(pid)) await sleep(50);
}

export interface ServeOptions {
  /** Milliseconds to wait for the server to answer. */
  timeoutMs?: number;
  /** Milliseconds between SIGTERM and SIGKILL on teardown. */
  graceMs?: number;
  /** Stream the served command's output. */
  verbose?: boolean;
}

/**
 * Start `command`, wait for it to serve, and return a handle to stop it.
 *
 * The port is passed both as `PORT` in the environment and by substituting
 * `{port}` anywhere in the command, so it works with servers that take it
 * either way.
 */
export async function startServer(
  command: string,
  options: ServeOptions = {}
): Promise<ServeHandle> {
  const { timeoutMs = 60_000, graceMs = 5_000, verbose = false } = options;

  const port = await reservePort();
  const url = `http://localhost:${port}`;
  const resolved = command.replace(/\{port\}/g, String(port));

  const child = spawn(resolved, {
    shell: true,
    // Own process group, so teardown can take the whole tree.
    detached: true,
    stdio: verbose ? "inherit" : "ignore",
    env: { ...process.env, PORT: String(port) },
  });

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await killGroup(child, graceMs);
  };

  // Don't leave an orphaned server behind if we die unexpectedly.
  process.once("exit", () => { void stop(); });

  // Installing a signal listener suppresses Node's default termination, so we
  // have to terminate ourselves. Without this, Ctrl-C would stop the server
  // and let the crawl carry on against it, writing an incomplete mirror and
  // exiting successfully.
  const onSignal = (code: number) => () => {
    void stop().finally(() => process.exit(code));
  };
  process.once("SIGINT", onSignal(130));
  process.once("SIGTERM", onSignal(143));

  try {
    await waitForServer(url, timeoutMs, child);
  } catch (err) {
    await stop();
    throw err;
  }

  return { url, port, stop };
}
