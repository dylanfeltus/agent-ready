import { spawn, spawnSync, type ChildProcess } from "node:child_process";
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
 * - **We kill the whole process tree, not the child.** `next start` forks.
 *   Killing the process we spawned leaves the real server holding the port, so
 *   the next run reads a stale build. The group leader exiting is not proof
 *   the group is gone either — a shell exits promptly on SIGTERM while a
 *   server it forked can ignore the signal.
 */

/** Windows has no process groups, so teardown needs a different mechanism. */
const IS_WINDOWS = process.platform === "win32";

export interface ServeHandle {
  url: string;
  port: number;
  stop: () => Promise<void>;
}

/**
 * Ask the OS for a free port and hand it straight to the child.
 *
 * There is an unavoidable gap between closing the probe and the child binding,
 * during which another process could take the port. Nothing portable closes it
 * (passing the listening descriptor through a shell is not possible), so the
 * gap is kept as small as possible instead.
 */
export function reservePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
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
async function waitForServer(
  url: string,
  timeoutMs: number,
  child: ChildProcess,
  output: () => string
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no response";

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Server command exited with code ${child.exitCode} before serving ${url}` +
          describeOutput(output())
      );
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

  throw new Error(
    `Timed out after ${timeoutMs / 1000}s waiting for ${url} (${lastError})` +
      describeOutput(output())
  );
}

/**
 * Append what the served command printed.
 *
 * Without this the only symptom of a misconfigured command is a bare timeout,
 * which is a long way from the actual error the server already reported.
 */
function describeOutput(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return `\n\n  Output from the server command:\n${trimmed
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n")}`;
}

/** True while any process in the child's tree remains. */
function treeAlive(child: ChildProcess): boolean {
  const pid = child.pid;
  if (pid === undefined) return false;

  if (IS_WINDOWS) {
    // No process groups to interrogate; the spawned process is the best proxy.
    return child.exitCode === null;
  }

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

/** Signal the child's whole tree, however the platform expresses that. */
function signalTree(child: ChildProcess, force: boolean): void {
  const pid = child.pid;
  if (pid === undefined) return;

  if (IS_WINDOWS) {
    // A negative pid is not a process group on Windows; taskkill /T walks the
    // tree, which is what reaches a server the command forked.
    const args = ["/pid", String(pid), "/T"];
    if (force) args.push("/F");
    const result = spawnSync("taskkill", args, { stdio: "ignore" });
    if (result.error) {
      try { child.kill(force ? "SIGKILL" : "SIGTERM"); } catch { /* gone */ }
    }
    return;
  }

  const signal: NodeJS.Signals = force ? "SIGKILL" : "SIGTERM";
  try {
    // Negative pid targets the group. The child was spawned detached, so it
    // leads its own group and anything it forked is inside it.
    process.kill(-pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

/** Terminate the child's tree, escalating if it does not go quietly. */
async function killTree(child: ChildProcess, graceMs: number): Promise<void> {
  if (child.pid === undefined) return;

  signalTree(child, false);

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && treeAlive(child)) await sleep(50);

  if (!treeAlive(child)) return;

  signalTree(child, true);
  const hardDeadline = Date.now() + 2_000;
  while (Date.now() < hardDeadline && treeAlive(child)) await sleep(50);
}

export interface ServeOptions {
  /** Milliseconds to wait for the server to answer. */
  timeoutMs?: number;
  /** Milliseconds between the polite signal and the forceful one. */
  graceMs?: number;
  /** Stream the served command's output instead of capturing it. */
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
    // Own process group, so teardown can take the whole tree. Meaningless on
    // Windows, where taskkill /T does the walking instead.
    detached: !IS_WINDOWS,
    stdio: verbose ? "inherit" : ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(port) },
  });

  // Keep a bounded tail of what the command printed, to explain a failure.
  let tail = "";
  const record = (chunk: unknown) => {
    tail = (tail + String(chunk)).slice(-2000);
  };
  child.stdout?.on("data", record);
  child.stderr?.on("data", record);

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    process.off("exit", onExit);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    await killTree(child, graceMs);
  };

  // Don't leave an orphaned server behind if we die unexpectedly. Only the
  // first signal is delivered synchronously here — an escalation cannot run
  // during 'exit' — but that is enough for a server that respects SIGTERM.
  const onExit = () => { void stop(); };

  // Installing a signal listener suppresses Node's default termination, so we
  // have to terminate ourselves. Without this, Ctrl-C would stop the server
  // and let the crawl carry on against it, writing an incomplete mirror and
  // exiting successfully.
  const terminateWith = (code: number) => () => {
    void stop().finally(() => process.exit(code));
  };
  const onSigint = terminateWith(130);
  const onSigterm = terminateWith(143);

  process.once("exit", onExit);
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  try {
    await waitForServer(url, timeoutMs, child, () => tail);
  } catch (err) {
    await stop();
    throw err;
  }

  return { url, port, stop };
}
