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

/** Kill a whole process group, escalating if it does not go quietly. */
function killGroup(child: ChildProcess, graceMs: number): Promise<void> {
  return new Promise((resolveKill) => {
    if (child.exitCode !== null || child.pid === undefined) {
      resolveKill();
      return;
    }

    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveKill();
    };

    child.once("exit", done);

    // Negative pid targets the group. The child was spawned detached, so it
    // leads its own group and any server it forked is inside it.
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
    }

    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
      }
      done();
    }, graceMs);
  });
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
  const onExit = () => { void stop(); };
  process.once("exit", onExit);
  process.once("SIGINT", onExit);
  process.once("SIGTERM", onExit);

  try {
    await waitForServer(url, timeoutMs, child);
  } catch (err) {
    await stop();
    throw err;
  }

  return { url, port, stop };
}
